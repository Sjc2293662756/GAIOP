const { logAudit } = require('../utils/auditLogger');

class ResultNarrationService {
  constructor() {
    this.responseTemplates = this.loadResponseTemplates();
  }

  loadResponseTemplates() {
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(__dirname, '../../config/response-templates.v2.json');
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      return {};
    }
  }

  isEnabled() {
    const envValue = String(process.env.ENABLE_RESULT_NARRATION || 'true').toLowerCase();
    return envValue !== 'false';
  }

  buildCapabilityIntroStructure(options = {}) {
    return {
      responseType: 'capability_intro',
      title: String(options.title || '我是观枢AI').trim(),
      message: String(options.message || '').trim(),
      capabilities: Array.isArray(options.capabilities) ? options.capabilities.filter(Boolean) : [],
      nextActions: Array.isArray(options.nextActions) ? options.nextActions.filter(Boolean) : []
    };
  }

  buildClarificationBriefStructure(options = {}) {
    return {
      responseType: 'clarification_brief',
      title: String(options.title || '我先确认一下').trim(),
      message: String(options.message || '').trim(),
      nextActions: Array.isArray(options.nextActions) ? options.nextActions.filter(Boolean) : []
    };
  }

  resolveOverviewPlaybook(payload) {
    const semanticUnderstanding = payload?.partialQuery?.semanticUnderstanding || payload?.semanticUnderstanding || {};
    const policyEnvelope = payload?.policyEnvelope || {};
    const overviewPlaybook = String(
      policyEnvelope.overviewPlaybook
      || semanticUnderstanding.overviewPlaybook
      || ''
    ).trim();
    return overviewPlaybook || 'global_summary';
  }

  resolveOverviewTemplate(playbook = 'global_summary') {
    return this.responseTemplates[`overview_${playbook}`]
      || this.responseTemplates.overview_global_summary
      || this.responseTemplates.overview
      || null;
  }

  buildOverviewTitle(playbook, timeLabel) {
    const normalized = String(timeLabel || '\u5f53\u524d').trim() || '\u5f53\u524d';
    switch (playbook) {
      case 'network_summary':
        return `\u3010${normalized}\u7f51\u7edc\u8d28\u91cf\u6982\u89c8\u3011`;
      case 'application_summary':
        return `\u3010${normalized}\u5e94\u7528\u4f53\u9a8c\u6982\u89c8\u3011`;
      case 'connection_summary':
        return `\u3010${normalized}\u8fde\u63a5\u72b6\u6001\u6982\u89c8\u3011`;
      default:
        return `\u3010${normalized}\u7efc\u5408\u6982\u89c8\u3011`;
    }
  }

  buildOverviewNextActions(overview, template) {
    const nextActions = Array.isArray(overview?.nextActions) ? overview.nextActions.filter(Boolean) : [];
    const defaultNextActions = Array.isArray(template?.defaultNextActions)
      ? template.defaultNextActions.filter(Boolean)
      : [];
    return Array.from(new Set(nextActions.concat(defaultNextActions))).slice(0, 4);
  }

  shouldIncludeSuggestions(userQuery) {
    const text = String(userQuery || '');
    return /(给出对应建议|给出建议|优化建议|排查建议|建议|如何处理|怎么处理)/i.test(text);
  }

  async optimize(payload, requestContext = null) {
    if (!this.isEnabled()) {
      return null;
    }

    const service = payload?.resolvedQuery?.service;
    if (!['topValues', 'timeValues', 'averageValues'].includes(service)) {
      return null;
    }

    if (payload?.summary?.empty) {
      return null;
    }

    const narrativeInput = this.buildNarrativeInput(payload);
    if (!narrativeInput || narrativeInput.factItems.length === 0) {
      return null;
    }

    logAudit('result_narration_started', {
      userQuery: payload?.userQuery,
      service,
      factCount: narrativeInput.factItems.length,
      suggestionCount: narrativeInput.suggestionItems.length,
      allowSuggestions: narrativeInput.allowSuggestions
    }, requestContext);

    const fallback = this.buildDeterministicFallback(payload, narrativeInput);
    logAudit('result_narration_completed', {
      userQuery: payload?.userQuery,
      mode: fallback.meta.mode,
      overview: fallback.meta.overview,
      factCount: fallback.meta.factCount,
      suggestionCount: fallback.meta.suggestionCount
    }, requestContext);
    return fallback;
  }

  buildNarrativeInput(payload) {
    const service = payload?.resolvedQuery?.service;
    const allowSuggestions = this.shouldIncludeSuggestions(payload?.userQuery);
    const groupPath = this.formatGroupPath(payload?.resolvedQuery?.groups);
    const metrics = Array.isArray(payload?.summary?.metrics) && payload.summary.metrics.length > 0
      ? payload.summary.metrics
      : (Array.isArray(payload?.resolvedQuery?.metrics) ? payload.resolvedQuery.metrics : []);

    if (service === 'topValues') {
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      return {
        service,
        userQuery: payload?.userQuery,
        groupPath,
        metrics,
        allowSuggestions,
        factItems: this.buildTopValueFacts(rows, groupPath, metrics),
        suggestionItems: allowSuggestions ? this.buildTopValueSuggestions(rows, groupPath, metrics) : []
      };
    }

    if (service === 'timeValues') {
      const series = payload?.structuredSeries || null;
      return {
        service,
        userQuery: payload?.userQuery,
        groupPath,
        metrics,
        allowSuggestions,
        factItems: this.buildTimeSeriesFacts(series, groupPath, metrics),
        suggestionItems: allowSuggestions ? this.buildTimeSeriesSuggestions(series, groupPath, metrics) : []
      };
    }

    if (service === 'averageValues') {
      const rows = this.normalizeAverageRows(payload);
      return {
        service,
        userQuery: payload?.userQuery,
        groupPath,
        metrics,
        allowSuggestions,
        factItems: this.buildAverageFacts(rows, groupPath, metrics),
        suggestionItems: allowSuggestions ? this.buildAverageSuggestions(rows, groupPath, metrics) : []
      };
    }

    return null;
  }

  buildTopValueFacts(rows, groupPath, metrics) {
    const items = Array.isArray(rows) ? rows : [];
    const facts = [];
    if (groupPath) {
      facts.push(`对象路径为 ${groupPath}。`);
    }
    if (metrics.length > 0) {
      facts.push(`本次查询使用的指标为 ${metrics.join('、')}。`);
    }
    facts.push(`本次共返回 ${items.length} 条排序结果。`);

    items.slice(0, 10).forEach((row, index) => {
      facts.push(`第${index + 1}名是 ${row?.object || '-'}，${this.formatMetricPairs(row, metrics)}。`);
    });

    const firstMetric = metrics[0];
    if (firstMetric && items.length >= 2) {
      const firstValue = this.extractPrimaryValue(items[0], firstMetric);
      const secondValue = this.extractPrimaryValue(items[1], firstMetric);
      if (Number.isFinite(firstValue) && Number.isFinite(secondValue)) {
        facts.push(`按 ${firstMetric} 计算，第1名与第2名的差值为 ${this.formatNumber(firstValue - secondValue)}。`);
      }
    }

    return facts;
  }

  buildTopValueSuggestions(rows, groupPath, metrics) {
    const items = Array.isArray(rows) ? rows : [];
    if (items.length === 0) {
      return [];
    }

    const topObjects = items.slice(0, Math.min(3, items.length)).map(item => item?.object).filter(Boolean);
    const suggestions = [];
    if (topObjects.length > 0) {
      suggestions.push(`建议优先围绕排名靠前的对象继续下钻：${topObjects.join('、')}。`);
    }
    if (groupPath) {
      suggestions.push(`建议基于当前路径 ${groupPath} 继续查看这些对象的趋势或明细。`);
    }
    if (metrics.includes('PLI') || metrics.includes('PLO')) {
      suggestions.push('建议继续区分流入与流出方向，确认问题更集中在哪个方向。');
    } else if (metrics.length > 0) {
      suggestions.push(`建议围绕指标 ${metrics.join('、')} 继续查看趋势，确认是瞬时峰值还是持续高位。`);
    }
    return suggestions;
  }

  buildTimeSeriesFacts(series, groupPath, metrics) {
    const facts = [];
    if (!series) {
      return facts;
    }

    if (groupPath) {
      facts.push(`对象路径为 ${groupPath}。`);
    }

    const seriesItems = Array.isArray(series?.series) && series.series.length > 0
      ? series.series
      : [series];

    seriesItems.forEach((item) => {
      const metricId = item?.metric || metrics[0] || '-';
      const points = Array.isArray(item?.points) ? item.points.filter(point => point && point.valid !== false && Number.isFinite(point.value)) : [];
      if (points.length === 0) {
        return;
      }

      const values = points.map(point => Number(point.value));
      const first = values[0];
      const last = values[values.length - 1];
      const max = Math.max(...values);
      const min = Math.min(...values);
      const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

      facts.push(`${metricId} 共保留 ${points.length} 个有效点。`);
      facts.push(`${metricId} 的首点为 ${this.formatNumber(first)}，末点为 ${this.formatNumber(last)}，均值为 ${this.formatNumber(avg)}。`);
      facts.push(`${metricId} 的最小值为 ${this.formatNumber(min)}，最大值为 ${this.formatNumber(max)}。`);
    });

    return facts;
  }

  buildTimeSeriesSuggestions(series, groupPath, metrics) {
    const seriesItems = Array.isArray(series?.series) && series.series.length > 0
      ? series.series
      : (series ? [series] : []);
    const suggestions = [];

    seriesItems.forEach((item) => {
      const metricId = item?.metric || metrics[0] || '-';
      const points = Array.isArray(item?.points) ? item.points.filter(point => point && point.valid !== false && Number.isFinite(point.value)) : [];
      if (points.length < 2) {
        return;
      }
      const first = Number(points[0].value);
      const last = Number(points[points.length - 1].value);
      const maxPoint = points.reduce((best, current) => (current.value > best.value ? current : best), points[0]);
      if (last > first) {
        suggestions.push(`建议优先关注 ${metricId} 在接近结束时段的抬升表现，并复核峰值点附近的数据。`);
      } else {
        suggestions.push(`建议优先回看 ${metricId} 的峰值点，确认是否存在短时突增。`);
      }
      if (Number.isFinite(maxPoint?.timestamp)) {
        suggestions.push(`建议重点查看时间点 ${maxPoint.timestamp} 附近的相关对象明细。`);
      }
    });

    if (groupPath && suggestions.length > 0) {
      suggestions.unshift(`建议在当前路径 ${groupPath} 下继续做分层下钻，定位峰值来源对象。`);
    }

    return Array.from(new Set(suggestions)).slice(0, 4);
  }

  buildAverageFacts(rows, groupPath, metrics) {
    const items = Array.isArray(rows) ? rows : [];
    const facts = [];
    if (groupPath) {
      facts.push(`对象路径为 ${groupPath}。`);
    }
    if (metrics.length > 0) {
      facts.push(`本次平均值查询涉及指标 ${metrics.join('、')}。`);
    }
    if (items.length === 0) {
      return facts;
    }

    items.slice(0, 5).forEach((row, index) => {
      const label = row?.object || `对象${index + 1}`;
      facts.push(`${label} 的平均结果为 ${this.formatMetricPairs(row, metrics)}。`);
    });

    return facts;
  }

  buildAverageSuggestions(rows, groupPath, metrics) {
    const items = Array.isArray(rows) ? rows : [];
    if (items.length === 0) {
      return [];
    }

    const first = items[0];
    const label = first?.object || '当前对象';
    const suggestions = [
      `建议围绕 ${label} 继续查看趋势数据，确认当前平均值是否由短时峰值抬高。`
    ];
    if (groupPath) {
      suggestions.push(`建议在当前路径 ${groupPath} 下继续下钻相关对象明细。`);
    }
    if (metrics.length > 0) {
      suggestions.push(`建议结合 ${metrics.join('、')} 的 TopN 或趋势查询继续定位重点对象。`);
    }
    return suggestions;
  }

  normalizeAverageRows(payload) {
    const metrics = Array.isArray(payload?.summary?.metrics) && payload.summary.metrics.length > 0
      ? payload.summary.metrics
      : (Array.isArray(payload?.resolvedQuery?.metrics) ? payload.resolvedQuery.metrics : []);
    const rawRows = Array.isArray(payload?.rawRows) ? payload.rawRows : [];

    if (rawRows.length > 0 && rawRows[0]?.group && Array.isArray(rawRows[0]?.metricValues)) {
      return rawRows.map((row) => {
        const values = {};
        const units = {};
        row.metricValues.forEach((item) => {
          const metricId = item?.metric?.id;
          if (!metricId) {
            return;
          }
          const averageValue = Number.isFinite(Number(item?.average))
            ? Number(item.average)
            : (Number.isFinite(Number(item?.value)) ? Number(item.value) : null);
          values[metricId] = averageValue;
          units[metricId] = item?.unit || item?.metric?.unit || null;
        });
        return {
          object: row.group.argument || row.group.label || row.group.key || null,
          values,
          units,
          metrics: Object.keys(values)
        };
      });
    }

    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (rows.length > 0 && rows[0]?.values) {
      return rows;
    }

    if (rows.length > 0 && metrics.length > 0) {
      return rows.map((row) => {
        const values = {};
        metrics.forEach((metricId) => {
          if (row && Object.prototype.hasOwnProperty.call(row, metricId)) {
            values[metricId] = this.toFiniteNumber(row[metricId]);
          }
        });
        return {
          object: row?.object || null,
          values,
          metrics: Object.keys(values)
        };
      });
    }

    return [];
  }

  buildSystemPrompt() {
    return [
      'You are a grounded NAPM result narrator.',
      'You will receive fact_items and suggestion_items that were generated only from real query results.',
      'You must not invent any metrics, values, objects, time ranges, causes, or recommendations.',
      'You may only organize and rewrite the supplied items.',
      'If allow_suggestions is false, suggestion_order must be an empty array.',
      'Return JSON only with keys: overview, fact_order, suggestion_order.',
      'overview must be one concise Chinese sentence.'
    ].join(' ');
  }

  buildUserPrompt(input) {
    return JSON.stringify({
      user_query: input.userQuery,
      service: input.service,
      group_path: input.groupPath || null,
      metrics: input.metrics,
      allow_suggestions: input.allowSuggestions,
      fact_items: input.factItems,
      suggestion_items: input.suggestionItems
    }, null, 2);
  }

  buildNarrationFromPlan(plan, input) {
    const factOrder = this.normalizeIndexOrder(plan?.fact_order, input.factItems.length);
    const suggestionOrder = input.allowSuggestions
      ? this.normalizeIndexOrder(plan?.suggestion_order, input.suggestionItems.length)
      : [];
    const facts = factOrder.map(index => input.factItems[index]).filter(Boolean);
    const suggestions = suggestionOrder.map(index => input.suggestionItems[index]).filter(Boolean);
    const overview = String(plan?.overview || '').trim() || '已根据本次真实返回数据整理出以下结果。';

    const lines = [`结论：${overview}`];
    if (facts.length > 0) {
      lines.push('关键结果：');
      facts.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    }

    if (input.allowSuggestions && suggestions.length > 0) {
      lines.push('建议：');
      suggestions.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    }

    return {
      displayText: lines.join('\n'),
      meta: {
        enabled: true,
        mode: 'grounded_ai_rewrite',
        overview,
        factCount: facts.length,
        suggestionCount: suggestions.length,
        allowSuggestions: input.allowSuggestions
      }
    };
  }

  buildDeterministicFallback(input) {
    const facts = Array.isArray(input?.factItems) ? input.factItems : [];
    const suggestions = input?.allowSuggestions
      ? (Array.isArray(input?.suggestionItems) ? input.suggestionItems.slice(0, 3) : [])
      : [];
    const overview = this.buildDeterministicOverview(input);
    const lines = [`结论：${overview}`];

    if (facts.length > 0) {
      lines.push('关键结果：');
      facts.slice(0, 6).forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    }

    if (input?.allowSuggestions && suggestions.length > 0) {
      lines.push('建议：');
      suggestions.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    }

    return {
      displayText: lines.join('\n'),
      meta: {
        enabled: true,
        mode: 'deterministic_fallback',
        overview,
        factCount: Math.min(facts.length, 6),
        suggestionCount: suggestions.length,
        allowSuggestions: Boolean(input?.allowSuggestions)
      }
    };
  }

  buildStructuredResponse(payload, narration = null, narrativeInput = null) {
    const responseType = this.resolveResponseType(payload);
    const structure = {
      responseType,
      overview: null,
      facts: [],
      suggestions: [],
      compare: null,
      diagnose: null
    };

    if (payload?.summary?.overview) {
      structure.overview = {
        summary: payload.summary.overview.summary || null,
        topFindings: Array.isArray(payload.summary.overview.topFindings) ? payload.summary.overview.topFindings : [],
        nextActions: Array.isArray(payload.summary.overview.nextActions) ? payload.summary.overview.nextActions : [],
        summaryMetrics: payload.summary.overview.summaryMetrics || null
      };
      structure.facts = Array.isArray(payload.summary.overview.topFindings) ? payload.summary.overview.topFindings : [];
      structure.suggestions = Array.isArray(payload.summary.overview.nextActions) ? payload.summary.overview.nextActions : [];
      return structure;
    }

    const input = narrativeInput || this.buildNarrativeInput(payload) || { factItems: [], suggestionItems: [] };
    structure.overview = narration?.meta?.overview || this.buildDeterministicOverview(input);
    structure.facts = (Array.isArray(input.factItems) ? input.factItems : []).slice(0, 8);
    structure.suggestions = (Array.isArray(input.suggestionItems) ? input.suggestionItems : []).slice(0, 5);

    if (responseType === 'diagnose') {
      structure.diagnose = {
        planKey: payload?.diagnosticPlan?.key || null,
        currentStep: payload?.diagnosticPlan?.currentStep || null,
        nextStep: payload?.diagnosticPlan?.nextStep || null,
        findings: structure.facts.slice(0, 5)
      };
    }

    if (responseType === 'compare') {
      structure.compare = {
        planKey: payload?.comparePlan?.key || null,
        metricDomain: payload?.comparePlan?.metricDomain || null,
        domainLabel: payload?.comparePlan?.domainLabel || null,
        focusMetrics: Array.isArray(payload?.comparePlan?.focusMetrics) ? payload.comparePlan.focusMetrics : [],
        nextActions: Array.isArray(payload?.comparePlan?.nextActions) ? payload.comparePlan.nextActions : [],
        findings: structure.facts.slice(0, 5)
      };
    }

    return structure;
  }

  buildResponse(plan, executionResult, diagnosis = null) {
    if (plan?.mode === 'overview') {
      const overviewPlaybook = String(plan?.overviewPlaybook || executionResult?.overviewPlaybook || 'global_summary').trim() || 'global_summary';
      return {
        responseType: 'overview',
        template: this.resolveOverviewTemplate(overviewPlaybook),
        overviewPlaybook,
        summary: executionResult?.summary || null,
        topFindings: executionResult?.topFindings || [],
        nextActions: plan?.nextActions || []
      };
    }

    if (plan?.mode === 'diagnostic') {
      return {
        responseType: 'diagnose',
        template: this.responseTemplates.diagnose || null,
        title: diagnosis?.title || '诊断分析',
        summary: diagnosis?.summary || {},
        conclusion: diagnosis?.conclusion || '',
        evidence: diagnosis?.evidence || [],
        recommendation: diagnosis?.recommendation || []
      };
    }

    return {
      responseType: 'topn',
      template: this.responseTemplates.topn || null,
      data: executionResult || null
    };
  }

  resolveResponseType(payload) {
    if (payload?.summary?.overview) {
      return 'overview';
    }
    if (payload?.comparePlan?.key && payload?.resolvedQuery?.service === 'timeValues') {
      return payload.comparePlan.responseType || 'compare';
    }
    if (payload?.diagnosticPlan?.key) {
      return 'diagnose';
    }

    const service = payload?.resolvedQuery?.service;
    if (service === 'topValues') {
      return 'topn';
    }
    if (service === 'timeValues') {
      return 'compare';
    }
    if (service === 'averageValues') {
      return 'diagnose';
    }
    return 'query';
  }

  buildDeterministicFallback(payload, input) {
    const structure = this.buildStructuredResponse(payload, null, input);
    const displayText = this.formatStructuredResponse(structure);
    const overview = this.extractOverviewText(structure) || this.buildDeterministicOverview(input);

    return {
      displayText,
      structure,
      meta: {
        enabled: true,
        mode: 'deterministic_fallback',
        overview,
        factCount: this.countStructureFacts(structure),
        suggestionCount: this.countStructureSuggestions(structure),
        allowSuggestions: Boolean(input?.allowSuggestions)
      }
    };
  }

  buildStructuredResponse(payload, narration = null, narrativeInput = null) {
    const responseType = this.resolveResponseType(payload);
    const input = narrativeInput || this.buildNarrativeInput(payload) || {
      factItems: [],
      suggestionItems: [],
      metrics: []
    };

    if (responseType === 'overview') {
      return this.buildOverviewStructure(payload);
    }

    if (responseType === 'topn') {
      return this.buildTopnStructure(payload, input);
    }

    if (responseType === 'trend') {
      return this.buildTrendStructure(payload, input);
    }

    if (responseType === 'compare') {
      return this.buildCompareStructure(payload, input, narration);
    }

    if (responseType === 'diagnose') {
      return this.buildDiagnoseStructure(payload, input, narration);
    }

    return {
      responseType: 'query',
      title: this.buildBracketTitle(payload, '查询结果'),
      summary: input.factItems.slice(0, 5),
      nextActions: input.suggestionItems.slice(0, 3)
    };
  }

  resolveResponseType(payload) {
    if (this.hasDiagnosePayload(payload)) {
      return 'diagnose';
    }

    if (payload?.summary?.overview) {
      return 'overview';
    }

    const service = payload?.resolvedQuery?.service;
    if (service === 'topValues') {
      return 'topn';
    }
    if (this.hasComparePayload(payload) && service === 'averageValues') {
      return 'compare';
    }
    if (this.hasComparePayload(payload) && service === 'timeValues') {
      return 'compare';
    }
    if (service === 'timeValues') {
      return 'trend';
    }
    if (service === 'averageValues' && payload?.policyEnvelope?.action === 'diagnose') {
      return 'diagnose';
    }
    return 'query';
  }

  hasComparePayload(payload) {
    return Boolean(
      payload?.summary?.compare
      || payload?.comparePlan?.key
      || payload?.compareResult
      || (
        Array.isArray(payload?.summary?.current)
        && Array.isArray(payload?.summary?.baseline)
        && Array.isArray(payload?.summary?.delta)
      )
    );
  }

  hasDiagnosePayload(payload) {
    return Boolean(
      payload?.summary?.diagnose
      || payload?.diagnosticResult
      || payload?.diagnosticPlan?.playbookId
      || payload?.diagnosticPlan?.key
      || payload?.partialQuery?.diagnosticPlaybookId
      || payload?.policyEnvelope?.action === 'diagnose'
    );
  }

  buildOverviewStructure(payload) {
    const overview = payload?.summary?.overview || {};
    const overviewPlaybook = this.resolveOverviewPlaybook(payload);
    const template = this.resolveOverviewTemplate(overviewPlaybook);
    const timeLabel = String(overview?.timeLabel || '当前').trim();
    const topFindings = (Array.isArray(overview?.topFindings) ? overview.topFindings : [])
      .slice(0, 5)
      .map((item, index) => ({
        rank: index + 1,
        object: item?.object || `对象${index + 1}`,
        metric: item?.metric || null,
        value: item?.value || null,
        domain: item?.domain || null
      }));

    return {
      responseType: 'overview',
      overviewPlaybook,
      template,
      title: this.buildOverviewTitle(overviewPlaybook, timeLabel),
      timeScope: this.buildTimeScopeText(payload, timeLabel),
      summary: this.buildOverviewSummaryLines(overview, overviewPlaybook, topFindings),
      topFindings,
      judgment: this.buildOverviewJudgment(overview, topFindings, overviewPlaybook),
      findingLabel: String(template?.findingLabel || '褰撳墠鏈€寮傚父瀵硅薄锛?').trim(),
      judgmentLabel: String(template?.judgmentLabel || '鍒濇鍒ゆ柇锛?').trim(),
      nextActionsLabel: String(template?.nextActionsLabel || '鍙户缁煡鐪嬶細').trim(),
      nextActions: this.buildOverviewNextActions(overview, template),
      summaryMetrics: overview?.summaryMetrics || null
    };
  }

  buildTopnStructure(payload, input) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const metricId = payload?.resolvedQuery?.metric
      || (Array.isArray(payload?.resolvedQuery?.metrics) ? payload.resolvedQuery.metrics[0] : null)
      || (Array.isArray(input?.metrics) ? input.metrics[0] : null)
      || null;
    const topCount = this.resolveTopCount(payload, rows.length);
    const timeLabel = this.resolveTimeRangeLabel(payload);
    const objectLabel = this.resolveObjectLabel(payload);

    return {
      responseType: 'topn',
      title: this.buildTopnTitle(metricId, objectLabel, topCount, timeLabel, payload),
      items: rows.slice(0, 5).map((row, index) => ({
        rank: index + 1,
        object: row?.object || `对象${index + 1}`,
        value: this.formatMetricValue(
          this.extractPrimaryValue(row, metricId) ?? row?.value ?? null,
          this.resolveMetricUnit(row, metricId)
        ),
        metric: metricId
      })),
      explanation: this.buildTopnExplanation(metricId, timeLabel, topCount, Math.min(5, rows.length)),
      nextActions: (Array.isArray(input?.suggestionItems) ? input.suggestionItems : []).slice(0, 3)
    };
  }

  buildTrendStructure(payload, input) {
    const series = this.resolvePrimarySeries(payload?.structuredSeries || null);
    const points = Array.isArray(series?.points)
      ? series.points.filter(point => point && point.valid !== false && Number.isFinite(Number(point.value)))
      : [];
    const values = points.map(point => Number(point.value));
    const unit = series?.unit || null;
    const currentValue = values.length > 0 ? values[values.length - 1] : null;
    const peakValue = values.length > 0 ? Math.max(...values) : null;
    const averageValue = values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    const metricId = series?.metric
      || payload?.resolvedQuery?.metric
      || (Array.isArray(payload?.resolvedQuery?.metrics) ? payload.resolvedQuery.metrics[0] : null)
      || null;
    const timeLabel = this.resolveTimeRangeLabel(payload);

    return {
      responseType: 'trend',
      title: this.buildTrendTitle(metricId, timeLabel, payload),
      current: this.formatMetricValue(currentValue, unit),
      peak: this.formatMetricValue(peakValue, unit),
      average: this.formatMetricValue(averageValue, unit),
      changes: this.buildTrendChangeLines(points, unit),
      nextActions: (Array.isArray(input?.suggestionItems) ? input.suggestionItems : []).slice(0, 3)
    };
  }

  buildCompareStructure(payload, input, narration = null) {
    const compare = payload?.summary?.compare || payload?.compareResult || {};
    const profile = this.resolveCompareProfile(payload);
    const current = this.normalizeCompareMetricItems(compare?.current || payload?.summary?.current, 'current');
    const baseline = this.normalizeCompareMetricItems(compare?.baseline || payload?.summary?.baseline, 'baseline');
    const delta = this.normalizeCompareMetricItems(compare?.delta || payload?.summary?.delta, 'delta');

    return {
      responseType: 'compare',
      title: this.buildCompareTitle(payload),
      intro: String(profile?.intro || '').trim(),
      current,
      baseline,
      delta,
      conclusion: this.buildCompareConclusion(payload, delta, narration, input),
      nextActions: this.buildCompareNextActions(profile, payload)
    };
  }

  buildDiagnoseStructure(payload, input, narration = null) {
    const diagnose = payload?.summary?.diagnose || payload?.diagnosticResult || {};
    const profile = this.resolveDiagnoseProfile(payload, diagnose);
    const summaryLines = this.buildDiagnoseSummaryLinesV1(diagnose, profile);
    const evidence = this.buildDiagnoseEvidenceV1(diagnose, profile, input);
    const recommendations = this.buildDiagnoseRecommendationsV1(diagnose, profile, input);
    const nextActions = this.buildDiagnoseNextActions(profile, diagnose, recommendations, input);
    const conclusion = this.buildDiagnoseConclusionV1(diagnose, profile, narration, input);
    const affectedObjects = Array.isArray(diagnose?.anomalyTopn?.items)
      ? diagnose.anomalyTopn.items.slice(0, 3).map((item) => ({
        rank: item?.rank || null,
        object: item?.object || null,
        value: this.formatMetricValue(item?.value ?? null, item?.unit || null),
        metric: item?.metric || null
      }))
      : [];

    return {
      responseType: 'diagnose',
      title: this.buildDiagnoseTitleV1(payload, profile, diagnose),
      intro: String(profile?.intro || '').trim(),
      category: this.normalizeCategoryLabel(
        profile?.title || payload?.diagnosticPlan?.metricDomain || payload?.resolvedQuery?.metricDomain || 'Diagnostic'
      ),
      confidence: this.normalizeConfidence(
        diagnose?.judge?.confidence
        || payload?.semanticResolutionResult?.confidence
        || 0.78
      ),
      summary: summaryLines.length > 0 ? summaryLines : evidence.slice(0, 3),
      conclusion,
      evidence,
      recommendation: recommendations,
      nextActions,
      affectedObjects
    };
  }

  resolveDiagnoseProfile(payload, diagnose = {}) {
    const titleKey = String(
      diagnose?.titleKey
      || payload?.diagnosticPlan?.titleKey
      || payload?.partialQuery?.diagnoseTitleKey
      || ''
    ).trim() || 'application';
    return this.responseTemplates[`diagnose_${titleKey}`]
      || this.responseTemplates.diagnose
      || {
        title: '诊断分析',
        intro: '',
        defaultNextActions: []
      };
  }

  buildDiagnoseTitleV1(payload, profile, diagnose = {}) {
    const baseTitle = String(profile?.title || '诊断分析').trim() || '诊断分析';
    const focusName = String(diagnose?.focusObject?.value || '').trim();
    if (focusName) {
      return `【${focusName}${baseTitle}】`;
    }
    return `【${baseTitle}】`;
  }

  buildDiagnoseSummaryLinesV1(diagnose = {}, profile = {}) {
    const lines = [];
    const focusName = String(diagnose?.focusObject?.value || '').trim();
    const scopeMode = String(diagnose?.executionMeta?.scopeMode || '').trim();
    if (focusName) {
      lines.push(`当前先按对象 ${focusName} 做最小诊断。`);
    } else if (scopeMode === 'web_scope_summary') {
      lines.push('当前先按网站域做摘要诊断，不把结果表述成已定位到具体页面。');
    }

    const currentMetrics = Array.isArray(diagnose?.current?.metrics) ? diagnose.current.metrics : [];
    const baselineMetrics = Array.isArray(diagnose?.baseline?.metrics) ? diagnose.baseline.metrics : [];
    currentMetrics.slice(0, 3).forEach((item) => {
      const baselineItem = baselineMetrics.find((candidate) => candidate?.metric === item?.metric) || null;
      const label = item?.label || this.describeMetric(item?.metric || '') || item?.metric || '指标';
      const currentText = this.formatMetricValue(item?.value ?? null, item?.unit || null);
      const baselineText = this.formatMetricValue(baselineItem?.value ?? null, baselineItem?.unit || item?.unit || null);
      lines.push(`${label}当前为 ${currentText}，昨日同时间为 ${baselineText}。`);
    });
    return lines.filter(Boolean).slice(0, 4);
  }

  buildDiagnoseEvidenceV1(diagnose = {}, profile = {}, input = null) {
    const judgeEvidence = Array.isArray(diagnose?.judge?.evidence) ? diagnose.judge.evidence.filter(Boolean) : [];
    if (judgeEvidence.length > 0) {
      return judgeEvidence.slice(0, 4);
    }
    return this.filterEvidenceItems(input?.factItems).slice(0, 4);
  }

  buildDiagnoseRecommendationsV1(diagnose = {}, profile = {}, input = null) {
    const judgeRecommendations = Array.isArray(diagnose?.judge?.recommendation)
      ? diagnose.judge.recommendation.filter(Boolean)
      : [];
    if (judgeRecommendations.length > 0) {
      return judgeRecommendations.slice(0, 3);
    }
    return (Array.isArray(input?.suggestionItems) ? input.suggestionItems : []).slice(0, 3);
  }

  buildDiagnoseNextActions(profile = {}, diagnose = {}, recommendations = [], input = null) {
    const defaults = Array.isArray(profile?.defaultNextActions) ? profile.defaultNextActions.filter(Boolean) : [];
    const inputActions = Array.isArray(input?.suggestionItems) ? input.suggestionItems.filter(Boolean) : [];
    return Array.from(new Set(defaults.concat(inputActions)))
      .filter((item) => !recommendations.includes(item))
      .slice(0, 3);
  }

  buildDiagnoseConclusionV1(diagnose = {}, profile = {}, narration = null, input = null) {
    const judgeConclusion = String(diagnose?.judge?.conclusion || '').trim();
    if (judgeConclusion) {
      return judgeConclusion;
    }
    return String(narration?.meta?.overview || this.buildDeterministicOverview(input)).trim();
  }

  buildOverviewSummaryLines(overview, playbook = 'global_summary', topFindings = []) {
    const leadText = String(overview?.leadText || '').trim();
    const lines = [];
    if (leadText) {
      lines.push(leadText);
    }

    lines.push(...this.extractOverviewBaseSummaryLines(overview));
    const focusLine = this.buildOverviewFocusLine(playbook, topFindings);
    if (focusLine) {
      lines.push(focusLine);
    }

    return Array.from(new Set(lines.filter(Boolean))).slice(0, 5);
  }

  extractOverviewBaseSummaryLines(overview) {
    const sections = Array.isArray(overview?.summary?.sections) ? overview.summary.sections : [];
    const lines = sections
      .map((section) => {
        if (typeof section === 'string') {
          return section.trim();
        }
        return String(section?.text || '').trim();
      })
      .filter(Boolean);
    if (lines.length > 0) {
      return lines;
    }

    const summaryMetrics = overview?.summaryMetrics && typeof overview.summaryMetrics === 'object'
      ? overview.summaryMetrics
      : {};
    return Object.values(summaryMetrics)
      .map((item) => {
        const label = this.describeMetric(item?.metric || item?.key || '指标');
        const valueText = String(item?.valueText || '').trim();
        if (!valueText) {
          return null;
        }
        return `${label}：${valueText}`;
      })
      .filter(Boolean)
      .slice(0, 4);
  }

  buildOverviewFocusLine(playbook, topFindings = []) {
    const labels = (Array.isArray(topFindings) ? topFindings : [])
      .slice(0, 3)
      .map((item) => String(item?.object || '').trim())
      .filter(Boolean);
    if (labels.length === 0) {
      return '';
    }

    switch (playbook) {
      case 'network_summary':
        return `当前波动更明显的链路或对象主要集中在 ${labels.join('、')}。`;
      case 'application_summary':
        return `当前更慢的应用或页面对象主要集中在 ${labels.join('、')}。`;
      case 'connection_summary':
        return `当前连接异常更集中的对象主要是 ${labels.join('、')}。`;
      default:
        return `当前更值得优先关注的对象主要是 ${labels.join('、')}。`;
    }
  }

  buildDiagnoseSummaryLines(row, payload) {
    if (!row) {
      return [];
    }

    const metrics = Array.isArray(row?.metrics) ? row.metrics : Object.keys(row?.values || {});
    const lines = metrics.slice(0, 4).map((metricId) => {
      const value = row?.values?.[metricId];
      const unit = row?.units?.[metricId] || this.resolveMetricUnit(row, metricId);
      return `${this.describeMetric(metricId) || metricId}：${this.formatMetricValue(value, unit)}`;
    });

    if (lines.length > 0) {
      return lines;
    }

    const metricId = payload?.resolvedQuery?.metric
      || (Array.isArray(payload?.resolvedQuery?.metrics) ? payload.resolvedQuery.metrics[0] : null)
      || null;
    if (metricId && row?.value !== undefined) {
      return [`${this.describeMetric(metricId) || metricId}：${this.formatMetricValue(row.value, row.unit || null)}`];
    }

    return [];
  }

  buildDiagnoseEvidence(row, payload, input) {
    const metrics = this.extractMetricValueMap(row);
    const evidence = [];

    if (metrics.PGTME !== null) {
      evidence.push(`页面延时当前为 ${this.formatMetricValue(metrics.PGTME, row?.units?.PGTME || null)}。`);
    }
    if (metrics.TRTI !== null) {
      evidence.push(`服务器响应时间为 ${this.formatMetricValue(metrics.TRTI, row?.units?.TRTI || null)}。`);
    }
    if (metrics.RTTI !== null) {
      evidence.push(`网络时延为 ${this.formatMetricValue(metrics.RTTI, row?.units?.RTTI || null)}。`);
    }
    if (metrics.PGHTTP500PCT !== null) {
      evidence.push(metrics.PGHTTP500PCT > 0
        ? `HTTP 5xx 比例为 ${this.formatMetricValue(metrics.PGHTTP500PCT, row?.units?.PGHTTP500PCT || null)}。`
        : 'HTTP 5xx 无明显升高。');
    }

    if (evidence.length > 0) {
      return evidence.slice(0, 4);
    }

    return this.filterEvidenceItems(input?.factItems).slice(0, 4);
  }

  buildDiagnoseRecommendations(row, payload, input) {
    const metrics = this.extractMetricValueMap(row);
    const recommendations = [];
    const category = this.normalizeCategoryLabel(
      payload?.diagnosticPlan?.category || payload?.resolvedQuery?.metricDomain || ''
    );

    if (metrics.TRTI !== null && (metrics.RTTI === null || metrics.TRTI >= metrics.RTTI * 2)) {
      recommendations.push('检查应用线程池。');
      recommendations.push('检查数据库慢SQL。');
      recommendations.push('查看后端服务日志。');
    } else if (metrics.RTTI !== null && (metrics.TRTI === null || metrics.RTTI >= metrics.TRTI * 2)) {
      recommendations.push('检查链路时延与丢包情况。');
      recommendations.push('查看 RTT / 重传趋势。');
      recommendations.push('确认关键网段或 VLAN 是否存在拥塞。');
    } else if (category === 'Web') {
      recommendations.push('查看最慢页面 Top10。');
      recommendations.push('检查页面资源加载与后端接口耗时。');
      recommendations.push('对照同时间窗基线继续诊断。');
    }

    if (recommendations.length > 0) {
      return recommendations.slice(0, 3);
    }

    return (Array.isArray(input?.suggestionItems) ? input.suggestionItems : []).slice(0, 3);
  }

  buildDiagnoseConclusion(row, payload, input, narration = null) {
    const metrics = this.extractMetricValueMap(row);
    if (metrics.PGHTTP500PCT !== null && metrics.PGHTTP500PCT > 0) {
      return '慢问题伴随 HTTP 5xx 异常，建议优先检查应用服务稳定性。';
    }
    if (metrics.TRTI !== null && metrics.RTTI !== null && metrics.TRTI >= metrics.RTTI * 2) {
      return '慢主要来自服务器处理延迟升高。';
    }
    if (metrics.RTTI !== null && metrics.TRTI !== null && metrics.RTTI >= metrics.TRTI * 2) {
      return '慢主要来自网络传输时延升高。';
    }
    if (metrics.PGTME !== null && metrics.TRTI !== null && metrics.TRTI >= 1) {
      return '页面变慢主要体现在服务器响应阶段。';
    }
    return String(narration?.meta?.overview || this.buildDeterministicOverview(input)).trim();
  }

  buildCompareConclusion(payload, deltaItems, narration = null, input = null) {
    const targetName = this.resolveTargetName(payload) || this.resolveCompareProfile(payload)?.title || '当前范围';
    const currentLabel = this.resolveTimeRangeLabel(payload) || '当前窗口';
    const positiveItems = (Array.isArray(deltaItems) ? deltaItems : []).filter((item) => /^\+/.test(String(item?.value || '').trim()));
    const negativeItems = (Array.isArray(deltaItems) ? deltaItems : []).filter((item) => /^-/.test(String(item?.value || '').trim()));

    if (positiveItems.length >= 2) {
      const highlights = positiveItems.slice(0, 2).map(item => item.label).join('和');
      return `${currentLabel} ${targetName} 整体表现较基线变差，主要体现在${highlights}上。`;
    }
    if (negativeItems.length >= 2) {
      const highlights = negativeItems.slice(0, 2).map(item => item.label).join('和');
      return `${currentLabel} ${targetName} 整体表现较基线改善，主要体现在${highlights}上。`;
    }

    return String(narration?.meta?.overview || this.buildDeterministicOverview(input)).trim();
  }

  filterEvidenceItems(items) {
    return (Array.isArray(items) ? items : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .filter(item => !/^对象路径/.test(item))
      .filter(item => !/^本次/.test(item));
  }

  resolvePrimarySeries(series) {
    if (!series) {
      return null;
    }

    if (Array.isArray(series?.series) && series.series.length > 0) {
      return series.series[0];
    }

    return series;
  }

  buildTrendChangeLines(points, unit = null) {
    const lines = [];
    if (!Array.isArray(points) || points.length < 2) {
      return lines;
    }

    const firstValue = Number(points[0].value);
    const lastValue = Number(points[points.length - 1].value);
    const delta = lastValue - firstValue;
    const peakPoint = points.reduce((best, current) => (
      Number(current.value) > Number(best.value) ? current : best
    ), points[0]);

    if (Math.abs(delta) < Math.max(Math.abs(firstValue) * 0.1, 1)) {
      lines.push('整体波动相对平稳。');
    } else if (delta > 0) {
      lines.push(`整体呈上升趋势，较起点增加 ${this.formatMetricValue(delta, unit)}。`);
    } else {
      lines.push(`整体呈下降趋势，较起点回落 ${this.formatMetricValue(Math.abs(delta), unit)}。`);
    }

    if (Number.isFinite(Number(peakPoint?.timestamp))) {
      lines.push(`${this.formatTimestamp(peakPoint.timestamp)} 出现峰值。`);
    }

    return lines.slice(0, 3);
  }

  formatDiagnoseResponseV1(structure) {
    const lines = [String(structure?.title || '').trim()].filter(Boolean);
    if (structure?.intro) {
      lines.push(String(structure.intro).trim());
    }
    if (Array.isArray(structure?.summary) && structure.summary.length > 0) {
      lines.push('摘要：');
      structure.summary.forEach((item) => lines.push(`- ${item}`));
    }
    if (structure?.conclusion) {
      lines.push('初步判断：');
      lines.push(String(structure.conclusion).trim());
    }
    if (Array.isArray(structure?.evidence) && structure.evidence.length > 0) {
      lines.push('主要证据：');
      structure.evidence.forEach((item) => lines.push(`- ${item}`));
    }
    if (Array.isArray(structure?.affectedObjects) && structure.affectedObjects.length > 0) {
      lines.push('受影响对象 Top3：');
      structure.affectedObjects.forEach((item) => {
        const detail = [item?.metric, item?.value].filter(Boolean).join(' ');
        lines.push(`- ${item?.object || '-'}${detail ? ` ${detail}` : ''}`);
      });
    }
    if (Array.isArray(structure?.recommendation) && structure.recommendation.length > 0) {
      lines.push('建议：');
      structure.recommendation.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    if (Array.isArray(structure?.nextActions) && structure.nextActions.length > 0) {
      lines.push('可继续查看：');
      structure.nextActions.forEach((item) => lines.push(`- ${item}`));
    }
    return lines.join('\n');
  }

  formatStructuredResponse(structure) {
    if (!structure || typeof structure !== 'object') {
      return '';
    }

    if (structure.responseType === 'diagnose' && (structure.intro || Array.isArray(structure.affectedObjects))) {
      return this.formatDiagnoseResponseV1(structure);
    }

    if (structure.responseType === 'capability_intro') {
      const lines = [String(structure.renderTitle || structure.title || '').trim()];
      if (structure.message) {
        lines.push(structure.message);
      }
      if (Array.isArray(structure.capabilities) && structure.capabilities.length > 0) {
        lines.push('');
        lines.push('我目前可以先帮你：');
        structure.capabilities.forEach((item, index) => {
          lines.push(`${index + 1}. ${item}`);
        });
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('');
        lines.push('你可以接着这样问我：');
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.filter(Boolean).join('\n');
    }

    if (structure.responseType === 'clarification_brief') {
      const lines = [structure.title];
      if (structure.message) {
        lines.push(structure.message);
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('');
        lines.push('你可以直接补一句：');
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.filter(Boolean).join('\n');
    }

    if (structure.responseType === 'overview') {
      const lines = [structure.title];
      if (structure.timeScope) {
        lines.push(structure.timeScope);
        lines.push('');
      }
      (Array.isArray(structure.summary) ? structure.summary : []).forEach((item) => {
        lines.push(item);
      });
      if (Array.isArray(structure.topFindings) && structure.topFindings.length > 0) {
        lines.push('');
        lines.push(String(structure.findingLabel || '当前最异常对象：').trim());
        structure.topFindings.forEach((item) => {
          const detail = [item?.metric, item?.value].filter(Boolean).join(' ');
          lines.push(`${item.rank}. ${item.object}${detail ? `（${detail}）` : ''}`);
        });
      }
      if (structure.judgment) {
        lines.push('');
        lines.push(String(structure.judgmentLabel || '初步判断：').trim());
        lines.push(structure.judgment);
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('');
        lines.push(String(structure.nextActionsLabel || '可继续查看：').trim());
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.join('\n');
    }

    if (structure.responseType === 'topn') {
      const lines = [structure.title];
      lines.push(`Top ${Array.isArray(structure.items) ? structure.items.length : 0}：`);
      (Array.isArray(structure.items) ? structure.items : []).forEach((item) => {
        lines.push(`${item.rank}. ${item.object}   ${item.value}`);
      });
      if (structure.explanation) {
        lines.push(structure.explanation);
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('可继续查看：');
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.join('\n');
    }

    if (structure.responseType === 'trend') {
      const lines = [structure.title];
      lines.push(`当前值：${structure.current}`);
      lines.push(`峰值：${structure.peak}`);
      lines.push(`平均值：${structure.average}`);
      if (Array.isArray(structure.changes) && structure.changes.length > 0) {
        lines.push('变化特征：');
        structure.changes.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('可继续查看：');
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.join('\n');
    }

    if (structure.responseType === 'diagnose') {
      const lines = [structure.title];
      lines.push('摘要：');
      (Array.isArray(structure.summary) ? structure.summary : []).forEach((item) => {
        lines.push(`- ${item}`);
      });
      if (structure.conclusion) {
        lines.push('结论：');
        lines.push(structure.conclusion);
      }
      if (Array.isArray(structure.evidence) && structure.evidence.length > 0) {
        lines.push('证据链：');
        structure.evidence.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      if (Array.isArray(structure.recommendation) && structure.recommendation.length > 0) {
        lines.push('建议：');
        structure.recommendation.forEach((item, index) => {
          lines.push(`${index + 1}. ${item}`);
        });
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('可继续查看：');
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.join('\n');
    }

    if (structure.responseType === 'compare') {
      const lines = [structure.title];
      if (structure.intro) {
        lines.push(structure.intro);
      }
      if (Array.isArray(structure.current) && structure.current.length > 0) {
        lines.push('当前窗口：');
        structure.current.forEach((item) => {
          if (item?.label && item?.value) {
            lines.push(`- ${item.label}：${item.value}`);
          }
        });
      }
      if (Array.isArray(structure.baseline) && structure.baseline.length > 0) {
        lines.push('基线窗口：');
        structure.baseline.forEach((item) => {
          if (item?.label && item?.value) {
            lines.push(`- ${item.label}：${item.value}`);
          }
        });
      }
      if (Array.isArray(structure.delta) && structure.delta.length > 0) {
        lines.push('变化：');
      }
      (Array.isArray(structure.delta) ? structure.delta : []).forEach((item) => {
        if (item?.label && item?.value) {
          lines.push(`- ${item.label}：${item.value}`);
        }
      });
      if (structure.conclusion) {
        lines.push('结论：');
        lines.push(structure.conclusion);
      }
      if (Array.isArray(structure.nextActions) && structure.nextActions.length > 0) {
        lines.push('可继续查看：');
        structure.nextActions.forEach((item) => {
          lines.push(`- ${item}`);
        });
      }
      return lines.join('\n');
    }

    return [structure.title, ...(Array.isArray(structure.summary) ? structure.summary : [])]
      .filter(Boolean)
      .join('\n');
  }

  extractOverviewText(structure) {
    if (!structure || typeof structure !== 'object') {
      return '';
    }

    if (typeof structure.conclusion === 'string' && structure.conclusion.trim()) {
      return structure.conclusion.trim();
    }

    if (Array.isArray(structure.summary) && structure.summary.length > 0) {
      return String(structure.summary[0] || '').trim();
    }

    if (typeof structure.explanation === 'string' && structure.explanation.trim()) {
      return structure.explanation.trim();
    }

    if (typeof structure.message === 'string' && structure.message.trim()) {
      return structure.message.trim();
    }

    return '';
  }

  countStructureFacts(structure) {
    if (!structure || typeof structure !== 'object') {
      return 0;
    }

    if (Array.isArray(structure.topFindings)) {
      return structure.topFindings.length;
    }
    if (Array.isArray(structure.items)) {
      return structure.items.length;
    }
    if (Array.isArray(structure.summary)) {
      return structure.summary.length;
    }
    if (Array.isArray(structure.evidence)) {
      return structure.evidence.length;
    }
    if (Array.isArray(structure.delta)) {
      return structure.delta.length;
    }
    return 0;
  }

  countStructureSuggestions(structure) {
    if (!structure || typeof structure !== 'object') {
      return 0;
    }

    if (Array.isArray(structure.recommendation)) {
      return structure.recommendation.length;
    }
    if (Array.isArray(structure.nextActions)) {
      return structure.nextActions.length;
    }
    return 0;
  }

  buildBracketTitle(payload, fallbackLabel) {
    const raw = String(payload?.userQuery || '').trim();
    if (raw) {
      return `【${raw}】`;
    }
    return `【${fallbackLabel}】`;
  }

  buildTopnTitle(metricId, objectLabel, topCount, timeLabel, payload) {
    const metricLabel = this.describeMetric(metricId) || '指标';
    const objectText = objectLabel || this.resolveObjectLabel(payload);
    const count = Number.isFinite(Number(topCount)) && Number(topCount) > 0 ? Number(topCount) : 20;
    if (timeLabel && objectText) {
      return `【${timeLabel}${metricLabel} Top${count} ${objectText}】`;
    }
    if (objectText) {
      return `【${metricLabel} Top${count} ${objectText}】`;
    }
    return this.buildBracketTitle(payload, `Top${count} 排名`);
  }

  buildTopnExplanation(metricId, timeLabel, topCount, displayCount) {
    const metricLabel = this.describeMetric(metricId) || '指标';
    const count = Number.isFinite(Number(topCount)) && Number(topCount) > 0 ? Number(topCount) : 20;
    const shown = Number.isFinite(Number(displayCount)) && Number(displayCount) > 0
      ? Number(displayCount)
      : Math.min(5, count);
    if (timeLabel) {
      return `统计口径为${timeLabel}${metricLabel}排序，当前展示前 ${shown} 项。`;
    }
    return `统计口径为${metricLabel}排序，当前展示前 ${shown} 项。`;
  }

  buildTrendTitle(metricId, timeLabel, payload) {
    const metricLabel = this.describeMetric(metricId) || '指标';
    if (timeLabel) {
      return `【${metricLabel} ${timeLabel}趋势】`;
    }
    return this.buildBracketTitle(payload, `${metricLabel} 趋势`);
  }

  buildCompareTitle(payload) {
    const profile = this.resolveCompareProfile(payload);
    const objectLabel = this.resolveTargetName(payload) || profile?.title || null;
    const currentLabel = this.resolveTimeRangeLabel(payload) || '当前';
    const baselineLabel = this.resolveBaselineLabel(payload);
    if (objectLabel) {
      return `【${objectLabel} ${currentLabel} vs ${baselineLabel}对比】`;
    }
    return `【${currentLabel} vs ${baselineLabel}对比】`;
  }

  buildDiagnoseTitle(payload) {
    const targetName = this.resolveTargetName(payload);
    const category = this.normalizeCategoryLabel(
      payload?.diagnosticPlan?.category || payload?.resolvedQuery?.metricDomain || '诊断'
    );
    const suffix = category === 'Web' ? '页面慢分析' : `${category}诊断分析`;
    if (targetName) {
      return `【${targetName} ${suffix}】`;
    }
    return `【${suffix}】`;
  }

  buildTimeScopeText(payload, timeLabel = '') {
    const start = Number(payload?.resolvedQuery?.start || payload?.summary?.overview?.start || 0);
    const end = Number(payload?.resolvedQuery?.end || payload?.summary?.overview?.end || 0);
    const rangeText = this.resolveAbsoluteTimeRangeText(start, end);
    if (timeLabel && rangeText) {
      return `统计时间：${timeLabel}（${rangeText}）`;
    }
    if (rangeText) {
      return `统计时间：${rangeText}`;
    }
    if (timeLabel) {
      return `统计时间：${timeLabel}`;
    }
    return '';
  }

  buildOverviewJudgment(overview, topFindings = [], playbook = 'global_summary') {
    switch (playbook) {
      case 'network_summary':
        return '当前更像网络质量波动，建议继续追 RTT、丢包、重传更高的链路或对象。';
      case 'application_summary':
        return '当前更像应用或页面体验波动，建议继续看最慢应用、页面响应和错误变化。';
      case 'connection_summary':
        return '当前更像连接稳定性问题，建议继续追 reset、建连失败和会话异常对象。';
      default:
        break;
    }

    const summaryLines = this.buildOverviewSummaryLines(overview, playbook, topFindings);
    const texts = summaryLines
      .concat((Array.isArray(topFindings) ? topFindings : []).map((item) => {
        const parts = [item?.object, item?.metric, item?.value, item?.domain].filter(Boolean);
        return parts.join(' ');
      }))
      .map(item => String(item || '').trim())
      .filter(Boolean);

    const webScore = this.countKeywordHits(texts, ['web', '页面', 'portal', 'pgtme', 'page']);
    const networkScore = this.countKeywordHits(texts, ['网络', 'rtt', '丢包', '重传', 'vlan', 'pli', 'rtti']);
    const appScore = this.countKeywordHits(texts, ['应用', '服务器', 'trti', '事务', '响应']);
    const hasMildNetwork = texts.some(text => /网络.*轻微异常|轻微波动/.test(text));

    if (webScore >= networkScore && webScore >= appScore && webScore > 0) {
      if (hasMildNetwork || networkScore > 0) {
        return '当前异常以 Web 体验变差为主，网络层存在轻微波动，但主因更偏向服务器处理慢。';
      }
      return '当前异常以 Web 体验变差为主，建议优先查看慢页面、后端接口与服务器响应情况。';
    }

    if (networkScore > webScore && networkScore >= appScore) {
      return '当前异常以网络质量波动为主，建议优先查看 RTT、丢包、重传及关键网段链路情况。';
    }

    if (appScore > 0) {
      return '当前异常更偏向应用处理侧，建议优先查看服务器响应时间、接口耗时与后端服务状态。';
    }

    return '当前整体存在一定波动，建议结合最异常对象继续下钻定位。';
  }

  resolveTopCount(payload, rowCount = 0) {
    const topCount = Number(payload?.resolvedQuery?.topCount);
    if (Number.isFinite(topCount) && topCount > 0) {
      return topCount;
    }
    if (Number.isFinite(Number(rowCount)) && Number(rowCount) > 0) {
      return Number(rowCount);
    }
    return 20;
  }

  resolveTargetName(payload) {
    const rawRows = Array.isArray(payload?.rawRows) ? payload.rawRows : [];
    if (rawRows[0]?.group?.argument) {
      return String(rawRows[0].group.argument).trim();
    }

    const groups = Array.isArray(payload?.resolvedQuery?.groups) ? payload.resolvedQuery.groups : [];
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const item = groups[index];
      if (item?.argument) {
        return String(item.argument).trim();
      }
    }

    return null;
  }

  resolveObjectLabel(payload) {
    const groups = Array.isArray(payload?.resolvedQuery?.groups) ? payload.resolvedQuery.groups : [];
    const lastGroup = groups[groups.length - 1] || null;
    const type = String(lastGroup?.type || '').trim();
    const map = {
      TotalTraffic: '整体网络',
      WebApp: '网站',
      Application: '应用',
      Business: '业务',
      Host: '主机',
      Server: '主机',
      IP: 'IP',
      ClientIp: '客户端IP',
      ClientIP: '客户端IP',
      Subnet: '网段',
      Vlan: 'VLAN',
      Page: '页面'
    };
    return map[type] || type || '对象';
  }

  resolveTimeRangeLabel(payload) {
    const overviewLabel = String(payload?.summary?.overview?.timeLabel || '').trim();
    if (overviewLabel) {
      return overviewLabel;
    }

    const start = Number(payload?.resolvedQuery?.start);
    const end = Number(payload?.resolvedQuery?.end);
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
      return '';
    }

    const seconds = end - start;
    if (Math.abs(seconds - 1800) <= 120) {
      return '最近30分钟';
    }
    if (Math.abs(seconds - 3600) <= 120) {
      return '最近1小时';
    }
    if (Math.abs(seconds - 7200) <= 120) {
      return '最近2小时';
    }
    if (Math.abs(seconds - 86400) <= 300) {
      return '最近1天';
    }

    const now = Math.floor(Date.now() / 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartTs = Math.floor(todayStart.getTime() / 1000);
    if (Math.abs(start - todayStartTs) <= 120 && Math.abs(end - now) <= 600) {
      return '今日';
    }

    return `${this.formatTimestamp(start)}~${this.formatTimestamp(end)}`;
  }

  resolveAbsoluteTimeRangeText(start, end) {
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
      return '';
    }
    return `${this.formatTimestamp(start)}~${this.formatTimestamp(end)}`;
  }

  countKeywordHits(items, keywords) {
    const texts = Array.isArray(items) ? items : [];
    const patterns = Array.isArray(keywords) ? keywords : [];
    let count = 0;
    texts.forEach((text) => {
      const normalized = String(text || '').toLowerCase();
      patterns.forEach((keyword) => {
        if (normalized.includes(String(keyword).toLowerCase())) {
          count += 1;
        }
      });
    });
    return count;
  }

  resolveBaselineLabel(payload) {
    const baseline = this.resolveEffectiveCompareBaseline(payload);
    const mapping = {
      yesterday_same_window: '昨日同时间',
      last_week_same_window: '上周同时间',
      previous_window: '上一时间窗'
    };
    return mapping[baseline] || '基线';
  }

  resolveEffectiveCompareBaseline(payload) {
    return payload?.compareResult?.baselineKey
      || payload?.partialQuery?.compareBaselineKey
      || payload?.resolvedQuery?.compareBaselineKey
      || payload?.comparePlan?.baseline
      || payload?.executionAlignment?.baseline?.compareTo
      || null;
  }

  normalizeCompareItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((item, index) => {
        if (typeof item === 'string') {
          return {
            label: `指标${index + 1}`,
            value: item
          };
        }
        if (!item || typeof item !== 'object') {
          return null;
        }
        const label = String(item.label || item.metric || item.name || `指标${index + 1}`).trim();
        const value = String(item.value || item.valueText || item.deltaText || '').trim();
        if (!label || !value) {
          return null;
        }
        return { label, value };
      })
      .filter(Boolean);
  }

  normalizeCompareMetricItems(items, mode = 'current') {
    const hasStructuredMetricItems = (Array.isArray(items) ? items : []).some((item) => (
      item
      && typeof item === 'object'
      && (
        Number.isFinite(this.toFiniteNumber(item.value))
        || Number.isFinite(this.toFiniteNumber(item.deltaValue))
      )
    ));
    const normalized = hasStructuredMetricItems ? [] : this.normalizeCompareItems(items);
    if (normalized.length > 0) {
      return normalized;
    }

    return (Array.isArray(items) ? items : [])
      .map((item, index) => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const metricId = item.metric || item.key || item.name || null;
        const label = this.describeMetric(metricId) || String(metricId || `指标${index + 1}`).trim();
        if (!label) {
          return null;
        }

        if (mode === 'delta') {
          const deltaValue = this.toFiniteNumber(item.deltaValue);
          const deltaRatio = this.toFiniteNumber(item.deltaRatio);
          const unit = item.unit || null;
          if (!Number.isFinite(deltaValue)) {
            return null;
          }
          const sign = deltaValue > 0 ? '+' : (deltaValue < 0 ? '-' : '±');
          const numericText = this.formatMetricValue(Math.abs(deltaValue), unit);
          const ratioText = Number.isFinite(deltaRatio)
            ? `（${deltaRatio > 0 ? '+' : (deltaRatio < 0 ? '-' : '±')}${this.formatNumber(Math.abs(deltaRatio) * 100)}%）`
            : '';
          return {
            label,
            value: `${sign}${numericText}${ratioText}`
          };
        }

        const value = this.toFiniteNumber(item.value);
        return {
          label,
          value: this.formatMetricValue(value, item.unit || null)
        };
      })
      .filter(Boolean);
  }

  normalizeCategoryLabel(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
      return 'Diagnostic';
    }
    if (/(web|page|portal|webexperience)/.test(text)) {
      return 'Web';
    }
    if (/(tcp|rtt|retrans|stability)/.test(text)) {
      return 'TCP';
    }
    if (/(network|loss|latency|quality)/.test(text)) {
      return 'Network';
    }
    if (/(app|application|server)/.test(text)) {
      return 'Application';
    }
    return String(value).trim();
  }

  extractMetricValueMap(row) {
    const values = row?.values && typeof row.values === 'object' ? row.values : {};
    const pick = (metricId) => {
      const numeric = this.toFiniteNumber(values[metricId]);
      return Number.isFinite(numeric) ? numeric : null;
    };
    return {
      PGTME: pick('PGTME'),
      RTTI: pick('RTTI'),
      TRTI: pick('TRTI'),
      PGHTTP500PCT: pick('PGHTTP500PCT')
    };
  }

  describeMetric(metricId) {
    const key = String(metricId || '').trim().toUpperCase();
    const labels = {
      RTTI: 'TCP RTT',
      PLI: '丢包',
      PLO: '丢包',
      RTXI: 'TCP 重传',
      RDTO: '重传时延',
      TPIO: '吞吐',
      TPI: '吞吐',
      TPO: '吞吐',
      TRTI: '服务器响应时间',
      T2FBI: '首包时间',
      PGTME: '页面延时',
      PGSLPCT: '慢页面占比',
      PGHTTP500PCT: 'HTTP 5xx',
      CSTI: '连接失败',
      CONI: '连接请求数',
      RFRI: '连接失败率',
      RFCI: 'Reset',
      RSTI: 'RST',
      CSTFAILPCT: '连接失败率',
      TCPRETRANS: 'TCP 重传'
    };
    return labels[key] || (metricId ? String(metricId).trim() : '');
  }

  formatTimestamp(timestamp) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return String(timestamp || '');
    }
    const date = new Date(numeric * 1000);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    if (sameDay) {
      return `${hours}:${minutes}`;
    }
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  }

  normalizeConfidence(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Number(numeric.toFixed(2));
  }

  resolveMetricUnit(row, metricId) {
    if (!row || !metricId) {
      return row?.unit || null;
    }
    return row?.units?.[metricId] || row?.unit || null;
  }

  formatMetricValue(value, unit = null) {
    if (value === null || value === undefined || value === '') {
      return '无数据';
    }
    const formatted = this.formatNumber(value);
    return unit ? `${formatted} ${unit}` : formatted;
  }

  buildDeterministicOverview(input) {
    const service = input?.service;
    const groupPath = input?.groupPath;
    const metrics = Array.isArray(input?.metrics) ? input.metrics.filter(Boolean) : [];

    if (service === 'topValues') {
      return `${groupPath || '当前对象'} 的 TopN 结果已基于真实数据整理完成${metrics.length > 0 ? `，指标为 ${metrics.join('、')}` : ''}。`;
    }
    if (service === 'timeValues') {
      return `${groupPath || '当前对象'} 的趋势结果已基于真实数据整理完成${metrics.length > 0 ? `，指标为 ${metrics.join('、')}` : ''}。`;
    }
    if (service === 'averageValues') {
      return `${groupPath || '当前对象'} 的平均值结果已基于真实数据整理完成${metrics.length > 0 ? `，指标为 ${metrics.join('、')}` : ''}。`;
    }
    return '已根据真实返回数据整理出本次结果。';
  }

  normalizeIndexOrder(value, length) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const picked = [];

    source.forEach((item) => {
      const index = Number(item);
      if (Number.isInteger(index) && index >= 0 && index < length && !seen.has(index)) {
        seen.add(index);
        picked.push(index);
      }
    });

    for (let index = 0; index < length; index += 1) {
      if (!seen.has(index)) {
        picked.push(index);
      }
    }

    return picked;
  }

  parseJson(raw) {
    const text = String(raw || '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : text;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(candidate.slice(start, end + 1));
      }
      throw error;
    }
  }

  formatGroupPath(groups) {
    return (Array.isArray(groups) ? groups : [])
      .map(item => (item?.argument ? `${item.type}(${item.argument})` : item?.type))
      .filter(Boolean)
      .join(' > ');
  }

  formatMetricPairs(row, fallbackMetrics = []) {
    const values = row?.values && typeof row.values === 'object' ? row.values : {};
    const metrics = Array.isArray(row?.metrics) && row.metrics.length > 0
      ? row.metrics
      : fallbackMetrics;

    if (metrics.length === 0 && row?.metric) {
      const value = row?.value;
      return value === null || value === undefined
        ? `${row.metric}=null`
        : `${row.metric}=${this.formatNumber(value)}`;
    }

    return metrics
      .map((metricId) => {
        const value = Object.prototype.hasOwnProperty.call(values, metricId)
          ? values[metricId]
          : (metricId === row?.metric ? row?.value : null);
        return `${metricId}=${value === null || value === undefined ? 'null' : this.formatNumber(value)}`;
      })
      .join('，');
  }

  extractPrimaryValue(row, metricId) {
    if (!row || !metricId) {
      return null;
    }
    const values = row?.values && typeof row.values === 'object' ? row.values : {};
    if (Object.prototype.hasOwnProperty.call(values, metricId)) {
      return this.toFiniteNumber(values[metricId]);
    }
    if (row.metric === metricId) {
      return this.toFiniteNumber(row.value);
    }
    return null;
  }

  formatNumber(value) {
    const numeric = this.toFiniteNumber(value);
    if (!Number.isFinite(numeric)) {
      return String(value);
    }
    return Number(numeric.toFixed(4)).toString();
  }

  toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  resolveTopnProfile(payload) {
    const stableTemplateId = String(payload?.resolvedQuery?.stableTemplate?.id || payload?.partialQuery?.stableTemplateId || '').trim();
    const rankingTitleKey = String(payload?.resolvedQuery?.executionBinding?.rankingTitleKey || payload?.partialQuery?.rankingTitleKey || '').trim();
    const key = rankingTitleKey || stableTemplateId;
    const map = {
      'ip_traffic': {
        templateKey: 'topn_ip_traffic',
        title: '地址流量排行',
        objectLabel: '地址'
      },
      'ip-traffic-topn-v1': {
        templateKey: 'topn_ip_traffic',
        title: '地址流量排行',
        objectLabel: '地址'
      },
      'definedapp_traffic': {
        templateKey: 'topn_definedapp_traffic',
        title: '应用流量排行',
        objectLabel: '应用'
      },
      'definedapp-traffic-topn-v1': {
        templateKey: 'topn_definedapp_traffic',
        title: '应用流量排行',
        objectLabel: '应用'
      },
      'webapp_access': {
        templateKey: 'topn_webapp_access',
        title: '网站访问排行',
        objectLabel: '网站'
      },
      'webapp-access-topn-v1': {
        templateKey: 'topn_webapp_access',
        title: '网站访问排行',
        objectLabel: '网站'
      },
      'prefix24_traffic': {
        templateKey: 'topn_prefix24_traffic',
        title: '网段流量排行',
        objectLabel: '网段'
      },
      'prefix24-traffic-topn-v1': {
        templateKey: 'topn_prefix24_traffic',
        title: '网段流量排行',
        objectLabel: '网段'
      }
    };
    return map[key] || null;
  }

  resolveCompareProfile(payload) {
    const compareTitleKey = String(
      payload?.partialQuery?.compareTitleKey
      || payload?.comparePlan?.titleKey
      || payload?.compareResult?.titleKey
      || ''
    ).trim();
    const metricDomain = String(
      payload?.comparePlan?.metricDomain
      || payload?.partialQuery?.metricDomainHint
      || payload?.resolvedQuery?.metricDomain
      || ''
    ).trim();

    const directMap = {
      global: {
        templateKey: 'compare_global',
        title: '整体体验'
      },
      network: {
        templateKey: 'compare_network',
        title: '网络质量'
      },
      application: {
        templateKey: 'compare_application',
        title: '应用性能'
      },
      connection: {
        templateKey: 'compare_connection',
        title: '连接稳定性'
      }
    };

    const domainMap = {
      Composite: 'global',
      NetworkQuality: 'network',
      ApplicationPerformance: 'application',
      TcpStability: 'connection'
    };

    const key = compareTitleKey || domainMap[metricDomain] || null;
    const profile = key ? directMap[key] || null : null;
    if (!profile) {
      return null;
    }

    const template = this.responseTemplates?.[profile.templateKey] || {};
    return {
      ...profile,
      intro: template?.intro || '',
      defaultNextActions: Array.isArray(template?.defaultNextActions) ? template.defaultNextActions : []
    };
  }

  buildCompareNextActions(profile, payload) {
    const baseline = this.resolveEffectiveCompareBaseline(payload);
    const planActions = this.filterCompareActionsForBaseline(
      Array.isArray(payload?.comparePlan?.nextActions) ? payload.comparePlan.nextActions : [],
      baseline
    );
    const templateActions = this.filterCompareActionsForBaseline(
      Array.isArray(profile?.defaultNextActions) ? profile.defaultNextActions : [],
      baseline
    );
    return Array.from(new Set(planActions.concat(templateActions))).slice(0, 4);
  }

  filterCompareActionsForBaseline(actions, baselineKey) {
    const items = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (!baselineKey) {
      return items;
    }

    return items.filter((item) => {
      const text = String(item);
      if (baselineKey !== 'yesterday_same_window' && /(昨|昨天)/.test(text)) {
        return false;
      }
      if (baselineKey === 'last_week_same_window' && /(上周)/.test(text)) {
        return false;
      }
      if (baselineKey === 'previous_window' && /(上一窗口|上一时间窗)/.test(text)) {
        return false;
      }
      return true;
    });
  }

  resolveTopnTemplate(payload) {
    const profile = this.resolveTopnProfile(payload);
    if (!profile?.templateKey) {
      return this.responseTemplates.topn || null;
    }
    return this.responseTemplates[profile.templateKey] || this.responseTemplates.topn || null;
  }

  buildTopnStructure(payload, input) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const metricId = payload?.resolvedQuery?.metric
      || (Array.isArray(payload?.resolvedQuery?.metrics) ? payload.resolvedQuery.metrics[0] : null)
      || (Array.isArray(input?.metrics) ? input.metrics[0] : null)
      || null;
    const topCount = this.resolveTopCount(payload, rows.length);
    const timeLabel = this.resolveTimeRangeLabel(payload);
    const profile = this.resolveTopnProfile(payload);
    const template = this.resolveTopnTemplate(payload) || {};
    const displayCount = Math.min(
      Number.isFinite(Number(topCount)) && Number(topCount) > 0 ? Number(topCount) : 5,
      Math.max(rows.length, 5)
    );

    if (rows.length === 0) {
      return {
        responseType: 'topn',
        title: this.buildTopnTitle(metricId, profile?.objectLabel || this.resolveObjectLabel(payload), topCount, timeLabel, payload),
        items: [],
        explanation: String(template.emptyMessage || '当前时间窗内没有查到对应排行结果。你可以换一个对象类型或时间范围继续看。').trim(),
        nextActions: Array.isArray(template.defaultNextActions) ? template.defaultNextActions.slice(0, 3) : []
      };
    }

    return {
      responseType: 'topn',
      title: this.buildTopnTitle(metricId, profile?.objectLabel || this.resolveObjectLabel(payload), topCount, timeLabel, payload),
      items: rows.slice(0, Math.min(5, topCount || 5)).map((row, index) => ({
        rank: index + 1,
        object: row?.object || `${profile?.objectLabel || '对象'}${index + 1}`,
        value: this.formatMetricValue(
          this.extractPrimaryValue(row, metricId) ?? row?.value ?? null,
          this.resolveMetricUnit(row, metricId)
        ),
        metric: metricId
      })),
      explanation: this.buildTopnExplanation(metricId, timeLabel, topCount, Math.min(displayCount, rows.length), payload),
      nextActions: Array.from(new Set([
        ...(Array.isArray(template.defaultNextActions) ? template.defaultNextActions : []),
        ...((Array.isArray(input?.suggestionItems) ? input.suggestionItems : []).slice(0, 3))
      ])).slice(0, 3)
    };
  }

  buildTopnTitle(metricId, objectLabel, topCount, timeLabel, payload) {
    const profile = this.resolveTopnProfile(payload);
    const template = this.resolveTopnTemplate(payload) || {};
    const titleText = String(template.title || profile?.title || '').trim();
    if (titleText && timeLabel) {
      return `【${timeLabel}${titleText}】`;
    }
    if (titleText) {
      return `【${titleText}】`;
    }

    const metricLabel = this.describeMetric(metricId) || '指标';
    const objectText = objectLabel || this.resolveObjectLabel(payload);
    const count = Number.isFinite(Number(topCount)) && Number(topCount) > 0 ? Number(topCount) : 20;
    if (timeLabel && objectText) {
      return `【${timeLabel}${metricLabel} Top${count} ${objectText}】`;
    }
    if (objectText) {
      return `【${metricLabel} Top${count} ${objectText}】`;
    }
    return this.buildBracketTitle(payload, `Top${count} 排名`);
  }

  buildTopnExplanation(metricId, timeLabel, topCount, displayCount, payload) {
    const template = this.resolveTopnTemplate(payload) || {};
    const intro = String(template.intro || '').trim();
    if (intro) {
      return intro;
    }

    const metricLabel = this.describeMetric(metricId) || '指标';
    const shown = Number.isFinite(Number(displayCount)) && Number(displayCount) > 0
      ? Number(displayCount)
      : Math.min(5, Number.isFinite(Number(topCount)) ? Number(topCount) : 5);
    if (timeLabel) {
      return `统计口径为${timeLabel}${metricLabel}排序，当前展示前 ${shown} 项。`;
    }
    return `统计口径为${metricLabel}排序，当前展示前 ${shown} 项。`;
  }

  resolveObjectLabel(payload) {
    const groups = Array.isArray(payload?.resolvedQuery?.groups) ? payload.resolvedQuery.groups : [];
    const lastGroup = groups[groups.length - 1] || null;
    const type = String(lastGroup?.type || '').trim();
    const map = {
      TotalTraffic: '整体网络',
      WebApp: '网站',
      WebApplication: '网站',
      Application: '应用',
      DefinedApp: '应用',
      Business: '业务',
      Host: '主机',
      Server: '主机',
      IP: 'IP',
      IPAddress: '地址',
      ClientIp: '客户端IP',
      ClientIPs: '客户端IP',
      Prefix24: '网段',
      IPConversation: '会话'
    };
    return map[type] || type || '对象';
  }
}

module.exports = new ResultNarrationService();
