const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const NAPM_DIRECT_SKILL_MODE = true;
const NAPM_SKILL_EXECUTOR = process.env.NAPM_SKILL_EXECUTOR || '/opt/NAPM_Semantic_Gateway/skills/openclaw-napm-query/scripts/run_napm_query.js';
const napmGuardState = new Map();
const napmConversationState = new Map();
const napmDebugApiByPrompt = new Map();
const napmResultByPrompt = new Map();
let latestNapmDebugApi = null;
let latestNapmResult = null;
let cachedGroupPathPlannerService = null;
let groupPathPlannerLookupComplete = false;
let cachedPromptRoutingService = null;
let promptRoutingLookupComplete = false;
let cachedResolutionSpecService = null;
let resolutionSpecLookupComplete = false;
let skillDotenvLoaded = false;
const RESULT_CACHE_MAX_AGE_MS = 90 * 1000;
const AUDIT_LOG_PATH = process.env.NAPM_AUDIT_LOG_PATH || '/home/netinside/.openclaw/logs/audit.log';
const SAFE_NAPM_TOOL_NAMES = new Set([
  'napm-skill-query',
  'napm-topn',
  'napm-average',
  'napm-timeseries'
]);
const DIRECT_TOOL_FORWARD_MARKER = '__napmForwardToSkill';
const DIRECT_TOOL_FORWARD_PROMPT = '__napmForwardPrompt';
const DIRECT_TOOL_FORWARD_REASON = '__napmForwardReason';
const NAPM_OBJECT_PATTERNS = [
  /napm/i,
  /netinside/i,
  /239web/i,
  /\bhis\b/i,
  /\u89c2\u67a2/,
  /\u667a\u7ef4/
];
const NAPM_DOMAIN_PATTERNS = [
  /\u7cfb\u7edf/,
  /\u7f51\u7edc/,
  /\u5e94\u7528/,
  /\u4e1a\u52a1/,
  /web\s*application/i,
  /webapp/i,
  /\u7f51\u7ad9/,
  /\u9875\u9762/,
  /\u6d41\u91cf/,
  /\u541e\u5410/,
  /\u54cd\u5e94/,
  /\u65f6\u5ef6/,
  /\u5ef6\u8fdf/,
  /\u5f02\u5e38/,
  /\u544a\u8b66/,
  /\u4e22\u5305/,
  /\u91cd\u4f20/,
  /\u6027\u80fd/,
  /\u76d1\u63a7/,
  /http/i,
  /[45]xx/i
];
const SYSTEM_DOMAIN_HINT_PATTERNS = [
  /\u670d\u52a1/,
  /\u7ed3\u679c/,
  /\u5206\u6790/,
  /\u6392\u67e5/,
  /\u8d8b\u52bf/,
  /\u6392\u884c/,
  /\u6392\u540d/,
  /\u60c5\u51b5/,
  /\u72b6\u6001/
];

const fetchImpl = (...args) => {
  if (typeof fetch === 'function') {
    return fetch(...args);
  }
  return import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
};

function getBaseUrl(api) {
  const baseUrl =
    api?.config?.gatewayBaseUrl ||
    process.env.NAPM_GATEWAY_BASE_URL ||
    NAPM_GATEWAY_BASE_URL;
  return String(baseUrl).replace(/\/+$/, '');
}

async function postJson(url, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePrompt(args = {}) {
  const prompt = args.prompt || args.userQuery || args.query || '';
  return typeof prompt === 'string' ? prompt.trim() : '';
}

function extractTextContent(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextContent(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!isPlainObject(value)) {
    return '';
  }

  if (value.type === 'text' && typeof value.text === 'string') {
    return value.text.trim();
  }

  const candidates = [
    value.text,
    value.prompt,
    value.content,
    value.body,
    value.message?.content
  ];
  for (const candidate of candidates) {
    const extracted = extractTextContent(candidate);
    if (extracted) {
      return extracted;
    }
  }

  return '';
}

function toBooleanFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return null;
}

function getEventMetadata(event = {}) {
  return isPlainObject(event?.metadata) ? event.metadata : {};
}

function isStreamingPreviewMessageEvent(event = {}) {
  if (!isPlainObject(event)) {
    return false;
  }

  const metadata = getEventMetadata(event);
  const explicitFinalFlags = [
    toBooleanFlag(event?.isFinal),
    toBooleanFlag(metadata?.isFinal),
    toBooleanFlag(event?.final),
    toBooleanFlag(metadata?.final),
    toBooleanFlag(event?.finish),
    toBooleanFlag(metadata?.finish),
    toBooleanFlag(event?.done),
    toBooleanFlag(metadata?.done)
  ].filter((value) => value !== null);

  if (explicitFinalFlags.includes(true)) {
    return false;
  }
  if (explicitFinalFlags.includes(false)) {
    return true;
  }

  const phase = String(event?.phase || metadata?.phase || event?.stage || metadata?.stage || '').trim().toLowerCase();
  const kind = String(event?.kind || metadata?.kind || event?.type || metadata?.type || '').trim().toLowerCase();
  const status = String(event?.status || metadata?.status || '').trim().toLowerCase();
  const previewFlag = toBooleanFlag(event?.preview) ?? toBooleanFlag(metadata?.preview);
  const streamingFlag = toBooleanFlag(event?.streaming)
    ?? toBooleanFlag(metadata?.streaming)
    ?? toBooleanFlag(event?.stream)
    ?? toBooleanFlag(metadata?.stream);

  if (previewFlag === true) {
    return true;
  }
  if (event?.delta != null || metadata?.delta != null) {
    return true;
  }
  if (event?.contentDelta != null || metadata?.contentDelta != null) {
    return true;
  }
  if (event?.textDelta != null || metadata?.textDelta != null) {
    return true;
  }

  if (/(stream|delta|partial|preview|draft|typing)/.test(phase)) {
    return true;
  }
  if (/(stream|delta|partial|preview|draft|typing)/.test(kind)) {
    return true;
  }
  if (/(stream|delta|partial|preview|draft|typing|pending)/.test(status)) {
    return true;
  }

  if (streamingFlag === true) {
    return true;
  }

  return false;
}

function looksLikeInternalReasoningPreview(text = '') {
  const content = String(text || '').trim();
  if (!content || content.length < 80) {
    return false;
  }

  const strongPatterns = [
    /根据\s*skill\s*文档/ig,
    /用户问的是/ig,
    /脚本路径在当前激活的版本下可能不同/ig,
    /查询返回的结果中/ig,
    /让我(?:用|查找|筛选|先|直接)/ig,
    /\bit\s+only\s+returned\b/ig,
    /\blet\s+me\s+try\b/ig,
    /\bactually,\s*wait\b/ig,
    /\bnow\s+i\s+see\b/ig,
    /\blet\s+me\s+take\s+a\s+(?:different|step\s+back)\s+approach\b/ig,
    /\bthat'?s\s+suspicious\b/ig
  ];

  const matches = strongPatterns
    .map((pattern) => {
      const found = content.match(pattern);
      return Array.isArray(found) ? found.length : 0;
    })
    .reduce((sum, count) => sum + count, 0);

  if (matches >= 2) {
    return true;
  }

  const repeatedSegments = [
    '根据Skill文档',
    '查询返回的结果中',
    '让我筛选出',
    '脚本路径在当前激活的版本下可能不同',
    'Let me try',
    'Now I see',
    'Actually, wait'
  ].filter((segment) => content.split(segment).length - 1 >= 2);

  return repeatedSegments.length > 0;
}

function isNapmMetaFollowUpPrompt(prompt = '', previousState = null) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasReference = /(?:这次|刚才|上一条|上一次|这个|该查询|这个查询|上面|前面|刚刚)/i.test(text);
  const hasMetaIntent = /(?:思路|构成|构造|怎么查|如何查|怎么拼|怎么组|来源|依据|为什么这样|返回给我|最终的?|最终api|方法来源|耗时|多长时间|时间都消耗在哪里|耗在哪里)/i.test(text);
  const previousNapmRelated = Boolean(previousState?.napmRelated || previousState?.domainRelated);

  if (hasMetaIntent && previousNapmRelated) {
    return true;
  }

  return hasReference && hasMetaIntent;
}

function looksLikeNapmBypassProcessText(text = '') {
  const content = String(text || '').trim();
  if (!content) {
    return false;
  }

  return /(?:Node\.js\s*脚本|python3|grep|bash|NapmMetadataService|单例导出|重试|写好.*脚本写入文件|调了\s+NapmMetadataService|直接调用.*getDrilldownPathsForGroupType|解析\s*JSON\s*失败)/i.test(content);
}

function isMeaningfulText(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return text !== '[object Object]' && text !== '[object Array]';
}

function normalizePromptKey(prompt) {
  return String(prompt || '').trim().toLowerCase();
}

function buildPromptScopeKey(prompt = '', conversationKey = '') {
  const promptKey = normalizePromptKey(prompt);
  const scopeKey = String(conversationKey || '').trim();
  if (!promptKey) {
    return '';
  }
  return scopeKey ? `${scopeKey}::${promptKey}` : promptKey;
}

function normalizeObject(value) {
  return isPlainObject(value) ? value : undefined;
}

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeGroupsForPlanning(groups = []) {
  if (!Array.isArray(groups)) {
    return [];
  }

  return groups
    .map((item) => ({
      type: typeof item?.type === 'string' ? item.type.trim() : item?.type || null,
      argument: item?.argument ?? null
    }))
    .filter((item) => item.type);
}

function getSkillWorkspaceRootFromExecutor() {
  const executorPath = String(NAPM_SKILL_EXECUTOR || '').trim();
  if (!executorPath) {
    return '';
  }

  const absoluteExecutorPath = path.isAbsolute(executorPath)
    ? executorPath
    : path.resolve(process.cwd(), executorPath);
  return path.resolve(path.dirname(absoluteExecutorPath), '..', '..', '..');
}

