#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const AlertApiService = require('../services/AlertApiService');
const { validateAlertQuery } = require('../services/AlertQueryValidator');
const {
  normalizeSummary,
  normalizeDetail,
  normalizeTimeline,
  normalizeMetricSeries,
  filterEvents,
  sortAlertEvents,
} = require('../services/AlertNormalizerService');
const { analyzeEvents, analyzeTimeline } = require('../services/AlertAnalyzerService');
const {
  buildTimeRange,
  buildPacketHandoff,
  buildNarrationInput,
  buildReportData,
  extractIndirectDiscoveryEvents,
} = require('../services/AlertNarrationContractService');
const {
  explainNotification,
  explainEventFields,
} = require('../services/AlertNotificationExplainerService');
const { discoverForEvents } = require('../services/AlertIndirectPacketDiscoveryService');
const { resolveExecutionTime } = require('../../openclaw-napm-query/src/shared/timeResolver');
const TimeRangeService = require('../../openclaw-napm-query/services/ResolvedQueryTimeRangeService');

if (require.main === module) {
  main().catch((error) => {
    writeJson({
      ok: false,
      mode: null,
      error: {
        code: error.code || 'ALERT_RUNTIME_ERROR',
        message: error.message || String(error),
      },
    });
    process.exitCode = 1;
  });
}

async function main() {
  loadDotEnvCandidates([
    path.join(workspaceRoot, '.env'),
    path.join(process.cwd(), '.env'),
    process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.env') : null,
    process.env.HOME ? path.join(process.env.HOME, '.openclaw', '.env') : null,
  ]);
  const args = parseArgs(process.argv.slice(2));
  const payload = loadPayload(args);
  const result = await executeAlertQuery(payload);
  writeJson(result);
}

