const fs = require('node:fs');
const path = require('node:path');

const NAPM_DIRECT_SKILL_MODE = true;
const OPENCLAW_SKILLS_ROOT = process.env.OPENCLAW_SKILLS_ROOT
  || path.join(process.env.HOME || '/home/netinside', '.openclaw/workspace/skills');

// ── In-process Skill loaders (2026-07-07) ─────────────────────────────────
// 替代 execFileAsync subprocess spawn，改为同进程 require() 调用。
// 每次 execute() 前 delete require.cache 确保远端更新后能热加载。
function loadSkill(skillDir, scriptName) {
  const skillPath = path.join(OPENCLAW_SKILLS_ROOT, skillDir, 'scripts', scriptName);
  try {
    delete require.cache[require.resolve(skillPath)];
  } catch (_e) {
    // 首次加载，缓存中可能没有
  }
  return require(skillPath);
}

const napmQuerySkill = () => loadSkill('openclaw-napm-query', 'run_napm_query.js');
const napmReportSkill = () => loadSkill('openclaw-napm-report', 'generate_napm_report.js');
const napmPacketSkill = () => loadSkill('openclaw-napm-packet-analysis', 'run_packet_analysis.js');
const napmAlertSkill = () => loadSkill('openclaw-napm-alert-query', 'run_alert_query.js');
const napmInspectionSkill = () => loadSkill('openclaw-napm-inspection', 'run_inspection_snapshot.js');
const napmSummarySkill = () => loadSkill('openclaw-napm-summary', 'run_summary.js');
const napmFaultDiagnosisSkill = () => loadSkill('openclaw-napm-fault-diagnosis', 'run_fault_diagnosis.js');
const napmGuardState = new Map();
const napmConversationState = new Map();
const napmDebugApiByPrompt = new Map();
const napmResultByPrompt = new Map();
const napmSentMediaByConversation = new Map();
let latestNapmDebugApi = null;
let latestNapmResult = null;
let latestReportExportResult = null;
let cachedGroupPathPlannerService = null;
let groupPathPlannerLookupComplete = false;
let cachedPromptRoutingService = null;
let promptRoutingLookupComplete = false;
let cachedWorkflowClassifierService = null;
let workflowClassifierLookupComplete = false;
let cachedResolutionSpecService = null;
let resolutionSpecLookupComplete = false;
let cachedNapmResolvedQueryResolverService = null;
let napmResolvedQueryResolverLookupComplete = false;
let skillDotenvLoaded = false;
const RESULT_CACHE_MAX_AGE_MS = 90 * 1000;
const SENT_MEDIA_DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const REPORT_EXPORT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
let pendingAlertDisplayText = null;
const AUDIT_LOG_PATH = process.env.NAPM_AUDIT_LOG_PATH || '/home/netinside/.openclaw/logs/audit.log';
const SAFE_NAPM_TOOL_NAMES = new Set(['napm-skill-query', 'napm-report-export', 'napm-packet-analysis', 'napm-alert-query', 'napm-inspection-snapshot', 'napm-summary', 'napm-fault-diagnosis']);
const ALERT_CATEGORY_LABELS = {
  networkAlerts: '网络性能告警',
  networkIssueAlerts: '网络异常告警',
  appAlerts: '应用性能告警',
  busAlerts: '业务故障告警',
  userAlerts: '用户体验告警',
  securityAlerts: '安全事件告警',
  AIAlerts: '智能分析告警'
};
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
  const hasMetaIntent = /(?:思路|构成|构造|怎么查(?:询)?|如何查(?:询)?|查询流程|查询过程|怎么拼|怎么组|来源|依据|为什么这样|返回给我|最终的?|最终api|方法来源|耗时|多长时间|时间都消耗在哪里|耗在哪里|谁在做|谁做的|谁执行|工具|python\s*过滤|过滤输出|exec|有没有走\s*skill|是否走\s*skill|走没走\s*skill|napm-skill-query|中间管道|中间层)/i.test(text);
  const previousNapmRelated = Boolean(previousState?.napmRelated || previousState?.domainRelated);

  if (hasMetaIntent && previousNapmRelated) {
    return true;
  }

  return hasReference && hasMetaIntent;
}

function isAlertEventPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  if (/\b(?:alertsSummary|alertsSummaryTimeLine|alertsDetail)\b/i.test(text)) {
    return true;
  }

  if (/(?:Email|SNMP|SysLog|快照)[^，。！？\n]{0,12}告警|告警[^，。！？\n]{0,24}(?:Email|SNMP|SysLog|快照|通知|动作|字段|配置)/i.test(text)) {
    return true;
  }

  if (!/告警/.test(text)) {
    return false;
  }

  return /(?:有哪些|有什么|有没有|是否有|查(?:询)?|列(?:出)?|列表|清单|摘要|明细|详情|事件|event\s*id|id|时间线|趋势|数量|统计|汇总|紧急|重大|轻微|严重|触发|原因|为什么|关联|数据包|napm-alert-query|告警查询\s*skill|告警\s*skill)/i.test(text);
}

function isAlertSkillMetaFollowUpPrompt(prompt = '', previousState = null) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const mentionsAlertSkill = /(?:告警|napm-alert-query|alert\s*query|alertsSummary|alertsDetail|alertsSummaryTimeLine)/i.test(text);
  return Boolean(
    (isNapmMetaFollowUpPrompt(text, previousState) && (mentionsAlertSkill || previousState?.alertRelated))
    || /(?:告警查询\s*skill|告警\s*skill|napm-alert-query)[^，。！？\n]{0,24}(?:用了|使用|调用|走了|执行|是否|是不是|有没有)/i.test(text)
    || /(?:用了|使用|调用|走了|执行|是否|是不是|有没有)[^，。！？\n]{0,24}(?:告警查询\s*skill|告警\s*skill|napm-alert-query)/i.test(text)
  );
}

function isFaultDiagnosisPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;

  // Direct mentions of fault/diagnosis/error analysis
  if (/(?:故障分析|故障诊断|故障报告|错误分析|报错分析|页面错误|HTTP\s*[45]\d{2}|[45]xx)/i.test(text)) {
    return true;
  }

  // "XXweb 的 400/500 报错" or "XXweb 的错误情况"
  if (/(?:web|业务|应用|系统).*(?:故障|错误|报错|异常|400|500)[^，。！？\n]{0,30}(?:分析|报告|诊断|排查|情况)/i.test(text)) {
    return true;
  }

  // "分析XXweb的故障" or "排查XXweb报错"
  if (/(?:分析|查看|检查|排查|给出).*(?:web|业务|应用).*(?:故障|错误|报错|异常|情况|报告)/i.test(text)) {
    return true;
  }

  return false;
}

function isSummaryPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;

  // Direct mentions of summary report types — always a summary report request
  if (/(?:综述报告|全局综述|业务综述|应用综述|业务组综述|网络综述|告警综述|summary\s*report|overview\s*report)/i.test(text)) {
    return true;
  }

  // Daily/weekly/monthly 报告 — always a report request
  if (/(?:日报|周报|月报)/i.test(text)) {
    return true;
  }

  // "报告" + time context = report request (not overview query)
  // "最近X天的报告", "最近24小时的报告" etc.
  if (/报告/.test(text) && /(?:最近|今天|昨天|本周|本月|过去)/i.test(text)) {
    return true;
  }

  return false;
}

function looksLikeNapmBypassProcessText(text = '') {
  const content = String(text || '').trim();
  if (!content) {
    return false;
  }

  return /(?:Node\.js\s*脚本|python3|python\s*(?:过滤|筛选|处理|解析|输出|代码|命令|脚本|完成)|Python\s*(?:过滤|筛选|处理|解析|输出|代码|命令|脚本|完成)|exec\s*(?:工具|执行|命令)|grep|bash|curl|cURL|NetInside\s*底层|底层\s*API|原始\s*API|直接调(?:用)?|直接查|直接去后端|直接从API|后端探查|本地\s*python|绕过|跨过|没走\s*skill|没有走\s*skill|没走\s*napm-skill-query|没有走\s*napm-skill-query|未经过\s*napm-skill-query|没有经过\s*napm-skill-query|没走任何中间层|没有经过.*中间(?:层|管道)|未经过.*中间(?:层|管道)|napm-skill-query\s*.*拒绝|resolvedQuery\s*.*(?:没|未|没有)构造|NapmMetadataService|单例导出|重试|写好.*脚本写入文件|调了\s+NapmMetadataService|直接调用.*getDrilldownPathsForGroupType|解析\s*JSON\s*失败)/i.test(content);
}

function looksLikeManualHierarchyInferenceText(text = '') {
  const content = String(text || '').trim();
  if (!content) {
    return false;
  }

  const mentionsHierarchySource = /(?:groups-tree\.static\.json|维度树|group\s*树|group\s*tree|children\s*:\s*\[\s*\]|children\s+为空|叶子节点|leaf\s*node|key\s*:\s*["']?[A-Za-z]+["']?)/i.test(content);
  const manualInference = /(?:手动|直接读|读取.*JSON|递归搜索|找到.*节点|自己.*判断|推测|猜测|组合路径|类似下钻|不依赖.*子树|无法沿树结构下钻|没有子节点|没有下层|children\s*为空)/i.test(content);
  const bypassSource = /(?:没有走\s*skill|没走\s*skill|没有走\s*napm-skill-query|没走\s*napm-skill-query|没有调用\s*napm-skill-query|没调用\s*napm-skill-query|直接调用.*NapmMetadataService|直接查.*groups-tree)/i.test(content);

  return (mentionsHierarchySource && manualInference) || bypassSource;
}

function looksLikeUnsupportedBusinessInventoryExplanation(text = '') {
  const content = String(text || '').trim();
  if (!content) {
    return false;
  }

  const mentionsBusinessInventory = /(?:业务系统|WebApplication|type=applications|applications\s+接口|南向\s*applications|业务应用)/i.test(content);
  const unsupportedExplanation = /(?:近期有(?:活跃)?流量|有流量数据|活跃(?:流量|应用|业务)|没有活跃流量|无流量|刚好没有活跃|现在有了|重新出现|被移除|名称有变化|中文(?:字符|名称).*过滤|全是中文)/i.test(content);
  return mentionsBusinessInventory && unsupportedExplanation;
}

function looksLikeInvalidBusinessInventoryAnswer(text = '') {
  const content = String(text || '').trim();
  if (!content) {
    return false;
  }

  const mentionsBusinessInventory = /(?:系统中|系统里|当前|现在|业务|业务系统|WebApplication)/i.test(content);
  if (!mentionsBusinessInventory) {
    return false;
  }

  return /(?:自定义业务应用|type\s*=\s*2|type=2|Type=2|DefinedApp|已定义应用|Web业务应用[\s\S]{0,120}自定义业务应用|业务相关[^，。！？\n]{0,20}(?:14|十四)\s*个|python\s*(?:按|过滤|筛选|处理|解析|输出)|exec\s*(?:工具|执行|命令)|直接调用后端|直接调(?:用)?后端|直接从API|未经过.*(?:中间管道|napm-skill-query)|没有经过.*(?:中间管道|napm-skill-query))/i.test(content);
}

function isMeaningfulText(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return text !== '[object Object]' && text !== '[object Array]';
}

function normalizePromptKey(prompt) {
  return String(prompt || '')
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[?？!！。；;，,、：:]+$/g, '');
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

  const timeRange = isPlainObject(resolvedQuery.timeRange) ? resolvedQuery.timeRange : null;
  const nestedTimeRangeStart = Number.isFinite(Number(timeRange?.start)) ? Number(timeRange.start) : null;
  const nestedTimeRangeEnd = Number.isFinite(Number(timeRange?.end)) ? Number(timeRange.end) : null;
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
    timeRangeKey: String(resolvedQuery.timeRangeKey || timeRange?.key || '').trim() || null,
    nestedTimeRangeStart,
    nestedTimeRangeEnd,
    hasNestedTimeRangeStart: nestedTimeRangeStart !== null,
    hasNestedTimeRangeEnd: nestedTimeRangeEnd !== null,
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
  const executorPath = path.join(OPENCLAW_SKILLS_ROOT, 'openclaw-napm-query/scripts/run_napm_query.js');
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

function normalizeQueryModeKeyForService(serviceName = '', queryModeKey = '') {
  const service = String(serviceName || '').trim();
  const mode = String(queryModeKey || '').trim();
  if (!mode) {
    return mode;
  }

  const normalizedMode = mode.toLowerCase().replace(/[_\s-]+/g, '');
  const aliasesByService = {
    topValues: {
      topn: 'topn',
      top: 'topn',
      topvalues: 'topn',
      topvalue: 'topn',
      ranking: 'topn',
      rank: 'topn',
      data: 'topn'
    },
    topValues_multi_protocol: {
      topn: 'topn',
      top: 'topn',
      topvalues: 'topn',
      topvalue: 'topn',
      ranking: 'topn',
      rank: 'topn',
      data: 'topn'
    },
    averageValues: {
      average: 'average',
      avg: 'average',
      averagevalues: 'average',
      data: 'average'
    },
    timeValues: {
      timeseries: 'timeseries',
      timevalues: 'timeseries',
      trend: 'timeseries',
      trends: 'timeseries',
      data: 'timeseries'
    },
    overview: {
      overview: 'overview',
      overall: 'overview',
      data: 'overview'
    },
    groups: {
      metadata: 'metadata',
      group: 'metadata',
      groups: 'metadata',
      list: 'metadata',
      metadatalist: 'metadata',
      data: 'metadata'
    },
    metrics: {
      metadata: 'metadata',
      metric: 'metadata',
      metrics: 'metadata',
      list: 'metadata',
      metadatalist: 'metadata',
      data: 'metadata'
    },
    drilldownCatalog: {
      metadata: 'metadata',
      drilldowncatalog: 'metadata',
      catalog: 'metadata',
      list: 'metadata'
    },
    security_refusal: {
      decision: 'decision',
      refusal: 'decision',
      securityrefusal: 'decision'
    }
  };

  return aliasesByService[service]?.[normalizedMode] || mode;
}

function normalizeResolvedQueryForPlugin(resolvedQuery = undefined) {
  if (!isPlainObject(resolvedQuery)) {
    return resolvedQuery;
  }

  const next = cloneJsonObject(resolvedQuery);
  const serviceName = String(next.service || '').trim();
  if (serviceName) {
    next.service = serviceName;
  }

  const normalizedQueryModeKey = normalizeQueryModeKeyForService(serviceName, next.queryModeKey);
  if (normalizedQueryModeKey) {
    next.queryModeKey = normalizedQueryModeKey;
  }

  return next;
}

function getRelativeTimeRangeKey(resolvedQuery = {}) {
  return String(
    resolvedQuery?.timeRangeKey
    || resolvedQuery?.timeRange?.key
    || resolvedQuery?.resolutionHints?.time?.key
    || ''
  ).trim();
}

function getExpectedResolvedTimeRange(timeRangeKey = '', options = {}) {
  const key = String(timeRangeKey || '').trim();
  if (!key) {
    return null;
  }

  const resolver = getNapmResolvedQueryResolverService();
  if (!resolver || typeof resolver.resolveTimeRange !== 'function') {
    return null;
  }

  try {
    return resolver.resolveTimeRange({ timeRangeKey: key }, {
      nowSeconds: options.nowSeconds
    });
  } catch (_error) {
    return null;
  }
}

function validateRelativeTimeRangeFreshness(resolvedQuery = {}, options = {}) {
  if (!options || !Number.isFinite(Number(options.nowSeconds))) {
    return { ok: true };
  }

  const timeRangeKey = getRelativeTimeRangeKey(resolvedQuery);
  if (!timeRangeKey) {
    return { ok: true };
  }

  const expected = getExpectedResolvedTimeRange(timeRangeKey, options);
  if (!expected || !Number.isFinite(Number(expected.start)) || !Number.isFinite(Number(expected.end))) {
    return { ok: true };
  }

  const actualStart = Number(resolvedQuery.start);
  const actualEnd = Number(resolvedQuery.end);
  if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd)) {
    return { ok: true };
  }

  const toleranceSeconds = Number.isFinite(Number(options.timeDriftToleranceSeconds))
    ? Number(options.timeDriftToleranceSeconds)
    : 300;
  const startDrift = Math.abs(actualStart - Number(expected.start));
  const endDrift = Math.abs(actualEnd - Number(expected.end));
  if (startDrift <= toleranceSeconds && endDrift <= toleranceSeconds) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'relative_time_range_stale_or_miscalculated',
    message: `resolvedQuery uses relative timeRange=${timeRangeKey}, but root-level start/end do not match the current server time. Rebuild timestamps with napm-resolve-time-range before calling napm-skill-query.`,
    details: {
      timeRangeKey,
      expectedStart: Number(expected.start),
      expectedEnd: Number(expected.end),
      actualStart,
      actualEnd,
      toleranceSeconds
    }
  };
}

