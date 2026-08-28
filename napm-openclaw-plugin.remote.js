const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AssistantOutputLedger = require('./plugin/AssistantOutputLedger');
const ConversationOperationState = require('./plugin/ConversationOperationState');
const {
  buildDeterministicFinalReply: buildAlertPacketFinalReply,
  prepareModelFinalContent: prepareAlertPacketModelFinalContent
} = require('./plugin/AlertPacketFinalReplyService');
const { ConversationScopeRegistry } = require('./plugin/ConversationScopeResolver');
const {
  REPORT_INTENTS,
  classifyReportPrompt,
  isAutomaticReportIntent,
  isReportWorkflowIntent
} = require('./plugin/ReportIntentClassifier');
const ReportSourceStore = require('./plugin/ReportSourceStore');
const TrustedToolContextStore = require('./plugin/TrustedToolContextStore');
const AlertReferenceStore = require('./plugin/AlertReferenceStore');

const NAPM_DIRECT_SKILL_MODE = true;
const LOCAL_SKILLS_ROOT = path.join(__dirname, 'skills');
const DEPLOYED_SKILLS_ROOT = path.join(process.env.HOME || '/home/netinside', '.openclaw/workspace/skills');
const REQUIRED_NAPM_SKILL_RUNTIME_PATHS = Object.freeze([
  'openclaw-napm-query/scripts/run_napm_query.js',
  'openclaw-napm-query/services/PromptRoutingService.js',
  'openclaw-napm-query/services/ResolutionSpecService.js',
  'openclaw-napm-query/services/ResolvedQueryTimeRangeService.js',
  'openclaw-napm-query/src/shared/timeResolver.js',
  'openclaw-napm-report/scripts/generate_napm_report.js',
  'openclaw-napm-packet-analysis/scripts/run_packet_analysis.js',
  'openclaw-napm-alert-query/scripts/run_alert_query.js',
  'openclaw-napm-alert-packet-analysis/scripts/run_alert_packet_analysis.js',
  'openclaw-napm-inspection/scripts/run_inspection_snapshot.js',
  'openclaw-napm-summary/scripts/run_summary.js',
  'openclaw-napm-fault-diagnosis/scripts/run_fault_diagnosis.js',
  'shared/NapmObjectTargetResolver.js'
]);

function hasCompleteNapmSkillRuntime(skillsRoot = '', existsSync = fs.existsSync) {
  const root = String(skillsRoot || '').trim();
  return Boolean(root) && REQUIRED_NAPM_SKILL_RUNTIME_PATHS.every((relativePath) => (
    existsSync(path.join(root, relativePath))
  ));
}

function resolveOpenClawSkillsRoot(options = {}) {
  const explicitRoot = String(options.explicitRoot ?? process.env.OPENCLAW_SKILLS_ROOT ?? '').trim();
  if (explicitRoot) {
    return explicitRoot;
  }

  const localSkillsRoot = String(options.localSkillsRoot || LOCAL_SKILLS_ROOT).trim();
  const deployedSkillsRoot = String(options.deployedSkillsRoot || DEPLOYED_SKILLS_ROOT).trim();
  const existsSync = typeof options.existsSync === 'function' ? options.existsSync : fs.existsSync;
  if (hasCompleteNapmSkillRuntime(localSkillsRoot, existsSync)) {
    return localSkillsRoot;
  }
  if (hasCompleteNapmSkillRuntime(deployedSkillsRoot, existsSync)) {
    return deployedSkillsRoot;
  }

  return existsSync(deployedSkillsRoot) ? deployedSkillsRoot : localSkillsRoot;
}

const OPENCLAW_SKILLS_ROOT = resolveOpenClawSkillsRoot();
const {
  NapmObjectTargetResolver,
  TARGET_RESOLUTION_STATUS
} = require(path.join(OPENCLAW_SKILLS_ROOT, 'shared', 'NapmObjectTargetResolver.js'));

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
const napmAlertPacketSkill = () => loadSkill('openclaw-napm-alert-packet-analysis', 'run_alert_packet_analysis.js');
const napmInspectionSkill = () => loadSkill('openclaw-napm-inspection', 'run_inspection_snapshot.js');
const napmSummarySkill = () => loadSkill('openclaw-napm-summary', 'run_summary.js');
const napmFaultDiagnosisSkill = () => loadSkill('openclaw-napm-fault-diagnosis', 'run_fault_diagnosis.js');
let automaticSummaryTargetResolver = new NapmObjectTargetResolver();

function setAutomaticSummaryTargetResolver(resolver = null) {
  automaticSummaryTargetResolver = resolver || new NapmObjectTargetResolver();
}
const napmGuardState = new Map();
const napmConversationState = new Map();
const napmSentMediaByConversation = new Map();
const nativeCommandByScope = new Map();
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
const QUERY_CONTEXT_MAX_AGE_MS = 30 * 60 * 1000;
const SENT_MEDIA_DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const OPENCLAW_NATIVE_COMMAND_TTL_MS = 30 * 1000;
const REPORT_EXPORT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const TRUSTED_TOOL_CONTEXT_MAX_AGE_MS = REPORT_EXPORT_CACHE_MAX_AGE_MS;
const REPORT_SOURCE_TTL_MS = Number(process.env.NAPM_REPORT_SOURCE_TTL_MS) > 0
  ? Number(process.env.NAPM_REPORT_SOURCE_TTL_MS)
  : 30 * 60 * 1000;
const REPORT_SOURCE_DIR = process.env.NAPM_REPORT_SOURCE_DIR
  || path.join(process.env.HOME || process.cwd(), '.openclaw', 'state', 'napm-report-sources');
const TRUSTED_CONTEXT_DIR = process.env.NAPM_TRUSTED_CONTEXT_DIR
  || path.join(process.env.HOME || process.cwd(), '.openclaw', 'state', 'napm-trusted-tool-contexts');
const ALERT_REFERENCE_TTL_MS = Number(process.env.NAPM_ALERT_REFERENCE_TTL_MS) > 0
  ? Number(process.env.NAPM_ALERT_REFERENCE_TTL_MS)
  : 7 * 24 * 60 * 60 * 1000;
const ALERT_REFERENCE_DIR = process.env.NAPM_ALERT_REFERENCE_DIR
  || (process.platform === 'linux'
    ? path.join('/dev/shm', 'napm-alert-references')
    : path.join(process.env.HOME || process.cwd(), '.openclaw', 'state', 'napm-alert-references'));
const napmOperationState = new ConversationOperationState({
  resultMaxAgeMs: RESULT_CACHE_MAX_AGE_MS,
  reportMaxAgeMs: REPORT_EXPORT_CACHE_MAX_AGE_MS,
  queryContextMaxAgeMs: QUERY_CONTEXT_MAX_AGE_MS
});
const assistantOutputLedger = new AssistantOutputLedger({
  maxAgeMs: RESULT_CACHE_MAX_AGE_MS
});
const conversationScopeRegistry = new ConversationScopeRegistry({
  maxAgeMs: REPORT_EXPORT_CACHE_MAX_AGE_MS
});
const napmReportSourceStore = new ReportSourceStore({
  baseDir: REPORT_SOURCE_DIR,
  ttlMs: REPORT_SOURCE_TTL_MS
});
const napmTrustedToolContextStore = new TrustedToolContextStore({
  baseDir: TRUSTED_CONTEXT_DIR,
  ttlMs: TRUSTED_TOOL_CONTEXT_MAX_AGE_MS
});
let napmAlertReferenceStore = null;

function getNapmAlertReferenceStore() {
  if (!napmAlertReferenceStore) {
    napmAlertReferenceStore = new AlertReferenceStore({
      baseDir: ALERT_REFERENCE_DIR,
      ttlMs: ALERT_REFERENCE_TTL_MS,
    });
  }
  return napmAlertReferenceStore;
}
const napmTrustedToolContextByTraceId = new Map();
const napmAutomaticReportByTurn = new Map();
const AUTOMATIC_REPORT_OPERATION_MAX_AGE_MS = RESULT_CACHE_MAX_AGE_MS;
const AUDIT_LOG_PATH = process.env.NAPM_AUDIT_LOG_PATH || '/home/netinside/.openclaw/logs/audit.log';
const SAFE_NAPM_TOOL_NAMES = new Set(['napm-skill-query', 'napm-report-export', 'napm-packet-analysis', 'napm-alert-query', 'napm-alert-packet-analysis', 'napm-inspection-snapshot', 'napm-summary', 'napm-fault-diagnosis']);
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
    /\blet\s+me\s+(?:re-?run|use|check|query|call|fetch|look|inspect)\b/ig,
    /\breturned\s+no\s+successful\s+results\b/ig,
    /\bthe\s+result\s+indicates\b/ig,
    /\bpacket\s+candidate\s+analysis\b[\s\S]{0,80}\b(?:did\s+not\s+succeed|failed)\b/ig,
    /\blet\s+me\s+check\s+if\s+there(?:'|’)s\s+(?:additional\s+)?context\b/ig,
    /\blet\s+me\s+provide\s+the\s+summary\b/ig,
    /\b(?:directly\s+)?provide\s+the\s+(?:corresponding\s+)?eventid\b/ig,
    /\bconfirm\s+(?:whether|if)\s+.+\blinktype\b/ig,
    /\bpreviously\s+i\s+(?:checked|queried|tried)\b/ig,
    /\bactually,\s*wait\b/ig,
    /\bnow\s+i\s+see\b/ig,
    /\blet\s+me\s+take\s+a\s+(?:different|step\s+back)\s+approach\b/ig,
    /\bthat'?s\s+suspicious\b/ig,
    /\bthe\s+guard\s+is\b/ig,
    /\bthe\s+problem\s+is\b/ig,
    /\bi\s+should\s+(?:explain|be\s+transparent|tell)\b/ig,
    /\bi\s+need\s+to\s+(?:explain|ask|tell)\b/ig
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

function isResultDeliveryFollowUpPrompt(prompt = '', previousState = null) {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasDeliveryIntent = /(?:为什么|怎么|咋)(?:没有|没)(?:返回|显示|展示|出来|给我)|(?:怎么|咋)?只有(?:标题|一句话)|结果呢|结果在哪里|报告呢|报告在(?:哪|哪里)|没有给我|没给我|重新发(?:一下|一遍)?|再发(?:一下|一遍)?|重新展示|再展示/i.test(text);
  const previousNapmRelated = Boolean(previousState?.napmRelated || previousState?.domainRelated);
  return hasDeliveryIntent && previousNapmRelated;
}

function isAlertEventPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  // A cross-session GJ reference is already a trusted alert identity. Treat
  // reference-based analysis as an alert turn even though the prompt does not
  // expose the internal eventId/start/end fields to the user.
  if (
    extractAlertReference(text)
    && /(?:告警|分析|查看|定位|数据包|报文|抓包|详情|事件|继续)/i.test(text)
  ) {
    return true;
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

function isAlertPacketAnalysisPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }
  const reference = extractAlertReference(text);
  if (reference) {
    return /(?:分析|查看|定位|数据包|报文|抓包|继续)/i.test(text);
  }
  if (!/告警/i.test(text)) {
    return false;
  }
  const hasPacketIntent = /(?:数据包|报文|抓包|pcap|\.cap\b)/i.test(text);
  const hasEventId = /\bevent\s*id\s*[:=]?\s*\d+\b/i.test(text)
    || /告警(?:事件)?\s*(?:id\s*[:=]?)?\s*\d{3,}/i.test(text);
  return hasPacketIntent && hasEventId;
}

function isAlertPacketConfirmationPrompt(prompt = '', previousState = null) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  const confirmation = /^(?:开始分析|继续(?:分析|下载)?|确认(?:继续)?(?:下载|分析)?|下载(?:它|该数据包|这个数据包)?|同意(?:下载|分析)?|可以(?:下载|分析)?)\s*[!！。.]?$/i.test(text);
  if (!confirmation) return false;
  const previousPrompt = String(
    previousState?.alertPacketCanonicalPrompt
      || previousState?.canonicalPrompt
      || previousState?.prompt
      || ''
  ).trim();
  const reference = previousState?.alertPacketReferenceId || extractAlertReference(previousPrompt)?.referenceId;
  return Boolean(
    reference
    && (
      previousState?.alertPacketPendingAction === 'CONFIRM_DOWNLOAD'
      || previousState?.alertPacketWorkflowState === 'DOWNLOAD_CONFIRMATION_REQUIRED'
      || isAlertPacketAnalysisPrompt(previousPrompt)
    )
  );
}

function buildAlertPacketContinuationPrompt(prompt = '', previousState = null) {
  if (!isAlertPacketConfirmationPrompt(prompt, previousState)) return '';
  const previousPrompt = String(
    previousState?.alertPacketCanonicalPrompt
      || previousState?.canonicalPrompt
      || previousState?.prompt
      || ''
  ).trim();
  const reference = previousState?.alertPacketReferenceId || extractAlertReference(previousPrompt)?.referenceId;
  if (!reference) return '';
  const candidateId = String(previousState?.alertPacketCandidateId || '').trim();
  return candidateId ? `分析 ${candidateId}` : `分析告警 ${reference}`;
}

const ALERT_REFERENCE_PATTERN = /\bGJ-[A-Z2-9]{6,16}(?:-P\d{1,3})?\b/i;

function extractAlertReference(prompt = '') {
  const match = String(prompt || '').match(ALERT_REFERENCE_PATTERN);
  if (!match) return null;
  const value = String(match[0]).toUpperCase();
  const candidateMatch = value.match(/^(GJ-[A-Z2-9]{6,16})-P(\d{1,3})$/);
  return candidateMatch
    ? { referenceId: candidateMatch[1], candidateId: value }
    : { referenceId: value, candidateId: null };
}

function buildReferenceCanonicalPrompt(record = {}, analysisInput = {}) {
  const lines = [
    `分析告警数据包 eventId=${record.alert?.eventId || analysisInput.eventId}`,
    `start=${analysisInput.start || record.packet?.window?.start || record.alert?.start}`,
    `end=${analysisInput.end || record.packet?.window?.end || record.alert?.end || ((record.alert?.start || 0) + 120)}`,
  ];
  const trigger = analysisInput.triggerMetrics || {};
  const names = Array.isArray(trigger.names) ? trigger.names : [];
  const values = Array.isArray(trigger.values) ? trigger.values : [];
  const units = Array.isArray(trigger.units) ? trigger.units : [];
  if (names.length > 0) {
    lines.push(`触发指标值: ${names.map((name, index) => `${name}=${values[index] ?? '?'}${units[index] || ''}`).join('，')}`);
  }
  if (trigger.severity) lines.push(`告警级别: ${trigger.severity}`);
  if (trigger.condition) lines.push(`触发条件: ${trigger.condition}`);
  return lines.join('\n');
}

function resolveAlertReferenceInput(prompt = '') {
  const reference = extractAlertReference(prompt);
  if (!reference) return null;
  const recordResult = getNapmAlertReferenceStore().get(reference.referenceId);
  if (!recordResult.ok) return { reference, error: recordResult };
  const record = recordResult;
  const candidates = Array.isArray(record.packet?.candidates) ? record.packet.candidates : [];
  const candidate = reference.candidateId
    ? candidates.find((item) => item.candidateId === reference.candidateId)
    : null;
  if (reference.candidateId && !candidate) {
    return {
      reference,
      error: {
        ok: false,
        errorCode: 'ALERT_PACKET_CANDIDATE_NOT_FOUND',
        message: '未找到指定的数据包候选。',
      },
    };
  }
  const packetWindow = candidate?.packetWindow || record.packet?.window || {
    start: record.alert?.start,
    end: record.alert?.end || ((record.alert?.start || 0) + 120),
  };
  const triggerMetrics = normalizeReferenceTriggerMetrics(record.triggerMetrics, record.analysis);
  return {
    reference,
    record,
    candidate,
    input: {
      referenceId: record.referenceId,
      candidateId: candidate?.candidateId || null,
      eventId: String(record.alert?.eventId || '').trim(),
      start: Number(packetWindow.start) || null,
      end: Number(packetWindow.end) || null,
      triggerMetrics,
      packetCandidate: candidate?.packetQuery || null,
    },
  };
}

function normalizeReferenceTriggerMetrics(metrics = [], analysis = {}) {
  const items = Array.isArray(metrics) ? metrics : [];
  return {
    names: items.map((item) => item.label || item.name || item.code).filter(Boolean),
    codes: items.map((item) => item.code || item.label || item.name).filter(Boolean),
    values: items.map((item) => item.value).filter((value) => value !== null && value !== undefined && value !== ''),
    units: items.map((item) => item.unit).filter(Boolean),
    severity: items[0]?.severity || '',
    condition: items[0]?.condition || '',
    profileId: analysis.profileId || '',
    profileVersion: analysis.profileVersion || null,
  };
}

function buildCanonicalAlertPacketToolParams(prompt = '', params = {}) {
  const text = String(prompt || '').trim();
  const source = isPlainObject(params) ? params : {};
  const referenceInput = resolveAlertReferenceInput(text);
  if (referenceInput?.error) {
    const canonical = {
      prompt: text,
      eventId: '',
      start: null,
      end: null,
      referenceId: referenceInput.reference?.referenceId || null,
      candidateId: referenceInput.reference?.candidateId || null,
      referenceErrorCode: referenceInput.error.errorCode || 'ALERT_REFERENCE_NOT_FOUND',
      triggerMetrics: isPlainObject(source.triggerMetrics) ? source.triggerMetrics : {},
      ...(source.previewRiskAccepted ? { previewRiskAccepted: true } : {}),
    };
    const traceId = normalizeTraceId(source.traceId);
    if (traceId) canonical.traceId = traceId;
    return canonical;
  }
  if (referenceInput?.input) {
    const canonical = {
      prompt: buildReferenceCanonicalPrompt(referenceInput.record, referenceInput.input),
      eventId: referenceInput.input.eventId,
      start: referenceInput.input.start,
      end: referenceInput.input.end,
      triggerMetrics: referenceInput.input.triggerMetrics,
      referenceId: referenceInput.input.referenceId,
      candidateId: referenceInput.input.candidateId,
      packetCandidate: referenceInput.input.packetCandidate,
      ...(source.previewRiskAccepted ? { previewRiskAccepted: true } : {}),
    };
    const traceId = normalizeTraceId(source.traceId);
    if (traceId) canonical.traceId = traceId;
    return canonical;
  }
  const eventMatch = text.match(/\bevent\s*id\s*[:=]?\s*(\d+)\b/i)
    || text.match(/告警(?:事件)?\s*(?:id\s*[:=]?)?\s*(\d{3,})/i);
  const startMatch = text.match(/\bstart\s*[:=]\s*(\d{10,13})\b/i);
  const endMatch = text.match(/\bend\s*[:=]\s*(\d{10,13})\b/i);
  const metricMatch = text.match(/触发指标值\s*[:：]\s*([^=\r\n]+?)\s*=\s*(-?\d+(?:\.\d+)?)\s*([^\s\r\n]*)/i);
  const severityMatch = text.match(/告警级别\s*[:：]\s*([^\r\n]+)/i);
  const conditionMatch = text.match(/触发条件\s*[:：]\s*([^\r\n]+)/i);
  const sourceMetrics = isPlainObject(source.triggerMetrics) ? source.triggerMetrics : {};
  const normalizeSeconds = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  };
  const asStringArray = (value) => {
    const values = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    return values.map((item) => String(item).trim()).filter(Boolean);
  };
  const asNumberArray = (value) => {
    const values = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    return values.map(Number).filter(Number.isFinite);
  };
  const canonical = {
    prompt: text,
    eventId: String(eventMatch?.[1] || source.eventId || '').trim(),
    start: normalizeSeconds(startMatch?.[1] || source.start),
    end: normalizeSeconds(endMatch?.[1] || source.end),
    triggerMetrics: {
      names: metricMatch ? [metricMatch[1].trim()] : asStringArray(sourceMetrics.names || sourceMetrics.name),
      codes: asStringArray(sourceMetrics.codes || sourceMetrics.code),
      values: metricMatch ? [Number(metricMatch[2])] : asNumberArray(sourceMetrics.values ?? sourceMetrics.value),
      units: metricMatch && metricMatch[3]
        ? [metricMatch[3].trim()]
        : asStringArray(sourceMetrics.units || sourceMetrics.unit),
      severity: severityMatch ? severityMatch[1].trim() : String(sourceMetrics.severity || '').trim(),
      condition: conditionMatch ? conditionMatch[1].trim() : String(sourceMetrics.condition || '').trim()
    }
  };
  if (source.previewRiskAccepted) canonical.previewRiskAccepted = true;
  const traceId = normalizeTraceId(source.traceId);
  if (traceId) canonical.traceId = traceId;
  return canonical;
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

function hasSpecificFaultDiagnosisTarget(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (/(?:^|[^\d])(?:\d{1,3}\.){3}\d{1,3}(?:[^\d]|$)/.test(text)) return true;
  if (/[“"'‘][^”"'’\n]{2,64}[”"'’]/.test(text)) return true;

  const patterns = [
    /(?:分析|诊断|排查|检查|查看|定位|针对|给)\s*(?:一下\s*)?([^，。！？\n]{1,40}?)(?:web|业务|应用|网站|系统|页面)/i,
    /([A-Za-z0-9\u4e00-\u9fa5._-]{2,40}?)(?:web|业务|应用|网站|系统|页面)(?:的)?(?:故障|错误|报错|异常|加载慢|响应慢|打开慢|卡顿|延时|延迟|性能)/i
  ];
  const genericTargets = /^(?:某个?|这个|当前|所有|全部|任意|哪个|哪些|什么|整体|全局|网络|页面|业务|应用|系统)$/i;
  return patterns.some((pattern) => {
    const match = text.match(pattern);
    if (!match) return false;
    const candidate = String(match[1] || '')
      .replace(/^(?:请|帮我|麻烦|分析|诊断|排查|检查|查看|定位|针对|给|一下)+/i, '')
      .trim();
    return candidate.length >= 2 && !genericTargets.test(candidate);
  });
}

function isFaultDiagnosisPrompt(prompt = '', options = {}) {
  const text = String(prompt || '').trim();
  if (!text) return false;

  // 2026-07-14: "告警数据包" 是 alert+packet 路由，不应触发故障诊断。
  // 否则所有包含"用户体验时间"的深入分析 prompt 都会被 fault guard 拦截，
  // AI 被强制导向 napm-fault-diagnosis 而非 napm-alert-query → napm-packet-analysis。
  if (/(?:告警.*数据包|数据包.*告警)/i.test(text)) {
    return false;
  }

  // Single-object analysis/overview reports are summary reports. Keep them
  // out of the fault workflow even when the named object is a business or app.
  if (isSummaryPrompt(text)) {
    return false;
  }

  // ── 2026-07-16: 排行/统计类查询快速排除 ──
  // 用户问的是"排行/哪个最多/TopN/数量多少"而不是"分析诊断某个具体业务"。
  // 特征：疑问词 + 排序词，但没有指定具体对象名 + 分析/诊断/排查意图。
  // 这类查询应走 napm-skill-query，不应被 isFaultDiagnosisPrompt 拦截。
  var hasRankingPattern = /(?:哪个|哪些|谁|什么|几个).*(?:最多|最高|最少|最低|最大|最小|排行|排名|Top\s*N|前\d+)/i.test(text);
  var hasStrongDiagnosisIntent = /(?:分析一下|分析这个|诊断一下|排查一下|出.*报告|给.*报告|故障报告|根因|原因分析)/i.test(text);

  if (hasRankingPattern && !hasStrongDiagnosisIntent) {
    return false;  // 纯排行查询，不是 fault diagnosis
  }

  // "XX业务 的 400/500 数量/次数/多少" — 单指标查询，不是诊断
  if (/(?:web|业务|应用).*(?:的|的的).*(?:HTTP\s*[45]\d{2}|400|500|4xx|5xx).*(?:数量|次数|个数|多少|是多少)/i.test(text)) {
    return false;
  }

  const hasDiagnosisIntent = Boolean(
    /(?:故障分析|故障诊断|故障报告|错误分析|报错分析|原因分析|根因|诊断|排查)/i.test(text)
    || /(?:分析|查看|检查|排查|定位|给出).*(?:故障|错误|报错|异常|慢|延时|延迟|性能|问题|原因|报告)/i.test(text)
    || /(?:页面性能|性能分析|性能诊断|页面加载|加载慢|页面慢|访问慢|响应慢|打开慢|延时分析|卡顿|转圈|首屏|白屏|渲染慢|servBusyTime|netBusyTime|pageTime|加载时间|用户体验时间)/i.test(text)
    || /(?:服务器|服务端).*(?:网络).*(?:慢|延时|延迟|问题)/i.test(text)
    || /(?:延时|延迟).*(?:拆分|分解|成分|来源|服务端|服务器|网络)/i.test(text)
  );
  if (!hasDiagnosisIntent) return false;

  return Boolean(options.hasExplicitTarget || hasSpecificFaultDiagnosisTarget(text));
}

function isSummaryPrompt(prompt = '') {
  return classifyReportPrompt(prompt) === REPORT_INTENTS.SUMMARY;
}

function isInspectionPrompt(prompt = '') {
  return classifyReportPrompt(prompt) === REPORT_INTENTS.INSPECTION;
}

