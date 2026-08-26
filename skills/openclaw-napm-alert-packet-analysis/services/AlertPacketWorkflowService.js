'use strict';

const AlertPacketResultContractService = require('./AlertPacketResultContractService');
const AlertReferenceStore = require('../../../plugin/AlertReferenceStore');
const { buildAnalysisContext } = require('./AlertMetricProfileService');

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 2000, 4000, 8000]);
const MAX_RETRY_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 8000;
const DEFAULT_MAX_WINDOW_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_CANDIDATES = 5;

class AlertPacketWorkflowService {
  constructor(options = {}) {
    this.alertSkill = options.alertSkill;
    this.packetSkill = options.packetSkill;
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
    this.retryDelaysMs = normalizeRetryDelays(options.retryDelaysMs);
    this.maxWindowSeconds = positiveInteger(options.maxWindowSeconds, DEFAULT_MAX_WINDOW_SECONDS);
    this.maxCandidates = Math.min(10, positiveInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES));
    this.resultContract = options.resultContract || new AlertPacketResultContractService();
    this.referenceStore = options.referenceStore || null;
  }

  async execute(rawInput = {}) {
    const validation = normalizeAndValidateInput(rawInput, this.maxWindowSeconds);
    if (!validation.ok) {
      return this.resultContract.buildFailure({
        input: validation.input,
        workflowState: 'INVALID_INPUT',
        errorCode: validation.errorCode,
        message: validation.message
      });
    }

    const input = validation.input;

    // A candidate reference is already resolved by the plugin from the shared
    // alert archive. Reuse its trusted packet query and avoid rediscovering or
    // analyzing other candidates.
    if (input.candidateId && input.packetCandidate) {
      const candidate = {
        rank: Number(input.packetCandidate.rank) || 1,
        candidateId: input.candidateId,
        ip: input.packetCandidate.ip || null,
        ips: Array.isArray(input.packetCandidate.ips) ? input.packetCandidate.ips : input.packetCandidate.criteria?.ips,
        ipPair: input.packetCandidate.ipPair || null,
        metricValue: input.packetCandidate.metricValue || null,
        suggestedPacketQuery: input.packetCandidate,
      };
      const packetAnalyses = await this._analyzeCandidates([candidate], input);
      return this.resultContract.buildSuccess({
        input,
        alertResult: null,
        packetAnalyses,
        detailAttempts: 0,
        selectedCandidateId: input.candidateId,
      });
    }

    let alertResult = null;
    let detailAttempts = 0;

    for (const delayMs of this.retryDelaysMs) {
      if (delayMs > 0) {
        await this.sleep(delayMs);
      }
      detailAttempts += 1;
      try {
        alertResult = await this.alertSkill.handleSkillCall(buildAlertDetailQuery(input));
      } catch (error) {
        return this.resultContract.buildFailure({
          input,
          workflowState: 'ALERT_DETAIL_QUERY_FAILED',
          message: error?.message || '告警详情查询失败。',
          detailAttempts,
          error
        });
      }

      if (!alertResult || alertResult.ok === false || alertResult.error) {
        return this.resultContract.buildFailure({
          input,
          workflowState: 'ALERT_DETAIL_QUERY_FAILED',
          message: alertResult?.error?.message || '告警详情查询失败。',
          detailAttempts,
          alertResult,
          error: alertResult?.error
        });
      }
      if (hasAlertDetail(alertResult)) {
        break;
      }
    }

    if (!hasAlertDetail(alertResult)) {
      return this.resultContract.buildFailure({
        input,
        workflowState: 'ALERT_DETAIL_NOT_VISIBLE',
        message: '已收到告警推送，但指定事件明细在有限重试后仍未可见，未执行推测性数据包分析。',
        detailAttempts,
        alertResult
      });
    }

    const candidates = extractPacketCandidates(alertResult).slice(0, this.maxCandidates);
    if (candidates.length === 0) {
      return this.resultContract.buildFailure({
        input,
        workflowState: 'NO_PACKET_CANDIDATE',
        message: '告警详情已获取，但没有返回可执行的 suggestedPacketQuery，未猜测 IP 或数据包地址。',
        detailAttempts,
        alertResult
      });
    }

    const persistedCandidates = this._persistCandidates(input, candidates);
    if (input.referenceId && !input.candidateId && persistedCandidates.length > 1) {
      return this.resultContract.buildCandidateSelection({
        input,
        alertResult,
        detailAttempts,
        candidates: persistedCandidates,
      });
    }

    const packetAnalyses = await this._analyzeCandidates(persistedCandidates, input);

    return this.resultContract.buildSuccess({
      input,
      alertResult,
      packetAnalyses,
      detailAttempts,
      selectedCandidateId: persistedCandidates.length === 1 ? persistedCandidates[0].candidateId : null,
    });
  }

  _persistCandidates(input, candidates = []) {
    const enriched = candidates.map((candidate, index) => {
      const candidateId = candidate.candidateId
        || (input.referenceId ? `${input.referenceId}-P${candidate.rank || index + 1}` : null);
      const packetQuery = buildAuthoritativePacketQuery(candidate.suggestedPacketQuery, input);
      return {
        ...candidate,
        candidateId,
        packetQuery,
        packetWindow: {
          start: packetQuery.criteria?.start || null,
          end: packetQuery.criteria?.end || null,
        },
        status: candidate.status || 'DISCOVERED',
      };
    });
    if (input.referenceId && enriched.length > 0) {
      try {
        if (!this.referenceStore) this.referenceStore = new AlertReferenceStore();
        this.referenceStore.update(input.referenceId, {
          status: enriched.length === 1 ? 'CANDIDATE_SELECTED' : 'CANDIDATES_READY',
          packet: {
            candidates: enriched.map((candidate) => ({
              candidateId: candidate.candidateId,
              rank: candidate.rank || null,
              ip: candidate.ip || null,
              ips: candidate.ips || [],
              ipPair: candidate.ipPair || null,
              metricValue: candidate.metricValue || null,
              packetWindow: candidate.packetWindow,
              packetQuery: candidate.packetQuery,
              status: candidate.status,
            })),
          },
        });
      } catch (_error) {
        // The analysis result remains valid even when candidate persistence is unavailable.
      }
    }
    return enriched;
  }

  async _analyzeCandidates(candidates, input) {
    const packetAnalyses = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const packetQuery = buildAuthoritativePacketQuery(candidate.packetQuery || candidate.suggestedPacketQuery, input);
      try {
        const packetResult = await this.packetSkill.handleSkillCall(packetQuery);
        packetAnalyses.push({
          rank: candidate.rank || index + 1,
          candidate: candidateMetadata(candidate),
          query: packetQuery,
          ok: Boolean(packetResult && packetResult.ok !== false && !packetResult.error),
          result: packetResult
        });
      } catch (error) {
        packetAnalyses.push({
          rank: candidate.rank || index + 1,
          candidate: candidateMetadata(candidate),
          query: packetQuery,
          ok: false,
          result: null,
          error: { code: error?.code || 'PACKET_ANALYSIS_FAILED', message: error?.message || String(error) }
        });
      }
    }
    return packetAnalyses;
  }
}