function validateResolvedQueryAgainstSpec(resolvedQuery = {}, options = {}) {
  if (!isPlainObject(resolvedQuery)) {
    return {
      ok: false,
      reason: 'missing_resolved_query',
      message: 'NAPM natural-language requests must include a structured resolvedQuery before calling napm-skill-query.'
    };
  }

  const normalizedResolvedQuery = normalizeResolvedQueryForPlugin(resolvedQuery);
  const serviceName = String(normalizedResolvedQuery.service || '').trim();
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
  const requiresRootStart = requiredFields.includes('start');
  const requiresRootEnd = requiredFields.includes('end');
  const rootStart = Number(normalizedResolvedQuery.start);
  const rootEnd = Number(normalizedResolvedQuery.end);
  const hasValidRootStart = Number.isFinite(rootStart) && rootStart > 0;
  const hasValidRootEnd = Number.isFinite(rootEnd) && rootEnd > rootStart;
  const nestedStart = Number(normalizedResolvedQuery?.timeRange?.start);
  const nestedEnd = Number(normalizedResolvedQuery?.timeRange?.end);
  const hasNestedStart = Number.isFinite(nestedStart) && nestedStart > 0;
  const hasNestedEnd = Number.isFinite(nestedEnd) && nestedEnd > 0;

  if ((requiresRootStart || requiresRootEnd) && (!hasValidRootStart || !hasValidRootEnd) && (hasNestedStart || hasNestedEnd)) {
    return {
      ok: false,
      reason: 'invalid_time_field_location',
      message: `resolvedQuery.service=${serviceName} must put executable timestamps at root-level start/end. timeRange.start/timeRange.end are declarative only and cannot be used for execution.`
    };
  }

  if ((requiresRootStart || requiresRootEnd) && hasValidRootStart && hasValidRootEnd && (rootStart % 60 !== 0 || rootEnd % 60 !== 0)) {
    return {
      ok: false,
      reason: 'invalid_time_boundary_alignment',
      message: `resolvedQuery.service=${serviceName} root-level start/end must be aligned to 60-second minute boundaries before calling napm-skill-query.`
    };
  }

  const missingFields = [];
  requiredFields.forEach((field) => {
    if (field === 'timeRange') {
      const start = Number(normalizedResolvedQuery.start);
      const end = Number(normalizedResolvedQuery.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
        missingFields.push('start/end');
      }
      return;
    }

    const value = normalizedResolvedQuery[field];
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

  const queryModeKey = String(normalizedResolvedQuery.queryModeKey || '').trim();
  const allowedQueryModes = Array.isArray(serviceSpec.queryModes) ? serviceSpec.queryModes : [];
  if (queryModeKey && allowedQueryModes.length > 0 && !allowedQueryModes.includes(queryModeKey)) {
    return {
      ok: false,
      reason: 'invalid_query_mode',
      message: `resolvedQuery.service=${serviceName} only accepts queryModeKey=${allowedQueryModes.join('|')}; received ${queryModeKey}.`,
      details: {
        service: serviceName,
        queryModeKey,
        allowedQueryModes
      }
    };
  }

  const relativeTimeValidation = validateRelativeTimeRangeFreshness(normalizedResolvedQuery, options);
  if (!relativeTimeValidation.ok) {
    return relativeTimeValidation;
  }

  return {
    ok: true,
    serviceSpec,
    resolvedQuery: normalizedResolvedQuery
  };
}

function buildResolvedQueryBoundaryFailureResult(validation = {}, args = {}) {
  return {
    ok: false,
    source: 'napm_openclaw_plugin_boundary',
    responseType: 'BOUNDARY_VALIDATION_ERROR',
    prompt: normalizePrompt(args),
    decision: {
      next_action: 'RECONSTRUCT_RESOLVED_QUERY',
      reason: validation.reason || 'invalid_resolved_query',
      message: validation.message || 'resolvedQuery failed plugin boundary validation.'
    },
    error: {
      code: 'UPSTREAM_RESOLVED_QUERY_INVALID',
      reason: validation.reason || 'invalid_resolved_query',
      message: validation.message || 'resolvedQuery failed plugin boundary validation.'
    },
    resolvedQuery: normalizeObject(args?.resolvedQuery) || null,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(args?.resolvedQuery)
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
  // Summary report requests must NOT be treated as overview queries.
  // "综述报告/日报/周报" → napm-summary (docx), not napm-skill-query overview (text).
  if (isSummaryPrompt(prompt)) {
    return false;
  }
  return getPromptRoutingService().isOverviewPrompt(prompt);
}

function getWorkflowClassifierService() {
  if (!workflowClassifierLookupComplete) {
    workflowClassifierLookupComplete = true;
    try {
      cachedWorkflowClassifierService = require(path.join(
        OPENCLAW_SKILLS_ROOT,
        'openclaw-napm-query/services/WorkflowClassifierService'
      ));
    } catch (_error) {
      cachedWorkflowClassifierService = null;
    }
  }
  return cachedWorkflowClassifierService;
}

function classifyNapmWorkflow(prompt = '') {
  const classifier = getWorkflowClassifierService();
  if (classifier && typeof classifier.classifyWorkflow === 'function') {
    return classifier.classifyWorkflow(prompt);
  }
  return {
    workflowType: null,
    confidence: 0,
    reason: 'workflow_classifier_unavailable'
  };
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

  const workflow = classifyNapmWorkflow(text);
  if (workflow.workflowType === 'object_inventory' && workflow.targetObjectType === 'BusinessGroup') {
    return true;
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

function isCompositeApplicationInventoryPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasInventoryIntent = /(?:有哪些|有什么|有哪几个|都有哪些|包含哪些|列表|清单|列出|查看|查询)/.test(text)
    || /(?:鏈夊摢浜|鏈変粈涔|鏈夊摢鍑犱釜|閮芥湁鍝簺|鍖呭惈鍝簺|鍒楄〃|娓呭崟|鍒楀嚭|鏌ョ湅|鏌ヨ)/i.test(text);
  const hasCompositeApplicationScope = /(?:系统)?自动识别(?:出来)?(?:的)?应用|特征识别(?:的)?应用|复合协议|复合应用|多协议应用|组合应用|CompositeApplication|composite\s*application/i.test(text)
    || /(?:绯荤粺)?鑷姩璇嗗埆(?:鍑烘潵)?(?:鐨)?搴旂敤|鐗瑰緛璇嗗埆(?:鐨)?搴旂敤|澶嶅悎鍗忚|澶嶅悎搴旂敤|澶氬崗璁簲鐢|缁勫悎搴旂敤/i.test(text);

  return hasInventoryIntent
    && hasCompositeApplicationScope
    && !isMetricInventoryPrompt(text)
    && !isHierarchyCatalogPrompt(text);
}

function validateCompositeApplicationInventoryResolvedQuery(prompt = '', resolvedQuery = {}) {
  if (!isCompositeApplicationInventoryPrompt(prompt)) {
    return {
      ok: true
    };
  }

  const service = String(resolvedQuery?.service || '').trim();
  const queryModeKey = String(resolvedQuery?.queryModeKey || '').trim();
  const operation = String(resolvedQuery?.semanticConstraints?.operation || '').trim();
  const groupType = String(resolvedQuery?.groups?.[0]?.type || '').trim();
  const groupArgument = String(resolvedQuery?.groups?.[0]?.argument || '').trim();
  const ok = service === 'groups'
    && (!queryModeKey || queryModeKey === 'metadata')
    && (!operation || operation === 'metadata_list')
    && groupType === 'CompositeApplication'
    && !groupArgument;

  if (ok) {
    return {
      ok: true
    };
  }

  return {
    ok: false,
    reason: 'composite_application_inventory_contract_mismatch',
    message: '“系统中有哪些自动识别的应用”是 CompositeApplication 元数据清单查询，resolvedQuery 必须使用 service=groups、queryModeKey=metadata、groups=[{type:"CompositeApplication"}]，不能使用 overview/auto_apps，也不能携带 argument:"all"。'
  };
}

function validateObjectInventoryResolvedQuery(prompt = '', resolvedQuery = {}) {
  const workflow = classifyNapmWorkflow(prompt);
  if (workflow.workflowType !== 'object_inventory' || !workflow.targetObjectType) {
    return {
      ok: true
    };
  }

  const expectedType = workflow.targetObjectType;
  const service = String(resolvedQuery?.service || '').trim();
  const queryModeKey = String(resolvedQuery?.queryModeKey || '').trim();
  const operation = String(resolvedQuery?.semanticConstraints?.operation || '').trim();
  const workflowType = String(resolvedQuery?.semanticConstraints?.workflowType || '').trim();
  const groupType = String(resolvedQuery?.groups?.[0]?.type || '').trim();
  const groupArgument = String(resolvedQuery?.groups?.[0]?.argument || '').trim();
  const ok = service === 'groups'
    && (!queryModeKey || queryModeKey === 'metadata')
    && (!operation || operation === 'metadata_list')
    && (!workflowType || workflowType === 'object_inventory')
    && groupType === expectedType
    && !groupArgument;

  if (ok) {
    return {
      ok: true
    };
  }

  return {
    ok: false,
    reason: 'object_inventory_contract_mismatch',
    message: `This is an NAPM object_inventory query for ${expectedType}. resolvedQuery must use service=groups, queryModeKey=metadata, semanticConstraints.operation=metadata_list, groups=[{type:"${expectedType}"}], and must not use overview/topValues or argument:"all".`
  };
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

const RESOLVED_QUERY_AUTO_REPAIR_REASONS = new Set([
  'missing_resolved_query',
  'missing_service',
  'unknown_service',
  'incomplete_resolved_query',
  'relative_time_range_stale_or_miscalculated'
]);

function getResolvedQueryValidationOptions(args = {}) {
  return {
    nowSeconds: args?.nowSeconds
  };
}

function shouldAttemptResolvedQueryAutoRepair(validation = {}, args = {}) {
  const prompt = normalizePrompt(args);
  if (!prompt || validation?.ok) {
    return false;
  }

  return RESOLVED_QUERY_AUTO_REPAIR_REASONS.has(String(validation?.reason || '').trim());
}

function maybeAutoRepairResolvedQuery(prepared = {}) {
  const prompt = normalizePrompt(prepared);
  if (isPlainObject(prepared.resolvedQuery)) {
    prepared.resolvedQuery = normalizeResolvedQueryForPlugin(prepared.resolvedQuery);
  }

  const validationOptions = getResolvedQueryValidationOptions(prepared);
  const validation = validateResolvedQueryAgainstSpec(prepared.resolvedQuery, validationOptions);
  if (validation.ok) {
    if (isPlainObject(validation.resolvedQuery)) {
      prepared.resolvedQuery = validation.resolvedQuery;
    }
    return {
      repaired: false,
      validation
    };
  }

  if (!shouldAttemptResolvedQueryAutoRepair(validation, prepared)) {
    return {
      repaired: false,
      validation
    };
  }

  const originalResolvedQuery = isPlainObject(prepared.resolvedQuery)
    ? cloneJsonObject(prepared.resolvedQuery)
    : null;
  const repaired = buildResolvedQueryForPrompt(prompt, prepared);
  if (!isPlainObject(repaired.resolvedQuery)) {
    appendPluginAuditEvent('napm_plugin_resolved_query_auto_repair_failed', {
      traceId: normalizeTraceId(prepared?.traceId) || buildNapmTraceId({}, prepared),
      prompt,
      reason: validation.reason || null,
      message: validation.message || null,
      source: repaired.source || null,
      resolverReason: repaired.result?.reason || null,
      resolverMessage: repaired.result?.message || null,
      originalResolvedQuery: normalizeObject(originalResolvedQuery) || null,
      originalResolvedQuerySummary: summarizeResolvedQueryForAudit(originalResolvedQuery),
      diagnostics: normalizeObject(repaired.result?.diagnostics) || null
    });
    return {
      repaired: false,
      validation,
      resolverResult: repaired.result || null
    };
  }

  prepared.resolvedQuery = repaired.resolvedQuery;
  const repairedValidation = validateResolvedQueryAgainstSpec(prepared.resolvedQuery, validationOptions);
  appendPluginAuditEvent('napm_plugin_resolved_query_auto_repaired', {
    traceId: normalizeTraceId(prepared?.traceId) || buildNapmTraceId({}, prepared),
    prompt,
    reason: validation.reason || null,
    message: validation.message || null,
    source: repaired.source || null,
    originalResolvedQuery: normalizeObject(originalResolvedQuery) || null,
    originalResolvedQuerySummary: summarizeResolvedQueryForAudit(originalResolvedQuery),
    repairedResolvedQuery: normalizeObject(prepared.resolvedQuery) || null,
    repairedResolvedQuerySummary: summarizeResolvedQueryForAudit(prepared.resolvedQuery),
    validation: {
      ok: Boolean(repairedValidation.ok),
      reason: repairedValidation.reason || null,
      message: repairedValidation.message || null
    },
    intent: normalizeObject(repaired.result?.intent) || null,
    diagnostics: normalizeObject(repaired.result?.diagnostics) || null
  });

  return {
    repaired: repairedValidation.ok,
    validation: repairedValidation.ok ? repairedValidation : validation,
    resolverResult: repaired.result || null
  };
}

function prepareSkillExecutionArgs(args = {}) {
  const prepared = isPlainObject(args) ? { ...args } : {};
  const prompt = normalizePrompt(prepared);
  if (!prepared.userQuery && prompt) {
    prepared.userQuery = prompt;
  }

  maybeAutoRepairResolvedQuery(prepared);

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

  return prepareSkillExecutionArgs(nextParams);
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
  const alertEventPrompt = isAlertEventPrompt(prompt);
  const alertMetaFollowUpPrompt = isAlertSkillMetaFollowUpPrompt(prompt, previousState);
  const metricInventoryPrompt = isMetricInventoryPrompt(prompt)
    || (previousState?.lastMetricInventoryGroup && isMetricInventoryDetailPrompt(prompt));
  const metaFollowUpPrompt = isNapmMetaFollowUpPrompt(prompt, previousState);
  const domainRelated = overviewRelated
    || alertEventPrompt
    || alertMetaFollowUpPrompt
    || isSystemDomainPrompt(prompt)
    || metaFollowUpPrompt
    || (previousState?.domainRelated && isContinuationPrompt(prompt));
  const napmRelated = overviewRelated
    || alertEventPrompt
    || alertMetaFollowUpPrompt
    || isNapmRelatedPrompt(prompt)
    || metaFollowUpPrompt
    || (previousState?.napmRelated && isContinuationPrompt(prompt));
  const alertRelated = alertEventPrompt
    || alertMetaFollowUpPrompt
    || Boolean(previousState?.alertRelated && (isContinuationPrompt(prompt) || metaFollowUpPrompt));

  return {
    prompt,
    napmRelated,
    domainRelated,
    alertRelated,
    alertEventPrompt,
    alertMetaFollowUpPrompt,
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

function getMediaUrlsFromOutgoingEvent(event = {}) {
  const urls = [];
  const mediaUrl = String(event?.mediaUrl || event?.payload?.mediaUrl || '').trim();
  if (mediaUrl) {
    urls.push(mediaUrl);
  }
  const mediaUrls = Array.isArray(event?.mediaUrls)
    ? event.mediaUrls
    : (Array.isArray(event?.payload?.mediaUrls) ? event.payload.mediaUrls : []);
  for (const item of mediaUrls) {
    const value = String(item || '').trim();
    if (value) {
      urls.push(value);
    }
  }
  return Array.from(new Set(urls));
}

function isReportExportPrompt(text = '') {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }
  return /(report|export|word|docx|pdf)/i.test(value)
    || /(报告|报表|导出|文档|文件|总结为|整理成|以\s*word|以\s*pdf|word\s*文档|pdf\s*文档)/i.test(value);
}

function getReportArtifactUrlsFromOutgoingEvent(event = {}) {
  return getMediaUrlsFromOutgoingEvent(event)
    .filter((url) => /\.(docx|pdf)(?:$|[?#])/i.test(String(url || '').trim()));
}

function textClaimsReportGenerated(text = '') {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }
  return /\.(docx|pdf)(?:\b|$)/i.test(value)
    || /(报告已生成|文档已生成|Word\s*文档已生成|PDF\s*已生成|已生成.*报告|已通过\s*MEDIA\s*发送|现在发送给您|通过\s*MEDIA\s*发送)/i.test(value);
}

function isAllowedReportArtifactUrl(url = '') {
  if (!isFreshReportExportResult()) {
    return false;
  }
  const value = String(url || '').trim();
  const record = latestReportExportResult;
  return Boolean(
    value
    && (
      value === record.filePath
      || value === record.downloadUrl
      || (record.filePath && value.endsWith(path.basename(record.filePath)))
      || (record.downloadUrl && value.endsWith(path.basename(record.downloadUrl)))
    )
  );
}

function buildReportExportRequiredReply() {
  return [
    '当前请求是报告/Word/PDF 导出请求，必须通过 napm-report-export 执行后才能发送文件。',
    '本轮没有检测到有效的 napm-report-export 结果，因此不允许直接生成、发送或补写报告文件。',
    '如果上一轮已有查询或数据包分析结果，请调用 napm-report-export，让它消费最新结构化 reportData 后生成 Word。'
  ].join('\n');
}

function dedupeOutgoingMediaForConversation(event = {}, ctx = {}) {
  const mediaUrls = getMediaUrlsFromOutgoingEvent(event);
  if (mediaUrls.length === 0) {
    return null;
  }

  const conversationKey = getConversationKey(ctx) || 'global';
  const now = Date.now();
  const existing = napmSentMediaByConversation.get(conversationKey) || new Map();
  for (const [url, updatedAt] of existing.entries()) {
    if ((now - Number(updatedAt || 0)) > SENT_MEDIA_DEDUPE_WINDOW_MS) {
      existing.delete(url);
    }
  }

  const duplicateUrls = mediaUrls.filter((url) => existing.has(url));
  const freshUrls = mediaUrls.filter((url) => !existing.has(url));
  for (const url of freshUrls) {
    existing.set(url, now);
  }
  napmSentMediaByConversation.set(conversationKey, existing);

  return {
    original: mediaUrls,
    fresh: freshUrls,
    duplicates: duplicateUrls
  };
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

function rememberDebugApiForPromptAliases(prompts = [], result = {}, conversationKey = '') {
  if (!Array.isArray(prompts)) {
    return;
  }

  prompts
    .map((prompt) => String(prompt || '').trim())
    .filter(Boolean)
    .forEach((prompt) => {
      rememberDebugApi(prompt, result, conversationKey);
    });
}

function rememberReportExportResult(prompt = '', result = {}, conversationKey = '') {
  if (!isPlainObject(result) || !result.ok) {
    return;
  }
  latestReportExportResult = {
    prompt: String(prompt || '').trim() || null,
    conversationKey: String(conversationKey || '').trim() || null,
    updatedAt: Date.now(),
    result,
    filePath: String(result.filePath || '').trim(),
    downloadUrl: String(result.downloadUrl || '').trim(),
    reportId: String(result.reportId || '').trim()
  };
}

function isFreshReportExportResult(record = latestReportExportResult, maxAgeMs = REPORT_EXPORT_CACHE_MAX_AGE_MS) {
  return Boolean(
    record
    && Number(record.updatedAt) > 0
    && (Date.now() - Number(record.updatedAt)) <= maxAgeMs
    && isPlainObject(record.result)
    && record.result.ok
  );
}

function isFreshRememberedRecord(record, maxAgeMs = RESULT_CACHE_MAX_AGE_MS) {
  return Boolean(
    record
    && Number(record.updatedAt) > 0
    && (Date.now() - Number(record.updatedAt)) <= maxAgeMs
  );
}

function getLatestRememberedSkillRecord(maxAgeMs = RESULT_CACHE_MAX_AGE_MS) {
  return isFreshRememberedRecord(latestNapmResult, maxAgeMs) ? latestNapmResult : null;
}

function getReportDataFromRecord(record = null) {
  if (!record || !isPlainObject(record.result)) {
    return null;
  }
  if (isPlainObject(record.result.reportData)) {
    return record.result.reportData;
  }
  return null;
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

function getRememberedRecordForPrompt(activePrompt = '', conversationState = null, conversationKey = '', guardState = null) {
  const metaFollowUp = isNapmMetaFollowUpPrompt(activePrompt, guardState || conversationState);
  return getRememberedSkillResult(activePrompt, conversationKey)
    || getRememberedSkillResult(activePrompt, '')
    || getRememberedMetricInventoryFollowUpRecord(activePrompt, conversationState, conversationKey)
    || (isMetricInventoryDetailPrompt(activePrompt) ? getRecentRememberedSkillResult(conversationKey) : null)
    || (metaFollowUp ? getRecentRememberedSkillResult('') : null);
}

function isAlertSkillResultRecord(record = null) {
  if (!record || !isPlainObject(record.result) || record.result?.error) {
    return false;
  }

  const result = record.result;
  const service = String(result.service || result?.reportData?.dataSource?.queryService || '').trim();
  const schema = String(result?.narrationInput?.schema || '').trim();
  const sourceSkill = String(
    result?.reportData?.dataSource?.sourceSkill
    || result?.reportData?.audit?.sourceSkill
    || ''
  ).trim();

  return Boolean(
    ['alertsSummary', 'alertsSummaryTimeLine', 'alertsDetail', 'explain_notification', 'explain_event_fields'].includes(service)
    || schema === 'openclaw_napm_alert.v1'
    || sourceSkill === 'openclaw-napm-alert-query'
  );
}

function getRememberedAlertRecordForPrompt(activePrompt = '', conversationState = null, conversationKey = '', guardState = null) {
  const candidates = [
    getRememberedSkillResult(activePrompt, conversationKey),
    getRememberedSkillResult(activePrompt, '')
  ];

  const alertFollowUp = Boolean(
    isAlertEventPrompt(activePrompt)
    || isAlertSkillMetaFollowUpPrompt(activePrompt, guardState || conversationState)
    || conversationState?.alertRelated
    || guardState?.alertRelated
  );
  if (alertFollowUp) {
    candidates.push(getRecentRememberedSkillResult(conversationKey));
    candidates.push(getRecentRememberedSkillResult(''));
  }

  return candidates.find((record) => isFreshRememberedRecord(record) && isAlertSkillResultRecord(record)) || null;
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

function isPacketCapturePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }
  return /(数据包|报文|抓包|抓取包|下载包|下载数据包|原始包|包详情|数据包情况|pcap|cap\b|packet|packetsPreview|packetsDown|DownServlet)/i.test(text);
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

  if (isPacketCapturePrompt(text)) {
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

  if (isPacketCapturePrompt(text)) {
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




function normalizeReportFormat(format = '') {
  const raw = String(format || '').trim().toLowerCase();
  if (raw === 'word') return 'docx';
  if (raw === 'doc') return 'docx';
  return raw || 'docx';
}

function buildReportTraceId(args = {}) {
  return normalizeTraceId(args?.traceId)
    || `napm-report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildPacketTraceId(args = {}) {
  return normalizeTraceId(args?.traceId)
    || `napm-packet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildAlertTraceId(args = {}) {
  return normalizeTraceId(args?.traceId)
    || `napm-alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildInspectionTraceId(args = {}) {
  return normalizeTraceId(args?.traceId)
    || `napm-inspection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}



function buildFaultDiagnosisReply(result = {}) {
  if (!result?.ok) {
    return `故障分析执行失败：${result?.error?.message || result?.message || '未知错误'}`;
  }
  if (!result?.reportReady) {
    return `故障分析已启动，当前步骤：${result?.steps?.length || 0} 步已完成。`;
  }
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const hintCount = steps.reduce((sum, s) => sum + (Array.isArray(s.hints) ? s.hints.length : 0), 0);
  if (result.filePath) {
    return [
      `故障分析完成。流程类型：${result.flowLabel || '-'}，共执行 ${steps.length} 个分析步骤，产生 ${hintCount} 条判断提示。`,
      `Word 报告已生成：${result.fileName || 'report.docx'}`
    ].join('\n');
  }
  return [
    `故障分析完成。流程类型：${result.flowLabel || '-'}，共执行 ${steps.length} 个分析步骤，产生 ${hintCount} 条判断提示。`,
    'reportData 已就绪，请调用 napm-report-export 生成 Word 文档。'
  ].join('\n');
}

function buildSummaryReply(result = {}) {
  const lines = [];
  if (!result?.ok) {
    lines.push('综述报告生成失败：' + (result?.error?.message || '未知错误'));
    return lines.join('\n');
  }
  // Target not found warning
  if (result.targetNotFoundWarning) {
    lines.push('⚠️ ' + result.targetNotFoundWarning);
  }
  const summary = isPlainObject(result.summary) ? result.summary : {};
  const scope = isPlainObject(result.scope) ? result.scope : {};
  const scopeLabel = scope.label || '全局';
  const overallStatus = summary.overallStatus || 'ok';
  const alertTotal = summary.alertSummary?.total ?? 0;
  const alertCritical = summary.alertSummary?.critical ?? 0;
  const alertMajor = summary.alertSummary?.major ?? 0;

  const statusEmoji = overallStatus === 'critical' ? '🔴' : overallStatus === 'warning' ? '🟡' : '🟢';
  const statusText = overallStatus === 'critical' ? '紧急' : overallStatus === 'warning' ? '需关注' : '正常';

  lines.push(`${scopeLabel}综述报告数据已采集完成。`);
  lines.push(`${statusEmoji} 整体状态：${statusText}`);
  lines.push(`📊 告警总数：${alertTotal}（紧急 ${alertCritical}、重大 ${alertMajor}）`);

  const trafficPoints = summary.trafficSummary?.trend?.dataset?.points?.length || summary.trafficSummary?.trend?.dataset?.time?.length || 0;
  if (trafficPoints > 0) {
    lines.push(`📈 流量采样点：${trafficPoints}`);
  }

  if (Array.isArray(summary.recommendations) && summary.recommendations.length > 0) {
    lines.push(`📋 建议事项：${summary.recommendations.length} 条`);
  }

  if (result.reportData) {
    lines.push('');
    lines.push('如需 Word 文件，请继续调用 napm-report-export 消费本次 reportData。');
  }
  return lines.join('\n');
}

function buildInspectionSnapshotReply(result = {}) {
  if (!result?.ok) {
    return String(
      result?.message
      || result?.error?.message
      || '巡检数据采集失败。'
    ).trim();
  }
  const lines = [];
  const title = String(result?.summary?.title || result?.reportData?.title || 'NAPM 巡检快照').trim();
  const status = String(result?.summary?.status || result?.inspection?.summary?.overallStatus || '').trim();
  lines.push(`巡检数据已生成：${title}`);
  if (status) {
    lines.push(`总体状态：${status}`);
  }
  const highlights = Array.isArray(result?.summary?.highlights)
    ? result.summary.highlights.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (highlights.length > 0) {
    lines.push('关注事项：');
    highlights.slice(0, 8).forEach((item) => lines.push(`- ${item}`));
  }
  if (result?.reportData?.reportType) {
    lines.push(`报告数据类型：${result.reportData.reportType}`);
  }
  lines.push('如需 Word 文件，请继续调用 napm-report-export 消费本次 reportData。');
  return lines.join('\n');
}






function buildAlertQueryReply(result = {}) {
  // skill 已生成 displayText → 直接透传
  const skillText = result?.narrationInput?.displayText;
  if (skillText) {
    const requestUrl = maskDebugApiUrl(result.requestUrl || result.requestUrls?.[0] || '');
    return requestUrl && !skillText.includes(requestUrl)
      ? `${skillText}\n\nDebug API:\n${requestUrl}`
      : skillText;
  }

  if (!result?.ok) {
    return String(
      result?.message
      || result?.error?.message
      || '告警查询失败。'
    ).trim();
  }

  if (result?.explanation?.title) {
    return String(result.explanation.title);
  }

  const lines = [];

  const pi = result?.narrationInput?.packetInstruction;
  const triggerInfo = result?.narrationInput?.triggerInfo;

  // ═══════════════════════════════════════════════════════════════
  // 当有 packetInstruction 时，输出这是主要指令，不混入长摘要
  // ═══════════════════════════════════════════════════════════════
  if (pi && pi.callPacketAnalysis && Array.isArray(pi.candidates) && pi.candidates.length > 0) {
    // USE_CANDIDATES — 只输出指令和候选，AI 必须逐条调 packet-analysis
    lines.push('═══════════════════════════════════════');
    lines.push('⚠️ 数据包发现完成 — 请执行以下操作：');
    lines.push('');
    lines.push(`发现 ${pi.candidates.length} 个嫌疑 IP 会话，必须逐条调用 napm-packet-analysis：`);
    lines.push('');
    for (const c of pi.candidates) {
      const label = c.ipPair || c.ip || c.ips?.join('↔') || '-';
      const sq = c.suggestedPacketQuery || {};
      const sqIps = (sq.criteria?.ips || c.ips || []).join(',');
      const sqStart = sq.criteria?.start || '';
      const sqEnd = sq.criteria?.end || '';
      lines.push(`  ${c.rank}. ${label}`);
      lines.push(`     → napm-packet-analysis mode=${sq.mode || 'preview_download_analyze'} ips=${sqIps} start=${sqStart} end=${sqEnd}`);
    }
    lines.push('');
    // 触发指标 — 动态透传，AI 必须围绕此展开分析
    if (Array.isArray(triggerInfo) && triggerInfo.length > 0) {
      const t = triggerInfo[0];
      const m = (t.metrics||[]).join('、') || null;
      const v = (t.value||[]).join('、');
      const u = (t.unit||[])[0] || '';
      if (m) {
        lines.push(`🔴 告警触发: ${m} = ${v}${u}（${t.severityLabel||'?'}）`);
        lines.push(`   条件: ${t.condition || 'N/A'}`);
        lines.push(`   报告必须围绕 ${m} 展开，解释为什么达到 ${v}${u}`);
      } else {
        lines.push('该告警无触发指标，仍必须逐条分析数据包内容');
      }
    }
    lines.push('');
    lines.push('═══════════════════════════════════════');
    lines.push('');
    // 告警基本信息
    const events = Array.isArray(result.details) && result.details.length > 0
      ? result.details
      : (Array.isArray(result.events) ? result.events : []);
    if (events.length > 0) {
      const e = events[0];
      lines.push(`告警: ${e.id} ${e.severityLabel||''} ${e.group||''} ${e.name||''}`);
      lines.push(`时间: ${e.start||'-'} ~ ${e.end||'-'}`);
      lines.push(`触发指标: ${(e.metrics||[]).join(', ') || '无'}`);
    }
    return lines.join('\n').trim();
  }

  // STOP 只在确实有 packet 查询意图（packetHandoff 非 null）时才显示
  // 普通 summary 查询（packetHandoff=null）不受影响
  if (pi && !pi.callPacketAnalysis && result.packetHandoff) {
    lines.push(`⚠️ 该告警无法进行数据包分析: ${pi.message}`);
    lines.push(`原因: ${result.packetHandoff.reason || 'N/A'}`);
    if (result.packetHandoff.hint) {
      lines.push(`提示: ${result.packetHandoff.hint}`);
    }
    return lines.join('\n').trim();
  }

  const events = Array.isArray(result.details) && result.details.length > 0
    ? result.details
    : (Array.isArray(result.events) ? result.events : []);
  const bySeverity = result.summary?.bySeverity || {};
  const shouldGroupByCategory = shouldRenderAlertCategorySections(result);
  const timeRange = result.timeRange || {};
  const timeText = timeRange.displayText
    || (timeRange.start && timeRange.end ? `${timeRange.start} 至 ${timeRange.end}` : '');
  if (timeText) {
    lines.push(`${timeText} 告警查询结果`);
    lines.push('');
  }

  if (result.summary?.total != null) {
    const bySev = result.summary?.bySeverity || {};
    lines.push(`告警总数：${result.summary.total} 条`);
    lines.push(`  🔴 紧急 ${bySev.critical || 0} 条  |  🟠 重大 ${bySev.major || 0} 条  |  轻微 ${bySev.minor || 0} 条`);
    lines.push('');
    if (shouldGroupByCategory) {
      if (Number(result.summary.total || 0) > 0) {
        lines.push(...buildAlertCategorySections(result.summary.byCategoryDetail, events));
      } else {
        lines.push('本时间范围内未查询到告警事件。');
      }
    }
  } else if (Array.isArray(result.timeline) && result.timeline.length > 0) {
    lines.push(`时间线桶数量：${result.timeline.length}`);
  }

  const displayEvents = events.slice(0, 5);
  if (!shouldGroupByCategory && displayEvents.length > 0) {
    lines.push(`前 ${displayEvents.length} 条告警摘要：`);
    lines.push('');
    lines.push('| 级别 | 类型 | 对象 | 描述 |');
    lines.push('| --- | --- | --- | --- |');
    for (const event of displayEvents) {
      const cells = [
        escapeMarkdownTableCell(`${formatSeverityBadge(event.severity)} ${event.severityLabel || event.severity || '-'}`),
        escapeMarkdownTableCell(formatAlertCategoryLabel(event.categoryLabel || event.category || '-')),
        escapeMarkdownTableCell(event.group || '-'),
        escapeMarkdownTableCell(event.name || '-')
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    const judgement = buildAlertInitialJudgement(displayEvents);
    if (judgement) {
      lines.push('');
      lines.push(`初步判断：${judgement}`);
    }
  } else if (!shouldGroupByCategory && result.summary?.total === 0) {
    lines.push('本时间范围内未查询到告警事件。');
  }

  if (result.packetHandoff) {
    if (result.packetHandoff.available) {
      lines.push('');
      lines.push('---');
      lines.push('[packetHandoff] 该告警可转数据包分析。');
      if (result.packetHandoff.discoveryMethod) {
        lines.push(`间接发现链路: ${result.packetHandoff.discoveryMethod.groupChain}`);
        lines.push(`排序指标: ${result.packetHandoff.discoveryMethod.topMetric}`);
      }
      const candidates = result.packetHandoff.candidates || [];
      if (candidates.length > 0) {
        lines.push(`嫌疑 IP 会话 (Top${candidates.length}):`);
        for (const c of candidates) {
          const label = c.ipPair || c.ip || c.ips?.join('↔') || '-';
          const metricStr = c.metricValue ? Object.entries(c.metricValue).map(([k,v]) => `${k}=${v}`).join(', ') : '';
          lines.push(`  ${c.rank}. ${label} ${metricStr ? `(${metricStr})` : ''}`);
        }
      }
    } else {
      lines.push('');
      lines.push('---');
      lines.push(`[packetHandoff] 数据包转交不可用: ${result.packetHandoff.reason || 'N/A'}`);
      if (result.packetHandoff.discoveryMethod) {
        lines.push(`间接发现链路: ${result.packetHandoff.discoveryMethod.groupChain} (返回空)`);
      }
    }
  }

  lines.push('');
  lines.push('告警查询完成。');

  const text = lines.join('\n').trim() || JSON.stringify(result, null, 2);
  const requestUrl = maskDebugApiUrl(result.requestUrl || result.requestUrls?.[0] || '');
  if (!requestUrl || text.includes(requestUrl)) {
    return text;
  }
  return `${text}\n\nDebug API:\n${requestUrl}`;
}

function shouldRenderAlertCategorySections(result = {}) {
  if (!result?.ok || result?.mode !== 'summary') {
    return false;
  }
  const categories = result.criteria?.categories;
  return !Array.isArray(categories) || categories.length === 0;
}

function buildAlertCategorySections(categoryDetails = [], fallbackEvents = []) {
  const details = Array.isArray(categoryDetails) && categoryDetails.length > 0
    ? categoryDetails
    : buildAlertCategoryDetailsFromEvents(fallbackEvents);
  const lines = [];

  for (const [index, detail] of details.filter((item) => Number(item?.total || 0) > 0).entries()) {
    const bySeverity = detail.bySeverity || {};
    const overviewEvents = Array.isArray(detail.overviewEvents) ? detail.overviewEvents.slice(0, 3) : [];
    lines.push(`${formatCategoryIndex(index + 1)} ${formatAlertCategorySectionTitle(detail.categoryLabel || detail.category)} — ${detail.total || 0} 条`);
    lines.push(formatAlertSeveritySummaryLine(bySeverity));
    const focusText = buildAlertCategoryFocusText(overviewEvents);
    if (focusText) {
      lines.push(focusText);
    }
    if (Number(bySeverity.unknown || 0) > 0) {
      lines.push(`未知级别 ${bySeverity.unknown || 0} 条`);
    }

    lines.push('告警概览：');
    if (overviewEvents.length > 0) {
      for (const event of overviewEvents) {
        lines.push(`   ${formatSeverityBadge(event.severity)} ${buildAlertOverviewSentence(event)}`);
      }
    } else {
      lines.push('暂无可展示明细。');
    }
    lines.push('');
  }

  return lines;
}

function formatCategoryIndex(index) {
  const symbols = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  return symbols[index - 1] || `${index}.`;
}

function formatAlertSeveritySummaryLine(bySeverity = {}) {
  const items = [
    [4, '紧急', bySeverity.critical || 0],
    [3, '重大', bySeverity.major || 0],
    [2, '轻微', bySeverity.minor || 0]
  ].filter(([, , count]) => Number(count || 0) > 0);

  if (items.length === 0) {
    return '暂无紧急/重大/轻微告警';
  }
  return items
    .map(([severity, label, count]) => `${formatSeverityBadge(severity)} ${label} ${count} 条`)
    .join(' | ');
}

function buildAlertCategoryFocusText(events = []) {
  const groups = [...new Set(events.map((event) => String(event.group || '').trim()).filter(Boolean))].slice(0, 5);
  const names = [...new Set(events.map((event) => String(event.name || '').trim()).filter(Boolean))].slice(0, 2);
  if (groups.length === 0 && names.length === 0) {
    return '';
  }
  const label = groups.length > 1 ? '主要对象' : '对象';
  const groupText = groups.length > 0 ? groups.join('、') : '未知对象';
  const nameText = names.length > 0 ? `（${names.join('、')}）` : '';
  return `${label}：${groupText}${nameText}`;
}

function buildAlertCategoryDetailsFromEvents(events = []) {
  const map = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const category = event.category || event.categoryLabel || 'unknown';
    if (!map.has(category)) {
      map.set(category, {
        category,
        categoryLabel: event.categoryLabel || ALERT_CATEGORY_LABELS[category] || category,
        total: 0,
        bySeverity: { critical: 0, major: 0, minor: 0, unknown: 0 },
        overviewEvents: []
      });
    }
    const detail = map.get(category);
    detail.total += 1;
    if (Number(event.severity) === 4) detail.bySeverity.critical += 1;
    else if (Number(event.severity) === 3) detail.bySeverity.major += 1;
    else if (Number(event.severity) === 2) detail.bySeverity.minor += 1;
    else detail.bySeverity.unknown += 1;
    if (detail.overviewEvents.length < 3) detail.overviewEvents.push(event);
  }
  return Array.from(map.values());
}

function formatAlertCategorySectionTitle(label = '') {
  const text = String(label || '').trim();
  return ALERT_CATEGORY_LABELS[text] || text || '未知告警';
}

function buildAlertOverviewSentence(event = {}) {
  const name = String(event.name || '告警').trim();
  const group = String(event.group || '未知对象').trim();
  const severityLabel = event.severityLabel || '';
  const durationText = formatAlertDuration(event);
  return `${name} — ${group}（${severityLabel}，持续 ${durationText}）`;
}

function formatAlertDuration(event = {}) {
  const seconds = resolveAlertDurationSeconds(event);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '未知';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} 秒`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours} 小时 ${remainMinutes} 分钟` : `${hours} 小时`;
}

function resolveAlertDurationSeconds(event = {}) {
  const period = Number(event.period);
  const start = Number(event.start || event.firstStart);
  const end = Number(event.end || event.lastEnd);
  const rangeSeconds = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? end - start
    : null;

  if (Number.isFinite(period) && period > 0) {
    if (period < 60) {
      return period * 60;
    }
    if (rangeSeconds && Math.abs(rangeSeconds - period * 60) <= 60) {
      return period * 60;
    }
    return period;
  }
  return rangeSeconds;
}

function formatAlertTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '未知';
  }
  const milliseconds = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(milliseconds));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function formatSeverityBadge(severity) {
  const value = Number(severity);
  if (value === 4) return '🔴';
  if (value === 3) return '🟠';
  if (value === 2) return '🟢';
  return '⚪';
}

function formatAlertCategoryLabel(label = '') {
  return String(label || '').replace(/告警$/u, '') || '-';
}

function escapeMarkdownTableCell(value = '') {
  return String(value == null ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim() || '-';
}

function buildAlertInitialJudgement(events = []) {
  const criticalEvents = events.filter((event) => Number(event.severity) === 4);
  const focusEvents = criticalEvents.length > 0 ? criticalEvents : events;
  if (focusEvents.length === 0) {
    return '';
  }

  const groups = [...new Set(focusEvents.map((event) => String(event.group || '').trim()).filter(Boolean))].slice(0, 3);
  const names = [...new Set(focusEvents.map((event) => String(event.name || '').trim()).filter(Boolean))].slice(0, 2);
  const targetText = groups.length > 0 ? groups.join('、') : '相关对象';
  const nameText = names.length > 0 ? `，主要表现为${names.join('、')}` : '';
  return `告警主要集中在${targetText}${nameText}。建议优先查看紧急/重大告警详情。`;
}

function maskDebugApiUrl(inputUrl = '') {
  const raw = String(inputUrl || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/password|passwd|token|secret|authorization/i.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString();
  } catch (_error) {
    return raw.replace(/([?&](?:Password|password|passwd|token|secret|authorization)=)[^&\s]+/g, '$1***');
  }
}


function looksLikeBusinessPagePacketPreviewPrompt(text = '') {
  const raw = String(text || '');
  if (!raw) return false;
  const hasPacketPreview = /(数据包|报文|抓包|原始包|pcap|cap\b|packet|DownServlet|pageViews)/i.test(raw)
    && /(预览|查看|分析|明细|访问实例|对端|选择)/i.test(raw);
  const hasHttpPageUrl = /https?:\/\/[^\s"'<>]+\/[^\s"'<>]+/i.test(raw);
  const hasPagePath = /\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+/.test(raw);
  return hasPacketPreview && (hasHttpPageUrl || hasPagePath);
}

function extractFirstHttpPageUrl(text = '') {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>，。；、]+\/[^\s"'<>，。；、]+/i);
  return match ? match[0] : '';
}

function normalizePacketBusinessPagePayload(payload = {}) {
  const criteria = isPlainObject(payload.criteria) ? { ...payload.criteria } : {};
  const prompt = String(payload.prompt || '').trim();
  const hasBusinessPageSignal = Boolean(
    criteria.page
    || criteria.pageUrl
    || criteria.pageFamilyId
    || criteria.pageFamilyDetailId
    || criteria.businessName
    || criteria.businessPageViewsPreviewOnly
    || payload.downloadType === 'DownServlet'
    || looksLikeBusinessPagePacketPreviewPrompt(prompt)
  );
  if (!hasBusinessPageSignal) {
    return payload;
  }

  const pageUrl = String(criteria.page || criteria.pageUrl || '').trim() || extractFirstHttpPageUrl(prompt);
  if (pageUrl && !criteria.page) criteria.page = pageUrl;
  if (pageUrl && !criteria.pageUrl) criteria.pageUrl = pageUrl;

  const normalized = {
    ...payload,
    downloadType: 'DownServlet',
    criteria
  };

  const asksPreview = String(normalized.mode || '').trim() === 'preview_only'
    || /预览|查看|明细|访问实例|对端|选择/.test(prompt)
    || criteria.businessPageViewsPreviewOnly;
  if (asksPreview) {
    normalized.mode = 'preview_only';
    normalized.criteria.businessPageViewsPreviewOnly = true;
  }

  return normalized;
}


function buildPacketAnalysisReply(result = {}) {
  const summary = isPlainObject(result?.summary) ? result.summary : {};
  const highlights = Array.isArray(summary.highlights)
    ? summary.highlights.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!result?.ok) {
    return String(
      result?.message
      || result?.error?.message
      || highlights.join('\n')
      || '数据包任务执行失败。'
    ).trim();
  }
  if (highlights.length > 0) {
    return highlights.join('\n');
  }
  return JSON.stringify(result, null, 2);
}

function buildReportDataForExport(args = {}) {
  const explicitReportData = isPlainObject(args.reportData) ? args.reportData : null;
  const rememberedRecord = getLatestRememberedSkillRecord();
  const rememberedReportData = getReportDataFromRecord(rememberedRecord);
  const sourceReportData = explicitReportData || rememberedReportData;
  if (!sourceReportData) {
    return {
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND',
      message: '未找到可导出的 NAPM reportData。请先完成一次 NAPM 查询或分析，再说“将以上导出为 Word”。'
    };
  }

  const format = normalizeReportFormat(args.format || args.reportPlan?.format || sourceReportData.format || sourceReportData.defaultFormat || 'docx');
  return {
    ok: true,
    reportData: {
      ...sourceReportData,
      format,
      title: String(args.title || args.reportPlan?.title || sourceReportData.title || '').trim() || sourceReportData.title,
      sourceQuestion: String(args.sourceQuestion || args.prompt || sourceReportData.sourceQuestion || '').trim() || sourceReportData.sourceQuestion,
      audit: {
        ...(isPlainObject(sourceReportData.audit) ? sourceReportData.audit : {}),
        exportPrompt: normalizePrompt(args) || null,
        reportDataSource: explicitReportData ? 'tool_args.reportData' : 'latest_napm_skill_result',
        sourcePromptKey: rememberedRecord?.promptKey || null
      }
    },
    source: explicitReportData ? 'tool_args.reportData' : 'latest_napm_skill_result'
  };
}

function buildReportInputForExport(args = {}) {
  const explicitReportData = isPlainObject(args.reportData) ? args.reportData : null;
  const rememberedRecord = getLatestRememberedSkillRecord();
  const rememberedReportData = getReportDataFromRecord(rememberedRecord);
  const explicitSourceResult = isPlainObject(args.sourceResult)
    ? args.sourceResult
    : (isPlainObject(args.packetResult)
      ? args.packetResult
      : (isPlainObject(args.queryResult) ? args.queryResult : null));
  const rememberedSourceResult = isPlainObject(rememberedRecord?.result) ? rememberedRecord.result : null;
  const sourceResult = explicitSourceResult || rememberedSourceResult;
  const sourceReportData = explicitReportData || rememberedReportData;

  if (!sourceReportData && !sourceResult) {
    return {
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND',
      message: '未找到可导出的结构化结果。请先完成一次 NAPM 查询或数据包分析，再导出 Word。'
    };
  }

  const format = normalizeReportFormat(
    args.format
    || args.reportPlan?.format
    || sourceReportData?.format
    || sourceReportData?.defaultFormat
    || 'docx'
  );

  const reportInput = {
    prompt: normalizePrompt(args) || null,
    format,
    title: String(args.title || args.reportPlan?.title || sourceReportData?.title || '').trim() || undefined,
    sourceQuestion: String(args.sourceQuestion || args.prompt || sourceReportData?.sourceQuestion || '').trim() || undefined
  };

  if (sourceReportData) {
    reportInput.reportData = {
      ...sourceReportData,
      format,
      title: reportInput.title || sourceReportData.title,
      sourceQuestion: reportInput.sourceQuestion || sourceReportData.sourceQuestion,
      audit: {
        ...(isPlainObject(sourceReportData.audit) ? sourceReportData.audit : {}),
        exportPrompt: normalizePrompt(args) || null,
        reportDataSource: explicitReportData ? 'tool_args.reportData' : 'latest_napm_skill_result.reportData',
        sourcePromptKey: rememberedRecord?.promptKey || null
      }
    };
  } else {
    reportInput.sourceResult = sourceResult;
  }

  return {
    ok: true,
    reportData: reportInput.reportData || null,
    reportInput,
    source: sourceReportData
      ? (explicitReportData ? 'tool_args.reportData' : 'latest_napm_skill_result.reportData')
      : (explicitSourceResult ? 'tool_args.sourceResult' : 'latest_structured_skill_result')
  };
}


function buildReportExportReply(result = {}) {
  if (!result?.ok) {
    return String(result?.message || '报告导出失败。').trim();
  }
  const lines = [
    `报告已生成：${result.title || result.reportId || 'NAPM 报告'}`,
    `格式：${result.format || 'docx'}`
  ];
  if (result.downloadUrl) {
    lines.push(`下载链接：${result.downloadUrl}`);
  }
  if (result.filePath) {
    lines.push(`文件路径：${result.filePath}`);
  }
  return lines.join('\n');
}

function buildResolvedQueryForPrompt(prompt = '', args = {}) {
  const normalizedPrompt = String(prompt || '').trim() || normalizePrompt(args);
  const resolver = getNapmResolvedQueryResolverService();
  if (!normalizedPrompt) {
    return {
      source: 'NapmResolvedQueryResolverService',
      result: {
        ok: false,
        reason: 'missing_prompt',
        message: 'Cannot construct resolvedQuery because prompt is empty.'
      },
      resolvedQuery: null
    };
  }

  if (!resolver || typeof resolver.resolvePrompt !== 'function') {
    return {
      source: 'NapmResolvedQueryResolverService',
      result: {
        ok: false,
        reason: 'resolver_unavailable',
        message: 'NAPM resolvedQuery resolver service is unavailable.'
      },
      resolvedQuery: null
    };
  }

  let result = null;
  try {
    result = resolver.resolvePrompt(normalizedPrompt, {
      nowSeconds: args?.nowSeconds
    });
  } catch (error) {
    return {
      source: 'NapmResolvedQueryResolverService',
      result: {
        ok: false,
        reason: 'resolver_exception',
        message: error?.message || 'NAPM resolvedQuery resolver threw an exception.'
      },
      resolvedQuery: null
    };
  }

  const resolvedQuery = normalizeResolvedQueryForPlugin(result?.resolvedQuery);
  const validation = validateResolvedQueryAgainstSpec(resolvedQuery, getResolvedQueryValidationOptions(args));
  if (!result?.ok || !isPlainObject(resolvedQuery) || !validation.ok) {
    return {
      source: 'NapmResolvedQueryResolverService',
      result: {
        ...(isPlainObject(result) ? result : {}),
        ok: false,
        validation: {
          ok: Boolean(validation.ok),
          reason: validation.reason || null,
          message: validation.message || null
        }
      },
      resolvedQuery: null
    };
  }

  return {
    source: 'NapmResolvedQueryResolverService',
    result,
    resolvedQuery: validation.resolvedQuery || resolvedQuery
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
  return napmQuerySkill().handleSkillCall(nextArgs);
}

function isQueryLikeAction(nextAction) {
  return nextAction === 'GO_DIRECT_QUERY' || nextAction === 'GO_OVERVIEW_QUERY';
}

async function runGatewaySkillFallback(args = {}) {
  return napmQuerySkill().handleSkillCall(args);
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

  if (isAlertSkillResultRecord(rememberedRecord)) {
    return buildAlertQueryReply(rememberedRecord.result);
  }

  const rememberedReply = makeTextReplyFromSkillResult(rememberedRecord.result);
  return String(rememberedReply?.text || '').trim();
}

function buildBusinessInventoryCorrectedReply(rememberedRecord = null) {
  const rememberedText = buildRememberedSkillReplyText(rememberedRecord);
  if (rememberedText) {
    return rememberedText;
  }
  return [
    '当前业务清单回答必须以 NAPM skill 返回结果为准。',
    'WebApplication 业务系统目录的查询口径是 applications Type=3；不能解释为近期活跃流量过滤，也不能按中文名称过滤。'
  ].join('\n');
}

function buildSkillRequiredReply() {
  return [
    '当前问题必须经 NAPM skill 执行后才能回答。',
    '本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。',
    '请以技能执行结果为准。'
  ].join('\n');
}

function buildAlertSkillRequiredReply() {
  return [
    '当前问题必须通过 napm-alert-query 执行后才能回答。',
    '本轮没有拿到可核验的告警查询结果，因此不能判断“没有告警”，也不能补写告警查询过程。',
    '请以 napm-alert-query 返回的 alertsSummary / alertsSummaryTimeLine / alertsDetail 结构化结果为准。'
  ].join('\n');
}

function buildHierarchySkillRequiredReply() {
  return [
    '当前问题属于 NAPM 下钻/层级目录查询，不能手动读取 groups-tree.static.json、不能只看某个 children=[] 节点，也不能用组合路径推测回答。',
    '必须先由 OpenClaw 构造 resolvedQuery：service=drilldownCatalog，groups=[{type:"目标对象"}]，再调用 napm-skill-query。',
    '本轮没有拿到有效的 drilldownCatalog skill 结果，因此不输出推测性下钻路径。'
  ].join('\n');
}

function buildSkillRequiredReplyForPrompt(prompt = '') {
  if (isAlertEventPrompt(prompt) || isAlertSkillMetaFollowUpPrompt(prompt)) {
    return buildAlertSkillRequiredReply();
  }
  if (isPacketCapturePrompt(prompt)) {
    return buildPacketSkillRequiredReply();
  }
  return isHierarchyCatalogPrompt(prompt)
    ? buildHierarchySkillRequiredReply()
    : buildSkillRequiredReply();
}

function buildPacketSkillRequiredReply() {
  return [
    '当前问题必须通过 napm-packet-analysis 执行后才能回答。',
    '本轮没有拿到有效的数据包 skill 结果，因此不展示手写 packetsPreview/packetsDown 链接，也不判断账号权限。',
    '请以 napm-packet-analysis 返回的链接为准；链接应包含运行时认证参数并对 Password 脱敏。'
  ].join('\n');
}

function shouldForceSkillRecordForPrompt(prompt = '', guardState = null) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return Boolean(
    isAlertEventPrompt(text)
    || isAlertSkillMetaFollowUpPrompt(text, guardState)
    || guardState?.alertRelated
    || isPacketCapturePrompt(text)
    || isBusinessObjectInventoryPrompt(text)
    || isBusinessGroupInventoryPrompt(text)
    || isCompositeApplicationInventoryPrompt(text)
    || isMetricInventoryPrompt(text)
    || isMetricInventoryDetailPrompt(text)
    || isHierarchyCatalogPrompt(text)
    || isNapmMetaFollowUpPrompt(text, guardState)
  );
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

  if (isAlertEventPrompt(prompt) || isAlertSkillMetaFollowUpPrompt(prompt, guardState) || guardState?.alertRelated) {
    return !isAlertSkillResultRecord(rememberedRecord);
  }

  if (rememberedRecord && isPlainObject(rememberedRecord.result)) {
    return false;
  }

  if (
    isPacketCapturePrompt(prompt)
    || isOverviewPrompt(prompt)
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
  const requestParams = isPlainObject(result?.requestParamsJson)
    ? result.requestParamsJson
    : (isPlainObject(result?.requestParams) ? result.requestParams : null);
  const metadata = isPlainObject(result?.metadata) ? result.metadata : null;
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
  if (requestParams) {
    lines.push(`requestParams：${JSON.stringify(requestParams)}`);
  }
  if (metadata) {
    lines.push(`metadata：providerType=${metadata.providerType || 'unknown'}，apiType=${metadata.apiType || 'unknown'}，applicationTypeFilter=${Array.isArray(metadata.applicationTypeFilter) ? JSON.stringify(metadata.applicationTypeFilter) : 'null'}`);
  }
  if (
    service === 'groups'
    && String(resolvedQuery?.groups?.[0]?.type || '').trim() === 'WebApplication'
    && metadata?.providerType === 'applications'
    && Array.isArray(metadata?.applicationTypeFilter)
    && metadata.applicationTypeFilter.map(Number).includes(3)
  ) {
    lines.push('业务查询口径：WebApplication 清单来自南向 applications 目录，并按 Type=3 做业务系统类型筛选。');
    lines.push('注意：这不是按流量活跃度过滤，也不是中文名称过滤；不能把对象增减解释为近期有无流量，除非另有指标查询结果证明。');
  }
  if (requestUrl) {
    lines.push(`Debug API：${requestUrl}`);
  } else {
    lines.push('Debug API：本条 skill 结果未记录 requestUrl。');
  }
  lines.push('未发现可核验记录时，不能补写任何未被日志证明的执行过程。');

  return lines.join('\n');
}

function buildAlertExecutionTraceReplyFromRememberedRecord(record = null) {
  if (!isAlertSkillResultRecord(record)) {
    return [
      '当前没有可核验的 napm-alert-query 执行记录，不能确认刚才实际走了告警查询 skill。',
      '因此我不会补写任何未被日志证明的工具调用、查询数量或执行过程。',
      '告警事件问题需要以 napm-alert-query 的 alertsSummary / alertsSummaryTimeLine / alertsDetail 结果为准。'
    ].join('\n');
  }

  const result = record.result;
  const service = String(result.service || '').trim() || 'unknown';
  const mode = String(result.mode || result?.narrationInput?.mode || '').trim() || 'unknown';
  const total = result?.summary?.total;
  const timeRange = result.timeRange || {};
  const lines = [
    '这次只能按已记录的告警 skill 结果说明查询链路：',
    '工具：napm-alert-query',
    `mode：${mode}`,
    `service：${service}`
  ];

  if (timeRange.start || timeRange.end) {
    lines.push(`timeRange：${timeRange.start || 'unknown'} ~ ${timeRange.end || 'unknown'}`);
  }
  if (total != null) {
    lines.push(`告警总数：${total}`);
  }
  const requestUrls = Array.isArray(result.requestUrls) && result.requestUrls.length > 0
    ? result.requestUrls
    : (result.requestUrl ? [result.requestUrl] : []);
  for (const requestUrl of requestUrls.map(maskDebugApiUrl).filter(Boolean).slice(0, 5)) {
    lines.push(`Debug API：${requestUrl}`);
  }
  lines.push('未发现可核验的 napm-alert-query 记录时，不能声明已经查过告警或没有告警。');

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
    isAlertEventPrompt(text)
    || isAlertSkillMetaFollowUpPrompt(text, guardState || conversationState)
    || isMetricInventoryPrompt(text)
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
  const timeConstructionRules = Array.isArray(queryContract.constructionRules)
    ? queryContract.constructionRules.join(' ')
    : 'Executable timestamps must be root-level start/end.';
  return {
    label: 'NAPM Skill Query',
    name: 'napm-skill-query',
    description: `Run the NAPM skill executor with a structured resolvedQuery already produced by OpenClaw upstream. This is the only production NAPM tool entry; use it after intent resolution, object scoping, time-range resolution, and query shaping are complete. Accepted structured input channel: ${acceptedInputs}. Time contract: ${timeConstructionRules}`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability after resolvedQuery has been constructed.' },
        userQuery: { type: 'string', description: 'Alias of prompt for traceability only; do not rely on this instead of resolvedQuery for structured NAPM queries.' },
        decision: { type: 'object', description: 'Optional structured decision object.', additionalProperties: true },
        intent: { type: 'object', description: 'Optional structured intent object.', additionalProperties: true },
        resolvedQuery: {
          type: 'object',
          description: 'Required fully resolved query payload. For executable data services such as topValues, averageValues, timeValues, overview, and topValues_multi_protocol, put Unix-second execution timestamps at root-level start and end, aligned to 60-second minute boundaries. Do not put executable timestamps only in timeRange.start/timeRange.end; timeRange is declarative metadata only.',
          properties: {
            service: { type: 'string' },
            queryModeKey: { type: 'string' },
            metrics: { type: 'array', items: { type: 'string' } },
            metric: { type: 'string' },
            topMetric: { type: 'string' },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  argument: {}
                },
                additionalProperties: true
              }
            },
            topCount: { type: 'number' },
            start: {
              type: 'number',
              description: 'Auto-filled by plugin from timeRange.key. Do NOT calculate or fill this yourself.'
            },
            end: {
              type: 'number',
              description: 'Auto-filled by plugin from timeRange.key. Do NOT calculate or fill this yourself.'
            },
            timeRange: {
              type: 'object',
              description: 'REQUIRED: set key to last1hour|last24hours|today|yesterday|last7days|last30days. Plugin auto-computes start/end from key. Do NOT set start/end yourself.',
              properties: {
                key: { type: 'string', description: 'last1hour|last24hours|today|yesterday|last7days|last30days' },
                displayText: { type: 'string' }
              },
              additionalProperties: false
            },
            format: { type: 'string' },
            semanticConstraints: { type: 'object', additionalProperties: true },
            pathPlanning: { type: 'object', additionalProperties: true },
            resolutionHints: { type: 'object', additionalProperties: true }
          },
          required: ['service'],
          additionalProperties: true
        },
        sessionState: { type: 'object', description: 'Optional multi-turn session state.', additionalProperties: true },
        clarificationContext: { type: 'object', description: 'Optional clarification state.', additionalProperties: true },
        policyAction: { type: 'string', description: 'Optional upstream policy action override.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args) => {
      const preparedArgs = prepareSkillExecutionArgs(args || {});
      const validation = validateResolvedQueryAgainstSpec(
        preparedArgs?.resolvedQuery,
        getResolvedQueryValidationOptions(preparedArgs)
      );
      if (isPlainObject(validation.resolvedQuery)) {
        preparedArgs.resolvedQuery = validation.resolvedQuery;
      }
      if (!validation.ok) {
        appendPluginAuditEvent('napm_plugin_tool_execute_resolved_query_blocked', {
          traceId: normalizeTraceId(preparedArgs?.traceId) || buildNapmTraceId({}, preparedArgs),
          prompt: normalizePrompt(preparedArgs),
          reason: validation.reason || null,
          message: validation.message || null,
          resolvedQuery: normalizeObject(preparedArgs?.resolvedQuery) || null,
          resolvedQuerySummary: summarizeResolvedQueryForAudit(preparedArgs?.resolvedQuery)
        });
        return makeToolResult(buildResolvedQueryBoundaryFailureResult(validation, preparedArgs));
      }
      const result = await napmQuerySkill().handleSkillCall(preparedArgs);
      rememberDebugApi(normalizePrompt(preparedArgs), result, null);
      return makeToolResult(result);
    }
  };
}

function createReportExportToolDefinition() {
  return {
    label: 'NAPM Report Export',
    name: 'napm-report-export',
    description: 'Export the latest NAPM skill result reportData, or an explicitly provided reportData object, into a report file. Use this only when the user explicitly asks to generate/export a report, Word, docx, or PDF from current/previous NAPM query results. This tool does not query NAPM and must not be used as a data-query fallback.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original report export prompt, such as 将以上以 Word 形式导出.' },
        format: { type: 'string', enum: ['docx', 'word', 'pdf'], description: 'Requested export format. word is normalized to docx. pdf currently returns REPORT_PDF_EXPORT_UNAVAILABLE.' },
        title: { type: 'string', description: 'Optional report title override.' },
        reportPlan: { type: 'object', description: 'Optional upstream report plan.', additionalProperties: true },
        reportData: { type: 'object', description: 'Optional reportData from napm-skill-query. If omitted, the latest fresh NAPM skill result reportData is used.', additionalProperties: true },
        downloadBaseUrl: { type: 'string', description: 'Optional download base URL, defaults to /reports.' },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmReportSkill().handleSkillCall(args || {});
      rememberReportExportResult(normalizePrompt(args), result, args?.conversationKey || '');
      return {
        content: [
          {
            type: 'text',
            text: buildReportExportReply(result)
          }
        ],
        details: result
      };
    }
  };
}

function createAlertQueryToolDefinition() {
  return {
    label: 'NAPM Alert Query',
    name: 'napm-alert-query',
    description: 'Execute the standalone NAPM alert skill for alert summary, alert timeline, alert detail, trigger metric series, notification field explanation, packet handoff, and reportData generation. Use this for 告警, 告警事件, 告警详情, 告警时间线, 紧急告警, 重大告警, 轻微告警, alertsSummary, alertsSummaryTimeLine, alertsDetail, Email/SNMP/SysLog alert notification explanation. This tool is read-only and must not modify alert rules.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability.' },
        mode: {
          type: 'string',
          enum: [
            'summary',
            'timeline',
            'detail',
            'detail_with_timeseries',
            'analysis',
            'explain_notification',
            'explain_event_fields'
          ],
          description: 'Alert task mode.'
        },
        alertQuery: { type: 'object', description: 'Full alert query payload accepted by openclaw-napm-alert-query.', additionalProperties: true },
        criteria: {
          type: 'object',
          description: 'Alert criteria. Executable modes require start/end Unix-second timestamps. detail modes require eventIds.',
          properties: {
            start: { type: 'number', description: 'Unix-second start timestamp.' },
            end: { type: 'number', description: 'Unix-second end timestamp.' },
            categories: { type: 'array', items: { type: 'string' } },
            severities: { type: 'array', items: { type: 'number' }, description: '2=轻微, 3=重大, 4=紧急.' },
            objects: { type: 'array', items: { type: 'string' } },
            eventIds: { type: 'array', items: { type: 'string' } },
            metrics: { type: 'array', items: { type: 'string' } },
            categoryTypes: { type: 'array', items: { type: 'number' } },
            taskTypes: { type: 'array', items: { type: 'string' } },
            linkTypes: { type: 'array', items: { type: 'number' } },
            granularity: { type: 'number' }
          },
          additionalProperties: true
        },
        options: {
          type: 'object',
          properties: {
            includeRaw: { type: 'boolean' },
            includeTimeline: { type: 'boolean' },
            includeDetail: { type: 'boolean' },
            includeMetricSeries: { type: 'boolean' },
            packetHandoff: { type: 'boolean' },
            topObjectsLimit: { type: 'number' },
            maxEvents: { type: 'number' }
          },
          additionalProperties: true
        },
        sessionState: { type: 'object', description: 'Optional multi-turn alert session state.', additionalProperties: true },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmAlertSkill().handleSkillCall(args || {});
      const renderedText = buildAlertQueryReply(result);
      const pi = result?.narrationInput?.packetInstruction;
      const dt = result?.narrationInput?.displayText;
      pendingAlertDisplayText = dt || null;
      appendPluginAuditEvent('napm_alert_displaytext_set', {
        hasDisplayText: Boolean(dt),
        displayTextLen: typeof dt === 'string' ? dt.length : 0
      });
      rememberSkillResult(normalizePrompt(args), result, args?.conversationKey || '');

      // 有 packetInstruction 时：text=AI指令, finalAnswer=摘要, details=完整数据
      if (pi && pi.callPacketAnalysis && Array.isArray(pi.candidates) && pi.candidates.length > 0) {
        return {
          text: renderedText,
          details: result,
          metadata: {
            ok: Boolean(result?.ok),
            mode: result?.mode || null,
            total: result?.summary?.total ?? null,
            packetHandoff: result?.packetHandoff || null,
            packetInstruction: pi,
            candidateCount: pi.candidates.length,
            candidates: pi.candidates.map((c) => ({
              rank: c.rank,
              ipPair: c.ipPair || null,
              ip: c.ip || null,
              suggestedPacketQuery: c.suggestedPacketQuery,
            })),
          }
        };
      }

      // summary / 无数据包模式：只返回 finalAnswer（纯文本），不给 AI 任何结构化数据
      // 防止 AI 从文本中解析数字后自行重组输出（算百分比、画 markdown 表格等）
      return {
        finalAnswer: renderedText
      };
    }
  };
}

function createInspectionSnapshotToolDefinition() {
  return {
    label: 'NAPM Inspection Snapshot',
    name: 'napm-inspection-snapshot',
    description: 'Collect a structured NAPM health inspection snapshot for traffic analysis system inspection reports. Use this for 巡检, 巡检报告, 健康检查报告, 基于AI的全流量性能分析平台巡检, device health inspection, traffic trend inspection, and business performance inspection. The tool queries NAPM and returns reportData for napm-report-export.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability.' },
        customerName: { type: 'string', description: 'Customer name for the inspection report, for example 北京烟草.' },
        projectName: { type: 'string', description: 'Project/system name. Defaults to 基于AI的全流量性能分析平台.' },
        reportDate: { type: 'string', description: 'Report date, usually YYYY-MM-DD.' },
        title: { type: 'string', description: 'Optional report title override.' },
        format: { type: 'string', enum: ['docx', 'word'], description: 'Requested reportData format. word is normalized by the report skill.' },
        inspectionQuery: { type: 'object', description: 'Full inspection query payload accepted by openclaw-napm-inspection.', additionalProperties: true },
        source: { type: 'object', description: 'Optional fixture source for tests/offline rendering. Omit for live NAPM collection.', additionalProperties: true },
        thresholds: { type: 'object', description: 'Optional inspection threshold overrides.', additionalProperties: true },
        nowSeconds: { type: 'number', description: 'Optional deterministic current Unix timestamp in seconds for tests.' },
        timezone: { type: 'string', description: 'Timezone for formatted inspection timestamps.' },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmInspectionSkill().handleSkillCall(args || {});
      rememberSkillResult(normalizePrompt(args), result, args?.conversationKey || '');
      return {
        content: [
          {
            type: 'text',
            text: buildInspectionSnapshotReply(result)
          }
        ],
        details: result
      };
    }
  };
}

function createSummaryToolDefinition() {
  return {
    label: 'NAPM Summary',
    name: 'napm-summary',
    description: 'Generate a NAPM summary/overview report aggregating alerts, traffic trends, and business performance data across a configurable time range and scope. Use this for 综述报告, 全局综述, 业务综述, 应用综述, 业务组综述, 网络综述, 告警综述, summary report, overview report, daily/weekly/monthly report. The tool queries NAPM APIs in parallel and returns structured reportData for napm-report-export.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability.' },
        scope: {
          type: 'object',
          description: 'Summary scope definition.',
          properties: {
            type: { type: 'string', enum: ['global', 'webApplication', 'application', 'businessGroup', 'network', 'alert'], description: 'Scope type: global=全局综述, webApplication=业务综述, application=应用综述, businessGroup=业务组综述, network=网络综述, alert=告警综述.' },
            label: { type: 'string', description: 'Human-readable scope label, e.g. 全局, 业务, 应用, 业务组, 网络, 告警.' },
            target: {
              type: 'object',
              description: 'Required for non-global scopes. The specific NAPM object to focus on.',
              properties: {
                groupType: { type: 'string', description: 'NAPM group type, e.g. WebApplication, Application, BusinessGroup, IPAddress.' },
                groupArgument: { type: 'string', description: 'NAPM group argument value, e.g. 239web.' },
                groupLabel: { type: 'string', description: 'Display label for the target object.' }
              },
              additionalProperties: true
            }
          },
          additionalProperties: false
        },
        timeRange: {
          type: 'object',
          description: 'Time range for the summary. If omitted, defaults to last 24 hours.',
          properties: {
            start: { type: 'number', description: 'Unix seconds start.' },
            end: { type: 'number', description: 'Unix seconds end.' },
            displayText: { type: 'string', description: 'Human-readable time range.' }
          },
          additionalProperties: false
        },
        format: { type: 'string', enum: ['docx', 'word'], description: 'Output format. Defaults to docx.' },
        title: { type: 'string', description: 'Optional custom report title.' },
        systemName: { type: 'string', description: 'Optional system name override.' },
        sourceQuestion: { type: 'string', description: 'Original user question for traceability.' },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmSummarySkill().handleSkillCall(args || {});
      rememberSkillResult(normalizePrompt(args), result, args?.conversationKey || '');
      return {
        content: [
          {
            type: 'text',
            text: buildSummaryReply(result)
          }
        ],
        details: result
      };
    }
  };
}

function createFaultDiagnosisToolDefinition() {
  return {
    label: 'NAPM Fault Diagnosis',
    name: 'napm-fault-diagnosis',
    description: 'Run a standardized NAPM fault diagnosis flow for B/S web application errors or C/S application slowness. Executes all diagnostic steps automatically and returns a structured fault analysis report ready for docx export. Use this for: Web系统4xx/5xx报错分析, 页面错误分析, HTTP状态码详情, C/S应用性能诊断, 业务故障分析. The tool queries NAPM indicators step by step, generates judgment hints, and produces reportData for napm-report-export. IMPORTANT: after napm-fault-diagnosis returns reportData, you MUST call napm-report-export to generate the Word file.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability.' },
        description: { type: 'string', description: 'Fault description, e.g. "238web页面大量HTTP 400/500报错"' },
        flowType: { type: 'string', enum: ['bs_app_slow', 'cs_app_slow', 'network_slow'], description: 'Diagnostic flow type. bs_app_slow=Web应用4xx/5xx错误分析, cs_app_slow=C/S应用性能诊断, network_slow=网络慢分析.' },
        target: {
          type: 'object',
          description: 'The NAPM object to analyze. Required for bs_app_slow and cs_app_slow.',
          properties: {
            groupType: { type: 'string', description: 'NAPM group type, e.g. WebApplication, Application, DefinedApp.' },
            groupArgument: { type: 'string', description: 'NAPM group argument, e.g. 238web.' },
            groupLabel: { type: 'string', description: 'Display label for the target object.' }
          },
          additionalProperties: true
        },
        timeRange: {
          type: 'object',
          description: 'Fault time window. If omitted, defaults to last 24 hours.',
          properties: {
            faultWindow: {
              type: 'object',
              properties: {
                start: { type: 'number', description: 'Fault window start (Unix seconds).' },
                end: { type: 'number', description: 'Fault window end (Unix seconds).' }
              }
            },
            baselineWindow: {
              type: 'object',
              properties: {
                start: { type: 'number', description: 'Baseline window start (Unix seconds).' },
                end: { type: 'number', description: 'Baseline window end (Unix seconds).' }
              }
            }
          }
        },
        fault: {
          type: 'object',
          description: 'Optional fault metadata.',
          properties: {
            description: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
            affectedObjects: { type: 'array', items: { type: 'string' } },
            recommendations: { type: 'array', items: { type: 'string' } },
            prevention: { type: 'array', items: { type: 'string' } }
          }
        },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmFaultDiagnosisSkill().handleSkillCall(args || {});
      rememberSkillResult(normalizePrompt(args), result, args?.conversationKey || '');
      return {
        content: [
          {
            type: 'text',
            text: buildFaultDiagnosisReply(result)
          }
        ],
        result
      };
    }
  };
}

