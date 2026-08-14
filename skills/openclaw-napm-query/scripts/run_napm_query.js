#!/usr/bin/env node

const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

function loadDotenv() {
  const candidates = [
    path.join(workspaceRoot, 'node_modules', 'dotenv'),
    'dotenv'
  ];

  for (const candidate of candidates) {
    try {
      require(candidate).config({
        path: path.join(workspaceRoot, '.env')
      });
      return;
    } catch (_error) {
      // try next candidate
    }
  }
}

loadDotenv();

const RequirementParserService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/RequirementParserService'));
const MetricMappingService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/MetricMappingService'));
const NapmMetadataService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/NapmMetadataService'));
const GroupPathPlannerService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/GroupPathPlannerService'));
const PromptRoutingService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/PromptRoutingService'));
const ResolutionSpecService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/ResolutionSpecService'));
const { buildOpenClawReplyContract } = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/OpenClawNarrationContractService'));
const ExecutionFailureClassifier = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/ExecutionFailureClassifier'));
const { executeOverviewModule, extractTopGroupValues } = require(path.join(__dirname, 'overview-module'));
const TimeUtils = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/src/utils/TimeUtils'));
const { buildSafeUrl, logAudit } = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/src/utils/auditLogger'));
// validateTimeRangeFreshness / autoCorrectTimestampIfStale removed 2026-07-07:
// time override now handled by before_tool_call Hook + src/shared/timeResolver.js
const SKILL_FORWARD_DISPLAY_TEXT = ['1', 'true', 'yes', 'on'].includes(String(process.env.SKILL_FORWARD_DISPLAY_TEXT || '').trim().toLowerCase());

function normalizeTraceId(value = '') {
  const text = String(value || '').trim();
  return text ? text.slice(0, 160) : '';
}

function buildTraceIdFromPayload(payload = {}, args = {}) {
  const explicit = normalizeTraceId(
    payload?.traceId
    || args?.traceId
    || payload?.sessionState?.traceId
    || payload?.session?.traceId
  );
  if (explicit) {
    return explicit;
  }
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeResolvedQueryForAudit(resolvedQuery = null) {
  if (!resolvedQuery || typeof resolvedQuery !== 'object' || Array.isArray(resolvedQuery)) {
    return null;
  }

  const groups = Array.isArray(resolvedQuery.groups)
    ? resolvedQuery.groups.map((item) => ({
        type: item?.type || null,
        argument: item?.argument ?? null
      }))
    : [];

  return {
    service: String(resolvedQuery.service || '').trim() || null,
    queryModeKey: String(resolvedQuery.queryModeKey || '').trim() || null,
    operation: String(
      resolvedQuery?.semanticConstraints?.operation
      || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
      || ''
    ).trim() || null,
    overviewScene: String(
      resolvedQuery.overviewScene
      || resolvedQuery?.semanticConstraints?.overviewScene
      || ''
    ).trim() || null,
    groups,
    metric: String(resolvedQuery.metric || '').trim() || null,
    metrics: Array.isArray(resolvedQuery.metrics) ? resolvedQuery.metrics.slice(0, 20) : [],
    topMetric: String(resolvedQuery.topMetric || '').trim() || null,
    topCount: Number.isFinite(Number(resolvedQuery.topCount)) ? Number(resolvedQuery.topCount) : null,
    granularity: Number.isFinite(Number(resolvedQuery.granularity)) ? Number(resolvedQuery.granularity) : null,
    start: Number.isFinite(Number(resolvedQuery.start)) ? Number(resolvedQuery.start) : null,
    end: Number.isFinite(Number(resolvedQuery.end)) ? Number(resolvedQuery.end) : null,
    hasPathPlanning: Boolean(resolvedQuery.pathPlanning),
    hasExecutionGuard: Boolean(resolvedQuery?.executionGuard?.blockExecution),
    hasAnalysisPipeline: Boolean(resolvedQuery.analysisPipeline)
  };
}

function buildAuditRequestContext(traceId = null) {
  return {
    requestId: traceId || null,
    feature: 'napm-skill-query'
  };
}

function logSkillAudit(event, payload = {}, traceId = null) {
  try {
    logAudit(event, payload, buildAuditRequestContext(traceId));
  } catch (_error) {
    // best-effort audit logging only
  }
}

function detectResolvedQuerySource(args = {}, payload = {}) {
  if (payload?.resolvedQuery && typeof payload.resolvedQuery === 'object' && !Array.isArray(payload.resolvedQuery)) {
    return 'payload.resolvedQuery';
  }
  if (args?.resolvedQuery) {
    return '--resolvedQuery';
  }
  if (args?.queryJson) {
    return '--queryJson';
  }
  return null;
}

function getBoundaryMode() {
  return ResolutionSpecService.getBoundaryMode('strict');
}

function isStrictBoundaryMode() {
  return ResolutionSpecService.isStrictBoundaryMode('strict');
}

function getResolutionSpec() {
  return ResolutionSpecService.loadResolutionSpec();
}

function hasExplicitRankingMetricInText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) {
    return false;
  }

  if (/(排序指标|排行指标|top\s*metric|topmetric)/i.test(raw)) {
    return true;
  }

  const hasSortVerb = /(排序|排行|排名|top|前\d+)/i.test(raw);
  const hasByPrefix = /(按照|按|根据|基于|以)/i.test(raw);
  const hasMetricWord = /(吞吐|流量|带宽|丢包|丢包率|时延|rtt|重传|tpio|tpi|tpo|bytio|byti|byto|pli|plo|rtti|trti)/i.test(raw);

  return (hasSortVerb && hasMetricWord) || (hasByPrefix && hasMetricWord);
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prompt') {
      args.prompt = argv[index + 1];
      index += 1;
    } else if (arg === '--queryJson') {
      args.queryJson = argv[index + 1];
      index += 1;
    } else if (arg === '--payload') {
      args.payload = argv[index + 1];
      index += 1;
    } else if (arg === '--resolvedQuery') {
      args.resolvedQuery = argv[index + 1];
      index += 1;
    } else if (arg === '--decision') {
      args.decision = argv[index + 1];
      index += 1;
    } else if (arg === '--intent') {
      args.intent = argv[index + 1];
      index += 1;
    } else if (arg === '--session') {
      args.session = argv[index + 1];
      index += 1;
    } else if (arg === '--raw') {
      args.raw = true;
    }
  }

  return args;
}

function parseJsonArg(name, value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${name}: ${error.message}`);
  }
}

function coerceJsonObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (error) {
    throw new Error(`Invalid JSON object: ${error.message}`);
  }
}

function appendRequestUrlToDisplayText(displayText, requestUrl) {
  const text = String(displayText || '').trim();
  if (!text) {
    return null;
  }
  return text;
}

function buildDisplayText(summary = {}, payload = {}) {
  if (summary?.displayText) {
    return summary.displayText;
  }

  const lines = [];
  const title = String(summary?.title || '').trim();
  if (title) {
    lines.push(`\u7ed3\u8bba\uff1a${title}`);
  }

  const highlights = Array.isArray(summary?.highlights) ? summary.highlights.filter(Boolean) : [];
  highlights.forEach((item) => lines.push(String(item)));

  return lines.join('\n').trim() || null;
}

function isSensitiveCredentialPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const patterns = [
    /(?:api|接口|访问)\s*(?:账号|账户|用户名|user\s*name)/i,
    /(?:api|接口|访问)\s*(?:密码|口令|密钥|凭证|credential|secret|token)/i,
    /账号名?密码/,
    /用户名.*密码|密码.*用户名/,
    /(?:告诉我|给我|查看|显示|读取|输出|返回|暴露|泄露).*(?:密码|口令|密钥|凭证|secret|token)/i,
    /(?:env|\.env|环境变量).*(?:密码|口令|密钥|凭证|token)/i,
    /(?:NETINSIDE_PASSWORD|NETINSIDE_USERNAME|GAIOP123|GAIOP)/i
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildSensitiveCredentialRefusalText() {
  return [
    '\u8fd9\u7c7b\u8d26\u53f7\u3001\u5bc6\u7801\u3001token \u6216\u5176\u4ed6\u51ed\u8bc1\u4fe1\u606f\u5c5e\u4e8e\u654f\u611f\u4fe1\u606f\uff0c\u6211\u4e0d\u80fd\u63d0\u4f9b\u3001\u5c55\u793a\u6216\u8f6c\u8ff0\u3002',
    '\u5982\u679c\u4f60\u9700\u8981\u6392\u67e5 NAPM \u8fde\u901a\u6027\u6216\u914d\u7f6e\u95ee\u9898\uff0c\u6211\u53ef\u4ee5\u5e2e\u4f60\u68c0\u67e5\u662f\u5426\u5b58\u5728\u8ba4\u8bc1\u5931\u8d25\u3001\u63a5\u53e3 400 \u6216\u6570\u636e\u65f6\u95f4\u8303\u56f4\u5f02\u5e38\uff0c\u4f46\u4e0d\u4f1a\u66b4\u9732\u5177\u4f53\u51ed\u8bc1\u3002'
  ].join('\n');
}

function buildSummary(service, resolvedQuery, data, extra = {}) {
  const rows = Array.isArray(data) ? data : [];
  const metrics = Array.isArray(resolvedQuery?.metrics)
    ? resolvedQuery.metrics.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const metric = resolvedQuery?.metric || metrics[0] || '';
  const metricText = metrics.length > 0 ? metrics.join(',') : metric;
  const topMetric = String(resolvedQuery?.topMetric || '').trim();
  const groupPath = Array.isArray(resolvedQuery?.groups)
    ? resolvedQuery.groups.map((item) => String(item?.type || '').trim()).filter(Boolean).join(' > ')
    : '';

  if (service === 'topValues_multi_protocol') {
    const protocolQueries = Array.isArray(resolvedQuery?.protocolQueries) ? resolvedQuery.protocolQueries : [];
    const protocolLabels = protocolQueries
      .map((query) => String(query?.groups?.find((group) => group?.type === 'IPProtocol')?.argument || '').trim())
      .filter(Boolean);
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '未知端口流量排行',
      highlights: [
        metricText ? `查询指标：${metricText}` : null,
        topMetric ? `排序指标：${topMetric}` : null,
        protocolLabels.length > 0 ? `协议范围：${protocolLabels.join(' / ')}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: rows.length === 0
    };
  }

  if (service === 'groups') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '\u5bf9\u8c61\u5217\u8868',
      highlights: [],
      rowCount: rows.length,
      empty: rows.length === 0
    };
  }

  if (service === 'metrics') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '\u6307\u6807\u5217\u8868',
      highlights: [],
      rowCount: rows.length,
      empty: rows.length === 0
    };
  }

  if (rows.length === 0) {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '\u672a\u67e5\u5230\u6570\u636e',
      highlights: [
        metricText ? `\u67e5\u8be2\u6307\u6807\uff1a${metricText}` : null,
        groupPath ? `\u67e5\u8be2\u8303\u56f4\uff1a${groupPath}` : null
      ].filter(Boolean),
      rowCount: 0,
      empty: true
    };
  }

  if (service === 'topValues') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '\u6392\u884c\u7ed3\u679c',
      highlights: [
        metricText ? `\u6307\u6807\uff1a${metricText}` : null,
        topMetric ? `\u6392\u5e8f\u6307\u6807\uff1a${topMetric}` : null,
        groupPath ? `\u5bf9\u8c61\u8303\u56f4\uff1a${groupPath}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: false,
      metrics: metrics.length > 0 ? metrics : (metric ? [metric] : []),
      topMetric: topMetric || null
    };
  }

  if (service === 'timeValues') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '\u8d8b\u52bf\u7ed3\u679c',
      highlights: [
        metricText ? `\u6307\u6807\uff1a${metricText}` : null,
        groupPath ? `\u5bf9\u8c61\u8303\u56f4\uff1a${groupPath}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: false,
      metrics: metrics.length > 0 ? metrics : (metric ? [metric] : [])
    };
  }

  return {
    mode: extra.mode || 'GO_DIRECT_QUERY',
    title: '\u67e5\u8be2\u7ed3\u679c',
    highlights: [
      metricText ? `\u6307\u6807\uff1a${metricText}` : null,
      groupPath ? `\u5bf9\u8c61\u8303\u56f4\uff1a${groupPath}` : null
    ].filter(Boolean),
    rowCount: rows.length,
    empty: false,
    metrics: metrics.length > 0 ? metrics : (metric ? [metric] : [])
  };
}