function normalizeAndValidateInput(rawInput = {}, maxWindowSeconds = DEFAULT_MAX_WINDOW_SECONDS) {
  const source = isPlainObject(rawInput) ? rawInput : {};
  const prompt = String(source.prompt || source.userQuery || '').trim();
  const promptFields = parseCanonicalPrompt(prompt);
  const eventId = String(promptFields.eventId || source.eventId || '').trim();
  const start = normalizeUnixSeconds(promptFields.start ?? source.start);
  const end = normalizeUnixSeconds(promptFields.end ?? source.end);
  const triggerMetrics = normalizeTriggerMetrics({
    ...(isPlainObject(source.triggerMetrics) ? source.triggerMetrics : {}),
    ...(isPlainObject(promptFields.triggerMetrics) ? promptFields.triggerMetrics : {})
  });
  const input = {
    prompt,
    eventId,
    start,
    end,
    triggerMetrics,
    referenceId: String(source.referenceId || '').trim() || null,
    candidateId: String(source.candidateId || '').trim() || null,
    referenceErrorCode: String(source.referenceErrorCode || '').trim() || null,
    packetCandidate: isPlainObject(source.packetCandidate) ? source.packetCandidate : null,
  };

  if (input.referenceErrorCode) {
    const referenceErrors = {
      ALERT_REFERENCE_NOT_FOUND: '未找到该告警引用。请确认引用编号是否正确，或重新获取告警推送。',
      ALERT_REFERENCE_EXPIRED: '该告警引用已过期（默认保留 7 天），请重新获取告警推送。',
      ALERT_PACKET_CANDIDATE_NOT_FOUND: '未找到指定的数据包候选。请先发送告警引用，获取最新候选列表。',
    };
    return {
      ok: false,
      input,
      errorCode: input.referenceErrorCode,
      message: referenceErrors[input.referenceErrorCode] || '告警引用不可用，请重新获取告警推送。',
    };
  }
  if (!/^\d+$/.test(eventId)) {
    return { ok: false, input, message: '告警数据包分析需要数字 eventId。' };
  }
  if (!start || !end) {
    return { ok: false, input, message: '告警数据包分析需要固定的 Unix 秒级 start/end。' };
  }
  if (end <= start) {
    return { ok: false, input, message: '告警数据包分析的 end 必须大于 start。' };
  }
  if ((end - start) > maxWindowSeconds) {
    return { ok: false, input, message: `告警数据包分析窗口不能超过 ${maxWindowSeconds} 秒。` };
  }
  return { ok: true, input };
}

