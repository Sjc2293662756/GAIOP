'use strict';

const SummaryClient = require('../../openclaw-napm-summary/services/SummaryClient');
const { classify, getFlow, getNextStep, resolveJump, getJumpOptions } = require('./FaultDiagnosisFlowRouter');
const { FaultDiagnosisSteps, matchHints } = require('./FaultDiagnosisSteps');

// ── helpers ─────────────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Fault diagnosis service — main orchestrator.
 *
 * Manages a session-based diagnostic workflow:
 *   1. Receive a user problem description → classify into flow type
 *   2. Execute diagnostic steps one at a time
 *   3. Each step queries NAPM, analyzes data, generates judgment hints
 *   4. User decides next action (continue, jump to another flow, generate report)
 *   5. When complete, build a structured report
 *
 * Session state tracks:
 *   - flowType: current diagnostic flow
 *   - completedSteps: [{ stepId, flowType, description, rawData, hints, userJudgment }]
 *   - context: { faultStart, faultEnd, baselineStart, baselineEnd, target, ... }
 */
class FaultDiagnosisService {
  constructor(options = {}) {
    this.client = options.client || new SummaryClient(options);
    this.steps = options.steps || new FaultDiagnosisSteps({ client: this.client });
    this.timeoutMs = options.timeoutMs || 120000;
  }

  /**
   * Run a standardized diagnostic flow (B/S or C/S) from start to report.
   * Executes all steps sequentially and returns the final report in one call.
   * No multi-turn interaction needed.
   *
   * For network_slow (interactive flow), use start() + nextAction() instead.
   */
  async run(input = {}) {
    // ── Create session + run step1 ──
    const result = await this.start(input);
    if (!result.ok) return result;

    let session = result.session;
    const flow = getFlow(session.flowType);

    // ── Run remaining steps ──
    for (let i = 1; i < flow.steps.length; i++) {
      // Inject previous step's rawData into context for dependent steps
      const prevStep = session.completedSteps[session.completedSteps.length - 1];
      if (prevStep && prevStep.rawData) {
        session.context._prevStepRawData = prevStep.rawData;
      }
      const stepResult = await this.executeStep(session, flow.steps[i]);
      session = stepResult.session;
    }

    // ── Build template-compatible reportData ──
    const reportData = this._buildBsTemplateData(session);

    return {
      ok: true,
      reportReady: true,
      reportData,
      sessionJson: serializeSession(session),
      flowType: session.flowType,
      flowLabel: session.flowLabel,
      steps: session.completedSteps.map((s) => ({
        stepId: s.stepId,
        description: s.description,
        hints: s.hints,
        analysisFlags: s.analysisFlags
      }))
    };
  }

