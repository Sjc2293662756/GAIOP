const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const NAPM_DIRECT_SKILL_MODE = true;
const NAPM_SKILL_EXECUTOR = process.env.NAPM_SKILL_EXECUTOR
  || path.join(process.env.HOME || '/home/netinside', '.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js');
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
let cachedNapmResolvedQueryResolverService = null;
let napmResolvedQueryResolverLookupComplete = false;
let skillDotenvLoaded = false;
const RESULT_CACHE_MAX_AGE_MS = 90 * 1000;
const AUDIT_LOG_PATH = process.env.NAPM_AUDIT_LOG_PATH || '/home/netinside/.openclaw/logs/audit.log';
const SAFE_NAPM_TOOL_NAMES = new Set(['napm-skill-query']);
const DEV_RESOLVER_TOOL_NAMES = new Set([
  'napm-resolve-query',
  'napm-mainflow-query'
]);
const NAPM_OBJECT_PATTERNS = [
  /napm/i,
  /netinside/i,
  /239web/i,
  /\bhis\b/i,
  /观枢/,
  /智维/
];
const NAPM_DOMAIN_PATTERNS = [
  /系统/,
  /网络/,
  /应用/,
  /业务/,
  /web\s*application/i,
  /webapp/i,
  /网站/,
  /页面/,
  /流量/,
  /吞吐/,
  /响应/,
  /时延/,
  /延迟/,
  /异常/,
  /告警/,
  /丢包/,
  /重传/,
  /性能/,
  /监控/,
  /http/i,
  /[45]xx/i
];
const SYSTEM_DOMAIN_HINT_PATTERNS = [
  /服务/,
  /结果/,
  /分析/,
  /排查/,
  /趋势/,
  /排行/,
  /排名/,
  /情况/,
  /状态/
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

  return /(?:Node\.js\s*脚本|python3|Python\s*解析|grep|bash|curl|cURL|NetInside\s*底层|底层\s*API|原始\s*API|直接调(?:用)?|绕过|跨过|没走\s*skill|没有走\s*skill|没走任何中间层|napm-skill-query\s*.*拒绝|resolvedQuery\s*.*(?:没|未|没有)构造|NapmMetadataService|单例导出|重试|写好.*脚本写入文件|调了\s+NapmMetadataService|直接调用.*getDrilldownPathsForGroupType|解析\s*JSON\s*失败)/i.test(content);
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

const AUDIT_SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'token',
  'authorization',
  'secret'
]);

function truncateAuditText(value = '', maxLength = 4000) {
  const text = String(value == null ? '' : value);
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}...[truncated:${text.length - maxLength}]`
    : text;
}

function sanitizeAuditValue(value, depth = 0) {
  if (value == null) {
    return value;
  }

  if (depth >= 5) {
    return '[max-depth]';
  }

  if (typeof value === 'string') {
    return truncateAuditText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => sanitizeAuditValue(item, depth + 1));
    if (value.length > 50) {
      items.push(`[truncated:${value.length - 50}]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 80);
    const normalized = {};
    entries.forEach(([key, item]) => {
      if (AUDIT_SENSITIVE_KEYS.has(String(key || '').toLowerCase())) {
        normalized[key] = '[masked]';
        return;
      }
      normalized[key] = sanitizeAuditValue(item, depth + 1);
    });
    if (Object.keys(value).length > 80) {
      normalized.__truncated__ = Object.keys(value).length - 80;
    }
    return normalized;
  }

  return String(value);
}

function appendPluginAuditEvent(event, payload = {}) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const normalizedPayload = sanitizeAuditValue(payload);
    const entry = {
      timestamp: new Date().toISOString(),
      channel: 'audit',
      service: 'napm-openclaw-plugin',
      event
    };
    if (isPlainObject(normalizedPayload)) {
      Object.assign(entry, normalizedPayload);
    } else {
      entry.payload = normalizedPayload;
    }
    fs.appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (_error) {
    // best-effort audit logging only
  }
}

function normalizeTraceId(value = '') {
  const text = String(value || '').trim();
  return text ? truncateAuditText(text, 160) : '';
}