async function executeAlertQuery(payload = {}, options = {}) {
  const prompt = payload.prompt || payload.userQuery || (payload.alertQuery && payload.alertQuery.prompt) || '';
  const promptTimeRange = resolveRelativeTimeRangeFromPrompt(prompt, options.nowMs);
  if (TimeRangeService.hasExplicitTimeRangeExpression(prompt) && !promptTimeRange) {
    return buildFailureResult(
      payload?.alertQuery?.mode || payload?.mode || null,
      {
        code: 'ALERT_RELATIVE_TIME_RANGE_UNRESOLVED',
        message: '用户问题包含明确的相对时间，但无法生成受支持的执行时间范围；已停止告警查询。'
      },
      null
    );
  }
  const criteria = getMutableCriteria(payload);
  const originalStart = criteria?.start || null;
  const originalEnd = criteria?.end || null;
  if (criteria) {
    const range = resolveExecutionTime({
      timeRangeKey: promptTimeRange?.key || criteria.timeRange?.key,
      start: criteria.start,
      end: criteria.end,
      nowSeconds: options.nowMs ? Math.floor(options.nowMs / 1000) : undefined,
      defaultKey: 'last1hour'
    });
    if (!range.ok) {
      return buildFailureResult(null, { code: range.reason, message: range.message }, null);
    }
    criteria.start = range.start;
    criteria.end = range.end;
    criteria.timeRange = {
      ...(criteria.timeRange && typeof criteria.timeRange === 'object' ? criteria.timeRange : {}),
      key: range.key,
      displayText: promptTimeRange?.displayText || criteria.timeRange?.displayText || range.displayText
    };
  }

  const validation = validateAlertQuery(payload.alertQuery || payload);
  if (!validation.ok) {
    return buildFailureResult(validation.query?.mode || null, validation.error, validation.query);
  }

  const { query } = validation;
  const timeRangeAdjustment = applyPromptRelativeTimeRange(query, prompt, {
    ...options,
    originalStart,
    originalEnd,
  });
  const categoryAdjustment = applyPromptCategoryFilter(query, prompt);

  if (query.mode === 'explain_notification') {
    return buildExplainResult(query, explainNotification(), prompt);
  }
  if (query.mode === 'explain_event_fields') {
    return buildExplainResult(query, explainEventFields(), prompt);
  }

  const api = options.api || new AlertApiService(options.apiOptions || {});
  const result = {
    ok: true,
    mode: query.mode,
    service: serviceForMode(query.mode),
    criteria: query.criteria,
    timeRange: buildTimeRange(query.criteria),
    summary: null,
    events: [],
    details: [],
    timeline: [],
    metricSeries: [],
    packetHandoff: null,
    warnings: [],
    error: null,
  };
  if (timeRangeAdjustment) {
    result.warnings.push(timeRangeAdjustment);
  }
  if (categoryAdjustment) {
    result.warnings.push(categoryAdjustment);
  }

  if (query.mode === 'summary' || query.mode === 'analysis') {
    const rawSummary = await api.getSummary(query.criteria);
    const events = sortAlertEvents(filterEvents(normalizeSummary(rawSummary, query.options), query.criteria));
    result.events = events.slice(0, query.options.maxEvents);
    result.summary = analyzeEvents(events, query.options);
    if (query.options.includeRaw) result.rawSummary = rawSummary;
  }

  if (query.mode === 'timeline' || (query.mode === 'analysis' && query.options.includeTimeline)) {
    const rawTimeline = await api.getTimeline(query.criteria);
    result.timeline = normalizeTimeline(rawTimeline);
    result.timelineSummary = analyzeTimeline(result.timeline);
    result.warnings.push({
      code: 'ALERT_TIMELINE_ORDER_UNCONFIRMED',
      message: 'alertsSummaryTimeLine 严重级别数组顺序按当前前端读取逻辑解释，建议以后端定义再确认。',
    });
    if (query.options.includeRaw) result.rawTimeline = rawTimeline;
  }

  if (query.mode === 'detail' || query.mode === 'detail_with_timeseries' || (query.mode === 'analysis' && query.options.includeDetail)) {
    const eventIds = query.criteria.eventIds.length > 0
      ? query.criteria.eventIds
      : result.events.map((event) => event.id).filter(Boolean);
    if (eventIds.length > 0) {
      const rawDetail = await api.getDetail({
        ...query.criteria,
        eventIds,
      });
      result.details = sortAlertEvents(filterEvents(normalizeDetail(rawDetail, query.options), query.criteria));
      if (query.options.includeRaw) result.rawDetail = rawDetail;
    }
  }

  const shouldFetchSeries = query.mode === 'detail_with_timeseries'
    || (query.mode === 'analysis' && query.options.includeMetricSeries);
  if (shouldFetchSeries) {
    result.details = await enrichDetailsFromSummaryIfNeeded(api, result.details, query, result);
    result.metricSeries = await fetchMetricSeries(api, result.details, query);
  }

  const packetSourceEvents = result.details.length > 0 ? result.details : result.events;
  if (query.options.packetHandoff) {
    result.packetHandoff = buildPacketHandoff(packetSourceEvents, query.criteria);
  }

  // 间接数据包发现：业务/应用/工作组告警 → 查询嫌疑 IP 会话
  if (query.options.packetHandoff && query.options.discoveryEnabled) {
    const indirectEvents = extractIndirectDiscoveryEvents(result.packetHandoff);
    if (indirectEvents.length > 0) {
      try {
        const discoveryResult = await discoverForEvents(api, indirectEvents, query.options);
        result.packetHandoff = mergeIndirectDiscoveryResult(result.packetHandoff, discoveryResult);
        if (discoveryResult && discoveryResult.available) {
          result.warnings.push({
            code: 'ALERT_INDIRECT_DISCOVERY_PERFORMED',
            message: `已对 ${indirectEvents.length} 个业务/应用/工作组告警执行间接数据包发现。`,
          });
        }
      } catch (discoveryError) {
        result.warnings.push({
          code: 'ALERT_INDIRECT_DISCOVERY_FAILED',
          message: `间接数据包发现执行失败：${discoveryError.message || String(discoveryError)}`,
        });
      }
    }
  }

  if (!result.summary && result.events.length === 0 && result.details.length > 0) {
    result.summary = analyzeEvents(result.details, query.options);
  }
  if (!result.summary && result.timeline.length > 0) {
    result.summary = {
      total: null,
      timeline: result.timelineSummary,
    };
  }

  attachRequestUrls(result, api);
  result.narrationInput = buildNarrationInput(result);
  result.reportData = buildReportData(result, prompt);
  return result;
}