function collectGroupPathPlannerModuleCandidates() {
  const candidates = [];
  const pushCandidate = (candidatePath) => {
    const normalized = String(candidatePath || '').trim();
    if (!normalized) {
      return;
    }

    const resolved = path.resolve(normalized);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  pushCandidate(path.resolve(__dirname, 'skills', 'openclaw-napm-query', 'services', 'GroupPathPlannerService.js'));
  pushCandidate(path.resolve(__dirname, '..', 'skills', 'openclaw-napm-query', 'services', 'GroupPathPlannerService.js'));
  pushCandidate(path.resolve(__dirname, '..', '..', 'skills', 'openclaw-napm-query', 'services', 'GroupPathPlannerService.js'));

  const workspaceRoot = getSkillWorkspaceRootFromExecutor();
  if (workspaceRoot) {
    pushCandidate(path.join(workspaceRoot, 'skills', 'openclaw-napm-query', 'services', 'GroupPathPlannerService.js'));
  }

  pushCandidate(path.resolve(process.cwd(), 'skills', 'openclaw-napm-query', 'services', 'GroupPathPlannerService.js'));
  return candidates;
}

function collectPromptRoutingModuleCandidates() {
  const candidates = [];
  const pushCandidate = (candidatePath) => {
    const normalized = String(candidatePath || '').trim();
    if (!normalized) {
      return;
    }

    const resolved = path.resolve(normalized);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  pushCandidate(path.resolve(__dirname, 'skills', 'openclaw-napm-query', 'services', 'PromptRoutingService.js'));
  pushCandidate(path.resolve(__dirname, '..', 'skills', 'openclaw-napm-query', 'services', 'PromptRoutingService.js'));
  pushCandidate(path.resolve(__dirname, '..', '..', 'skills', 'openclaw-napm-query', 'services', 'PromptRoutingService.js'));

  const workspaceRoot = getSkillWorkspaceRootFromExecutor();
  if (workspaceRoot) {
    pushCandidate(path.join(workspaceRoot, 'skills', 'openclaw-napm-query', 'services', 'PromptRoutingService.js'));
  }

  pushCandidate(path.resolve(process.cwd(), 'skills', 'openclaw-napm-query', 'services', 'PromptRoutingService.js'));
  return candidates;
}

function collectResolutionSpecServiceModuleCandidates() {
  const candidates = [];
  const pushCandidate = (candidatePath) => {
    const normalized = String(candidatePath || '').trim();
    if (!normalized) {
      return;
    }

    const resolved = path.resolve(normalized);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  pushCandidate(path.resolve(__dirname, 'skills', 'openclaw-napm-query', 'services', 'ResolutionSpecService.js'));
  pushCandidate(path.resolve(__dirname, '..', 'skills', 'openclaw-napm-query', 'services', 'ResolutionSpecService.js'));
  pushCandidate(path.resolve(__dirname, '..', '..', 'skills', 'openclaw-napm-query', 'services', 'ResolutionSpecService.js'));

  const workspaceRoot = getSkillWorkspaceRootFromExecutor();
  if (workspaceRoot) {
    pushCandidate(path.join(workspaceRoot, 'skills', 'openclaw-napm-query', 'services', 'ResolutionSpecService.js'));
  }

  pushCandidate(path.resolve(process.cwd(), 'skills', 'openclaw-napm-query', 'services', 'ResolutionSpecService.js'));
  return candidates;
}

function loadSkillDotenvIfAvailable() {
  if (skillDotenvLoaded) {
    return;
  }

  skillDotenvLoaded = true;
  const workspaceRoot = getSkillWorkspaceRootFromExecutor() || process.cwd();
  const dotenvPath = path.join(workspaceRoot, '.env');
  if (!fs.existsSync(dotenvPath)) {
    return;
  }

  const dotenvCandidates = [
    path.join(workspaceRoot, 'node_modules', 'dotenv'),
    'dotenv'
  ];

  for (const candidate of dotenvCandidates) {
    try {
      require(candidate).config({ path: dotenvPath });
      return;
    } catch (_error) {
      // Try the next candidate.
    }
  }
}

function getGroupPathPlannerService() {
  if (groupPathPlannerLookupComplete) {
    return cachedGroupPathPlannerService;
  }

  loadSkillDotenvIfAvailable();
  groupPathPlannerLookupComplete = true;
  for (const candidatePath of collectGroupPathPlannerModuleCandidates()) {
    try {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      const service = require(candidatePath);
      if (service && typeof service.planPath === 'function') {
        cachedGroupPathPlannerService = service;
        break;
      }
    } catch (_error) {
      // Try the next candidate.
    }
  }

  return cachedGroupPathPlannerService;
}

function getPromptRoutingService() {
  if (promptRoutingLookupComplete) {
    return cachedPromptRoutingService;
  }

  loadSkillDotenvIfAvailable();
  promptRoutingLookupComplete = true;
  for (const candidatePath of collectPromptRoutingModuleCandidates()) {
    try {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      const service = require(candidatePath);
      if (service && typeof service.isOverviewPrompt === 'function') {
        cachedPromptRoutingService = service;
        break;
      }
    } catch (_error) {
      // Try the next candidate.
    }
  }

  if (!cachedPromptRoutingService) {
    throw new Error('PromptRoutingService module not found');
  }

  return cachedPromptRoutingService;
}

function getResolutionSpecService() {
  if (resolutionSpecLookupComplete) {
    return cachedResolutionSpecService;
  }

  loadSkillDotenvIfAvailable();
  resolutionSpecLookupComplete = true;
  for (const candidate of collectResolutionSpecServiceModuleCandidates()) {
    try {
      cachedResolutionSpecService = require(candidate);
      break;
    } catch (_error) {
      // try next candidate
    }
  }

  return cachedResolutionSpecService;
}

function getBoundaryMode() {
  const service = getResolutionSpecService();
  if (service && typeof service.getBoundaryMode === 'function') {
    return service.getBoundaryMode('compat');
  }
  const raw = String(process.env.NAPM_RESOLUTION_BOUNDARY_MODE || 'compat').trim().toLowerCase();
  return raw === 'strict' ? 'strict' : 'compat';
}

function isStrictBoundaryMode() {
  return getBoundaryMode() === 'strict';
}

function shouldSkipPathPreflight(resolvedQuery = {}) {
  const service = String(resolvedQuery?.service || '').trim();
  return service === 'overview'
    || service === 'drilldownCatalog'
    || service === 'query_explanation'
    || service === 'security_refusal';
}

function resolvePathPlanningSeedGroups(resolvedQuery = {}, sessionState = null, prompt = '') {
  const explicitGroups = normalizeGroupsForPlanning(resolvedQuery?.groups);
  if (explicitGroups.length > 0) {
    return explicitGroups;
  }

  if (!sessionState || typeof sessionState !== 'object' || !isContinuationPrompt(prompt)) {
    return [];
  }

  return normalizeGroupsForPlanning(sessionState?.last_groups);
}

function applyPathPreflightToResolvedQuery(resolvedQuery = undefined, prompt = '', sessionState = null) {
  if (!isPlainObject(resolvedQuery) || shouldSkipPathPreflight(resolvedQuery)) {
    return resolvedQuery;
  }

  if (Array.isArray(resolvedQuery?.pathPlanning?.plannedGroups) && resolvedQuery.pathPlanning.plannedGroups.length > 0) {
    return resolvedQuery;
  }

  const pathPlannerService = getGroupPathPlannerService();
  if (!pathPlannerService || typeof pathPlannerService.planPath !== 'function') {
    return resolvedQuery;
  }

  const seedGroups = resolvePathPlanningSeedGroups(resolvedQuery, sessionState, prompt);
  if (seedGroups.length === 0) {
    return resolvedQuery;
  }

  const query = cloneJsonObject(resolvedQuery);
  const pathPlan = pathPlannerService.planPath(query, prompt, {
    groups: seedGroups
  });
  if (!pathPlan?.plannedGroups?.length) {
    return query;
  }

  const targetType = String(pathPlan.plannedGroups[pathPlan.plannedGroups.length - 1]?.type || '').trim() || null;
  query.groups = pathPlan.plannedGroups;
  query.pathPlanning = {
    ...(isPlainObject(query.pathPlanning) ? query.pathPlanning : {}),
    ...pathPlan,
    preflightSource: 'napm_openclaw_plugin'
  };

  if (targetType || pathPlan.followUpAction) {
    query.semanticConstraints = {
      ...(isPlainObject(query.semanticConstraints) ? query.semanticConstraints : {}),
      ...(targetType ? { targetObjectType: targetType } : {}),
      ...(
        pathPlan.followUpAction && !String(query?.semanticConstraints?.followUpAction || '').trim()
          ? { followUpAction: pathPlan.followUpAction }
          : {}
      )
    };
  }

  if (targetType) {
    query.resolutionHints = {
      ...(isPlainObject(query.resolutionHints) ? query.resolutionHints : {}),
      group: {
        ...(isPlainObject(query?.resolutionHints?.group) ? query.resolutionHints.group : {}),
        type: targetType,
        source: String(query?.resolutionHints?.group?.source || '').trim() || 'plugin_path_preflight'
      }
    };
  }

  return query;
}

function applyPathPreflightToSkillArgs(args = {}) {
  return isPlainObject(args) ? { ...args } : {};
}

function roundToNearestMinute(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric / 60) * 60;
}

function getDefaultTimeRange() {
  const end = roundToNearestMinute(Math.floor(Date.now() / 1000));
  return {
    start: end - (24 * 60 * 60),
    end
  };
}

function formatNumber(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  return numeric.toFixed(digits).replace(/\.?0+$/, '');
}

function normalizeTimeRange(args = {}) {
  const fallback = getDefaultTimeRange();
  const start = roundToNearestMinute(args.start);
  const end = roundToNearestMinute(args.end);
  if (start && end && end > start) {
    return { start, end };
  }
  if (end && !start) {
    return { start: end - (24 * 60 * 60), end };
  }
  if (start && !end) {
    return { start, end: start + (24 * 60 * 60) };
  }
  return fallback;
}

function looksLikeMetricCode(value = '') {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{2,}$/.test(text);
}

function normalizeMetricInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'TPIO';
  }

  const normalized = raw.toUpperCase();
  if (looksLikeMetricCode(normalized)) {
    return normalized;
  }

  if (/(请求次数|访问量|访问次数|页面访问|page\s*views|visit\s*count|visits)/i.test(raw)) return 'PGNPGE';
  if (/(http响应数|响应数|response\s*count|http\s*responses)/i.test(raw)) return 'PGNOBJE';
  if (/(吞吐|吞吐量|带宽|throughput|bandwidth)/i.test(raw)) return 'TPIO';
  if (/(页面流量|网站流量|web页面流量)/i.test(raw)) return 'PGBYTO';
  if (/(请求流量|页面请求流量|请求数据量)/i.test(raw)) return 'PGBYTI';
  if (/(总流量|流量|traffic)/i.test(raw)) return 'BYTIO';
  if (/(服务端响应时间|服务器响应时间|server\s*response)/i.test(raw)) return 'TRTI';
  if (/(往返时延|网络时延|延迟|时延|latency|rtt)/i.test(raw)) return 'RTTI';
  if (/(慢页面|慢页|slow\s*page)/i.test(raw)) return 'PGNSLPGE';
  if (/(http\s*500|5xx|500错误|500异常)/i.test(raw)) return 'PGHTTP500';
  if (/(http\s*400|4xx|400错误|400异常)/i.test(raw)) return 'PGHTTP400';
  if (/(丢包|丢包率|packet\s*loss|loss)/i.test(raw)) return 'PLI';
  if (/(重传|retransmission)/i.test(raw)) return 'RDTI';
  if (/(连接请求数|建连请求数|connection\s*request)/i.test(raw)) return 'CONI';
  if (/(连接失败数|失败连接数|connection\s*failure)/i.test(raw)) return 'RFCI';
  if (/(连接数|新建连接数|connection\s*count)/i.test(raw)) return 'CCNI';
  return raw;
}

function normalizeGroupInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'IPAddress';
  }

  if (/^(?:ClientIPs|BusinessGroup|WebApplication|DefinedApp|Application|Prefix24|IPConversation|TotalTraffic|IPAddress)$/i.test(raw)) {
    if (/^Application$/i.test(raw)) {
      return 'DefinedApp';
    }
    if (/^ClientIPs$/i.test(raw)) {
      return 'ClientIPs';
    }
    return raw;
  }

  if (/(客户端ip|client\s*ip|clientip)/i.test(raw)) return 'IPAddress';
  if (/(服务端ip|server\s*ip|serverip)/i.test(raw)) return 'IPAddress';
  if (/(ip地址|主机|host|\bip\b)/i.test(raw)) return 'IPAddress';
  if (/(业务组|工作组|业务分组|business\s*group)/i.test(raw)) return 'BusinessGroup';
  if (/(web应用|业务系统|网站|站点|web\s*application|webapp|website|\bweb\b)/i.test(raw)) return 'WebApplication';
  if (/(已知应用|协议应用|应用|app|application)/i.test(raw)) return 'DefinedApp';
  if (/(ip会话|会话|session|conversation)/i.test(raw)) return 'IPConversation';
  if (/(网段|prefix24|\/24)/i.test(raw)) return 'Prefix24';
  if (/(总流量|全局|整体|概览|系统整体|global|overall|total\s*traffic)/i.test(raw)) return 'TotalTraffic';
  return raw;
}

function normalizeGranularity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return 3600;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  if (raw === '1m' || raw === '1min' || raw === '1minute') return 60;
  if (raw === '5m' || raw === '5min' || raw === '5minute') return 300;
  if (raw === '15m' || raw === '15min' || raw === '15minute') return 900;
  if (raw === '30m' || raw === '30min' || raw === '30minute') return 1800;
  if (raw === '1h' || raw === '1hr' || raw === '1hour') return 3600;
  return 3600;
}

function isOverviewPrompt(prompt = '') {
  return getPromptRoutingService().isOverviewPrompt(prompt);
}

function normalizeHierarchyQuestionTarget(prompt = '') {
  return getPromptRoutingService().normalizeHierarchyQuestionTarget(prompt) || '';
}

function isHierarchyCatalogPrompt(prompt = '') {
  return getPromptRoutingService().isHierarchyCatalogPrompt(prompt);
}

function isMetricInventoryPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return /(?:(?:哪些|有什么|有哪些)[^，。！？\n]{0,12}指标|指标[^，。！？\n]{0,12}(?:哪些|有什么|有哪些|可查|能查|支持)|(?:可查|能查|支持)[^，。！？\n]{0,12}(?:哪些|有什么)[^，。！？\n]{0,6}指标)/i.test(text);
}

function inferMetricInventoryGroup(prompt = '') {
  return getPromptRoutingService().inferMetricInventoryGroup(prompt);
}

function isBusinessObjectInventoryPrompt(prompt = '') {
  return getPromptRoutingService().isBusinessObjectInventoryPrompt(prompt);
}

function buildBusinessObjectInventoryResolvedQuery(prompt = '') {
  const route = getPromptRoutingService().buildBusinessObjectInventoryRoute(prompt);
  return materializePluginPromptRoute(route);
}

function buildMetricInventoryResolvedQuery(prompt = '') {
  const route = getPromptRoutingService().buildMetricInventoryRoute(prompt);
  return materializePluginPromptRoute(route);
}

function shouldRefreshMetricInventory(prompt = '', rememberedRecord = null) {
  const text = String(prompt || '').trim();
  const rememberedGroup = String(rememberedRecord?.resolvedQuery?.groups?.[0]?.type || '').trim();
  if (isMetricInventoryDetailPrompt(text) && rememberedGroup) {
    return false;
  }
  const effectivePrompt = expandMetricInventoryPrompt(text, rememberedGroup);
  if (!isMetricInventoryPrompt(effectivePrompt)) {
    return false;
  }

  const expectedGroup = inferMetricInventoryGroup(effectivePrompt);
  const resolvedService = String(rememberedRecord?.resolvedQuery?.service || '').trim();
  const rememberedOperation = String(rememberedRecord?.resolvedQuery?.semanticConstraints?.operation || '').trim();

  return resolvedService !== 'metrics'
    || rememberedOperation !== 'metadata_list'
    || !expectedGroup
    || rememberedGroup !== expectedGroup;
}

function shouldRefreshHierarchyCatalog(prompt = '', rememberedRecord = null) {
  const text = String(prompt || '').trim();
  if (!isHierarchyCatalogPrompt(text)) {
    return false;
  }

  const resolvedService = String(rememberedRecord?.resolvedQuery?.service || '').trim();
  return resolvedService !== 'drilldownCatalog';
}