const DISCOVERY_CONTAINER_TARGET_MAP = {
  ClientIPs: 'IPAddress',
  ServerIPs: 'IPAddress',
  MemberIPs: 'IPAddress',
  ExternalIPs: 'IPAddress',
  InternalIPs: 'IPAddress',
  ConnectedIPs: 'ConnectedIP',
  Applications: 'DefinedApp',
  OtherApps: 'OtherApp',
  IPConversations: 'IPConversation'
};

const OVERVIEW_SCENE_BY_OBJECT_TYPE = {
  BusinessGroup: 'business_group',
  WebApplication: 'business',
  DefinedApp: 'application',
  Application: 'application',
  IPAddress: 'network',
  ConnectedIP: 'network',
  Prefix24: 'network',
  IPConversation: 'network',
  OtherApp: 'security',
  TotalTraffic: 'system'
};

const COMPREHENSIVE_ANALYSIS_RESPONSE_TYPE = 'comprehensive_analysis';
const DISCOVER_THEN_ANALYZE_RESPONSE_TYPE = 'comprehensive_analysis_with_discovery';

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function resolvePrimaryMetricId(query = {}) {
  return String(
    query?.metric
    || query?.topMetric
    || (Array.isArray(query?.metrics) ? query.metrics[0] : '')
    || ''
  ).trim() || null;
}

function inferMetricDomainFromMetric(metricId = '') {
  const metric = String(metricId || '').trim().toUpperCase();
  if (!metric) {
    return null;
  }
  if (metric === 'PLI' || metric === 'PLO') {
    return 'loss';
  }
  if (['RFCI', 'RFCO', 'RFRI', 'RFR0', 'PGHTTP400', 'PGHTTP500', 'PGHTTP400PCT', 'PGHTTP500PCT'].includes(metric) || metric.startsWith('PGHTTP')) {
    return 'error';
  }
  if (['CONI', 'CONO', 'CCNI', 'CCNO', 'CSTI'].includes(metric)) {
    return 'session';
  }
  if (['TPIO', 'TPI', 'TPO', 'BYTIO', 'BYTI', 'BYTO', 'PKIO'].includes(metric)) {
    return 'traffic';
  }
  if (['RTTI', 'TRTI', 'PGTME', 'PGTMS', 'RDTO'].includes(metric)) {
    return 'experience';
  }
  return null;
}

function normalizeQueryGroups(groups = []) {
  return Array.isArray(groups)
    ? groups.map((item) => ({
      type: item?.type || null,
      argument: item?.argument ?? null
    })).filter((item) => item.type)
    : [];
}

function floorToMinute(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric / 60) * 60;
}

function normalizeResolvedQueryTimeRange(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return query;
  }

  if (Number.isFinite(Number(query.start)) && Number(query.start) > 0) {
    query.start = floorToMinute(query.start);
  }
  if (Number.isFinite(Number(query.end)) && Number(query.end) > 0) {
    query.end = floorToMinute(query.end);
  }
  // 2026-07-07: 时间覆盖已由 before_tool_call Hook 统一处理，
  // validateTimeRangeFreshness / autoCorrectTimestampIfStale 不再需要。
  if (query.timeRange && typeof query.timeRange === 'object' && !Array.isArray(query.timeRange)) {
    delete query.timeRange.start;
    delete query.timeRange.end;
  }
  if (query.analysisPipeline?.discoveryQuery && typeof query.analysisPipeline.discoveryQuery === 'object') {
    query.analysisPipeline.discoveryQuery = stripDiscoveryQueryExecutionTime(
      normalizeResolvedQueryTimeRange(query.analysisPipeline.discoveryQuery)
    );
  }
  if (Array.isArray(query.protocolQueries)) {
    query.protocolQueries = query.protocolQueries.map((item) => (
      item && typeof item === 'object'
        ? normalizeResolvedQueryTimeRange(item)
        : item
    ));
  }
  return query;
}

function stripDiscoveryQueryExecutionTime(discoveryQuery = {}) {
  if (!discoveryQuery || typeof discoveryQuery !== 'object' || Array.isArray(discoveryQuery)) {
    return discoveryQuery;
  }

  const next = {
    ...discoveryQuery
  };
  delete next.start;
  delete next.end;
  if (next.timeRange && typeof next.timeRange === 'object' && !Array.isArray(next.timeRange)) {
    const cleanedTimeRange = { ...next.timeRange };
    delete cleanedTimeRange.start;
    delete cleanedTimeRange.end;
    if (Object.keys(cleanedTimeRange).length > 0) {
      next.timeRange = cleanedTimeRange;
    } else {
      delete next.timeRange;
    }
  }
  return next;
}

function inferOverviewSceneFromObjectType(objectType = '') {
  return OVERVIEW_SCENE_BY_OBJECT_TYPE[String(objectType || '').trim()] || null;
}

function normalizeDiscoveryTargetObjectType(type = '') {
  const raw = String(type || '').trim();
  if (!raw) {
    return null;
  }
  if (DISCOVERY_CONTAINER_TARGET_MAP[raw]) {
    return DISCOVERY_CONTAINER_TARGET_MAP[raw];
  }
  return raw;
}

