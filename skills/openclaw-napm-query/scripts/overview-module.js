/**
 * 文件作用：
 * 负责 NAPM 概览类查询的统一编排，包含场景识别、时间范围归一化、
 * 候选概览模块装配、元数据预检、执行计划构建与执行，以及结果归并摘要。
 */
const NapmMetadataService = require('../services/NapmMetadataService');
const { listOverviewCandidates, getOverviewSceneProfile } = require('./OverviewCandidateRegistry');
const { resolveOverviewDepth, getOverviewBudget } = require('./OverviewBudget');
const { extractOverviewSlots, buildOverviewPlan, DEFAULT_OVERVIEW_PLANNING_POLICY } = require('./OverviewPlanner');
const { compileOverviewPlan, buildBaseQueryFromCandidate } = require('./OverviewPlanCompiler');
const { executeOverviewPlan } = require('./OverviewExecution');
const { reduceOverviewResults } = require('./OverviewResultReducer');

const DEFAULT_TOP_COUNT = 5;
const DEFAULT_OVERVIEW_WINDOW_SECONDS = 24 * 60 * 60;

// 将常见对象分组类型映射到概览场景，便于从 resolvedQuery 反推概览视角。
const GROUP_TYPE_SCENE_MAP = {
  BusinessGroup: 'business_group',
  WebApplication: 'business',
  DefinedApp: 'application',
  Application: 'application',
  IPAddress: 'network',
  Prefix24: 'network',
  IPConversation: 'network',
  MemberIPs: 'security',
  TotalTraffic: 'system'
};

// 当上游没有显式给出场景时，尝试从自然语言提示词中推断概览场景。
const SCENE_HINT_PATTERNS = [
  { scene: 'business_group', regex: /(业务组|工作组|业务分组|businessgroup|business group)/i },
  { scene: 'security', regex: /(未知.{0,8}(tcp|udp)?.{0,8}(端口|应用).{0,8}(流量|吞吐|带宽)|(tcp|udp).{0,8}未知.{0,8}(端口|应用).{0,8}(流量|吞吐|带宽))/i },
  { scene: 'security', regex: /(安全|风险|攻击|告警|security|attack|threat)/i },
  { scene: 'network', regex: /(网络|链路|丢包|吞吐|带宽|时延|地址|ip|network)/i },
  { scene: 'application', regex: /(应用|app|服务|网页|站点|application)/i },
  { scene: 'business', regex: /(业务|business|web应用|web application)/i },
  { scene: 'system', regex: /(系统|整体|总览|概览|全局|overall|overview|global|system)/i }
];

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundToNearestMinute(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  return Math.floor(numeric / 60) * 60;
}

function formatCompactNumber(value, digits = 2) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  return Number(numeric.toFixed(digits)).toString();
}

function pickFirstValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source ? source[key] : undefined;
    if (value === null || value === undefined || value === '') {
      continue;
    }
    return value;
  }
  return null;
}

// 兼容多种返回结构，从行数据中抽取最合适的指标值单元。
function extractMetricValueCell(row, preferredMetricId = null) {
  const metricValues = Array.isArray(row?.metricValues) ? row.metricValues : [];
  if (metricValues.length > 0) {
    const exact = metricValues.find((item) => {
      const metricId = String(item?.metric?.id || '').trim();
      return preferredMetricId ? metricId === preferredMetricId : Boolean(metricId);
    });
    return exact || metricValues[0] || null;
  }

  if (preferredMetricId && Object.prototype.hasOwnProperty.call(row || {}, preferredMetricId)) {
    return {
      metric: {
        id: preferredMetricId
      },
      value: row[preferredMetricId],
      unit: row?.units?.[preferredMetricId] || row?.unit || null
    };
  }

  return null;
}

function extractRowObjectLabel(row = {}) {
  return String(
    pickFirstValue(row?.group, ['argument', 'label', 'key'])
    || row?.object
    || row?.value
    || row?.groupPath
    || ''
  ).trim() || null;
}