function shouldRefreshBusinessObjectInventory(prompt = '', rememberedRecord = null) {
  const text = String(prompt || '').trim();
  if (!isBusinessObjectInventoryPrompt(text)) {
    return false;
  }

  const resolvedService = String(rememberedRecord?.resolvedQuery?.service || '').trim();
  const rememberedOperation = String(rememberedRecord?.resolvedQuery?.semanticConstraints?.operation || '').trim();
  const rememberedGroup = String(rememberedRecord?.resolvedQuery?.groups?.[0]?.type || '').trim();
  return resolvedService !== 'groups'
    || rememberedOperation !== 'metadata_list'
    || rememberedGroup !== 'WebApplication';
}

function getOverviewDayStart(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + Number(offsetDays || 0));
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function getOverviewDayEndExclusive(offsetDays = 0) {
  return getOverviewDayStart(Number(offsetDays || 0) + 1);
}

function getOverviewRelativeRange(seconds) {
  const end = roundToNearestMinute(Math.floor(Date.now() / 1000));
  return {
    start: end - Number(seconds || 0),
    end
  };
}

function inferOverviewScene(prompt = '') {
  return getPromptRoutingService().inferOverviewScene(prompt);
}

function normalizeOverviewSceneKey(scene = '') {
  return getPromptRoutingService().normalizeOverviewSceneKey(scene);
}

function inferOverviewTimeRangeKey(prompt = '') {
  return getPromptRoutingService().inferOverviewTimeRangeKey(prompt);
}

function parseOverviewTimeRange(timeRangeKey = 'last24hours') {
  switch (String(timeRangeKey || '').toLowerCase()) {
    case 'today':
      return {
        start: getOverviewDayStart(0),
        end: getOverviewDayEndExclusive(0)
      };
    case 'yesterday':
      return {
        start: getOverviewDayStart(-1),
        end: getOverviewDayEndExclusive(-1)
      };
    case 'last7days':
      return getOverviewRelativeRange(7 * 24 * 3600);
    case 'last30days':
      return getOverviewRelativeRange(30 * 24 * 3600);
    case 'last1hour':
      return getOverviewRelativeRange(3600);
    case 'last24hours':
    default:
      return getOverviewRelativeRange(24 * 3600);
  }
}

function materializePluginPromptRoute(route = null, options = {}) {
  return getPromptRoutingService().materializePromptRouteResolvedQuery(route, {
    resolveTimeRange: (timeRangeKey) => parseOverviewTimeRange(timeRangeKey),
    roundTimeValue: roundToNearestMinute,
    pluginStructuredOverview: Boolean(options.pluginStructuredOverview)
  });
}

function buildOverviewResolvedQuery(prompt = '') {
  const route = getPromptRoutingService().buildOverviewRoute(prompt);
  return materializePluginPromptRoute(route, { pluginStructuredOverview: true });
}

function resolvePromptInjectedResolvedQuery(prompt = '', currentResolvedQuery = undefined, options = {}) {
  if (isStrictBoundaryMode()) {
    return null;
  }
  const text = String(prompt || '').trim();
  if (!text) {
    return null;
  }

  const existingResolvedQuery = normalizeObject(currentResolvedQuery);
  const promptRoute = getPromptRoutingService().resolvePromptRoute(text);
  const promptResolvedQuery = materializePluginPromptRoute(promptRoute, {
    pluginStructuredOverview: Boolean(options.pluginStructuredOverview)
  });
  const promptService = String(promptResolvedQuery?.service || '').trim();

  if (isPlainObject(promptResolvedQuery) && promptService && promptService !== 'overview') {
    return promptResolvedQuery;
  }

  const packetLossResolvedQuery = buildPacketLossClientTopResolvedQuery(text, existingResolvedQuery);
  if (packetLossResolvedQuery) {
    return packetLossResolvedQuery;
  }

  if (Boolean(options.allowOverviewReplacement)) {
    const overviewResolvedQuery = promptService === 'overview'
      ? promptResolvedQuery
      : buildOverviewResolvedQuery(text);
    if (shouldReplaceWithPromptOverview(existingResolvedQuery, overviewResolvedQuery)) {
      return overviewResolvedQuery;
    }
    return null;
  }

  if (!isPlainObject(existingResolvedQuery) && isPlainObject(promptResolvedQuery)) {
    return promptResolvedQuery;
  }

  return null;
}

function shouldReplaceWithPromptOverview(resolvedQuery = {}, overviewResolvedQuery = null) {
  if (!isPlainObject(overviewResolvedQuery)) {
    return false;
  }
  if (!isPlainObject(resolvedQuery)) {
    return true;
  }

  const service = String(resolvedQuery?.service || '').trim();
  if (service !== 'overview') {
    return true;
  }

  const actualScene = normalizeOverviewSceneKey(
    resolvedQuery?.overviewScene
    || resolvedQuery?.semanticConstraints?.overviewScene
  );
  const expectedScene = normalizeOverviewSceneKey(overviewResolvedQuery?.overviewScene);
  return actualScene !== expectedScene;
}

function prepareSkillExecutionArgs(args = {}) {
  const prepared = isPlainObject(args) ? { ...args } : {};
  const prompt = normalizePrompt(prepared);
  if (!prepared.userQuery && prompt) {
    prepared.userQuery = prompt;
  }

  return applyPathPreflightToSkillArgs(prepared);
}

function buildCanonicalSkillToolParams(activePrompt = '', toolParams = {}) {
  const prompt = String(activePrompt || '').trim();
  const nextParams = isPlainObject(toolParams) ? { ...toolParams } : {};
  if (!prompt) {
    return applyPathPreflightToSkillArgs(nextParams);
  }

  nextParams.prompt = prompt;
  nextParams.userQuery = prompt;

  return applyPathPreflightToSkillArgs(nextParams);
}

function isPluginStructuredOverviewInjection(originalArgs = {}, preparedArgs = {}) {
  return !isPlainObject(originalArgs?.resolvedQuery)
    && isPlainObject(preparedArgs?.resolvedQuery)
    && String(preparedArgs.resolvedQuery?.service || '').trim() === 'overview'
    && isOverviewPrompt(normalizePrompt(preparedArgs));
}

function getGuardKeys(ctx = {}) {
  return [
    ctx.sessionKey,
    ctx.sessionId,
    ctx.agentId,
    ctx.runId,
    ctx.messageId,
    ctx.conversationId
  ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
}

function getGuardState(ctx = {}) {
  for (const key of getGuardKeys(ctx)) {
    const state = napmGuardState.get(key);
    if (state) {
      return state;
    }
  }
  return null;
}

function setGuardState(ctx = {}, state) {
  for (const key of getGuardKeys(ctx)) {
    napmGuardState.set(key, state);
  }
}

function buildConversationScopedGuardState(content = '', previousState = null) {
  const prompt = String(content || '').trim();
  const overviewRelated = isOverviewPrompt(prompt);
  const metricInventoryPrompt = isMetricInventoryPrompt(prompt)
    || (previousState?.lastMetricInventoryGroup && isMetricInventoryDetailPrompt(prompt));
  const metaFollowUpPrompt = isNapmMetaFollowUpPrompt(prompt, previousState);
  const domainRelated = overviewRelated
    || isSystemDomainPrompt(prompt)
    || metaFollowUpPrompt
    || (previousState?.domainRelated && isContinuationPrompt(prompt));
  const napmRelated = overviewRelated
    || isNapmRelatedPrompt(prompt)
    || metaFollowUpPrompt
    || (previousState?.napmRelated && isContinuationPrompt(prompt));

  return {
    prompt,
    napmRelated,
    domainRelated,
    metricInventoryPrompt,
    metaFollowUpPrompt,
    lastMetricInventoryGroup: isMetricInventoryPrompt(prompt)
      ? inferMetricInventoryGroup(prompt)
      : (previousState?.lastMetricInventoryGroup || ''),
    generalOutOfScopeRequested: Boolean(prompt) && !domainRelated,
    outOfScopeBoundaryRequested: domainRelated && isOutOfScopeNapmRequest(prompt),
    turnNapmToolUsed: false,
    updatedAt: Date.now()
  };
}

function derivePromptGuardState(activePrompt = '', conversationState = null, guardState = null) {
  const prompt = String(activePrompt || '').trim();
  const previousState = isPlainObject(conversationState)
    ? conversationState
    : (isPlainObject(guardState) ? guardState : null);
  const derivedState = buildConversationScopedGuardState(prompt, previousState);

  return {
    ...(isPlainObject(conversationState) ? conversationState : {}),
    ...(isPlainObject(guardState) ? guardState : {}),
    ...derivedState,
    prompt,
    turnNapmToolUsed: Boolean(
      conversationState?.turnNapmToolUsed
      || guardState?.turnNapmToolUsed
    ),
    updatedAt: Date.now()
  };
}

function getConversationKey(ctx = {}) {
  return [
    ctx.channelId || '',
    ctx.accountId || '',
    ctx.conversationId || ''
  ].join(':');
}

function getRequestUrlFromResult(result) {
  const summary = isPlainObject(result?.summary) ? result.summary : {};
  return String(result?.requestUrl || summary?.requestUrl || '').trim();
}

function rememberSkillResult(prompt, result, conversationKey = '') {
  const key = buildPromptScopeKey(prompt, conversationKey);
  if (!key || !isPlainObject(result)) {
    return;
  }

  const record = {
    promptKey: key,
    conversationKey: String(conversationKey || '').trim() || null,
    updatedAt: Date.now(),
    requestUrl: getRequestUrlFromResult(result) || '',
    resolvedQuery: isPlainObject(result.resolvedQuery) ? result.resolvedQuery : null,
    result
  };
  napmResultByPrompt.set(key, record);
  latestNapmResult = record;
}

function rememberDebugApi(prompt, result, conversationKey = '') {
  rememberSkillResult(prompt, result, conversationKey);

  const key = buildPromptScopeKey(prompt, conversationKey);
  const requestUrl = getRequestUrlFromResult(result);
  if (!key || !requestUrl) {
    return;
  }
  const record = {
    conversationKey: String(conversationKey || '').trim() || null,
    requestUrl,
    updatedAt: Date.now()
  };
  napmDebugApiByPrompt.set(key, record);
  latestNapmDebugApi = {
    ...record,
    promptKey: key
  };
}

function isFreshRememberedRecord(record, maxAgeMs = RESULT_CACHE_MAX_AGE_MS) {
  return Boolean(
    record
    && Number(record.updatedAt) > 0
    && (Date.now() - Number(record.updatedAt)) <= maxAgeMs
  );
}

function getRememberedDebugApi(prompt, conversationKey = '') {
  const key = buildPromptScopeKey(prompt, conversationKey);
  if (!key) {
    return '';
  }
  const record = napmDebugApiByPrompt.get(key);
  if (!isFreshRememberedRecord(record)) {
    return '';
  }
  return String(record?.requestUrl || '').trim();
}

function getRecentDebugApiFallback(maxAgeMs = 2 * 60 * 1000) {
  if (!latestNapmDebugApi?.requestUrl || !latestNapmDebugApi?.updatedAt) {
    return '';
  }
  if (Date.now() - latestNapmDebugApi.updatedAt > maxAgeMs) {
    return '';
  }
  return String(latestNapmDebugApi.requestUrl || '').trim();
}

function getRememberedSkillResult(prompt, conversationKey = '') {
  const key = buildPromptScopeKey(prompt, conversationKey);
  if (!key) {
    return null;
  }
  const record = napmResultByPrompt.get(key) || null;
  return isFreshRememberedRecord(record) ? record : null;
}

function getRecentRememberedSkillResult(conversationKey = '') {
  const scopeKey = String(conversationKey || '').trim();
  if (!latestNapmResult || !isFreshRememberedRecord(latestNapmResult)) {
    return null;
  }
  if (!scopeKey) {
    return latestNapmResult;
  }
  return latestNapmResult.conversationKey === scopeKey
    ? latestNapmResult
    : null;
}

function getRememberedMetricInventoryFollowUpRecord(prompt = '', conversationState = null, conversationKey = '') {
  const text = String(prompt || '').trim();
  if (!isMetricInventoryDetailPrompt(text)) {
    return null;
  }

  const groupType = String(conversationState?.lastMetricInventoryGroup || '').trim();
  if (!groupType) {
    return null;
  }

  const scopePromptMap = {
    WebApplication: '业务都可以查哪些指标？',
    BusinessGroup: '业务组都可以查哪些指标？',
    ClientBusinessGroup: '客户端业务组都可以查哪些指标？',
    PageFamily: '页面族都可以查哪些指标？',
    User: '用户都可以查哪些指标？',
    DefinedApp: '应用都可以查哪些指标？',
    Application: '应用都可以查哪些指标？'
  };
  const canonicalPrompt = scopePromptMap[groupType] || '';
  if (!canonicalPrompt) {
    return null;
  }

  return getRememberedSkillResult(canonicalPrompt, conversationKey)
    || getRememberedSkillResult(canonicalPrompt, '')
    || (
      latestNapmResult
      && isFreshRememberedRecord(latestNapmResult)
      && String(latestNapmResult?.resolvedQuery?.groups?.[0]?.type || '').trim() === groupType
      && String(latestNapmResult?.resolvedQuery?.service || '').trim() === 'metrics'
        ? latestNapmResult
        : null
    );
}

function extractOverviewSceneFromRememberedRecord(record = null) {
  if (!isPlainObject(record)) {
    return '';
  }

  const result = isPlainObject(record.result) ? record.result : {};
  return normalizeOverviewSceneKey(
    record?.resolvedQuery?.overviewScene
    || record?.resolvedQuery?.semanticConstraints?.overviewScene
    || result?.resolvedQuery?.overviewScene
    || result?.resolvedQuery?.semanticConstraints?.overviewScene
    || result?.narrationStructure?.scene
    || result?.overview?.scene
  );
}

function readRecentAuditLines(maxLines = 400) {
  try {
    const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - maxLines));
  } catch (_error) {
    return [];
  }
}