  /**
   * Start a new diagnostic session, or resume an existing one.
   *
   * Use this for interactive flows (network_slow) where user judgment
   * is needed between steps.
   *
   * For standardized flows (B/S, C/S), use run() instead.
   *
   * @param {object} input
   * @param {string} input.description — user's problem description
   * @param {string} input.flowType — optional: skip classify() and use this flow type directly
   * @param {object} input.timeRange — { faultWindow: {start,end}, baselineWindow: {start,end} }
   * @param {object} input.target — { groupType, groupArgument, groupLabel }
   * @param {object} input.fault — { description, severity }
   * @param {string} input.sessionJson — serialized session from a previous call (for resume)
   * @param {string} input.action — user action: "继续下一步" / "转XXX" / "生成报告"
   */
  async start(input = {}) {
    // ── Resume existing session ──
    if (input.sessionJson) {
      const session = deserializeSession(input.sessionJson);
      if (!session) {
        return { ok: false, message: '会话恢复失败：sessionJson 无效或已过期' };
      }

      const action = String(input.action || '').trim();
      if (!action) {
        // No action specified — return current state for display
        const lastStep = session.completedSteps[session.completedSteps.length - 1];
        return {
          ok: true,
          session,
          sessionJson: serializeSession(session),
          step: lastStep ? {
            stepId: lastStep.stepId,
            flowType: lastStep.flowType,
            description: lastStep.description,
            data: lastStep.rawData,
            analysisFlags: lastStep.analysisFlags,
            hints: lastStep.hints,
            nextOptions: this._buildNextOptions(session)
          } : null
        };
      }

      return this.nextAction(session, action);
    }

    // ── New session ──
    const description = String(input.description || input.fault?.description || '');
    // If OpenClaw explicitly passes flowType, use it; otherwise classify from description
    const flowType = input.flowType || classify(description);
    const flow = getFlow(flowType);
    const timeRange = this._resolveTimeRange(input.timeRange || input);
    const target = isPlainObject(input.target) ? input.target : null;
    const faultInput = isPlainObject(input.fault) ? input.fault : {};

    const session = {
      flowType,
      flowLabel: flow.label,
      description: description || faultInput.description || '未命名故障',
      faultInput,
      context: {
        faultStart: timeRange.faultWindow?.start || timeRange.start,
        faultEnd: timeRange.faultWindow?.end || timeRange.end,
        baselineStart: timeRange.baselineWindow?.start || null,
        baselineEnd: timeRange.baselineWindow?.end || null,
        target,
        granularity: this._autoGranularity(
          timeRange.faultWindow?.start || timeRange.start,
          timeRange.faultWindow?.end || timeRange.end
        )
      },
      completedSteps: [],
      currentStepId: flow.steps[0],
      timeRange,
      target
    };

    return this.executeStep(session, flow.steps[0]);
  }

  /**
   * Execute a single diagnostic step and return results.
   */
  async executeStep(session, stepId) {
    const { flowType, context } = session;

    // Build and execute NAPM queries for this step
    const plan = this.steps.buildQueries(flowType, stepId, context);
    const rawData = await this._executeQueries(plan.queries);

    // Analyze data for hint matching
    const analysisFlags = this.steps.analyzeStepData(flowType, stepId, rawData, context);

    // Match judgment hints
    const hints = matchHints(flowType, stepId, analysisFlags);

    // Get next step options
    const nextStepId = getNextStep(flowType, stepId);
    const jumpOptions = getJumpOptions(flowType);

    const nextOptions = [];
    if (nextStepId) {
      const nextFlow = getFlow(flowType);
      const nextIdx = nextFlow.steps.indexOf(nextStepId);
      nextOptions.push({
        type: 'continue',
        flowType,
        stepId: nextStepId,
        label: `继续${nextFlow.steps.length > nextIdx + 1 ? '下一步' : '最后一步'}`
      });
    }
    for (const jump of jumpOptions) {
      nextOptions.push({
        type: 'jump',
        flowType: jump.flowType,
        stepId: null, // resolved when user selects
        label: jump.label,
        trigger: jump.trigger
      });
    }
    nextOptions.push({ type: 'report', label: '生成故障分析报告' });

    // Record step completion
    session.completedSteps.push({
      stepId,
      flowType,
      description: plan.description,
      rawData,
      analysisFlags,
      hints,
      userJudgment: null
    });
    session.currentStepId = stepId;

    const result = {
      ok: true,
      session,
      sessionJson: serializeSession(session),
      step: {
        stepId,
        flowType,
        description: plan.description,
        data: rawData,
        analysisFlags,
        hints,
        nextOptions
      }
    };

    return result;
  }

  /**
   * Handle user's decision after a step: continue, jump, or report.
   */
  async nextAction(session, userDecision = '') {
    const decision = String(userDecision || '').trim();

    // "生成报告" → build report
    if (decision.includes('报告') || decision.includes('生成') || decision === 'report') {
      return this._buildReportResult(session);
    }

    // Try to resolve as a jump
    const jump = resolveJump(session.flowType, session.currentStepId, decision);

    if (jump && jump.flowType !== session.flowType) {
      // Cross-flow jump
      session.flowType = jump.flowType;
      session.flowLabel = getFlow(jump.flowType).label;
      return this.executeStep(session, jump.stepId);
    }

    if (jump) {
      // Same flow, next step
      return this.executeStep(session, jump.stepId);
    }

    // Default: continue to next step in current flow
    const nextStepId = getNextStep(session.flowType, session.currentStepId);
    if (nextStepId) {
      return this.executeStep(session, nextStepId);
    }

    // No more steps — suggest report
    return {
      ok: true,
      session,
      step: null,
      message: '当前流程所有步骤已完成。建议生成故障分析报告。',
      suggestReport: true
    };
  }

