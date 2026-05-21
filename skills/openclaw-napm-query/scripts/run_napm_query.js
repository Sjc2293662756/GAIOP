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
const { executeOverviewModule, extractTopGroupValues } = require(path.join(__dirname, 'overview-module'));
const TimeUtils = require(path.join(workspaceRoot, 'src/utils/TimeUtils'));
const { isBusinessObjectType } = require(path.join(workspaceRoot, 'src/constants/objectMetricOwnership'));
const { buildSafeUrl } = require(path.join(workspaceRoot, 'src/utils/auditLogger'));

const SKILL_FORWARD_DISPLAY_TEXT = ['1', 'true', 'yes', 'on'].includes(String(process.env.SKILL_FORWARD_DISPLAY_TEXT || '').trim().toLowerCase());

function getBoundaryMode() {
  return ResolutionSpecService.getBoundaryMode('compat');
}

function isStrictBoundaryMode() {
  return ResolutionSpecService.isStrictBoundaryMode('compat');
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
    } else if (arg === '--query') {
      args.query = argv[index + 1];
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
  const metric = resolvedQuery?.metric || (Array.isArray(resolvedQuery?.metrics) ? resolvedQuery.metrics.join(',') : '');
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
        metric ? `查询指标：${metric}` : null,
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
        metric ? `\u67e5\u8be2\u6307\u6807\uff1a${metric}` : null,
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
        metric ? `\u6307\u6807\uff1a${metric}` : null,
        topMetric ? `\u6392\u5e8f\u6307\u6807\uff1a${topMetric}` : null,
        groupPath ? `\u5bf9\u8c61\u8303\u56f4\uff1a${groupPath}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: false,
      metrics: metric ? [metric] : [],
      topMetric: topMetric || null
    };
  }

  if (service === 'timeValues') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '\u8d8b\u52bf\u7ed3\u679c',
      highlights: [
        metric ? `\u6307\u6807\uff1a${metric}` : null,
        groupPath ? `\u5bf9\u8c61\u8303\u56f4\uff1a${groupPath}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: false,
      metrics: metric ? [metric] : []
    };
  }

  return {
    mode: extra.mode || 'GO_DIRECT_QUERY',
    title: '\u67e5\u8be2\u7ed3\u679c',
    highlights: [
      metric ? `\u6307\u6807\uff1a${metric}` : null,
      groupPath ? `\u5bf9\u8c61\u8303\u56f4\uff1a${groupPath}` : null
    ].filter(Boolean),
    rowCount: rows.length,
    empty: false,
    metrics: metric ? [metric] : []
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

  const query = normalizeResolvedQueryShape(discoverySeed, prompt);
  if (!hasExplicitTimeRange(query) && hasExplicitTimeRange(baseResolvedQuery)) {
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
  return query;
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
    || inferOverviewSceneFromObjectType(focusSelection.type)
    || inferOverviewSceneFromObjectType(discoveryQuery?.groups?.[0]?.type)
    || 'system';

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

function buildAnalysisDiscoveryFailureResult(baseResolvedQuery = {}, discoveryQuery = {}, discoveryResult = {}) {
  const targetObjectType = inferDiscoveryTargetObjectType(baseResolvedQuery?.analysisPipeline, discoveryQuery) || '目标对象';
  const metricId = resolvePrimaryMetricId(discoveryQuery);
  const text = [
    `当前先按 ${metricId || '指定指标'} 尝试定位可分析的 ${targetObjectType}，但在本次查询结果里没有锁定到明确对象。`,
    '可以先缩小时间范围，或直接指定要分析的对象后再继续综合分析。'
  ].join('\n');
  return {
    ok: false,
    service: 'overview',
    data: [],
    summary: buildDecisionSummary('未锁定可分析对象', text, 'DISCOVERY_TARGET_NOT_FOUND'),
    error: {
      code: 'DISCOVERY_TARGET_NOT_FOUND',
      message: text
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

function isMetadataBusinessInventory(resolvedQuery = {}) {
  const service = String(resolvedQuery?.service || '').trim();
  const firstGroupType = String(resolvedQuery?.groups?.[0]?.type || '').trim();
  const operation = String(
    resolvedQuery?.semanticConstraints?.operation
    || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
    || ''
  ).trim();

  return service === 'groups'
    && isBusinessObjectType(firstGroupType)
    && operation === 'metadata_list';
}

function isNoiseWebApplicationLabel(label = '') {
  const raw = String(label || '').trim();
  if (!raw) {
    return true;
  }
  return /^(?:Other Group|Other Web Application)$/i.test(raw);
}

function isProtocolStyleWebApplicationLabel(label = '') {
  const raw = String(label || '').trim();
  if (!raw) {
    return true;
  }
  if (/[\u4e00-\u9fa5]/.test(raw)) {
    return false;
  }
  if (/[a-z]/.test(raw)) {
    return false;
  }

  const normalized = raw.toUpperCase();
  const exactProtocolLabels = new Set([
    'AIM-TCP', 'AIM-UDP', 'DNS', 'HTTP', 'HTTPS', 'ICMP', 'IMAP', 'POP3', 'SMTP', 'SSH', 'TELNET',
    'FTP-CONTROL', 'FTP-DATA', 'MSSQL-TCP', 'MSSQL-UDP', 'RTCP'
  ]);
  if (exactProtocolLabels.has(normalized)) {
    return true;
  }

  if (
    /^(?:MS-|SAP-|ORACLE-|SUN-RPC|NETBIOS|SQL\*NET|RTP|RTSP|SIP|H323|FTP|SMTP|SSH|DNS|HTTP|HTTPS|ICMP|TELNET|IMAP|POP3|MSSQL|VMWARE-SRV|MS-WBT-SRV|KAZAA|GNUTELLA|RBT-WANOPT)/.test(normalized)
  ) {
    return true;
  }

  return /^(?:[A-Z0-9*]+(?:[-_][A-Z0-9*]+){0,8})$/.test(normalized);
}

function filterBusinessSystemRows(rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  const filtered = items.filter((item) => {
    const label = String(item?.label || item?.Label || item?.value || item?.name || '').trim();
    if (isNoiseWebApplicationLabel(label)) {
      return false;
    }
    if (isProtocolStyleWebApplicationLabel(label)) {
      return false;
    }
    return true;
  });

  return filtered.length > 0 ? filtered : items;
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

  return query;
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
        start: Number(session.last_time_range.start) || null,
        end: Number(session.last_time_range.end) || null
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

function applyStaticPathPlanningIfNeeded(query = {}, prompt = '') {
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
    return query;
  }

  const continuationInstruction = extractContinuationInstruction(query);
  const explicitGroups = cloneGroups(query.groups);
  const sessionGroups = cloneGroups(sessionState.last_groups);
  const shouldDrilldown = continuationInstruction.requestedAction === 'drilldown'
    || isDrilldownPrompt(prompt);

  if (continuationInstruction.plannedGroups.length > 0) {
    query.groups = continuationInstruction.plannedGroups;
  } else if (explicitGroups.length === 0 && sessionGroups.length > 0) {
    query.groups = shouldDrilldown
      ? inferDrilldownPathFromPrompt(sessionGroups, prompt)
      : sessionGroups;
  } else if (explicitGroups.length > 0 && shouldDrilldown) {
    query.groups = inferDrilldownPathFromPrompt(explicitGroups, prompt);
  } else if (continuationInstruction.inheritGroups && explicitGroups.length === 0 && sessionGroups.length > 0) {
    query.groups = sessionGroups;
  }

  if ((!query.metric && sessionState.last_metric) || continuationInstruction.inheritMetric) {
    query.metric = sessionState.last_metric;
  }
  if ((!Array.isArray(query.metrics) || query.metrics.length === 0) && query.metric) {
    query.metrics = [query.metric];
  }

  if (
    (!hasExplicitTimeRange(query) || continuationInstruction.inheritTimeRange)
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

function inferPromptFallbackOverviewScene(prompt = '') {
  const text = String(prompt || '').trim();
  if (isUnknownPortTrafficPrompt(text)) {
    return 'security';
  }
  return PromptRoutingService.inferOverviewScene(text);
}

function inferPromptFallbackTimeRangeKey(prompt = '') {
  return PromptRoutingService.inferOverviewTimeRangeKey(prompt);
}

function isUnknownPortTrafficPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasUnknownTarget = /(未知|其它|其他).{0,8}(tcp|udp)?.{0,8}(端口|应用)|\bother\s*app\b|\botherapp\b/i.test(text);
  const hasTrafficIntent = /(流量|吞吐|吞吐量|带宽|throughput|bandwidth)/i.test(text);
  return hasUnknownTarget && hasTrafficIntent;
}

function detectUnknownPortProtocol(prompt = '') {
  const text = String(prompt || '').trim();
  if (!isUnknownPortTrafficPrompt(text)) {
    return null;
  }

  const hasTcp = /(^|[^A-Za-z])(tcp)([^A-Za-z]|$)/i.test(text);
  const hasUdp = /(^|[^A-Za-z])(udp)([^A-Za-z]|$)/i.test(text);
  if (hasTcp && !hasUdp) {
    return 'TCP';
  }
  if (hasUdp && !hasTcp) {
    return 'UDP';
  }
  return null;
}

function buildPromptFallbackUnknownPortResolvedQuery(prompt = '') {
  const text = String(prompt || '').trim();
  const protocol = detectUnknownPortProtocol(text);
  if (!protocol) {
    return null;
  }

  if (/(趋势|变化|走势|曲线|按时间|trend|timevalues|平均|avg|average|概览|总览|整体|overview)/i.test(text)) {
    return null;
  }

  const timeRangeKey = inferPromptFallbackTimeRangeKey(text);
  const range = TimeUtils.parseTimeRange(timeRangeKey);

  return normalizeResolvedQueryShape({
    service: 'topValues',
    queryModeKey: 'topn',
    semanticConstraints: {
      operation: 'topn',
      targetObjectType: 'OtherApp',
      scopeHints: ['unknown_port_traffic', protocol],
      overviewScene: 'security'
    },
    start: Math.floor(Number(range.start || 0) / 60) * 60,
    end: Math.floor(Number(range.end || 0) / 60) * 60,
    metric: 'TPIO',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 10,
    groups: [
      { type: 'TotalTraffic' },
      { type: 'IPProtocol', argument: protocol },
      { type: 'OtherApps' },
      { type: 'OtherApp' }
    ],
    format: 'json',
    userRequirement: text
  }, text);
}

function buildPromptFallbackUnknownPortDualProtocolResolvedQuery(prompt = '') {
  const text = String(prompt || '').trim();
  if (!isUnknownPortTrafficPrompt(text)) {
    return null;
  }

  if (detectUnknownPortProtocol(text)) {
    return null;
  }

  if (/(趋势|变化|走势|曲线|按时间|trend|timevalues|平均|avg|average|概览|总览|整体|overview)/i.test(text)) {
    return null;
  }

  const timeRangeKey = inferPromptFallbackTimeRangeKey(text);
  const range = TimeUtils.parseTimeRange(timeRangeKey);
  const start = Math.floor(Number(range.start || 0) / 60) * 60;
  const end = Math.floor(Number(range.end || 0) / 60) * 60;

  const buildProtocolQuery = (protocol) => ({
    service: 'topValues',
    queryModeKey: 'topn',
    semanticConstraints: {
      operation: 'topn',
      targetObjectType: 'OtherApp',
      scopeHints: ['unknown_port_traffic', protocol],
      overviewScene: 'security'
    },
    start,
    end,
    metric: 'TPIO',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 10,
    groups: [
      { type: 'TotalTraffic' },
      { type: 'IPProtocol', argument: protocol },
      { type: 'OtherApps' },
      { type: 'OtherApp' }
    ],
    format: 'json',
    userRequirement: text
  });

  return normalizeResolvedQueryShape({
    service: 'topValues_multi_protocol',
    queryModeKey: 'topn',
    semanticConstraints: {
      operation: 'topn',
      targetObjectType: 'OtherApp',
      scopeHints: ['unknown_port_traffic', 'TCP', 'UDP'],
      overviewScene: 'security'
    },
    start,
    end,
    metric: 'TPIO',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 10,
    format: 'json',
    userRequirement: text,
    protocolQueries: [
      buildProtocolQuery('TCP'),
      buildProtocolQuery('UDP')
    ]
  }, text);
}

function isMetricInventoryPrompt(prompt = '') {
  return PromptRoutingService.isMetricInventoryPrompt(prompt);
}

function inferPromptFallbackMetricInventoryGroup(prompt = '') {
  return PromptRoutingService.inferMetricInventoryGroup(prompt) || null;
}

function buildPromptFallbackMetricInventoryResolvedQuery(prompt = '') {
  const route = PromptRoutingService.buildMetricInventoryRoute(prompt);
  return materializePromptRouteResolvedQuery(route);
}

function materializePromptRouteResolvedQuery(route = null) {
  return PromptRoutingService.materializePromptRouteResolvedQuery(route, {
    resolveTimeRange: (timeRangeKey) => TimeUtils.parseTimeRange(timeRangeKey),
    roundTimeValue: (value) => Math.floor(Number(value || 0) / 60) * 60,
    normalizeResolvedQueryShape
  });
}

function isPromptFallbackBusinessObjectInventoryPrompt(prompt = '') {
  return PromptRoutingService.isBusinessObjectInventoryPrompt(prompt);
}

function buildPromptFallbackBusinessObjectInventoryResolvedQuery(prompt = '') {
  const route = PromptRoutingService.buildBusinessObjectInventoryRoute(prompt);
  return materializePromptRouteResolvedQuery(route);
}

function isPromptFallbackPacketLossClientTopPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasLoss = /(丢包|丢包率|packet\s*loss|loss)/i.test(text);
  const hasRanking = /(最多|最高|最大|排行|排名|top|谁|哪个)/i.test(text);
  const hasAddressScope = /(客户端|client|地址|\bip\b|ip地址|远端|对端)/i.test(text);

  return hasLoss && hasRanking && hasAddressScope;
}

function buildPromptFallbackPacketLossClientTopResolvedQuery(prompt = '') {
  const text = String(prompt || '').trim();
  if (!isPromptFallbackPacketLossClientTopPrompt(text)) {
    return null;
  }

  const metric = /(流出|出向|outbound|uplink)/i.test(text) ? 'PLO' : 'PLI';
  const timeRangeKey = inferPromptFallbackTimeRangeKey(text);
  const range = TimeUtils.parseTimeRange(timeRangeKey);

  return normalizeResolvedQueryShape({
    service: 'topValues',
    queryModeKey: 'topn',
    semanticConstraints: {
      operation: 'topn',
      targetObjectType: 'IPAddress',
      metricDomain: 'loss'
    },
    start: Math.floor(Number(range.start || 0) / 60) * 60,
    end: Math.floor(Number(range.end || 0) / 60) * 60,
    metric,
    metrics: [metric],
    topMetric: metric,
    topCount: 1,
    groups: [{ type: 'IPAddress' }],
    format: 'json',
    userRequirement: text
  }, text);
}

function looksLikePromptOnlyOverview(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasOverviewIntent = /(整体|总体|概览|总览|overall|overview|global|怎么样|情况|状态)/i.test(text);
  const hasNapmDomain = /(napm|netinside|系统|网络|应用|业务|web应用|网站|页面|流量|吞吐|时延|响应|异常|告警|丢包|重传|性能|监控)/i.test(text);
  return hasOverviewIntent && hasNapmDomain;
}

function buildPromptFallbackResolvedQuery(prompt = '') {
  const metricInventoryResolvedQuery = buildPromptFallbackMetricInventoryResolvedQuery(prompt);
  if (metricInventoryResolvedQuery) {
    return metricInventoryResolvedQuery;
  }

  const businessObjectInventoryResolvedQuery = buildPromptFallbackBusinessObjectInventoryResolvedQuery(prompt);
  if (businessObjectInventoryResolvedQuery) {
    return businessObjectInventoryResolvedQuery;
  }

  const packetLossClientTopResolvedQuery = buildPromptFallbackPacketLossClientTopResolvedQuery(prompt);
  if (packetLossClientTopResolvedQuery) {
    return packetLossClientTopResolvedQuery;
  }

  const unknownPortResolvedQuery = buildPromptFallbackUnknownPortResolvedQuery(prompt);
  if (unknownPortResolvedQuery) {
    return unknownPortResolvedQuery;
  }

  const unknownPortDualProtocolResolvedQuery = buildPromptFallbackUnknownPortDualProtocolResolvedQuery(prompt);
  if (unknownPortDualProtocolResolvedQuery) {
    return unknownPortDualProtocolResolvedQuery;
  }

  if (!looksLikePromptOnlyOverview(prompt)) {
    return null;
  }

  const timeRangeKey = inferPromptFallbackTimeRangeKey(prompt);
  const range = TimeUtils.parseTimeRange(timeRangeKey);
  const scene = inferPromptFallbackOverviewScene(prompt);

  return normalizeResolvedQueryShape({
    service: 'overview',
    queryModeKey: 'overview',
    overviewScene: scene,
    semanticConstraints: {
      operation: 'overview',
      overviewScene: scene
    },
    start: Math.floor(Number(range.start || 0) / 60) * 60,
    end: Math.floor(Number(range.end || 0) / 60) * 60,
    groups: [],
    format: 'json',
    userRequirement: prompt
  }, prompt);
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

  const explicitResolvedQuery = coerceJsonObject(args.query)
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

  if (!isStrictBoundaryMode()) {
    const promptFallbackResolvedQuery = buildPromptFallbackResolvedQuery(prompt);
    if (promptFallbackResolvedQuery) {
      const resolvedQuery = applySessionContinuationToResolvedQuery(
        promptFallbackResolvedQuery,
        prompt,
        requestContext.session
      );
      return {
        prompt,
        mappingResult: null,
        resolvedQuery,
        intentResult: RequirementParserService.buildIntentResult(resolvedQuery, prompt),
        semanticResolutionResult: RequirementParserService.buildSemanticResolutionResult(resolvedQuery),
        requestContext,
        payload
      };
    }

    const hierarchyCatalogPayload = await buildHierarchyCatalogPayload(prompt);
    if (hierarchyCatalogPayload) {
      return {
        prompt,
        mappingResult: null,
        resolvedQuery: {
          service: 'drilldownCatalog',
          userRequirement: prompt,
          groups: hierarchyCatalogPayload?.targetGroupType
            ? [{ type: hierarchyCatalogPayload.targetGroupType, argument: null }]
            : []
        },
        intentResult: {
          objectType: 'IntentResult',
          userIntent: 'metadata',
          questionType: 'drilldown_hierarchy',
          service: 'drilldownCatalog',
          scopeHint: hierarchyCatalogPayload?.targetGroupType || 'all_top_level_groups',
          preferOverviewFirst: false,
          stableTemplateId: null,
          candidateGeneration: null,
          metricDomainCandidates: [],
          confidence: 0.95
        },
        semanticResolutionResult: {
          objectType: 'SemanticResolutionResult',
          object: hierarchyCatalogPayload?.targetGroupType
            ? { type: hierarchyCatalogPayload.targetGroupType, value: null }
            : null,
          groupPath: hierarchyCatalogPayload?.targetGroupType ? [hierarchyCatalogPayload.targetGroupType] : [],
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
          objectSemantic: 'drilldown_hierarchy',
          pathPlanning: null,
          stableTemplateId: null,
          confidence: 0.95,
          needsClarification: false
        },
        hierarchyCatalogPayload,
        requestContext,
        payload
      };
    }
  }

  const error = new Error('Structured resolvedQuery is required in upstream-execution mode; local prompt parsing is disabled.');
  error.code = 'UPSTREAM_RESOLVED_QUERY_REQUIRED';
  error.details = {
    acceptedInputs: ['--query', '--resolvedQuery', '--payload.resolvedQuery'],
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
  if (resolvedQuery?.service === 'topValues_multi_protocol') {
    return executeUnknownPortDualProtocolQuery(prompt, resolvedQuery);
  }

  const isOverview = isOverviewResolvedQuery(resolvedQuery);
  const analysisPipeline = resolvedQuery?.analysisPipeline && typeof resolvedQuery.analysisPipeline === 'object'
    ? resolvedQuery.analysisPipeline
    : null;
  const hasDiscoveryStage = Boolean(analysisPipeline?.discoveryQuery);

  if (isOverview && hasDiscoveryStage) {
    const discoveryQuery = buildDiscoveryQuery(resolvedQuery, prompt);
    if (!discoveryQuery) {
      return buildAnalysisDiscoveryFailureResult(resolvedQuery, {}, {});
    }
    const discoveryResult = await RequirementParserService.executeGatewayRequest(discoveryQuery);
    const focusSelection = deriveDiscoveryFocusSelection(analysisPipeline, discoveryQuery, discoveryResult);
    if (!focusSelection) {
      return buildAnalysisDiscoveryFailureResult(resolvedQuery, discoveryQuery, discoveryResult);
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

    return {
      ...overviewResult,
      resolvedQuery: focusedOverviewResolvedQuery,
      requestUrl: overviewResult?.requestUrl || discoveryResult?.requestUrl || null,
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
  }

  if (isOverview) {
    return executeOverviewModule({
      prompt,
      payload,
      intent: intentResult,
      resolvedQuery,
      executeGatewayRequest: RequirementParserService.executeGatewayRequest.bind(RequirementParserService)
    });
  }

  return RequirementParserService.executeGatewayRequest(resolvedQuery);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = parseJsonArg('--payload', args.payload) || {};
  const input = await resolveInput(args, payload);
  const prompt = input.prompt || '';
  const resolvedQuery = input.resolvedQuery || {};
  const mappingResult = input.mappingResult || null;
  const intentResult = input.intentResult || null;
  const semanticResolutionResult = input.semanticResolutionResult || null;
  const hierarchyCatalogPayload = input.hierarchyCatalogPayload || null;

  if (input.sensitiveCredentialRequest) {
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
    const output = buildHierarchyCatalogContract(prompt, hierarchyCatalogPayload);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const executionResult = await executeResolvedQuery(prompt, resolvedQuery, payload, intentResult);
  const rawRows = Array.isArray(executionResult?.data) ? executionResult.data : [];
  const rows = isMetadataBusinessInventory(resolvedQuery)
    ? filterBusinessSystemRows(rawRows)
    : rawRows;
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

    const summary = buildDecisionSummary('Skill execution failed', error.message, 'FAILED');
    const output = buildOpenClawReplyContract({
      ok: false,
      service: null,
      resolvedQuery: null,
      rows: [],
      data: [],
      summary,
      error: {
        code: error.code || 'SKILL_EXECUTION_ERROR',
        message: error.message
      },
      responseType: 'decision_result',
      displayText: error.message
    }, {
      forwardDisplayText: true,
      appendRequestUrlToDisplayText,
      includeRequestUrl: false
    });

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  __test__: {
    getBoundaryMode,
    isStrictBoundaryMode,
    getResolutionSpec,
    hasExplicitRankingMetricInText,
    normalizeResolvedQueryShape,
    normalizeSessionState,
    extractContinuationInstruction,
    isDrilldownPrompt,
    inferDrilldownPathFromPrompt,
    applySessionContinuationToResolvedQuery,
    isUnknownPortTrafficPrompt,
    detectUnknownPortProtocol,
    buildPromptFallbackResolvedQuery,
    buildPromptFallbackUnknownPortResolvedQuery,
    buildPromptFallbackUnknownPortDualProtocolResolvedQuery,
    buildPromptFallbackMetricInventoryResolvedQuery,
    buildPromptFallbackBusinessObjectInventoryResolvedQuery,
    isPromptFallbackPacketLossClientTopPrompt,
    buildPromptFallbackPacketLossClientTopResolvedQuery,
    inferPromptFallbackMetricInventoryGroup,
    isPromptFallbackBusinessObjectInventoryPrompt,
    isMetricInventoryPrompt,
    isHierarchyCatalogPrompt,
    normalizeDrilldownQuestionTarget,
    buildDrilldownCatalogDisplayText,
    resolveInput,
    buildFocusedOverviewResolvedQuery,
    deriveDiscoveryFocusSelection,
    executeUnknownPortDualProtocolQuery,
    executeResolvedQuery
  }
};