function findRecentPacketLossAuditWindow(metric = 'PLI') {
  const lines = readRecentAuditLines();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"event":"napm_api_request_built"') || !line.includes('"service":"topValues"')) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      const request = isPlainObject(entry?.gatewayRequest) ? entry.gatewayRequest : {};
      const groups = Array.isArray(request.groups) ? request.groups : [];
      if (String(request.metric || '').trim().toUpperCase() !== metric) {
        continue;
      }
      if (groups.length !== 1 || String(groups[0]?.type || '').trim() !== 'IPAddress') {
        continue;
      }
      const start = Number(request.start);
      const end = Number(request.end);
      const topCount = Number(request.topCount || 5);
      if (start > 0 && end > 0) {
        return { start, end, topCount: topCount > 0 ? topCount : 5 };
      }
    } catch (_error) {}
  }
  return null;
}

function isPacketLossClientTopPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasLoss = /(\u4e22\u5305|\u4e22\u5305\u7387|packet\s*loss|loss)/i.test(text);
  const hasRanking = /(\u6700\u591a|\u6700\u9ad8|\u6700\u5927|\u6392\u884c|\u6392\u540d|top|\u8c01|\u54ea\u4e2a)/i.test(text);
  const hasAddressScope = /(\u5ba2\u6237\u7aef|client|\u5730\u5740|\bip\b|ip\u5730\u5740|\u8fdc\u7aef|\u5bf9\u7aef)/i.test(text);

  return hasLoss && hasRanking && hasAddressScope;
}

function buildPacketLossClientTopResolvedQuery(prompt = '', seedResolvedQuery) {
  const text = String(prompt || '').trim();
  if (!isPacketLossClientTopPrompt(text)) {
    return null;
  }

  const metric = /(\u6d41\u51fa|\u51fa\u5411|outbound|uplink)/i.test(text) ? 'PLO' : 'PLI';
  const seed = isPlainObject(seedResolvedQuery) ? seedResolvedQuery : {};
  const timeWindow = findRecentPacketLossAuditWindow(metric);
  const defaultRange = getDefaultTimeRange();
  const start = Number(seed.start || timeWindow?.start || defaultRange.start);
  const end = Number(seed.end || timeWindow?.end || defaultRange.end);
  const topCountCandidate = Number(seed.topCount);
  if (!(start > 0) || !(end > 0)) {
    return null;
  }

  return {
    ...seed,
    service: 'topValues',
    metric,
    metrics: [metric],
    topMetric: metric,
    groups: [{ type: 'IPAddress' }],
    topCount: topCountCandidate > 0 ? topCountCandidate : 1,
    start,
    end,
    format: 'json',
    userRequirement: text
  };
}

function includesAnyKeyword(text, keywords = []) {
  const normalized = String(text || '').toLowerCase();
  return keywords.some((keyword) => normalized.includes(String(keyword || '').toLowerCase()));
}

function isNapmRelatedPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  if (isOverviewPrompt(text)) {
    return true;
  }

  if (isHierarchyCatalogPrompt(text)) {
    return true;
  }

  if (isPacketLossClientTopPrompt(text)) {
    return true;
  }

  return includesAnyKeyword(text, [
    'napm',
    'netinside',
    '239web',
    'his',
    'web应用',
    '网站',
    '业务系统',
    '业务',
    '系统',
    '页面',
    '响应时间',
    '时延',
    '延迟',
    '吞吐',
    '流量',
    '异常',
    '慢',
    '卡',
    'http',
    '5xx',
    '??',
    '??',
    '??',
    '??',
    '??',
    '??',
    '??',
    '??',
    '??',
    '??',
    '??'
  ]);
}

function isSystemDomainPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  if (isOverviewPrompt(text)) {
    return true;
  }

  if (isHierarchyCatalogPrompt(text)) {
    return true;
  }

  if (isPacketLossClientTopPrompt(text)) {
    return true;
  }

  if (isNapmMetaFollowUpPrompt(text)) {
    return true;
  }

  return includesAnyKeyword(text, [
    'napm',
    'netinside',
    '239web',
    'his',
    'web应用',
    '网站',
    '业务系统',
    '业务',
    '系统',
    '应用',
    '服务',
    '页面',
    '响应时间',
    '时延',
    '延迟',
    '吞吐',
    '流量',
    '异常',
    '慢',
    '卡',
    'http',
    '5xx',
    '丢包',
    '重传',
    '趋势',
    '排行',
    '排名',
    '性能',
    '监控',
    '告警',
    '结果',
    '分析',
    '排查',
    '今天比昨天',
    '最近情况'
  ]);
}

function isContinuationPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return text.length <= 12 || includesAnyKeyword(text, [
    '这个',
    '它',
    '上面',
    '上述',
    '昨天',
    '今天',
    '那',
    '然后呢',
    '继续',
    '改成',
    '换成',
    '怎么看',
    '怎么理解'
  ]);
}

function isOutOfScopeNapmRequest(prompt) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return includesAnyKeyword(text, [
    '重启',
    '部署',
    '发布',
    '改配置',
    '配置文件',
    'nginx',
    'docker',
    'k8s',
    'kubectl',
    'sql',
    '慢sql',
    '锁等待',
    '连接池',
    '线程池',
    '代码',
    'bug',
    '堆栈',
    '日志定位',
    '服务治理',
    'systemctl',
    'service restart'
  ]);
}

function isDangerousSystemTool(toolName) {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized || SAFE_NAPM_TOOL_NAMES.has(normalized)) {
    return false;
  }

  return /(exec|shell|terminal|bash|powershell|systemctl|service|restart|deploy|docker|k8s|kubectl|ssh|command)/i.test(normalized);
}

function buildSoftBoundaryReply() {
  return [
    '这个请求不在当前 OpenClaw NAPM 技能的处理范围内。',
    '我这边不执行重启、部署、改配置、代码排障或数据库内部诊断。',
    '如果你是想排查系统问题，可以改问我：239web最近异常吗、今天比昨天差吗、这个结果怎么理解。'
  ].join('\n');
}

function buildGeneralOutOfScopeReply() {
  return [
    '我当前只处理系统监控、性能分析、NAPM 查询和结果解读相关问题。',
    '像天气、闲聊、泛问答这类内容不在当前技能范围内。',
    '如果你是想看系统情况，可以直接问我：239web最近异常吗、某系统今天比昨天差吗、这个监控结果怎么理解。'
  ].join('\n');
}

function buildAssistantTextMessage(text, originalMessage) {
  return {
    ...(originalMessage || {}),
    role: 'assistant',
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

function buildSkillPayload(args = {}) {
  const prompt = normalizePrompt(args);
  return {
    userQuery: prompt || (typeof args.userQuery === 'string' ? args.userQuery : undefined),
    prompt,
    query: normalizeObject(args.query),
    decision: normalizeObject(args.decision),
    intent: normalizeObject(args.intent),
    resolvedQuery: normalizeObject(args.resolvedQuery),
    sessionState: normalizeObject(args.sessionState),
    clarificationContext: normalizeObject(args.clarificationContext),
    policyAction: typeof args.policyAction === 'string' ? args.policyAction : undefined
  };
}

function buildTopnPayload(args = {}) {
  const { start, end } = normalizeTimeRange(args);
  return {
    service: 'topValues',
    metric: normalizeMetricInput(args.metric),
    groups: [
      {
        type: normalizeGroupInput(args.group)
      }
    ],
    topCount: Number(args.topCount || 5),
    start,
    end,
    format: 'json'
  };
}

function buildAveragePayload(args = {}) {
  const metrics = Array.isArray(args.metrics)
    ? args.metrics.map((item) => normalizeMetricInput(item)).filter(Boolean)
    : typeof args.metric === 'string' && args.metric.trim()
      ? [normalizeMetricInput(args.metric)]
      : ['TPIO'];

  const { start, end } = normalizeTimeRange(args);
  const groupType = normalizeGroupInput(args.group);
  const groupArgument = typeof args.groupArgument === 'string' && args.groupArgument.trim() ? args.groupArgument.trim() : undefined;

  return {
    service: 'averageValues',
    metrics,
    groups: [
      {
        type: groupType,
        ...(groupArgument ? { argument: groupArgument } : {})
      }
    ],
    start,
    end,
    format: 'json'
  };
}

function buildTimeseriesPayload(args = {}) {
  const { start, end } = normalizeTimeRange(args);
  const metric = normalizeMetricInput(args.metric);
  const groupType = normalizeGroupInput(args.group);
  const groupArgument = typeof args.groupArgument === 'string' && args.groupArgument.trim() ? args.groupArgument.trim() : undefined;
  const granularity = normalizeGranularity(args.granularity);

  return {
    service: 'timeValues',
    metrics: [metric],
    groups: [
      {
        type: groupType,
        ...(groupArgument ? { argument: groupArgument } : {})
      }
    ],
    start,
    end,
    granularity,
    format: 'json'
  };
}

function extractSkillJson(stdout) {
  const normalized = String(stdout || '');
  for (let index = normalized.lastIndexOf('{'); index >= 0; index = normalized.lastIndexOf('{', index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith('{')) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // keep searching for the start of the trailing JSON object
    }
  }

  throw new Error(`Unable to locate trailing skill JSON in stdout: ${normalized.slice(-4000)}`);
}

async function runSkillExecutor(args = {}) {
  const preparedArgs = prepareSkillExecutionArgs(args);
  const payload = buildSkillPayload(preparedArgs);
  if (isPluginStructuredOverviewInjection(args, preparedArgs)) {
    payload.__pluginOverviewStructured = true;
  }
  const { stdout, stderr } = await execFileAsync('node', [
    NAPM_SKILL_EXECUTOR,
    '--payload',
    JSON.stringify(payload)
  ], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      NETINSIDE_TLS_INSECURE: process.env.NETINSIDE_TLS_INSECURE || 'true',
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    }
  });

  const result = extractSkillJson(stdout);
  if (stderr && String(stderr).trim()) {
    result.executorStderr = String(stderr).trim();
  }
  return result;
}

function isQueryLikeAction(nextAction) {
  return nextAction === 'GO_DIRECT_QUERY' || nextAction === 'GO_OVERVIEW_QUERY';
}

async function runGatewaySkillFallback(args = {}) {
  return runSkillExecutor(args);
}

function isDirectNapmTool(toolName = '') {
  const normalized = String(toolName || '').trim();
  return normalized === 'napm-topn'
    || normalized === 'napm-average'
    || normalized === 'napm-timeseries';
}

function isTruthyInternalFlag(value) {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function getDirectToolForwardPrompt(args = {}) {
  const candidates = [
    args?.[DIRECT_TOOL_FORWARD_PROMPT],
    args?.prompt,
    args?.userQuery,
    args?.query
  ];
  const matched = candidates.find((value) => typeof value === 'string' && value.trim());
  return matched ? matched.trim() : '';
}

function buildDirectToolForwardParams(params = {}, prompt = '', reason = '') {
  const forwarded = isPlainObject(params) ? { ...params } : {};
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    return forwarded;
  }

  forwarded[DIRECT_TOOL_FORWARD_MARKER] = true;
  forwarded[DIRECT_TOOL_FORWARD_PROMPT] = normalizedPrompt;
  if (reason) {
    forwarded[DIRECT_TOOL_FORWARD_REASON] = String(reason).trim();
  }
  return forwarded;
}

function shouldForwardDirectToolToSkill(toolName = '', args = {}) {
  return isDirectNapmTool(toolName)
    && isTruthyInternalFlag(args?.[DIRECT_TOOL_FORWARD_MARKER])
    && Boolean(getDirectToolForwardPrompt(args));
}

function buildForwardSkillArgsFromDirectTool(args = {}) {
  const prompt = getDirectToolForwardPrompt(args);
  if (!prompt) {
    return null;
  }

  return prepareSkillExecutionArgs({
    prompt,
    userQuery: prompt
  });
}

function toolArgsContainCanonicalTimeRange(params = {}) {
  return Number(params?.start) > 0 && Number(params?.end) > 0;
}

function toolArgsLookCanonicalForDirectNapm(toolName = '', params = {}) {
  if (!isDirectNapmTool(toolName)) {
    return true;
  }

  const metric = String(params?.metric || '').trim();
  const metrics = Array.isArray(params?.metrics)
    ? params.metrics.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const group = String(params?.group || '').trim();
  const allMetricsCanonical = [metric, ...metrics].filter(Boolean).every((item) => looksLikeMetricCode(item));
  const groupCanonical = /^(?:ClientIPs|BusinessGroup|WebApplication|DefinedApp|Application|Prefix24|IPConversation|TotalTraffic|IPAddress)$/i.test(group);
  return allMetricsCanonical && groupCanonical && toolArgsContainCanonicalTimeRange(params);
}

function makeTextReply(text) {
  return { text: String(text || '').trim() };
}