  /**
   * Build the final diagnostic report data.
   */
  buildReportData(session) {
    const report = {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'diagnostic_report',
      templateId: 'napm_fault_diagnosis_v2',
      format: 'docx',
      title: `${session.description}_故障分析报告`,
      systemName: 'Netlnside流量分析系统',
      faultName: session.description,
      timeRange: {
        start: session.context.faultStart,
        end: session.context.faultEnd,
        displayText: session.timeRange?.displayText || '',
        baselineStart: session.context.baselineStart,
        baselineEnd: session.context.baselineEnd
      },
      dataSource: {
        system: 'Netlnside流量分析系统',
        sourceSkill: 'openclaw-napm-fault-diagnosis',
        queryService: `faultDiagnosis:${session.flowType}`
      },
      diagnosisReport: {
        flowType: session.flowType,
        flowLabel: session.flowLabel,
        fault: session.faultInput,
        steps: session.completedSteps.map((s) => ({
          stepId: s.stepId,
          description: s.description,
          rawData: s.rawData,
          hints: s.hints,
          userJudgment: s.userJudgment
        }))
      },
      audit: {
        sourceSkill: 'openclaw-napm-fault-diagnosis',
        sourceSchema: 'openclaw_napm_fault_diagnosis_result.v2',
        flowType: session.flowType,
        totalSteps: session.completedSteps.length,
        queriesPerformed: session.completedSteps.map((s) => s.stepId)
      }
    };

    return report;
  }

  // ── Internal ──────────────────────────────────────────────────