function inferDiscoveryTargetObjectType(analysisPipeline = {}, discoveryQuery = {}) {
  const explicit = normalizeDiscoveryTargetObjectType(
    analysisPipeline?.targetObjectType
    || analysisPipeline?.focusObjectType
    || analysisPipeline?.selection?.targetObjectType
    || discoveryQuery?.semanticConstraints?.targetObjectType
    || discoveryQuery?.candidateSpec?.semantic_constraints?.targetObjectType
  );
  if (explicit) {
    return explicit;
  }

  const groups = normalizeQueryGroups(discoveryQuery?.groups);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeDiscoveryTargetObjectType(groups[index]?.type);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function buildDiscoveryQuery(baseResolvedQuery = {}, prompt = '') {
  const pipeline = baseResolvedQuery?.analysisPipeline && typeof baseResolvedQuery.analysisPipeline === 'object'
    ? baseResolvedQuery.analysisPipeline
    : {};
  const discoverySeed = pipeline?.discoveryQuery && typeof pipeline.discoveryQuery === 'object'
    ? pipeline.discoveryQuery
    : null;
  if (!discoverySeed) {
    return null;
  }

  const query = normalizeResolvedQueryShape(stripDiscoveryQueryExecutionTime(discoverySeed), prompt);
  if (hasExplicitTimeRange(baseResolvedQuery)) {
    query.start = Number(baseResolvedQuery.start);
    query.end = Number(baseResolvedQuery.end);
  }
  if ((!query.metric && !Array.isArray(query.metrics)) && baseResolvedQuery?.metric) {
    query.metric = baseResolvedQuery.metric;
  }
  if ((!Array.isArray(query.metrics) || query.metrics.length === 0) && Array.isArray(baseResolvedQuery?.metrics) && baseResolvedQuery.metrics.length > 0) {
    query.metrics = baseResolvedQuery.metrics.slice();
  }
  if (query.service === 'topValues' && !query.topMetric) {
    query.topMetric = query.metric || query.metrics?.[0] || baseResolvedQuery?.topMetric || null;
  }
  return normalizeResolvedQueryTimeRange(query);
}

function validateAnalysisPipelineContract(baseResolvedQuery = {}) {
  const pipeline = baseResolvedQuery?.analysisPipeline && typeof baseResolvedQuery.analysisPipeline === 'object'
    ? baseResolvedQuery.analysisPipeline
    : null;
  const discoveryQuery = pipeline?.discoveryQuery && typeof pipeline.discoveryQuery === 'object'
    ? pipeline.discoveryQuery
    : null;

  if (!discoveryQuery) {
    return {
      ok: false,
      code: 'DISCOVERY_QUERY_MISSING',
      message: 'analysisPipeline.discoveryQuery is required for discover-then-overview execution.',
      stage: 'analysisPipeline'
    };
  }

  if (!hasExplicitTimeRange(baseResolvedQuery)) {
    return {
      ok: false,
      code: 'ANALYSIS_PIPELINE_TIME_RANGE_MISSING',
      message: 'analysisPipeline requires top-level start/end generated by napm-resolve-time-range.',
      stage: 'analysisPipeline'
    };
  }

  const targetObjectType = inferDiscoveryTargetObjectType(pipeline, discoveryQuery);
  const groups = normalizeQueryGroups(discoveryQuery.groups);
  const discoveryGroupType = normalizeDiscoveryTargetObjectType(groups[0]?.type);

  if (!targetObjectType) {
    return {
      ok: false,
      code: 'DISCOVERY_TARGET_TYPE_UNRESOLVED',
      message: 'analysisPipeline.targetObjectType or discoveryQuery.groups[0].type is required.',
      stage: 'analysisPipeline'
    };
  }

  if (!discoveryGroupType) {
    return {
      ok: false,
      code: 'DISCOVERY_GROUP_TYPE_MISSING',
      message: 'discoveryQuery.groups[0].type is required.',
      stage: 'discoveryQuery'
    };
  }

  if (targetObjectType !== discoveryGroupType) {
    return {
      ok: false,
      code: 'DISCOVERY_TARGET_TYPE_MISMATCH',
      message: `analysisPipeline targetObjectType ${targetObjectType} does not match discoveryQuery group type ${discoveryGroupType}.`,
      stage: 'analysisPipeline',
      targetObjectType,
      discoveryGroupType
    };
  }

  if (String(discoveryQuery.service || '').trim() !== 'topValues') {
    return {
      ok: false,
      code: 'UNSUPPORTED_DISCOVERY_SERVICE',
      message: 'analysisPipeline.discoveryQuery currently supports service=topValues only.',
      stage: 'discoveryQuery',
      service: discoveryQuery.service || null
    };
  }

  const primaryMetric = resolvePrimaryMetricId(discoveryQuery);
  if (!primaryMetric) {
    return {
      ok: false,
      code: 'DISCOVERY_METRIC_MISSING',
      message: 'discoveryQuery requires metric, metrics[0], or topMetric.',
      stage: 'discoveryQuery'
    };
  }

  return {
    ok: true,
    targetObjectType,
    discoveryGroupType,
    primaryMetric
  };
}

function deriveDiscoveryFocusSelection(analysisPipeline = {}, discoveryQuery = {}, discoveryResult = {}) {
  const targetObjectType = inferDiscoveryTargetObjectType(analysisPipeline, discoveryQuery);
  if (!targetObjectType) {
    return null;
  }

  const rows = Array.isArray(discoveryResult?.data) ? discoveryResult.data : [];
  const metricHints = [
    discoveryQuery?.metric,
    discoveryQuery?.topMetric,
    ...(Array.isArray(discoveryQuery?.metrics) ? discoveryQuery.metrics : [])
  ].filter(Boolean);
  const selectedRank = Number(analysisPipeline?.selection?.rank);
  const normalizedRank = Number.isFinite(selectedRank) && selectedRank > 0 ? selectedRank : 1;
  const selectedValue = extractTopGroupValues(rows, targetObjectType, metricHints, 1)[0] || null;
  if (selectedValue) {
    return {
      type: targetObjectType,
      value: selectedValue,
      rank: normalizedRank,
      metric: resolvePrimaryMetricId(discoveryQuery),
      sourceService: discoveryQuery?.service || null
    };
  }

  const groups = normalizeQueryGroups(discoveryQuery?.groups);
  const explicitGroup = groups.find((item) => normalizeDiscoveryTargetObjectType(item.type) === targetObjectType && item.argument);
  if (explicitGroup?.argument) {
    return {
      type: targetObjectType,
      value: String(explicitGroup.argument).trim(),
      rank: 1,
      metric: resolvePrimaryMetricId(discoveryQuery),
      sourceService: discoveryQuery?.service || null
    };
  }

  const anchorObject = discoveryQuery?.semanticConstraints?.anchorObject || null;
  if (normalizeDiscoveryTargetObjectType(anchorObject?.type) === targetObjectType && anchorObject?.argument) {
    return {
      type: targetObjectType,
      value: String(anchorObject.argument).trim(),
      rank: 1,
      metric: resolvePrimaryMetricId(discoveryQuery),
      sourceService: discoveryQuery?.service || null
    };
  }

  return null;
}

function buildFocusedOverviewResolvedQuery(baseResolvedQuery = {}, focusSelection = null, discoveryQuery = null) {
  if (!focusSelection?.type || !focusSelection?.value) {
    return null;
  }

  const next = deepClone(baseResolvedQuery) || {};
  const focusGroup = {
    type: focusSelection.type,
    argument: focusSelection.value
  };
  const existingContextGroups = normalizeQueryGroups([
    ...(Array.isArray(next?.contextGroups) ? next.contextGroups : []),
    ...(Array.isArray(next?.groups) ? next.groups : [])
  ]).filter((item) => item.argument && !(item.type === focusGroup.type && String(item.argument).trim() === focusGroup.argument));

  next.service = 'overview';
  next.queryModeKey = 'overview';
  next.groups = [focusGroup];
  next.contextGroups = existingContextGroups;
  next.overviewScene = next.overviewScene
    || next?.semanticConstraints?.overviewScene
    || next?.analysisScene
    || next?.semanticConstraints?.analysisScene
    || inferOverviewSceneFromObjectType(focusSelection.type)
    || inferOverviewSceneFromObjectType(discoveryQuery?.groups?.[0]?.type)
    || 'system';
  next.analysisType = next.analysisType || next?.semanticConstraints?.analysisType || 'comprehensive_analysis';
  next.analysisMode = next.analysisMode || next?.semanticConstraints?.analysisMode || 'discover_then_analyze';
  next.analysisScene = next.analysisScene || next?.semanticConstraints?.analysisScene || next.overviewScene;

  const metricId = resolvePrimaryMetricId(discoveryQuery || next);
  if (metricId) {
    next.metric = next.metric || metricId;
    if (!Array.isArray(next.metrics) || next.metrics.length === 0) {
      next.metrics = [metricId];
    }
  }

  const inferredMetricDomain = inferMetricDomainFromMetric(metricId);
  next.metricDomain = next.metricDomain || inferredMetricDomain || null;
  next.semanticConstraints = {
    ...(next?.semanticConstraints && typeof next.semanticConstraints === 'object' ? next.semanticConstraints : {}),
    operation: 'overview',
    analysisType: next.analysisType,
    analysisMode: next.analysisMode,
    analysisScene: next.analysisScene,
    overviewScene: next.overviewScene,
    targetObjectType: focusSelection.type,
    anchorObject: {
      type: focusSelection.type,
      argument: focusSelection.value
    },
    metricDomain: next?.semanticConstraints?.metricDomain || inferredMetricDomain || null
  };

  const originalPipeline = next?.analysisPipeline && typeof next.analysisPipeline === 'object'
    ? next.analysisPipeline
    : {};
  next.analysisPipeline = {
    ...originalPipeline,
    analysisType: next.analysisType,
    analysisMode: next.analysisMode,
    analysisScene: next.analysisScene,
    discoveryQuery: null,
    discovery: {
      targetObjectType: focusSelection.type,
      selectedObject: focusSelection.value,
      rank: focusSelection.rank || 1,
      metric: focusSelection.metric || metricId || null,
      service: focusSelection.sourceService || discoveryQuery?.service || null
    }
  };

  if (!hasExplicitTimeRange(next) && hasExplicitTimeRange(discoveryQuery)) {
    next.start = Number(discoveryQuery.start);
    next.end = Number(discoveryQuery.end);
  }

  return normalizeResolvedQueryShape(next, next.userRequirement || '');
}

function buildAnalysisDiscoveryFailureResult(baseResolvedQuery = {}, discoveryQuery = {}, discoveryResult = {}, options = {}) {
  const targetObjectType = inferDiscoveryTargetObjectType(baseResolvedQuery?.analysisPipeline, discoveryQuery) || '目标对象';
  const metricId = resolvePrimaryMetricId(discoveryQuery);
  const stage = String(options.stage || 'discoveryQuery').trim();
  const code = String(options.code || discoveryResult?.error?.code || 'DISCOVERY_TARGET_NOT_FOUND').trim();
  const reason = String(options.message || discoveryResult?.error?.message || '').trim();
  const text = code === 'DISCOVERY_TARGET_NOT_FOUND'
    ? [
        `本次未在指定时间范围内发现符合条件的 ${targetObjectType}，因此没有进入聚焦分析。`,
        `查询对象：${targetObjectType}`,
        `排序指标：${metricId || '未指定'}`,
        reason ? `失败原因：${reason}` : null
      ].filter(Boolean).join('\n')
    : [
        '本次未能完成“先发现对象”的步骤，因此没有进入聚焦分析。',
        `失败阶段：${stage}`,
        `查询对象：${targetObjectType}`,
        `排序指标：${metricId || '未指定'}`,
        `失败原因：${reason || code}`
      ].join('\n');
  return {
    ok: false,
    service: 'overview',
    data: [],
    responseType: 'decision_result',
    failureStage: stage,
    summary: buildDecisionSummary(
      code === 'DISCOVERY_TARGET_NOT_FOUND' ? '未锁定可分析对象' : '先发现对象步骤失败',
      text,
      code
    ),
    error: {
      code,
      message: reason || text,
      userMessage: text,
      failureStage: stage
    },
    requestUrl: discoveryResult?.requestUrl || null,
    warnings: discoveryResult?.error?.message ? [String(discoveryResult.error.message)] : []
  };
}

function isOverviewResolvedQuery(resolvedQuery = null) {
  const semanticOperation = String(
    resolvedQuery?.semanticConstraints?.operation
    || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
    || ''
  ).trim().toLowerCase();

  return resolvedQuery?.service === 'overview'
    || resolvedQuery?.queryModeKey === 'overview'
    || semanticOperation === 'overview';
}

function buildFollowUpActionsFromGate(gate = null) {
  const options = Array.isArray(gate?.options) ? gate.options : [];
  return options.map((item) => ({
    label: item?.label || item?.value || null,
    value: item?.value || item?.label || null,
    query: item?.replyText || item?.value || item?.label || null
  })).filter((item) => item.query);
}

function buildDecisionSummary(title, text, mode = 'ASK_CLARIFYING_QUESTION') {
  return {
    mode,
    title,
    highlights: [text].filter(Boolean),
    rowCount: 0,
    empty: true,
    displayText: text
  };
}

function normalizeDrilldownQuestionTarget(raw = '') {
  return PromptRoutingService.normalizeHierarchyQuestionTarget(raw);
}

function isHierarchyCatalogPrompt(prompt = '') {
  return PromptRoutingService.isHierarchyCatalogPrompt(prompt);
}

function buildDrilldownCatalogDisplayText(result = null) {
  if (!result) {
    return '当前没有识别到可用的下钻层级信息。';
  }

  if (Array.isArray(result.catalog)) {
    const lines = ['当前静态 group 树里的顶层对象及其直接下钻方向如下：'];
    result.catalog.forEach((item) => {
      const children = Array.isArray(item.directChildren)
        ? item.directChildren.map((child) => child.runtimeKey || child.key).filter(Boolean)
        : [];
      lines.push(`- ${item.runtimeGroupType || item.groupType}：${children.length > 0 ? children.join('、') : '暂无下层'}`);
    });
    lines.push('如果你要看某个顶层对象的完整路径，我可以继续按对象展开。');
    return lines.join('\n');
  }

  const directChildren = Array.isArray(result.directChildren)
    ? result.directChildren.map((item) => item.runtimeKey || item.key).filter(Boolean)
    : [];
  const samplePaths = Array.isArray(result.paths)
    ? result.paths.map((item) => item.runtimePathText).filter(Boolean).slice(0, 12)
    : [];

  const lines = [
    `${result.runtimeGroupType || result.groupType} 支持的直接下钻方向：${directChildren.length > 0 ? directChildren.join('、') : '暂无下层'}`
  ];

  if (samplePaths.length > 0) {
    lines.push('常见下钻路径：');
    samplePaths.forEach((pathText) => lines.push(`- ${pathText}`));
  }

  lines.push('以上是基于本地静态 group 树整理出的结构层级，不依赖上游维度元数据接口权限。');
  return lines.join('\n');
}

function buildDrilldownCatalogSummary(result = null) {
  const title = Array.isArray(result?.catalog)
    ? '顶层对象下钻目录'
    : `${result?.runtimeGroupType || result?.groupType || '对象'}下钻路径`;
  const displayText = buildDrilldownCatalogDisplayText(result);

  return {
    mode: 'GO_DIRECT_QUERY',
    title,
    highlights: displayText.split('\n').filter(Boolean).slice(0, 12),
    rowCount: Array.isArray(result?.catalog)
      ? result.catalog.length
      : Array.isArray(result?.paths) ? result.paths.length : 0,
    empty: false,
    displayText
  };
}

async function buildHierarchyCatalogPayload(prompt = '') {
  if (!isHierarchyCatalogPrompt(prompt)) {
    return null;
  }

  const targetGroupType = normalizeDrilldownQuestionTarget(prompt);
  if (!targetGroupType) {
    const catalog = await NapmMetadataService.getTopLevelDrilldownCatalog({ maxDepth: 2 });
    return {
      service: 'drilldownCatalog',
      targetGroupType: null,
      catalog
    };
  }

  const result = await NapmMetadataService.getDrilldownPathsForGroupType(targetGroupType, { maxDepth: 2 });
  if (!result) {
    return {
      service: 'drilldownCatalog',
      targetGroupType,
      notFound: true
    };
  }

  return {
    service: 'drilldownCatalog',
    targetGroupType,
    ...result
  };
}

async function buildHierarchyCatalogPayloadFromResolvedQuery(resolvedQuery = null) {
  if (!resolvedQuery || resolvedQuery.service !== 'drilldownCatalog') {
    return null;
  }

  const groups = Array.isArray(resolvedQuery.groups) ? resolvedQuery.groups : [];
  const targetGroupType = String(
    groups.find((item) => item && typeof item === 'object' && item.type)?.type || ''
  ).trim();

  if (!targetGroupType) {
    const catalog = await NapmMetadataService.getTopLevelDrilldownCatalog({ maxDepth: 2 });
    return {
      service: 'drilldownCatalog',
      targetGroupType: null,
      catalog
    };
  }

  const result = await NapmMetadataService.getDrilldownPathsForGroupType(targetGroupType, { maxDepth: 2 });
  if (!result) {
    return {
      service: 'drilldownCatalog',
      targetGroupType,
      notFound: true
    };
  }

  return {
    service: 'drilldownCatalog',
    targetGroupType,
    ...result
  };
}

function buildHierarchyCatalogContract(prompt = '', payload = null) {
  const notFound = Boolean(payload?.notFound);
  const displayText = notFound
    ? `没有在本地静态 group 树里识别到 ${payload?.targetGroupType || '该对象'} 的下钻定义。`
    : buildDrilldownCatalogDisplayText(payload);
  const summary = notFound
    ? buildDecisionSummary('未识别到对象下钻定义', displayText, 'GROUP_HIERARCHY_NOT_FOUND')
    : buildDrilldownCatalogSummary(payload);

  return buildOpenClawReplyContract({
    ok: !notFound,
    prompt,
    service: 'drilldownCatalog',
    resolvedQuery: {
      service: 'drilldownCatalog',
      userRequirement: prompt,
      groups: payload?.targetGroupType
        ? [{ type: payload.targetGroupType, argument: null }]
        : []
    },
    rows: [],
    data: [],
    summary,
    error: notFound ? {
      code: 'GROUP_HIERARCHY_NOT_FOUND',
      message: displayText
    } : null,
    responseType: 'decision_result',
    displayText,
    followUpActions: [],
    narrationStructure: {
      responseType: 'decision_result',
      title: summary.title,
      explanation: displayText,
      timeRange: null,
      nextActions: []
    },
    narrationInput: {
      schema: 'openclaw_napm_narration.v1',
      narrationBy: 'openclaw',
      narrationRequired: true,
      type: 'decision_result',
      service: 'drilldownCatalog',
      responseType: 'decision_result',
      decision: null,
      intent: {
        objectType: 'IntentResult',
        userIntent: 'metadata',
        questionType: 'drilldown_hierarchy',
        service: 'drilldownCatalog',
        scopeHint: payload?.targetGroupType || 'all_top_level_groups',
        preferOverviewFirst: false,
        stableTemplateId: null,
        candidateGeneration: null,
        metricDomainCandidates: [],
        confidence: 0.95
      },
      resolvedQuery: {
        service: 'drilldownCatalog',
        userRequirement: prompt,
        groups: payload?.targetGroupType
          ? [{ type: payload.targetGroupType, argument: null }]
          : []
      },
      request: {
        requestUrl: null,
        requestParamsJson: null,
        timeRange: null
      },
      summary,
      result: {
        timeRange: null,
        rows: [],
        structuredRows: [],
        structuredSeries: null,
        enrichedRows: [],
        compareResult: null,
        overview: null,
        hierarchyCatalog: payload,
        narrationStructure: {
          responseType: 'decision_result',
          title: summary.title,
          explanation: displayText,
          timeRange: null,
          nextActions: []
        }
      },
      followUp: {
        prompts: [],
        actions: []
      },
      renderPolicy: {
        language: 'zh-CN',
        narrationRequired: true,
        target: 'final_user_reply',
        responseType: 'decision_result',
        preferSources: [
          'result.hierarchyCatalog',
          'result.narrationStructure',
          'summary'
        ],
        fallbackSources: [
          'displayText',
          'replyText'
        ],
        rules: [
          'Answer with structural drilldown hierarchy from the local static groups tree.',
          'Do not claim metadata API permission failure when hierarchyCatalog is present.'
        ]
      }
    }
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText,
    includeRequestUrl: false
  });
}

function isQueryConstructionExplanationPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasApiIntent = /(?:api|url|参数|param|request)/i.test(text);
  const hasExplainIntent = /(?:思路|构成|构造|怎么查|如何查|怎么拼|怎么组|来源|依据|为什么这样|返回给我|最终的?|最终api|方法来源)/i.test(text);
  const hasReferenceIntent = /(?:这个|这个查询|刚才|上一条|上一个|刚刚|该查询|这次)/i.test(text);

  return hasApiIntent && (hasExplainIntent || hasReferenceIntent);
}