function shouldExposeUpstreamApi() {
  const raw = String(process.env.SHOW_UPSTREAM_API_IN_REPLY || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function shouldAllowNapmReasoningPreview() {
  const raw = String(process.env.NAPM_ALLOW_REASONING_PREVIEW || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function shouldAllowNapmReasoningPreviewForCtx(ctx = {}) {
  if (!shouldAllowNapmReasoningPreview()) {
    return false;
  }

  return String(ctx?.channelId || '').trim() !== 'wecom';
}

function appendDebugApi(text, requestUrl) {
  const body = String(text || '').trim();
  const url = String(requestUrl || '').trim();
  if (!url || !shouldExposeUpstreamApi()) {
    return body;
  }
  if (!body) {
    return `Debug API:\n${url}`;
  }
  if (body.includes(url)) {
    return body;
  }
  return `${body}\n\nDebug API:\n${url}`;
}

function getMetricInventoryScopeLabel(groupType = '') {
  const normalized = String(groupType || '').trim();
  if (normalized === 'WebApplication') return '业务';
  if (normalized === 'BusinessGroup') return '业务组';
  if (normalized === 'ClientBusinessGroup') return '客户端业务组';
  if (normalized === 'PageFamily') return '页面族';
  if (normalized === 'User') return '用户';
  if (normalized === 'DefinedApp' || normalized === 'Application') return '应用';
  return normalized || '当前对象';
}

function isMetricInventoryDetailPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return /(?:详细|详情|展开|具体|明细|全部|所有|列出来|编码|code|metric\s*code|具体指标|分类下|每一类|分别是)/i.test(text);
}

function getMetricInventoryCategories(groupType = '') {
  const normalized = String(groupType || '').trim();
  if (normalized === 'WebApplication' || normalized === 'ClientBusinessGroup') {
    return [
      { name: '业务网络', description: '关注业务页面相关的请求流量、页面流量和页面大小。', sampleIds: ['PGBYTI', 'PGBYTO', 'PGSIZEI', 'PGSIZEO'] },
      { name: '业务访问', description: '关注页面访问次数、访问率以及客户端/服务端访问量。', sampleIds: ['PGNPGE', 'PGNPGC', 'PGNPGS', 'PGRT'] },
      { name: '业务性能', description: '关注页面时延、慢页面率和慢页面占比等用户体验指标。', sampleIds: ['PGSLRT', 'PGSLPCT', 'PGTME'] },
      { name: '响应代码', description: '关注 HTTP 响应数量以及 200/400/500 等状态码分布。', sampleIds: ['PGNOBJE', 'PGHTTP200', 'PGHTTP400', 'PGHTTP500'] },
      { name: '页面优化', description: '关注页面优化覆盖率及部分优化/全优化相关指标。', sampleIds: ['POPT', 'PPOPT', 'PFOPT'] }
    ];
  }

  if (normalized === 'BusinessGroup') {
    return [
      { name: '数据包', description: '关注业务组相关的数据包数量、大小和方向分布。', sampleIds: ['PKIO', 'PKI', 'PKO'] },
      { name: '网络流量', description: '关注吞吐、流量大小以及进出方向流量。', sampleIds: ['TPIO', 'TPI', 'TPO', 'BYTIO'] },
      { name: '传输效率', description: '关注利用率、转发效率等链路传输质量。', sampleIds: ['GPI', 'GPO', 'UTI', 'UTO'] },
      { name: '网络性能', description: '关注丢包、重传、RTT 和时延相关质量指标。', sampleIds: ['PLI', 'PLO', 'RTTI', 'RTXI'] },
      { name: '网络连接', description: '关注连接请求、并发连接、失败连接等连接类指标。', sampleIds: ['CONI', 'CCNI', 'RFCI', 'RFRI'] },
      { name: '应用访问', description: '关注重置、重试、事务请求等应用访问行为。', sampleIds: ['RSTSI', 'RSTSO', 'TRNI', 'TRNO'] },
      { name: '应用性能', description: '关注服务器响应时间、应用响应时间和事务处理性能。', sampleIds: ['TRTI', 'TRTO', 'ARTI', 'ARTO'] },
      { name: '用户体验', description: '关注用户体验指数等体验类指标。', sampleIds: ['UEII', 'UEIO'] },
      { name: '安全分析', description: '关注异常请求、失败连接和行为特征等安全场景指标。', sampleIds: ['CONI', 'RFCI', 'FILI', 'RFRI'] }
    ];
  }

  return [];
}

function expandMetricInventoryPrompt(prompt = '', groupType = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return '';
  }

  if (!isMetricInventoryDetailPrompt(text) || isMetricInventoryPrompt(text)) {
    return text;
  }

  const scopeLabel = getMetricInventoryScopeLabel(groupType);
  return `${scopeLabel}都可以查哪些指标？${text}`;
}

function buildMetricInventoryUserFacingText(result, narration) {
  const summary = isPlainObject(result?.summary) ? result.summary : {};
  const requestUrl = result?.requestUrl || summary?.requestUrl || '';
  const items = Array.isArray(narration?.items) ? narration.items : [];
  if (items.length === 0) {
    return '';
  }

  const groupType = String(result?.resolvedQuery?.groups?.[0]?.type || '').trim();
  const scopeLabel = getMetricInventoryScopeLabel(groupType);
  const timeRangeText = String(
    narration?.timeRange?.displayText
    || result?.narrationInput?.summary?.timeRange?.displayText
    || summary?.timeRange?.displayText
    || ''
  ).trim();
  const sample = items
    .slice(0, 12)
    .map((item) => {
      const id = String(item?.id || '').trim();
      const value = String(item?.value || item?.label || '').trim();
      if (id && value) return `${id}（${value}）`;
      return id || value;
    })
    .filter(Boolean);

  if (sample.length === 0) {
    return '';
  }

  const promptText = String(
    result?.prompt
    || result?.resolvedQuery?.userRequirement
    || result?.narrationInput?.resolvedQuery?.userRequirement
    || ''
  ).trim();
  const detailPrompt = isMetricInventoryDetailPrompt(promptText);
  const categories = getMetricInventoryCategories(groupType);
  const lines = [];
  if (timeRangeText) {
    lines.push(timeRangeText);
  }

  if (categories.length > 0 && !detailPrompt) {
    lines.push(`${scopeLabel}视角可查指标，建议先按指标分类来理解：`);
    categories.forEach((category) => {
      lines.push(`${category.name}：${category.description}`);
    });
    lines.push('如果你要看详细指标，我可以继续按某个分类展开具体指标和编码。');
    return appendDebugApi(lines.join('\n'), requestUrl);
  }

  if (categories.length > 0 && detailPrompt) {
    lines.push(`${scopeLabel}视角下，各指标分类对应的代表指标如下：`);
    categories.forEach((category) => {
      const hits = sample.filter((item) => category.sampleIds.some((id) => item.startsWith(`${id}（`) || item === id));
      const displayItems = hits.length > 0
        ? hits
        : category.sampleIds
          .map((id) => sample.find((item) => item.startsWith(`${id}（`) || item === id))
          .filter(Boolean);
      lines.push(`${category.name}：${displayItems.join('、') || '当前结果未返回该分类代表指标'}`);
    });
    return appendDebugApi(lines.join('\n'), requestUrl);
  }

  lines.push(`${scopeLabel}视角可查指标主要包括：${sample.join('、')}`);
  return appendDebugApi(lines.join('\n'), requestUrl);
}

function buildMetricInventoryDetailTextFromRememberedRecord(prompt = '', rememberedRecord = null) {
  const text = String(prompt || '').trim();
  if (!isMetricInventoryDetailPrompt(text)) {
    return '';
  }

  const result = rememberedRecord?.result;
  const narration = isPlainObject(result?.narrationStructure)
    ? result.narrationStructure
    : (isPlainObject(result?.narrationInput?.result?.narrationStructure)
      ? result.narrationInput.result.narrationStructure
      : null);
  if (!narration) {
    return '';
  }

  const groupType = String(rememberedRecord?.resolvedQuery?.groups?.[0]?.type || result?.resolvedQuery?.groups?.[0]?.type || '').trim();
  const categories = getMetricInventoryCategories(groupType);
  const items = Array.isArray(narration?.items) ? narration.items : [];
  if (!groupType || categories.length === 0 || items.length === 0) {
    return '';
  }

  const summary = isPlainObject(result?.summary) ? result.summary : {};
  const requestUrl = result?.requestUrl || summary?.requestUrl || '';
  const timeRangeText = String(
    narration?.timeRange?.displayText
    || result?.narrationInput?.summary?.timeRange?.displayText
    || summary?.timeRange?.displayText
    || ''
  ).trim();
  const sample = items
    .slice(0, 20)
    .map((item) => {
      const id = String(item?.id || '').trim();
      const value = String(item?.value || item?.label || '').trim();
      if (id && value) return `${id}（${value}）`;
      return id || value;
    })
    .filter(Boolean);
  if (sample.length === 0) {
    return '';
  }

  const lines = [];
  if (timeRangeText) {
    lines.push(timeRangeText);
  }
  lines.push(`${getMetricInventoryScopeLabel(groupType)}视角下，各指标分类对应的代表指标如下：`);
  categories.forEach((category) => {
    const displayItems = category.sampleIds
      .map((id) => sample.find((item) => item.startsWith(`${id}（`) || item === id))
      .filter(Boolean);
    lines.push(`${category.name}：${displayItems.join('、') || '当前结果未返回该分类代表指标'}`);
  });
  return appendDebugApi(lines.join('\n'), requestUrl);
}

function buildMetricInventorySummaryTextFromCategories(groupType = '') {
  const normalized = String(groupType || '').trim();
  const categories = getMetricInventoryCategories(normalized);
  if (categories.length === 0) {
    return '';
  }

  const lines = [`${getMetricInventoryScopeLabel(normalized)}视角可查指标，建议先按指标分类来理解：`];
  categories.forEach((category) => {
    lines.push(`${category.name}：${category.description}`);
  });
  lines.push('如果你要看详细指标，我可以继续按某个分类展开具体指标和编码。');
  return lines.join('\n');
}

function buildMetricInventoryReplyTextFromRememberedRecord(prompt = '', rememberedRecord = null) {
  const text = String(prompt || '').trim();
  if (!text || !rememberedRecord || !isPlainObject(rememberedRecord.result)) {
    return '';
  }

  const rememberedGroup = String(rememberedRecord?.resolvedQuery?.groups?.[0]?.type || '').trim();
  const effectivePrompt = expandMetricInventoryPrompt(text, rememberedGroup);
  if (!isMetricInventoryPrompt(effectivePrompt)) {
    return '';
  }

  const resolvedService = String(rememberedRecord?.resolvedQuery?.service || '').trim();
  const rememberedOperation = String(rememberedRecord?.resolvedQuery?.semanticConstraints?.operation || '').trim();
  if (resolvedService !== 'metrics' || rememberedOperation !== 'metadata_list') {
    return '';
  }

  const expectedGroup = inferMetricInventoryGroup(effectivePrompt);
  if (expectedGroup && rememberedGroup && expectedGroup !== rememberedGroup) {
    return '';
  }

  if (isMetricInventoryDetailPrompt(text)) {
    return buildMetricInventoryDetailTextFromRememberedRecord(text, rememberedRecord);
  }

  const rememberedReply = makeTextReplyFromSkillResult(rememberedRecord.result);
  return String(rememberedReply?.text || '').trim();
}

function buildRememberedSkillReplyText(rememberedRecord = null) {
  if (!rememberedRecord || !isPlainObject(rememberedRecord.result)) {
    return '';
  }

  const rememberedReply = makeTextReplyFromSkillResult(rememberedRecord.result);
  return String(rememberedReply?.text || '').trim();
}

function buildPromptScopedReplyTextFromRememberedRecord(prompt = '', rememberedRecord = null) {
  const text = String(prompt || '').trim();
  if (!text || !rememberedRecord || !isPlainObject(rememberedRecord.result)) {
    return '';
  }

  if (!isOverviewPrompt(text) && !isPacketLossClientTopPrompt(text)) {
    return '';
  }

  const result = rememberedRecord.result;
  if (result?.error) {
    return '';
  }

  const hasRows = Array.isArray(result?.rows) && result.rows.length > 0;
  const hasOverview = isPlainObject(result?.overview);
  if (!hasRows && !hasOverview) {
    return '';
  }

  const rememberedReply = makeTextReplyFromSkillResult(result);
  return String(rememberedReply?.text || '').trim();
}

function containsWrongMetricInventoryContent(groupType = '', content = '') {
  const normalizedGroup = String(groupType || '').trim();
  const text = String(content || '').trim();
  if (!text) {
    return false;
  }

  if (normalizedGroup === 'WebApplication' || normalizedGroup === 'ClientBusinessGroup') {
    return /(?:\bBusinessGroup\b|业务组|工作组|\bBG[A-Z0-9]{2,}\b|BGPKTS|BGBITS|BGRTT|BGRTTP|BGRETRANS|BGRST|总吞吐|入向吞吐|出向吞吐|连接请求数|并发连接数|失败请求数|丢包率|重传率|\bRTT\b|最高告警级别|告警数量)/i.test(text);
  }

  return false;
}

async function buildAsyncRefreshedReplyText(api, prompt, rememberedRecord, conversationKey) {
  const activePrompt = String(prompt || '').trim();
  if (!activePrompt) {
    return '';
  }

  const rememberedDetailText = buildMetricInventoryDetailTextFromRememberedRecord(activePrompt, rememberedRecord);
  if (rememberedDetailText) {
    return rememberedDetailText;
  }

  const rememberedMetricInventoryText = buildMetricInventoryReplyTextFromRememberedRecord(activePrompt, rememberedRecord);
  if (rememberedMetricInventoryText) {
    return rememberedMetricInventoryText;
  }

  if (activePrompt && isOverviewPrompt(activePrompt)) {
    const resolvedService = String(rememberedRecord?.resolvedQuery?.service || '').trim();
    const expectedOverviewScene = normalizeOverviewSceneKey(inferOverviewScene(activePrompt));
    const rememberedOverviewScene = extractOverviewSceneFromRememberedRecord(rememberedRecord);
    const shouldRefreshOverview = resolvedService !== 'overview'
      || rememberedOverviewScene !== expectedOverviewScene;
    if (shouldRefreshOverview) {
      try {
        api.logger.warn('[napm-openclaw-plugin] forcing overview prompt through skill executor before final reply');
        const refreshed = await runSkillExecutor({
          prompt: activePrompt,
          userQuery: activePrompt
        });
        rememberDebugApi(activePrompt, refreshed, conversationKey);
        const refreshedReply = makeTextReplyFromSkillResult(refreshed);
        return refreshedReply.text || '';
      } catch (error) {
        api.logger.error(`[napm-openclaw-plugin] overview refresh failed: ${error.message}`);
      }
    }
  }

  if (shouldRefreshHierarchyCatalog(activePrompt, rememberedRecord)) {
    try {
      api.logger.warn('[napm-openclaw-plugin] forcing hierarchy prompt through skill executor before final reply');
      const refreshed = await runSkillExecutor({
        prompt: activePrompt,
        userQuery: activePrompt
      });
      rememberDebugApi(activePrompt, refreshed, conversationKey);
      const refreshedReply = makeTextReplyFromSkillResult(refreshed);
      return refreshedReply.text || '';
    } catch (error) {
      api.logger.error(`[napm-openclaw-plugin] hierarchy refresh failed: ${error.message}`);
    }
  }

  if (shouldRefreshMetricInventory(activePrompt, rememberedRecord)) {
    try {
      api.logger.warn('[napm-openclaw-plugin] forcing metric-inventory prompt through skill executor before final reply');
      const refreshed = await runSkillExecutor({
        prompt: activePrompt,
        userQuery: activePrompt
      });
      rememberDebugApi(activePrompt, refreshed, conversationKey);
      const refreshedReply = makeTextReplyFromSkillResult(refreshed);
      return refreshedReply.text || '';
    } catch (error) {
      api.logger.error(`[napm-openclaw-plugin] metric inventory refresh failed: ${error.message}`);
      const fallbackGroup = inferMetricInventoryGroup(activePrompt);
      return buildMetricInventorySummaryTextFromCategories(fallbackGroup);
    }
  }

  if (shouldRefreshBusinessObjectInventory(activePrompt, rememberedRecord)) {
    try {
      api.logger.warn('[napm-openclaw-plugin] forcing business-object-inventory prompt through skill executor before final reply');
      const refreshed = await runSkillExecutor({
        prompt: activePrompt,
        userQuery: activePrompt
      });
      rememberDebugApi(activePrompt, refreshed, conversationKey);
      const refreshedReply = makeTextReplyFromSkillResult(refreshed);
      return refreshedReply.text || '';
    } catch (error) {
      api.logger.error(`[napm-openclaw-plugin] business object inventory refresh failed: ${error.message}`);
    }
  }

  return '';
}

function shouldForceGenericNapmSkillRefresh(activePrompt = '', guardState = null, rememberedRecord = null) {
  const prompt = String(activePrompt || '').trim();
  if (!prompt) {
    return false;
  }

  if (
    isOverviewPrompt(prompt)
    || shouldRefreshHierarchyCatalog(prompt, rememberedRecord)
    || shouldRefreshMetricInventory(prompt, rememberedRecord)
    || shouldRefreshBusinessObjectInventory(prompt, rememberedRecord)
  ) {
    return false;
  }

  const napmRelated = Boolean(
    guardState?.napmRelated
    || isNapmRelatedPrompt(prompt)
  );
  if (!napmRelated) {
    return false;
  }

  if (guardState?.turnNapmToolUsed) {
    return false;
  }

  const rememberedPromptKey = normalizePromptKey(rememberedRecord?.result?.prompt || rememberedRecord?.resolvedQuery?.userRequirement || '');
  const currentPromptKey = normalizePromptKey(prompt);
  const rememberedFresh = Boolean(
    rememberedRecord
    && rememberedPromptKey
    && rememberedPromptKey === currentPromptKey
    && (Date.now() - Number(rememberedRecord.updatedAt || 0) <= RESULT_CACHE_MAX_AGE_MS)
  );

  return !rememberedFresh;
}

function canUseGenericNapmSkillRefreshResult(result = null) {
  if (!isPlainObject(result)) {
    return false;
  }

  const errorCode = String(result?.error?.code || '').trim();
  if (errorCode === 'UPSTREAM_RESOLVED_QUERY_REQUIRED') {
    return false;
  }

  if (String(result?.responseMode || '').trim() === 'machine_narration_input') {
    return true;
  }

  if (String(result?.displayText || '').trim()) {
    return true;
  }

  if (String(result?.replyText || '').trim()) {
    return true;
  }

  if (isPlainObject(result?.resolvedQuery)) {
    return true;
  }

  if (Array.isArray(result?.rows) && result.rows.length > 0) {
    return true;
  }

  return false;
}

function shouldRequireSkillBackedReply(activePrompt = '', guardState = null, rememberedRecord = null) {
  const prompt = String(activePrompt || '').trim();
  if (!prompt) {
    return false;
  }

  if (rememberedRecord && isPlainObject(rememberedRecord.result)) {
    return false;
  }

  if (
    isOverviewPrompt(prompt)
    || isHierarchyCatalogPrompt(prompt)
    || isMetricInventoryPrompt(prompt)
    || isMetricInventoryDetailPrompt(prompt)
    || isBusinessObjectInventoryPrompt(prompt)
    || isNapmMetaFollowUpPrompt(prompt, guardState)
  ) {
    return true;
  }

  return Boolean(
    guardState?.napmRelated
    || isNapmRelatedPrompt(prompt)
  );
}

function buildSkillRequiredReply() {
  return [
    '当前问题必须经 NAPM skill 执行后才能回答。',
    '本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。',
    '请以技能执行结果为准。'
  ].join('\n');
}

async function buildGenericNapmSkillRefreshText(api, prompt, conversationKey, conversationState = null) {
  const activePrompt = String(prompt || '').trim();
  if (!activePrompt) {
    return '';
  }

  try {
    let expandedPrompt = activePrompt;
    const rememberedRecord = getRememberedSkillResult(activePrompt, conversationKey);
    const rememberedGroupType = String(
      rememberedRecord?.resolvedQuery?.groups?.[0]?.type
      || conversationState?.lastMetricInventoryGroup
      || ''
    ).trim();
    if (isMetricInventoryDetailPrompt(activePrompt) && rememberedGroupType) {
      expandedPrompt = expandMetricInventoryPrompt(activePrompt, rememberedGroupType);
    }
    api.logger.warn('[napm-openclaw-plugin] forcing generic NAPM prompt through skill executor before final reply');
    const refreshed = await runSkillExecutor({
      prompt: expandedPrompt,
      userQuery: expandedPrompt
    });
    if (!canUseGenericNapmSkillRefreshResult(refreshed)) {
      return '';
    }
    rememberDebugApi(activePrompt, refreshed, conversationKey);
    const refreshedReply = makeTextReplyFromSkillResult(refreshed);
    return refreshedReply.text || '';
  } catch (error) {
    api.logger.error(`[napm-openclaw-plugin] generic NAPM refresh failed: ${error.message}`);
    return '';
  }
}

function selectActivePromptText(conversationState = null, guardState = null, fallbackPrompt = '') {
  const candidates = [
    conversationState?.prompt,
    guardState?.prompt,
    fallbackPrompt
  ]
    .map((item) => String(item || '').trim())
    .filter(isMeaningfulText);

  if (candidates.length === 0) {
    return '';
  }

  const preferred = candidates.find((text) => (
    isMetricInventoryPrompt(text)
    || isMetricInventoryDetailPrompt(text)
    || isHierarchyCatalogPrompt(text)
    || isOverviewPrompt(text)
    || isNapmRelatedPrompt(text)
    || isSystemDomainPrompt(text)
  ));
  return preferred || candidates[0];
}

function extractMessageText(message) {
  if (!message || !Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .map((part) => (part && part.type === 'text' ? String(part.text || '') : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function shouldCancelNapmPreviewMessage(event, ctx, activePrompt = '', guardState = null, rememberedRecord = null) {
  if (shouldAllowNapmReasoningPreviewForCtx(ctx)) {
    return false;
  }
  if (String(ctx?.channelId || '').trim() !== 'wecom') {
    return false;
  }

  const prompt = String(activePrompt || '').trim();
  if (!prompt) {
    return false;
  }

  const napmPrompt = Boolean(
    guardState?.napmRelated
    || isNapmRelatedPrompt(prompt)
    || isOverviewPrompt(prompt)
    || isHierarchyCatalogPrompt(prompt)
    || isMetricInventoryPrompt(prompt)
    || isMetricInventoryDetailPrompt(prompt)
  );
  if (!napmPrompt) {
    return false;
  }

  if (rememberedRecord && isPlainObject(rememberedRecord.result)) {
    return false;
  }

  if (isStreamingPreviewMessageEvent(event)) {
    return true;
  }

  if (guardState?.turnNapmToolUsed && looksLikeInternalReasoningPreview(event?.content)) {
    return true;
  }

  return false;
}

function buildUserFacingSkillText(result) {
  const summary = isPlainObject(result?.summary) ? result.summary : {};
  const requestUrl = result?.requestUrl || summary?.requestUrl || '';
  const displayText = String(result?.displayText || summary?.displayText || '').trim();
  if (displayText) {
    return appendDebugApi(displayText, requestUrl);
  }

  const narration = isPlainObject(result?.narrationStructure)
    ? result.narrationStructure
    : (isPlainObject(result?.narrationInput?.result?.narrationStructure)
      ? result.narrationInput.result.narrationStructure
      : null);
  if (narration) {
    if (String(narration?.responseType || '').trim() === 'topn') {
      const timeRangeText = String(
        narration?.timeRange?.displayText
        || result?.narrationInput?.summary?.timeRange?.displayText
        || summary?.timeRange?.displayText
        || ''
      ).trim();
      const items = Array.isArray(narration.items) ? narration.items : [];
      const topItem = items[0] || null;
      const topObject = String(topItem?.object || '').trim();
      const metricId = String(topItem?.metric || result?.resolvedQuery?.metric || '').trim().toUpperCase();
      const rawValue = Number(topItem?.rawValue ?? topItem?.value);
      const metricUnit = String(topItem?.unit || '').trim() || '%';
      const userRequirement = String(
        result?.prompt
        || result?.resolvedQuery?.userRequirement
        || result?.narrationInput?.resolvedQuery?.userRequirement
        || ''
      ).trim();
      if (
        topObject
        && Number.isFinite(rawValue)
        && ['PLI', 'PLO'].includes(metricId)
        && /(\u4e22\u5305|\u4e22\u5305\u7387|packet\s*loss|loss)/i.test(userRequirement)
      ) {
        const lines = [];
        if (timeRangeText) {
          lines.push(timeRangeText);
        }
        const sortMetric = String(result?.resolvedQuery?.topMetric || summary?.topMetric || '').trim().toUpperCase();
        const rankingText = sortMetric && sortMetric !== metricId
          ? `默认按 ${sortMetric} 排序`
          : `按 ${metricId} 排序`;
        const metricLabel = metricId === 'PLO' ? '\u51fa\u5411\u4e22\u5305\u7387' : '\u6d41\u5165\u4e22\u5305\u7387';
        lines.push(`当前${rankingText}，丢包最大的地址是 ${topObject}，${metricLabel} ${formatNumber(rawValue)}${metricUnit}。`);
        return appendDebugApi(lines.join('\n'), requestUrl);
      }
    }

    if (String(narration?.responseType || '').trim() === 'metric_list') {
      const metricInventoryText = buildMetricInventoryUserFacingText(result, narration);
      if (metricInventoryText) {
        return metricInventoryText;
      }
    }

    const lines = [];
    const timeRangeText = String(
      narration?.timeRange?.displayText
      || result?.narrationInput?.summary?.timeRange?.displayText
      || ''
    ).trim();
    if (timeRangeText) {
      lines.push(timeRangeText);
    }
    if (typeof narration.explanation === 'string' && narration.explanation.trim()) {
      lines.push(narration.explanation.trim());
    }
    const items = Array.isArray(narration.items) ? narration.items : [];
    if (items.length > 0) {
      const sample = items
        .slice(0, 12)
        .map((item) => {
          const id = String(item?.id || '').trim();
          const value = String(item?.value || item?.label || '').trim();
          if (id && value) return `${id}（${value}）`;
          return id || value;
        })
        .filter(Boolean);
      if (sample.length > 0) {
        lines.push(`可查指标示例：${sample.join('、')}`);
      }
    }
    if (lines.length > 0) {
      return appendDebugApi(lines.join('\n'), requestUrl);
    }
  }
  return '';
}

function makeTextReplyFromSkillResult(result) {
  const summary = isPlainObject(result?.summary) ? result.summary : {};
  const decision = isPlainObject(result?.decision) ? result.decision : {};
  const displayText = buildUserFacingSkillText(result);
  if (displayText) {
    return makeTextReply(displayText);
  }

  const highlights = Array.isArray(summary.highlights)
    ? summary.highlights.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  const lines = [];
  if (typeof summary.title === 'string' && summary.title.trim()) {
    lines.push(summary.title.trim());
  }
  if (highlights.length > 0) {
    lines.push(...highlights);
  }
  if (decision.next_action === 'ASK_CLARIFYING_QUESTION' && decision.clarifying_question) {
    lines.push(String(decision.clarifying_question).trim());
  }
  if (decision.next_action === 'REJECT_AND_REDIRECT' && lines.length === 0) {
    lines.push('这个请求不属于 NAPM 查询技能范围，请改问 NAPM 查询、分析、解释或结果解读相关问题。');
  }
  if (lines.length === 0) {
    lines.push(JSON.stringify(result, null, 2));
  }

  return makeTextReply(lines.join('\n'));
}

function makeToolResult(result) {
  const displayText = buildUserFacingSkillText(result);
  return {
    content: [
      {
        type: 'text',
        text: displayText || JSON.stringify(result, null, 2)
      }
    ],
    details: result
  };
}

function createHttpToolDefinition(name, label, description, parameters, endpoint, payloadBuilder) {
  return {
    label,
    name,
    description,
    parameters,
    execute: async (_toolCallId, args) => {
      const toolArgs = isPlainObject(args) ? args : {};
      const forwardedPrompt = getDirectToolForwardPrompt(toolArgs);
      const shouldForward = shouldForwardDirectToolToSkill(name, toolArgs)
        || (isDirectNapmTool(name) && Boolean(forwardedPrompt) && isOverviewPrompt(forwardedPrompt));

      let result;
      if (shouldForward) {
        const forwardedSkillArgs = buildForwardSkillArgsFromDirectTool(toolArgs);
        result = await runSkillExecutor(forwardedSkillArgs || { prompt: forwardedPrompt, userQuery: forwardedPrompt });
      } else {
        result = await runSkillExecutor({ resolvedQuery: payloadBuilder(toolArgs) });
      }

      rememberDebugApi(forwardedPrompt || normalizePrompt(toolArgs), result, null);
      return makeToolResult(result);
    }
  };
}

function createSkillToolDefinition() {
  return {
    label: 'NAPM Skill Query',
    name: 'napm-skill-query',
    description: 'Run the OpenClaw NAPM skill executor first. Use this for any NAPM-related request, including boundary checks for restart/deploy/config/code/db-internal asks about monitored objects like 239web or HIS. The tool returns a structured decision and only executes queries when the skill allows it.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt for the NAPM skill.' },
        userQuery: { type: 'string', description: 'Alias of prompt if provided externally.' },
        decision: { type: 'object', description: 'Optional structured decision object.', additionalProperties: true },
        intent: { type: 'object', description: 'Optional structured intent object.', additionalProperties: true },
        resolvedQuery: { type: 'object', description: 'Optional fully resolved query payload.', additionalProperties: true },
        sessionState: { type: 'object', description: 'Optional multi-turn session state.', additionalProperties: true },
        clarificationContext: { type: 'object', description: 'Optional clarification state.', additionalProperties: true },
        policyAction: { type: 'string', description: 'Optional upstream policy action override.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args) => {
      const preparedArgs = prepareSkillExecutionArgs(args || {});
      const result = await runSkillExecutor(preparedArgs);
      rememberDebugApi(normalizePrompt(preparedArgs), result, null);
      return makeToolResult(result);
    }
  };
}

function registerCommand(api, definition) {
  api.registerCommand({
    name: definition.name,
    description: definition.description,
    acceptsArgs: true,
    async handler(ctx) {
      const prompt = typeof ctx.args === 'string' ? ctx.args.trim() : '';
      if (!prompt && definition.name === 'napm-skill-query') {
        return { text: 'Usage: /napm-skill-query <your NAPM question>' };
      }

      if (definition.name === 'napm-skill-query') {
        const skillArgs = prepareSkillExecutionArgs({ prompt, userQuery: prompt });
        const result = await runSkillExecutor(skillArgs);
        rememberDebugApi(prompt, result, null);
        return makeTextReplyFromSkillResult(result);
      }

      const result = await runSkillExecutor({ resolvedQuery: definition.payloadBuilder({ prompt, userQuery: prompt }) });
      rememberDebugApi(prompt, result, null);
      return makeTextReplyFromSkillResult(result);
    }
  });
}

function buildNapmRoutingSystemContext() {
  return [
    'You are not a general-purpose assistant in this deployment. Only handle system monitoring, performance analysis, NAPM query, anomaly diagnosis, and result interpretation requests.',
    'When the user asks about NAPM, NetInside, monitored applications, monitored websites, business systems, WebApplication objects, or known monitored objects such as 239web and HIS, you must call the tool `napm-skill-query` with the raw user prompt before using exec, shell, restart, deployment, or other system-operation tools.',
    'Questions about hierarchy or drilldown structure, such as which drilldown paths a BusinessGroup or IPAddress supports, must also go through `napm-skill-query` instead of being answered from general knowledge.',
    'Do not use `napm-timeseries`, `napm-topn`, or `napm-average` for raw natural-language NAPM questions. Only use those direct tools when metric/group/start/end are already explicit canonical NAPM parameters.',
    'This rule also applies to boundary-check requests such as restart, deploy, modify config, inspect SQL, code debugging, or DB-internal asks when they mention NAPM-monitored objects.',
    'If `napm-skill-query` returns decision.next_action=`REJECT_AND_REDIRECT`, do not call exec, shell, restart, deployment, or configuration tools. Explain that the request is outside the NAPM skill boundary and invite the user to ask a NAPM query, analysis, explanation, or result-interpretation question instead.',
    'If `napm-skill-query` returns `ASK_CLARIFYING_QUESTION`, ask that clarification and stop.',
    'If `napm-skill-query` returns `ANSWER_CONCEPTUALLY` or `INTERPRET_RESULT`, answer from that result and stop.',
    'If `napm-skill-query` returns `displayText` or `summary.displayText`, prefer using that text directly instead of paraphrasing it.',
    'For any NAPM data question, including repeated or follow-up wording, never answer from stale conversation memory alone. You must base the reply on a fresh NAPM tool result from the current turn.',
    'If the tool result contains `requestUrl`, you must append `Debug API:` followed by that exact URL at the end of your final reply.',
    'If the request is clearly unrelated to system monitoring or NAPM, such as weather, casual chat, reminders, entertainment, or general knowledge, do not answer the request. Briefly redirect the user back to system monitoring, anomaly analysis, or result interpretation questions.'
  ].join('\n');
}

const skillTool = createSkillToolDefinition();
const topnTool = createHttpToolDefinition(
  'napm-topn',
  'NAPM TopN',
  'Run a direct NAPM TopN query through the semantic gateway.',
  {
    type: 'object',
    properties: {
      metric: { type: 'string' },
      group: { type: 'string' },
      topCount: { type: 'number' },
      start: { type: 'number' },
      end: { type: 'number' }
    },
    additionalProperties: false
  },
  'local://napm.query.topn',
  buildTopnPayload
);

const averageTool = createHttpToolDefinition(
  'napm-average',
  'NAPM Average',
  'Run a direct NAPM average query through the semantic gateway.',
  {
    type: 'object',
    properties: {
      metric: { type: 'string' },
      metrics: { type: 'array', items: { type: 'string' } },
      group: { type: 'string' },
      groupArgument: { type: 'string' },
      start: { type: 'number' },
      end: { type: 'number' }
    },
    additionalProperties: false
  },
  'local://napm.query.average',
  buildAveragePayload
);

const timeseriesTool = createHttpToolDefinition(
  'napm-timeseries',
  'NAPM Timeseries',
  'Run a direct NAPM trend query through the semantic gateway.',
  {
    type: 'object',
    properties: {
      metric: { type: 'string' },
      group: { type: 'string' },
      groupArgument: { type: 'string' },
      start: { type: 'number' },
      end: { type: 'number' },
      granularity: { type: 'string' }
    },
    additionalProperties: false
  },
  'local://napm.query.timeseries',
  buildTimeseriesPayload
);

const plugin = {
  id: 'napm-openclaw-plugin',
  name: 'NAPM OpenClaw Plugin',
  description: 'Bridge NAPM skill and query requests from OpenClaw into the deployed NAPM semantic gateway.',
  register(api) {
    api.registerTool(skillTool);
    api.registerTool(topnTool);
    api.registerTool(averageTool);
    api.registerTool(timeseriesTool);

    api.registerHook(
      'message_received',
      (event, ctx) => {
        const conversationKey = getConversationKey(ctx);
        const content = extractTextContent(event?.content ?? event?.message?.content);
        const previousState = conversationKey ? (napmConversationState.get(conversationKey) || null) : null;
        const nextState = {
          ...buildConversationScopedGuardState(content, previousState),
          promptKey: normalizePromptKey(content)
        };

        if (conversationKey) {
          napmConversationState.set(conversationKey, nextState);
        }

        setGuardState(ctx, nextState);
      },
      {
        name: 'napm-message-scope-detect',
        description: 'Track whether the latest incoming message is in the system-monitoring domain, NAPM-related, or out of scope.'
      }
    );

    api.registerHook(
      ['before_prompt_build', 'before_agent_start'],
      (event, ctx) => {
        const prompt = typeof event?.prompt === 'string' ? event.prompt.trim() : '';
        const guardKeys = getGuardKeys(ctx);
        const promptOverviewRelated = isOverviewPrompt(prompt);
        const promptDomainRelated = promptOverviewRelated || isSystemDomainPrompt(prompt);
        const promptNapmRelated = promptOverviewRelated || isNapmRelatedPrompt(prompt);
        const promptOutOfScopeBoundaryRequested = promptDomainRelated && isOutOfScopeNapmRequest(prompt);
        const promptGeneralOutOfScopeRequested = Boolean(prompt) && !promptDomainRelated;
        if (guardKeys.length > 0) {
          const conversationKey = getConversationKey(ctx);
          const previousConversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
          if (conversationKey && isMeaningfulText(prompt)) {
            napmConversationState.set(conversationKey, {
              ...buildConversationScopedGuardState(prompt, previousConversationState),
              promptKey: normalizePromptKey(prompt)
            });
          }
          const conversationState = conversationKey ? napmConversationState.get(conversationKey) : previousConversationState;
          const effectiveNapmRelated = promptNapmRelated || Boolean(conversationState?.napmRelated);
          const effectiveDomainRelated = promptDomainRelated || Boolean(conversationState?.domainRelated);
          const guardState = {
            prompt,
            napmRelated: effectiveNapmRelated,
            domainRelated: effectiveDomainRelated,
            generalOutOfScopeRequested: prompt
              ? !effectiveDomainRelated
              : (promptGeneralOutOfScopeRequested || Boolean(conversationState?.generalOutOfScopeRequested)),
            outOfScopeBoundaryRequested: effectiveDomainRelated
              && (
                promptOutOfScopeBoundaryRequested
                || (!prompt && Boolean(conversationState?.outOfScopeBoundaryRequested))
              ),
            turnNapmToolUsed: Boolean(getGuardState(ctx)?.turnNapmToolUsed),
            updatedAt: Date.now()
          };
          setGuardState(ctx, guardState);
          api.logger.info(`[napm-openclaw-plugin] stored guard state keys=${guardKeys.join(',')} generalOutOfScope=${guardState.generalOutOfScopeRequested} outOfScopeBoundary=${guardState.outOfScopeBoundaryRequested} napmRelated=${guardState.napmRelated}`);
        }
        if (prompt) {
          api.logger.info(`[napm-openclaw-plugin] injecting NAPM routing policy for prompt: ${prompt.slice(0, 120)}`);
        }
        return {
          appendSystemContext: buildNapmRoutingSystemContext()
        };
      },
      {
        name: 'napm-routing-policy',
        description: 'Force NAPM-related and monitored-object requests to pass through napm-skill-query before system-operation tools.'
      }
    );

    api.registerHook(
      'before_tool_call',
      (event, ctx) => {
        const guardKeys = getGuardKeys(ctx);
        const guardState = getGuardState(ctx);
        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const toolName = String(event?.toolName || '').trim();
        const toolParams = isPlainObject(event?.params) ? event.params : {};
        api.logger.info(`[napm-openclaw-plugin] before_tool_call tool=${toolName} keys=${guardKeys.join(',') || 'none'} guard=${guardState ? 'hit' : 'miss'}`);

        const fallbackPrompt = normalizePrompt(toolParams);
        const activePrompt = selectActivePromptText(conversationState, guardState, fallbackPrompt);
        const activePromptState = derivePromptGuardState(activePrompt, conversationState, guardState);

        if ((activePromptState?.generalOutOfScopeRequested || activePromptState?.outOfScopeBoundaryRequested) && !SAFE_NAPM_TOOL_NAMES.has(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked tool for out-of-scope prompt: tool=${toolName}`);
          return {
            block: true,
            blockReason: 'This deployment only answers system monitoring and NAPM-related questions.'
          };
        }

        const activeNapmPrompt = Boolean(activePrompt)
          && (
            Boolean(activePromptState?.napmRelated)
            || isOverviewPrompt(activePrompt)
            || isNapmRelatedPrompt(activePrompt)
          );

        if (toolName === 'napm-skill-query' && activeNapmPrompt && activePrompt) {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          const canonicalSkillParams = buildCanonicalSkillToolParams(activePrompt, toolParams);
          const originalPrompt = normalizePrompt(toolParams);
          const canonicalPrompt = normalizePrompt(canonicalSkillParams);
          const originalResolvedGroup = String(toolParams?.resolvedQuery?.groups?.[0]?.type || '').trim();
          const canonicalResolvedGroup = String(canonicalSkillParams?.resolvedQuery?.groups?.[0]?.type || '').trim();
          if (
            canonicalPrompt
            && (
              canonicalPrompt !== originalPrompt
              || canonicalResolvedGroup !== originalResolvedGroup
            )
          ) {
            api.logger.warn(`[napm-openclaw-plugin] canonicalized napm-skill-query params: originalPrompt=${originalPrompt || 'none'} canonicalPrompt=${canonicalPrompt} originalGroup=${originalResolvedGroup || 'none'} canonicalGroup=${canonicalResolvedGroup || 'none'}`);
            return {
              params: canonicalSkillParams
            };
          }
        }

        if (activeNapmPrompt && isDirectNapmTool(toolName) && activePrompt && !shouldForwardDirectToolToSkill(toolName, toolParams)) {
          const rerouteReason = toolArgsLookCanonicalForDirectNapm(toolName, toolParams)
            ? 'skill_only_direct_tool_guard'
            : 'skill_only_non_canonical_direct_tool';
          api.logger.warn(`[napm-openclaw-plugin] rerouting direct NAPM tool to skill executor: tool=${toolName} reason=${rerouteReason}`);
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          return {
            params: buildDirectToolForwardParams(toolParams, activePrompt, rerouteReason)
          };
        }

        if (activeNapmPrompt && !SAFE_NAPM_TOOL_NAMES.has(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked non-skill tool for NAPM-scoped prompt: tool=${toolName}`);
          return {
            block: true,
            blockReason: 'NAPM natural-language requests must call napm-skill-query first and may not invoke other tools directly.'
          };
        }

        if (activeNapmPrompt && SAFE_NAPM_TOOL_NAMES.has(toolName)) {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
        }

        if (!activeNapmPrompt || !isDangerousSystemTool(toolName)) {
          return undefined;
        }

        api.logger.warn(`[napm-openclaw-plugin] blocked dangerous tool for NAPM-scoped prompt: tool=${toolName}`);
        return {
          block: true,
          blockReason: 'NAPM-scoped requests must stay inside napm-skill-query and may not invoke system-operation tools.'
        };
      },
      {
        name: 'napm-boundary-tool-guard',
        description: 'Block shell and system-operation tools when the active prompt is NAPM-related or references monitored objects.'
      }
    );

    api.registerHook(
      'message_sending',
      async (event, ctx) => {
        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const guardState = getGuardState(ctx);
        const generalOutOfScopeRequested = Boolean(
          conversationState?.generalOutOfScopeRequested
          || guardState?.generalOutOfScopeRequested
        );
        const outOfScopeBoundaryRequested = Boolean(
          conversationState?.outOfScopeBoundaryRequested
          || guardState?.outOfScopeBoundaryRequested
        );
        if (generalOutOfScopeRequested) {
          return {
            content: buildGeneralOutOfScopeReply()
          };
        }

        if (!outOfScopeBoundaryRequested) {
          const activePrompt = selectActivePromptText(conversationState, guardState, extractTextContent(event?.content));
          const rememberedRecord = getRememberedSkillResult(activePrompt, conversationKey)
            || getRememberedSkillResult(activePrompt, '')
            || getRememberedMetricInventoryFollowUpRecord(activePrompt, conversationState, conversationKey)
            || (isMetricInventoryDetailPrompt(activePrompt) ? getRecentRememberedSkillResult(conversationKey) : null);
          const requiresSkillBackedReply = shouldRequireSkillBackedReply(activePrompt, guardState, rememberedRecord);
          if (shouldAllowNapmReasoningPreviewForCtx(ctx) && isStreamingPreviewMessageEvent(event)) {
            return undefined;
          }
          const leakedReasoningText = extractTextContent(event?.content);
          const leakedBypassProcessText = looksLikeNapmBypassProcessText(leakedReasoningText);
          const rememberedReasoningFallbackText = !shouldAllowNapmReasoningPreviewForCtx(ctx) && looksLikeInternalReasoningPreview(leakedReasoningText)
            ? buildRememberedSkillReplyText(rememberedRecord)
            : '';
          if (rememberedReasoningFallbackText) {
            return {
              content: rememberedReasoningFallbackText
            };
          }
          if (leakedBypassProcessText) {
            const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
            if (rememberedReplyText) {
              return {
                content: rememberedReplyText
              };
            }
            const refreshedText = await buildAsyncRefreshedReplyText(api, activePrompt, rememberedRecord, conversationKey);
            if (refreshedText) {
              return {
                content: refreshedText
              };
            }
            const genericNapmRefreshText = shouldForceGenericNapmSkillRefresh(activePrompt, guardState, rememberedRecord)
              ? await buildGenericNapmSkillRefreshText(api, activePrompt, conversationKey, conversationState)
              : '';
            if (genericNapmRefreshText) {
              return {
                content: genericNapmRefreshText
              };
            }
            return {
              content: buildSkillRequiredReply()
            };
          }
          if (shouldCancelNapmPreviewMessage(event, ctx, activePrompt, guardState, rememberedRecord)) {
            api.logger.warn('[napm-openclaw-plugin] canceled streaming preview before NAPM final reply was ready');
            return {
              cancel: true
            };
          }
          if (requiresSkillBackedReply && !rememberedRecord) {
            if (isStreamingPreviewMessageEvent(event)) {
              return {
                cancel: true
              };
            }
            const refreshedText = await buildAsyncRefreshedReplyText(api, activePrompt, rememberedRecord, conversationKey);
            if (refreshedText) {
              return {
                content: refreshedText
              };
            }
            const genericNapmRefreshText = shouldForceGenericNapmSkillRefresh(activePrompt, guardState, rememberedRecord)
              ? await buildGenericNapmSkillRefreshText(api, activePrompt, conversationKey, conversationState)
              : '';
            if (genericNapmRefreshText) {
              return {
                content: genericNapmRefreshText
              };
            }
            return {
              content: buildSkillRequiredReply()
            };
          }
          const refreshedText = await buildAsyncRefreshedReplyText(api, activePrompt, rememberedRecord, conversationKey);
          if (refreshedText) {
            return {
              content: refreshedText
            };
          }

          const genericNapmRefreshText = shouldForceGenericNapmSkillRefresh(activePrompt, guardState, rememberedRecord)
            ? await buildGenericNapmSkillRefreshText(api, activePrompt, conversationKey, conversationState)
            : '';
          if (genericNapmRefreshText) {
            return {
              content: genericNapmRefreshText
            };
          }

          const requestUrl = getRememberedDebugApi(conversationState?.prompt, conversationKey) || getRecentDebugApiFallback();
          if (!requestUrl || !shouldExposeUpstreamApi()) {
            return undefined;
          }
          return {
            content: appendDebugApi(event?.content, requestUrl)
          };
        }

        return {
          content: buildSoftBoundaryReply()
        };
      },
      {
        name: 'napm-out-of-scope-rewriter',
        description: 'Rewrite outgoing replies for NAPM-related out-of-scope requests into a soft redirect back to system monitoring and analysis questions.'
      }
    );

    api.registerHook(
      'before_message_write',
      (event, ctx) => {
        const message = event?.message;
        const role = String(message?.role || '').trim();
        if (role !== 'assistant') {
          return undefined;
        }

        const guardKeys = getGuardKeys(ctx);
        const guardState = getGuardState(ctx);
        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        api.logger.info(`[napm-openclaw-plugin] before_message_write role=${role} keys=${guardKeys.join(',') || 'none'} guard=${guardState ? 'hit' : 'miss'}`);
        if (guardState?.generalOutOfScopeRequested || conversationState?.generalOutOfScopeRequested) {
          api.logger.warn('[napm-openclaw-plugin] rewriting assistant message for general out-of-scope request');
          return {
            message: buildAssistantTextMessage(buildGeneralOutOfScopeReply(), message)
          };
        }

        if (guardState?.outOfScopeBoundaryRequested || conversationState?.outOfScopeBoundaryRequested) {
          api.logger.warn('[napm-openclaw-plugin] rewriting assistant message for NAPM boundary request');
          return {
            message: buildAssistantTextMessage(buildSoftBoundaryReply(), message)
          };
        }

        const activePrompt = selectActivePromptText(conversationState, guardState, extractMessageText(message));
        const rememberedRecord = getRememberedSkillResult(activePrompt, conversationKey)
          || getRememberedSkillResult(activePrompt, '')
          || getRememberedMetricInventoryFollowUpRecord(activePrompt, conversationState, conversationKey)
          || (isMetricInventoryDetailPrompt(activePrompt) ? getRecentRememberedSkillResult(conversationKey) : null);
        const requiresSkillBackedReply = shouldRequireSkillBackedReply(activePrompt, guardState, rememberedRecord);
        const rememberedPromptScopedText = buildPromptScopedReplyTextFromRememberedRecord(activePrompt, rememberedRecord);
        if (rememberedPromptScopedText) {
          return {
            message: buildAssistantTextMessage(rememberedPromptScopedText, message)
          };
        }
        const existingText = extractMessageText(message);
        if (looksLikeNapmBypassProcessText(existingText)) {
          const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord) || buildSkillRequiredReply();
          return {
            message: buildAssistantTextMessage(rememberedReplyText, message)
          };
        }
        const rememberedReasoningFallbackText = !shouldAllowNapmReasoningPreviewForCtx(ctx) && looksLikeInternalReasoningPreview(existingText)
          ? buildRememberedSkillReplyText(rememberedRecord)
          : '';
        if (rememberedReasoningFallbackText) {
          return {
            message: buildAssistantTextMessage(rememberedReasoningFallbackText, message)
          };
        }
        if (requiresSkillBackedReply && !rememberedRecord) {
          return {
            message: buildAssistantTextMessage(buildSkillRequiredReply(), message)
          };
        }
        const metricInventoryGroup = inferMetricInventoryGroup(expandMetricInventoryPrompt(activePrompt, conversationState?.lastMetricInventoryGroup || ''));
        if (
          metricInventoryGroup
          && !isMetricInventoryDetailPrompt(activePrompt)
          && containsWrongMetricInventoryContent(metricInventoryGroup, existingText)
        ) {
          const fallbackText = buildMetricInventorySummaryTextFromCategories(metricInventoryGroup);
          if (fallbackText) {
            return {
              message: buildAssistantTextMessage(fallbackText, message)
            };
          }
        }

        return undefined;
      },
      {
        name: 'napm-before-message-write-guard',
        description: 'Rewrite assistant transcript messages for out-of-scope prompts before they are written and delivered.'
      }
    );

    registerCommand(api, {
      name: 'napm-skill-query',
      description: 'Call the NAPM skill bridge command.',
      endpoint: 'local://napm.skill.query',
      payloadBuilder: buildSkillPayload
    });
    registerCommand(api, {
      name: 'napm-topn',
      description: 'Run an NAPM TopN query.',
      endpoint: 'local://napm.query.topn',
      payloadBuilder: buildTopnPayload
    });
    registerCommand(api, {
      name: 'napm-average',
      description: 'Run an NAPM average query.',
      endpoint: 'local://napm.query.average',
      payloadBuilder: buildAveragePayload
    });
    registerCommand(api, {
      name: 'napm-timeseries',
      description: 'Run an NAPM timeseries query.',
      endpoint: 'local://napm.query.timeseries',
      payloadBuilder: buildTimeseriesPayload
    });
  }
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.__test__ = {
  getBoundaryMode,
  isStrictBoundaryMode,
  applyPathPreflightToResolvedQuery,
  buildCanonicalSkillToolParams,
  buildBusinessObjectInventoryResolvedQuery,
  buildRememberedSkillReplyText,
  buildSkillRequiredReply,
  buildOverviewResolvedQuery,
  buildMetricInventoryResolvedQuery,
  buildPacketLossClientTopResolvedQuery,
  buildPromptScopedReplyTextFromRememberedRecord,
  inferOverviewScene,
  inferMetricInventoryGroup,
  isBusinessObjectInventoryPrompt,
  isHierarchyCatalogPrompt,
  isMetricInventoryPrompt,
  isMetricInventoryDetailPrompt,
  isNapmMetaFollowUpPrompt,
  isPacketLossClientTopPrompt,
  looksLikeNapmBypassProcessText,
  shouldForceGenericNapmSkillRefresh,
  shouldRequireSkillBackedReply,
  canUseGenericNapmSkillRefreshResult,
  normalizeHierarchyQuestionTarget,
  normalizeOverviewSceneKey,
  shouldReplaceWithPromptOverview,
  rememberSkillResult,
  shouldRefreshBusinessObjectInventory,
  shouldRefreshHierarchyCatalog,
  shouldRefreshMetricInventory,
  prepareSkillExecutionArgs,
  shouldAllowNapmReasoningPreview,
  extractOverviewSceneFromRememberedRecord
};