  async _executeQueries(queries = []) {
    const results = {};
    const settled = await Promise.allSettled(queries.map((q) => q.fn()));
    queries.forEach((q, i) => {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        results[q.label] = result.value;
      } else {
        console.error(`[FaultDiagnosis] Query "${q.label}" failed:`, result.reason?.message || result.reason);
        results[q.label] = null;
      }
    });
    return results;
  }

  /**
   * Build template-compatible reportData for the B/S fault diagnosis v2 fixed template.
   * Extracts data from completedSteps into the `diagnosis` object that the template references.
   */
  _buildBsTemplateData(session) {
    const target = session.target || session.context?.target || {};
    const faultInput = session.faultInput || {};
    const steps = session.completedSteps || [];

    const diagnosis = {
      flowType: session.flowType,
      flowLabel: session.flowLabel,
      description: session.description,
      targetLabel: target.groupLabel || target.groupArgument || session.description,
      targetType: target.groupType || 'WebApplication',
      severity: faultInput.severity || 'major',
      severityLabel: { critical: '紧急', major: '重大', minor: '轻微' }[faultInput.severity] || '重大',
      stepCount: steps.length,
      reportDate: new Date().toISOString().slice(0, 10),
      recommendations: faultInput.recommendations || [],
      prevention: faultInput.prevention || [],
      step1Hints: [],
      step2Hints: [],
      step3Hints: [],
      step1: {},
      step2: {},
      step3: {}
    };

    // Extract step data
    for (const step of steps) {
      const hints = (step.hints || []).filter((h) => h.type === 'judgment').map((h) => h.text);
      const raw = step.rawData || {};

      if (step.stepId === 'step1_4xx_5xx_overview') {
        diagnosis.step1Hints = hints;
        diagnosis.step1 = this._extractStep1Data(raw);
      } else if (step.stepId === 'step2_page_error_analysis') {
        diagnosis.step2Hints = hints;
        diagnosis.step2 = this._extractStep2Data(raw);
      } else if (step.stepId === 'step3_page_status_detail') {
        diagnosis.step3Hints = hints;
            diagnosis.step3 = this._extractStep3Data(raw);
      }
    }

    return {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'diagnostic_report',
      templateId: 'napm_bs_fault_diagnosis_v2',
      format: 'docx',
      title: (diagnosis.description || '未命名故障') + '_业务故障分析报告',
      systemName: 'Netlnside流量分析系统',
      faultName: diagnosis.description,
      timeRange: {
        start: session.context?.faultStart,
        end: session.context?.faultEnd,
        displayText: session.timeRange?.displayText || ''
      },
      dataSource: {
        system: 'Netlnside流量分析系统',
        sourceSkill: 'openclaw-napm-fault-diagnosis',
        queryService: `faultDiagnosis:${session.flowType}`
      },
      diagnosis,
      audit: {
        sourceSkill: 'openclaw-napm-fault-diagnosis',
        sourceSchema: 'openclaw_napm_fault_diagnosis_result.v2',
        flowType: session.flowType,
        totalSteps: steps.length,
        queriesPerformed: steps.map((s) => s.stepId)
      }
    };
  }

  /** Extract step1 data: 4xx/5xx error overview */
  _extractStep1Data(raw) {
    const result = { topApps: [], http400Total: 0, http500Total: 0, http400Pct: '0%' };

    // averageValues response: [{metricValues: [{metric:{id:'PGNPGE'},value:531},...]}] — extract flat values
    const rawData = raw.businessOverview;
    const flat = _extractMetricValues(rawData);
    if (flat && Object.keys(flat).length > 0) {
      const visits = Number(flat.PGNPGE) || 0;
      const total400 = Number(flat.PGHTTP400) || 0;
      const total500 = Number(flat.PGHTTP500) || 0;

      result.topApps = [{
        keyLabel: '当前业务',
        ...flat  // pass through all averageValues fields: PGNPGE, PGTME, PGNSLPGE, PGSLPCT, PGHTTP400, PGHTTP500, PGBYTI, PGBYTO
      }];
      result.http400Total = total400;
      result.http500Total = total500;
      result.http400Pct = visits > 0 ? ((total400 / visits) * 100).toFixed(2) + '%' : '0%';
    }
    return result;
  }

  /** Extract step2 data: page-level error analysis */
  _extractStep2Data(raw) {
    const result = { pages: [] };
    const pageData = raw.pageErrorAnalysis;
    if (!pageData) return result;

    // Try ALL known NAPM response formats to find items
    let items = [];
    // Format A: raw array [{group, groupPath, metricValues}, ...]
    if (Array.isArray(pageData) && pageData.length > 0) {
      items = pageData;
    }
    // Format B: { topValues: [...] }
    else if (isPlainObject(pageData) && Array.isArray(pageData.topValues) && pageData.topValues.length > 0) {
      items = pageData.topValues;
    }
    // Format C: single item {group, groupPath, metricValues}
    else if (isPlainObject(pageData) && (pageData.group || pageData.groupPath || pageData.metricValues)) {
      items = [pageData];
    }

    // NAPM optimization: only first item has metric.id metadata.
    // Cache the metric ID order from the first item for all subsequent items.
    const firstMV = items.length > 0 ? (Array.isArray(items[0]?.metricValues) ? items[0].metricValues : []) : [];
    const metricIdOrder = firstMV.map((mv) => mv.metric?.id || null);

    result.pages = items.slice(0, 20).map((item, idx) =>
      this._flattenPageItem(item, idx === 0 ? null : metricIdOrder)
    ).filter(Boolean);
    return result;
  }

  /** Flatten a single NAPM page item into { pageUrl, PGNPGE, PGHTTP400, ... } */
  _flattenPageItem(item, metricIdOrder) {
    if (!isPlainObject(item)) return null;
    const mvList = Array.isArray(item.metricValues) ? item.metricValues : [];
    if (mvList.length === 0 && !metricIdOrder) return null;

    // Resolve page URL: try keyLabel > key > group.argument > parse from groupPath
    let pageUrl = item.keyLabel || item.key || '';
    if (!pageUrl && item.groupPath) {
      const afterPage = String(item.groupPath).replace(/.*page\s+\d+\//, '');
      pageUrl = afterPage || '';
    }
    if (!pageUrl) pageUrl = item.group?.argument || '';

    const row = { pageUrl, key: item.key || item.group?.argument || '' };
    const ids = metricIdOrder || mvList.map((mv) => mv.metric?.id || null);
    for (let i = 0; i < Math.max(mvList.length, ids.length); i++) {
      const mv = mvList[i];
      const id = ids[i] || (mv?.metric?.id) || 'value';
      const val = mv ? mv.value : undefined;
      row[id] = val;
    }
    return row;
  }

  /** Extract step3 data: pageViews per-visit detail rows */
  _extractStep3Data(raw) {
    const allVisits = [];

    for (const [key, data] of Object.entries(raw)) {
      if (!key.startsWith('pageDetail_')) continue;
      // pageViews returns JSON array: [{startTime, page, clientIp, httpStatus, http200S, http400S, http500S, httpResponses}]
      const rows = Array.isArray(data) ? data : [];
      for (const r of rows) {
        allVisits.push({
          startTime: r.startTime || '-',
          page: r.page || key.replace('pageDetail_', ''),
          clientIp: r.clientIp || '-',
          httpStatus: r.httpStatus ?? '-',
          http200S: r.http200S ?? 0,
          http400S: r.http400S ?? 0,
          http500S: r.http500S ?? 0,
          httpResponses: r.httpResponses ?? 0
        });
      }
    }

    return { pageDetails: allVisits };
  }

  /**
   * Extract flat metric values from various NAPM response formats:
   *   A: [{metricValues:[{metric:{id:'PGNPGE'},value:531}]}] → {PGNPGE:531}
   *   B: {PGNPGE:531} → return as-is
   *   C: {metricValues:[{metric:{id:'PGNPGE'},value:531}]} → {PGNPGE:531}
   */
  _extractMetricValues(data) {
    if (!data) return null;
    // Format A: array of items with metricValues
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0]?.metricValues)) {
      return this._flatMV(data[0].metricValues);
    }
    // Format C: object with metricValues array
    if (isPlainObject(data) && Array.isArray(data.metricValues)) {
      return this._flatMV(data.metricValues);
    }
    // Format B: already flat
    if (isPlainObject(data) && !data.metricValues && Object.keys(data).length > 0) {
      return data;
    }
    return null;
  }

  _flatMV(mvList) {
    const result = {};
    for (const mv of mvList) {
      result[mv.metric?.id || 'value'] = mv.value;
    }
    return result;
  }

  _buildReportResult(session) {
    return {
      ok: true,
      session,
      step: null,
      reportReady: true,
      reportData: this.buildReportData(session)
    };
  }

  _resolveTimeRange(input = {}) {
    const now = nowUnix();
    if (isPlainObject(input.faultWindow)) {
      const fw = input.faultWindow;
      const bw = input.baselineWindow || null;
      const faultStart = Number(fw.start) || (now - 7200);
      const faultEnd = Number(fw.end) || now;
      const result = {
        start: faultStart,
        end: faultEnd,
        faultWindow: { start: faultStart, end: faultEnd },
        baselineWindow: null
      };
      if (bw && (bw.start || bw.end)) {
        result.baselineWindow = {
          start: Number(bw.start) || (faultStart - 86400),
          end: Number(bw.end) || faultStart
        };
      }
      return result;
    }
    const start = Number(input.start) || (now - 86400);
    const end = Number(input.end) || now;
    return { start, end, faultWindow: { start, end }, baselineWindow: null };
  }

  _autoGranularity(start, end) {
    const rangeSec = Math.abs(Number(end || 0) - Number(start || 0));
    if (rangeSec <= 86400) return 60;
    if (rangeSec <= 604800) return 3600;
    return 86400;
  }

  _buildNextOptions(session) {
    const { flowType } = session;
    const nextStepId = getNextStep(flowType, session.currentStepId);
    const jumpOptions = getJumpOptions(flowType);

    const nextOptions = [];
    if (nextStepId) {
      const nextFlow = getFlow(flowType);
      const nextIdx = nextFlow.steps.indexOf(nextStepId);
      nextOptions.push({
        type: 'continue',
        flowType,
        stepId: nextStepId,
        label: `继续${nextFlow.steps.length > nextIdx + 1 ? '下一步' : '最后一步'}`
      });
    }
    for (const jump of jumpOptions) {
      nextOptions.push({
        type: 'jump',
        flowType: jump.flowType,
        stepId: null,
        label: jump.label,
        trigger: jump.trigger
      });
    }
    nextOptions.push({ type: 'report', label: '生成故障分析报告' });

    return nextOptions;
  }
}