function cloneQueryGroups(groups = []) {
  return Array.isArray(groups)
    ? groups.map((group) => ({
      type: group?.type || null,
      argument: group?.argument ?? null
    })).filter((group) => group.type)
    : [];
}

function buildRequestUrlFromRememberedQuery(rememberedQuery = null) {
  if (!rememberedQuery || typeof rememberedQuery !== 'object') {
    return null;
  }

  const requestParamsJson = rememberedQuery.requestParamsJson && typeof rememberedQuery.requestParamsJson === 'object'
    ? rememberedQuery.requestParamsJson
    : null;
  if (!requestParamsJson) {
    return null;
  }

  const baseUrl = String(process.env.NETINSIDE_HOST || '').trim();
  const username = String(process.env.NETINSIDE_USERNAME || '').trim();
  const password = String(process.env.NETINSIDE_PASSWORD || '').trim();
  if (!baseUrl || !username || !password) {
    return null;
  }

  return buildSafeUrl(baseUrl, {
    UserName: username,
    Password: password,
    ...requestParamsJson
  });
}

function buildGroupPathExplanation(groups = []) {
  const normalizedGroups = cloneQueryGroups(groups);
  if (normalizedGroups.length === 0) {
    return '当前查询没有显式 group path。';
  }

  return normalizedGroups.map((group) => (
    group.argument ? `${group.type}(${group.argument})` : group.type
  )).join(' -> ');
}

function buildQueryConstructionExplanationText(prompt = '', rememberedQuery = null) {
  const context = rememberedQuery && typeof rememberedQuery === 'object'
    ? rememberedQuery
    : null;
  if (!context) {
    return '';
  }

  const resolvedQuery = context.resolvedQuery && typeof context.resolvedQuery === 'object'
    ? context.resolvedQuery
    : {};
  const requestParamsJson = context.requestParamsJson && typeof context.requestParamsJson === 'object'
    ? context.requestParamsJson
    : null;
  const requestUrl = String(
    context.requestUrl
    || buildRequestUrlFromRememberedQuery(context)
    || ''
  ).trim();
  const metricsText = Array.isArray(resolvedQuery.metrics) && resolvedQuery.metrics.length > 0
    ? resolvedQuery.metrics.join(', ')
    : (resolvedQuery.metric ? String(resolvedQuery.metric) : '');
  const lines = [];

  if (resolvedQuery.start && resolvedQuery.end) {
    lines.push(`数据时间：${TimeUtils.formatDate(resolvedQuery.start)} 至 ${TimeUtils.formatDate(resolvedQuery.end)}`);
  }
  lines.push('这次查询实际走的是项目内 skill 执行链，不是临时用外部 python3 去解析。');
  lines.push('构造思路：先按项目内的 group path 规则确定查询层级，再由项目代码拼成 NetInside 参数。');
  lines.push(`本次 group path：${buildGroupPathExplanation(resolvedQuery.groups)}`);
  if (metricsText) {
    lines.push(`指标：${metricsText}`);
  }
  if (resolvedQuery.service) {
    lines.push(`service：${resolvedQuery.service}`);
  }
  lines.push('方法来源：');
  lines.push('1. 项目内静态维度树与路径规划逻辑。');
  lines.push('2. 项目内 RequirementParserService / GroupBuilder 的参数拼装规则。');
  lines.push('3. 项目内 NapmClient 对 NetInside WebService 的真实请求。');
  if (requestParamsJson) {
    lines.push(`最终请求参数：${JSON.stringify(requestParamsJson, null, 2)}`);
  } else {
    lines.push('最终请求参数：当前上下文里没有保留下来。');
  }
  if (requestUrl) {
    lines.push(`最终 API：${requestUrl}`);
  }

  return lines.join('\n');
}

