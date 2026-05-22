/**
 * NapmResolvedQueryResolverService.js
 *
 * 这是一个轻量级、spec 驱动的 prompt -> resolvedQuery 解析器。
 * 它主要处理两类高确定性场景：
 * 1. 元数据清单类问句
 * 2. 排名 / TopN 类问句
 * 当规则无法可靠构造 resolvedQuery 时，会返回结构化失败结果，而不是盲目猜测。
 */
const {
  loadResolutionSpec
} = require('./ResolutionSpecService');

// 深拷贝 spec 等 JSON 兼容对象，避免解析阶段修改共享配置。
function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

// 判断文本是否命中任一关键字或正则规则。
function includesAny(text = '', patterns = []) {
  const source = normalizeLower(text);
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    const token = normalizeLower(pattern);
    return token && source.includes(token);
  });
}

function flattenAliasEntries(aliasMap = {}) {
  const entries = [];
  Object.entries(aliasMap || {}).forEach(([id, aliases]) => {
    entries.push({ id, alias: id });
    (Array.isArray(aliases) ? aliases : []).forEach((alias) => {
      entries.push({ id, alias });
    });
  });
  return entries;
}

function findAliasMatch(text = '', aliasMap = {}, options = {}) {
  const source = normalizeLower(text);
  const preferredIds = Array.isArray(options.preferredIds) ? options.preferredIds : [];
  const entries = flattenAliasEntries(aliasMap)
    .filter((entry) => normalizeText(entry.alias))
    .sort((left, right) => {
      const leftPreferred = preferredIds.includes(left.id) ? 1 : 0;
      const rightPreferred = preferredIds.includes(right.id) ? 1 : 0;
      if (leftPreferred !== rightPreferred) {
        return rightPreferred - leftPreferred;
      }
      return normalizeText(right.alias).length - normalizeText(left.alias).length;
    });

  for (const entry of entries) {
    const alias = normalizeLower(entry.alias);
    if (alias && source.includes(alias)) {
      return {
        id: entry.id,
        alias: entry.alias
      };
    }
  }

  return null;
}

// 向下取整到分钟，保证生成的时间窗口对齐执行层常用时间粒度。
function alignToMinute(seconds = Math.floor(Date.now() / 1000)) {
  const rawEnd = Number(seconds) > 0 ? Math.floor(Number(seconds)) : Math.floor(Date.now() / 1000);
  return Math.floor(rawEnd / 60) * 60;
}

function buildRelativeTimeRange(key, seconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const end = alignToMinute(nowSeconds);
  const start = alignToMinute(end - seconds);
  return {
    key,
    start,
    end
  };
}

function normalizeResolvedQueryTimeRange(resolvedQuery = {}) {
  if (!resolvedQuery || typeof resolvedQuery !== 'object' || Array.isArray(resolvedQuery)) {
    return resolvedQuery;
  }

  const next = { ...resolvedQuery };
  if (Number.isFinite(Number(next.start)) && Number(next.start) > 0) {
    next.start = alignToMinute(next.start);
  }
  if (Number.isFinite(Number(next.end)) && Number(next.end) > 0) {
    next.end = alignToMinute(next.end);
  }
  if (
    next.timeRange
    && typeof next.timeRange === 'object'
    && !Array.isArray(next.timeRange)
  ) {
    next.timeRange = { ...next.timeRange };
    if (Number.isFinite(Number(next.timeRange.start)) && Number(next.timeRange.start) > 0) {
      next.timeRange.start = alignToMinute(next.timeRange.start);
    }
    if (Number.isFinite(Number(next.timeRange.end)) && Number(next.timeRange.end) > 0) {
      next.timeRange.end = alignToMinute(next.timeRange.end);
    }
  }
  return next;
}

function buildLast1HourTimeRange(nowSeconds = Math.floor(Date.now() / 1000)) {
  return buildRelativeTimeRange('last1hour', 60 * 60, nowSeconds);
}

function buildLast24HoursTimeRange(nowSeconds = Math.floor(Date.now() / 1000)) {
  return buildRelativeTimeRange('last24hours', 24 * 60 * 60, nowSeconds);
}