function applyPromptRelativeTimeRange(query = {}, prompt = '', options = {}) {
  if (!query || !query.criteria) {
    return null;
  }

  const resolved = resolveRelativeTimeRangeFromPrompt(prompt, options.nowMs);
  if (!resolved) {
    return null;
  }

  const originalStart = options.originalStart ?? query.criteria.start ?? null;
  const originalEnd = options.originalEnd ?? query.criteria.end ?? null;
  query.criteria.start = resolved.start;
  query.criteria.end = resolved.end;
  query.criteria.timeRange = {
    ...(query.criteria.timeRange || {}),
    key: resolved.key,
    displayText: resolved.displayText,
  };

  if (originalStart === resolved.start && originalEnd === resolved.end) {
    return null;
  }

  return {
    code: 'ALERT_RELATIVE_TIME_RANGE_REBUILT',
    message: `已按用户相对时间表达重新计算告警查询窗口：${resolved.displayText}。`,
    originalStart,
    originalEnd,
    start: resolved.start,
    end: resolved.end,
  };
}

function getMutableCriteria(payload = {}) {
  if (payload.alertQuery && typeof payload.alertQuery.criteria === 'object' && !Array.isArray(payload.alertQuery.criteria)) {
    return payload.alertQuery.criteria;
  }
  if (payload.criteria && typeof payload.criteria === 'object' && !Array.isArray(payload.criteria)) {
    return payload.criteria;
  }
  if (payload.alertQuery && typeof payload.alertQuery === 'object' && !Array.isArray(payload.alertQuery)) {
    return payload.alertQuery;
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

function applyPromptCategoryFilter(query = {}, prompt = '') {
  if (!query || !query.criteria) {
    return null;
  }

  const hasAuthoritativeEventIds = Array.isArray(query.criteria.eventIds)
    && query.criteria.eventIds.length > 0;
  if (hasAuthoritativeEventIds && ['detail', 'detail_with_timeseries'].includes(query.mode)) {
    return null;
  }

  const categories = resolveCategoryFilterFromPrompt(prompt);
  if (categories.length === 0) {
    return null;
  }

  const originalCategories = Array.isArray(query.criteria.categories)
    ? query.criteria.categories.slice()
    : [];
  const same = originalCategories.length === categories.length
    && originalCategories.every((item, index) => item === categories[index]);
  query.criteria.categories = categories;
  if (same) {
    return null;
  }

  return {
    code: 'ALERT_PROMPT_CATEGORY_FILTER_REBUILT',
    message: `已按用户告警分类表达重建筛选条件：${categories.join(', ')}。`,
    originalCategories,
    categories,
  };
}

function resolveCategoryFilterFromPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return [];
  }

  const rules = [
    {
      pattern: /(?:业务故障告警|业务故障|业务告警)/,
      categories: ['busAlerts'],
    },
    {
      pattern: /(?:应用性能告警|应用告警)/,
      categories: ['appAlerts'],
    },
    {
      pattern: /(?:网络异常告警|网络异常)/,
      categories: ['networkIssueAlerts'],
    },
    {
      pattern: /(?:网络性能告警|网络性能)/,
      categories: ['networkAlerts'],
    },
    {
      pattern: /(?:用户体验告警|用户体验)/,
      categories: ['userAlerts'],
    },
    {
      pattern: /(?:安全事件告警|安全告警|安全事件)/,
      categories: ['securityAlerts'],
    },
    {
      pattern: /(?:智能分析告警|智能告警|AI告警|AI\s*告警)/i,
      categories: ['AIAlerts'],
    },
  ];

  const matched = [];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      matched.push(...rule.categories);
    }
  }

  return [...new Set(matched)];
}

function resolveRelativeTimeRangeFromPrompt(prompt = '', nowMs = Date.now()) {
  return TimeRangeService.resolvePromptTimeRange(prompt, {
    nowSeconds: Math.floor(Number(nowMs || Date.now()) / 1000)
  });
}

/**
 * 将间接发现结果合并回 packetHandoff 结构中。
 *
 * 逻辑：
 *   - 单个 PENDING 候选 → 替换为 discovery 结果
 *   - MULTIPLE 候选 → 替换 PENDING 标记，保留直接候选
 *   - 无 PENDING 候选 → 原样返回
 */