function buildQueryConstructionExplanationContract(prompt = '', rememberedQuery = null) {
  const text = buildQueryConstructionExplanationText(prompt, rememberedQuery);
  if (!text) {
    return null;
  }

  const resolvedQuery = rememberedQuery?.resolvedQuery && typeof rememberedQuery.resolvedQuery === 'object'
    ? rememberedQuery.resolvedQuery
    : {
      service: 'query_explanation',
      userRequirement: prompt
    };
  const requestParamsJson = rememberedQuery?.requestParamsJson && typeof rememberedQuery.requestParamsJson === 'object'
    ? rememberedQuery.requestParamsJson
    : null;
  const requestUrl = String(
    rememberedQuery?.requestUrl
    || buildRequestUrlFromRememberedQuery(rememberedQuery)
    || ''
  ).trim() || null;
  const summary = buildDecisionSummary('查询构造说明', text, 'ANSWER_CONCEPTUALLY');

  return buildOpenClawReplyContract({
    ok: true,
    prompt,
    service: 'query_explanation',
    resolvedQuery,
    rows: [],
    data: [],
    summary,
    error: null,
    requestUrl,
    requestParamsJson,
    displayText: text,
    followUpActions: [],
    responseType: 'decision_result'
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText,
    includeRequestUrl: false
  });
}

function normalizeResolvedQueryShape(resolvedQuery = {}, prompt = '') {
  const query = resolvedQuery && typeof resolvedQuery === 'object'
    ? JSON.parse(JSON.stringify(resolvedQuery))
    : {};

  query.userRequirement = query.userRequirement || prompt || '';
  query.format = query.format || 'json';

  if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
    if (query.metric) {
      query.metrics = [query.metric];
    }
  }

  if (query.service === 'topValues') {
    query.topCount = Number.isFinite(Number(query.topCount)) && Number(query.topCount) > 0
      ? Number(query.topCount)
      : 10;
    query.topMetric = query.topMetric || query.metric || query.metrics?.[0] || null;

  }

  if (query.service === 'timeValues') {
    query.granularity = Number.isFinite(Number(query.granularity)) && Number(query.granularity) > 0
      ? Number(query.granularity)
      : 3600;
  }

  return normalizeResolvedQueryTimeRange(query);
}

function cloneGroups(groups = []) {
  return Array.isArray(groups)
    ? groups.map((item) => ({
      type: item?.type || null,
      argument: item?.argument ?? null
    })).filter((item) => item.type)
    : [];
}

function normalizeSessionState(session = null) {
  if (!session || typeof session !== 'object') {
    return null;
  }

  return {
    active_domain: session.active_domain || null,
    last_time_range: session.last_time_range && typeof session.last_time_range === 'object'
      ? {
        start: floorToMinute(session.last_time_range.start),
        end: floorToMinute(session.last_time_range.end)
      }
      : null,
    last_metric: String(session.last_metric || '').trim() || null,
    last_groups: cloneGroups(session.last_groups),
    last_result_available: Boolean(session.last_result_available),
    turn_expiry: Number(session.turn_expiry) || 0
  };
}

function hasUsableSessionContext(session = null) {
  return Boolean(
    session
    && session.last_result_available
    && session.turn_expiry > 0
  );
}

function extractContinuationInstruction(query = {}) {
  const pathPlanning = query?.pathPlanning && typeof query.pathPlanning === 'object'
    ? query.pathPlanning
    : {};
  const semanticConstraints = query?.semanticConstraints && typeof query.semanticConstraints === 'object'
    ? query.semanticConstraints
    : {};
  const executionHints = query?.executionHints && typeof query.executionHints === 'object'
    ? query.executionHints
    : {};

  const requestedAction = String(
    pathPlanning?.followUpAction
    || semanticConstraints?.followUpAction
    || executionHints?.followUpAction
    || query?.followUpAction
    || ''
  ).trim().toLowerCase();

  const explicitPath = Array.isArray(pathPlanning?.plannedGroups)
    ? pathPlanning.plannedGroups
    : (Array.isArray(semanticConstraints?.plannedGroups)
      ? semanticConstraints.plannedGroups
      : []);

  return {
    requestedAction,
    plannedGroups: cloneGroups(explicitPath),
    inheritGroups: requestedAction === 'inherit_groups' || executionHints?.inheritGroups === true,
    inheritTimeRange: requestedAction === 'inherit_time_range' || executionHints?.inheritTimeRange === true,
    inheritMetric: requestedAction === 'inherit_metric' || executionHints?.inheritMetric === true
  };
}

function hasExplicitTimeRange(query = {}) {
  return Number(query?.start) > 0 && Number(query?.end) > 0;
}

function isDrilldownPrompt(prompt = '') {
  const raw = String(prompt || '').trim();
  if (!raw) {
    return false;
  }

  return /(?:继续|接着|往下|下钻|深入|细看|明细|详情|详细|展开|下一层|具体到|具体看|细分到|钻取)/i.test(raw);
}

function inferDrilldownPathFromPrompt(groups = [], prompt = '') {
  const baseGroups = cloneGroups(groups);
  if (baseGroups.length === 0) {
    return baseGroups;
  }

  const raw = String(prompt || '').trim();
  const lower = raw.toLowerCase();
  const firstType = String(baseGroups[0]?.type || '').trim();
  const lastType = String(baseGroups[baseGroups.length - 1]?.type || '').trim();
  const pathKey = baseGroups.map((item) => item.type).join('>');

  const appendIfMissing = (items = []) => {
    const next = cloneGroups(baseGroups);
    items.forEach((type) => {
      const currentLastType = String(next[next.length - 1]?.type || '').trim();
      if (currentLastType !== type) {
        next.push({ type, argument: null });
      }
    });
    return next;
  };

  if (/(客户端|client)/i.test(raw)) {
    if (firstType === 'WebApplication' || firstType === 'PageFamily') {
      return appendIfMissing(['ClientIPs', 'IPAddress']);
    }
  }

  if (/(服务端|服务器|server)/i.test(raw)) {
    if (firstType === 'WebApplication' || firstType === 'PageFamily') {
      return appendIfMissing(['ServerIPs', 'IPAddress']);
    }
  }

  if (/(成员ip|成员|member)/i.test(raw)) {
    if (firstType === 'BusinessGroup' || firstType === 'Prefix24') {
      return appendIfMissing(['MemberIPs', 'IPAddress']);
    }
  }

  if (/(连接ip|对端ip|连接对象|connected)/i.test(raw)) {
    if (firstType === 'BusinessGroup' || firstType === 'Prefix24' || firstType === 'IPAddress') {
      return appendIfMissing(['ConnectedIPs', 'IPAddress']);
    }
  }

  if (/(会话|session|conversation)/i.test(lower)) {
    if (firstType === 'BusinessGroup' || firstType === 'Prefix24') {
      return appendIfMissing(['IPConversations', 'IPConversation']);
    }
  }

  if (/(应用|application|协议)/i.test(raw)) {
    if (firstType === 'BusinessGroup' || firstType === 'IPAddress' || firstType === 'Prefix24') {
      return appendIfMissing(['Applications', 'DefinedApp']);
    }
  }

  if (/(页面|pagefamily|页面族)/i.test(raw)) {
    if (firstType === 'WebApplication') {
      return appendIfMissing(['PageFamily']);
    }
  }

  if (!isDrilldownPrompt(raw)) {
    return baseGroups;
  }

  if (pathKey === 'WebApplication') {
    return appendIfMissing(['ClientIPs', 'IPAddress']);
  }
  if (pathKey === 'PageFamily') {
    return appendIfMissing(['ClientIPs', 'IPAddress']);
  }
  if (pathKey === 'BusinessGroup') {
    return appendIfMissing(['MemberIPs', 'IPAddress']);
  }
  if (pathKey === 'Prefix24') {
    return appendIfMissing(['MemberIPs', 'IPAddress']);
  }
  if (pathKey === 'IPAddress') {
    return appendIfMissing(['ConnectedIPs', 'ConnectedIP']);
  }

  if (lastType === 'ClientIPs') {
    return appendIfMissing(['IPAddress']);
  }
  if (lastType === 'ServerIPs') {
    return appendIfMissing(['IPAddress']);
  }
  if (lastType === 'MemberIPs') {
    return appendIfMissing(['IPAddress']);
  }
  if (lastType === 'ConnectedIPs') {
    return appendIfMissing(['IPAddress']);
  }
  if (lastType === 'IPConversations') {
    return appendIfMissing(['IPConversation']);
  }
  if (lastType === 'Applications') {
    return appendIfMissing(['DefinedApp']);
  }

  return baseGroups;
}

function shouldSkipStaticPathPlanning(query = {}, prompt = '') {
  if (query?.skipPathPlanning === true || query?.executionHints?.skipPathPlanning === true) {
    return true;
  }

  const service = String(query?.service || '').trim();
  if (!['topValues', 'averageValues', 'timeValues'].includes(service)) {
    return false;
  }

  const followUpAction = String(
    query?.pathPlanning?.followUpAction
    || query?.semanticConstraints?.followUpAction
    || query?.executionHints?.followUpAction
    || ''
  ).trim().toLowerCase();
  if (followUpAction === 'drilldown' || isDrilldownPrompt(prompt)) {
    return false;
  }

  const groups = cloneGroups(query?.groups);
  if (groups.length === 0) {
    return false;
  }

  const currentTerminalType = String(groups[groups.length - 1]?.type || '').trim();
  const targetType = String(
    query?.semanticConstraints?.targetObjectType
    || query?.resolutionHints?.group?.type
    || ''
  ).trim();
  if (targetType && currentTerminalType && targetType === currentTerminalType) {
    return true;
  }

  const metrics = Array.isArray(query?.metrics)
    ? query.metrics.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const primaryMetric = String(query?.metric || query?.topMetric || metrics[0] || '').trim().toUpperCase();
  const isPacketLossMetric = ['PLI', 'PLO'].includes(primaryMetric) || metrics.some((item) => ['PLI', 'PLO'].includes(item));
  return service === 'topValues'
    && currentTerminalType === 'IPAddress'
    && isPacketLossMetric;
}

function shouldAllowExecutionPathRepair(query = {}) {
  return Boolean(
    query?.executionOptions?.allowPathRepair === true
    || query?.executionHints?.allowPathRepair === true
    || query?.pathPlanning?.allowExecutionRepair === true
  );
}

function applyStaticPathPlanningIfNeeded(query = {}, prompt = '') {
  if (!shouldAllowExecutionPathRepair(query)) {
    return query;
  }

  if (shouldSkipStaticPathPlanning(query, prompt)) {
    return query;
  }

  const staticPathPlan = GroupPathPlannerService.planPath(query, prompt, {
    groups: query.groups
  });
  if (staticPathPlan?.plannedGroups?.length > 0) {
    query.groups = staticPathPlan.plannedGroups;
    query.pathPlanning = {
      ...(query.pathPlanning && typeof query.pathPlanning === 'object' ? query.pathPlanning : {}),
      ...staticPathPlan
    };
  }

  return query;
}