function buildPreviewMetricItems(rows = [], preferredMetricId = null, limit = 3) {
  return rows
    .slice(0, limit)
    .map((row, index) => {
      const metricCell = extractMetricValueCell(row, preferredMetricId);
      const object = extractRowObjectLabel(row) || `item_${index + 1}`;
      const rawValue = toFiniteNumber(metricCell?.value ?? row?.value);
      const unit = String(metricCell?.unit || row?.unit || '').trim() || null;
      return {
        rank: index + 1,
        object,
        rawValue,
        unit,
        valueText: rawValue === null
          ? null
          : `${formatCompactNumber(rawValue)}${unit ? ` ${unit}` : ''}`
      };
    })
    .filter((item) => item.object);
}

function summarizeTopMetricRows(label, rows = [], preferredMetricId = null, limit = 3) {
  const preview = buildPreviewMetricItems(rows, preferredMetricId, limit);
  if (preview.length === 0) {
    return {
      label,
      summary: `${label} 暂无数据`,
      preview: []
    };
  }

  return {
    label,
    summary: `${label}：${preview.map((item) => `${item.object}${item.valueText ? ` ${item.valueText}` : ''}`).join('；')}`,
    preview
  };
}

function flattenAlertRecords(value, bucket = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenAlertRecords(item, bucket));
    return bucket;
  }
  if (!value || typeof value !== 'object') {
    return bucket;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, 'severity')
    || Object.prototype.hasOwnProperty.call(value, 'group')
    || Object.prototype.hasOwnProperty.call(value, 'metrics')
  ) {
    bucket.push(value);
    return bucket;
  }

  Object.values(value).forEach((item) => flattenAlertRecords(item, bucket));
  return bucket;
}

function summarizeAlertRows(label, rows = []) {
  const records = flattenAlertRecords(rows);
  if (records.length === 0) {
    return {
      label,
      summary: `${label}：未发现告警`,
      preview: []
    };
  }

  const groups = [];
  const seenGroups = new Set();
  let highestSeverity = null;
  records.forEach((item) => {
    const severity = toFiniteNumber(item?.severity);
    if (severity !== null && (highestSeverity === null || severity > highestSeverity)) {
      highestSeverity = severity;
    }
    const group = String(item?.group || '').trim();
    if (group && !seenGroups.has(group)) {
      seenGroups.add(group);
      groups.push(group);
    }
  });

  const severityText = highestSeverity === null ? null : `最高级别 ${highestSeverity}`;
  const groupText = groups.length > 0
    ? `涉及 ${groups.slice(0, 3).join('、')}${groups.length > 3 ? ' 等' : ''}`
    : null;

  return {
    label,
    summary: `${label}：检测到 ${records.length} 条告警${severityText ? `，${severityText}` : ''}${groupText ? `，${groupText}` : ''}`,
    preview: groups.slice(0, 5).map((group, index) => ({
      rank: index + 1,
      object: group
    }))
  };
}

function summarizeTimeTrendRows(label, rows = [], preferredMetricId = null) {
  const firstRow = Array.isArray(rows) ? rows[0] : null;
  const metricValues = Array.isArray(firstRow?.metricValues) ? firstRow.metricValues : [];
  const targetMetric = metricValues.find((item) => String(item?.metric?.id || '').trim() === String(preferredMetricId || '').trim())
    || metricValues[0]
    || null;
  const values = Array.isArray(targetMetric?.values)
    ? targetMetric.values.map(toFiniteNumber).filter((item) => item !== null)
    : [];
  if (values.length === 0) {
    return {
      label,
      summary: `${label} 暂无有效数据`,
      preview: []
    };
  }

  const unit = String(targetMetric?.unit || targetMetric?.metric?.unit || '').trim() || null;
  const peak = Math.max(...values);
  const latest = values[values.length - 1];

  return {
    label,
    summary: `${label}：共 ${values.length} 个时间点，峰值 ${formatCompactNumber(peak)}${unit ? ` ${unit}` : ''}，最新 ${formatCompactNumber(latest)}${unit ? ` ${unit}` : ''}`,
    preview: [
      { object: 'peak', rawValue: peak, unit },
      { object: 'latest', rawValue: latest, unit }
    ]
  };
}