function isAutomaticReportPrompt(prompt = '') {
  return isAutomaticReportIntent(classifyReportPrompt(prompt));
}

function isReportWorkflowPrompt(prompt = '') {
  return isReportWorkflowIntent(classifyReportPrompt(prompt));
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

function isBusinessInventoryGuardScope(prompt = '', rememberedRecord = null) {
  // Metric inventories may mention other object types as a useful comparison.
  // Their ownership must be checked from the structured metric result, not prose.
  if (isMetricInventoryPrompt(prompt)) {
    return false;
  }

  const result = isPlainObject(rememberedRecord?.result) ? rememberedRecord.result : null;
  if (result) {
    const resolvedQuery = isPlainObject(rememberedRecord?.resolvedQuery)
      ? rememberedRecord.resolvedQuery
      : (isPlainObject(result.resolvedQuery) ? result.resolvedQuery : {});
    const service = String(result.service || resolvedQuery.service || '').trim();
    const objectType = String(
      result?.metadata?.effectiveObjectType
      || result?.metadata?.requestedObjectType
      || resolvedQuery?.groups?.[0]?.type
      || ''
    ).trim();
    return service === 'groups' && objectType === 'WebApplication';
  }

  return isBusinessObjectInventoryPrompt(prompt);
}

function isMetricInventoryResultRecord(rememberedRecord = null) {
  const result = isPlainObject(rememberedRecord?.result) ? rememberedRecord.result : null;
  if (!result) {
    return false;
  }

  const resolvedQuery = isPlainObject(rememberedRecord?.resolvedQuery)
    ? rememberedRecord.resolvedQuery
    : (isPlainObject(result.resolvedQuery) ? result.resolvedQuery : {});
  const service = String(result.service || resolvedQuery.service || '').trim();
  const responseType = String(
    result.responseType
    || result.narrationStructure?.responseType
    || result.narrationInput?.result?.narrationStructure?.responseType
    || ''
  ).trim();
  return service === 'metrics' && responseType === 'metric_list' && Boolean(result.ok !== false && !result.error);
}

function isMeaningfulText(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return text !== '[object Object]' && text !== '[object Array]';
}

function isPlatformIdentityPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }
  const normalized = text.replace(/[！!。.?？，,~～]+$/g, '').trim();

  const patterns = [
    // Pure greetings share the platform identity route. Anchors prevent a greeting
    // prefix from bypassing NAPM routing or the general out-of-scope boundary.
    /^(?:(?:观枢\s*AI|助手)[，,:：\s]*)?(?:你好|您好|嗨|哈喽|哈啰|hello|hi|早|早上好|上午好|中午好|下午好|晚上好|早安|午安|晚安|在吗|在不在)(?:呀|啊|哦|哈)?$/i,
    /^(?:你|您)(?:到底)?是谁$/i,
    /^(?:你|您)(?:叫|叫什么)(?:名字|名称)?$/i,
    /^(?:你|您)的(?:名字|名称|身份)(?:是|叫|是什么)$/i,
    /^(?:你|您)是(?:做什么|干什么|什么助手|哪种助手|什么系统)(?:的)?$/i,
    /^(?:请|麻烦)?(?:介绍(?:一下)?(?:你|您)自己|做个?自我介绍|自我介绍(?:一下)?)$/i,
    /^(?:你|您)(?:都)?(?:能|可以|会|擅长)(?:都)?[^，。！？?!\n]{0,8}(?:做|干|处理|回答|提供|支持)[^，。！？?!\n]{0,8}(?:什么|哪些|啥|嘛)(?:事|事情|工作|功能|能力)?$/i,
    /^(?:你|您)(?:有|具备)(?:什么|哪些)?(?:功能|能力|本领)$/i,
    /^(?:你|您)(?:运行|部署|工作)在(?:哪里|哪儿|什么平台|哪个平台)$/i,
    /^(?:你|您)(?:基于|使用)(?:什么|哪个)平台$/i,
    /^(?:你|您)是(?:什么|哪个)模型$/i
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

const TURN_POLICY_ROUTES = Object.freeze({
  NAPM_CANDIDATE: 'napm_candidate',
  EXPLICIT_OUT_OF_SCOPE: 'explicit_out_of_scope',
  MODEL_OWNED: 'model_owned'
});

function isExplicitGeneralOutOfScopePrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  return [
    /(?:天气|气温|温度|下雨|降雨|晴天|空气质量|雾霾)/i,
    /(?:讲|说|来)(?:一个|个|段)?(?:笑话|段子|故事)/i,
    /(?:写|作)(?:一首|首|个)?(?:诗|歌词)/i,
    /(?:电影|电视剧|综艺|游戏)(?:推荐|好看|攻略)/i,
    /(?:星座|运势|占卜|算命)/i,
    /(?:陪我)?闲聊|聊聊天|随便聊聊/i
  ].some((pattern) => pattern.test(text));
}

function buildTurnPolicy({
  prompt = '',
  napmRelated = false,
  domainRelated = false,
  platformIdentityPrompt = false,
  outOfScopeBoundaryRequested = false
} = {}) {
  let route = TURN_POLICY_ROUTES.MODEL_OWNED;
  let reason = platformIdentityPrompt ? 'platform_identity_fast_path' : 'semantic_model_fallback';

  if (napmRelated || domainRelated) {
    route = TURN_POLICY_ROUTES.NAPM_CANDIDATE;
    reason = outOfScopeBoundaryRequested ? 'napm_boundary_request' : 'napm_domain_match';
  } else if (isExplicitGeneralOutOfScopePrompt(prompt)) {
    route = TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE;
    reason = 'explicit_general_out_of_scope_match';
  }

  return Object.freeze({
    route,
    reason,
    modelOwnsResponse: route === TURN_POLICY_ROUTES.MODEL_OWNED,
    toolActionsAllowed: route === TURN_POLICY_ROUTES.NAPM_CANDIDATE
      && !outOfScopeBoundaryRequested
  });
}