function applySessionContinuationToResolvedQuery(resolvedQuery = {}, prompt = '', session = null) {
  const query = normalizeResolvedQueryShape(resolvedQuery, prompt);
  const sessionState = normalizeSessionState(session);
  if (!hasUsableSessionContext(sessionState)) {
    applyStaticPathPlanningIfNeeded(query, prompt);
    return normalizeResolvedQueryShape(query, prompt);
  }

  const continuationInstruction = extractContinuationInstruction(query);
  const explicitGroups = cloneGroups(query.groups);
  const sessionGroups = cloneGroups(sessionState.last_groups);
  const shouldDrilldown = continuationInstruction.requestedAction === 'drilldown';

  if (continuationInstruction.plannedGroups.length > 0) {
    query.groups = continuationInstruction.plannedGroups;
  } else if (explicitGroups.length === 0 && sessionGroups.length > 0) {
    if (shouldDrilldown && shouldAllowExecutionPathRepair(query)) {
      query.groups = inferDrilldownPathFromPrompt(sessionGroups, prompt);
    } else if (continuationInstruction.inheritGroups) {
      query.groups = sessionGroups;
    }
  } else if (explicitGroups.length > 0 && shouldDrilldown && shouldAllowExecutionPathRepair(query)) {
    query.groups = inferDrilldownPathFromPrompt(explicitGroups, prompt);
  }

  if (continuationInstruction.inheritMetric && sessionState.last_metric) {
    query.metric = sessionState.last_metric;
  }
  if ((!Array.isArray(query.metrics) || query.metrics.length === 0) && query.metric) {
    query.metrics = [query.metric];
  }

  if (
    continuationInstruction.inheritTimeRange
    && sessionState.last_time_range?.start
    && sessionState.last_time_range?.end
  ) {
    query.start = sessionState.last_time_range.start;
    query.end = sessionState.last_time_range.end;
  }

  if (!query.userRequirement) {
    query.userRequirement = prompt || '';
  }

  applyStaticPathPlanningIfNeeded(query, prompt);

  return normalizeResolvedQueryShape(query, prompt);
}

function isMetricInventoryPrompt(prompt = '') {
  return PromptRoutingService.isMetricInventoryPrompt(prompt);
}

async function resolveInput(args, payload) {
  const prompt = String(
    args.prompt
    || payload?.prompt
    || payload?.query
    || payload?.userQuery
    || payload?.text
    || ''
  ).trim();

  const requestContext = {
    decision: parseJsonArg('--decision', args.decision) || payload?.decision || null,
    intent: parseJsonArg('--intent', args.intent) || payload?.intent || null,
    session: parseJsonArg('--session', args.session) || payload?.session || payload?.sessionState || null
  };

  if (isSensitiveCredentialPrompt(prompt)) {
    return {
      prompt,
      mappingResult: null,
      resolvedQuery: {
        service: 'security_refusal',
        userRequirement: prompt
      },
      intentResult: {
        objectType: 'IntentResult',
        userIntent: 'security_refusal',
        questionType: 'sensitive_credentials',
        service: 'security_refusal',
        scopeHint: null,
        preferOverviewFirst: false,
        stableTemplateId: null,
        candidateGeneration: null,
        metricDomainCandidates: [],
        confidence: 0.99
      },
      semanticResolutionResult: {
        objectType: 'SemanticResolutionResult',
        object: null,
        groupPath: [],
        metric: null,
        metrics: [],
        metricDomain: null,
        timeRange: {
          start: null,
          end: null
        },
        baseline: {
          type: 'none',
          timeRangeKey: null,
          start: null,
          end: null,
          compareTo: null
        },
        metricSemantic: null,
        objectSemantic: null,
        pathPlanning: null,
        stableTemplateId: null,
        confidence: 0.99,
        needsClarification: false
      },
      requestContext,
      payload,
      sensitiveCredentialRequest: true
    };
  }

  const explicitResolvedQuery = coerceJsonObject(args.queryJson)
    || parseJsonArg('--resolvedQuery', args.resolvedQuery)
    || payload?.resolvedQuery
    || null;

  if (explicitResolvedQuery) {
    const resolvedQuery = applySessionContinuationToResolvedQuery(
      explicitResolvedQuery,
      prompt,
      requestContext.session
    );
    return {
      prompt: prompt || String(resolvedQuery?.userRequirement || '').trim(),
      mappingResult: null,
      resolvedQuery,
      intentResult: RequirementParserService.buildIntentResult(resolvedQuery, prompt),
      semanticResolutionResult: RequirementParserService.buildSemanticResolutionResult(resolvedQuery),
      requestContext,
      payload
    };
  }

  const error = new Error('Structured resolvedQuery is required in upstream-execution mode; local prompt parsing is disabled.');
  error.code = 'UPSTREAM_RESOLVED_QUERY_REQUIRED';
  error.details = {
    acceptedInputs: ['--queryJson', '--resolvedQuery', 'payload.resolvedQuery'],
    promptReceived: Boolean(prompt),
    boundaryMode: getBoundaryMode()
  };
  throw error;
}

function buildClarificationContract(base = {}, gate = null) {
  const question = String(
    gate?.question
    || base?.resolvedQuery?.executionGuard?.message
    || '\u5f53\u524d\u4fe1\u606f\u8fd8\u4e0d\u591f\uff0c\u6211\u9700\u8981\u4f60\u518d\u660e\u786e\u4e00\u70b9\u3002'
  ).trim();
  const followUpActions = buildFollowUpActionsFromGate(gate);
  const summary = buildDecisionSummary('\u8fd8\u9700\u8981\u8865\u5145\u4e00\u70b9\u4fe1\u606f', question);

  return buildOpenClawReplyContract({
    ...base,
    ok: false,
    error: null,
    rows: [],
    summary,
    displayText: question,
    followUpActions,
    responseType: 'decision_result'
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText
  });
}

function buildSensitiveCredentialRefusalContract(base = {}) {
  const text = buildSensitiveCredentialRefusalText();
  const summary = buildDecisionSummary('\u654f\u611f\u4fe1\u606f\u4fdd\u62a4', text, 'SECURITY_REFUSAL');

  return buildOpenClawReplyContract({
    ...base,
    ok: false,
    error: {
      code: 'SENSITIVE_CREDENTIAL_REQUEST_BLOCKED',
      message: text
    },
    rows: [],
    summary,
    displayText: text,
    followUpActions: [],
    responseType: 'decision_result'
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText,
    includeRequestUrl: false
  });
}

function buildMissingResolvedQueryContract(base = {}) {
  const spec = getResolutionSpec();
  const text = [
    '\u5f53\u524d\u8fd9\u4e2a\u95ee\u9898\u8fd8\u6ca1\u6709\u5f62\u6210\u53ef\u6267\u884c\u7684 NAPM \u67e5\u8be2\u6761\u4ef6\u3002',
    '\u8bf7\u5148\u7531 OpenClaw \u4e3b\u94fe\u5b8c\u6210\u610f\u56fe\u5224\u5b9a\u3001\u8303\u56f4\u786e\u8ba4\u6216\u5fc5\u8981\u7684\u6f84\u6e05\u540e\uff0c\u518d\u4e0b\u53d1 structured resolvedQuery \u7ed9 NAPM skill \u6267\u884c\u3002'
  ].join('\n');
  const summary = buildDecisionSummary('\u8fd8\u9700\u8981 OpenClaw \u5148\u5b8c\u6210\u7406\u89e3', text, 'UPSTREAM_RESOLUTION_REQUIRED');

  return buildOpenClawReplyContract({
    ...base,
    ok: false,
    error: {
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      message: text
    },
    decision: {
      next_action: 'UPSTREAM_RESOLUTION_REQUIRED',
      boundaryMode: getBoundaryMode(),
      acceptedInputs: Array.isArray(spec?.queryContract?.acceptedInputs) ? spec.queryContract.acceptedInputs : []
    },
    rows: [],
    summary,
    displayText: text,
    followUpActions: [],
    responseType: 'decision_result'
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText,
    includeRequestUrl: false
  });
}

async function executeUnknownPortDualProtocolQuery(prompt, resolvedQuery) {
  const protocolQueries = Array.isArray(resolvedQuery?.protocolQueries)
    ? resolvedQuery.protocolQueries.filter((item) => item && typeof item === 'object')
    : [];

  if (protocolQueries.length === 0) {
    return {
      ok: false,
      service: 'topValues_multi_protocol',
      data: [],
      summary: buildSummary('topValues_multi_protocol', resolvedQuery, []),
      error: {
        code: 'UNKNOWN_PORT_PROTOCOL_QUERIES_MISSING',
        message: 'Unknown port traffic query is missing protocolQueries.'
      }
    };
  }

  const results = [];
  const warnings = [];
  for (const protocolQuery of protocolQueries) {
    const result = await RequirementParserService.executeGatewayRequest(protocolQuery);
    const protocol = String(protocolQuery?.groups?.find((group) => group?.type === 'IPProtocol')?.argument || '').trim() || 'UNKNOWN';
    results.push({
      protocol,
      query: protocolQuery,
      ok: Boolean(result?.ok),
      requestUrl: result?.requestUrl || null,
      data: Array.isArray(result?.data) ? result.data : [],
      error: result?.error || null,
      summary: result?.summary || buildSummary('topValues', protocolQuery, Array.isArray(result?.data) ? result.data : [])
    });
    if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
  }

  const mergedRows = results.flatMap((item) => {
    const rows = Array.isArray(item.data) ? item.data : [];
    return rows.map((row) => ({
      ...row,
      protocol: item.protocol
    }));
  });

  const protocolHighlights = results.map((item) => {
    const rowCount = Array.isArray(item.data) ? item.data.length : 0;
    return `${item.protocol} 结果数：${rowCount}`;
  });

  const summary = {
    ...buildSummary('topValues_multi_protocol', resolvedQuery, mergedRows),
    highlights: [
      ...(protocolHighlights || [])
    ]
  };

  return {
    ok: results.some((item) => item.ok),
    service: 'topValues_multi_protocol',
    data: mergedRows,
    requestUrl: results.map((item) => item.requestUrl).filter(Boolean).join('\n') || null,
    summary,
    warnings,
    protocolResults: results,
    error: results.some((item) => item.ok)
      ? null
      : {
          code: 'UNKNOWN_PORT_PROTOCOL_QUERIES_FAILED',
          message: 'All unknown port traffic protocol queries failed.'
        }
  };
}