function summarizeAverageMetricRows(label, rows = [], preferredMetricIds = []) {
  const firstRow = Array.isArray(rows) ? rows[0] : null;
  const metricValues = Array.isArray(firstRow?.metricValues) ? firstRow.metricValues : [];
  const preferredIds = Array.isArray(preferredMetricIds)
    ? preferredMetricIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const candidates = metricValues.length > 0
    ? metricValues
    : preferredIds
      .map((metricId) => {
        if (Object.prototype.hasOwnProperty.call(firstRow || {}, metricId)) {
          return {
            metric: { id: metricId },
            value: firstRow?.[metricId],
            unit: firstRow?.units?.[metricId] || firstRow?.unit || null
          };
        }
        return null;
      })
      .filter(Boolean);

  const preview = candidates
    .map((item, index) => {
      const metricId = String(item?.metric?.id || preferredIds[index] || '').trim() || null;
      const rawValue = toFiniteNumber(item?.value ?? item?.Value);
      const unit = String(item?.unit || item?.metric?.unit || '').trim() || null;
      if (!metricId || rawValue === null) {
        return null;
      }
      return {
        rank: index + 1,
        object: metricId,
        rawValue,
        unit,
        valueText: `${formatCompactNumber(rawValue)}${unit ? ` ${unit}` : ''}`
      };
    })
    .filter(Boolean);

  if (preview.length === 0) {
    return {
      label,
      summary: `${label} 暂无有效均值数据`,
      preview: []
    };
  }

  return {
    label,
    summary: `${label}：${preview.map((item) => `${item.object} ${item.valueText}`).join('；')}`,
    preview
  };
}

// 针对不同概览模块输出统一的摘要结构，便于最终聚合展示。
function buildOverviewModuleInsight(candidate = {}, rows = []) {
  const label = String(candidate?.label || candidate?.candidateId || '').trim() || 'overview';
  const service = String(candidate?.service || '').trim();
  const metricIds = Array.isArray(candidate?.metrics) ? candidate.metrics.filter(Boolean) : [];
  const metricId = metricIds.length > 0 ? metricIds[0] : null;

  if (service === 'alertsSummary') {
    return summarizeAlertRows(label, rows);
  }
  if (service === 'timeValues') {
    return summarizeTimeTrendRows(label, rows, metricId);
  }
  if (service === 'averageValues') {
    return summarizeAverageMetricRows(label, rows, metricIds);
  }
  if (service === 'topValues') {
    return summarizeTopMetricRows(label, rows, candidate?.topMetric || metricId);
  }

  return {
    label,
    summary: `${label} 已执行`,
    preview: []
  };
}

// 将场景别名、中文关键词统一映射为内部使用的标准 scene key。
function normalizeSceneKey(scene) {
  const key = normalizeText(scene);
  if (!key) {
    return null;
  }

  const map = {
    system: 'system',
    global: 'system',
    overall: 'system',
    business_group: 'business_group',
    businessgroup: 'business_group',
    business: 'business',
    app: 'application',
    application: 'application',
    network: 'network',
    security: 'security',
    系统: 'system',
    全局: 'system',
    整体: 'system',
    总览: 'system',
    概览: 'system',
    业务组: 'business_group',
    工作组: 'business_group',
    业务分组: 'business_group',
    业务: 'business',
    应用: 'application',
    网络: 'network',
    安全: 'security'
  };

  return map[key] || null;
}

// 概览查询默认按分钟对齐，若未给出合法范围则回退到最近 24 小时。
function resolveOverviewTimeRange(start, end) {
  const safeStart = roundToNearestMinute(start);
  const safeEnd = roundToNearestMinute(end);
  if (safeStart && safeEnd && safeEnd > safeStart) {
    return { start: safeStart, end: safeEnd };
  }
  const now = roundToNearestMinute(Math.floor(Date.now() / 1000));
  return {
    start: now - DEFAULT_OVERVIEW_WINDOW_SECONDS,
    end: now
  };
}