function getTurnPolicyRoute(state = null) {
  const route = String(state?.turnPolicy?.route || state?.turnRoute || '').trim();
  if (Object.values(TURN_POLICY_ROUTES).includes(route)) {
    return route;
  }
  if (state?.generalOutOfScopeRequested) {
    return TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE;
  }
  if (state?.napmRelated || state?.domainRelated) {
    return TURN_POLICY_ROUTES.NAPM_CANDIDATE;
  }
  return TURN_POLICY_ROUTES.MODEL_OWNED;
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

function normalizeTurnId(value = '') {
  const text = String(value || '').trim();
  return text ? truncateAuditText(text, 160) : '';
}

function buildNapmTurnId() {
  return `napm-turn-${crypto.randomUUID()}`;
}

function getContextTurnKey(ctx = {}) {
  return normalizeTraceId(ctx?.messageId || ctx?.runId || '');
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

function getQuerySemanticGuardMode() {
  const raw = String(process.env.NAPM_QUERY_SEMANTIC_GUARD_MODE || '').trim().toLowerCase();
  return ['enforce', 'shadow', 'off'].includes(raw) ? raw : 'shadow';
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

  const defaultQueryModeByService = {
    topValues: 'topn',
    topValues_multi_protocol: 'topn',
    averageValues: 'average',
    timeValues: 'timeseries',
    overview: 'overview',
    groups: 'metadata',
    metrics: 'metadata',
    drilldownCatalog: 'metadata',
    security_refusal: 'decision'
  };
  const normalizedQueryModeKey = normalizeQueryModeKeyForService(
    serviceName,
    next.queryModeKey || defaultQueryModeByService[serviceName]
  );
  if (normalizedQueryModeKey) {
    next.queryModeKey = normalizedQueryModeKey;
  }

  if (!Array.isArray(next.groups) || next.groups.length === 0) {
    const declaredCount = Number(next.numGroups);
    const indexedGroupFields = Object.keys(next)
      .map((key) => key.match(/^groupType(\d+)$/i))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    const groupCount = Number.isInteger(declaredCount) && declaredCount > 0
      ? declaredCount
      : Math.max(0, ...indexedGroupFields);
    const groups = [];
    for (let index = 1; index <= groupCount; index += 1) {
      const type = String(next[`groupType${index}`] || '').trim();
      if (!type) continue;
      const argument = next[`groupArgument${index}`];
      groups.push(argument == null || String(argument).trim() === ''
        ? { type }
        : { type, argument });
    }
    if (groups.length > 0) {
      next.groups = groups;
    }
  }

  if (Array.isArray(next.groups)) {
    next.groups = next.groups.map((group) => {
      if (!isPlainObject(group)) {
        return group;
      }
      const type = String(group.type || '').trim();
      return {
        ...group,
        type: type === 'Application' ? 'DefinedApp' : type
      };
    });
  }
  if (String(next.objectType || '').trim() === 'Application') {
    next.objectType = 'DefinedApp';
  }
  if (isPlainObject(next.semanticConstraints)) {
    next.semanticConstraints = { ...next.semanticConstraints };
    if (String(next.semanticConstraints.targetObjectType || '').trim() === 'Application') {
      next.semanticConstraints.targetObjectType = 'DefinedApp';
    }
  }

  const metricList = Array.isArray(next.metrics)
    ? next.metrics
    : (typeof next.metrics === 'string' ? next.metrics.split(',') : []);
  const normalizedMetrics = [...new Set(metricList
    .map((metric) => String(metric || '').trim())
    .filter(Boolean))];
  if (normalizedMetrics.length > 0) {
    next.metrics = normalizedMetrics;
  } else if (String(next.metric || '').trim()) {
    next.metrics = [String(next.metric).trim()];
  }

  if (String(next.topMetric || '').trim()) {
    next.topMetric = String(next.topMetric).trim();
  }
  if (!String(next.metric || '').trim()) {
    next.metric = next.topMetric || next.metrics?.[0] || next.metric;
  } else {
    next.metric = String(next.metric).trim();
  }
  if (serviceName === 'topValues' && !next.topMetric) {
    next.topMetric = next.metric || next.metrics?.[0];
  }

  ['start', 'end', 'topCount', 'granularity'].forEach((field) => {
    if (next[field] == null || next[field] === '') return;
    const numeric = Number(next[field]);
    if (Number.isFinite(numeric)) {
      next[field] = numeric;
    }
  });

  const hasExplicitTime = Number.isFinite(Number(next.start))
    && Number(next.start) > 0
    && Number.isFinite(Number(next.end))
    && Number(next.end) > Number(next.start);
  const relativeTimeKey = String(next?.timeRange?.key || next.timeRangeKey || '').trim();
  next.executionOptions = isPlainObject(next.executionOptions)
    ? { ...next.executionOptions }
    : {};
  const declaredTimeMode = String(next.executionOptions.timeMode || '').trim();
  if (declaredTimeMode === 'fixed' && hasExplicitTime) {
    next.executionOptions.timeMode = 'fixed';
  } else if (isSupportedRelativeTimeRangeKey(relativeTimeKey)) {
    next.executionOptions.timeMode = 'relative';
  } else if (hasExplicitTime) {
    next.executionOptions.timeMode = 'fixed';
  }
  if (Object.keys(next.executionOptions).length === 0) {
    delete next.executionOptions;
  }

  if (serviceName) {
    next.format = 'json';
  }
  delete next.csv;
  delete next.json;
  delete next.numGroups;
  Object.keys(next).forEach((key) => {
    if (/^group(?:Type|Argument)\d+$/i.test(key)) {
      delete next[key];
    }
  });

  return next;
}

function getResolutionSpecServiceNames() {
  const service = getResolutionSpecService();
  if (service && typeof service.getServiceNames === 'function') {
    return service.getServiceNames();
  }
  return [];
}

function isSupportedRelativeTimeRangeKey(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '');
  return key === 'today'
    || key === 'yesterday'
    || key === 'lastonehour'
    || /^last\d{1,7}(?:seconds?|minutes?|hours?|days?)$/.test(key);
}

function hasValidExplicitTimeRange(resolvedQuery = {}) {
  const start = Number(resolvedQuery.start);
  const end = Number(resolvedQuery.end);
  return Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > start;
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
  const timeRangeKey = getRelativeTimeRangeKey(resolvedQuery);
  const normalizedTimeRangeKey = String(timeRangeKey || '').trim().toLowerCase();
  if (normalizedTimeRangeKey === 'custom' && hasValidExplicitTimeRange(resolvedQuery)) {
    return { ok: true };
  }
  if (timeRangeKey && !isSupportedRelativeTimeRangeKey(timeRangeKey)) {
    return {
      ok: false,
      reason: 'unsupported_time_range_key',
      message: `Unsupported resolvedQuery timeRange.key=${timeRangeKey}; provide a concrete key such as last60minutes.`,
      details: { timeRangeKey }
    };
  }
  if (!options || !Number.isFinite(Number(options.nowSeconds))) {
    return { ok: true };
  }

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

function validateResolvedQueryAgainstSpec(resolvedQuery, options = {}) {
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
  const declaredTimeKey = getRelativeTimeRangeKey(normalizedResolvedQuery);
  const hasSupportedDeclarativeTime = Boolean(declaredTimeKey)
    && isSupportedRelativeTimeRangeKey(declaredTimeKey);
  const allowUnmaterializedRelativeTime = options?.phase === 'construction'
    && hasSupportedDeclarativeTime
    && !hasNestedStart
    && !hasNestedEnd;

  if (declaredTimeKey && declaredTimeKey !== 'custom' && !hasSupportedDeclarativeTime) {
    return {
      ok: false,
      reason: 'unsupported_time_range_key',
      message: `Unsupported resolvedQuery timeRange.key=${declaredTimeKey}; provide a concrete key such as last60minutes.`,
      details: { timeRangeKey: declaredTimeKey }
    };
  }

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
    if ((field === 'start' || field === 'end') && allowUnmaterializedRelativeTime) {
      return;
    }

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

  if (serviceName === 'topValues') {
    const topCount = normalizedResolvedQuery.topCount;
    if (topCount != null && (!Number.isInteger(Number(topCount)) || Number(topCount) <= 0)) {
      return {
        ok: false,
        reason: 'invalid_top_count',
        message: `resolvedQuery.topCount must be a positive integer; received ${topCount}.`
      };
    }
    const metrics = Array.isArray(normalizedResolvedQuery.metrics)
      ? normalizedResolvedQuery.metrics.map((metric) => String(metric || '').trim())
      : [];
    const topMetric = String(normalizedResolvedQuery.topMetric || '').trim();
    if (topMetric && !metrics.includes(topMetric)) {
      return {
        ok: false,
        reason: 'top_metric_not_in_metrics',
        message: `resolvedQuery.topMetric=${topMetric} must also be present in resolvedQuery.metrics.`,
        details: { topMetric, metrics }
      };
    }
  }

  const groups = Array.isArray(normalizedResolvedQuery.groups) ? normalizedResolvedQuery.groups : [];
  const terminalGroupType = String(groups[groups.length - 1]?.type || '').trim();
  const targetObjectType = String(normalizedResolvedQuery?.semanticConstraints?.targetObjectType || '').trim();
  const targetAliases = {
    ClientIPs: 'IPAddress',
    ServerIPs: 'IPAddress',
    MemberIPs: 'IPAddress',
    ExternalIPs: 'IPAddress',
    InternalIPs: 'IPAddress'
  };
  const normalizedTargetObjectType = targetAliases[targetObjectType] || targetObjectType;
  if (terminalGroupType && normalizedTargetObjectType && terminalGroupType !== normalizedTargetObjectType) {
    return {
      ok: false,
      reason: 'target_group_mismatch',
      message: `resolvedQuery semantic target=${targetObjectType} does not match terminal group=${terminalGroupType}.`,
      details: { targetObjectType, terminalGroupType }
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

  const argumentPolicyValidation = typeof service.evaluateQueryArgumentPolicy === 'function'
    ? service.evaluateQueryArgumentPolicy(normalizedResolvedQuery)
    : null;
  if (argumentPolicyValidation && !argumentPolicyValidation.ok) {
    return {
      ok: false,
      reason: argumentPolicyValidation.reason || 'invalid_group_argument_policy',
      message: argumentPolicyValidation.message || 'resolvedQuery group argument policy validation failed.',
      details: argumentPolicyValidation.details || null,
      resolvedQuery: normalizedResolvedQuery
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
  const validationReason = String(validation?.reason || '').trim();
  const validationDetails = isPlainObject(validation.details) ? validation.details : {};
  const clarificationQuestion = buildQueryScopeClarificationQuestion(
    validationReason,
    validationDetails
  );
  if (clarificationQuestion) {
    const prompt = normalizePrompt(args)
      || String(args?.resolvedQuery?.userRequirement || '').trim();
    return {
      ok: false,
      source: 'napm_openclaw_plugin_boundary',
      responseType: 'clarification_required',
      prompt,
      displayText: clarificationQuestion,
      summary: {
        mode: 'ASK_CLARIFYING_QUESTION',
        title: '需要补充查询范围',
        highlights: [clarificationQuestion],
        rowCount: 0,
        empty: true,
        displayText: clarificationQuestion
      },
      decision: {
        next_action: 'ASK_CLARIFYING_QUESTION',
        reason: validationReason || 'query_scope_incomplete',
        clarifying_question: clarificationQuestion,
        message: clarificationQuestion
      },
      error: {
        code: validation?.code || 'QUERY_SCOPE_INCOMPLETE',
        reason: validationReason || 'query_scope_incomplete',
        message: clarificationQuestion,
        retryable: false
      },
      validationDetails,
      resolvedQuery: normalizeObject(args?.resolvedQuery) || null,
      resolvedQuerySummary: summarizeResolvedQueryForAudit(args?.resolvedQuery)
    };
  }

  const allowedServices = getResolutionSpecServiceNames();
  const serviceName = String(validation?.expectedService || args?.resolvedQuery?.service || '').trim();
  const resolutionSpecService = getResolutionSpecService();
  const serviceSpec = serviceName && resolutionSpecService?.getServiceSpec
    ? resolutionSpecService.getServiceSpec(serviceName)
    : null;
  const allowedQueryModes = Array.isArray(serviceSpec?.queryModes) ? serviceSpec.queryModes : [];
  const requiredFields = Array.isArray(serviceSpec?.required) ? serviceSpec.required : [];
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
    allowedServices,
    expectedQueryModeKey: String(validation?.expectedQueryModeKey || '').trim()
      || (allowedQueryModes.length === 1 ? allowedQueryModes[0] : null),
    allowedQueryModes,
    requiredFields,
    validationDetails: isPlainObject(validation.details) ? validation.details : null,
    resolvedQuery: normalizeObject(args?.resolvedQuery) || null,
    resolvedQuerySummary: summarizeResolvedQueryForAudit(args?.resolvedQuery)
  };
}

function buildQueryScopeClarificationQuestion(reason = '', details = {}) {
  const normalizedReason = String(reason || '').trim();
  const groupType = String(details?.groupType || '').trim();
  const objectLabel = groupType === 'DefinedApp'
    ? '应用'
    : groupType === 'WebApplication'
      ? '业务/Web 应用'
      : groupType || '对象';

  if (normalizedReason === 'application_scope_mismatch') {
    return '应用流量趋势需要指定具体应用名称。请告诉我要查询哪个应用；如果您想看全局流量，请改问“总流量趋势”。';
  }

  if (normalizedReason === 'group_argument_required') {
    return `查询${objectLabel}的趋势或平均值需要指定具体${objectLabel}名称，请补充对象名称。`;
  }

  return '';
}

function buildNapmSkillExecutionFailureReply() {
  return [
    'NAPM 查询工具执行失败，本次没有取得有效数据。',
    '请稍后重试；如持续失败，请联系维护人员检查查询工具运行状态。'
  ].join('\n');
}

function buildResolvedQueryValidationFailureReply() {
  return [
    '当前查询参数未构造完整，本次没有执行 NAPM 查询。',
    '请重新发起查询；如持续失败，请联系维护人员检查查询参数构造链路。'
  ].join('\n');
}

function buildNapmSkillExecutionFailureResult(args = {}) {
  return {
    ok: false,
    source: 'napm_openclaw_plugin',
    responseType: 'SKILL_EXECUTION_ERROR',
    prompt: normalizePrompt(args),
    decision: {
      next_action: 'RETRY_OR_ESCALATE',
      reason: 'skill_execution_failed'
    },
    error: {
      code: 'NAPM_SKILL_EXECUTION_FAILED',
      reason: 'skill_execution_failed',
      retryable: true
    },
    displayText: buildNapmSkillExecutionFailureReply(),
    resolvedQuery: normalizeObject(args?.resolvedQuery) || null
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
  // Report workflows must not be treated as overview data queries.
  if (isReportWorkflowPrompt(prompt)) {
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

function isObjectInventoryPrompt(prompt = '') {
  return classifyNapmWorkflow(prompt).workflowType === 'object_inventory';
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
    expectedService: 'groups',
    expectedQueryModeKey: 'metadata',
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
    expectedService: 'groups',
    expectedQueryModeKey: 'metadata',
    message: `This is an NAPM object_inventory query for ${expectedType}. resolvedQuery must use service=groups, queryModeKey=metadata, semanticConstraints.operation=metadata_list, groups=[{type:"${expectedType}"}], and must not use overview/topValues or argument:"all".`
  };
}

function isApplicationTrafficTrendPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return false;
  }

  const hasApplication = /(?:应用|application|app)/i.test(text);
  const hasTraffic = /(?:流量|吞吐|带宽|throughput|bandwidth|traffic)/i.test(text);
  const hasTrendOrAverage = /(?:趋势|走势|变化|曲线|按时间|平均|均值|trend|timeseries|time\s*series|average|mean)/i.test(text);
  return hasApplication && hasTraffic && hasTrendOrAverage;
}

function validateApplicationTrafficScopeResolvedQuery(prompt = '', resolvedQuery = {}) {
  if (!isApplicationTrafficTrendPrompt(prompt)) {
    return { ok: true };
  }

  const service = String(resolvedQuery?.service || '').trim();
  if (!['timeValues', 'averageValues'].includes(service)) {
    return { ok: true };
  }

  const groups = Array.isArray(resolvedQuery?.groups) ? resolvedQuery.groups : [];
  const totalTrafficGroup = groups.find((group) => (
    String(group?.type || '').trim() === 'TotalTraffic'
  ));
  if (!totalTrafficGroup) {
    return { ok: true };
  }

  return {
    ok: false,
    enforce: true,
    reason: 'application_scope_mismatch',
    code: 'APPLICATION_SCOPE_MISMATCH',
    expectedGroupType: 'DefinedApp',
    actualGroupType: 'TotalTraffic',
    message: '应用流量趋势或平均值不能使用 TotalTraffic（总流量）范围。请在有具体应用名称时使用 DefinedApp 并提供 groups[0].argument；没有具体名称时先向用户追问。只有明确询问总流量或全局流量时才使用 TotalTraffic。',
    details: {
      service,
      queryModeKey: String(resolvedQuery?.queryModeKey || '').trim() || null,
      expectedGroupType: 'DefinedApp',
      actualGroupType: 'TotalTraffic',
      argument: String(totalTrafficGroup?.argument ?? '').trim() || null
    }
  };
}

function observePromptQuerySemanticMismatch(prompt = '', resolvedQuery = {}) {
  if (getQuerySemanticGuardMode() === 'off') {
    return { ok: true };
  }

  return [
    validateApplicationTrafficScopeResolvedQuery(prompt, resolvedQuery),
    validateCompositeApplicationInventoryResolvedQuery(prompt, resolvedQuery),
    validateObjectInventoryResolvedQuery(prompt, resolvedQuery)
  ].find((validation) => validation && validation.ok === false) || { ok: true };
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

function getResolvedQueryValidationOptions(args = {}) {
  return {
    nowSeconds: args?.nowSeconds
  };
}

function rememberResolvedQueryFailureForTurn(
  activePrompt = '',
  validation = {},
  args = {},
  conversationKey = '',
  turnId = ''
) {
  const failureResult = buildResolvedQueryBoundaryFailureResult(validation, args);
  const prompt = activePrompt || normalizePrompt(args);
  const failureRecord = napmOperationState.rememberQueryFailure({
    scope: conversationKey,
    turnId,
    promptKey: buildPromptScopeKey(prompt, conversationKey),
    result: failureResult,
    resolvedQuery: normalizeObject(args?.resolvedQuery) || null
  });

  if (failureRecord?.terminal) {
    failureResult.decision = {
      next_action: 'STOP_RETRYING',
      reason: failureResult.error.reason,
      message: 'Query repair budget exhausted. Stop reconstructing and report the typed failure.'
    };
  }

  return failureRecord || {
    result: failureResult,
    attemptCount: 1,
    mayRepair: true,
    terminal: false,
    duplicate: false
  };
}

function rememberResolvedQueryBoundaryFailureForTurn(
  activePrompt = '',
  validation = {},
  args = {},
  conversationKey = '',
  conversationState = null,
  guardState = null
) {
  return rememberResolvedQueryFailureForTurn(
    activePrompt,
    validation,
    args,
    conversationKey,
    getActiveTurnId(conversationState, guardState)
  );
}

function clearResolvedQueryFailureForTurn(conversationKey = '', conversationState = null, guardState = null) {
  return napmOperationState.clearQueryFailureForTurn(
    conversationKey,
    getActiveTurnId(conversationState, guardState)
  );
}

function rememberSkillExecutionFailureForTurn(
  activePrompt = '',
  result = {},
  args = {},
  conversationKey = '',
  turnId = ''
) {
  return napmOperationState.rememberSkillExecutionFailure({
    scope: conversationKey,
    turnId,
    promptKey: buildPromptScopeKey(activePrompt || normalizePrompt(args), conversationKey),
    result,
    resolvedQuery: normalizeObject(args?.resolvedQuery) || null
  });
}

function buildResolvedQueryFailureBlockReason(validation = {}, failureRecord = null) {
  const message = validation.message || 'resolvedQuery failed plugin validation.';
  if (String(validation?.reason || '').trim() === 'application_scope_mismatch') {
    return `${message} 请停止重试工具，直接向用户追问具体应用名称；如果用户要看全局流量，应重新明确询问“总流量趋势”。`;
  }
  if (String(validation?.reason || '').trim() === 'group_argument_required') {
    return `${message} 请停止重试工具，直接向用户追问具体对象名称。`;
  }
  if (failureRecord?.terminal) {
    return `${message} Query repair budget exhausted; stop reconstructing and report this failure.`;
  }
  return `${message} OpenClaw may reconstruct resolvedQuery once.`;
}

function prepareSkillExecutionArgs(args = {}) {
  const prepared = isPlainObject(args) ? { ...args } : {};
  const prompt = normalizePrompt(prepared);
  if (!prepared.userQuery && prompt) {
    prepared.userQuery = prompt;
  }

  if (isPlainObject(prepared.resolvedQuery)) {
    prepared.resolvedQuery = normalizeResolvedQueryForPlugin(prepared.resolvedQuery);
  }

  return applyPathPreflightToSkillArgs(prepared);
}

function buildCanonicalSkillToolParams(activePrompt = '', toolParams = {}) {
  const prompt = String(activePrompt || '').trim();
  const nextParams = isPlainObject(toolParams) ? { ...toolParams } : {};
  if (!prompt) {
    return prepareSkillExecutionArgs(nextParams);
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

function buildGuardKey(prefix, value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized ? `${prefix}:${normalized}` : '';
}

function getGuardKeys(ctx = {}) {
  const conversationParts = [ctx.channelId, ctx.accountId, ctx.conversationId]
    .map((value) => String(value == null ? '' : value).trim());
  const conversationKey = conversationParts.every(Boolean)
    ? `conversation:${conversationParts.join(':')}`
    : '';
  const keys = [
    buildGuardKey('session-key', ctx.sessionKey),
    buildGuardKey('session-id', ctx.sessionId),
    conversationKey,
    buildGuardKey('run-id', ctx.runId),
    buildGuardKey('message-id', ctx.messageId)
  ].filter(Boolean);
  return keys.filter((value, index) => keys.indexOf(value) === index);
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
  const platformIdentityPrompt = isPlatformIdentityPrompt(prompt);
  if (platformIdentityPrompt) {
    const turnPolicy = buildTurnPolicy({ prompt, platformIdentityPrompt });
    return {
      prompt,
      turnPolicy,
      turnRoute: turnPolicy.route,
      napmRelated: false,
      domainRelated: false,
      platformIdentityPrompt: true,
      alertRelated: false,
      alertEventPrompt: false,
      alertMetaFollowUpPrompt: false,
      metricInventoryPrompt: false,
      metaFollowUpPrompt: false,
      resultDeliveryFollowUpPrompt: false,
      lastMetricInventoryGroup: '',
      generalOutOfScopeRequested: false,
      outOfScopeBoundaryRequested: false,
      turnNapmToolUsed: false,
      updatedAt: Date.now()
    };
  }

  const overviewRelated = isOverviewPrompt(prompt);
  const alertEventPrompt = isAlertEventPrompt(prompt);
  const alertMetaFollowUpPrompt = isAlertSkillMetaFollowUpPrompt(prompt, previousState);
  const metricInventoryPrompt = isMetricInventoryPrompt(prompt)
    || (previousState?.lastMetricInventoryGroup && isMetricInventoryDetailPrompt(prompt));
  const metaFollowUpPrompt = isNapmMetaFollowUpPrompt(prompt, previousState);
  const resultDeliveryFollowUpPrompt = isResultDeliveryFollowUpPrompt(prompt, previousState);
  const reportExportPrompt = isReportExportPrompt(prompt);
  const reportWorkflowPrompt = isReportWorkflowPrompt(prompt);
  const domainRelated = overviewRelated
    || reportWorkflowPrompt
    || reportExportPrompt
    || alertEventPrompt
    || alertMetaFollowUpPrompt
    || metricInventoryPrompt
    || isSystemDomainPrompt(prompt)
    || metaFollowUpPrompt
    || resultDeliveryFollowUpPrompt
    || (previousState?.domainRelated && isContinuationPrompt(prompt));
  const napmRelated = overviewRelated
    || reportWorkflowPrompt
    || reportExportPrompt
    || alertEventPrompt
    || alertMetaFollowUpPrompt
    || metricInventoryPrompt
    || isNapmRelatedPrompt(prompt)
    || metaFollowUpPrompt
    || resultDeliveryFollowUpPrompt
    || (previousState?.napmRelated && isContinuationPrompt(prompt));
  const alertRelated = alertEventPrompt
    || alertMetaFollowUpPrompt
    || Boolean(previousState?.alertRelated && (isContinuationPrompt(prompt) || metaFollowUpPrompt));
  const outOfScopeBoundaryRequested = domainRelated && isOutOfScopeNapmRequest(prompt);
  const turnPolicy = buildTurnPolicy({
    prompt,
    napmRelated,
    domainRelated,
    platformIdentityPrompt,
    outOfScopeBoundaryRequested
  });

  return {
    prompt,
    turnPolicy,
    turnRoute: turnPolicy.route,
    napmRelated,
    domainRelated,
    platformIdentityPrompt,
    alertRelated,
    alertEventPrompt,
    alertMetaFollowUpPrompt,
    metricInventoryPrompt,
    metaFollowUpPrompt,
    resultDeliveryFollowUpPrompt,
    lastMetricInventoryGroup: isMetricInventoryPrompt(prompt)
      ? inferMetricInventoryGroup(prompt)
      : (previousState?.lastMetricInventoryGroup || ''),
    generalOutOfScopeRequested: turnPolicy.route === TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE,
    outOfScopeBoundaryRequested,
    turnNapmToolUsed: false,
    updatedAt: Date.now()
  };
}

function getActiveTurnId(conversationState = null, guardState = null) {
  return normalizeTurnId(conversationState?.turnId || guardState?.turnId || '');
}

function derivePromptGuardState(activePrompt = '', conversationState = null, guardState = null) {
  const prompt = String(activePrompt || '').trim();
  const existingState = {
    ...(isPlainObject(conversationState) ? conversationState : {}),
    ...(isPlainObject(guardState) ? guardState : {})
  };
  const existingPrompt = String(existingState.canonicalPrompt || existingState.prompt || '').trim();
  if (
    existingState.turnPolicy
    && (
      !prompt
      || normalizePromptKey(prompt) === normalizePromptKey(existingPrompt)
    )
  ) {
    return {
      ...existingState,
      prompt: prompt || existingPrompt,
      updatedAt: Date.now()
    };
  }

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
  return conversationScopeRegistry.resolve(ctx);
}

function parseOpenClawControlCommand(content = '') {
  const text = String(content || '').trim();
  const match = text.match(/^\/([a-z][a-z0-9_-]*)(?:@\S+)?(?:\s|$)/i);
  if (!match) {
    return null;
  }

  const name = match[1].toLowerCase();
  return {
    name,
    raw: text,
    resetsSession: name === 'new' || name === 'reset'
  };
}

function pruneNativeCommandTurns() {
  const now = Date.now();
  for (const [scope, record] of nativeCommandByScope.entries()) {
    if ((now - Number(record?.updatedAt || 0)) > OPENCLAW_NATIVE_COMMAND_TTL_MS) {
      nativeCommandByScope.delete(scope);
    }
  }
}

function rememberNativeCommandTurn(ctx = {}, command = null) {
  const scope = getConversationKey(ctx);
  if (!scope || !command) {
    return false;
  }
  pruneNativeCommandTurns();
  nativeCommandByScope.set(scope, {
    ...command,
    updatedAt: Date.now()
  });
  return true;
}

function clearNativeCommandTurn(ctx = {}) {
  const scope = getConversationKey(ctx);
  return scope ? nativeCommandByScope.delete(scope) : false;
}

function isNativeCommandTurn(ctx = {}) {
  const scope = getConversationKey(ctx);
  if (!scope) {
    return false;
  }
  pruneNativeCommandTurns();
  return nativeCommandByScope.has(scope);
}

function clearNapmConversationScope(ctx = {}) {
  const scope = getConversationKey(ctx);
  if (!scope) {
    return { scope: '', cleared: false };
  }

  const summary = {
    scope,
    conversationState: napmConversationState.delete(scope),
    operationRecords: napmOperationState.clearScope(scope),
    assistantOutputs: assistantOutputLedger.clearScope(scope),
    reportSources: napmReportSourceStore.clearScope(scope),
    trustedContexts: napmTrustedToolContextStore.clearScope(scope),
    inMemoryTrustedContexts: 0,
    automaticReportOperations: 0,
    mediaState: napmSentMediaByConversation.delete(scope),
    nativeCommandState: nativeCommandByScope.delete(scope),
    scopeAliases: 0,
    guardRecords: 0,
    cleared: true
  };

  for (const [traceId, record] of napmTrustedToolContextByTraceId.entries()) {
    if (String(record?.conversationKey || '').trim() === scope) {
      napmTrustedToolContextByTraceId.delete(traceId);
      summary.inMemoryTrustedContexts += 1;
    }
  }
  for (const key of napmAutomaticReportByTurn.keys()) {
    if (key.startsWith(`${scope}::`) && napmAutomaticReportByTurn.delete(key)) {
      summary.automaticReportOperations += 1;
    }
  }
  for (const [key, state] of napmGuardState.entries()) {
    if (String(state?.conversationKey || '').trim() === scope) {
      napmGuardState.delete(key);
      summary.guardRecords += 1;
    }
  }
  for (const key of getGuardKeys(ctx)) {
    if (napmGuardState.delete(key)) {
      summary.guardRecords += 1;
    }
  }
  summary.scopeAliases = conversationScopeRegistry.clearScope(scope);

  appendPluginAuditEvent('napm_conversation_scope_cleared', {
    ...summary,
    scope: undefined,
    scopeHash: ReportSourceStore.hashScope(scope)
  });
  return summary;
}

function pruneAutomaticReportOperations() {
  const now = Date.now();
  for (const [key, record] of napmAutomaticReportByTurn.entries()) {
    if ((now - Number(record?.updatedAt || 0)) > AUTOMATIC_REPORT_OPERATION_MAX_AGE_MS) {
      napmAutomaticReportByTurn.delete(key);
    }
  }
  while (napmAutomaticReportByTurn.size > 2000) {
    napmAutomaticReportByTurn.delete(napmAutomaticReportByTurn.keys().next().value);
  }
}

function getAutomaticReportOperation(operationKey = '') {
  pruneAutomaticReportOperations();
  return napmAutomaticReportByTurn.get(String(operationKey || '').trim())?.operation || null;
}

function rememberAutomaticReportOperation(operationKey = '', operation = null) {
  const key = String(operationKey || '').trim();
  if (!key || !operation || typeof operation.then !== 'function') {
    return null;
  }
  pruneAutomaticReportOperations();
  napmAutomaticReportByTurn.set(key, { operation, updatedAt: Date.now() });
  return operation;
}

function pruneTrustedToolContexts() {
  const now = Date.now();
  for (const [traceId, record] of napmTrustedToolContextByTraceId.entries()) {
    if ((now - Number(record?.updatedAt || 0)) > TRUSTED_TOOL_CONTEXT_MAX_AGE_MS) {
      napmTrustedToolContextByTraceId.delete(traceId);
    }
  }

  while (napmTrustedToolContextByTraceId.size > 2000) {
    napmTrustedToolContextByTraceId.delete(napmTrustedToolContextByTraceId.keys().next().value);
  }
}

function bindTrustedToolContext(event = {}, ctx = {}) {
  const conversationKey = getConversationKey(ctx);
  if (!conversationKey || !isPlainObject(event?.params)) {
    return '';
  }

  const toolName = String(event.toolName || '').trim() || 'napm-tool';
  const conversationState = napmConversationState.get(conversationKey) || null;
  const guardState = getGuardState(ctx);
  const turnId = getActiveTurnId(conversationState, guardState);
  const traceId = `napm-${crypto.randomUUID()}`;
  if (!traceId) {
    return '';
  }

  pruneTrustedToolContexts();
  napmTrustedToolContextByTraceId.set(traceId, {
    conversationKey,
    turnId: turnId || null,
    toolName,
    updatedAt: Date.now()
  });
  const persistentRecord = napmTrustedToolContextStore.put({
    traceId,
    scope: conversationKey,
    turnId,
    toolName
  });
  if (Object.isExtensible(event.params)) {
    event.params.traceId = traceId;
  }
  appendPluginAuditEvent('trusted_tool_context_bound', {
    traceId,
    toolName,
    turnId: turnId || null,
    scopeHash: ReportSourceStore.hashScope(conversationKey),
    persistent: Boolean(persistentRecord.ok),
    errorCode: persistentRecord.ok ? null : persistentRecord.errorCode
  });
  return traceId;
}

function getTrustedConversationKey(args = {}) {
  const traceId = normalizeTraceId(args?.traceId);
  if (!traceId) {
    return '';
  }
  pruneTrustedToolContexts();
  const record = napmTrustedToolContextByTraceId.get(traceId) || null;
  const memoryScope = String(record?.conversationKey || '').trim();
  if (memoryScope) {
    return memoryScope;
  }

  const persistentRecord = napmTrustedToolContextStore.get(traceId);
  return persistentRecord.ok ? String(persistentRecord.scope || '').trim() : '';
}

function getTrustedTurnId(args = {}) {
  const traceId = normalizeTraceId(args?.traceId);
  if (!traceId) {
    return '';
  }
  pruneTrustedToolContexts();
  const record = napmTrustedToolContextByTraceId.get(traceId) || null;
  const memoryTurnId = normalizeTurnId(record?.turnId);
  if (memoryTurnId) {
    return memoryTurnId;
  }

  const persistentRecord = napmTrustedToolContextStore.get(traceId);
  return persistentRecord.ok ? normalizeTurnId(persistentRecord.turnId) : '';
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

function buildMediaDedupeKey(url = '') {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch (_error) {
    // Keep the original URL when decoding fails.
  }
  const basename = path.basename(decoded.split(/[?#]/, 1)[0] || decoded).toLowerCase();
  if (/\.(?:docx|pdf)$/i.test(basename)) {
    return `report:${basename.replace(/---[0-9a-f]{8}-[0-9a-f-]{27,36}(?=\.(?:docx|pdf)$)/i, '')}`;
  }
  return `url:${decoded}`;
}

function isReportExportPrompt(text = '') {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }
  return /(report|export|word|docx|pdf)/i.test(value)
    || /(报告|报表|导出|文档|文件|总结为|整理成|以\s*word|以\s*pdf|word\s*文档|pdf\s*文档)/i.test(value);
}

function isReportGenerationBypassTool(toolName = '') {
  const normalized = String(toolName || '').trim().toLowerCase();
  return /(exec|shell|terminal|bash|powershell|python|write|file[_-]?write|create[_-]?file)/i.test(normalized);
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

function isAllowedReportArtifactUrl(url = '', conversationKey = '') {
  const record = getFreshReportExportResult(conversationKey);
  if (!record) {
    return false;
  }
  const value = String(url || '').trim();
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

  const conversationKey = getConversationKey(ctx);
  if (!conversationKey) {
    return null;
  }
  const turnId = getActiveTurnId(
    napmConversationState.get(conversationKey) || null,
    getGuardState(ctx)
  );
  const now = Date.now();
  const existing = napmSentMediaByConversation.get(conversationKey) || new Map();
  for (const [key, record] of existing.entries()) {
    if ((now - Number(record?.updatedAt || 0)) > SENT_MEDIA_DEDUPE_WINDOW_MS) {
      existing.delete(key);
    }
  }

  const isDuplicateForTurn = (url) => {
    const record = existing.get(buildMediaDedupeKey(url));
    if (!record) return false;
    return turnId ? record.turnId === turnId : !record.turnId;
  };
  const duplicateUrls = mediaUrls.filter(isDuplicateForTurn);
  const freshUrls = mediaUrls.filter((url) => !isDuplicateForTurn(url));
  for (const url of freshUrls) {
    existing.set(buildMediaDedupeKey(url), { updatedAt: now, turnId: turnId || null });
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

function rememberSkillResult(prompt, result, conversationKey = '', sourceTool = 'napm-skill-query', turnId = '') {
  const key = buildPromptScopeKey(prompt, conversationKey);
  if (!conversationKey || !key || !isPlainObject(result)) {
    return null;
  }
  const record = napmOperationState.rememberSkillResult({
    scope: conversationKey,
    turnId,
    promptKey: key,
    result,
    requestUrl: getRequestUrlFromResult(result),
    resolvedQuery: result.resolvedQuery,
    sourceTool
  });
  if (record && sourceTool === 'napm-alert-packet-analysis' && result.referenceId) {
    const currentState = napmConversationState.get(conversationKey);
    if (currentState) {
      const packetAnalyses = Array.isArray(result.packetAnalyses) ? result.packetAnalyses : [];
      const firstCandidateId = packetAnalyses.length === 1
        ? String(packetAnalyses[0]?.candidate?.candidateId || '').trim()
        : '';
      const workflowState = String(result.workflowState || '').trim();
      napmConversationState.set(conversationKey, {
        ...currentState,
        alertPacketReferenceId: String(result.referenceId).trim(),
        alertPacketCandidateId: String(result.candidateId || firstCandidateId || currentState.alertPacketCandidateId || '').trim() || null,
        alertPacketWorkflowState: workflowState || null,
        alertPacketPendingAction: String(result.decision?.next_action || '').trim() || null,
        alertPacketPreviewRiskAccepted: false,
        updatedAt: Date.now()
      });
    }
  }
  if (
    record
    && sourceTool === 'napm-skill-query'
    && result.ok === true
    && isPlainObject(result.resolvedQuery)
  ) {
    const queryContext = napmOperationState.rememberQueryContext({
      scope: conversationKey,
      turnId,
      sourceTool,
      resolvedQuery: result.resolvedQuery
    });
    if (queryContext) {
      appendPluginAuditEvent('napm_query_context_remembered', {
        turnId: queryContext.turnId,
        sourceTool,
        resolvedQuerySummary: summarizeResolvedQueryForAudit(queryContext.resolvedQuery),
        scopeHash: ReportSourceStore.hashScope(conversationKey)
      });
    }
  }
  const reportData = getReportDataFromResult(result);
  if (!record || !reportData) {
    return record;
  }

  const source = napmReportSourceStore.put({
    scope: conversationKey,
    sourceTool,
    reportType: reportData.reportType,
    promptKey: key,
    reportData
  });
  if (source.ok) {
    record.reportSourceId = source.reportSourceId;
    appendPluginAuditEvent('report_source_stored', {
      reportSourceId: source.reportSourceId,
      sourceTool,
      reportType: source.reportType,
      scopeHash: source.ownerScopeHash,
      expiresAt: source.expiresAt
    });
  } else {
    record.reportSourceErrorCode = source.errorCode;
    appendPluginAuditEvent('report_source_store_failed', {
      sourceTool,
      errorCode: source.errorCode,
      message: source.message
    });
  }
  return record;
}

function normalizeContextComparisonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeContextComparisonValue(item));
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = normalizeContextComparisonValue(value[key]);
        return result;
      }, {});
  }
  return value == null ? null : value;
}

function normalizeContextMetrics(resolvedQuery = {}) {
  const normalized = normalizeResolvedQueryForPlugin(resolvedQuery);
  return Array.isArray(normalized?.metrics)
    ? [...new Set(normalized.metrics
        .map((metric) => String(metric || '').trim().toUpperCase())
        .filter(Boolean))]
        .sort()
    : [];
}

function normalizeContextGroups(resolvedQuery = {}) {
  const normalized = normalizeResolvedQueryForPlugin(resolvedQuery);
  if (!Array.isArray(normalized?.groups) || normalized.groups.length === 0) {
    return [];
  }
  return normalized.groups.map((group) => ({
    type: String(group?.type || '').trim(),
    argument: normalizeContextComparisonValue(group?.argument)
  }));
}

function buildContextTimeSignature(resolvedQuery = {}) {
  const normalized = normalizeResolvedQueryForPlugin(resolvedQuery);
  const key = getRelativeTimeRangeKey(normalized).toLowerCase();
  return {
    key,
    start: Number.isFinite(Number(normalized?.start)) ? Number(normalized.start) : null,
    end: Number.isFinite(Number(normalized?.end)) ? Number(normalized.end) : null,
    granularity: Number.isFinite(Number(normalized?.granularity))
      ? Number(normalized.granularity)
      : null
  };
}

function authorizeContextualTimeValuesFollowUp(conversationKey = '', toolName = '', resolvedQuery = null) {
  if (toolName !== 'napm-skill-query' || !conversationKey || !isPlainObject(resolvedQuery)) {
    return { ok: false, reason: 'unsupported_tool_or_query' };
  }

  const previousRecord = napmOperationState.getLatestQueryContext(conversationKey);
  if (
    !previousRecord
    || previousRecord.sourceTool !== 'napm-skill-query'
    || !isPlainObject(previousRecord.resolvedQuery)
  ) {
    return { ok: false, reason: 'missing_previous_query_context' };
  }

  const previous = normalizeResolvedQueryForPlugin(previousRecord.resolvedQuery);
  const current = normalizeResolvedQueryForPlugin(resolvedQuery);
  if (
    previous?.service !== 'timeValues'
    || current?.service !== 'timeValues'
    || previous?.queryModeKey !== 'timeseries'
    || current?.queryModeKey !== 'timeseries'
  ) {
    return { ok: false, reason: 'unsupported_query_family' };
  }

  const previousMetrics = normalizeContextMetrics(previous);
  const currentMetrics = normalizeContextMetrics(current);
  if (
    previousMetrics.length === 0
    || currentMetrics.length === 0
    || JSON.stringify(previousMetrics) !== JSON.stringify(currentMetrics)
  ) {
    return { ok: false, reason: 'metrics_changed' };
  }

  const previousGroups = normalizeContextGroups(previous);
  const currentGroups = normalizeContextGroups(current);
  if (previousGroups.length === 0) {
    return { ok: false, reason: 'previous_group_context_missing' };
  }
  if (
    currentGroups.length > 0
    && JSON.stringify(previousGroups) !== JSON.stringify(currentGroups)
  ) {
    return { ok: false, reason: 'groups_changed' };
  }

  const previousTime = buildContextTimeSignature(previous);
  const currentTime = buildContextTimeSignature(current);
  const timeRangeChanged = (previousTime.key || currentTime.key)
    ? previousTime.key !== currentTime.key
    : previousTime.start !== currentTime.start || previousTime.end !== currentTime.end;
  const granularityChanged = previousTime.granularity !== currentTime.granularity;
  if (!timeRangeChanged && !granularityChanged) {
    return { ok: false, reason: 'query_time_unchanged' };
  }

  return {
    ok: true,
    reason: 'structured_time_values_followup',
    parentTurnId: previousRecord.turnId || null,
    previousResolvedQuery: previousRecord.resolvedQuery,
    currentGroupsMissing: currentGroups.length === 0
  };
}

function rememberDebugApi(prompt, result, conversationKey = '', turnId = '') {
  const skillRecord = rememberSkillResult(prompt, result, conversationKey, 'napm-skill-query', turnId);

  const key = buildPromptScopeKey(prompt, conversationKey);
  const requestUrl = getRequestUrlFromResult(result);
  if (!conversationKey || !key || !requestUrl) {
    return null;
  }
  const debugRecord = napmOperationState.rememberDebugApi({
    scope: conversationKey,
    turnId,
    promptKey: key,
    requestUrl
  });
  if (debugRecord && skillRecord?.reportSourceId) {
    debugRecord.reportSourceId = skillRecord.reportSourceId;
  }
  return debugRecord;
}

function rememberDebugApiForPromptAliases(prompts = [], result = {}, conversationKey = '', turnId = '') {
  if (!Array.isArray(prompts)) {
    return;
  }

  prompts
    .map((prompt) => String(prompt || '').trim())
    .filter(Boolean)
    .forEach((prompt) => {
      rememberDebugApi(prompt, result, conversationKey, turnId);
    });
}

function rememberReportExportResult(prompt = '', result = {}, conversationKey = '', turnId = '') {
  return napmOperationState.rememberReportExport({
    scope: conversationKey,
    turnId,
    prompt,
    result,
    filePath: result?.filePath,
    downloadUrl: result?.downloadUrl,
    reportId: result?.reportId
  });
}

function getFreshReportExportResult(conversationKey = '', turnId = '') {
  return napmOperationState.getReportExport(conversationKey, turnId);
}

function isFreshReportExportResult(conversationKey = '', turnId = '') {
  return Boolean(getFreshReportExportResult(conversationKey, turnId));
}

function buildFreshReportExportReply(conversationKey = '', turnId = '') {
  const record = getFreshReportExportResult(conversationKey, turnId);
  if (!record?.result?.ok) {
    return '';
  }
  return isMeaningfulText(record.deliveryContent)
    ? String(record.deliveryContent).trim()
    : buildReportExportReply(record.result);
}

function getRecentReportExportResult(conversationKey = '') {
  return getFreshReportExportResult(conversationKey, '');
}

function buildRecentReportExportReply(conversationKey = '') {
  const record = getRecentReportExportResult(conversationKey);
  return record?.result?.ok ? buildReportExportReply(record.result) : '';
}

function buildAutomaticSummaryToolArgs(prompt = '', resolvedScope = null) {
  const normalizedPrompt = String(prompt || '').trim();
  const timeRangeKey = inferOverviewTimeRangeKey(normalizedPrompt) || 'last24hours';
  const sceneKey = normalizeOverviewSceneKey(inferOverviewScene(normalizedPrompt));
  const scopeByScene = {
    system: { type: 'global', label: '全局' },
    business: { type: 'webApplication', label: '业务' },
    application: { type: 'application', label: '应用' },
    business_group: { type: 'businessGroup', label: '业务组' },
    network: { type: 'network', label: '网络' },
    alert: { type: 'alert', label: '告警' }
  };
  const inferredScope = /告警|告警综述|alerts?|alert\s+overview/i.test(normalizedPrompt)
    ? scopeByScene.alert
    : (scopeByScene[sceneKey] || scopeByScene.system);
  const scope = isPlainObject(resolvedScope) && resolvedScope.type
    ? {
      type: String(resolvedScope.type).trim(),
      label: String(resolvedScope.label || '').trim(),
      ...(isPlainObject(resolvedScope.target) ? {
        target: {
          groupType: String(resolvedScope.target.groupType || '').trim(),
          groupArgument: String(resolvedScope.target.groupArgument || '').trim(),
          groupLabel: String(resolvedScope.target.groupLabel || resolvedScope.target.groupArgument || '').trim()
        }
      } : {})
    }
    : inferredScope;
  const titleByType = {
    global: 'NAPM 系统综述报告',
    webApplication: 'NAPM 业务综述报告',
    application: 'NAPM 应用综述报告',
    businessGroup: 'NAPM 业务组综述报告',
    network: 'NAPM 网络综述报告',
    alert: 'NAPM 告警综述报告'
  };
  const targetLabel = String(scope.target?.groupLabel || scope.target?.groupArgument || '').trim();
  const summaryTitle = targetLabel
    ? `${targetLabel} ${String(titleByType[scope.type] || titleByType.global).replace(/^NAPM\s*/, '')}`
    : (titleByType[scope.type] || titleByType.global);
  return {
    prompt: normalizedPrompt,
    sourceQuestion: normalizedPrompt,
    scope,
    timeRange: {
      key: timeRangeKey,
      displayText: normalizedPrompt
    },
    format: 'docx',
    title: summaryTitle
  };
}

function buildSummaryTargetResolutionFailureReply(resolution = {}) {
  const targetHint = String(resolution.targetHint || '指定对象').trim();
  if (resolution.status === TARGET_RESOLUTION_STATUS.AMBIGUOUS) {
    return `检测到多个名为“${targetHint}”的业务或应用，未生成综述报告。请明确说明要分析业务还是应用。`;
  }
  if (resolution.status === TARGET_RESOLUTION_STATUS.CATALOG_UNAVAILABLE) {
    return 'NAPM 对象目录暂时不可用，无法确认综述报告对象，本轮未生成报告。请稍后重试。';
  }
  return `未在 NAPM 对象目录中找到“${targetHint}”，未生成综述报告。请确认对象名称后重试。`;
}

function buildAutomaticSummaryFailureResult(errorCode = 'AUTOMATIC_SUMMARY_FAILED') {
  return {
    content: '综述报告生成失败：数据汇总或文档导出未完成，请稍后重试。',
    mediaUrl: '',
    mediaUrls: [],
    failed: true,
    details: {
      ok: false,
      errorCode: String(errorCode || 'AUTOMATIC_SUMMARY_FAILED').trim()
        || 'AUTOMATIC_SUMMARY_FAILED'
    }
  };
}

function buildAutomaticInspectionToolArgs(prompt = '') {
  const normalizedPrompt = String(prompt || '').trim();
  const resolver = getNapmResolvedQueryResolverService();
  let timeRange;
  try {
    const resolved = resolver?.resolveTimeRange?.(normalizedPrompt);
    if (resolved?.key) {
      timeRange = {
        key: resolved.key,
        displayText: resolved.displayText || normalizedPrompt
      };
    }
  } catch (_error) {
    timeRange = undefined;
  }
  return {
    prompt: normalizedPrompt,
    format: 'docx',
    title: 'NAPM 系统巡检报告',
    ...(timeRange ? { timeRange } : {})
  };
}

async function runAutomaticInspectionReportDelivery(prompt = '', ctx = {}, conversationKey = '', turnId = '') {
  const normalizedPrompt = String(prompt || '').trim();
  const scope = String(conversationKey || '').trim();
  const normalizedTurnId = normalizeTurnId(turnId);
  if (!normalizedPrompt || !scope || !normalizedTurnId || !isInspectionPrompt(normalizedPrompt)) {
    return null;
  }

  const operationKey = `${scope}::${normalizedTurnId}::inspection`;
  const existing = getAutomaticReportOperation(operationKey);
  if (existing) {
    return existing;
  }

  const operation = (async () => {
    try {
      const inspectionEvent = {
        toolName: 'napm-inspection-snapshot',
        params: buildAutomaticInspectionToolArgs(normalizedPrompt)
      };
      bindTrustedToolContext(inspectionEvent, ctx);
      const inspectionArgs = {
        ...inspectionEvent.params,
        traceId: inspectionEvent.params.traceId
      };
      appendPluginAuditEvent('napm_automatic_inspection_started', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        prompt: normalizedPrompt,
        sourceTool: 'napm-inspection-snapshot'
      });

      const inspectionResult = await inspectionSnapshotTool.execute(
        'automatic-inspection-snapshot',
        inspectionArgs
      );
      const inspectionDetails = inspectionResult?.details || null;
      const reportData = inspectionDetails?.reportData || null;
      if (!isPlainObject(inspectionDetails) || inspectionDetails.ok !== true) {
        throw new Error('napm-inspection-snapshot returned no usable result');
      }
      if (
        !isPlainObject(reportData)
        || reportData.reportType !== 'inspection_report'
        || reportData.templateId !== 'napm_traffic_health_inspection_v1'
      ) {
        throw new Error('napm-inspection-snapshot returned an invalid inspection report contract');
      }

      const reportSourceId = String(
        inspectionResult?.metadata?.reportSourceId
        || inspectionDetails?.reportSourceId
        || ''
      ).trim();
      if (!reportSourceId) {
        throw new Error('napm-inspection-snapshot did not provide reportSourceId');
      }

      const exportEvent = {
        toolName: 'napm-report-export',
        params: {
          prompt: normalizedPrompt,
          format: 'docx',
          title: inspectionArgs.title,
          reportSourceId
        }
      };
      bindTrustedToolContext(exportEvent, ctx);
      const exportArgs = {
        ...exportEvent.params,
        traceId: exportEvent.params.traceId
      };
      const exportResult = await reportExportTool.execute(
        'automatic-inspection-report-export',
        exportArgs
      );
      const reportDetails = exportResult?.details || null;
      if (!isPlainObject(reportDetails) || reportDetails.ok !== true || !reportDetails.filePath) {
        throw new Error('napm-report-export did not generate an inspection report');
      }

      appendPluginAuditEvent('napm_automatic_inspection_completed', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        sourceTool: 'napm-inspection-snapshot',
        reportType: reportData.reportType,
        templateId: reportData.templateId,
        reportId: reportDetails.reportId || null,
        format: reportDetails.format || null,
        filePath: reportDetails.filePath
      });
      const deliveryContent = buildInspectionReportDeliveryReply(inspectionDetails, reportDetails);
      napmOperationState.rememberReportDelivery({
        scope,
        turnId: normalizedTurnId,
        content: deliveryContent,
        reportKind: REPORT_INTENTS.INSPECTION
      });
      return {
        content: deliveryContent,
        mediaUrl: reportDetails.filePath,
        mediaUrls: [reportDetails.filePath],
        details: {
          ...reportDetails,
          sourceTool: 'napm-inspection-snapshot',
          reportType: reportData.reportType,
          templateId: reportData.templateId
        }
      };
    } catch (error) {
      appendPluginAuditEvent('napm_automatic_inspection_failed', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        sourceTool: 'napm-inspection-snapshot',
        errorCode: error?.code || 'AUTOMATIC_INSPECTION_FAILED',
        error: String(error?.message || error || 'unknown error').slice(0, 500)
      });
      return {
        content: '巡检报告生成失败：巡检数据采集或报告导出未完成，请稍后重试。',
        mediaUrl: '',
        mediaUrls: [],
        failed: true,
        details: {
          ok: false,
          errorCode: error?.code || 'AUTOMATIC_INSPECTION_FAILED'
        }
      };
    }
  })();

  rememberAutomaticReportOperation(operationKey, operation);
  return operation;
}

async function runAutomaticSummaryReportDelivery(prompt = '', ctx = {}, conversationKey = '', turnId = '') {
  const normalizedPrompt = String(prompt || '').trim();
  const scope = String(conversationKey || '').trim();
  const normalizedTurnId = normalizeTurnId(turnId);
  if (!normalizedPrompt || !scope || !normalizedTurnId || !isSummaryPrompt(normalizedPrompt)) {
    return null;
  }

  const operationKey = `${scope}::${normalizedTurnId}::summary`;
  const existing = getAutomaticReportOperation(operationKey);
  if (existing) {
    return existing;
  }

  const operation = (async () => {
    try {
      loadSkillDotenvIfAvailable();
      const baseArgs = buildAutomaticSummaryToolArgs(normalizedPrompt);
      const targetResolution = await automaticSummaryTargetResolver.resolveSummaryScope(
        normalizedPrompt,
        baseArgs.scope
      );
      appendPluginAuditEvent('napm_summary_target_resolved', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        status: targetResolution?.status || null,
        scopeType: targetResolution?.scope?.type || baseArgs.scope.type,
        groupType: targetResolution?.scope?.target?.groupType || null,
        groupArgument: targetResolution?.scope?.target?.groupArgument || null
      });
      if (!targetResolution?.ok) {
        return {
          content: buildSummaryTargetResolutionFailureReply(targetResolution),
          mediaUrl: '',
          mediaUrls: [],
          failed: true,
          details: {
            ok: false,
            errorCode: `SUMMARY_${String(targetResolution?.status || 'TARGET_RESOLUTION_FAILED').toUpperCase()}`,
            targetResolution
          }
        };
      }
      const summaryEvent = {
        toolName: 'napm-summary',
        params: buildAutomaticSummaryToolArgs(normalizedPrompt, targetResolution.scope)
      };
      bindTrustedToolContext(summaryEvent, ctx);
      const summaryArgs = {
        ...summaryEvent.params,
        traceId: summaryEvent.params.traceId
      };
      appendPluginAuditEvent('napm_automatic_summary_started', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        prompt: normalizedPrompt,
        timeRangeKey: summaryArgs.timeRange?.key || null
      });
      const summaryResult = await summaryTool.execute('automatic-summary', summaryArgs);
      const summaryDetails = summaryResult?.details || null;
      if (!isPlainObject(summaryDetails) || summaryDetails.ok !== true) {
        throw new Error('napm-summary returned no usable result');
      }
      const reportSourceId = String(
        summaryResult?.metadata?.reportSourceId
        || summaryDetails?.reportSourceId
        || ''
      ).trim();
      if (!reportSourceId) {
        throw new Error('napm-summary did not provide reportSourceId');
      }

      const exportEvent = {
        toolName: 'napm-report-export',
        params: {
          prompt: normalizedPrompt,
          format: 'docx',
          title: summaryArgs.title,
          reportSourceId
        }
      };
      bindTrustedToolContext(exportEvent, ctx);
      const exportArgs = {
        ...exportEvent.params,
        traceId: exportEvent.params.traceId
      };
      const exportResult = await reportExportTool.execute('automatic-report-export', exportArgs);
      const reportDetails = exportResult?.details || null;
      const reportFilePath = String(reportDetails?.filePath || '').trim();
      if (!isPlainObject(reportDetails) || reportDetails.ok !== true || !reportFilePath) {
        throw new Error('napm-report-export did not generate a report');
      }

      appendPluginAuditEvent('napm_automatic_summary_completed', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        reportId: reportDetails.reportId || null,
        format: reportDetails.format || null
      });
      return {
        content: buildReportExportReply(reportDetails),
        mediaUrl: reportFilePath,
        mediaUrls: [reportFilePath],
        details: {
          ...reportDetails,
          filePath: reportFilePath
        }
      };
    } catch (error) {
      appendPluginAuditEvent('napm_automatic_summary_failed', {
        conversationKey: scope,
        turnId: normalizedTurnId,
        errorCode: error?.code || 'AUTOMATIC_SUMMARY_FAILED',
        error: String(error?.message || error || 'unknown error').slice(0, 500)
      });
      return buildAutomaticSummaryFailureResult(error?.code || 'AUTOMATIC_SUMMARY_FAILED');
    }
  })();

  rememberAutomaticReportOperation(operationKey, operation);
  return operation;
}

function buildReplyDispatchMessageContext(event = {}) {
  const messageContext = isPlainObject(event?.ctx) ? event.ctx : {};
  return {
    sessionKey: String(event?.sessionKey || messageContext.SessionKey || '').trim() || undefined,
    channelId: String(
      event?.originatingChannel
      || messageContext.OriginatingChannel
      || messageContext.Surface
      || messageContext.Provider
      || ''
    ).trim() || undefined,
    accountId: String(messageContext.AccountId || '').trim() || undefined,
    conversationId: String(
      event?.originatingTo
      || messageContext.OriginatingTo
      || messageContext.NativeDirectUserId
      || messageContext.From
      || messageContext.To
      || ''
    ).trim() || undefined,
    runId: String(event?.runId || '').trim() || undefined,
    messageId: String(messageContext.MessageSid || messageContext.MessageSidFull || '').trim() || undefined
  };
}

function getReplyDispatchPrompt(event = {}, conversationState = null) {
  const messageContext = isPlainObject(event?.ctx) ? event.ctx : {};
  const fallbackPrompt = [
    messageContext.BodyForCommands,
    messageContext.CommandBody,
    messageContext.RawBody,
    messageContext.Body
  ]
    .map((item) => String(item || '').trim())
    .find(isMeaningfulText) || '';
  return selectActivePromptText(conversationState, null, fallbackPrompt);
}

async function dispatchReportReplyPayload(
  payload = {},
  event = {},
  hookCtx = {},
  auditEvent = '',
  deliveryContext = {}
) {
  const content = String(payload?.content || payload?.text || '').trim();
  const filePath = String(payload?.mediaUrl || payload?.filePath || '').trim();
  if (!content || typeof hookCtx?.dispatcher?.sendFinalReply !== 'function') {
    return null;
  }

  const conversationKey = String(deliveryContext?.conversationKey || '').trim();
  const turnId = normalizeTurnId(deliveryContext?.turnId);
  if (conversationKey && turnId && !napmOperationState.claimFinalDelivery(conversationKey, turnId)) {
    appendPluginAuditEvent('napm_report_duplicate_reply_dispatch_suppressed', {
      conversationKey,
      turnId,
      reportKind: deliveryContext?.reportKind || null,
      filePath: filePath || null
    });
    return {
      handled: true,
      queuedFinal: false,
      counts: typeof hookCtx.dispatcher.getQueuedCounts === 'function'
        ? hookCtx.dispatcher.getQueuedCounts()
        : { tool: 0, block: 0, final: 0 }
    };
  }

  if (typeof hookCtx.onReplyStart === 'function') {
    await hookCtx.onReplyStart();
  }
  const replyPayload = {
    text: content,
    ...(filePath ? { mediaUrl: filePath, mediaUrls: [filePath] } : {})
  };
  const queuedFinal = Boolean(hookCtx.dispatcher.sendFinalReply(replyPayload));
  const counts = typeof hookCtx.dispatcher.getQueuedCounts === 'function'
    ? hookCtx.dispatcher.getQueuedCounts()
    : { tool: 0, block: 0, final: queuedFinal ? 1 : 0 };
  if (queuedFinal) {
    hookCtx.recordProcessed?.('completed', { reason: 'napm_report_reply_dispatched' });
    hookCtx.markIdle?.('message_completed');
  }
  appendPluginAuditEvent(auditEvent || 'napm_report_reply_dispatched', {
    sessionKey: event?.sessionKey || null,
    runId: event?.runId || null,
    conversationKey: conversationKey || null,
    turnId: turnId || null,
    reportKind: deliveryContext?.reportKind || null,
    filePath: filePath || null,
    queuedFinal
  });
  return {
    handled: true,
    queuedFinal,
    counts
  };
}

async function dispatchAlertReplyPayload(record = null, event = {}, hookCtx = {}, conversationKey = '', turnId = '') {
  const content = isCurrentAlertQueryResultRecord(record, turnId)
    ? buildAlertQueryReply(record.result)
    : '';
  if (
    !content
    || !conversationKey
    || !turnId
    || typeof hookCtx?.dispatcher?.sendFinalReply !== 'function'
  ) {
    return null;
  }

  const preparedFinal = napmOperationState.prepareFinalContent({
    scope: conversationKey,
    turnId,
    content,
    source: 'napm-alert-query',
    workflowState: 'ALERT_QUERY_COMPLETED'
  });
  if (!preparedFinal) {
    return null;
  }

  const claimed = napmOperationState.claimPreparedFinalDelivery(conversationKey, turnId);
  const counts = () => (typeof hookCtx.dispatcher.getQueuedCounts === 'function'
    ? hookCtx.dispatcher.getQueuedCounts()
    : { tool: 0, block: 0, final: 0 });
  if (!claimed) {
    appendPluginAuditEvent('napm_alert_duplicate_reply_dispatch_suppressed', {
      conversationKey,
      turnId,
      sourceTool: record.sourceTool,
      fingerprint: preparedFinal.fingerprint
    });
    return {
      handled: true,
      queuedFinal: false,
      counts: counts()
    };
  }

  if (typeof hookCtx.onReplyStart === 'function') {
    await hookCtx.onReplyStart();
  }
  const queuedFinal = Boolean(hookCtx.dispatcher.sendFinalReply({ text: preparedFinal.content }));
  if (queuedFinal) {
    hookCtx.recordProcessed?.('completed', { reason: 'napm_alert_reply_dispatched' });
    hookCtx.markIdle?.('message_completed');
  }
  appendPluginAuditEvent('napm_alert_reply_dispatched', {
    conversationKey,
    turnId,
    sourceTool: record.sourceTool,
    contentLength: preparedFinal.content.length,
    fingerprint: preparedFinal.fingerprint,
    queuedFinal
  });
  return {
    handled: true,
    queuedFinal,
    counts: counts()
  };
}

function isFreshRememberedRecord(record, maxAgeMs = RESULT_CACHE_MAX_AGE_MS) {
  return Boolean(
    record
    && Number(record.updatedAt) > 0
    && (Date.now() - Number(record.updatedAt)) <= maxAgeMs
  );
}

function getLatestRememberedSkillRecord(conversationKey = '') {
  return napmOperationState.getLatestSkillResult(conversationKey);
}

function getReportDataFromResult(result = null) {
  if (!isPlainObject(result)) {
    return null;
  }
  if (isPlainObject(result.reportData)) {
    return result.reportData;
  }
  if (isPlainObject(result.details) && isPlainObject(result.details.reportData)) {
    return result.details.reportData;
  }
  if (isPlainObject(result.result) && isPlainObject(result.result.reportData)) {
    return result.result.reportData;
  }
  return null;
}

function getReportDataFromRecord(record = null) {
  if (!record || !isPlainObject(record.result)) {
    return null;
  }
  // 2026-07-09 修复：execute() 返回 {content, details: result} 或 {content, result}，
  // reportData 嵌套在 details 或 result 子对象中，不在顶层。
  if (isPlainObject(record.result.reportData)) {
    return record.result.reportData;
  }
  // napm-summary / napm-inspection: {content, details: {..., reportData}}
  if (isPlainObject(record.result.details) && isPlainObject(record.result.details.reportData)) {
    return record.result.details.reportData;
  }
  // napm-fault-diagnosis: {content, result: {..., reportData}}
  if (isPlainObject(record.result.result) && isPlainObject(record.result.result.reportData)) {
    return record.result.result.reportData;
  }
  return null;
}

function getRememberedDebugApi(prompt, conversationKey = '') {
  const key = buildPromptScopeKey(prompt, conversationKey);
  if (!key) {
    return '';
  }
  return String(napmOperationState.getDebugApi(key)?.requestUrl || '').trim();
}

function getRecentDebugApiFallback(conversationKey = '') {
  return String(napmOperationState.getLatestDebugApi(conversationKey)?.requestUrl || '').trim();
}

function getRememberedSkillResult(prompt, conversationKey = '') {
  const key = buildPromptScopeKey(prompt, conversationKey);
  if (!key) {
    return null;
  }
  return napmOperationState.getSkillResult(key);
}

function getRecentRememberedSkillResult(conversationKey = '') {
  return napmOperationState.getLatestSkillResult(conversationKey);
}

function getRememberedSkillResultForTurn(conversationKey = '', turnId = '') {
  return napmOperationState.getSkillResultForTurn(conversationKey, turnId);
}

function getRememberedQueryFailureForTurn(conversationKey = '', turnId = '') {
  return napmOperationState.getQueryFailureForTurn(conversationKey, turnId);
}

function getRememberedSkillExecutionFailureForTurn(conversationKey = '', turnId = '') {
  return napmOperationState.getSkillExecutionFailureForTurn(conversationKey, turnId);
}

function getRememberedRecordForPrompt(activePrompt = '', conversationState = null, conversationKey = '', guardState = null) {
  if (isPlatformIdentityPrompt(activePrompt)) {
    return null;
  }

  const metaFollowUp = isNapmMetaFollowUpPrompt(activePrompt, guardState || conversationState);
  const resultDeliveryFollowUp = isResultDeliveryFollowUpPrompt(activePrompt, guardState || conversationState);
  const currentTurnRecord = getRememberedSkillResultForTurn(
    conversationKey,
    getActiveTurnId(conversationState, guardState)
  );
  if (currentTurnRecord) {
    return currentTurnRecord;
  }
  const currentTurnExecutionFailure = getRememberedSkillExecutionFailureForTurn(
    conversationKey,
    getActiveTurnId(conversationState, guardState)
  );
  if (currentTurnExecutionFailure) {
    return currentTurnExecutionFailure;
  }
  const currentTurnFailure = getRememberedQueryFailureForTurn(
    conversationKey,
    getActiveTurnId(conversationState, guardState)
  );
  if (currentTurnFailure) {
    return currentTurnFailure;
  }
  if (resultDeliveryFollowUp) {
    const recentRecord = getRecentRememberedSkillResult(conversationKey);
    return recentRecord
      && isPlainObject(recentRecord.result)
      && recentRecord.result.ok !== false
      && !recentRecord.result.error
      ? recentRecord
      : null;
  }
  if (isObjectInventoryPrompt(activePrompt)) {
    return null;
  }
  if (isMetricInventoryPrompt(activePrompt) && !isMetricInventoryDetailPrompt(activePrompt)) {
    // A repeated metric inventory question is a new data request. Only the
    // current turn's result may support it; explicit detail follow-ups below
    // retain the existing conversation-context behavior.
    return null;
  }
  return getRememberedSkillResult(activePrompt, conversationKey)
    || getRememberedMetricInventoryFollowUpRecord(activePrompt, conversationState, conversationKey)
    || (isMetricInventoryDetailPrompt(activePrompt) ? getRecentRememberedSkillResult(conversationKey) : null)
    || (metaFollowUp ? getRecentRememberedSkillResult(conversationKey) : null);
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

function isCurrentAlertQueryResultRecord(record = null, turnId = '') {
  return Boolean(
    record
    && record.sourceTool === 'napm-alert-query'
    && record.result?.ok === true
    && isAlertSkillResultRecord(record)
    && isSkillResultRecordForTurn(record, turnId)
  );
}

function isAlertPacketSkillResultRecord(record = null) {
  if (!record || !isPlainObject(record.result)) {
    return false;
  }
  const result = record.result;
  return Boolean(
    result.workflowType === 'alert_packet_analysis'
    || result?.narrationInput?.schema === 'openclaw_napm_alert_packet_analysis.v1'
  );
}

function isSkillResultRecordForTurn(record = null, turnId = '') {
  const normalizedTurnId = normalizeTurnId(turnId);
  return Boolean(
    record
    && normalizedTurnId
    && normalizeTurnId(record.turnId) === normalizedTurnId
  );
}

function isAlertScopedSkillResultRecord(record = null) {
  return isAlertSkillResultRecord(record) || isAlertPacketSkillResultRecord(record);
}

function getRememberedAlertRecordForPrompt(activePrompt = '', conversationState = null, conversationKey = '', guardState = null) {
  const candidates = [
    getRememberedSkillResultForTurn(conversationKey, getActiveTurnId(conversationState, guardState)),
    getRememberedSkillResult(activePrompt, conversationKey)
  ];

  const alertFollowUp = Boolean(
    isAlertEventPrompt(activePrompt)
    || isAlertSkillMetaFollowUpPrompt(activePrompt, guardState || conversationState)
    || conversationState?.alertRelated
    || guardState?.alertRelated
  );
  if (alertFollowUp) {
    candidates.push(getRecentRememberedSkillResult(conversationKey));
  }

  return candidates.find((record) => isFreshRememberedRecord(record) && isAlertScopedSkillResultRecord(record)) || null;
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
    || (
      getRecentRememberedSkillResult(conversationKey)
      && String(getRecentRememberedSkillResult(conversationKey)?.resolvedQuery?.groups?.[0]?.type || '').trim() === groupType
      && String(getRecentRememberedSkillResult(conversationKey)?.resolvedQuery?.service || '').trim() === 'metrics'
        ? getRecentRememberedSkillResult(conversationKey)
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

  if (/(数据包|报文|抓包|抓取包|下载包|下载数据包|原始包|包详情|数据包情况|\bpcap\b|\.cap\b|\bcap\b|packetsPreview|packetsDown|DownServlet)/i.test(text)) {
    return true;
  }

  const hasPacketNoun = /\bpackets?\b/i.test(text);
  if (!hasPacketNoun) {
    return false;
  }

  const hasPacketLossMetric = /\bpacket[\s-]*loss(?:\s+rate)?\b|\bloss\s+rate\b|\bPLI\b/i.test(text);
  const hasExplicitCaptureArtifact = /\b(?:capture|download|fetch|export)\b|\braw\s+packets?\b|\bpcap\b|\.cap\b/i.test(text);
  if (hasPacketLossMetric && !hasExplicitCaptureArtifact) {
    return false;
  }

  const hasPacketOperation = /\b(?:capture|download|fetch|inspect|analy[sz]e|analysis|preview|decode|export|open)\b/i.test(text);
  const hasPacketDetailIntent = /\bpackets?\s+(?:details?|contents?|payloads?|headers?)\b|\b(?:details?|contents?|payloads?|headers?)\s+(?:of|for)\s+(?:the\s+)?packets?\b/i.test(text);
  return hasExplicitCaptureArtifact || hasPacketOperation || hasPacketDetailIntent;
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

  if (isAlertPacketAnalysisPrompt(text)) {
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

  return includesAnyKeyword(text, [
    '这个',
    '它',
    '上面',
    '上述',
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
  // 🔴 2026-07-27 修复: 优先检查 ok 状态，防止 failure result 中
  // narrationInput.displayText（"告警总数：0 条"模板）把真实错误吞噬。
  if (!result?.ok) {
    return String(
      result?.error?.message
      || result?.message
      || '告警查询失败。'
    ).trim();
  }

  // skill 已生成 displayText → 直接透传
  const skillText = result?.narrationInput?.displayText;
  if (skillText) {
    const requestUrl = maskDebugApiUrl(result.requestUrl || result.requestUrls?.[0] || '');
    return appendDebugApi(skillText, requestUrl);
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
    // USE_CANDIDATES — AI 必须逐条调 packet-analysis，这是中间步骤不是最终答复。
    // 2026-07-14: 实测 AI 多次忽略原格式，改成顶部红标强制指令。
    lines.push('🚨🚨🚨 下一步操作（必须执行，这是中间步骤，不是最终答复）🚨🚨🚨');
    lines.push('');
    lines.push(`已发现 ${pi.candidates.length} 个嫌疑 IP 会话。`);
    lines.push('你必须立即对每个 candidate 调用 napm-packet-analysis 工具：');
    lines.push('');
    for (const c of pi.candidates) {
      const label = c.ipPair || c.ip || c.ips?.join('↔') || '-';
      const sq = c.suggestedPacketQuery || {};
      lines.push(`  napm-packet-analysis(`);
      lines.push(`    mode: "${sq.mode || 'preview_download_analyze'}",`);
      lines.push(`    criteria: { ips: ${JSON.stringify(sq.criteria?.ips || c.ips)}, start: ${sq.criteria?.start || ''}, end: ${sq.criteria?.end || ''} },`);
      if (sq.analysis && sq.analysis.hasTriggerMetrics) {
        lines.push(`    analysis: { metrics: ${JSON.stringify(sq.analysis.metrics)}, metricLabels: ${JSON.stringify(sq.analysis.metricLabels)}, instruction: "${sq.analysis.instruction?.slice(0, 60)}..." }`);
      }
      lines.push(`  )  ← 第${c.rank}个候选: ${label}`);
      lines.push('');
    }
    // 触发指标
    if (Array.isArray(triggerInfo) && triggerInfo.length > 0) {
      const t = triggerInfo[0];
      const m = (t.metrics||[]).join('、') || null;
      if (m) {
        lines.push(`📊 告警触发指标: ${m} = ${(t.value||[]).join('、')}${(t.unit||[])[0] || ''}（${t.severityLabel||'?'}）`);
      }
    }
    lines.push('');
    lines.push('⛔ 禁止: 自己拼 curl、用 napm-skill-query 查 IP 会话、直接输出这段文本给用户。');
    lines.push('✅ 必须: 对上面每个 candidate 调 napm-packet-analysis，拿到 tshark 分析结果后再组织最终答复。');
    lines.push('');
    // 告警基本信息（参考用）
    const events = Array.isArray(result.details) && result.details.length > 0
      ? result.details
      : (Array.isArray(result.events) ? result.events : []);
    if (events.length > 0) {
      const e = events[0];
      lines.push(`--- 参考信息 ---`);
      lines.push(`告警: ${e.id} ${e.severityLabel||''} ${e.group||''} ${e.name||''} | 时间: ${e.start||'-'}~${e.end||'-'}`);
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
  return appendDebugApi(text, requestUrl);
}

function buildAlertQueryToolResponse(result = {}, renderedText = '', reportSourceId = '') {
  const text = String(renderedText || '').trim();
  const metadata = {
    sourceTool: 'napm-alert-query',
    answerMode: 'deterministic'
  };
  if (reportSourceId) {
    metadata.reportSourceId = reportSourceId;
  }
  return {
    content: [
      {
        type: 'text',
        text
      }
    ],
    details: result,
    isError: result?.ok === false,
    metadata,
    finalAnswer: text,
    displayText: text
  };
}

function buildAlertPacketAnalysisReply(result = {}) {
  if (!result?.ok) {
    return String(
      result?.error?.message
      || '告警数据包分析工作流执行失败。'
    ).trim();
  }
  return [
    '告警详情与数据包分析已完成。请仅依据下面的结构化证据解释告警触发原因，不得再次查询告警汇总，不得猜测 IP 或补写数据包结论。',
    JSON.stringify(result.narrationInput || result, null, 2)
  ].join('\n\n');
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
    // 2026-07-14: 禁止 AI 看到 Password=*** 后自己猜密码填进去。
    // skill 内部已从 .env 读取正确凭证，URL 中的 *** 是脱敏标记。
    const credentialNotice = '⛔ 安全提示：所有 URL 中的认证（UserName/Password）已由 skill 从 .env 自动注入。Password=*** 是脱敏标记，不是占位符——禁止自行替换或拼接密码！如需下载/分析数据包，请使用 napm-packet-analysis 工具而非 curl。';
    return highlights.join('\n') + '\n\n' + credentialNotice;
  }
  return JSON.stringify(result, null, 2);
}

function buildLegacyReportDataForExport(args = {}) {
  const explicitReportData = isPlainObject(args.reportData) ? args.reportData : null;
  const conversationKey = getTrustedConversationKey(args);
  const rememberedRecord = getLatestRememberedSkillRecord(conversationKey);
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
        reportDataSource: explicitReportData ? 'tool_args.reportData' : 'conversation_scoped_napm_skill_result',
        sourcePromptKey: rememberedRecord?.promptKey || null
      }
    },
    source: explicitReportData ? 'tool_args.reportData' : 'conversation_scoped_napm_skill_result'
  };
}

function buildReportDataForExport(args = {}) {
  const reportInput = buildReportInputForExport(args);
  if (!reportInput.ok) {
    return reportInput;
  }
  return {
    ok: true,
    reportData: reportInput.reportData,
    source: reportInput.source
  };
}

function auditReportExportSourceResolved(reportInput = {}, args = {}) {
  const source = isPlainObject(reportInput.reportSource) ? reportInput.reportSource : null;
  appendPluginAuditEvent('report_export_source_resolved', {
    traceId: normalizeTraceId(args.traceId) || null,
    reportSourceId: source?.reportSourceId || null,
    source: reportInput.source || null,
    sourceTool: source?.sourceTool || null,
    reportType: source?.reportType || null,
    scopeHash: source?.ownerScopeHash || reportInput.scopeHash || null
  });
}

function auditReportGenerated(result = {}, reportInput = {}, args = {}) {
  appendPluginAuditEvent('report_generated', {
    traceId: normalizeTraceId(args.traceId) || null,
    reportSourceId: reportInput.reportSource?.reportSourceId || null,
    reportId: String(result.reportId || '').trim() || null,
    format: String(result.format || '').trim() || null,
    scopeHash: reportInput.reportSource?.ownerScopeHash || reportInput.scopeHash || null
  });
}

function buildReportInputForExport(args = {}) {
  const explicitReportData = isPlainObject(args.reportData) ? args.reportData : null;
  const conversationKey = getTrustedConversationKey(args);
  const explicitReportSourceId = String(args.reportSourceId || '').trim();
  const rememberedRecord = conversationKey
    ? getLatestRememberedSkillRecord(conversationKey)
    : null;
  const rememberedReportData = getReportDataFromRecord(rememberedRecord);
  const explicitSourceResult = isPlainObject(args.sourceResult)
    ? args.sourceResult
    : (isPlainObject(args.packetResult)
      ? args.packetResult
      : (isPlainObject(args.queryResult) ? args.queryResult : null));
  const rememberedSourceResult = isPlainObject(rememberedRecord?.result)
    ? rememberedRecord.result
    : null;

  if (!explicitReportData && !explicitSourceResult && !conversationKey) {
    return {
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND',
      message: '未找到可导出的结构化结果。请先完成一次 NAPM 查询或数据包分析，再导出 Word。'
    };
  }

  const persistedSource = (explicitReportData || explicitSourceResult)
    ? null
    : (explicitReportSourceId
      ? napmReportSourceStore.get({
        reportSourceId: explicitReportSourceId,
        scope: conversationKey
      })
      : napmReportSourceStore.findForScope(conversationKey));
  const persistedReportData = persistedSource?.ok ? persistedSource.reportData : null;
  const sourceReportData = explicitReportData
    || (!explicitSourceResult ? (persistedReportData || rememberedReportData) : null);
  const sourceResult = explicitSourceResult || (!sourceReportData ? rememberedSourceResult : null);

  if (
    persistedSource
    && !persistedSource.ok
    && !['REPORT_SOURCE_NOT_FOUND', 'REPORT_SOURCE_EXPIRED'].includes(persistedSource.errorCode)
  ) {
    return persistedSource;
  }

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
        reportDataSource: explicitReportData
          ? 'tool_args.reportData'
          : (persistedReportData ? 'report_source_store' : 'latest_napm_skill_result.reportData'),
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
    reportSource: persistedSource?.ok ? {
      reportSourceId: persistedSource.reportSourceId,
      sourceTool: persistedSource.sourceTool,
      reportType: persistedSource.reportType,
      ownerScopeHash: persistedSource.ownerScopeHash
    } : null,
    scopeHash: conversationKey ? ReportSourceStore.hashScope(conversationKey) : null,
    source: sourceReportData
      ? (explicitReportData
        ? 'tool_args.reportData'
        : (persistedReportData ? 'report_source_store' : 'latest_napm_skill_result.reportData'))
      : (explicitSourceResult ? 'tool_args.sourceResult' : 'latest_structured_skill_result')
  };
}


function normalizeInspectionStatusLabel(status = '') {
  const value = String(status || '').trim();
  if (!value) {
    return '';
  }
  if (/^(?:ok|normal|healthy|正常|良好)$/i.test(value)) {
    return '正常';
  }
  if (/^(?:warning|warn|attention|需关注|警告)$/i.test(value)) {
    return '需关注';
  }
  if (/^(?:critical|error|failed|failure|abnormal|异常|严重)$/i.test(value)) {
    return '异常';
  }
  return '';
}

function normalizeReportHighlights(highlights = [], limit = 5) {
  if (!Array.isArray(highlights)) {
    return [];
  }
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  return highlights
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== '[object Object]' && item !== '[object Array]')
    .slice(0, normalizedLimit);
}

function buildInspectionReportDeliveryReply(inspectionResult = {}, reportResult = {}) {
  if (!reportResult?.ok) {
    return buildReportExportReply(reportResult);
  }

  const summary = isPlainObject(inspectionResult?.summary) ? inspectionResult.summary : {};
  const title = String(
    reportResult?.title
    || summary.title
    || inspectionResult?.reportData?.title
    || 'NAPM 系统巡检报告'
  ).trim();
  const statusLabel = normalizeInspectionStatusLabel(
    summary.status || inspectionResult?.inspection?.summary?.overallStatus
  );
  const highlights = normalizeReportHighlights(summary.highlights, 5);
  const conclusion = String(inspectionResult?.inspection?.summary?.conclusion || '').trim();
  const lines = [`系统巡检报告已生成：${title}`];

  if (statusLabel) {
    lines.push(`总体状态：${statusLabel}`);
  }
  if (highlights.length > 0) {
    lines.push('重点发现：');
    highlights.forEach((item) => lines.push(`- ${item}`));
  } else if (conclusion) {
    lines.push(`巡检结论：${conclusion}`);
  }

  lines.push('', '完整巡检报告已作为附件发送。');
  return lines.join('\n');
}

function buildReportExportReply(result = {}) {
  if (!result?.ok) {
    return String(result?.message || '报告导出失败。').trim();
  }
  const lines = [
    `报告已生成：${result.title || result.reportId || 'NAPM 报告'}`,
    `格式：${result.format || 'docx'}`,
    '完整报告将以附件形式发送。'
  ];
  return lines.join('\n');
}

function appendReportSourceId(text, reportSourceId = '') {
  const normalizedId = String(reportSourceId || '').trim();
  const normalizedText = String(text || '').trim();
  return normalizedId
    ? `${normalizedText}${normalizedText ? '\n' : ''}报告数据编号：${normalizedId}`
    : normalizedText;
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

  if (isAlertPacketSkillResultRecord(rememberedRecord)) {
    return buildAlertPacketFinalReply(rememberedRecord.result);
  }

  if (isAlertSkillResultRecord(rememberedRecord)) {
    return buildAlertQueryReply(rememberedRecord.result);
  }

  if (rememberedRecord.recordType === 'query_validation_failure') {
    return buildResolvedQueryValidationFailureReply();
  }

  if (rememberedRecord.recordType === 'skill_execution_failure') {
    return buildNapmSkillExecutionFailureReply();
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
    'WebApplication 业务系统目录的查询口径是 applications Type=3；不是按流量活跃度过滤，也不是中文名称过滤。'
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

function buildAlertPacketSkillRequiredReply() {
  return [
    '当前告警引用尚未完成数据包分析，系统未执行推测性分析。',
    '请稍后重试该告警引用；不需要补充 eventId、start 或 end。'
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
  if (isAlertPacketAnalysisPrompt(prompt)) {
    return buildAlertPacketSkillRequiredReply();
  }
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

  if (isPlatformIdentityPrompt(text)) {
    return false;
  }

  return Boolean(
    isAlertEventPrompt(text)
    || isAlertSkillMetaFollowUpPrompt(text, guardState)
    || guardState?.alertRelated
    || isPacketCapturePrompt(text)
    || isObjectInventoryPrompt(text)
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

  if (isPlatformIdentityPrompt(prompt)) {
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
    || isObjectInventoryPrompt(prompt)
    || isResultDeliveryFollowUpPrompt(prompt, guardState)
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
  const authoritativeCandidates = [
    conversationState?.canonicalPrompt,
    guardState?.canonicalPrompt,
    conversationState?.prompt,
    guardState?.prompt
  ]
    .map((item) => String(item || '').trim())
    .filter(isMeaningfulText);

  if (authoritativeCandidates.length > 0) {
    return authoritativeCandidates[0];
  }
  return isMeaningfulText(fallbackPrompt) ? String(fallbackPrompt).trim() : '';
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

function messageContainsToolCall(message = null) {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((part) => {
    const type = String(part?.type || '').trim().toLowerCase().replace(/[_-]/g, '');
    return type === 'toolcall' || isPlainObject(part?.toolCall);
  });
}

function buildFallbackSendingResult(content, conversationKey = '', conversationState = null, guardState = null) {
  const turnId = getActiveTurnId(conversationState, guardState);
  if (
    conversationKey
    && turnId
    && !napmOperationState.claimFallbackDelivery(conversationKey, turnId)
  ) {
    appendPluginAuditEvent('napm_plugin_duplicate_fallback_suppressed', {
      conversationKey,
      turnId
    });
    return { cancel: true };
  }
  return { content };
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

  const alertPacketPrompt = isAlertPacketAnalysisPrompt(prompt);
  const napmPrompt = Boolean(
    alertPacketPrompt
    || guardState?.napmRelated
    || isNapmRelatedPrompt(prompt)
    || isOverviewPrompt(prompt)
    || isHierarchyCatalogPrompt(prompt)
    || isMetricInventoryPrompt(prompt)
    || isMetricInventoryDetailPrompt(prompt)
  );
  if (!napmPrompt) {
    return false;
  }

  if (isStreamingPreviewMessageEvent(event)) {
    return true;
  }

  // A failed tool attempt can leave a model's English planning text as the
  // first final message. Suppress it for alert references even before a
  // remembered tool result exists; only a deterministic Chinese status or
  // verified analysis may reach the WeCom channel.
  if (
    alertPacketPrompt
    && looksLikeInternalReasoningPreview(extractTextContent(event?.content))
  ) {
    appendPluginAuditEvent('napm_alert_packet_internal_reasoning_suppressed', {
      prompt,
      conversationKey: getConversationKey(ctx) || null,
      reason: 'alert_packet_without_verified_result'
    });
    return true;
  }

  if (
    looksLikeInternalReasoningPreview(extractTextContent(event?.content))
    && (guardState?.turnNapmToolUsed || rememberedRecord)
  ) {
    return true;
  }

  return false;
}

function buildUserFacingSkillText(result) {
  const summary = isPlainObject(result?.summary) ? result.summary : {};
  const requestUrl = result?.requestUrl || summary?.requestUrl || '';
  const narrationStructure = isPlainObject(result?.narrationStructure)
    ? result.narrationStructure
    : (isPlainObject(result?.narrationInput?.result?.narrationStructure)
      ? result.narrationInput.result.narrationStructure
      : {});
  let groupListDisplayText = '';
  let metricListDisplayText = '';
  const responseType = String(result?.responseType || narrationStructure?.responseType || '').trim();
  if (result?.service === 'groups' || responseType === 'group_list') {
    const rows = Array.isArray(result?.rows)
      ? result.rows
      : (Array.isArray(result?.data) ? result.data : []);
    try {
      const narrationContractService = require(path.join(
        OPENCLAW_SKILLS_ROOT,
        'openclaw-napm-query/services/OpenClawNarrationContractService'
      ));
      if (typeof narrationContractService.buildGroupListDisplayText === 'function') {
        groupListDisplayText = narrationContractService.buildGroupListDisplayText(
          result,
          rows,
          result?.metadata?.effectiveObjectType || result?.resolvedQuery?.groups?.[0]?.type || '',
          result?.metadata || null
        );
      }
    } catch (_error) {
      groupListDisplayText = '';
    }
  }
  if (result?.service === 'metrics' || responseType === 'metric_list') {
    const rows = Array.isArray(result?.rows)
      ? result.rows
      : (Array.isArray(result?.data) ? result.data : []);
    try {
      const narrationContractService = require(path.join(
        OPENCLAW_SKILLS_ROOT,
        'openclaw-napm-query/services/OpenClawNarrationContractService'
      ));
      if (typeof narrationContractService.buildMetricListDisplayText === 'function') {
        metricListDisplayText = narrationContractService.buildMetricListDisplayText(
          result,
          rows,
          result?.metadata?.effectiveObjectType || result?.resolvedQuery?.groups?.[0]?.type || ''
        );
      }
    } catch (_error) {
      metricListDisplayText = '';
    }
  }
  const displayText = String(
    result?.displayText
    || summary?.displayText
    || result?.replyText
    || narrationStructure?.displayText
    || groupListDisplayText
    || metricListDisplayText
    || ''
  ).trim();
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

function makeToolResult(result, reportSourceId = '') {
  const displayText = buildUserFacingSkillText(result);
  return {
    content: [
      {
        type: 'text',
        text: appendReportSourceId(displayText || JSON.stringify(result, null, 2), reportSourceId)
      }
    ],
    isError: Boolean(result?.ok === false || result?.error),
    details: result,
    metadata: reportSourceId ? { reportSourceId } : undefined
  };
}

function createSkillToolDefinition() {
  const queryContract = getResolutionSpecQueryContract() || {};
  const allowedServices = getResolutionSpecServiceNames();
  const resolutionSpecService = getResolutionSpecService();
  const requiredFieldsByService = allowedServices
    .map((serviceName) => {
      const required = resolutionSpecService?.getServiceSpec
        ? resolutionSpecService.getServiceSpec(serviceName)?.required
        : null;
      return Array.isArray(required) && required.length > 0
        ? `${serviceName} requires ${required.join(', ')}`
        : '';
    })
    .filter(Boolean)
    .join('; ');
  const overviewScenes = getResolutionSpecRoutingRules()?.overviewScenes || [];
  const acceptedInputs = Array.isArray(queryContract.acceptedInputs)
    ? queryContract.acceptedInputs.join(', ')
    : 'payload.resolvedQuery';
  const timeConstructionRules = Array.isArray(queryContract.constructionRules)
    ? queryContract.constructionRules.join(' ')
    : 'Executable timestamps must be root-level start/end.';
  return {
    label: 'NAPM Skill Query',
    name: 'napm-skill-query',
    description: `Run the NAPM skill executor with a structured resolvedQuery. PRIMARY tool for: ranking/discovery (哪个XX最多/排行/TopN/排名), single-metric lookups (XX的400数量/延时/吞吐值), average/trend queries, inventory (有哪些业务/对象), and drilldown. For fault diagnosis of a SPECIFIC named object, use napm-fault-diagnosis instead. Accepted structured input channel: ${acceptedInputs}. prompt is trace-only and never constructs or repairs a query. Service contracts: ${requiredFieldsByService}. Inventory example: service=groups, queryModeKey=metadata, groups=[{type:"WebApplication"}] for 业务/业务系统 or groups=[{type:"DefinedApp"}] for 应用/已定义应用. A single-object DefinedApp/WebApplication trend or average query requires groups[0].argument with the concrete object name; missing names must be clarified. Plain 应用流量趋势/平均值 means DefinedApp, never TotalTraffic; without a concrete application name, ask the user to clarify instead of querying. Global/overall traffic trends require service=timeValues and groups=[{type:"TotalTraffic"}] without an argument. TPIO is throughput rate; BYTIO is accumulated byte traffic. Time contract: ${timeConstructionRules}`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Original user prompt retained for traceability after resolvedQuery has been constructed.' },
        userQuery: { type: 'string', description: 'Alias of prompt for traceability only; do not rely on this instead of resolvedQuery for structured NAPM queries.' },
        decision: { type: 'object', description: 'Optional structured decision object.', additionalProperties: true },
        intent: { type: 'object', description: 'Optional structured intent object.', additionalProperties: true },
        resolvedQuery: {
          type: 'object',
          description: 'Required fully resolved semantic query. For relative time, provide a concrete timeRange.key and let plugin execute materialize root-level start/end from the server clock. For fixed time, provide minute-aligned Unix-second root-level start/end and executionOptions.timeMode=fixed. prompt is never used to fill missing query fields.',
          properties: {
            service: {
              type: 'string',
              enum: allowedServices,
              description: 'Service declared by napm-resolution-spec.v1.json. Use timeValues for trends, not timeseries/trend/series.'
            },
            queryModeKey: { type: 'string' },
            metrics: { type: 'array', items: { type: 'string' } },
            metric: { type: 'string' },
            topMetric: { type: 'string' },
            groups: {
              type: 'array',
              description: 'Required and non-empty for service=groups and service=timeValues. Use TotalTraffic for global/overall traffic trends, WebApplication for 业务/业务系统, DefinedApp for 应用/已定义应用, and BusinessGroup for 业务组.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  argument: {
                    description: 'Concrete object name for single-object trend/average queries. Omit for TotalTraffic, inventory, or ranking discovery.'
                  }
                },
                additionalProperties: true
              }
            },
            topCount: { type: 'number' },
            granularity: {
              type: 'number',
              minimum: 1,
              description: 'Required for service=timeValues; interval in seconds supported by NAPM metadata.'
            },
            overviewScene: {
              type: 'string',
              enum: overviewScenes,
              description: 'Required for service=overview.'
            },
            protocolQueries: {
              type: 'array',
              description: 'Required for service=topValues_multi_protocol. Each item is a complete topValues query for one protocol.',
              items: {
                type: 'object',
                properties: {
                  service: { type: 'string', enum: ['topValues'] },
                  queryModeKey: { type: 'string', enum: ['topn'] },
                  metrics: { type: 'array', items: { type: 'string' } },
                  topMetric: { type: 'string' },
                  groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  topCount: { type: 'number' },
                  start: { type: 'number' },
                  end: { type: 'number' },
                  semanticConstraints: { type: 'object', additionalProperties: true }
                },
                additionalProperties: true
              }
            },
            filters: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'Optional structured query filters.'
            },
            executionOptions: {
              type: 'object',
              description: 'Execution controls such as timeMode and explicit repair-policy flags.',
              additionalProperties: true
            },
            start: {
              type: 'number',
              description: 'Fixed-time queries only: minute-aligned Unix timestamp in seconds. Omit for relative time.'
            },
            end: {
              type: 'number',
              description: 'Fixed-time queries only: minute-aligned Unix timestamp in seconds. Omit for relative time.'
            },
            timeRange: {
              type: 'object',
              description: 'Relative-time declaration. Set one concrete supported key such as last30minutes, last1hour, last24hours, last7days, today, or yesterday. Placeholder keys such as lastNminutes are invalid. Do not put start/end inside timeRange.',
              properties: {
                key: { type: 'string', description: 'Concrete relative key: last<number>seconds|minutes|hours|days, last1hour, today, or yesterday.' },
                displayText: { type: 'string' }
              },
              additionalProperties: false
            },
            format: { type: 'string' },
            userRequirement: { type: 'string' },
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
      required: ['resolvedQuery'],
      additionalProperties: false
    },
    execute: async (_toolCallId, args) => {
      const preparedArgs = prepareSkillExecutionArgs(args || {});
      const conversationKey = getTrustedConversationKey(preparedArgs);
      const turnId = getTrustedTurnId(preparedArgs);
      const traceId = normalizeTraceId(preparedArgs?.traceId) || buildNapmTraceId({}, preparedArgs);

      try {
        const timeResolverPath = path.join(
          OPENCLAW_SKILLS_ROOT,
          'openclaw-napm-query/src/shared/timeResolver'
        );
        const { applyTimeOverride } = require(timeResolverPath);
        applyTimeOverride(preparedArgs.resolvedQuery);
        const validation = validateResolvedQueryAgainstSpec(
          preparedArgs?.resolvedQuery,
          getResolvedQueryValidationOptions(preparedArgs)
        );
        if (isPlainObject(validation.resolvedQuery)) {
          preparedArgs.resolvedQuery = validation.resolvedQuery;
        }
        if (!validation.ok) {
          appendPluginAuditEvent('napm_plugin_tool_execute_resolved_query_blocked', {
            traceId,
            prompt: normalizePrompt(preparedArgs),
            reason: validation.reason || null,
            message: validation.message || null,
            resolvedQuery: normalizeObject(preparedArgs?.resolvedQuery) || null,
            resolvedQuerySummary: summarizeResolvedQueryForAudit(preparedArgs?.resolvedQuery)
          });
          const failureResult = buildResolvedQueryBoundaryFailureResult(validation, preparedArgs);
          const failureRecord = rememberResolvedQueryFailureForTurn(
            normalizePrompt(preparedArgs),
            validation,
            preparedArgs,
            conversationKey,
            turnId
          );
          if (failureRecord?.result) {
            return makeToolResult(failureRecord.result);
          }
          return makeToolResult(failureResult);
        }

        // before_tool_call is not guaranteed to run for every OpenClaw execution
        // path. Keep prompt/query scope validation at the tool boundary as well,
        // so a malformed application trend can never reach the southbound API.
        const semanticPrompt = normalizePrompt(preparedArgs)
          || String(preparedArgs?.resolvedQuery?.userRequirement || '').trim();
        const promptSemanticObservation = observePromptQuerySemanticMismatch(
          semanticPrompt,
          preparedArgs?.resolvedQuery
        );
        if (
          !promptSemanticObservation.ok
          && (
            getQuerySemanticGuardMode() === 'enforce'
            || promptSemanticObservation.enforce === true
          )
        ) {
          appendPluginAuditEvent('napm_plugin_tool_execute_prompt_query_semantic_mismatch_observed', {
            traceId,
            prompt: semanticPrompt,
            enforced: true,
            reason: promptSemanticObservation.reason,
            message: promptSemanticObservation.message,
            resolvedQuery: normalizeObject(preparedArgs?.resolvedQuery) || null,
            resolvedQuerySummary: summarizeResolvedQueryForAudit(preparedArgs?.resolvedQuery)
          });
          const semanticArgs = semanticPrompt && !normalizePrompt(preparedArgs)
            ? { ...preparedArgs, prompt: semanticPrompt }
            : preparedArgs;
          const failureRecord = rememberResolvedQueryFailureForTurn(
            semanticPrompt,
            promptSemanticObservation,
            semanticArgs,
            conversationKey,
            turnId
          );
          appendPluginAuditEvent('napm_plugin_tool_execute_resolved_query_blocked', {
            traceId,
            prompt: semanticPrompt,
            reason: promptSemanticObservation.reason || null,
            message: promptSemanticObservation.message || null,
            resolvedQuery: normalizeObject(preparedArgs?.resolvedQuery) || null,
            resolvedQuerySummary: summarizeResolvedQueryForAudit(preparedArgs?.resolvedQuery)
          });
          if (failureRecord?.result) {
            return makeToolResult(failureRecord.result);
          }
          return makeToolResult(buildResolvedQueryBoundaryFailureResult(
            promptSemanticObservation,
            semanticArgs
          ));
        }

        napmOperationState.clearQueryFailureForTurn(conversationKey, turnId);
        napmOperationState.clearSkillExecutionFailureForTurn(conversationKey, turnId);
        const result = await napmQuerySkill().handleSkillCall(preparedArgs);
        const debugRecord = rememberDebugApi(
          normalizePrompt(preparedArgs),
          result,
          conversationKey,
          turnId
        );
        return makeToolResult(result, debugRecord?.reportSourceId);
      } catch (error) {
        const failureResult = buildNapmSkillExecutionFailureResult(preparedArgs);
        appendPluginAuditEvent('napm_plugin_skill_execution_failed', {
          traceId,
          prompt: normalizePrompt(preparedArgs),
          errorCode: String(error?.code || 'SKILL_EXECUTION_ERROR'),
          errorMessage: String(error?.message || 'Unknown NAPM skill execution error'),
          resolvedQuerySummary: summarizeResolvedQueryForAudit(preparedArgs?.resolvedQuery)
        });
        rememberSkillExecutionFailureForTurn(
          normalizePrompt(preparedArgs),
          failureResult,
          preparedArgs,
          conversationKey,
          turnId
        );
        return makeToolResult(failureResult);
      }
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
        reportSourceId: { type: 'string', description: 'Explicit report source id returned by a report-producing NAPM tool.' },
        reportData: { type: 'object', description: 'Optional reportData from napm-skill-query. If omitted, the latest fresh NAPM skill result reportData is used.', additionalProperties: true },
        downloadBaseUrl: { type: 'string', description: 'Optional download base URL, defaults to /reports.' },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      // Build report input from remembered NAPM skill result (e.g. fault-diagnosis, summary, etc.)
      const reportInput = buildReportInputForExport(args);
      if (!reportInput.ok) {
        return {
          content: [{ type: 'text', text: reportInput.message || 'REPORT_DATA_NOT_FOUND: 未找到可导出的 NAPM 结果。请先完成一次故障分析或查询。' }],
          details: reportInput
        };
      }
      auditReportExportSourceResolved(reportInput, args);
      const result = await napmReportSkill().handleSkillCall(reportInput.reportInput);
      rememberReportExportResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        getTrustedTurnId(args)
      );
      if (result?.ok) {
        auditReportGenerated(result, reportInput, args);
      }
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
    description: 'Execute the standalone NAPM alert skill for alert summary, alert timeline, alert detail, trigger metric series, notification field explanation, packet handoff, and reportData generation. Use this for ordinary 告警, 告警事件, 告警详情, 告警时间线, 紧急告警, 重大告警, 轻微告警, alertsSummary, alertsSummaryTimeLine, alertsDetail, Email/SNMP/SysLog alert notification explanation. Combined 告警数据包 requests with eventId must use napm-alert-packet-analysis instead. This tool is read-only and must not modify alert rules.',
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
          description: 'Alert criteria. Relative queries must use timeRange.key or let the skill derive time from the canonical prompt and server clock. start/end are only for an explicit fixed-time request. detail modes require eventIds.',
          properties: {
            start: { type: 'number', description: 'Explicit fixed-time query only: Unix-second start timestamp. Omit for relative time.' },
            end: { type: 'number', description: 'Explicit fixed-time query only: Unix-second end timestamp. Omit for relative time.' },
            timeRange: {
              type: 'object',
              description: 'Relative-time declaration. Prefer a concrete key; the skill recomputes start/end from the server clock.',
              properties: {
                key: { type: 'string', description: 'Concrete key: last<number>minutes|hours|days, last1hour, today, or yesterday.' },
                displayText: { type: 'string' }
              },
              additionalProperties: false
            },
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
      const pi = result?.narrationInput?.packetInstruction;
      const handoffRecord = rememberSkillResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        'napm-alert-query',
        getTrustedTurnId(args)
      );
      const reportSourceId = handoffRecord?.reportSourceId || '';
      const renderedText = appendReportSourceId(buildAlertQueryReply(result), reportSourceId);

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
            reportSourceId: reportSourceId || null,
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

      // summary / 无数据包模式：displayText 直达用户，绕过 AI 叙述层
      // OpenClaw SDK: displayText 直接显示给用户，不经过 Bot/AI 处理
      // 防止 AI 从文本中解析数字后自行重组输出（算百分比、画 markdown 表格等）
      return buildAlertQueryToolResponse(result, renderedText, reportSourceId);
    }
  };
}

function createAlertPacketAnalysisToolDefinition() {
  return {
    label: 'NAPM Alert Packet Analysis',
    name: 'napm-alert-packet-analysis',
    description: 'Deterministic composite workflow for packet evidence around one specified NAPM alert event. Use for 告警数据包/报文/抓包 requests with either (1) eventId plus fixed start/end or (2) a cross-session GJ-XXXXXX referenceId such as “分析告警 GJ-QFH9QC4Z”. For referenceId input, the plugin restores the canonical eventId, fixed packet window, trigger metrics, and candidate data from the shared alert archive; users must not be asked to provide those internal fields. This tool owns alertsDetail retries and calls the existing packet Skill in-process. Do not call napm-alert-query, napm-packet-analysis, exec, or memory_search for this workflow.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Canonical original alert notification prompt.' },
        eventId: { type: 'string', pattern: '^\\d+$' },
        start: { type: 'number', description: 'Fixed Unix-second packet window start.' },
        end: { type: 'number', description: 'Fixed Unix-second packet window end.' },
        triggerMetrics: { type: 'object', additionalProperties: true },
        referenceId: { type: 'string', pattern: '^GJ-[A-Z2-9]{6,16}$', description: 'Cross-session alert reference restored by the plugin.' },
        candidateId: { type: 'string', pattern: '^GJ-[A-Z2-9]{6,16}-P\\d{1,3}$', description: 'Selected single packet candidate reference.' },
        packetCandidate: { type: 'object', additionalProperties: true, description: 'Trusted packet candidate restored from the alert reference store.' },
        referenceErrorCode: { type: 'string', description: 'Plugin-owned alert reference lookup error code.' },
        previewRiskAccepted: { type: 'boolean', description: 'Plugin-owned confirmation that the preview risk may proceed to download.' },
        traceId: { type: 'string', description: 'Plugin-owned trusted trace id.' }
      },
      anyOf: [
        { required: ['prompt', 'referenceId'] },
        { required: ['prompt', 'eventId', 'start', 'end'] }
      ],
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmAlertPacketSkill().handleSkillCall(args || {});
      rememberSkillResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        'napm-alert-packet-analysis',
        getTrustedTurnId(args)
      );
      return {
        content: [{ type: 'text', text: buildAlertPacketAnalysisReply(result) }],
        details: result,
        isError: Boolean(result?.ok === false || result?.error)
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
        timeRange: {
          type: 'object',
          description: 'Report time window. Use a concrete key such as last7days, last30days, last90days, last365days, currentQuarter, previousQuarter, currentYear, or previousYear. Fixed windows use mode=custom with start/end.',
          properties: {
            key: { type: 'string' },
            mode: { type: 'string', enum: ['rolling', 'calendar', 'custom'] },
            start: { type: 'number' },
            end: { type: 'number' },
            displayText: { type: 'string' },
            timezone: { type: 'string' }
          },
          additionalProperties: false
        },
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
      const handoffRecord = rememberSkillResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        'napm-inspection-snapshot',
        getTrustedTurnId(args)
      );
      const reportSourceId = handoffRecord?.reportSourceId || '';
      return {
        content: [
          {
            type: 'text',
            text: appendReportSourceId(buildInspectionSnapshotReply(result), reportSourceId)
          }
        ],
        details: result,
        metadata: reportSourceId ? { reportSourceId } : undefined
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
              description: 'Required when the request names a specific NAPM object. Omit only for an explicit dimension-overview report.',
              properties: {
                groupType: { type: 'string', description: 'NAPM group type, e.g. WebApplication, Application, BusinessGroup, IPAddress.' },
                groupArgument: { type: 'string', description: 'NAPM group argument value, e.g. 239web.' },
                groupLabel: { type: 'string', description: 'Display label for the target object.' }
              },
              required: ['groupType', 'groupArgument'],
              additionalProperties: true
            }
          },
          additionalProperties: false
        },
        timeRange: {
          type: 'object',
          description: 'Time range for the summary. key supports lastNminutes|lastNhours|lastNdays|today|yesterday. If omitted, defaults to last 24 hours.',
          properties: {
            key: { type: 'string', description: 'Relative or calendar time key. The skill resolves executable timestamps.' },
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
      const handoffRecord = rememberSkillResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        'napm-summary',
        getTrustedTurnId(args)
      );
      const reportSourceId = handoffRecord?.reportSourceId || '';
      return {
        content: [
          {
            type: 'text',
            text: appendReportSourceId(buildSummaryReply(result), reportSourceId)
          }
        ],
        details: result,
        metadata: reportSourceId ? { reportSourceId } : undefined
      };
    }
  };
}

function createFaultDiagnosisToolDefinition() {
  return {
    label: 'NAPM Fault Diagnosis',
    name: 'napm-fault-diagnosis',
    description: 'Run a standardized NAPM fault diagnosis flow for a SPECIFIC named business/application. ⚠️ DO NOT use for ranking queries (哪个XX最多/排行/TopN), single-metric lookups, or HTTP status code ranking — use napm-skill-query for those. The tool automatically detects the correct analysis type and target object from the NAPM catalog. ⚠️ You MUST pass the user ORIGINAL message in BOTH prompt and description fields — do NOT modify, shorten, or reinterpret the user request. The tool uses the exact wording for name extraction.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'MANDATORY: Copy the user EXACT original message here character-by-character. Do NOT modify, shorten, translate, or interpret. This is used for object name extraction.' },
        description: { type: 'string', description: 'MANDATORY: Same as prompt — the exact user request. The tool uses this for flow type classification.' },
        timeRange: {
          type: 'object',
          description: 'Fault time window. key supports lastNminutes|lastNhours|lastNdays|today|yesterday. If omitted, defaults to last 24 hours.',
          properties: {
            key: { type: 'string', description: 'Relative or calendar time key. The skill resolves faultWindow.' },
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
            severity: { type: 'string', enum: ['critical', 'major', 'minor'] }
          }
        },
        traceId: { type: 'string', description: 'Optional trace id for audit correlation.' }
      },
      required: ['prompt', 'description'],
      additionalProperties: false
    },
    execute: async (_toolCallId, args = {}) => {
      const result = await napmFaultDiagnosisSkill().handleSkillCall(args || {});
      const handoffRecord = rememberSkillResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        'napm-fault-diagnosis',
        getTrustedTurnId(args)
      );
      const reportSourceId = handoffRecord?.reportSourceId || '';
      return {
        content: [
          {
            type: 'text',
            text: appendReportSourceId(buildFaultDiagnosisReply(result), reportSourceId)
          }
        ],
        details: result,
        metadata: reportSourceId ? { reportSourceId } : undefined
      };
    }
  };
}