// ── Session serialization ────────────────────────────────────────────

const MAX_RAW_DATA_KEYS = 5;
const MAX_METRIC_VALUES_LENGTH = 50;

/**
 * Serialize a session to a JSON string for OpenClaw cross-turn persistence.
 * Truncates rawData to keep the payload small.
 */
function serializeSession(session) {
  if (!isPlainObject(session)) return '';

  const steps = (session.completedSteps || []).map((s) => {
    const rawData = isPlainObject(s.rawData) ? s.rawData : {};
    const truncated = {};

    // Only keep first N keys, truncate large arrays in metricValues
    const keys = Object.keys(rawData).slice(0, MAX_RAW_DATA_KEYS);
    for (const key of keys) {
      const value = rawData[key];
      if (isPlainObject(value) && Array.isArray(value.metricValues)) {
        truncated[key] = {
          _truncated: true,
          metricValues: value.metricValues.map((mv) => ({
            metric: { id: mv.metric?.id || 'unknown' },
            values: Array.isArray(mv.values)
              ? mv.values.slice(0, MAX_METRIC_VALUES_LENGTH)
              : undefined,
            value: mv.value
          }))
        };
      } else if (isPlainObject(value) && Array.isArray(value.topValues)) {
        truncated[key] = {
          _truncated: true,
          topValues: value.topValues.slice(0, 20).map((item) => ({
            key: item.key,
            keyLabel: item.keyLabel,
            metricValues: (item.metricValues || []).map((mv) => ({
              metric: { id: mv.metric?.id || 'unknown' },
              value: mv.value
            }))
          }))
        };
      } else {
        truncated[key] = value;
      }
    }

    return {
      stepId: s.stepId,
      flowType: s.flowType,
      description: s.description,
      rawData: truncated,
      analysisFlags: s.analysisFlags || {},
      hints: (s.hints || []).map((h) => ({ type: h.type, text: h.text })),
      userJudgment: s.userJudgment || null
    };
  });

  const payload = {
    v: 1,
    flowType: session.flowType,
    flowLabel: session.flowLabel,
    description: session.description,
    faultInput: session.faultInput || {},
    context: session.context || {},
    completedSteps: steps,
    currentStepId: session.currentStepId,
    timeRange: session.timeRange || {},
    target: session.target || null
  };

  try {
    return JSON.stringify(payload);
  } catch (_) {
    return '';
  }
}

/**
 * Deserialize a session JSON string back into a session object.
 */
function deserializeSession(json = '') {
  if (!json || typeof json !== 'string') return null;

  let payload;
  try {
    payload = JSON.parse(json);
  } catch (_) {
    return null;
  }

  if (!isPlainObject(payload) || payload.v !== 1) return null;

  return {
    flowType: payload.flowType || 'network_slow',
    flowLabel: payload.flowLabel || '网络慢/网络运行异常',
    description: payload.description || '',
    faultInput: payload.faultInput || {},
    context: payload.context || {},
    completedSteps: payload.completedSteps || [],
    currentStepId: payload.currentStepId || '',
    timeRange: payload.timeRange || {},
    target: payload.target || null
  };
}

module.exports = FaultDiagnosisService;
module.exports.serializeSession = serializeSession;
module.exports.deserializeSession = deserializeSession;
module.exports.__test__ = { serializeSession, deserializeSession };