function mapResolvedQueryToScene(resolvedQuery = {}) {
  const groups = Array.isArray(resolvedQuery?.groups) ? resolvedQuery.groups : [];
  for (const group of groups) {
    const type = String(group?.type || '').trim();
    if (GROUP_TYPE_SCENE_MAP[type]) {
      return GROUP_TYPE_SCENE_MAP[type];
    }
  }
  return null;
}

// 场景判定遵循“显式输入优先，提示词和分组兜底”的策略，尽量复用上游判断。
function resolveOverviewScene({ prompt, payload, intent, resolvedQuery } = {}) {
  const fromPayload = normalizeSceneKey(
    payload?.overviewScene
    || payload?.scene
    || payload?.semanticUnderstanding?.overviewScene
  );
  if (fromPayload) {
    return fromPayload;
  }

  const fromIntent = normalizeSceneKey(
    intent?.overviewScene
    || intent?.constraints?.overviewScene
  );
  if (fromIntent) {
    return fromIntent;
  }

  const fromResolvedQuery = normalizeSceneKey(
    resolvedQuery?.overviewScene
    || resolvedQuery?.semanticConstraints?.overviewScene
  );
  if (fromResolvedQuery) {
    return fromResolvedQuery;
  }

  const text = String(prompt || '').trim();
  const hint = SCENE_HINT_PATTERNS.find((item) => item.regex.test(text));
  if (hint) {
    return hint.scene;
  }

  const fromResolvedGroups = mapResolvedQueryToScene(resolvedQuery);
  if (fromResolvedGroups) {
    return fromResolvedGroups;
  }

  return 'system';
}

function isLikelyMetricKey(key, metricHints = []) {
  const normalized = String(key || '').trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (metricHints.map((item) => String(item || '').toUpperCase()).includes(normalized)) {
    return true;
  }
  return /^(TPIO|TPO|TPI|PLI|PLO|RTTI|TRTI|PGTME|PGNPGE|PGNSLPGE|PGHTTP\d+|CONI|CONO|CCNI|CCNO|RFCI|RFCO|BYTIO|UEII|CSTI|PTTO|RDTO)$/.test(normalized);
}

function looksLikeIp(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function pickNestedGroupValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text || null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const directKeys = [
    'argument',
    'Argument',
    'label',
    'Label',
    'value',
    'Value',
    'name',
    'Name',
    'key',
    'Key',
    'id',
    'Id',
    'IPAddress',
    'Application',
    'DefinedApp',
    'WebApplication',
    'BusinessGroup',
    'IPConversation',
    'Prefix24'
  ];

  for (const key of directKeys) {
    const nested = value[key];
    if (nested === null || nested === undefined) {
      continue;
    }
    if (typeof nested === 'string' || typeof nested === 'number') {
      const text = String(nested).trim();
      if (text) {
        return text;
      }
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (typeof nestedValue === 'string' || typeof nestedValue === 'number') {
      const text = String(nestedValue).trim();
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function pickBestGroupValue(row, targetGroupType, metricHints = []) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const objectValue = pickNestedGroupValue(row.object);
  if (objectValue) {
    return objectValue;
  }

  const groupValue = pickNestedGroupValue(row.group);
  if (groupValue) {
    return groupValue;
  }

  const aliases = {
    IPAddress: ['ipaddress', 'ip', 'address', 'clientip', 'serverip', 'dstip', 'srcip', 'group'],
    DefinedApp: ['definedapp', 'application', 'app', 'name', 'group'],
    Application: ['application', 'app', 'name', 'group'],
    WebApplication: ['webapplication', 'website', 'webapp', 'application', 'name', 'group'],
    BusinessGroup: ['businessgroup', 'business', 'group', 'name'],
    IPConversation: ['ipconversation', 'conversation', 'session', 'group']
  };
  const targetAliases = aliases[targetGroupType] || ['group', 'name', 'object', 'label'];

  for (const key of Object.keys(row)) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!targetAliases.includes(normalizedKey)) {
      continue;
    }
    const value = pickNestedGroupValue(row[key]);
    if (value) {
      return value;
    }
  }

  if (targetGroupType === 'IPAddress') {
    for (const key of Object.keys(row)) {
      const value = pickNestedGroupValue(row[key]);
      if (looksLikeIp(value)) {
        return value;
      }
    }
  }

  for (const key of Object.keys(row)) {
    if (isLikelyMetricKey(key, metricHints)) {
      continue;
    }
    const value = pickNestedGroupValue(row[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

// 从概览结果中抽取用于下钻或二次查询的 Top 对象值，需兼容多种返回字段形态。
function extractTopGroupValues(rows, targetGroupType, metricHints = [], limit = DEFAULT_TOP_COUNT) {
  const values = [];
  const seen = new Set();
  const safeLimit = Number(limit) > 0 ? Number(limit) : DEFAULT_TOP_COUNT;
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = pickBestGroupValue(row, targetGroupType, metricHints);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
    if (values.length >= safeLimit) {
      break;
    }
  }
  return values;
}

function applyArgumentByTargetParam(groups = [], targetParam, argumentValue) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return groups;
  }
  const value = String(argumentValue || '').trim();
  if (!value) {
    return groups;
  }

  const normalizedTarget = String(targetParam || '').trim();
  const match = normalizedTarget.match(/^groupArgument(\d+)$/i);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < groups.length) {
      groups[index].argument = value;
      return groups;
    }
  }

  groups[0].argument = value;
  return groups;
}