function createPacketAnalysisToolDefinition() {
  return {
    label: 'NAPM Packet Analysis',
    name: 'napm-packet-analysis',
    description: 'Execute the standalone NAPM packet skill for packet preview/download URL construction, packet preview, packet download, business page packet preview, or pcap/cap analysis. Use this for 数据包, 报文, 抓包, pcap/cap, packetsPreview, packetsDown, DownServlet, pageViews requests WHEN the target IPs are already known and the request is not tied to an alert event. Combined 告警数据包 requests with eventId must use napm-alert-packet-analysis instead. The criteria.id parameter is ONLY for linkType=2 event IDs supplied by a trusted handoff, not an arbitrary alert event ID.',
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
            id: { type: 'string', description: 'Event ID for linkType=2 packets ONLY. For a combined alert packet request, use napm-alert-packet-analysis and accept an id only from its trusted handoff.' },
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
      const handoffRecord = rememberSkillResult(
        normalizePrompt(args),
        result,
        getTrustedConversationKey(args),
        'napm-packet-analysis',
        getTrustedTurnId(args)
      );
      const reportSourceId = handoffRecord?.reportSourceId || '';
      return {
        content: [
          {
            type: 'text',
            text: appendReportSourceId(buildPacketAnalysisReply(result), reportSourceId)
          }
        ],
        details: result,
        metadata: reportSourceId ? { reportSourceId } : undefined
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

  if (isPlatformIdentityPrompt(prompt)) {
    return [
      'PLATFORM IDENTITY / CAPABILITY / GREETING REQUEST:',
      '这是允许的平台身份、能力或简短问候问题。直接依据 OpenClaw workspace 中的 IDENTITY.md 和 SOUL.md 回答。',
      '不得调用 NAPM skill 或其他工具；不得要求查询结果；不得返回天气、闲聊、泛问答的通用域外文案。',
      '纯问候应简短、自然地回应，并说明自己是观枢AI；身份或能力问题应准确说明观枢 GAIOP / NAPM、OpenClaw 智能运维助手的定位。'
    ].join('\n');
  }

  const turnPolicy = opts.turnPolicy || (prompt
    ? buildTurnPolicy({
      prompt,
      napmRelated: Boolean(opts.napmRelated) || isNapmRelatedPrompt(prompt),
      domainRelated: isSystemDomainPrompt(prompt),
      platformIdentityPrompt: false,
      outOfScopeBoundaryRequested: isSystemDomainPrompt(prompt) && isOutOfScopeNapmRequest(prompt)
    })
    : buildTurnPolicy({ domainRelated: true }));

  if (turnPolicy.route === TURN_POLICY_ROUTES.MODEL_OWNED) {
    return [
      'MODEL-OWNED NON-ACTION TURN:',
      '请使用完整会话上下文以及 workspace 中的 SOUL.md、IDENTITY.md 理解用户当前表达。',
      '身份、能力、称呼、问候、省略追问和澄清对话由模型直接自然回答，不要求命中 JavaScript 关键词。',
      '不得调用任何 Tool，不得编造 NAPM 数据；如果用户实际想查询监控数据但对象或范围不明确，只问一个关键澄清问题。',
      '若完整语义明确属于天气、娱乐或通用闲聊等非 NAPM 内容，简短说明边界并引导回系统监控问题。'
    ].join('\n');
  }

  if (turnPolicy.route === TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE) {
    return [
      'EXPLICIT OUT-OF-SCOPE NON-ACTION TURN:',
      '当前请求明确不属于系统监控、性能分析或 NAPM 范围。',
      '不得调用任何 Tool；简短说明能力边界并引导用户改问监控、性能或 NAPM 问题。'
    ].join('\n');
  }

  // Scene detection via existing classifiers (all accept prompt string)
  var isFault = false, isSummary = false, isInspection = false, isAlert = false, isPacket = false, isAlertPacket = false;
  try {
    if (prompt) {
      isFault = isFaultDiagnosisPrompt(prompt);
      isSummary = isSummaryPrompt(prompt);
      isInspection = isInspectionPrompt(prompt);
      isAlert = isAlertEventPrompt(prompt);
      isPacket = isPacketCapturePrompt(prompt);
      isAlertPacket = isAlertPacketAnalysisPrompt(prompt);
    }
  } catch (_e) { /* classifier errors → inject all rules as fallback */ }

  var isNapm = Boolean(opts.napmRelated) || (prompt && isNapmRelatedPrompt(prompt));
  // Guard: if no scene detected, default to data-query + packet scenes to cover all possibilities
  var anyScene = isFault || isSummary || isInspection || isAlert || isPacket;
  if (!anyScene) { isFault = true; isSummary = true; isAlert = true; isPacket = true; }

  var rules = [];

  // ── TOOL ROUTING TABLE (always) ──
  rules.push(
    'TOOL ROUTING — pick exactly one entry point based on user intent:',
    '  ⚠️ RANKING/DISCOVERY queries (排行/排名/TopN/哪个最多/哪些最高/谁最少) → napm-skill-query with service=topValues. These are DATA QUERIES, NOT fault diagnosis. Examples: "今天哪个业务的400报错最多？" "丢包最高的前10个IP" "HTTP 500最多的Web应用排行".',
    '  AVERAGE/MEAN queries (平均/均值) → napm-skill-query with service=averageValues, queryModeKey=average.',
    '  TREND/TIMESERIES queries (趋势/走势/变化/曲线/按时间) → napm-skill-query with service=timeValues, queryModeKey=timeseries, and granularity in seconds.',
    '  STATUS/OVERVIEW queries (情况怎么样/整体状态/概览/总览) → napm-skill-query with service=overview, queryModeKey=overview, and overviewScene.',
    '  OBJECT INVENTORY queries (有哪些对象/业务/应用) → napm-skill-query with service=groups, queryModeKey=metadata. In this deployment plain 应用 means DefinedApp (applications Type=2), while 业务/业务系统/Web应用 means WebApplication (applications Type=3).',
    '  METRIC INVENTORY queries (支持哪些指标/可查哪些指标) → napm-skill-query with service=metrics, queryModeKey=metadata.',
    '  DRILLDOWN CATALOG queries (下钻/层级/路径/目录) → napm-skill-query with service=drilldownCatalog, queryModeKey=metadata.',
    '  fault/error diagnosis for a SPECIFIC named object (分析XXweb的故障/给XX出故障诊断报告/排查XX的报错根因/XX应用慢原因分析/XX业务性能诊断) → napm-fault-diagnosis (ONLY pass description + timeRange; the tool auto-detects flowType and target from NAPM catalog) → napm-report-export',
    '  summary/overview report (综述报告/单个业务分析报告/单个应用分析报告/日报/周报/月报) → napm-summary (scope+timeRange; named target is resolved from the NAPM catalog) → napm-report-export (auto, no user prompt)',
    '  inspection report (巡检/健康检查) → napm-inspection-snapshot → napm-report-export',
    '  alert events (告警/告警摘要/告警详情/告警时间线) → napm-alert-query',
    '  packet capture/analysis (数据包/报文/抓包/pcap) → napm-packet-analysis',
    '  alert+packet combined (告警数据包 <eventId> with fixed start/end) → napm-alert-packet-analysis ONLY. The composite tool owns alertsDetail retries and packet-analysis handoff; never call napm-alert-query or napm-packet-analysis directly.',
    '  data query (排行/排名/TopN/ranking/average/trend/overview/inventory/metric-list/drilldown) → napm-skill-query',
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
    'Time: relative queries use a concrete key such as last30minutes, last1hour, last2hours, last24hours, today, or yesterday; placeholders such as lastNminutes are invalid. Plugin execute computes root start/end from the server clock. Fixed queries use minute-aligned root start/end with executionOptions.timeMode="fixed". Missing time must fail.',
    'Trend contract: service=timeValues requires a non-empty groups array. Plain 应用流量趋势/平均值 must use groups=[{type:"DefinedApp",argument:"具体应用名称"}]; if the name is missing, ask a clarification question and do not use TotalTraffic. Global/overall/total traffic trends use groups=[{type:"TotalTraffic"}]. A contextual time follow-up must submit a complete resolvedQuery; do not submit only changed time fields.',
    'Traffic semantics: 流量趋势/流量速率/吞吐/带宽 use TPIO (throughput rate). 流量/累计流量/流量大小/字节数 use BYTIO (accumulated byte traffic). TotalTraffic is the object scope, not a metric.',
    'Query construction rules → skills/openclaw-napm-query/references/query-construction.md; service and mode mapping → skills/openclaw-napm-query/references/service-modes.md.'
  );

  // ── ALERT CONTRACT (only for alert scenes) ──
  if (isAlert) {
    rules.push(
      'Alert mode: summary=list, timeline=trend, detail=by eventId, detail_with_timeseries=trigger metrics, explain_notification=field help. Read-only tool.',
      'Alert answer: output result verbatim. Do NOT add 建议关注/按严重程度/当前持续中/tables/bullet lists or any modification. Result IS the final answer.'
    );
  }

  if (isAlertPacket) {
    rules.push(
      'ALERT_PACKET_WORKFLOW_REQUIRED: call napm-alert-packet-analysis exactly once. For a GJ-xxxxxx reference, the plugin restores canonical eventId/start/end/triggerMetrics from the shared alert archive; do not invent or ask the user to repeat internal timestamps. Preserve canonical triggerMetrics. Do not add timeRange.key and do not fall back to alertsSummary.'
    );
  }

  // ── PACKET CONTRACT (only for packet scenes) ──
  if (isPacket) {
    rules.push(
      'Packet modes: build_url_only (link-only), preview_only (large ranges), preview_download_analyze (full). Business page preview: use downloadType="DownServlet"+criteria.page; never downgrade to IP-based packetsPreview when URL is provided. IP packetsPreview only when user explicitly asks 按IP.',
      'Alert-packet: napm-alert-packet-analysis ONLY. It performs alertsDetail discovery and calls packet-analysis internally. criteria.id is for linkType=2 trusted handoffs only, not arbitrary alert event IDs.',
      'Trigger cause analysis: always explain alert trigger metrics/threshold/actual value/packet correlation. Do NOT skip because alert name contains 测试.'
    );
  }

  // ── ANSWER / FOLLOW-UP RULES (always) ──
  rules.push(
    'REJECT_AND_REDIRECT → explain boundary. ASK_CLARIFYING_QUESTION → ask and stop. ANSWER_CONCEPTUALLY/INTERPRET_RESULT → answer from result.',
    'Prefer displayText/summary.displayText directly over paraphrasing.',
    'Never answer from stale memory. Base reply on fresh tool result from current turn.',
    'A valid empty query result is only evidence that the declared object, metric, and time range returned no data points. Do not speculate about collection failures, permissions, or data delay unless the result contains that failure classification.',
    'Never claim data was queried by direct API/curl/exec/python. Say: use napm-skill-query with resolvedQuery.'
  );

  // ── REPORT EXPORT (always — small) ──
  rules.push(
    'Report export: napm-skill-query→napm-report-export (new). Follow-up export (将以上导出) → napm-report-export only (no re-query). Do not auto-export for ordinary data questions.',
    'Cross-skill: fresh alert report → napm-alert-query→napm-report-export. Fresh inspection → napm-inspection-snapshot→napm-report-export.',
    'PDF not available; if requested, call napm-report-export format=pdf and report error.',
    '',
    shouldExposeUpstreamApi()
      ? 'Append "Debug API: <requestUrl>" at end of reply when present; keep credentials masked.'
      : 'Do not expose requestUrl or Debug API in normal replies, even when the tool result contains them.',
    'Boundary requests (restart/deploy/config/SQL/code) mentioning NAPM objects → reject and redirect.'
  );

  return rules.join('\n');
}

const skillTool = createSkillToolDefinition();
const reportExportTool = createReportExportToolDefinition();
const alertQueryTool = createAlertQueryToolDefinition();
const alertPacketAnalysisTool = createAlertPacketAnalysisToolDefinition();
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
      if (typeof api.on === 'function') {
        const normalizedEvents = Array.isArray(events) ? events : [events];
        for (const eventName of normalizedEvents) {
          api.on(eventName, handler, opts);
        }
        return;
      }
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
    api.registerTool(alertPacketAnalysisTool);
    api.registerTool(inspectionSnapshotTool);
    api.registerTool(summaryTool);
    api.registerTool(faultDiagnosisTool);
    api.registerTool(packetAnalysisTool);

    registerNapmHook(
      'message_received',
      (event, ctx) => {
        const conversationKey = getConversationKey(ctx);
        const content = extractTextContent(event?.content ?? event?.message?.content);
        const nativeCommand = parseOpenClawControlCommand(content);
        if (nativeCommand) {
          const resetSummary = nativeCommand.resetsSession
            ? clearNapmConversationScope(ctx)
            : null;
          rememberNativeCommandTurn(ctx, nativeCommand);
          appendPluginAuditEvent('openclaw_native_command_bypassed', {
            command: nativeCommand.name,
            resetsSession: nativeCommand.resetsSession,
            scopeHash: conversationKey ? ReportSourceStore.hashScope(conversationKey) : null,
            resetSummary
          });
          return undefined;
        }

        clearNativeCommandTurn(ctx);
        const previousState = conversationKey ? (napmConversationState.get(conversationKey) || null) : null;
        const continuationPrompt = buildAlertPacketContinuationPrompt(content, previousState);
        const effectivePrompt = continuationPrompt || content;
        const turnId = buildNapmTurnId();
        const nextState = {
          ...buildConversationScopedGuardState(effectivePrompt, previousState),
          conversationKey: conversationKey || null,
          promptKey: normalizePromptKey(effectivePrompt),
          canonicalPrompt: effectivePrompt,
          userPrompt: content,
          alertPacketContinuationPrompt: Boolean(continuationPrompt),
          alertPacketPreviewRiskAccepted: Boolean(continuationPrompt),
          alertPacketReferenceId: continuationPrompt
            ? (extractAlertReference(continuationPrompt)?.referenceId || previousState?.alertPacketReferenceId || null)
            : (previousState?.alertPacketReferenceId || extractAlertReference(effectivePrompt)?.referenceId || null),
          alertPacketCandidateId: continuationPrompt
            ? (extractAlertReference(continuationPrompt)?.candidateId || previousState?.alertPacketCandidateId || null)
            : (previousState?.alertPacketCandidateId || extractAlertReference(effectivePrompt)?.candidateId || null),
          turnId,
          contextTurnKey: getContextTurnKey(ctx) || null
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
        if (isNativeCommandTurn(ctx)) {
          return undefined;
        }

        const receivedPrompt = typeof event?.prompt === 'string' ? event.prompt.trim() : '';
        const guardKeys = getGuardKeys(ctx);
        const conversationKey = getConversationKey(ctx);
        const previousConversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const contextTurnKey = getContextTurnKey(ctx);
        // message_received is the authoritative turn boundary. Prompt-build hooks
        // may expose different run/message ids and must never replace its identity.
        const previousPrompt = String(
          previousConversationState?.canonicalPrompt || previousConversationState?.prompt || ''
        ).trim();
        const canReuseTurn = Boolean(previousConversationState?.turnId);
        const prompt = canReuseTurn
          ? (previousPrompt || receivedPrompt)
          : receivedPrompt;
        const turnId = canReuseTurn
          ? normalizeTurnId(previousConversationState.turnId)
          : buildNapmTurnId();
        let conversationState = canReuseTurn ? previousConversationState : null;
        if (!conversationState && isMeaningfulText(prompt)) {
          conversationState = {
            ...buildConversationScopedGuardState(prompt, previousConversationState),
            conversationKey: conversationKey || null,
            promptKey: normalizePromptKey(prompt),
            canonicalPrompt: prompt,
            turnId,
            contextTurnKey: contextTurnKey || null
          };
          if (conversationKey) {
            napmConversationState.set(conversationKey, conversationState);
          }
        }
        if (guardKeys.length > 0) {
          const previousGuardState = getGuardState(ctx);
          const guardState = {
            ...(conversationState || buildConversationScopedGuardState(prompt, previousConversationState)),
            prompt,
            canonicalPrompt: prompt,
            conversationKey: conversationKey || null,
            turnId,
            turnNapmToolUsed: Boolean(
              previousGuardState?.turnId === turnId
              && previousGuardState?.turnNapmToolUsed
            ),
            updatedAt: Date.now()
          };
          setGuardState(ctx, guardState);
          api.logger.info(`[napm-openclaw-plugin] stored guard state keys=${guardKeys.join(',')} route=${getTurnPolicyRoute(guardState)} generalOutOfScope=${guardState.generalOutOfScopeRequested} outOfScopeBoundary=${guardState.outOfScopeBoundaryRequested} platformIdentity=${guardState.platformIdentityPrompt} napmRelated=${guardState.napmRelated}`);
        }
        if (prompt) {
          api.logger.info(`[napm-openclaw-plugin] injecting NAPM routing policy for prompt: ${prompt.slice(0, 120)}`);
        }
        return {
          appendSystemContext: buildNapmRoutingSystemContext({
            prompt,
            napmRelated: Boolean(conversationState?.napmRelated),
            turnPolicy: conversationState?.turnPolicy
          })
        };
      },
      {
        name: 'napm-routing-policy',
        description: 'Force NAPM-related and monitored-object requests to pass through napm-skill-query before system-operation tools.'
      }
    );

    registerNapmHook(
      'reply_dispatch',
      async (event, hookCtx) => {
        if (event?.isTailDispatch || event?.suppressUserDelivery || event?.sendPolicy === 'deny') {
          return undefined;
        }

        const messageCtx = buildReplyDispatchMessageContext(event);
        if (isNativeCommandTurn(messageCtx)) {
          return undefined;
        }
        const conversationKey = getConversationKey(messageCtx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const prompt = getReplyDispatchPrompt(event, conversationState);
        if (!prompt) {
          return undefined;
        }

        const turnId = getActiveTurnId(conversationState, null);
        const reportIntent = classifyReportPrompt(prompt);
        const alertRecord = getRememberedAlertRecordForPrompt(
          prompt,
          conversationState,
          conversationKey,
          null
        );
        if (
          !isSummaryPrompt(prompt)
          && !isReportExportPrompt(prompt)
          && !isAlertPacketAnalysisPrompt(prompt)
          && isCurrentAlertQueryResultRecord(alertRecord, turnId)
        ) {
          return dispatchAlertReplyPayload(
            alertRecord,
            event,
            hookCtx,
            conversationKey,
            turnId
          );
        }

        const deliveryFollowUp = isResultDeliveryFollowUpPrompt(prompt, conversationState);
        if (deliveryFollowUp) {
          const recentReport = getRecentReportExportResult(conversationKey)?.result || null;
          if (recentReport?.ok && recentReport.filePath) {
            appendPluginAuditEvent('napm_report_followup_replayed', {
              conversationKey: conversationKey || null,
              turnId: turnId || null,
              reportId: recentReport.reportId || null,
              mediaUrl: recentReport.filePath
            });
            return dispatchReportReplyPayload({
              content: buildReportExportReply(recentReport),
              mediaUrl: recentReport.filePath
            }, event, hookCtx, 'napm_report_followup_reply_dispatched', {
              conversationKey,
              turnId,
              reportKind: REPORT_INTENTS.EXPORT
            });
          }
        }

        if (!isAutomaticReportIntent(reportIntent)) {
          return undefined;
        }

        const freshReport = getFreshReportExportResult(conversationKey, turnId)?.result || null;
        if (freshReport?.ok && freshReport.filePath) {
          return dispatchReportReplyPayload({
            content: buildReportExportReply(freshReport),
            mediaUrl: freshReport.filePath
          }, event, hookCtx, 'napm_report_current_turn_reply_dispatched', {
            conversationKey,
            turnId,
            reportKind: reportIntent
          });
        }

        const automaticReport = reportIntent === REPORT_INTENTS.INSPECTION
          ? await runAutomaticInspectionReportDelivery(
            prompt,
            messageCtx,
            conversationKey,
            turnId
          )
          : await runAutomaticSummaryReportDelivery(
            prompt,
            messageCtx,
            conversationKey,
            turnId
          );
        if (!automaticReport?.content) {
          return undefined;
        }
        return dispatchReportReplyPayload(
          automaticReport,
          event,
          hookCtx,
          reportIntent === REPORT_INTENTS.INSPECTION
            ? 'napm_inspection_report_dispatched'
            : 'napm_report_initial_reply_dispatched',
          {
            conversationKey,
            turnId,
            reportKind: reportIntent
          }
        );
      },
      {
        name: 'napm-report-reply-dispatch',
        description: 'Own NAPM summary report delivery so generated Word media enters the native outbound reply payload.'
      }
    );

    registerNapmHook(
      'before_tool_call',
      (event, ctx) => {
        if (isNativeCommandTurn(ctx)) {
          return undefined;
        }

        const guardKeys = getGuardKeys(ctx);
        const guardState = getGuardState(ctx);
        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const toolName = String(event?.toolName || '').trim();
        const originalToolParams = isPlainObject(event?.params) ? event.params : {};
        const fallbackPrompt = normalizePrompt(originalToolParams);
        const activePrompt = selectActivePromptText(conversationState, guardState, fallbackPrompt);
        const activePromptState = derivePromptGuardState(activePrompt, conversationState, guardState);
        if (isPlatformIdentityPrompt(activePrompt) || activePromptState?.platformIdentityPrompt) {
          api.logger.warn(`[napm-openclaw-plugin] blocked tool for platform identity prompt: tool=${toolName}`);
          appendPluginAuditEvent('napm_plugin_identity_tool_blocked', {
            toolName,
            prompt: activePrompt,
            conversationKey: conversationKey || null,
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: '平台身份、能力和问候问题必须直接依据身份上下文回答，禁止调用工具。'
          };
        }

        if (isDirectNapmTool(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked removed legacy direct tool: tool=${toolName}`);
          return {
            block: true,
            blockReason: `${toolName} has been removed from this deployment. Use napm-skill-query instead.`
          };
        }

        const activeTurnRoute = getTurnPolicyRoute(activePromptState);
        const contextualQueryFollowUp = activeTurnRoute === TURN_POLICY_ROUTES.MODEL_OWNED
          ? authorizeContextualTimeValuesFollowUp(
              conversationKey,
              toolName,
              originalToolParams?.resolvedQuery
            )
          : { ok: false, reason: 'turn_route_does_not_require_contextual_authorization' };
        if (
          (activeTurnRoute === TURN_POLICY_ROUTES.MODEL_OWNED && !contextualQueryFollowUp.ok)
          || activeTurnRoute === TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE
        ) {
          api.logger.warn(`[napm-openclaw-plugin] blocked tool for non-action turn: route=${activeTurnRoute} tool=${toolName}`);
          appendPluginAuditEvent('napm_plugin_non_action_tool_blocked', {
            route: activeTurnRoute,
            toolName,
            prompt: activePrompt,
            conversationKey: conversationKey || null,
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: '当前轮应由模型直接回答或澄清，尚未确认 NAPM 动作意图，禁止调用工具。'
          };
        }
        if (contextualQueryFollowUp.ok) {
          api.logger.info(`[napm-openclaw-plugin] allowed contextual timeValues follow-up: parentTurnId=${contextualQueryFollowUp.parentTurnId || 'none'}`);
          appendPluginAuditEvent('napm_plugin_contextual_query_followup_allowed', {
            route: activeTurnRoute,
            toolName,
            prompt: activePrompt,
            conversationKey: conversationKey || null,
            parentTurnId: contextualQueryFollowUp.parentTurnId,
            currentGroupsMissing: contextualQueryFollowUp.currentGroupsMissing,
            previousResolvedQuerySummary: summarizeResolvedQueryForAudit(
              contextualQueryFollowUp.previousResolvedQuery
            ),
            currentResolvedQuerySummary: summarizeResolvedQueryForAudit(
              originalToolParams?.resolvedQuery
            ),
            context: buildAuditContextSnapshot(ctx)
          });
        }

        const trustedTraceId = isSafeNapmToolName(toolName)
          ? bindTrustedToolContext(event, ctx)
          : '';
        let toolParams = trustedTraceId
          ? { ...originalToolParams, traceId: trustedTraceId }
          : originalToolParams;
        api.logger.info(`[napm-openclaw-plugin] before_tool_call tool=${toolName} keys=${guardKeys.join(',') || 'none'} guard=${guardState ? 'hit' : 'miss'}`);

        if (toolName === 'napm-alert-query' && activePrompt) {
          toolParams = buildCanonicalSkillToolParams(activePrompt, toolParams);
        }
        if (toolName === 'napm-alert-packet-analysis' && activePrompt) {
          toolParams = buildCanonicalAlertPacketToolParams(activePrompt, toolParams);
          if (activePromptState?.alertPacketPreviewRiskAccepted) {
            toolParams = {
              ...toolParams,
              previewRiskAccepted: true
            };
          }
        }
        if (toolName === 'napm-inspection-snapshot' && activePrompt) {
          const resolver = getNapmResolvedQueryResolverService();
          let inferredTimeRange = null;
          try {
            const resolved = resolver?.resolveTimeRange?.(activePrompt);
            if (resolved?.key) {
              inferredTimeRange = {
                key: resolved.key,
                displayText: resolved.displayText || activePrompt
              };
            }
          } catch (_error) {
            inferredTimeRange = null;
          }
          toolParams = {
            ...toolParams,
            prompt: activePrompt,
            ...(toolParams.timeRange || !inferredTimeRange ? {} : { timeRange: inferredTimeRange })
          };
        }
        const trustedParamsResult = (trustedTraceId || toolParams !== originalToolParams)
          ? { params: toolParams }
          : undefined;
        if (isReportExportPrompt(activePrompt) && isReportGenerationBypassTool(toolName)) {
          api.logger.warn(`[napm-openclaw-plugin] blocked report generation bypass: tool=${toolName}`);
          appendPluginAuditEvent('napm_report_generation_bypass_blocked', {
            toolName,
            prompt: activePrompt,
            conversationKey: conversationKey || null,
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: '报告请求必须使用 napm-report-export；禁止通过 exec、write、shell 或脚本直接生成报告文件。'
          };
        }

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
            || contextualQueryFollowUp.ok
          );
        const activePacketPrompt = Boolean(activePrompt) && isPacketCapturePrompt(activePrompt);
        const activeAlertPrompt = Boolean(activePrompt) && (
          isAlertEventPrompt(activePrompt)
          || isAlertSkillMetaFollowUpPrompt(activePrompt, activePromptState)
          || Boolean(activePromptState?.alertRelated)
        );
        const activeAlertPacketPrompt = Boolean(activePrompt) && isAlertPacketAnalysisPrompt(activePrompt);
        const activeReportIntent = classifyReportPrompt(activePrompt);
        const activeInspectionPrompt = activeReportIntent === REPORT_INTENTS.INSPECTION;
        const activeSummaryPrompt = activeReportIntent === REPORT_INTENTS.SUMMARY;

        if (activeAlertPacketPrompt && toolName !== 'napm-alert-packet-analysis') {
          api.logger.warn(`[napm-openclaw-plugin] blocked non-composite tool for alert packet workflow: tool=${toolName}`);
          appendPluginAuditEvent('napm_plugin_alert_packet_wrong_tool_blocked', {
            toolName,
            prompt: activePrompt,
            expectedTool: 'napm-alert-packet-analysis',
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: 'ALERT_PACKET_WORKFLOW_REQUIRED: 该请求必须使用 napm-alert-packet-analysis；禁止降级为告警汇总、跳过 eventId 详情定位或由模型直接调用数据包工具。'
          };
        }

        if (activeAlertPacketPrompt && toolName === 'napm-alert-packet-analysis') {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          return { params: toolParams };
        }

        // A named business/application analysis report is the summary workflow.
        // Prevent model retries through fault diagnosis or another NAPM entry
        // point; reply_dispatch owns the deterministic summary -> export chain.
        if (
          activeSummaryPrompt
          && isSafeNapmToolName(toolName)
          && !['napm-summary', 'napm-report-export'].includes(toolName)
        ) {
          api.logger.warn(`[napm-openclaw-plugin] blocked wrong tool for summary prompt: tool=${toolName}`);
          appendPluginAuditEvent('napm_plugin_summary_prompt_wrong_tool_blocked', {
            toolName,
            prompt: activePrompt,
            expectedTool: 'napm-summary',
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: 'Summary/overview report requests, including single-object business/application analysis reports, must use napm-summary followed by napm-report-export.'
          };
        }

        // ── Fault diagnosis guard (MUST be first) ──
        // 2026-07-14: 当 prompt 明确是"告警数据包"请求时（activeAlertPacketPrompt=true），
        // 不触发故障诊断拦截。否则所有包含"用户体验时间"的深入分析都会被导向 fault-diagnosis。
        const hasResolvedFaultTarget = Array.isArray(event.params?.resolvedQuery?.groups)
          && event.params.resolvedQuery.groups.some((group) => (
            group?.argument != null && String(group.argument).trim().length > 0
          ));
        const activeFaultDiagnosisPrompt = Boolean(activePrompt) && isFaultDiagnosisPrompt(activePrompt, {
          hasExplicitTarget: hasResolvedFaultTarget
        });
        if ((toolName === 'napm-skill-query' || toolName === 'napm-alert-query') && activeFaultDiagnosisPrompt && !activeAlertPacketPrompt) {

          // ── 2026-07-16: 排行/统计类查询兜底放行 ──
          // 即使 isFaultDiagnosisPrompt 误判，如果 LLM 构造的 resolvedQuery 是全局排行
          // （topValues + topn + 无具体对象名），说明 LLM 正确理解了这是排行查询，应该放行。
          // 这打破了"isFaultDiagnosisPrompt 误判 → query 被 block → 只能走 fault-diagnosis"的死循环。
          var rq = isPlainObject(event.params?.resolvedQuery) ? event.params.resolvedQuery : null;
          var isGlobalRanking = rq
            && rq.service === 'topValues'
            && rq.queryModeKey === 'topn'
            && Array.isArray(rq.groups)
            && !rq.groups.some(function(g) { return typeof g.argument === 'string' && g.argument.length > 0; });

          if (isGlobalRanking) {
            // 全局排行查询 → 放行，这是 query 的职责，不是 fault diagnosis
            api.logger.info(`[napm-openclaw-plugin] ALLOWED napm-skill-query for global ranking: ${activePrompt.slice(0, 120)}`);
            appendPluginAuditEvent('napm_plugin_fault_dx_ranking_allowed', { toolName: toolName, prompt: activePrompt });
            // 不 block，继续后续逻辑
          } else {
            // 针对性诊断 → 仍然拦截
            api.logger.warn(`[napm-openclaw-plugin] BLOCKED ${toolName} for fault-diagnosis prompt: ${activePrompt.slice(0, 120)}`);
            appendPluginAuditEvent('napm_plugin_fault_dx_wrong_tool_blocked', { toolName: toolName, prompt: activePrompt, context: buildAuditContextSnapshot(ctx) });
            return { block: true, blockReason: `FAULT DIAGNOSIS REQUIRED: This is a fault/error analysis request for a specific target. Do NOT use ${toolName}. Instead, call napm-fault-diagnosis with description + timeRange only. The tool auto-detects whether to use business fault analysis (bs_app_slow) or application fault analysis (cs_app_slow) based on the NAPM catalog. DO NOT pass flowType — let the tool decide.` };
          }
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
          return trustedParamsResult;
        }

        if (
          activeInspectionPrompt
          && isSafeNapmToolName(toolName)
          && !['napm-inspection-snapshot', 'napm-report-export'].includes(toolName)
        ) {
          api.logger.warn(`[napm-openclaw-plugin] blocked wrong tool for inspection prompt: tool=${toolName}`);
          appendPluginAuditEvent('napm_plugin_inspection_prompt_wrong_tool_blocked', {
            toolName,
            prompt: activePrompt,
            expectedTool: 'napm-inspection-snapshot',
            context: buildAuditContextSnapshot(ctx)
          });
          return {
            block: true,
            blockReason: 'Inspection report requests must use napm-inspection-snapshot followed by napm-report-export. Do not use napm-summary or napm-skill-query.'
          };
        }

        if (toolName === 'napm-inspection-snapshot' && activeInspectionPrompt) {
          setGuardState(ctx, {
            ...activePromptState,
            turnNapmToolUsed: true,
            updatedAt: Date.now()
          });
          return trustedParamsResult;
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
          return trustedParamsResult;
        }

        // Packet prompts belong to the packet-analysis skill and must not enter metric-query execution.
        if (toolName === 'napm-skill-query' && activeNapmPrompt && activePrompt && !activePacketPrompt) {
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
          const semanticGuardMode = getQuerySemanticGuardMode();
          const resolvedQueryValidation = validateResolvedQueryAgainstSpec(
            canonicalSkillParams?.resolvedQuery,
            { phase: 'construction' }
          );
          if (isPlainObject(resolvedQueryValidation.resolvedQuery)) {
            canonicalSkillParams.resolvedQuery = resolvedQueryValidation.resolvedQuery;
          }
          const promptLooksStructuredMetaRequest = Boolean(
            isMetricInventoryPrompt(activePrompt)
            || isObjectInventoryPrompt(activePrompt)
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
            semanticGuardMode,
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
          const promptSemanticObservation = observePromptQuerySemanticMismatch(
            activePrompt,
            canonicalSkillParams?.resolvedQuery
          );
          if (!promptSemanticObservation.ok) {
            api.logger.warn(`[napm-openclaw-plugin] observed prompt/query semantic mismatch: mode=${semanticGuardMode} reason=${promptSemanticObservation.reason} prompt=${activePrompt.slice(0, 120)}`);
            appendPluginAuditEvent('napm_plugin_prompt_query_semantic_mismatch_observed', {
              traceId,
              toolName,
              prompt: activePrompt,
              boundaryMode,
              semanticGuardMode,
              enforced: semanticGuardMode === 'enforce' || promptSemanticObservation.enforce === true,
              reason: promptSemanticObservation.reason,
              message: promptSemanticObservation.message,
              resolvedQuery: normalizeObject(canonicalSkillParams.resolvedQuery) || null,
              resolvedQuerySummary: summarizeResolvedQueryForAudit(canonicalSkillParams.resolvedQuery),
              context: buildAuditContextSnapshot(ctx)
            });
            if (semanticGuardMode === 'enforce' || promptSemanticObservation.enforce === true) {
              const failureRecord = rememberResolvedQueryBoundaryFailureForTurn(
                activePrompt,
                promptSemanticObservation,
                canonicalSkillParams,
                conversationKey,
                conversationState,
                guardState
              );
              return {
                block: true,
                blockReason: buildResolvedQueryFailureBlockReason(promptSemanticObservation, failureRecord)
              };
            }
          }
          if (!resolvedQueryValidation.ok) {
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
            const failureRecord = rememberResolvedQueryBoundaryFailureForTurn(
              activePrompt,
              resolvedQueryValidation,
              canonicalSkillParams,
              conversationKey,
              conversationState,
              guardState
            );
            return {
              block: true,
              blockReason: buildResolvedQueryFailureBlockReason(resolvedQueryValidation, failureRecord)
            };
          }
          const clearedValidationFailure = clearResolvedQueryFailureForTurn(
            conversationKey,
            conversationState,
            guardState
          );
          const activeTurnId = getActiveTurnId(conversationState, guardState);
          const clearedExecutionFailure = napmOperationState.clearSkillExecutionFailureForTurn(
            conversationKey,
            activeTurnId
          );
          if (clearedValidationFailure || clearedExecutionFailure) {
            appendPluginAuditEvent('napm_plugin_prior_query_failure_superseded', {
              traceId,
              toolName,
              prompt: activePrompt,
              turnId: activeTurnId || null,
              clearedValidationFailure: Boolean(clearedValidationFailure),
              clearedExecutionFailure: Boolean(clearedExecutionFailure)
            });
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

        // ── Packet prompt: block exec/bash/curl bypass ──────────────────
        // 当 AI 尝试用 shell 工具直接 curl NAPM 包接口时强制拦截，
        // 防止绕过 napm-packet-analysis skill（skill 会正确读取 .env 中的密码和 TLS 配置）。
        // 2026-07-14: 实测 AI 用 bash+curl+硬编码错误密码绕过 skill，导致 403 + 无分析。
        if (activePacketPrompt && isDangerousSystemTool(toolName)) {
          const paramsStr = JSON.stringify(toolParams).toLowerCase();
          const hasNapmPacketUrl = /101\.254\.114\.238/.test(paramsStr)
            && /(packetspreview|packetsdown|downservlet)/i.test(paramsStr);
          const hasCurlToNapm = /curl|wget/.test(paramsStr)
            && /101\.254\.114\.238/.test(paramsStr)
            && /(netinside|webservice)/i.test(paramsStr);
          if (hasNapmPacketUrl || hasCurlToNapm) {
            api.logger.warn(`[napm-openclaw-plugin] BLOCKED exec/curl bypass for packet prompt: tool=${toolName}`);
            appendPluginAuditEvent('napm_plugin_packet_exec_curl_blocked', {
              toolName,
              prompt: activePrompt,
              context: buildAuditContextSnapshot(ctx)
            });
            return {
              block: true,
              blockReason: 'Packet capture/download/analysis MUST use napm-packet-analysis skill, NOT shell/exec/curl. The skill handles TLS certificates, reads credentials from .env, and runs tshark for analysis. Direct curl will fail with wrong passwords or TLS errors.'
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
          return trustedParamsResult;
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
        if (isNativeCommandTurn(ctx)) {
          return undefined;
        }

        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        const guardState = getGuardState(ctx);
        const turnId = getActiveTurnId(conversationState, guardState);
        const activePromptForReport = selectActivePromptText(conversationState, guardState, extractTextContent(event?.content));
        const activeReportIntent = classifyReportPrompt(activePromptForReport);
        const resultDeliveryFollowUp = isResultDeliveryFollowUpPrompt(activePromptForReport, guardState || conversationState);
        const progressOutput = assistantOutputLedger.consumeProgressDelivery({
          scope: conversationKey,
          turnId,
          text: extractTextContent(event?.content)
        });
        if (progressOutput) {
          appendPluginAuditEvent('tool_progress_delivery_suppressed', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            outputId: progressOutput.outputId,
            assistantMessageIndex: progressOutput.assistantMessageIndex,
            stopReason: progressOutput.stopReason,
            hasToolCall: progressOutput.hasToolCall,
            fingerprint: progressOutput.fingerprint,
            contentLength: progressOutput.textLength
          });
          return { cancel: true };
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

        const alertScopedPrompt = Boolean(
          isAlertEventPrompt(activePromptForReport)
          || isAlertSkillMetaFollowUpPrompt(activePromptForReport, guardState || conversationState)
          || guardState?.alertRelated
          || conversationState?.alertRelated
        );
        const rememberedRecord = alertScopedPrompt
          ? getRememberedAlertRecordForPrompt(activePromptForReport, conversationState, conversationKey, guardState)
          : getRememberedRecordForPrompt(activePromptForReport, conversationState, conversationKey, guardState);
        const currentAlertResult = isCurrentAlertQueryResultRecord(rememberedRecord, turnId);
        const recentReportReply = resultDeliveryFollowUp
          ? buildRecentReportExportReply(conversationKey)
          : '';
        if (recentReportReply) {
          const recentReport = getRecentReportExportResult(conversationKey)?.result || {};
          appendPluginAuditEvent('napm_report_followup_replayed', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            reportId: recentReport.reportId || null,
            mediaUrl: recentReport.filePath || null
          });
          return {
            content: recentReportReply,
            mediaUrl: recentReport.filePath || undefined,
            mediaUrls: recentReport.filePath ? [recentReport.filePath] : undefined
          };
        }
        const freshReportReply = buildFreshReportExportReply(conversationKey, turnId);
        if (isReportExportPrompt(activePromptForReport) && freshReportReply) {
          return { content: freshReportReply };
        }
        if (
          isAutomaticReportIntent(activeReportIntent)
          && !freshReportReply
          && !isStreamingPreviewMessageEvent(event)
        ) {
          const automaticReport = activeReportIntent === REPORT_INTENTS.INSPECTION
            ? await runAutomaticInspectionReportDelivery(
              activePromptForReport,
              ctx,
              conversationKey,
              turnId
            )
            : await runAutomaticSummaryReportDelivery(
              activePromptForReport,
              ctx,
              conversationKey,
              turnId
            );
          if (automaticReport?.content) {
            return automaticReport;
          }
        }
        if (
          isAlertPacketAnalysisPrompt(activePromptForReport)
          && isAlertPacketSkillResultRecord(rememberedRecord)
          && isSkillResultRecordForTurn(rememberedRecord, turnId)
        ) {
          let preparedFinal = napmOperationState.getPreparedFinalContent(conversationKey, turnId);
          if (!preparedFinal) {
            preparedFinal = napmOperationState.prepareFinalContent({
              scope: conversationKey,
              turnId,
              content: buildAlertPacketFinalReply(rememberedRecord.result),
              source: 'deterministic_fallback',
              workflowState: rememberedRecord.result.workflowState
            });
            appendPluginAuditEvent('napm_plugin_alert_packet_fallback_prepared', {
              conversationKey: conversationKey || null,
              turnId: turnId || null,
              workflowState: rememberedRecord.result.workflowState || null,
              fingerprint: preparedFinal?.fingerprint || null
            });
          }
          if (!preparedFinal || !napmOperationState.claimPreparedFinalDelivery(conversationKey, turnId)) {
            appendPluginAuditEvent('napm_plugin_duplicate_alert_packet_delivery_suppressed', {
              conversationKey: conversationKey || null,
              turnId: turnId || null,
              workflowState: rememberedRecord.result.workflowState || null
            });
            return { cancel: true };
          }
          appendPluginAuditEvent('napm_plugin_alert_packet_final_delivery_claimed', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            workflowState: rememberedRecord.result.workflowState || null,
            source: preparedFinal.source,
            fingerprint: preparedFinal.fingerprint
          });
          return { content: preparedFinal.content };
        }
        if (shouldCancelNapmPreviewMessage(event, ctx, activePromptForReport, guardState, rememberedRecord)) {
          api.logger.warn('[napm-openclaw-plugin] canceled NAPM preview before output rewriting');
          return { cancel: true };
        }
        if (
          !shouldAllowNapmReasoningPreviewForCtx(ctx)
          && (
            rememberedRecord?.recordType === 'query_validation_failure'
            || rememberedRecord?.recordType === 'skill_execution_failure'
          )
        ) {
          return buildFallbackSendingResult(
            buildRememberedSkillReplyText(rememberedRecord),
            conversationKey,
            conversationState,
            guardState
          );
        }
        if (
          currentAlertResult
          && getTurnPolicyRoute(guardState || conversationState) === TURN_POLICY_ROUTES.MODEL_OWNED
          && !isStreamingPreviewMessageEvent(event)
        ) {
          const content = buildAlertQueryReply(rememberedRecord.result);
          appendPluginAuditEvent('napm_alert_deterministic_final_delivery', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            sourceTool: rememberedRecord.sourceTool,
            contentLength: content.length,
            hook: 'message_sending'
          });
          return { content };
        }
        const reportArtifactUrls = getReportArtifactUrlsFromOutgoingEvent(event);
        if (reportArtifactUrls.length > 0 && !isReportExportPrompt(activePromptForReport)) {
          appendPluginAuditEvent('napm_stale_report_media_suppressed', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            prompt: activePromptForReport || null,
            mediaUrls: reportArtifactUrls,
            reason: 'non_report_turn_must_not_inherit_previous_report_media'
          });
          return extractTextContent(event?.content)
            ? { mediaUrls: [], mediaUrl: null }
            : { cancel: true };
        }
        if (isReportExportPrompt(activePromptForReport) && reportArtifactUrls.length > 0) {
          const illegalUrls = reportArtifactUrls.filter((url) => !isAllowedReportArtifactUrl(url, conversationKey));
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
        const activeTurnRoute = getTurnPolicyRoute(guardState || conversationState);
        const outOfScopeBoundaryRequested = Boolean(
          conversationState?.outOfScopeBoundaryRequested
          || guardState?.outOfScopeBoundaryRequested
        );
        if (
          activeTurnRoute === TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE
          || generalOutOfScopeRequested
        ) {
          return {
            content: buildGeneralOutOfScopeReply()
          };
        }

        if (activeTurnRoute === TURN_POLICY_ROUTES.MODEL_OWNED) {
          return undefined;
        }

        if (!outOfScopeBoundaryRequested) {
          const activePrompt = activePromptForReport;
          const requiresSkillBackedReply = shouldRequireSkillBackedReply(activePrompt, guardState, rememberedRecord);
          if (shouldAllowNapmReasoningPreviewForCtx(ctx) && isStreamingPreviewMessageEvent(event)) {
            return undefined;
          }
          if (
            isMetricInventoryPrompt(activePrompt)
            && isMetricInventoryResultRecord(rememberedRecord)
            && isSkillResultRecordForTurn(rememberedRecord, turnId)
          ) {
            // Metric identifiers, labels, and units are source data. Keep the
            // model from silently changing them while narrating the result.
            return {
              content: buildRememberedSkillReplyText(rememberedRecord)
            };
          }
          const leakedReasoningText = extractTextContent(event?.content);
          if (isReportExportPrompt(activePrompt) && textClaimsReportGenerated(leakedReasoningText) && !isFreshReportExportResult(conversationKey)) {
            appendPluginAuditEvent('napm_report_direct_claim_blocked', {
              conversationKey: conversationKey || null,
              prompt: activePrompt,
              reason: 'missing_fresh_napm_report_export_result'
            });
            return {
              content: buildReportExportRequiredReply()
            };
          }
          if (
            isObjectInventoryPrompt(activePrompt)
            || isResultDeliveryFollowUpPrompt(activePrompt, guardState || conversationState)
          ) {
            const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
            if (rememberedReplyText) {
              return {
                content: rememberedReplyText
              };
            }
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
          if (
            isBusinessInventoryGuardScope(activePrompt, rememberedRecord)
            && looksLikeInvalidBusinessInventoryAnswer(leakedReasoningText)
          ) {
            const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
            return rememberedReplyText
              ? { content: rememberedReplyText }
              : buildFallbackSendingResult(
                buildSkillRequiredReplyForPrompt(activePrompt),
                conversationKey,
                conversationState,
                guardState
              );
          }
          if (
            isBusinessInventoryGuardScope(activePrompt, rememberedRecord)
            && looksLikeUnsupportedBusinessInventoryExplanation(leakedReasoningText)
          ) {
            return {
              content: buildBusinessInventoryCorrectedReply(rememberedRecord)
            };
          }
          if (isHierarchyCatalogPrompt(activePrompt) && looksLikeManualHierarchyInferenceText(leakedReasoningText)) {
            const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
            return rememberedReplyText
              ? { content: rememberedReplyText }
              : buildFallbackSendingResult(
                buildHierarchySkillRequiredReply(),
                conversationKey,
                conversationState,
                guardState
              );
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
            return buildFallbackSendingResult(
              buildSkillRequiredReplyForPrompt(activePrompt),
              conversationKey,
              conversationState,
              guardState
            );
          }
          if (requiresSkillBackedReply && !rememberedRecord) {
            if (isStreamingPreviewMessageEvent(event)) {
              return {
                cancel: true
              };
            }
            return buildFallbackSendingResult(
              buildSkillRequiredReplyForPrompt(activePrompt),
              conversationKey,
              conversationState,
              guardState
            );
          }
          if (shouldForceSkillRecordForPrompt(activePrompt, guardState) && !rememberedRecord) {
            return buildFallbackSendingResult(
              buildSkillRequiredReplyForPrompt(activePrompt),
              conversationKey,
              conversationState,
              guardState
            );
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
        if (isNativeCommandTurn(ctx)) {
          return undefined;
        }

        const message = event?.message;
        const role = String(message?.role || '').trim();
        if (role !== 'assistant') {
          return undefined;
        }
        if (messageContainsToolCall(message)) {
          const conversationKey = getConversationKey(ctx);
          const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
          const guardState = getGuardState(ctx);
          const turnId = getActiveTurnId(conversationState, guardState);
          const visibleText = extractMessageText(message);
          const outputRecord = visibleText
            ? assistantOutputLedger.recordToolProgress({
                scope: conversationKey,
                turnId,
                text: visibleText,
                stopReason: message?.stopReason || event?.stopReason || message?.metadata?.stopReason,
                assistantMessageIndex: Number.isInteger(event?.assistantMessageIndex)
                  ? event.assistantMessageIndex
                  : null,
                providerPhase: message?.metadata?.phase || event?.phase,
                attemptId: ctx?.attemptId || event?.attemptId
              })
            : null;
          appendPluginAuditEvent('assistant_output_classified', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            outputId: outputRecord?.outputId || null,
            assistantMessageIndex: outputRecord?.assistantMessageIndex ?? null,
            phase: 'progress',
            stopReason: String(message?.stopReason || event?.stopReason || '').trim() || null,
            hasToolCall: true,
            fingerprint: outputRecord?.fingerprint || null,
            contentLength: visibleText.length
          });
          if (visibleText && !outputRecord) {
            appendPluginAuditEvent('lifecycle_identity_missing', {
              conversationKey: conversationKey || null,
              turnId: turnId || null,
              phase: 'progress',
              hasToolCall: true,
              reason: !conversationKey ? 'conversation_scope_missing' : 'turn_id_missing',
              contentLength: visibleText.length
            });
          }
          return undefined;
        }

        const guardKeys = getGuardKeys(ctx);
        const guardState = getGuardState(ctx);
        const conversationKey = getConversationKey(ctx);
        const conversationState = conversationKey ? napmConversationState.get(conversationKey) : null;
        api.logger.info(`[napm-openclaw-plugin] before_message_write role=${role} keys=${guardKeys.join(',') || 'none'} guard=${guardState ? 'hit' : 'miss'}`);
        const activeTurnRoute = getTurnPolicyRoute(guardState || conversationState);
        if (
          activeTurnRoute === TURN_POLICY_ROUTES.EXPLICIT_OUT_OF_SCOPE
          || guardState?.generalOutOfScopeRequested
          || conversationState?.generalOutOfScopeRequested
        ) {
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
        const turnId = getActiveTurnId(conversationState, guardState);
        if (isCurrentAlertQueryResultRecord(rememberedRecord, turnId)) {
          const content = buildAlertQueryReply(rememberedRecord.result);
          appendPluginAuditEvent('napm_alert_deterministic_final_delivery', {
            conversationKey: conversationKey || null,
            turnId: turnId || null,
            sourceTool: rememberedRecord.sourceTool,
            contentLength: content.length,
            hook: 'before_message_write'
          });
          return {
            message: buildAssistantTextMessage(content, message)
          };
        }
        if (
          !shouldAllowNapmReasoningPreviewForCtx(ctx)
          && (
            rememberedRecord?.recordType === 'query_validation_failure'
            || rememberedRecord?.recordType === 'skill_execution_failure'
          )
        ) {
          return {
            message: buildAssistantTextMessage(
              buildRememberedSkillReplyText(rememberedRecord),
              message
            )
          };
        }
        const resultDeliveryFollowUp = isResultDeliveryFollowUpPrompt(activePrompt, guardState || conversationState);
        const recentReportReply = resultDeliveryFollowUp
          ? buildRecentReportExportReply(conversationKey)
          : '';
        if (recentReportReply) {
          return {
            message: buildAssistantTextMessage(recentReportReply, message)
          };
        }
        const freshReportReply = buildFreshReportExportReply(conversationKey, turnId);
        if (isReportExportPrompt(activePrompt) && freshReportReply) {
          return {
            message: buildAssistantTextMessage(freshReportReply, message)
          };
        }
        if (
          isAlertPacketAnalysisPrompt(activePrompt)
          && isAlertPacketSkillResultRecord(rememberedRecord)
          && isSkillResultRecordForTurn(rememberedRecord, turnId)
        ) {
          if (rememberedRecord.result.workflowState !== 'COMPLETED') {
            appendPluginAuditEvent('napm_plugin_alert_packet_failed_model_final_rewritten', {
              conversationKey: conversationKey || null,
              turnId: turnId || null,
              workflowState: rememberedRecord.result.workflowState || null
            });
            return {
              message: buildAssistantTextMessage(
                buildAlertPacketFinalReply(rememberedRecord.result),
                message
              )
            };
          }
          const preparedContent = prepareAlertPacketModelFinalContent(existingText, rememberedRecord.result);
          if (preparedContent) {
            const preparedFinal = napmOperationState.prepareFinalContent({
              scope: conversationKey,
              turnId,
              content: preparedContent,
              source: 'assistant_final',
              workflowState: rememberedRecord.result.workflowState
            });
            appendPluginAuditEvent('napm_plugin_alert_packet_model_final_prepared', {
              conversationKey: conversationKey || null,
              turnId: turnId || null,
              workflowState: rememberedRecord.result.workflowState || null,
              fingerprint: preparedFinal?.fingerprint || null
            });
            return undefined;
          }
        }
        if (isReportExportPrompt(activePrompt) && textClaimsReportGenerated(existingText) && !isFreshReportExportResult(conversationKey)) {
          appendPluginAuditEvent('napm_report_direct_claim_rewritten_before_write', {
            conversationKey: conversationKey || null,
            prompt: activePrompt,
            reason: 'missing_fresh_napm_report_export_result'
          });
          return {
            message: buildAssistantTextMessage(buildReportExportRequiredReply(), message)
          };
        }
        if (
          isMetricInventoryPrompt(activePrompt)
          && isMetricInventoryResultRecord(rememberedRecord)
          && isSkillResultRecordForTurn(rememberedRecord, turnId)
        ) {
          // Persist the same deterministic metric inventory that was returned
          // by the Skill, regardless of how the model paraphrased it.
          return {
            message: buildAssistantTextMessage(
              buildRememberedSkillReplyText(rememberedRecord),
              message
            )
          };
        }
        if (
          isObjectInventoryPrompt(activePrompt)
          || isResultDeliveryFollowUpPrompt(activePrompt, guardState || conversationState)
        ) {
          const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord);
          if (rememberedReplyText) {
            return {
              message: buildAssistantTextMessage(rememberedReplyText, message)
            };
          }
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
        if (
          isBusinessInventoryGuardScope(activePrompt, rememberedRecord)
          && looksLikeInvalidBusinessInventoryAnswer(existingText)
        ) {
          const rememberedReplyText = buildRememberedSkillReplyText(rememberedRecord) || buildSkillRequiredReplyForPrompt(activePrompt);
          return {
            message: buildAssistantTextMessage(rememberedReplyText, message)
          };
        }
        if (
          isBusinessInventoryGuardScope(activePrompt, rememberedRecord)
          && looksLikeUnsupportedBusinessInventoryExplanation(existingText)
        ) {
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
        if (isAlertPacketAnalysisPrompt(activePrompt) && looksLikeInternalReasoningPreview(existingText)) {
          const safeReply = buildRememberedSkillReplyText(rememberedRecord) || buildAlertPacketSkillRequiredReply();
          return {
            message: buildAssistantTextMessage(safeReply, message)
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
        if (isAutomaticReportPrompt(activePrompt) && !rememberedRecord) {
          // reply_dispatch owns the primary async report workflow. message_sending
          // remains a compatibility fallback for OpenClaw runtimes without that hook.
          // Keep the transcript untouched until that operation has a result.
          return undefined;
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
  requiredNapmSkillRuntimePaths: REQUIRED_NAPM_SKILL_RUNTIME_PATHS,
  hasCompleteNapmSkillRuntime,
  resolveOpenClawSkillsRoot,
  parseOpenClawControlCommand,
  isNativeCommandTurn,
  clearNapmConversationScope,
  getBoundaryMode,
  isStrictBoundaryMode,
  getQuerySemanticGuardMode,
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
  observePromptQuerySemanticMismatch,
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
  createAlertPacketAnalysisToolDefinition,
  createInspectionSnapshotToolDefinition,
  createSummaryToolDefinition,
  createPacketAnalysisToolDefinition,
  buildInspectionSnapshotReply,
  buildSummaryReply,
  buildAlertQueryReply,
  buildAlertQueryToolResponse,
  buildAlertPacketAnalysisReply,
  buildAlertPacketFinalReply,
  buildNapmRoutingSystemContext,
  buildPacketAnalysisReply,
  buildReportDataForExport,
  buildReportInputForExport,
  auditReportExportSourceResolved,
  auditReportGenerated,
  buildInspectionReportDeliveryReply,
  buildReportExportReply,
  classifyReportPrompt,
  reportIntents: REPORT_INTENTS,
  buildAutomaticInspectionToolArgs,
  buildAutomaticSummaryToolArgs,
  buildSummaryTargetResolutionFailureReply,
  setAutomaticSummaryTargetResolver,
  isReportExportPrompt,
  isReportGenerationBypassTool,
  textClaimsReportGenerated,
  rememberReportExportResult,
  isFreshReportExportResult,
  dedupeOutgoingMediaForConversation,
  buildMediaDedupeKey,
  getGuardState,
  getActiveTurnId,
  getNapmResolvedQueryResolverService,
  resolvePromptWithAudit,
  runMainflowQuery,
  inferOverviewScene,
  inferMetricInventoryGroup,
  isBusinessObjectInventoryPrompt,
  isPlatformIdentityPrompt,
  isExplicitGeneralOutOfScopePrompt,
  buildTurnPolicy,
  getTurnPolicyRoute,
  turnPolicyRoutes: TURN_POLICY_ROUTES,
  isHierarchyCatalogPrompt,
  isAlertEventPrompt,
  isAlertPacketAnalysisPrompt,
  extractAlertReference,
  resolveAlertReferenceInput,
  buildCanonicalAlertPacketToolParams,
  hasSpecificFaultDiagnosisTarget,
  isFaultDiagnosisPrompt,
  isInspectionPrompt,
  isSummaryPrompt,
  isAlertSkillMetaFollowUpPrompt,
  isAlertSkillResultRecord,
  isAlertPacketSkillResultRecord,
  buildAlertSkillRequiredReply,
  buildAlertPacketSkillRequiredReply,
  buildAlertExecutionTraceReplyFromRememberedRecord,
  isMetricInventoryPrompt,
  isMetricInventoryDetailPrompt,
  isNapmMetaFollowUpPrompt,
  isPacketLossClientTopPrompt,
  isPacketCapturePrompt,
  looksLikeNapmBypassProcessText,
  looksLikeManualHierarchyInferenceText,
  looksLikeUnsupportedBusinessInventoryExplanation,
  shouldForceSkillRecordForPrompt,
  shouldRequireSkillBackedReply,
  normalizeHierarchyQuestionTarget,
  normalizeOverviewSceneKey,
  shouldReplaceWithPromptOverview,
  rememberDebugApiForPromptAliases,
  rememberSkillResult,
  getConversationKey,
  bindTrustedToolContext,
  getTrustedConversationKey,
  getTrustedTurnId,
  getLatestRememberedSkillRecord,
  getRememberedQueryFailureForTurn,
  getReportDataFromRecord,
  prepareSkillExecutionArgs,
  shouldAllowNapmReasoningPreview,
  extractOverviewSceneFromRememberedRecord
};