function createPacketAnalysisToolDefinition() {
  return {
    label: 'NAPM Packet Analysis',
    name: 'napm-packet-analysis',
    description: 'Execute the standalone NAPM packet skill for packet preview/download URL construction, packet preview, packet download, business page packet preview, or pcap/cap analysis. Use this for 数据包, 报文, 抓包, pcap/cap, packetsPreview, packetsDown, DownServlet, pageViews requests WHEN the target IPs are already known. ⚠️ If the user says "告警数据包 <eventId>", do NOT use this skill directly — route to napm-alert-query FIRST for automatic IP discovery. The criteria.id parameter is ONLY for linkType=2 event IDs, NOT for alert event IDs.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability.' },
        mode: {
          type: 'string',
          enum: [
            'build_url_only',
            'explain_url',
            'preview_only',
            'download_only',
            'preview_download',
            'analyze_file',
            'download_analyze',
            'preview_download_analyze'
          ],
          description: 'Packet task mode. Use build_url_only for link-only requests; preview_only for large/uncertain ranges; preview_download_analyze for safe packet analysis requests.'
        },
        downloadType: { type: 'string', enum: ['packetsDown', 'DownServlet'], description: 'Packet download endpoint type.' },
        packetQuery: { type: 'object', description: 'Optional full packet query payload accepted by openclaw-napm-packet-analysis.', additionalProperties: true },
        criteria: {
          type: 'object',
          description: 'Packet criteria. Live preview/download requires start/end and one target such as ips, ipRanges, id, top, instanceId, businessName, pageFamilyId, pageFamilyDetailId, page, or pageUrl.',
          properties: {
            host: { type: 'string', description: 'Optional NetInside host. Normally omit and let runtime env provide NETINSIDE_HOST.' },
            ips: { type: 'array', items: { type: 'string' } },
            ipRanges: { type: 'array', items: { type: 'string' } },
            id: { type: 'string', description: 'Event ID for linkType=2 packets ONLY. Do NOT use for alert event IDs — route to napm-alert-query first.' },
            instanceId: { type: 'string' },
            businessName: { type: 'string', description: 'Web application/business name for business packet DownServlet resolution.' },
            page: { type: 'string', description: 'Business page URL/path to preview via pageViews before DownServlet download.' },
            pageUrl: { type: 'string', description: 'Alias of page. Use for Web page URL/path packet preview.' },
            pageFamilyId: { type: 'string', description: 'Known PageFamily id. Starts business packet preview from pageViews.' },
            pageFamilyDetailId: { type: 'string', description: 'Known pageViews detail id. Used to construct DownServlet instanceId.' },
            clientIp: { type: 'string', description: 'Optional client IP selected from pageViews preview rows.' },
            serverIp: { type: 'string', description: 'Optional server IP selected from pageViews preview rows.' },
            pageViewIndex: { type: 'number', description: 'Optional row index selected from pageViews preview rows.' },
            top: { type: 'object', additionalProperties: true },
            start: { type: 'number', description: 'Unix-second start timestamp.' },
            end: { type: 'number', description: 'Unix-second end timestamp.' }
          },
          additionalProperties: true
        },
        analysis: { type: 'object', description: 'Optional tshark analysis options.', additionalProperties: true },
        filePolicy: { type: 'object', description: 'Optional packet download/file safety policy.', additionalProperties: true },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmPacketSkill().handleSkillCall(args || {});
      rememberSkillResult(normalizePrompt(args), result, args?.conversationKey || '');
      return {
        content: [
          {
            type: 'text',
            text: buildPacketAnalysisReply(result)
          }
        ],
        details: result
      };
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
  const skillResult = await napmQuerySkill().handleSkillCall(skillArgs);
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


function buildNapmRoutingSystemContext(opts = {}) {
  const queryContract = getResolutionSpecQueryContract() || {};
  const acceptedInputs = Array.isArray(queryContract?.acceptedInputs)
    ? queryContract.acceptedInputs.join(', ')
    : 'payload.resolvedQuery';
  const prompt = String(opts.prompt || '').trim();

  // Scene detection via existing classifiers (all accept prompt string)
  var isFault = false, isSummary = false, isAlert = false, isPacket = false;
  try {
    if (prompt) {
      isFault = isFaultDiagnosisPrompt(prompt);
      isSummary = isSummaryPrompt(prompt);
      isAlert = isAlertEventPrompt(prompt);
      isPacket = isPacketCapturePrompt(prompt);
    }
  } catch (_e) { /* classifier errors → inject all rules as fallback */ }

  var isNapm = Boolean(opts.napmRelated) || (prompt && isNapmRelatedPrompt(prompt));
  // Guard: if no scene detected, default to data-query + packet scenes to cover all possibilities
  var anyScene = isFault || isSummary || isAlert || isPacket;
  if (!anyScene) { isFault = true; isSummary = true; isAlert = true; isPacket = true; }

  var rules = [];

  // ── TOOL ROUTING TABLE (always) ──
  rules.push(
    'TOOL ROUTING — pick exactly one entry point based on user intent:',
    '  fault/error analysis (故障/报错/4xx/5xx) → napm-fault-diagnosis (flowType="bs_app_slow", target={groupType:"WebApplication",groupArgument,groupLabel}, timeRange) → napm-report-export',
    '  summary/overview report (综述报告/日报/周报/月报) → napm-summary (scope+timeRange) → napm-report-export (auto, no user prompt)',
    '  inspection report (巡检/健康检查) → napm-inspection-snapshot → napm-report-export',
    '  alert events (告警/告警摘要/告警详情/告警时间线) → napm-alert-query',
    '  packet capture/analysis (数据包/报文/抓包/pcap) → napm-packet-analysis',
    '  alert+packet combined (告警数据包 <eventId>) → napm-alert-query FIRST (mode=detail) → napm-packet-analysis with suggestedPacketQuery',
    '  data query (ranking/average/trend/overview/inventory/metric-list/drilldown) → napm-skill-query',
    '  report/export only (将以上导出Word/生成报告, no new data) → napm-report-export (consume existing reportData)',
    'Do NOT use napm-skill-query for reports, fault analysis, alerts, or packet requests. Each domain has its own tool.',
    'napm-resolve-query and napm-mainflow-query are diagnostic-only; do not use in production.',
    'Legacy tools napm-timeseries/napm-topn/napm-average are removed.'
  );

  // ── SCOPE MAPPING (only for summary) ──
  if (isSummary) {
    rules.push('Scope mapping: 全局/系统/NAPM→{type:"global",label:"全局"} 业务→{type:"webApplication",label:"业务"} 网络→{type:"network",label:"网络"} 工作组→{type:"businessGroup",label:"工作组"} 应用→{type:"application",label:"应用"} 告警→{type:"alert",label:"告警"}. Omit scope.target for overall review.');
  }

  // ── GENERAL BOUNDARY (always) ──
  rules.push(
    'You handle only system monitoring, NAPM query, anomaly diagnosis, and result interpretation. Non-monitoring (weather/chat/entertainment) → briefly redirect.',
    'OpenClaw upstream owns resolvedQuery construction. Plugin forwards structured queries; skill executes them.',
    'Accepted input: ' + acceptedInputs + '. Data queries require structured resolvedQuery, not raw prompt only.',
    '',
    'Time: set timeRange.key only (last1hour|last24hours|today|yesterday|last7days|last30days). Plugin computes start/end from server clock. Do NOT pass start/end timestamps. Example: {service:"topValues",timeRange:{key:"last1hour",displayText:"最近1小时"}}.',
    'Query construction rules (inventory/metric ownership/drilldown/time wording/follow-up) → skills/openclaw-napm-query/references/query-workflow-contract.md.'
  );

  // ── ALERT CONTRACT (only for alert scenes) ──
  if (isAlert) {
    rules.push(
      'Alert mode: summary=list, timeline=trend, detail=by eventId, detail_with_timeseries=trigger metrics, explain_notification=field help. Read-only tool.',
      'Alert answer: output result verbatim. Do NOT add 建议关注/按严重程度/当前持续中/tables/bullet lists or any modification. Result IS the final answer.'
    );
  }

  // ── PACKET CONTRACT (only for packet scenes) ──
  if (isPacket) {
    rules.push(
      'Packet modes: build_url_only (link-only), preview_only (large ranges), preview_download_analyze (full). Business page preview: use downloadType="DownServlet"+criteria.page; never downgrade to IP-based packetsPreview when URL is provided. IP packetsPreview only when user explicitly asks 按IP.',
      'Alert-packet: napm-alert-query FIRST (auto IP discovery via packetHandoff), then napm-packet-analysis. criteria.id is for linkType=2 only, not alert event IDs.',
      'Trigger cause analysis: always explain alert trigger metrics/threshold/actual value/packet correlation. Do NOT skip because alert name contains 测试.'
    );
  }

  // ── ANSWER / FOLLOW-UP RULES (always) ──
  rules.push(
    'REJECT_AND_REDIRECT → explain boundary. ASK_CLARIFYING_QUESTION → ask and stop. ANSWER_CONCEPTUALLY/INTERPRET_RESULT → answer from result.',
    'Prefer displayText/summary.displayText directly over paraphrasing.',
    'Never answer from stale memory. Base reply on fresh tool result from current turn.',
    'Never claim data was queried by direct API/curl/exec/python. Say: use napm-skill-query with resolvedQuery.'
  );

  // ── REPORT EXPORT (always — small) ──
  rules.push(
    'Report export: napm-skill-query→napm-report-export (new). Follow-up export (将以上导出) → napm-report-export only (no re-query). Do not auto-export for ordinary data questions.',
    'Cross-skill: fresh alert report → napm-alert-query→napm-report-export. Fresh inspection → napm-inspection-snapshot→napm-report-export.',
    'PDF not available; if requested, call napm-report-export format=pdf and report error.',
    '',
    'Append "Debug API: <requestUrl>" at end of reply when present.',
    'Boundary requests (restart/deploy/config/SQL/code) mentioning NAPM objects → reject and redirect.'
  );

  return rules.join('\n');
}

const skillTool = createSkillToolDefinition();
const reportExportTool = createReportExportToolDefinition();
const alertQueryTool = createAlertQueryToolDefinition();
const inspectionSnapshotTool = createInspectionSnapshotToolDefinition();
const summaryTool = createSummaryToolDefinition();
const faultDiagnosisTool = createFaultDiagnosisToolDefinition();
const packetAnalysisTool = createPacketAnalysisToolDefinition();
const resolverTool = createResolvedQueryResolverToolDefinition();
const mainflowTool = createMainflowQueryToolDefinition();

const plugin = {
  id: 'napm-openclaw-plugin',
  name: 'NAPM OpenClaw Plugin',
  description: 'Bridge NAPM skill and query requests from OpenClaw into the deployed NAPM OpenClaw skill runtime.',
  register(api) {
    const registerNapmHook = (events, handler, opts = {}) => {
      if (api.hooks && typeof api.hooks.on === 'function') {
        const normalizedEvents = Array.isArray(events) ? events : [events];
        for (const eventName of normalizedEvents) {
          api.hooks.on(eventName, handler, opts);
        }
        return;
      }
      api.registerHook(events, handler, opts);
    };

    if (shouldEnableDevResolverTools()) {
      api.registerTool(resolverTool);
      api.registerTool(mainflowTool);
    }
    api.registerTool(skillTool);
    api.registerTool(reportExportTool);
    api.registerTool(alertQueryTool);
    api.registerTool(inspectionSnapshotTool);
    api.registerTool(summaryTool);
    api.registerTool(faultDiagnosisTool);
    api.registerTool(packetAnalysisTool);

    registerNapmHook(
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

    registerNapmHook(
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
            alertRelated: Boolean(conversationState?.alertRelated),
            alertEventPrompt: Boolean(conversationState?.alertEventPrompt),
            alertMetaFollowUpPrompt: Boolean(conversationState?.alertMetaFollowUpPrompt),
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
          appendSystemContext: buildNapmRoutingSystemContext({ prompt, napmRelated: promptNapmRelated })
        };
      },
      {
        name: 'napm-routing-policy',
        description: 'Force NAPM-related and monitored-object requests to pass through napm-skill-query before system-operation tools.'
      }
    );

    registerNapmHook(
      'before_tool_call',
      (event, ctx) => {
        const guardKeys = getGuardKeys(ctx);
        const guardState = getGuardState(ctx);
        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const toolName = String(event?.toolName || '').trim();
        const toolParams = isPlainObject(event?.params) ? event.params : {};
        api.logger.info(`[napm-openclaw-plugin] before_tool_call tool=${toolName} keys=${guardKeys.join(',') || 'none'} guard=${guardState ? 'hit' : 'miss'}`);

        // ── Unified Time Override (2026-07-07) ──────────────────────────────
        // Date.now() 无条件覆盖所有 NAPM Tool 的时间参数。
        // 替代之前在 runSkillExecutor 中只对 napm-skill-query 生效的时间覆盖。
        // 现在对所有需要时间的 Tool 统一生效。
        if (isSafeNapmToolName(toolName) && isPlainObject(event.params)) {
          try {
            const { applyTimeOverride } = require(path.resolve(__dirname, 'src/shared/timeResolver'));

            // napm-skill-query: 覆盖 resolvedQuery.start/end
            if (toolName === 'napm-skill-query' && isPlainObject(event.params.resolvedQuery)) {
              applyTimeOverride(event.params.resolvedQuery);
            }

            // napm-summary / napm-fault-diagnosis: 无条件覆盖时间（2026-07-08 修复）
            // 即使 LLM 直接传了 start/end 而没有传 timeRange.key，也必须用 Date.now() 覆盖。
            // 否则 SummaryService._resolveTimeRange 可能使用 LLM 提供的错误时间戳。
            if (toolName === 'napm-summary' || toolName === 'napm-fault-diagnosis') {
              if (!isPlainObject(event.params.timeRange)) {
                event.params.timeRange = {};
              }
              const now = Math.floor(Date.now() / 1000);
              const floor = (v) => Math.floor(v / 60) * 60;
              const timeKey = String(event.params.timeRange.key || '').trim() || 'last24hours';
              const DURATION_MAP = { last5minutes: 300, last1hour: 3600, last24hours: 86400,
                last1day: 86400, last7days: 604800, last30days: 2592000 };

              let start, end;
              if (timeKey === 'today') {
                const d = new Date(now * 1000); d.setHours(0, 0, 0, 0);
                start = floor(d.getTime() / 1000);
                end = floor(now);
              } else if (timeKey === 'yesterday') {
                const d = new Date(now * 1000); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0);
                start = floor(d.getTime() / 1000);
                end = floor(start + 86340);
              } else {
                const duration = DURATION_MAP[timeKey] || 86400;
                start = floor(now - duration);
                end = floor(now);
              }
              event.params.timeRange.start = start;
              event.params.timeRange.end = end;
              event.params.timeRange.key = timeKey;
              // 同时设置根级别 start/end，兼容直接从 params 读取时间的服务
              event.params.start = start;
              event.params.end = end;
            }

            // napm-alert-query: 如果 criteria 有 timeRange.key，覆盖 start/end
            if (toolName === 'napm-alert-query'
                && isPlainObject(event.params.alertQuery?.criteria)) {
              const criteria = event.params.alertQuery.criteria;
              if (!criteria.start && !criteria.end) {
                const now = Math.floor(Date.now() / 1000);
                const floor = (v) => Math.floor(v / 60) * 60;
                criteria.start = floor(now - 3600);
                criteria.end = floor(now);
              }
            }
          } catch (_timeOverrideError) {
            // 时间覆盖失败不影响工具调用 — 静默降级
            api.logger.warn(`[napm-openclaw-plugin] time override failed for ${toolName}: ${_timeOverrideError.message}`);
          }
        }

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
        const activePacketPrompt = Boolean(activePrompt) && isPacketCapturePrompt(activePrompt);
        const activeAlertPrompt = Boolean(activePrompt) && (
          isAlertEventPrompt(activePrompt)
          || isAlertSkillMetaFollowUpPrompt(activePrompt, activePromptState)
          || Boolean(activePromptState?.alertRelated)
        );
        const activeAlertPacketPrompt = activePacketPrompt && activeAlertPrompt;
        const activeSummaryPrompt = Boolean(activePrompt) && isSummaryPrompt(activePrompt);

        // ── Fault diagnosis guard (MUST be first) ──
        const activeFaultDiagnosisPrompt = Boolean(activePrompt) && isFaultDiagnosisPrompt(activePrompt);
        if ((toolName === 'napm-skill-query' || toolName === 'napm-alert-query') && activeFaultDiagnosisPrompt) {
          api.logger.warn(`[napm-openclaw-plugin] BLOCKED ${toolName} for fault-diagnosis prompt: ${activePrompt.slice(0, 120)}`);
          appendPluginAuditEvent('napm_plugin_fault_dx_wrong_tool_blocked', { toolName, prompt: activePrompt, context: buildAuditContextSnapshot(ctx) });
          return { block: true, blockReason: `FAULT DIAGNOSIS REQUIRED: This is a web application fault/error analysis request. Do NOT use ${toolName}. Instead, call napm-fault-diagnosis with flowType="bs_app_slow" and the target WebApplication.` };
        }

        if (isDirectNapmTool(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked removed legacy direct tool: tool=${toolName}`);
          return {
            block: true,
            blockReason: `${toolName} has been removed from this deployment. Use napm-skill-query instead.`
          };
        }

        if (toolName === 'napm-skill-query' && activePacketPrompt) {
          api.logger.warn(`[napm-openclaw-plugin] blocked napm-skill-query for packet prompt: prompt=${activePrompt.slice(0, 120)}`);
          appendPluginAuditEvent('napm_plugin_packet_prompt_wrong_tool_blocked', {
            toolName,
            prompt: activePrompt,
            expectedTool: 'napm-packet-analysis',
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: 'Packet capture/download/analysis requests must use napm-packet-analysis, not napm-skill-query.'
          };
        }

        if (toolName === 'napm-skill-query' && activeAlertPrompt) {
          api.logger.warn(`[napm-openclaw-plugin] blocked napm-skill-query for alert prompt: prompt=${activePrompt.slice(0, 120)}`);
          appendPluginAuditEvent('napm_plugin_alert_prompt_wrong_tool_blocked', {
            toolName,
            prompt: activePrompt,
            expectedTool: 'napm-alert-query',
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: 'Alert event queries must use napm-alert-query, not napm-skill-query or overview/security summaries.'
          };
        }

        if (toolName === 'napm-alert-query' && activeAlertPrompt) {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          return undefined;
        }

        // Summary report guard: block napm-skill-query for summary prompts → redirect to napm-summary
        if (toolName === 'napm-skill-query' && activeSummaryPrompt) {
          api.logger.warn(`[napm-openclaw-plugin] blocked napm-skill-query for summary prompt: prompt=${activePrompt.slice(0, 120)}`);
          appendPluginAuditEvent('napm_plugin_summary_prompt_wrong_tool_blocked', {
            toolName,
            prompt: activePrompt,
            expectedTool: 'napm-summary',
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: 'Summary/overview report requests must use napm-summary, not napm-skill-query. Call napm-summary with scope and timeRange to aggregate alert/traffic/business data, then napm-report-export to deliver the Word file.'
          };
        }

        if (toolName === 'napm-summary' && activeSummaryPrompt) {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          return undefined;
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
          const originalResolvedQueryJson = JSON.stringify(normalizeObject(toolParams?.resolvedQuery) || null);
          const canonicalResolvedQueryJson = JSON.stringify(normalizeObject(canonicalSkillParams?.resolvedQuery) || null);
          const boundaryMode = getBoundaryMode();
          const resolvedQueryValidation = validateResolvedQueryAgainstSpec(canonicalSkillParams?.resolvedQuery);
          if (isPlainObject(resolvedQueryValidation.resolvedQuery)) {
            canonicalSkillParams.resolvedQuery = resolvedQueryValidation.resolvedQuery;
          }
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
          const compositeApplicationInventoryValidation = validateCompositeApplicationInventoryResolvedQuery(
            activePrompt,
            canonicalSkillParams?.resolvedQuery
          );
          if (!compositeApplicationInventoryValidation.ok) {
            api.logger.warn(`[napm-openclaw-plugin] blocked CompositeApplication inventory semantic mismatch: reason=${compositeApplicationInventoryValidation.reason} prompt=${activePrompt.slice(0, 120)}`);
            appendPluginAuditEvent('napm_plugin_resolved_query_blocked', {
              traceId,
              toolName,
              prompt: activePrompt,
              boundaryMode,
              reason: compositeApplicationInventoryValidation.reason,
              message: compositeApplicationInventoryValidation.message,
              resolvedQuery: normalizeObject(canonicalSkillParams.resolvedQuery) || null,
              resolvedQuerySummary: summarizeResolvedQueryForAudit(canonicalSkillParams.resolvedQuery),
              context: buildAuditContextSnapshot(ctx)
            });
            return {
              block: true,
              blockReason: `${compositeApplicationInventoryValidation.message} OpenClaw must reconstruct resolvedQuery first.`
            };
          }
          const objectInventoryValidation = validateObjectInventoryResolvedQuery(
            activePrompt,
            canonicalSkillParams?.resolvedQuery
          );
          if (!objectInventoryValidation.ok) {
            api.logger.warn(`[napm-openclaw-plugin] blocked object_inventory semantic mismatch: reason=${objectInventoryValidation.reason} prompt=${activePrompt.slice(0, 120)}`);
            appendPluginAuditEvent('napm_plugin_resolved_query_blocked', {
              traceId,
              toolName,
              prompt: activePrompt,
              boundaryMode,
              reason: objectInventoryValidation.reason,
              message: objectInventoryValidation.message,
              resolvedQuery: normalizeObject(canonicalSkillParams.resolvedQuery) || null,
              resolvedQuerySummary: summarizeResolvedQueryForAudit(canonicalSkillParams.resolvedQuery),
              context: buildAuditContextSnapshot(ctx)
            });
            return {
              block: true,
              blockReason: `${objectInventoryValidation.message} OpenClaw must reconstruct resolvedQuery first.`
            };
          }
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
              || canonicalResolvedQueryJson !== originalResolvedQueryJson
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

        if (activePacketPrompt && toolName !== 'napm-packet-analysis' && !(activeAlertPacketPrompt && (toolName === 'napm-alert-query' || toolName === 'napm-skill-query'))) {
          api.logger.warn(`[napm-openclaw-plugin] blocked non-packet tool for packet prompt: tool=${toolName}`);
          return {
            block: true,
            blockReason: 'Packet capture/download/analysis requests must use napm-packet-analysis.'
          };
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

    registerNapmHook(
      'message_sending',
      async (event, ctx) => {
        // 🔴 最高优先级：如果有 pendingAlertDisplayText，直接替换整个消息
        // 必须在所有其他逻辑之前执行，防止被 early-return 跳过
        if (pendingAlertDisplayText) {
          const text = pendingAlertDisplayText;
          pendingAlertDisplayText = null;
          appendPluginAuditEvent('napm_alert_displaytext_consumed_msg_sending', { consumed: true });
          return { content: text };
        }
        const mediaDedupe = dedupeOutgoingMediaForConversation(event, ctx);
        if (mediaDedupe?.original?.length > 0 && mediaDedupe.fresh.length === 0) {
          appendPluginAuditEvent('napm_plugin_duplicate_media_suppressed', {
            conversationKey: getConversationKey(ctx) || null,
            mediaUrls: mediaDedupe.original,
            reason: 'duplicate_media_within_window'
          });
          return {
            cancel: true
          };
        }
        if (mediaDedupe?.fresh?.length > 0 && mediaDedupe.fresh.length < mediaDedupe.original.length) {
          appendPluginAuditEvent('napm_plugin_duplicate_media_trimmed', {
            conversationKey: getConversationKey(ctx) || null,
            originalMediaUrls: mediaDedupe.original,
            forwardedMediaUrls: mediaDedupe.fresh
          });
          return {
            mediaUrls: mediaDedupe.fresh,
            mediaUrl: mediaDedupe.fresh[0] || undefined
          };
        }

        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const guardState = getGuardState(ctx);
        const activePromptForReport = selectActivePromptText(conversationState, guardState, extractTextContent(event?.content));
        const reportArtifactUrls = getReportArtifactUrlsFromOutgoingEvent(event);
        if (isReportExportPrompt(activePromptForReport) && reportArtifactUrls.length > 0) {
          const illegalUrls = reportArtifactUrls.filter((url) => !isAllowedReportArtifactUrl(url));
          if (illegalUrls.length > 0) {
            appendPluginAuditEvent('napm_report_direct_artifact_blocked', {
              conversationKey: conversationKey || null,
              prompt: activePromptForReport,
              mediaUrls: illegalUrls,
              reason: 'missing_fresh_napm_report_export_result'
            });
            return {
              content: buildReportExportRequiredReply()
            };
          }
        }
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
          const activePrompt = activePromptForReport;
          const alertScopedPrompt = Boolean(
            isAlertEventPrompt(activePrompt)
            || isAlertSkillMetaFollowUpPrompt(activePrompt, guardState || conversationState)
            || guardState?.alertRelated
            || conversationState?.alertRelated
          );
          const rememberedRecord = alertScopedPrompt
            ? getRememberedAlertRecordForPrompt(activePrompt, conversationState, conversationKey, guardState)
            : getRememberedRecordForPrompt(activePrompt, conversationState, conversationKey, guardState);
          const requiresSkillBackedReply = shouldRequireSkillBackedReply(activePrompt, guardState, rememberedRecord);
          if (shouldAllowNapmReasoningPreviewForCtx(ctx) && isStreamingPreviewMessageEvent(event)) {
            return undefined;
          }
          const leakedReasoningText = extractTextContent(event?.content);
          if (isReportExportPrompt(activePrompt) && textClaimsReportGenerated(leakedReasoningText) && !isFreshReportExportResult()) {
            appendPluginAuditEvent('napm_report_direct_claim_blocked', {
              conversationKey: conversationKey || null,
              prompt: activePrompt,
              reason: 'missing_fresh_napm_report_export_result'
            });
            return {
              content: buildReportExportRequiredReply()
            };
          }
          const leakedBypassProcessText = looksLikeNapmBypassProcessText(leakedReasoningText);
          if (isNapmMetaFollowUpPrompt(activePrompt, guardState) || isAlertSkillMetaFollowUpPrompt(activePrompt, guardState || conversationState)) {
            return {
              content: alertScopedPrompt
                ? buildAlertExecutionTraceReplyFromRememberedRecord(rememberedRecord)
                : buildExecutionTraceReplyFromRememberedRecord(rememberedRecord)
            };
          }
          if (alertScopedPrompt && isAlertSkillResultRecord(rememberedRecord)) {
            return {
              content: buildAlertQueryReply(rememberedRecord.result)
            };
          }
          if (looksLikeInvalidBusinessInventoryAnswer(leakedReasoningText)) {
            const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
            return {
              content: rememberedReplyText || buildSkillRequiredReplyForPrompt(activePrompt)
            };
          }
          if (looksLikeUnsupportedBusinessInventoryExplanation(leakedReasoningText)) {
            return {
              content: buildBusinessInventoryCorrectedReply(rememberedRecord)
            };
          }
          if (isHierarchyCatalogPrompt(activePrompt) && looksLikeManualHierarchyInferenceText(leakedReasoningText)) {
            const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
            return {
              content: rememberedReplyText || buildHierarchySkillRequiredReply()
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
              content: buildSkillRequiredReplyForPrompt(activePrompt)
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
              content: buildSkillRequiredReplyForPrompt(activePrompt)
            };
          }
          if (shouldForceSkillRecordForPrompt(activePrompt, guardState) && !rememberedRecord) {
            return {
              content: buildSkillRequiredReplyForPrompt(activePrompt)
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

    registerNapmHook(
      'before_message_write',
      (event, ctx) => {
        // 🔴 最高优先级：如果有 pendingAlertDisplayText，直接替换整个消息
        if (pendingAlertDisplayText) {
          const text = pendingAlertDisplayText;
          pendingAlertDisplayText = null;
          appendPluginAuditEvent('napm_alert_displaytext_consumed_before_write', { consumed: true });
          const msg = event?.message;
          return { message: buildAssistantTextMessage(text, msg) };
        }
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
        const alertScopedPrompt = Boolean(
          isAlertEventPrompt(activePrompt)
          || isAlertSkillMetaFollowUpPrompt(activePrompt, guardState || conversationState)
          || guardState?.alertRelated
          || conversationState?.alertRelated
        );
        const rememberedRecord = alertScopedPrompt
          ? getRememberedAlertRecordForPrompt(activePrompt, conversationState, conversationKey, guardState)
          : getRememberedRecordForPrompt(activePrompt, conversationState, conversationKey, guardState);
        const requiresSkillBackedReply = shouldRequireSkillBackedReply(activePrompt, guardState, rememberedRecord);
        const existingText = extractMessageText(message);
        if (isReportExportPrompt(activePrompt) && textClaimsReportGenerated(existingText) && !isFreshReportExportResult()) {
          appendPluginAuditEvent('napm_report_direct_claim_rewritten_before_write', {
            conversationKey: conversationKey || null,
            prompt: activePrompt,
            reason: 'missing_fresh_napm_report_export_result'
          });
          return {
            message: buildAssistantTextMessage(buildReportExportRequiredReply(), message)
          };
        }
        if (isNapmMetaFollowUpPrompt(activePrompt, guardState) || isAlertSkillMetaFollowUpPrompt(activePrompt, guardState || conversationState)) {
          return {
            message: buildAssistantTextMessage(
              alertScopedPrompt
                ? buildAlertExecutionTraceReplyFromRememberedRecord(rememberedRecord)
                : buildExecutionTraceReplyFromRememberedRecord(rememberedRecord),
              message
            )
          };
        }
        if (alertScopedPrompt && isAlertSkillResultRecord(rememberedRecord)) {
          return {
            message: buildAssistantTextMessage(buildAlertQueryReply(rememberedRecord.result), message)
          };
        }
        if (looksLikeInvalidBusinessInventoryAnswer(existingText)) {
          const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord) || buildSkillRequiredReplyForPrompt(activePrompt);
          return {
            message: buildAssistantTextMessage(rememberedReplyText, message)
          };
        }
        if (looksLikeUnsupportedBusinessInventoryExplanation(existingText)) {
          return {
            message: buildAssistantTextMessage(buildBusinessInventoryCorrectedReply(rememberedRecord), message)
          };
        }
        if (isHierarchyCatalogPrompt(activePrompt) && looksLikeManualHierarchyInferenceText(existingText)) {
          const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
          return {
            message: buildAssistantTextMessage(rememberedReplyText || buildHierarchySkillRequiredReply(), message)
          };
        }
        if (looksLikeNapmBypassProcessText(existingText)) {
          const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord) || buildSkillRequiredReplyForPrompt(activePrompt);
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
            message: buildAssistantTextMessage(buildSkillRequiredReplyForPrompt(activePrompt), message)
          };
        }
        if (shouldForceSkillRecordForPrompt(activePrompt, guardState) && !rememberedRecord) {
          return {
            message: buildAssistantTextMessage(buildSkillRequiredReplyForPrompt(activePrompt), message)
          };
        }
        return undefined;
      },
      {
        name: 'napm-before-message-write-guard',
        description: 'Rewrite assistant transcript messages for out-of-scope prompts before they are written and delivered.'
      }
    );

  }
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.__test__ = {
  getBoundaryMode,
  isStrictBoundaryMode,
  shouldEnableDevResolverTools,
  isSafeNapmToolName,
  summarizeResolvedQueryForAudit,
  normalizeQueryModeKeyForService,
  normalizeResolvedQueryForPlugin,
  validateResolvedQueryAgainstSpec,
  applyPathPreflightToResolvedQuery,
  buildCanonicalSkillToolParams,
  buildBusinessObjectInventoryResolvedQuery,
  isCompositeApplicationInventoryPrompt,
  validateCompositeApplicationInventoryResolvedQuery,
  classifyNapmWorkflow,
  validateObjectInventoryResolvedQuery,
  buildRememberedSkillReplyText,
  buildExecutionTraceReplyFromRememberedRecord,
  buildSkillRequiredReply,
  buildHierarchySkillRequiredReply,
  getRememberedRecordForPrompt,
  buildOverviewResolvedQuery,
  buildMetricInventoryResolvedQuery,
  buildPacketLossClientTopResolvedQuery,
  buildResolvedQueryForPrompt,
  createResolvedQueryResolverToolDefinition,
  createMainflowQueryToolDefinition,
  createReportExportToolDefinition,
  createAlertQueryToolDefinition,
  createInspectionSnapshotToolDefinition,
  createSummaryToolDefinition,
  createPacketAnalysisToolDefinition,
  buildInspectionSnapshotReply,
  buildSummaryReply,
  buildAlertQueryReply,
  buildNapmRoutingSystemContext,
  buildPacketAnalysisReply,
  buildReportDataForExport,
  buildReportInputForExport,
  buildReportExportReply,
  isReportExportPrompt,
  textClaimsReportGenerated,
  rememberReportExportResult,
  isFreshReportExportResult,
  dedupeOutgoingMediaForConversation,
  getNapmResolvedQueryResolverService,
  resolvePromptWithAudit,
  runMainflowQuery,
  inferOverviewScene,
  inferMetricInventoryGroup,
  isBusinessObjectInventoryPrompt,
  isHierarchyCatalogPrompt,
  isAlertEventPrompt,
  isSummaryPrompt,
  isAlertSkillMetaFollowUpPrompt,
  isAlertSkillResultRecord,
  buildAlertSkillRequiredReply,
  buildAlertExecutionTraceReplyFromRememberedRecord,
  isMetricInventoryPrompt,
  isMetricInventoryDetailPrompt,
  isNapmMetaFollowUpPrompt,
  isPacketLossClientTopPrompt,
  looksLikeNapmBypassProcessText,
  looksLikeManualHierarchyInferenceText,
  looksLikeUnsupportedBusinessInventoryExplanation,
  shouldRequireSkillBackedReply,
  normalizeHierarchyQuestionTarget,
  normalizeOverviewSceneKey,
  shouldReplaceWithPromptOverview,
  rememberDebugApiForPromptAliases,
  rememberSkillResult,
  getLatestRememberedSkillRecord,
  getReportDataFromRecord,
  prepareSkillExecutionArgs,
  shouldAllowNapmReasoningPreview,
  extractOverviewSceneFromRememberedRecord
};