/**
 * 从用户问句中推断相对时间范围。
 * 当前以“最近 N 分钟 / 小时 / 天”为主，兜底到最近 1 小时。
 */
function inferTimeRange(prompt = '', nowSeconds = Math.floor(Date.now() / 1000)) {
  const text = normalizeText(prompt);
  const lower = normalizeLower(text);

  const minuteMatch = lower.match(/(?:最近|近|过去|last|past)\s*(\d{1,3})\s*(?:分钟|分|minutes?|mins?)/i);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return buildRelativeTimeRange(`last${minutes}minutes`, minutes * 60, nowSeconds);
    }
  }

  if (/(?:最近|近|过去)\s*(?:一|1)\s*(?:小时|个小时)|last\s*(?:1\s*)?hour|past\s*(?:1\s*)?hour/i.test(text)) {
    return buildLast1HourTimeRange(nowSeconds);
  }

  const hourMatch = lower.match(/(?:最近|近|过去|last|past)\s*(\d{1,3})\s*(?:小时|个小时|hours?|hrs?)/i);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return buildRelativeTimeRange(`last${hours}hours`, hours * 60 * 60, nowSeconds);
    }
  }

  if (/(?:最近|近|过去)\s*(?:一|1)\s*(?:天|日)|(?:最近|过去)\s*24\s*(?:小时|个小时)|last\s*(?:1\s*)?day|past\s*(?:1\s*)?day|last\s*24\s*hours?|past\s*24\s*hours?/i.test(text)) {
    return buildLast24HoursTimeRange(nowSeconds);
  }

  const dayMatch = lower.match(/(?:最近|近|过去|last|past)\s*(\d{1,2})\s*(?:天|日|days?)/i);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      return buildRelativeTimeRange(`last${days}days`, days * 24 * 60 * 60, nowSeconds);
    }
  }

  return buildLast1HourTimeRange(nowSeconds);
}