function mergeIndirectDiscoveryResult(packetHandoff, discoveryResult) {
  if (!packetHandoff) {
    if (!discoveryResult) return null;
    return discoveryResult;
  }

  // 单个 PENDING 候选 → 直接替换
  if (packetHandoff.needsDiscovery) {
    return discoveryResult || null;
  }

  // MULTIPLE_ALERT_PACKET_CANDIDATES → 逐个处理
  if (packetHandoff.reason === 'MULTIPLE_ALERT_PACKET_CANDIDATES'
      && Array.isArray(packetHandoff.candidates)) {
    const resolved = packetHandoff.candidates.map((candidate) => {
      if (candidate && candidate.needsDiscovery && candidate.discoveryEvent) {
        // 从 discovery 结果中找匹配的
        const match = findDiscoveryMatch(candidate.discoveryEvent, discoveryResult);
        return match || candidate; // 没找到匹配则保留原标记
      }
      return candidate;
    }).filter(Boolean);

    if (resolved.length === 0) return null;
    if (resolved.length === 1) return resolved[0];
    return {
      available: true,
      reason: 'MULTIPLE_ALERT_PACKET_CANDIDATES',
      candidates: resolved,
    };
  }

  return packetHandoff;
}

/**
 * 在聚合的 discovery 结果中查找匹配指定 eventId 的结果。
 */
function findDiscoveryMatch(event, discoveryResult) {
  if (!discoveryResult || !event) return null;

  // 单个结果 → 直接匹配 eventId
  if (discoveryResult.eventId && String(discoveryResult.eventId) === String(event.id)) {
    return discoveryResult;
  }

  // 聚合多事件结果 → 在 groups 中查找
  if (discoveryResult.reason === 'ALERT_INDIRECT_PACKET_VIA_DISCOVERY_MULTI'
      && Array.isArray(discoveryResult.groups)) {
    for (const group of discoveryResult.groups) {
      if (String(group.eventId) === String(event.id)) {
        return group;
      }
    }
  }

  return null;
}

function attachRequestUrls(result = {}, api = {}) {
  if (!api || typeof api.getRequestHistory !== 'function') {
    return;
  }

  const requestUrls = api.getRequestHistory()
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (requestUrls.length === 0) {
    return;
  }

  result.requestUrl = requestUrls[0];
  result.requestUrls = requestUrls;
}

async function enrichDetailsFromSummaryIfNeeded(api, details = [], query = {}, result = {}) {
  const needsSummary = details.some((detail) => !Array.isArray(detail.metrics) || detail.metrics.length === 0);
  if (!needsSummary) {
    return details;
  }

  try {
    const summaryEvents = result.events.length > 0
      ? result.events
      : filterEvents(
        sortAlertEvents(normalizeSummary(await api.getSummary(query.criteria), query.options)),
        {
          ...query.criteria,
          metrics: []
        }
      );
    const byId = new Map(summaryEvents.map((event) => [String(event.id), event]));
    return details.map((detail) => {
      const summary = byId.get(String(detail.id));
      if (!summary) return detail;
      return {
        ...summary,
        ...detail,
        metrics: detail.metrics && detail.metrics.length > 0 ? detail.metrics : summary.metrics,
        value: detail.value && detail.value.length > 0 ? detail.value : summary.value,
        baseline: detail.baseline && detail.baseline.length > 0 ? detail.baseline : summary.baseline,
        unit: detail.unit && detail.unit.length > 0 ? detail.unit : summary.unit,
        condition: detail.condition || summary.condition,
        name: detail.name || summary.name,
        category: detail.category || summary.category,
        categoryLabel: detail.categoryLabel || summary.categoryLabel,
      };
    });
  } catch (error) {
    result.warnings.push({
      code: 'ALERT_DETAIL_SUMMARY_ENRICH_FAILED',
      message: error.message || String(error),
    });
    return details;
  }
}