// 元数据预检是概览编排的保护层，用于提前发现候选模块的粒度/分组兼容性问题。
async function loadOverviewMetadataReviewSafely(candidates = [], timeRange = null) {
  const warnings = [];
  const byCandidateId = {};
  let flattenedGroups = [];
  let granularities = [];

  try {
    flattenedGroups = await NapmMetadataService.getFlattenedGroups();
  } catch (error) {
    warnings.push(`overview metadata flattened groups unavailable: ${error.message}`);
  }

  try {
    granularities = await NapmMetadataService.getGranularities();
  } catch (error) {
    warnings.push(`overview metadata granularities unavailable: ${error.message}`);
  }

  for (const candidate of candidates) {
    try {
      const reviewQuery = buildBaseQueryFromCandidate(
        candidate,
        timeRange || resolveOverviewTimeRange(),
        [],
        { slotValues: {}, requestedTopCount: null },
        null
      );
      const review = await NapmMetadataService.reviewQuery(reviewQuery);
      byCandidateId[candidate.id] = {
        ...review,
        ok: !Array.isArray(review?.issues) || review.issues.length === 0
      };
    } catch (error) {
      byCandidateId[candidate.id] = {
        ok: false,
        issues: ['metadata_review_failed'],
        suggestions: [],
        error: { message: error.message }
      };
      warnings.push(`overview metadata review failed: ${candidate.id}`);
    }
  }

  return {
    flattenedGroups,
    granularities,
    byCandidateId,
    warnings
  };
}

// 仅构造标准概览候选查询，不执行请求，便于调试或外部复用。
function buildOverviewQueries(scene, start, end) {
  const timeRange = resolveOverviewTimeRange(start, end);
  const sceneProfile = getOverviewSceneProfile(scene);
  const rootTemplateOrder = Array.isArray(sceneProfile?.depthRoots?.standard)
    ? sceneProfile.depthRoots.standard
    : [];
  const orderedCandidateIds = rootTemplateOrder.length > 0
    ? rootTemplateOrder
    : listOverviewCandidates(scene)
      .filter((candidate) => candidate.role !== 'child')
      .map((candidate) => candidate.id);
  const candidates = orderedCandidateIds
    .map((candidateId) => listOverviewCandidates(scene).find((candidate) => candidate.id === candidateId))
    .filter((candidate) => candidate && candidate.role !== 'child');
  return candidates.map((candidate) => ({
    key: candidate.id,
    role: candidate.role,
    params: buildBaseQueryFromCandidate(
      candidate,
      timeRange,
      [],
      { slotValues: {}, requestedTopCount: null },
      null
    )
  }));
}