// 从问句中推断 TopN 数量；若更像“谁最高/哪个最多”，则默认返回 1。
function inferTopCount(prompt = '') {
  const text = normalizeText(prompt);
  const topMatch = text.match(/(?:top|前)\s*(\d{1,2})/i);
  if (topMatch) {
    const parsed = Number(topMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (/(谁|哪一个|哪个|最大|最高|最小|最低|最多|最少)/.test(text)) {
    return 1;
  }

  return 10;
}

function inferDirection(prompt = '') {
  if (includesAny(prompt, ['最小', '最低', '最少', '最低的', '最小的'])) {
    return 'asc';
  }
  return 'desc';
}

// 基于 resolution spec 中的指标别名表识别指标。
function inferMetric(prompt = '', spec = {}) {
  const match = findAliasMatch(prompt, spec?.metrics?.aliases || {});
  if (match) {
    return {
      metric: match.id,
      matchedAlias: match.alias
    };
  }

  return null;
}

/**
 * 基于对象别名与偏好对象类型推断 groupType。
 * 在客户端 IP、业务组、Web 应用等常见对象上会给更贴近业务语义的优先级。
 */
function inferGroup(prompt = '', spec = {}, options = {}) {
  const text = normalizeText(prompt);
  const objectAliases = spec?.objects?.aliases || {};
  const preferredIds = [];

  if (/客户端\s*IP|client\s*ip/i.test(text)) {
    preferredIds.push('ClientIPs', 'IPAddress');
  }
  if (/IP地址|ip地址|\bip\b/i.test(text)) {
    preferredIds.push('IPAddress', 'ClientIPs');
  }
  if (/工作组|业务组|BusinessGroup/i.test(text)) {
    preferredIds.push('BusinessGroup');
  }
  if (/业务系统|Web应用|网站|站点|WebApplication/i.test(text)) {
    preferredIds.push('WebApplication');
  }

  const match = findAliasMatch(text, objectAliases, { preferredIds });
  if (match) {
    const mappedId = match.id === 'ClientIPs' && options.collapseClientIpToIpAddress !== false
      ? 'IPAddress'
      : match.id;
    return {
      group: mappedId,
      matchedAlias: match.alias,
      originalGroup: match.id
    };
  }

  if (options.defaultGroup) {
    return {
      group: options.defaultGroup,
      matchedAlias: null,
      originalGroup: options.defaultGroup
    };
  }

  return null;
}

function isMetadataListPrompt(prompt = '') {
  return includesAny(prompt, ['有哪些', '有什么', '列表', '清单', '对象列表', '都有哪些']);
}

function isMetricInventoryPrompt(prompt = '') {
  return includesAny(prompt, ['哪些指标', '什么指标', '可查哪些指标', '可以查哪些指标', '支持哪些指标', '指标列表']);
}

function isDrilldownCatalogPrompt(prompt = '') {
  return includesAny(prompt, ['下钻', '往下钻', '钻取', '层级', '路径', '结构', '目录', '可以到哪里']);
}

function isRankingPrompt(prompt = '') {
  return includesAny(prompt, [
    '最大',
    '最高',
    '最多',
    '最小',
    '最低',
    '最少',
    'top',
    'TopN',
    '排行',
    '排名',
    '是谁',
    '哪个',
    '哪一个'
  ]);
}

// 构造统一 diagnostics 结构，便于上层知道该结果来自哪个解析器。
function buildDiagnostics(extra = {}) {
  return {
    resolver: 'NapmResolvedQueryResolverService',
    source: 'openclaw_mainflow_resolver',
    ...extra
  };
}

// 构造成功解析结果。
function success(prompt, intent, resolvedQuery, diagnostics = {}) {
  return {
    ok: true,
    source: 'openclaw_mainflow_resolver',
    intent,
    prompt: normalizeText(prompt),
    resolvedQuery: normalizeResolvedQueryTimeRange(resolvedQuery),
    diagnostics: buildDiagnostics(diagnostics)
  };
}

// 构造失败解析结果，并保留失败原因与诊断上下文。
function failure(prompt, reason, message, diagnostics = {}) {
  return {
    ok: false,
    source: 'openclaw_mainflow_resolver',
    prompt: normalizeText(prompt),
    reason,
    message,
    diagnostics: buildDiagnostics(diagnostics)
  };
}

// 构造 metadata 类问句通用 resolvedQuery 结构。
function buildMetadataResolvedQuery(prompt, service, groupType, operation) {
  return {
    service,
    queryModeKey: 'metadata',
    groups: [{ type: groupType }],
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation
    },
    resolutionHints: {
      constructedBy: 'openclaw_mainflow_resolver'
    }
  };
}

/**
 * 解析元数据类问句。
 * 当前覆盖对象清单、指标清单和下钻目录三种元数据场景。
 */
function resolveMetadataPrompt(prompt = '', spec = {}) {
  const groupMatch = inferGroup(prompt, spec, { defaultGroup: 'WebApplication' });
  const groupType = groupMatch?.group || 'WebApplication';

  if (isDrilldownCatalogPrompt(prompt)) {
    return success(
      prompt,
      {
        category: 'metadata_query',
        service: 'drilldownCatalog',
        operation: 'metadata_list',
        groupType
      },
      {
        service: 'drilldownCatalog',
        queryModeKey: 'metadata',
        groups: [{ type: groupType }],
        format: 'json',
        userRequirement: normalizeText(prompt),
        semanticConstraints: {
          operation: 'drilldown_catalog'
        },
        resolutionHints: {
          constructedBy: 'openclaw_mainflow_resolver',
          matchedGroupAlias: groupMatch?.matchedAlias || null
        }
      },
      {
        matchedGroup: groupMatch || null
      }
    );
  }

  if (isMetricInventoryPrompt(prompt)) {
    return success(
      prompt,
      {
        category: 'metadata_query',
        service: 'metrics',
        operation: 'metadata_list',
        groupType
      },
      buildMetadataResolvedQuery(prompt, 'metrics', groupType, 'metadata_list'),
      {
        matchedGroup: groupMatch || null
      }
    );
  }

  if (isMetadataListPrompt(prompt)) {
    const explicitBusinessGroup = /工作组|业务组|BusinessGroup/i.test(prompt);
    const resolvedGroupType = explicitBusinessGroup ? 'BusinessGroup' : groupType;
    return success(
      prompt,
      {
        category: 'metadata_query',
        service: 'groups',
        operation: 'metadata_list',
        groupType: resolvedGroupType
      },
      buildMetadataResolvedQuery(prompt, 'groups', resolvedGroupType, 'metadata_list'),
      {
        matchedGroup: groupMatch || null
      }
    );
  }

  return null;
}

/**
 * 解析 TopN / 排名类问句。
 * 会尝试同时收敛指标、对象、时间范围、排序方向和 topCount。
 */
function resolveTopValuesPrompt(prompt = '', spec = {}, options = {}) {
  if (!isRankingPrompt(prompt)) {
    return null;
  }

  const metricMatch = inferMetric(prompt, spec);
  if (!metricMatch) {
    return failure(
      prompt,
      'missing_metric',
      'Cannot construct resolvedQuery because no NAPM metric was identified.',
      { phase: 'metric_resolution' }
    );
  }

  const groupMatch = inferGroup(prompt, spec, { defaultGroup: 'IPAddress' });
  const groupType = groupMatch?.group || 'IPAddress';
  const nowSeconds = options.nowSeconds || Math.floor(Date.now() / 1000);
  const timeRange = inferTimeRange(prompt, nowSeconds);
  const direction = inferDirection(prompt);
  const topCount = inferTopCount(prompt);

  const resolvedQuery = {
    service: 'topValues',
    queryModeKey: 'topn',
    metric: metricMatch.metric,
    metrics: [metricMatch.metric],
    topMetric: metricMatch.metric,
    groups: [{ type: groupType }],
    topCount,
    start: timeRange.start,
    end: timeRange.end,
    timeRange: {
      key: timeRange.key
    },
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation: direction === 'asc' ? 'rank_bottom' : 'rank_top',
      direction
    },
    resolutionHints: {
      constructedBy: 'openclaw_mainflow_resolver',
      matchedMetricAlias: metricMatch.matchedAlias || null,
      matchedGroupAlias: groupMatch?.matchedAlias || null
    }
  };

  return success(
    prompt,
    {
      category: 'data_query',
      service: 'topValues',
      operation: resolvedQuery.semanticConstraints.operation,
      metric: metricMatch.metric,
      groupType,
      topCount
    },
    resolvedQuery,
    {
      matchedMetric: metricMatch,
      matchedGroup: groupMatch || null,
      timeRange
    }
  );
}