function buildAlertDetailQuery(input) {
  return {
    prompt: input.prompt,
    mode: 'detail',
    criteria: {
      eventIds: [input.eventId],
      start: input.start,
      end: input.end
    },
    options: {
      packetHandoff: true,
      discoveryEnabled: true,
      discoveryTopCount: DEFAULT_MAX_CANDIDATES,
      packetBufferSeconds: 120,
      alertTriggerMetrics: input.triggerMetrics
    }
  };
}

function parseCanonicalPrompt(prompt = '') {
  const text = String(prompt || '');
  const eventMatch = text.match(/\bevent\s*id\s*[:=]?\s*(\d+)\b/i)
    || text.match(/告警(?:事件)?\s*(?:id\s*[:=]?)?\s*(\d{3,})/i);
  const startMatch = text.match(/\bstart\s*[:=]\s*(\d{10,13})\b/i);
  const endMatch = text.match(/\bend\s*[:=]\s*(\d{10,13})\b/i);
  const metricMatch = text.match(/触发指标值\s*[:：]\s*([^=\r\n]+?)\s*=\s*(-?\d+(?:\.\d+)?)\s*([^\s\r\n]*)/i);
  const severityMatch = text.match(/告警级别\s*[:：]\s*([^\r\n]+)/i);
  const conditionMatch = text.match(/触发条件\s*[:：]\s*([^\r\n]+)/i);
  const triggerMetrics = metricMatch || severityMatch || conditionMatch
    ? normalizeTriggerMetrics({
        names: metricMatch ? [metricMatch[1].trim()] : [],
        values: metricMatch ? [Number(metricMatch[2])] : [],
        units: metricMatch && metricMatch[3] ? [metricMatch[3].trim()] : [],
        severity: severityMatch ? severityMatch[1].trim() : '',
        condition: conditionMatch ? conditionMatch[1].trim() : ''
      })
    : null;
  return {
    eventId: eventMatch?.[1] || '',
    start: startMatch?.[1] || null,
    end: endMatch?.[1] || null,
    triggerMetrics
  };
}

function normalizeTriggerMetrics(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    names: toStringArray(source.names || source.name),
    codes: toStringArray(source.codes || source.code),
    values: toNumberArray(source.values ?? source.value),
    units: toStringArray(source.units || source.unit),
    condition: String(source.condition || '').trim(),
    severity: String(source.severity || '').trim(),
    profileId: String(source.profileId || source.analysisProfile || '').trim(),
    profileVersion: Number(source.profileVersion || 0) || null,
    evidenceChecks: toStringArray(source.evidenceChecks),
  };
}