// 概览主入口：串联场景识别、规划、执行与结果归并，并输出统一的 overview 结构。
async function executeOverviewModule(options = {}) {
  const executeGatewayRequest = options.executeGatewayRequest;
  if (typeof executeGatewayRequest !== 'function') {
    throw new Error('executeOverviewModule requires executeGatewayRequest function');
  }

  const prompt = options.prompt || '';
  const payload = options.payload || {};
  const intent = options.intent || {};
  const resolvedQuery = options.resolvedQuery || {};
  const scene = resolveOverviewScene({ prompt, payload, intent, resolvedQuery });
  const depth = resolveOverviewDepth({ prompt, payload, intent, resolvedQuery });
  const budget = getOverviewBudget(depth);
  const timeRange = resolveOverviewTimeRange(resolvedQuery?.start, resolvedQuery?.end);
  const candidates = listOverviewCandidates(scene);
  const metadataReview = await loadOverviewMetadataReviewSafely(candidates, timeRange);
  const slots = extractOverviewSlots({
    prompt,
    resolvedQuery,
    intent,
    scene,
    metadataReview
  });
  const overviewPlan = buildOverviewPlan({
    candidates,
    scene,
    depth,
    budget,
    metadataReview,
    slots,
    planningPolicy: DEFAULT_OVERVIEW_PLANNING_POLICY
  });
  const compiledPlan = compileOverviewPlan({
    overviewPlan,
    timeRange,
    seedGroups: Array.isArray(resolvedQuery?.groups) ? deepClone(resolvedQuery.groups) : [],
    metadataReview
  });
  const executionResult = await executeOverviewPlan({
    compiledPlan,
    executeGatewayRequest,
    extractTopGroupValues,
    applyArgumentByTargetParam
  });
  const reduced = reduceOverviewResults({
    scene,
    depth,
    timeRange,
    overviewPlan,
    compiledPlan,
    executionResult,
    buildOverviewModuleInsight
  });

  const warnings = [
    ...(Array.isArray(metadataReview?.warnings) ? metadataReview.warnings : []),
    ...(Array.isArray(reduced?.overview?.warnings) ? reduced.overview.warnings : [])
  ];
  const ok = Number(reduced?.overview?.executionMeta?.successCount || 0) > 0;

  return {
    ok,
    service: 'overview',
    data: Array.isArray(reduced?.overview?.queries) ? reduced.overview.queries : [],
    overview: {
      ...reduced.overview,
      warnings
    },
    summary: reduced.summary,
    selectedCandidates: reduced?.overview?.selectedCandidates || [],
    skippedCandidates: reduced?.overview?.skippedCandidates || [],
    modules: reduced?.overview?.modules || [],
    warnings,
    executionMeta: reduced?.overview?.executionMeta || {
      queryCount: 0,
      successCount: 0,
      failedCount: 0
    },
    renderPolicy: {
      allowPartialResult: true
    },
    error: ok
      ? null
      : {
          code: 'OVERVIEW_NO_SUCCESS_QUERY',
          message: `Overview scene ${scene} executed with no successful queries`
        }
  };
}

module.exports = {
  resolveOverviewScene,
  resolveOverviewDepth,
  getOverviewBudget,
  resolveOverviewTimeRange,
  listOverviewCandidates,
  loadOverviewMetadataReviewSafely,
  extractOverviewSlots,
  buildOverviewPlan,
  compileOverviewPlan,
  executeOverviewPlan,
  reduceOverviewResults,
  buildOverviewQueries,
  executeOverviewModule,
  extractTopGroupValues,
  __test__: {
    resolveOverviewTimeRange,
    extractTopGroupValues,
    applyArgumentByTargetParam,
    pickBestGroupValue,
    buildOverviewModuleInsight,
    summarizeAverageMetricRows
  }
};