async function executeResolvedQuery(prompt, resolvedQuery, payload, intentResult) {
  resolvedQuery = normalizeResolvedQueryShape(resolvedQuery, prompt);
  const traceId = normalizeTraceId(payload?.traceId || payload?.sessionState?.traceId);
  logSkillAudit('napm_skill_execution_started', {
    traceId: traceId || null,
    prompt,
    service: String(resolvedQuery?.service || '').trim() || null,
    resolvedQuery,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
    hasIntentResult: Boolean(intentResult)
  }, traceId);

  if (resolvedQuery?.service === 'topValues_multi_protocol') {
    const result = await executeUnknownPortDualProtocolQuery(prompt, resolvedQuery);
    logSkillAudit('napm_skill_execution_completed', {
      traceId: traceId || null,
      prompt,
      service: 'topValues_multi_protocol',
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      ok: Boolean(result?.ok),
      requestUrl: result?.requestUrl || null,
      rowCount: Array.isArray(result?.data) ? result.data.length : 0,
      responseType: 'multi_protocol'
    }, traceId);
    return result;
  }

  const isOverview = isOverviewResolvedQuery(resolvedQuery);
  const analysisPipeline = resolvedQuery?.analysisPipeline && typeof resolvedQuery.analysisPipeline === 'object'
    ? resolvedQuery.analysisPipeline
    : null;
  const hasDiscoveryStage = Boolean(analysisPipeline?.discoveryQuery);

  if (isOverview && hasDiscoveryStage) {
    const pipelineValidation = validateAnalysisPipelineContract(resolvedQuery);
    if (!pipelineValidation.ok) {
      return buildAnalysisDiscoveryFailureResult(
        resolvedQuery,
        analysisPipeline?.discoveryQuery || {},
        {},
        {
          code: pipelineValidation.code,
          message: pipelineValidation.message,
          stage: pipelineValidation.stage || 'analysisPipeline'
        }
      );
    }

    const discoveryQuery = buildDiscoveryQuery(resolvedQuery, prompt);
    if (!discoveryQuery) {
      return buildAnalysisDiscoveryFailureResult(resolvedQuery, {}, {});
    }
    const discoveryResult = await RequirementParserService.executeGatewayRequest(discoveryQuery);
    if (!discoveryResult?.ok) {
      return buildAnalysisDiscoveryFailureResult(
        resolvedQuery,
        discoveryQuery,
        discoveryResult,
        {
          code: discoveryResult?.error?.code || 'DISCOVERY_QUERY_FAILED',
          message: discoveryResult?.error?.message || 'discoveryQuery execution failed.',
          stage: 'discoveryQuery'
        }
      );
    }

    const focusSelection = deriveDiscoveryFocusSelection(analysisPipeline, discoveryQuery, discoveryResult);
    if (!focusSelection) {
      return buildAnalysisDiscoveryFailureResult(
        resolvedQuery,
        discoveryQuery,
        discoveryResult,
        {
          code: 'DISCOVERY_TARGET_NOT_FOUND',
          stage: 'discoveryQuery'
        }
      );
    }

    const focusedOverviewResolvedQuery = buildFocusedOverviewResolvedQuery(
      resolvedQuery,
      focusSelection,
      discoveryQuery
    );
    const overviewResult = await executeOverviewModule({
      prompt,
      payload,
      intent: intentResult,
      resolvedQuery: focusedOverviewResolvedQuery,
      executeGatewayRequest: RequirementParserService.executeGatewayRequest.bind(RequirementParserService)
    });

    const result = {
      ...overviewResult,
      resolvedQuery: focusedOverviewResolvedQuery,
      requestUrl: overviewResult?.requestUrl || discoveryResult?.requestUrl || null,
      responseType: DISCOVER_THEN_ANALYZE_RESPONSE_TYPE,
      legacyResponseType: 'overview_with_discovery',
      analysisType: focusedOverviewResolvedQuery.analysisType || 'comprehensive_analysis',
      analysisMode: focusedOverviewResolvedQuery.analysisMode || 'discover_then_analyze',
      analysisScene: focusedOverviewResolvedQuery.analysisScene || focusedOverviewResolvedQuery.overviewScene || null,
      discovery: {
        service: discoveryQuery.service,
        targetObjectType: focusSelection.type,
        selectedObject: focusSelection.value,
        rank: focusSelection.rank || 1,
        metric: focusSelection.metric || resolvePrimaryMetricId(discoveryQuery) || null,
        request: discoveryQuery,
        rowCount: Array.isArray(discoveryResult?.data) ? discoveryResult.data.length : 0
      },
      overview: overviewResult?.overview
        ? {
            ...overviewResult.overview,
            discovery: {
              service: discoveryQuery.service,
              targetObjectType: focusSelection.type,
              selectedObject: focusSelection.value,
              rank: focusSelection.rank || 1,
              metric: focusSelection.metric || resolvePrimaryMetricId(discoveryQuery) || null,
              request: discoveryQuery,
              rowCount: Array.isArray(discoveryResult?.data) ? discoveryResult.data.length : 0
            }
          }
        : overviewResult?.overview || null,
      warnings: [
        ...(Array.isArray(discoveryResult?.warnings) ? discoveryResult.warnings : []),
        ...(Array.isArray(overviewResult?.warnings) ? overviewResult.warnings : [])
      ]
    };
    logSkillAudit('napm_skill_execution_completed', {
      traceId: traceId || null,
      prompt,
      service: String(result?.service || focusedOverviewResolvedQuery?.service || '').trim() || null,
      resolvedQuery: focusedOverviewResolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(focusedOverviewResolvedQuery),
      ok: Boolean(result?.ok),
      requestUrl: result?.requestUrl || null,
      rowCount: Array.isArray(result?.data) ? result.data.length : 0,
      responseType: DISCOVER_THEN_ANALYZE_RESPONSE_TYPE,
      legacyResponseType: 'overview_with_discovery'
    }, traceId);
    return result;
  }

  if (isOverview) {
    const result = await executeOverviewModule({
      prompt,
      payload,
      intent: intentResult,
      resolvedQuery,
      executeGatewayRequest: RequirementParserService.executeGatewayRequest.bind(RequirementParserService)
    });
    logSkillAudit('napm_skill_execution_completed', {
      traceId: traceId || null,
      prompt,
      service: String(result?.service || resolvedQuery?.service || '').trim() || null,
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      ok: Boolean(result?.ok),
      requestUrl: result?.requestUrl || null,
      rowCount: Array.isArray(result?.data) ? result.data.length : 0,
      responseType: 'overview'
    }, traceId);
    return result;
  }

  const result = await RequirementParserService.executeGatewayRequest(resolvedQuery);
  logSkillAudit('napm_skill_execution_completed', {
    traceId: traceId || null,
    prompt,
    service: String(result?.service || resolvedQuery?.service || '').trim() || null,
    resolvedQuery,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
    ok: Boolean(result?.ok),
    requestUrl: result?.requestUrl || null,
    rowCount: Array.isArray(result?.data) ? result.data.length : 0,
    responseType: 'direct_query'
  }, traceId);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = parseJsonArg('--payload', args.payload) || {};
  const traceId = buildTraceIdFromPayload(payload, args);
  payload.traceId = traceId;
  const input = await resolveInput(args, payload);
  const prompt = input.prompt || '';
  const resolvedQuery = input.resolvedQuery || {};
  const mappingResult = input.mappingResult || null;
  const intentResult = input.intentResult || null;
  const semanticResolutionResult = input.semanticResolutionResult || null;
  const hierarchyCatalogPayload = input.hierarchyCatalogPayload
    || await buildHierarchyCatalogPayloadFromResolvedQuery(resolvedQuery)
    || null;
  const resolvedQuerySource = detectResolvedQuerySource(args, payload);

  logSkillAudit('napm_skill_resolved_query_received', {
    traceId,
    prompt,
    resolvedQuerySource,
    boundaryMode: getBoundaryMode(),
    resolvedQuery,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
    sessionPresent: Boolean(input?.requestContext?.session),
    sensitiveCredentialRequest: Boolean(input.sensitiveCredentialRequest)
  }, traceId);

  if (input.sensitiveCredentialRequest) {
    logSkillAudit('napm_skill_execution_completed', {
      traceId,
      prompt,
      service: 'security_refusal',
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      ok: true,
      responseType: 'security_refusal'
    }, traceId);
    const output = buildSensitiveCredentialRefusalContract({
      prompt,
      service: 'security_refusal',
      resolvedQuery,
      intentResult,
      semanticResolutionResult,
      supportedMetrics: MetricMappingService.getAllMetricCodes().length
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const clarificationGate = mappingResult?.clarificationGate || resolvedQuery?.clarificationGate || null;
  if (clarificationGate?.required) {
    logSkillAudit('napm_skill_execution_completed', {
      traceId,
      prompt,
      service: String(resolvedQuery?.service || '').trim() || null,
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      ok: true,
      responseType: 'clarification_required',
      clarificationQuestion: clarificationGate?.question || null
    }, traceId);
    const output = buildClarificationContract({
      prompt,
      service: resolvedQuery?.service || null,
      resolvedQuery,
      intentResult,
      semanticResolutionResult,
      assistantDecision: clarificationGate,
      supportedMetrics: MetricMappingService.getAllMetricCodes().length
    }, clarificationGate);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (resolvedQuery?.executionGuard?.blockExecution && !isOverviewResolvedQuery(resolvedQuery)) {
    logSkillAudit('napm_skill_execution_completed', {
      traceId,
      prompt,
      service: String(resolvedQuery?.service || '').trim() || null,
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      ok: true,
      responseType: 'execution_guard_blocked',
      guardMessage: resolvedQuery?.executionGuard?.message || null
    }, traceId);
    const output = buildClarificationContract({
      prompt,
      service: resolvedQuery?.service || null,
      resolvedQuery,
      intentResult,
      semanticResolutionResult,
      assistantDecision: resolvedQuery.executionGuard,
      supportedMetrics: MetricMappingService.getAllMetricCodes().length
    }, {
      question: resolvedQuery.executionGuard.message,
      options: (resolvedQuery.executionGuard.details?.suggestedCandidates || []).map((item) => ({
        label: item?.label || item?.value,
        value: item?.value || item?.label,
        replyText: item?.value || item?.label
      }))
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (resolvedQuery?.service === 'drilldownCatalog' && hierarchyCatalogPayload) {
    logSkillAudit('napm_skill_execution_completed', {
      traceId,
      prompt,
      service: 'drilldownCatalog',
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      ok: !hierarchyCatalogPayload?.notFound,
      responseType: 'drilldown_catalog',
      hierarchyTargetGroupType: hierarchyCatalogPayload?.targetGroupType || null
    }, traceId);
    const output = buildHierarchyCatalogContract(prompt, hierarchyCatalogPayload);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const executionResult = await executeResolvedQuery(prompt, resolvedQuery, payload, intentResult);
  const rows = Array.isArray(executionResult?.data) ? executionResult.data : [];
  const service = executionResult?.service || resolvedQuery?.service || null;
  const summary = executionResult?.summary || buildSummary(service, resolvedQuery, rows);
  const output = buildOpenClawReplyContract({
    ok: Boolean(executionResult?.ok),
    prompt,
    service,
    resolvedQuery,
    rows,
    data: rows,
    overview: executionResult?.overview || null,
    requestUrl: executionResult?.requestUrl || null,
    requestParamsJson: executionResult?.requestParams || null,
    metadata: executionResult?.metadata || null,
    rawApiResponse: args.raw ? executionResult?.rawApiResponse ?? null : undefined,
    summary,
    error: executionResult?.error || null,
    warnings: Array.isArray(executionResult?.warnings) ? executionResult.warnings : [],
    supportedMetrics: MetricMappingService.getAllMetricCodes().length,
    intentResult,
    semanticResolutionResult,
    assistantDecision: clarificationGate || null
  }, {
    forwardDisplayText: isOverviewResolvedQuery(resolvedQuery) ? true : SKILL_FORWARD_DISPLAY_TEXT,
    appendRequestUrlToDisplayText,
    defaultDisplayTextBuilder: buildDisplayText,
    includeRequestUrl: false
  });

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const isMissingResolvedQuery = error.code === 'UPSTREAM_RESOLVED_QUERY_REQUIRED';
    if (isMissingResolvedQuery) {
      logSkillAudit('napm_skill_missing_resolved_query', {
        traceId: null,
        error: {
          code: error.code || null,
          message: error.message
        },
        details: error.details || null
      }, null);
      const output = buildMissingResolvedQueryContract({
        prompt: null,
        service: null,
        resolvedQuery: null,
        rows: [],
        data: [],
        supportedMetrics: MetricMappingService.getAllMetricCodes().length
      });
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }

    logSkillAudit('napm_skill_execution_failed', {
      traceId: null,
      error: {
        code: error.code || 'SKILL_EXECUTION_ERROR',
        message: error.message
      }
    }, null);

    const failureClassification = ExecutionFailureClassifier.classify(error, {});
    const summary = buildDecisionSummary('Skill execution failed', failureClassification.userMessage, failureClassification.category);
    const output = buildOpenClawReplyContract({
      ok: false,
      service: null,
      resolvedQuery: null,
      rows: [],
      data: [],
      summary,
      error: {
        code: error.code || 'SKILL_EXECUTION_ERROR',
        message: error.message,
        failureClassification,
        userMessage: failureClassification.userMessage
      },
      responseType: 'decision_result',
      displayText: failureClassification.userMessage
    }, {
      forwardDisplayText: false,
      appendRequestUrlToDisplayText,
      includeRequestUrl: false
    });

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  });
}

/**
 * Plugin 通过 require() 同进程调用的入口。
 * params 已经是 JavaScript 对象（buildSkillPayload 的产出），
 * 包含 resolvedQuery, prompt, traceId, sessionState 等字段，
 * 无需 CLI 参数解析和 JSON 反序列化。
 *
 * 时间覆盖已由 before_tool_call Hook 完成，
 * 此函数只做 floorToMinute + 基础 shape 校验。
 */
async function handleSkillCall(params = {}) {
  try {
    const payload = params;
    const traceId = normalizeTraceId(payload.traceId) || buildTraceIdFromPayload(payload, {});
    payload.traceId = traceId;
    const input = await resolveInput({}, payload);
    const prompt = input.prompt || '';
    const resolvedQuery = input.resolvedQuery || {};
    const mappingResult = input.mappingResult || null;
    const intentResult = input.intentResult || null;
    const semanticResolutionResult = input.semanticResolutionResult || null;
    const hierarchyCatalogPayload = input.hierarchyCatalogPayload
      || await buildHierarchyCatalogPayloadFromResolvedQuery(resolvedQuery)
      || null;

    logSkillAudit('napm_skill_resolved_query_received', {
      traceId,
      prompt,
      resolvedQuerySource: detectResolvedQuerySource({}, payload),
      boundaryMode: getBoundaryMode(),
      resolvedQuery,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
      sessionPresent: Boolean(input?.requestContext?.session),
      sensitiveCredentialRequest: Boolean(input.sensitiveCredentialRequest),
    }, traceId);

    // Guard: sensitive credential request
    if (input.sensitiveCredentialRequest) {
      logSkillAudit('napm_skill_execution_completed', {
        traceId, prompt, service: 'security_refusal', resolvedQuery,
        resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
        ok: true, responseType: 'security_refusal',
      }, traceId);
      return buildSensitiveCredentialRefusalContract({
        prompt, service: 'security_refusal', resolvedQuery, intentResult, semanticResolutionResult,
        supportedMetrics: MetricMappingService.getAllMetricCodes().length,
      });
    }

    // Guard: clarification gate
    const clarificationGate = mappingResult?.clarificationGate || resolvedQuery?.clarificationGate || null;
    if (clarificationGate?.required) {
      logSkillAudit('napm_skill_execution_completed', {
        traceId, prompt, service: String(resolvedQuery?.service || '').trim() || null,
        resolvedQuery, resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
        ok: true, responseType: 'clarification_required',
        clarificationQuestion: clarificationGate?.question || null,
      }, traceId);
      return buildClarificationContract({
        prompt, service: resolvedQuery?.service || null, resolvedQuery, intentResult, semanticResolutionResult,
        assistantDecision: clarificationGate,
        supportedMetrics: MetricMappingService.getAllMetricCodes().length,
      }, clarificationGate);
    }

    // Guard: execution guard
    if (resolvedQuery?.executionGuard?.blockExecution && !isOverviewResolvedQuery(resolvedQuery)) {
      logSkillAudit('napm_skill_execution_completed', {
        traceId, prompt, service: String(resolvedQuery?.service || '').trim() || null,
        resolvedQuery, resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
        ok: true, responseType: 'execution_guard_blocked',
        guardMessage: resolvedQuery?.executionGuard?.message || null,
      }, traceId);
      return buildClarificationContract({
        prompt, service: resolvedQuery?.service || null, resolvedQuery, intentResult, semanticResolutionResult,
        assistantDecision: resolvedQuery.executionGuard,
        supportedMetrics: MetricMappingService.getAllMetricCodes().length,
      }, {
        question: resolvedQuery.executionGuard.message,
        options: (resolvedQuery.executionGuard.details?.suggestedCandidates || []).map((item) => ({
          label: item?.label || item?.value,
          value: item?.value || item?.label,
          replyText: item?.value || item?.label,
        })),
      });
    }

    // Guard: drilldown catalog
    if (resolvedQuery?.service === 'drilldownCatalog' && hierarchyCatalogPayload) {
      logSkillAudit('napm_skill_execution_completed', {
        traceId, prompt, service: 'drilldownCatalog', resolvedQuery,
        resolvedQuerySummary: summarizeResolvedQueryForAudit(resolvedQuery),
        ok: !hierarchyCatalogPayload?.notFound,
        responseType: 'drilldown_catalog',
        hierarchyTargetGroupType: hierarchyCatalogPayload?.targetGroupType || null,
      }, traceId);
      return buildHierarchyCatalogContract(prompt, hierarchyCatalogPayload);
    }

    // Main execution path
    const executionResult = await executeResolvedQuery(prompt, resolvedQuery, payload, intentResult);
    const rows = Array.isArray(executionResult?.data) ? executionResult.data : [];
    const service = executionResult?.service || resolvedQuery?.service || null;
    const summary = executionResult?.summary || buildSummary(service, resolvedQuery, rows);
    const output = buildOpenClawReplyContract({
      ok: Boolean(executionResult?.ok),
      prompt, service, resolvedQuery, rows, data: rows,
      overview: executionResult?.overview || null,
      requestUrl: executionResult?.requestUrl || null,
      requestParamsJson: executionResult?.requestParams || null,
      metadata: executionResult?.metadata || null,
      rawApiResponse: undefined,
      summary,
      error: executionResult?.error || null,
      warnings: Array.isArray(executionResult?.warnings) ? executionResult.warnings : [],
      supportedMetrics: MetricMappingService.getAllMetricCodes().length,
      intentResult, semanticResolutionResult,
      assistantDecision: clarificationGate || null,
    }, {
      forwardDisplayText: isOverviewResolvedQuery(resolvedQuery) ? true : SKILL_FORWARD_DISPLAY_TEXT,
      appendRequestUrlToDisplayText,
      defaultDisplayTextBuilder: buildDisplayText,
      includeRequestUrl: false,
    });

    return output;
  } catch (error) {
    const isMissingResolvedQuery = error.code === 'UPSTREAM_RESOLVED_QUERY_REQUIRED';
    if (isMissingResolvedQuery) {
      logSkillAudit('napm_skill_missing_resolved_query', {
        traceId: null,
        error: { code: error.code || null, message: error.message },
        details: error.details || null,
      }, null);
      return buildMissingResolvedQueryContract({
        prompt: null, service: null, resolvedQuery: null,
        rows: [], data: [],
        supportedMetrics: MetricMappingService.getAllMetricCodes().length,
      });
    }

    logSkillAudit('napm_skill_execution_failed', {
      traceId: null,
      error: { code: error.code || 'SKILL_EXECUTION_ERROR', message: error.message },
    }, null);

    const failureClassification = ExecutionFailureClassifier.classify(error, {});
    const summary = buildDecisionSummary('Skill execution failed', failureClassification.userMessage, failureClassification.category);
    return buildOpenClawReplyContract({
      ok: false, service: null, resolvedQuery: null, rows: [], data: [], summary,
      error: {
        code: error.code || 'SKILL_EXECUTION_ERROR',
        message: error.message,
        failureClassification,
        userMessage: failureClassification.userMessage,
      },
      responseType: 'decision_result',
      displayText: failureClassification.userMessage,
    }, {
      forwardDisplayText: false,
      appendRequestUrlToDisplayText,
      includeRequestUrl: false,
    });
  }
}

module.exports = {
  handleSkillCall,
  __test__: {
    getBoundaryMode,
    isStrictBoundaryMode,
    getResolutionSpec,
    floorToMinute,
    normalizeResolvedQueryTimeRange,
    hasExplicitRankingMetricInText,
    normalizeResolvedQueryShape,
    buildSummary,
    normalizeSessionState,
    extractContinuationInstruction,
    isDrilldownPrompt,
    inferDrilldownPathFromPrompt,
    applySessionContinuationToResolvedQuery,
    isMetricInventoryPrompt,
    isHierarchyCatalogPrompt,
    normalizeDrilldownQuestionTarget,
    buildDrilldownCatalogDisplayText,
    buildHierarchyCatalogPayloadFromResolvedQuery,
    resolveInput,
    buildFocusedOverviewResolvedQuery,
    deriveDiscoveryFocusSelection,
    executeUnknownPortDualProtocolQuery,
    executeResolvedQuery
  }
};