function extractPacketCandidates(alertResult = {}) {
  const instruction = alertResult?.narrationInput?.packetInstruction || alertResult?.packetInstruction || null;
  if (instruction && instruction.callPacketAnalysis !== true) {
    return [];
  }
  if (instruction?.callPacketAnalysis) {
    if (isPlainObject(instruction.suggestedPacketQuery)) {
      return [{ rank: 1, suggestedPacketQuery: instruction.suggestedPacketQuery }];
    }
    if (Array.isArray(instruction.candidates)) {
      return instruction.candidates.filter((item) => isPlainObject(item?.suggestedPacketQuery));
    }
  }

  const handoff = alertResult?.packetHandoff;
  if (isPlainObject(handoff?.suggestedPacketQuery)) {
    return [{ rank: 1, suggestedPacketQuery: handoff.suggestedPacketQuery }];
  }
  if (Array.isArray(handoff?.candidates)) {
    return handoff.candidates.filter((item) => isPlainObject(item?.suggestedPacketQuery));
  }
  return [];
}

function buildAuthoritativePacketQuery(suggestedPacketQuery = {}, input = {}) {
  const source = isPlainObject(suggestedPacketQuery) ? suggestedPacketQuery : {};
  const sourceCriteria = isPlainObject(source.criteria) ? source.criteria : {};
  const criteria = {
    ...sourceCriteria,
    start: input.start,
    end: input.end
  };
  delete criteria.timeRange;
  const analysisContext = buildAnalysisContext(input.triggerMetrics || {});
  const analysis = isPlainObject(source.analysis)
    ? { ...source.analysis }
    : {};
  if (analysisContext.hasTriggerMetrics && !source.analysis?.hasTriggerMetrics) {
    Object.assign(analysis, {
      hasTriggerMetrics: true,
      metrics: analysis.metrics || analysisContext.metrics,
      metricLabels: analysis.metricLabels || analysisContext.metricLabels,
      values: analysis.values || analysisContext.values,
      units: analysis.units || analysisContext.units,
      condition: analysis.condition || analysisContext.condition,
      severity: analysis.severity || analysisContext.severity,
      profileId: analysis.profileId || analysisContext.profileId,
      profileVersion: analysis.profileVersion || analysisContext.profileVersion,
      evidenceChecks: analysis.evidenceChecks || analysisContext.evidenceChecks,
      instruction: analysis.instruction || analysisContext.instruction,
    });
  }
  return {
    ...source,
    criteria,
    ...(Object.keys(analysis).length > 0 ? { analysis } : {})
  };
}

function hasAlertDetail(result = {}) {
  return Array.isArray(result?.details) && result.details.length > 0;
}

function candidateMetadata(candidate = {}) {
  return {
    candidateId: candidate.candidateId || null,
    rank: candidate.rank || null,
    ip: candidate.ip || null,
    ips: Array.isArray(candidate.ips) ? candidate.ips : null,
    ipPair: candidate.ipPair || null,
    metricValue: candidate.metricValue || null
  };
}

function normalizeRetryDelays(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : DEFAULT_RETRY_DELAYS_MS;
  const normalized = source
    .slice(0, MAX_RETRY_ATTEMPTS)
    .map((item) => Math.max(0, Math.min(MAX_RETRY_DELAY_MS, Number(item) || 0)));
  if (normalized[0] !== 0) normalized.unshift(0);
  return normalized.slice(0, MAX_RETRY_ATTEMPTS);
}

function normalizeUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function toStringArray(value) {
  const source = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  return source.map((item) => String(item).trim()).filter(Boolean);
}

function toNumberArray(value) {
  const source = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  return source.map(Number).filter(Number.isFinite);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = AlertPacketWorkflowService;
module.exports.normalizeAndValidateInput = normalizeAndValidateInput;
module.exports.parseCanonicalPrompt = parseCanonicalPrompt;
module.exports.__test__ = {
  buildAlertDetailQuery,
  buildAuthoritativePacketQuery,
  extractPacketCandidates,
  normalizeAndValidateInput,
  normalizeRetryDelays,
  parseCanonicalPrompt
};