/**
 * 主入口：按“元数据问句 -> TopN 问句”的顺序尝试构造 resolvedQuery。
 * 如果当前规则集无法支持该问句，会返回结构化 failure 结果。
 */
function resolvePrompt(prompt = '', options = {}) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return failure('', 'missing_prompt', 'Cannot construct resolvedQuery because prompt is empty.');
  }

  const spec = options.spec ? cloneJson(options.spec) : loadResolutionSpec();
  const metadataResult = resolveMetadataPrompt(normalizedPrompt, spec);
  if (metadataResult) {
    return metadataResult;
  }

  const topValuesResult = resolveTopValuesPrompt(normalizedPrompt, spec, options);
  if (topValuesResult) {
    return topValuesResult;
  }

  return failure(
    normalizedPrompt,
    'unsupported_prompt',
    'Cannot construct resolvedQuery for this prompt with the current spec-driven resolver.',
    {
      phase: 'intent_resolution',
      supportedServices: Object.keys(spec?.services || {})
    }
  );
}

module.exports = {
  resolvePrompt,
  resolveMetadataPrompt,
  resolveTopValuesPrompt,
  inferMetric,
  inferGroup,
  inferTopCount,
  inferDirection,
  inferTimeRange,
  buildLast1HourTimeRange,
  buildLast24HoursTimeRange,
  alignToMinute,
  normalizeResolvedQueryTimeRange
};