function buildNapmTraceId(ctx = {}, args = {}) {
  const explicit = normalizeTraceId(args?.traceId || args?.sessionState?.traceId);
  if (explicit) {
    return explicit;
  }

  const contextParts = [
    ctx?.runId,
    ctx?.messageId,
    ctx?.conversationId,
    ctx?.sessionId,
    ctx?.sessionKey,
    ctx?.agentId
  ]
    .map((item) => normalizeTraceId(item))
    .filter(Boolean);

  if (contextParts.length > 0) {
    return truncateAuditText(`napm-${contextParts.join('-')}`, 160);
  }

  return `napm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildAuditContextSnapshot(ctx = {}) {
  return {
    conversationId: ctx?.conversationId || null,
    runId: ctx?.runId || null,
    messageId: ctx?.messageId || null,
    sessionId: ctx?.sessionId || null,
    sessionKey: ctx?.sessionKey || null,
    agentId: ctx?.agentId || null,
    accountId: ctx?.accountId || null,
    channelId: ctx?.channelId || null
  };
}

function summarizeResolvedQueryForAudit(resolvedQuery = null) {
  if (!isPlainObject(resolvedQuery)) {
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

function collectNapmResolvedQueryResolverModuleCandidates() {
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

  pushCandidate(path.resolve(__dirname, 'skills', 'openclaw-napm-query', 'services', 'NapmResolvedQueryResolverService.js'));
  pushCandidate(path.resolve(__dirname, '..', 'skills', 'openclaw-napm-query', 'services', 'NapmResolvedQueryResolverService.js'));
  pushCandidate(path.resolve(__dirname, '..', '..', 'skills', 'openclaw-napm-query', 'services', 'NapmResolvedQueryResolverService.js'));

  const workspaceRoot = getSkillWorkspaceRootFromExecutor();
  if (workspaceRoot) {
    pushCandidate(path.join(workspaceRoot, 'skills', 'openclaw-napm-query', 'services', 'NapmResolvedQueryResolverService.js'));
  }

  pushCandidate(path.resolve(process.cwd(), 'skills', 'openclaw-napm-query', 'services', 'NapmResolvedQueryResolverService.js'));
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

function getNapmResolvedQueryResolverService() {
  if (napmResolvedQueryResolverLookupComplete) {
    return cachedNapmResolvedQueryResolverService;
  }

  loadSkillDotenvIfAvailable();
  napmResolvedQueryResolverLookupComplete = true;
  for (const candidate of collectNapmResolvedQueryResolverModuleCandidates()) {
    try {
      cachedNapmResolvedQueryResolverService = require(candidate);
      break;
    } catch (_error) {
      // try next candidate
    }
  }

  return cachedNapmResolvedQueryResolverService;
}

function getBoundaryMode() {
  return 'strict';
}

function isStrictBoundaryMode() {
  return getBoundaryMode() === 'strict';
}

function shouldEnableDevResolverTools() {
  const raw = String(process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isSafeNapmToolName(toolName) {
  const normalized = String(toolName || '').trim();
  if (SAFE_NAPM_TOOL_NAMES.has(normalized)) {
    return true;
  }
  return shouldEnableDevResolverTools() && DEV_RESOLVER_TOOL_NAMES.has(normalized);
}

function getResolutionSpecQueryContract() {
  const service = getResolutionSpecService();
  if (service && typeof service.getQueryContract === 'function') {
    return service.getQueryContract() || null;
  }
  return null;
}

function getResolutionSpecObjectAliases() {
  const service = getResolutionSpecService();
  if (service && typeof service.getObjectAliases === 'function') {
    return service.getObjectAliases() || {};
  }
  return {};
}

function getResolutionSpecRoutingRules() {
  const service = getResolutionSpecService();
  if (service && typeof service.getRoutingRules === 'function') {
    return service.getRoutingRules() || {};
  }
  return {};
}

function getResolutionSpecMetadataRules() {
  const service = getResolutionSpecService();
  if (service && typeof service.getMetadataRules === 'function') {
    return service.getMetadataRules() || {};
  }
  return {};
}

function hasExplicitResolvedQuery(args = {}) {
  return isPlainObject(args?.resolvedQuery);
}

function validateResolvedQueryAgainstSpec(resolvedQuery = {}) {
  if (!isPlainObject(resolvedQuery)) {
    return {
      ok: false,
      reason: 'missing_resolved_query',
      message: 'NAPM natural-language requests must include a structured resolvedQuery before calling napm-skill-query.'
    };
  }

  const serviceName = String(resolvedQuery.service || '').trim();
  if (!serviceName) {
    return {
      ok: false,
      reason: 'missing_service',
      message: 'resolvedQuery.service is required before calling napm-skill-query.'
    };
  }

  const service = getResolutionSpecService();
  const serviceSpec = service && typeof service.getServiceSpec === 'function'
    ? service.getServiceSpec(serviceName)
    : null;
  if (!serviceSpec) {
    return {
      ok: false,
      reason: 'unknown_service',
      message: `resolvedQuery.service=${serviceName} is not declared in napm-resolution-spec.v1.json.`
    };
  }

  const requiredFields = Array.isArray(serviceSpec.required) ? serviceSpec.required : [];
  const missingFields = [];
  requiredFields.forEach((field) => {
    if (field === 'timeRange') {
      const start = Number(resolvedQuery.start);
      const end = Number(resolvedQuery.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
        missingFields.push('start/end');
      }
      return;
    }

    const value = resolvedQuery[field];
    if (field === 'groups') {
      if (!Array.isArray(value) || value.length === 0) {
        missingFields.push(field);
      }
      return;
    }

    if (field === 'metrics') {
      if (!Array.isArray(value) || value.length === 0) {
        missingFields.push(field);
      }
      return;
    }

    if (field === 'protocolQueries') {
      if (!Array.isArray(value) || value.length === 0) {
        missingFields.push(field);
      }
      return;
    }

    if (value == null || (typeof value === 'string' && !value.trim())) {
      missingFields.push(field);
    }
  });

  if (missingFields.length > 0) {
    return {
      ok: false,
      reason: 'incomplete_resolved_query',
      message: `resolvedQuery is missing required fields for service=${serviceName}: ${missingFields.join(', ')}.`
    };
  }

  return {
    ok: true,
    serviceSpec
  };
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
  return resolvedQuery;
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

function isBusinessGroupInventoryPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasGroupScope = /(BusinessGroup|业务组|工作组|业务分组)/i.test(text);
  if (!hasGroupScope) {
    return false;
  }

  const hasInventoryIntent = /(?:(?:系统中|系统里|当前|现在)?[^，。！？\n]{0,8}(?:有哪些|有什么|有哪几个|都有哪些|包含哪些)|列出[^，。！？\n]{0,8}|查看[^，。！？\n]{0,8}|查询[^，。！？\n]{0,8})(?:BusinessGroup|业务组|工作组|业务分组)|(?:BusinessGroup|业务组|工作组|业务分组)[^，。！？\n]{0,8}(?:有哪些|有什么|有哪几个|都有哪些|列表|清单)/i.test(text);
  if (!hasInventoryIntent) {
    return false;
  }

  return !isMetricInventoryPrompt(text)
    && !isHierarchyCatalogPrompt(text)
    && !isOverviewPrompt(text);
}

function buildBusinessObjectInventoryResolvedQuery(prompt = '') {
  return null;
}

function buildMetricInventoryResolvedQuery(prompt = '') {
  return null;
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
  return null;
}

function buildOverviewResolvedQuery(prompt = '') {
  return null;
}

function resolvePromptInjectedResolvedQuery(prompt = '', currentResolvedQuery = undefined, options = {}) {
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
  return null;
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
  if (!normalized || isSafeNapmToolName(normalized)) {
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
    traceId: typeof args.traceId === 'string' ? args.traceId : undefined,
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
  if (!normalizeTraceId(preparedArgs.traceId)) {
    preparedArgs.traceId = buildNapmTraceId({}, preparedArgs);
  }
  const payload = buildSkillPayload(preparedArgs);
  const traceId = normalizeTraceId(payload.traceId) || buildNapmTraceId({}, preparedArgs);
  if (!payload.traceId) {
    payload.traceId = traceId;
  }
  if (isPluginStructuredOverviewInjection(args, preparedArgs)) {
    payload.__pluginOverviewStructured = true;
  }
  appendPluginAuditEvent('napm_plugin_skill_executor_invoked', {
    traceId,
    prompt: normalizePrompt(preparedArgs),
    boundaryMode: getBoundaryMode(),
    resolvedQuery: normalizeObject(payload.resolvedQuery) || null,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(payload.resolvedQuery),
    sessionStatePresent: Boolean(payload.sessionState)
  });

  try {
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

    appendPluginAuditEvent('napm_plugin_skill_executor_completed', {
      traceId,
      prompt: normalizePrompt(preparedArgs),
      ok: Boolean(result?.ok),
      service: String(result?.service || result?.resolvedQuery?.service || '').trim() || null,
      responseType: String(result?.responseType || '').trim() || null,
      summaryMode: String(result?.summary?.mode || '').trim() || null,
      requestUrl: getRequestUrlFromResult(result) || null,
      resolvedQuery: isPlainObject(result?.resolvedQuery) ? result.resolvedQuery : null,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(result?.resolvedQuery),
      error: isPlainObject(result?.error)
        ? result.error
        : (result?.error ? { message: String(result.error) } : null),
      executorStderr: result.executorStderr || null
    });

    return result;
  } catch (error) {
    appendPluginAuditEvent('napm_plugin_skill_executor_failed', {
      traceId,
      prompt: normalizePrompt(preparedArgs),
      resolvedQuery: normalizeObject(payload.resolvedQuery) || null,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(payload.resolvedQuery),
      error: {
        code: error?.code || null,
        message: error?.message || String(error)
      }
    });
    throw error;
  }
}

function buildResolvedQueryForPrompt(prompt = '', args = {}) {
  return {
    source: 'none',
    result: null,
    resolvedQuery: null
  };
}

async function runResolvedSkillExecutor(args = {}) {
  const prompt = normalizePrompt(args);
  const traceId = normalizeTraceId(args?.traceId) || `napm-resolved-refresh-${Date.now()}`;
  const nextArgs = isPlainObject(args) ? { ...args } : {};
  if (!isPlainObject(nextArgs.resolvedQuery)) {
    const resolverPrompt = normalizePrompt(args?.resolverPrompt || '') || prompt;
    const resolved = buildResolvedQueryForPrompt(resolverPrompt, args);
    if (isPlainObject(resolved.resolvedQuery)) {
      nextArgs.resolvedQuery = resolved.resolvedQuery;
      if (resolverPrompt !== prompt) {
        nextArgs.resolvedQuery = {
          ...nextArgs.resolvedQuery,
          userRequirement: prompt
        };
      }
      appendPluginAuditEvent('napm_resolver_resolved_query_created', {
        traceId,
        prompt,
        resolverPrompt,
        source: resolved.source,
        ok: true,
        intent: normalizeObject(resolved.result?.intent) || null,
        resolvedQuery: normalizeObject(nextArgs.resolvedQuery) || null,
        resolvedQuerySummary: summarizeResolvedQueryForAudit(nextArgs.resolvedQuery),
        diagnostics: normalizeObject(resolved.result?.diagnostics) || null
      });
    }
  }
  nextArgs.traceId = traceId;
  return runSkillExecutor(nextArgs);
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

function buildRemovedDirectToolReply(toolName = '') {
  const normalized = String(toolName || '').trim() || 'legacy NAPM direct tool';
  return {
    ok: false,
    error: `${normalized} has been removed from this deployment. Use napm-skill-query and let OpenClaw construct structured resolvedQuery instead.`,
    nextAction: 'USE_NAPM_SKILL_QUERY'
  };
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

function isMetricInventoryDetailPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return /(?:详细|详情|展开|具体|明细|全部|所有|列出来|编码|code|metric\s*code|具体指标|分类下|每一类|分别是)/i.test(text);
}

function buildRememberedSkillReplyText(rememberedRecord = null) {
  if (!rememberedRecord || !isPlainObject(rememberedRecord.result)) {
    return '';
  }

  const rememberedReply = makeTextReplyFromSkillResult(rememberedRecord.result);
  return String(rememberedReply?.text || '').trim();
}

function buildSkillRequiredReply() {
  return [
    '当前问题必须经 NAPM skill 执行后才能回答。',
    '本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。',
    '请以技能执行结果为准。'
  ].join('\n');
}

function hasVerifiableSkillRecord(record = null) {
  return Boolean(
    record
    && isPlainObject(record.result)
    && isPlainObject(record.resolvedQuery || record.result?.resolvedQuery)
    && !record.result?.error
  );
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
    || isBusinessGroupInventoryPrompt(prompt)
    || isNapmMetaFollowUpPrompt(prompt, guardState)
  ) {
    return true;
  }

  return Boolean(
    guardState?.napmRelated
    || isNapmRelatedPrompt(prompt)
  );
}

function buildExecutionTraceReplyFromRememberedRecord(record = null) {
  if (!hasVerifiableSkillRecord(record)) {
    return [
      '当前没有可核验的 NAPM skill 执行记录，不能确认刚才实际走了哪条查询链路。',
      '因此我不会补写任何未被日志证明的执行过程。',
      '需要以本轮真实的 napm-skill-query 记录和 audit 日志为准。'
    ].join('\n');
  }

  const result = record.result;
  const resolvedQuery = record.resolvedQuery || result.resolvedQuery || {};
  const service = String(resolvedQuery.service || result.service || '').trim() || 'unknown';
  const metric = String(resolvedQuery.topMetric || resolvedQuery.metric || '').trim();
  const groups = Array.isArray(resolvedQuery.groups)
    ? resolvedQuery.groups
      .map((group) => String(group?.argument || group?.type || '').trim())
      .filter(Boolean)
    : [];
  const requestUrl = getRequestUrlFromResult(result);
  const lines = [
    '这次只能按已记录的 NAPM skill 结果说明查询链路：',
    `工具：napm-skill-query`,
    `service：${service}`
  ];

  if (metric) {
    lines.push(`metric：${metric}`);
  }
  if (groups.length > 0) {
    lines.push(`groups：${groups.join(' > ')}`);
  }
  if (requestUrl) {
    lines.push(`Debug API：${requestUrl}`);
  } else {
    lines.push('Debug API：本条 skill 结果未记录 requestUrl。');
  }
  lines.push('未发现可核验记录时，不能补写任何未被日志证明的执行过程。');

  return lines.join('\n');
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
  const displayText = String(result?.displayText || summary?.displayText || result?.replyText || '').trim();
  return displayText ? appendDebugApi(displayText, requestUrl) : '';
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

function createSkillToolDefinition() {
  const queryContract = getResolutionSpecQueryContract() || {};
  const acceptedInputs = Array.isArray(queryContract.acceptedInputs)
    ? queryContract.acceptedInputs.join(', ')
    : 'payload.resolvedQuery';
  return {
    label: 'NAPM Skill Query',
    name: 'napm-skill-query',
    description: `Run the NAPM skill executor with a structured resolvedQuery already produced by OpenClaw upstream. This is the only production NAPM tool entry; use it after intent resolution, object scoping, time-range resolution, and query shaping are complete. Accepted structured input channel: ${acceptedInputs}.`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability after resolvedQuery has been constructed.' },
        userQuery: { type: 'string', description: 'Alias of prompt for traceability only; do not rely on this instead of resolvedQuery for structured NAPM queries.' },
        decision: { type: 'object', description: 'Optional structured decision object.', additionalProperties: true },
        intent: { type: 'object', description: 'Optional structured intent object.', additionalProperties: true },
        resolvedQuery: { type: 'object', description: 'Required fully resolved query payload for NAPM data, metadata, ranking, trend, overview, and hierarchy requests.', additionalProperties: true },
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

function resolvePromptWithAudit(args = {}, tracePrefix = 'napm-resolver') {
  const prompt = normalizePrompt(args);
  const traceId = normalizeTraceId(args?.traceId) || `${tracePrefix}-${Date.now()}`;
  appendPluginAuditEvent('napm_resolver_request_received', {
    traceId,
    prompt,
    source: 'openclaw_tool'
  });

  const resolver = getNapmResolvedQueryResolverService();
  let result = null;
  if (!resolver || typeof resolver.resolvePrompt !== 'function') {
    result = {
      ok: false,
      source: 'openclaw_mainflow_resolver',
      prompt,
      reason: 'resolver_unavailable',
      message: 'NAPM resolvedQuery resolver service is unavailable.'
    };
  } else {
    result = resolver.resolvePrompt(prompt, {
      nowSeconds: args?.nowSeconds
    });
  }

  appendPluginAuditEvent(result?.ok ? 'napm_resolver_resolved_query_created' : 'napm_resolver_failed', {
    traceId,
    prompt,
    ok: Boolean(result?.ok),
    reason: result?.reason || null,
    intent: normalizeObject(result?.intent) || null,
    resolvedQuery: normalizeObject(result?.resolvedQuery) || null,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(result?.resolvedQuery),
    diagnostics: normalizeObject(result?.diagnostics) || null
  });

  return {
    traceId,
    prompt,
    result
  };
}

async function runMainflowQuery(args = {}) {
  const { traceId, prompt, result: resolverResult } = resolvePromptWithAudit(args, 'napm-mainflow');
  if (!resolverResult?.ok || !isPlainObject(resolverResult?.resolvedQuery)) {
    return {
      ok: false,
      source: 'openclaw_mainflow_query',
      prompt,
      resolverResult
    };
  }

  const skillArgs = prepareSkillExecutionArgs({
    prompt,
    userQuery: prompt,
    traceId,
    resolvedQuery: resolverResult.resolvedQuery
  });
  const skillResult = await runSkillExecutor(skillArgs);
  rememberDebugApi(prompt, skillResult, null);
  appendPluginAuditEvent('napm_mainflow_skill_completed', {
    traceId,
    prompt,
    resolvedQuery: normalizeObject(skillArgs.resolvedQuery) || null,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(skillArgs.resolvedQuery),
    requestUrl: skillResult?.requestUrl || null,
    decision: normalizeObject(skillResult?.decision) || null
  });
  return {
    ok: true,
    source: 'openclaw_mainflow_query',
    prompt,
    resolverResult,
    skillResult
  };
}

function makeMainflowToolResult(result = {}) {
  if (isPlainObject(result?.skillResult)) {
    const displayText = buildUserFacingSkillText(result.skillResult);
    return {
      content: [
        {
          type: 'text',
          text: displayText || JSON.stringify(result.skillResult, null, 2)
        }
      ],
      details: result
    };
  }
  return makeToolResult(result);
}

function createResolvedQueryResolverToolDefinition() {
  return {
    label: 'NAPM Resolve Query',
    name: 'napm-resolve-query',
    description: 'Diagnostic-only NAPM resolver. Enable with NAPM_ENABLE_DEV_RESOLVER_TOOLS=true to inspect local prompt-to-resolvedQuery behavior. This tool is not registered in production.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original NAPM natural-language user prompt.' },
        userQuery: { type: 'string', description: 'Alias of prompt.' },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' },
        nowSeconds: { type: 'number', description: 'Optional deterministic current timestamp in seconds for tests.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const { result } = resolvePromptWithAudit(args, 'napm-resolver');
      return makeToolResult(result);
    }
  };
}

function createMainflowQueryToolDefinition() {
  return {
    label: 'NAPM Mainflow Query',
    name: 'napm-mainflow-query',
    description: 'Diagnostic-only NAPM mainflow runner. Enable with NAPM_ENABLE_DEV_RESOLVER_TOOLS=true to resolve a prompt locally and execute the skill. This tool is not registered in production.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original NAPM natural-language user prompt.' },
        userQuery: { type: 'string', description: 'Alias of prompt.' },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' },
        nowSeconds: { type: 'number', description: 'Optional deterministic current timestamp in seconds for tests.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => makeMainflowToolResult(await runMainflowQuery(args))
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

      if (definition.name === 'napm-resolve-query') {
        const { result } = resolvePromptWithAudit({ prompt, userQuery: prompt }, 'napm-resolver-command');
        return makeTextReply(JSON.stringify(result, null, 2));
      }

      if (definition.name === 'napm-mainflow-query') {
        const result = await runMainflowQuery({ prompt, userQuery: prompt });
        if (isPlainObject(result?.skillResult)) {
          return makeTextReplyFromSkillResult(result.skillResult);
        }
        return makeTextReply(JSON.stringify(result, null, 2));
      }

      if (definition.name === 'napm-skill-query') {
        const skillArgs = prepareSkillExecutionArgs({ prompt, userQuery: prompt });
        const result = await runSkillExecutor(skillArgs);
        rememberDebugApi(prompt, result, null);
        return makeTextReplyFromSkillResult(result);
      }

      if (typeof definition.payloadBuilder !== 'function') {
        return makeTextReply(JSON.stringify({ ok: false, reason: 'unsupported_command', command: definition.name }, null, 2));
      }

      const result = await runSkillExecutor({ resolvedQuery: definition.payloadBuilder({ prompt, userQuery: prompt }) });
      rememberDebugApi(prompt, result, null);
      return makeTextReplyFromSkillResult(result);
    }
  });
}

function buildNapmRoutingSystemContext() {
  const queryContract = getResolutionSpecQueryContract() || {};
  const objectAliases = getResolutionSpecObjectAliases();
  const routingRules = getResolutionSpecRoutingRules();
  const metadataRules = getResolutionSpecMetadataRules();
  const businessGroupAliases = Array.isArray(objectAliases?.BusinessGroup) ? objectAliases.BusinessGroup.join(' / ') : '业务组 / 工作组 / BusinessGroup';
  const webApplicationAliases = Array.isArray(objectAliases?.WebApplication) ? objectAliases.WebApplication.join(' / ') : '业务 / 业务系统 / Web应用 / WebApplication';
  const metricInventoryRule = metadataRules?.metrics || '当用户询问某对象维度支持哪些指标时使用 metrics metadata 查询。';
  const groupInventoryRule = metadataRules?.groups || '当用户询问有哪些对象或某对象维度下有哪些成员时使用 groups metadata 查询。';
  const hierarchyRule = metadataRules?.drilldownCatalog || '当用户询问层级、下钻路径、结构或可达路径时使用 drilldownCatalog。';
  const businessInventoryService = String(routingRules?.inventory?.businessObjectInventory?.service || 'groups');
  const businessInventoryMode = String(routingRules?.inventory?.businessObjectInventory?.queryModeKey || 'metadata');
  const metricInventoryService = String(routingRules?.inventory?.metricInventory?.service || 'metrics');
  const metricInventoryMode = String(routingRules?.inventory?.metricInventory?.queryModeKey || 'metadata');
  const acceptedInputs = Array.isArray(queryContract?.acceptedInputs)
    ? queryContract.acceptedInputs.join(', ')
    : 'payload.resolvedQuery';

  return [
    'You are not a general-purpose assistant in this deployment. Only handle system monitoring, performance analysis, NAPM query, anomaly diagnosis, and result interpretation requests.',
    'When the user asks a NAPM question, call `napm-skill-query` only after OpenClaw upstream has produced a complete structured `resolvedQuery`.',
    '`napm-resolve-query` and `napm-mainflow-query` are diagnostic-only tools and are not production query paths. Do not choose them unless they are explicitly enabled for development diagnostics.',
    `The accepted structured input channel is: ${acceptedInputs}. Do not rely on raw prompt only when the request is a data query, metadata inventory query, ranking, average, trend, or overview request.`,
    'OpenClaw upstream is the owner of resolvedQuery construction. The NAPM plugin only forwards structured queries, and the NAPM skill only executes them.',
    `Interpret plain monitored business wording such as ${webApplicationAliases} as WebApplication scope unless the user explicitly asks for ${businessGroupAliases}.`,
    `Interpret explicit ${businessGroupAliases} wording as BusinessGroup scope.`,
    `For inventory questions, use ${groupInventoryRule} Example: "系统中有哪些工作组？" -> service=${businessInventoryService}, queryModeKey=${businessInventoryMode}, semanticConstraints.operation=metadata_list, groups=[{type:"BusinessGroup"}].`,
    `For business-system inventory questions, Example: "系统中有哪些业务系统？" -> service=${businessInventoryService}, queryModeKey=${businessInventoryMode}, semanticConstraints.operation=metadata_list, groups=[{type:"WebApplication"}].`,
    `For metric-inventory questions, use ${metricInventoryRule} Example: "业务都可以查哪些指标？" -> service=${metricInventoryService}, queryModeKey=${metricInventoryMode}, semanticConstraints.operation=metadata_list, groups=[{type:"WebApplication"}]. Example: "工作组都可以查哪些指标？" -> service=${metricInventoryService}, queryModeKey=${metricInventoryMode}, semanticConstraints.operation=metadata_list, groups=[{type:"BusinessGroup"}].`,
    `For hierarchy questions, use ${hierarchyRule} Example: "BusinessGroup 可以往下钻到哪里？" -> service=drilldownCatalog, groups=[{type:"BusinessGroup"}].`,
    'Questions about hierarchy or drilldown structure, such as which drilldown paths a BusinessGroup or IPAddress supports, must also go through `napm-skill-query` as structured resolvedQuery instead of being answered from general knowledge.',
    'The legacy direct tools `napm-timeseries`, `napm-topn`, and `napm-average` have been removed from this deployment to avoid bypassing the resolvedQuery-first production entry.',
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
const resolverTool = createResolvedQueryResolverToolDefinition();
const mainflowTool = createMainflowQueryToolDefinition();

const plugin = {
  id: 'napm-openclaw-plugin',
  name: 'NAPM OpenClaw Plugin',
  description: 'Bridge NAPM skill and query requests from OpenClaw into the deployed NAPM semantic gateway.',
  register(api) {
    if (shouldEnableDevResolverTools()) {
      api.registerTool(resolverTool);
      api.registerTool(mainflowTool);
    }
    api.registerTool(skillTool);

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

        if ((activePromptState?.generalOutOfScopeRequested || activePromptState?.outOfScopeBoundaryRequested) && !isSafeNapmToolName(toolName)) {
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

        if (isDirectNapmTool(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked removed legacy direct tool: tool=${toolName}`);
          return {
            block: true,
            blockReason: `${toolName} has been removed from this deployment. Use napm-skill-query instead.`
          };
        }

        if (toolName === 'napm-skill-query' && activeNapmPrompt && activePrompt) {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          const traceId = buildNapmTraceId(ctx, toolParams);
          const canonicalSkillParams = buildCanonicalSkillToolParams(activePrompt, {
            ...toolParams,
            traceId
          });
          const originalPrompt = normalizePrompt(toolParams);
          const canonicalPrompt = normalizePrompt(canonicalSkillParams);
          const originalTraceId = normalizeTraceId(toolParams?.traceId);
          const canonicalTraceId = normalizeTraceId(canonicalSkillParams?.traceId);
          const originalResolvedGroup = String(toolParams?.resolvedQuery?.groups?.[0]?.type || '').trim();
          const canonicalResolvedGroup = String(canonicalSkillParams?.resolvedQuery?.groups?.[0]?.type || '').trim();
          const boundaryMode = getBoundaryMode();
          const resolvedQueryValidation = validateResolvedQueryAgainstSpec(canonicalSkillParams?.resolvedQuery);
          const promptLooksStructuredMetaRequest = Boolean(
            isMetricInventoryPrompt(activePrompt)
            || isBusinessObjectInventoryPrompt(activePrompt)
            || isBusinessGroupInventoryPrompt(activePrompt)
            || isHierarchyCatalogPrompt(activePrompt)
            || isOverviewPrompt(activePrompt)
            || isPacketLossClientTopPrompt(activePrompt)
          );
          appendPluginAuditEvent('napm_plugin_skill_call_received', {
            traceId,
            toolName,
            prompt: activePrompt,
            originalPrompt: originalPrompt || null,
            boundaryMode,
            promptLooksStructuredMetaRequest,
            validation: {
              ok: Boolean(resolvedQueryValidation.ok),
              reason: resolvedQueryValidation.reason || null,
              message: resolvedQueryValidation.message || null
            },
            originalResolvedQuery: normalizeObject(toolParams.resolvedQuery) || null,
            originalResolvedQuerySummary: summarizeResolvedQueryForAudit(toolParams.resolvedQuery),
            canonicalResolvedQuery: normalizeObject(canonicalSkillParams.resolvedQuery) || null,
            canonicalResolvedQuerySummary: summarizeResolvedQueryForAudit(canonicalSkillParams.resolvedQuery),
            context: buildAuditContextSnapshot(ctx)
          });
          if (!resolvedQueryValidation.ok && (boundaryMode === 'strict' || promptLooksStructuredMetaRequest)) {
            api.logger.warn(`[napm-openclaw-plugin] blocked napm-skill-query without valid resolvedQuery: reason=${resolvedQueryValidation.reason} prompt=${activePrompt.slice(0, 120)}`);
            appendPluginAuditEvent('napm_plugin_resolved_query_blocked', {
              traceId,
              toolName,
              prompt: activePrompt,
              boundaryMode,
              reason: resolvedQueryValidation.reason || null,
              message: resolvedQueryValidation.message || null,
              resolvedQuery: normalizeObject(canonicalSkillParams.resolvedQuery) || null,
              resolvedQuerySummary: summarizeResolvedQueryForAudit(canonicalSkillParams.resolvedQuery),
              context: buildAuditContextSnapshot(ctx)
            });
            return {
              block: true,
              blockReason: `${resolvedQueryValidation.message} OpenClaw must construct resolvedQuery first.`
            };
          }
          const shouldRewriteSkillParams = Boolean(
            canonicalPrompt
            && (
              canonicalPrompt !== originalPrompt
              || canonicalResolvedGroup !== originalResolvedGroup
              || canonicalTraceId !== originalTraceId
            )
          );
          appendPluginAuditEvent('napm_plugin_resolved_query_forwarded', {
            traceId,
            toolName,
            prompt: activePrompt,
            boundaryMode,
            canonicalized: shouldRewriteSkillParams,
            validation: {
              ok: Boolean(resolvedQueryValidation.ok),
              reason: resolvedQueryValidation.reason || null
            },
            resolvedQuery: normalizeObject(canonicalSkillParams.resolvedQuery) || null,
            resolvedQuerySummary: summarizeResolvedQueryForAudit(canonicalSkillParams.resolvedQuery),
            context: buildAuditContextSnapshot(ctx)
          });
          if (
            shouldRewriteSkillParams
          ) {
            api.logger.warn(`[napm-openclaw-plugin] canonicalized napm-skill-query params: originalPrompt=${originalPrompt || 'none'} canonicalPrompt=${canonicalPrompt} originalGroup=${originalResolvedGroup || 'none'} canonicalGroup=${canonicalResolvedGroup || 'none'}`);
            return {
              params: canonicalSkillParams
            };
          }
        }

        if (activeNapmPrompt && !isSafeNapmToolName(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked non-skill tool for NAPM-scoped prompt: tool=${toolName}`);
          return {
            block: true,
            blockReason: 'NAPM requests must use the single production entry napm-skill-query with an upstream-produced resolvedQuery. Resolver/mainflow diagnostic tools are not production query paths.'
          };
        }

        if (activeNapmPrompt && isSafeNapmToolName(toolName)) {
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
          if (isNapmMetaFollowUpPrompt(activePrompt, guardState)) {
            return {
              content: buildExecutionTraceReplyFromRememberedRecord(rememberedRecord)
            };
          }
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
            return {
              content: buildSkillRequiredReply()
            };
          }

          return undefined;
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

    if (shouldEnableDevResolverTools()) {
      registerCommand(api, {
        name: 'napm-resolve-query',
        description: 'Diagnostic-only: construct a NAPM resolvedQuery from a natural-language prompt.',
        endpoint: 'local://napm.resolve.query'
      });

      registerCommand(api, {
        name: 'napm-mainflow-query',
        description: 'Diagnostic-only: resolve a NAPM prompt into resolvedQuery and execute it through napm-skill-query.',
        endpoint: 'local://napm.mainflow.query'
      });
    }
  }
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.__test__ = {
  getBoundaryMode,
  isStrictBoundaryMode,
  shouldEnableDevResolverTools,
  isSafeNapmToolName,
  applyPathPreflightToResolvedQuery,
  buildCanonicalSkillToolParams,
  buildBusinessObjectInventoryResolvedQuery,
  buildRememberedSkillReplyText,
  buildExecutionTraceReplyFromRememberedRecord,
  buildSkillRequiredReply,
  buildOverviewResolvedQuery,
  buildMetricInventoryResolvedQuery,
  buildPacketLossClientTopResolvedQuery,
  createResolvedQueryResolverToolDefinition,
  createMainflowQueryToolDefinition,
  getNapmResolvedQueryResolverService,
  resolvePromptWithAudit,
  runMainflowQuery,
  inferOverviewScene,
  inferMetricInventoryGroup,
  isBusinessObjectInventoryPrompt,
  isHierarchyCatalogPrompt,
  isMetricInventoryPrompt,
  isMetricInventoryDetailPrompt,
  isNapmMetaFollowUpPrompt,
  isPacketLossClientTopPrompt,
  looksLikeNapmBypassProcessText,
  shouldRequireSkillBackedReply,
  normalizeHierarchyQuestionTarget,
  normalizeOverviewSceneKey,
  shouldReplaceWithPromptOverview,
  rememberSkillResult,
  prepareSkillExecutionArgs,
  shouldAllowNapmReasoningPreview,
  extractOverviewSceneFromRememberedRecord
};