async function fetchMetricSeries(api, details = [], query = {}) {
  const output = [];
  for (const detail of details) {
    if (!detail.groupType || !detail.group) continue;
    const metrics = query.criteria.metrics.length > 0 ? query.criteria.metrics : detail.metrics;
    for (let index = 0; index < metrics.length; index += 1) {
      const metric = metrics[index];
      try {
        const raw = await api.getMetricSeries({
          metric,
          groupType: detail.groupType,
          group: detail.group,
          start: query.criteria.start,
          end: query.criteria.end,
          granularity: query.criteria.granularity,
        });
        output.push(normalizeMetricSeries(raw, {
          eventId: detail.id,
          metric,
          group: detail.group,
          categoryType: detail.categoryType,
          groupType: detail.groupType,
          granularity: query.criteria.granularity,
          unit: detail.unit?.[index] || detail.unit?.[0] || null,
        }));
      } catch (error) {
        output.push({
          eventId: detail.id,
          metric,
          group: detail.group,
          ok: false,
          error: {
            code: 'ALERT_METRIC_SERIES_FAILED',
            message: error.message || String(error),
          },
        });
      }
    }
  }
  return output;
}

function buildExplainResult(query, explanation, prompt = '') {
  const result = {
    ok: true,
    mode: query.mode,
    service: query.mode,
    timeRange: null,
    explanation,
    summary: {
      title: explanation.title,
    },
    events: [],
    details: [],
    timeline: [],
    metricSeries: [],
    packetHandoff: null,
    warnings: [],
    error: null,
  };
  result.narrationInput = buildNarrationInput(result);
  result.reportData = buildReportData(result, prompt);
  return result;
}

function buildFailureResult(mode, error, query = null) {
  const result = {
    ok: false,
    mode,
    service: serviceForMode(mode),
    timeRange: query ? buildTimeRange(query.criteria || {}) : null,
    summary: null,
    events: [],
    details: [],
    timeline: [],
    metricSeries: [],
    packetHandoff: null,
    warnings: [],
    error,
  };
  result.narrationInput = buildNarrationInput(result);
  return result;
}

function serviceForMode(mode) {
  if (mode === 'timeline') return 'alertsSummaryTimeLine';
  if (mode === 'detail' || mode === 'detail_with_timeseries') return 'alertsDetail';
  if (mode === 'explain_notification' || mode === 'explain_event_fields') return mode;
  return 'alertsSummary';
}

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--queryFile') args.queryFile = argv[++index];
    else if (arg === '--queryJson') args.queryJson = argv[++index];
    else if (arg === '--payload') args.payload = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage:',
        '  node scripts/run_alert_query.js --queryFile ./alert-query.json',
        '  node scripts/run_alert_query.js --queryJson "{...}"',
      ].join('\n') + '\n');
      process.exit(0);
    }
  }
  return args;
}

function loadPayload(args = {}) {
  if (args.queryFile) {
    return JSON.parse(stripBom(fs.readFileSync(args.queryFile, 'utf8')));
  }
  if (args.queryJson) {
    return JSON.parse(stripBom(args.queryJson));
  }
  if (args.payload) {
    return JSON.parse(stripBom(args.payload));
  }
  return {};
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function loadDotEnvCandidates(filePaths = []) {
  for (const filePath of filePaths.filter(Boolean)) {
    loadDotEnv(filePath);
  }
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Plugin 通过 require() 同进程调用的入口。
 * params 已经是 JavaScript 对象，无需 JSON 解析。
 */
async function handleSkillCall(params = {}) {
  try {
    loadDotEnvCandidates([
      path.join(workspaceRoot, '.env'),
      path.join(process.cwd(), '.env'),
      process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.env') : null,
      process.env.HOME ? path.join(process.env.HOME, '.openclaw', '.env') : null,
    ]);

    return await executeAlertQuery(params);
  } catch (error) {
    return {
      ok: false,
      mode: null,
      error: {
        code: error.code || 'ALERT_SKILL_ERROR',
        message: error.message || String(error),
      },
    };
  }
}

module.exports = {
  executeAlertQuery,
  handleSkillCall,
  parseArgs,
  loadPayload,
  loadDotEnvCandidates,
  serviceForMode,
  enrichDetailsFromSummaryIfNeeded,
  fetchMetricSeries,
  mergeIndirectDiscoveryResult,
  findDiscoveryMatch,
  __test__: {
    getMutableCriteria,
    resolveRelativeTimeRangeFromPrompt,
  },
};
