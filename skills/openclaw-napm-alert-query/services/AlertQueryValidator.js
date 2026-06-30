'use strict';

const { ALERT_CATEGORY_LABELS } = require('./AlertConstants');

const SUPPORTED_MODES = new Set([
  'summary',
  'timeline',
  'detail',
  'detail_with_timeseries',
  'analysis',
  'explain_notification',
  'explain_event_fields',
]);

const EXECUTABLE_TIME_MODES = new Set([
  'summary',
  'timeline',
  'detail',
  'detail_with_timeseries',
  'analysis',
]);

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const seconds = numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  return Math.floor(seconds / 60) * 60;
}

function toStringArray(value) {
  if (value == null || value === '') return [];
  const source = Array.isArray(value) ? value : [value];
  return source.map((item) => String(item).trim()).filter(Boolean);
}

function toNumberArray(value) {
  if (value == null || value === '') return [];
  const source = Array.isArray(value) ? value : [value];
  return source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

const ALERT_CATEGORY_ALIASES = {
  应用告警: 'appAlerts',
  应用性能: 'appAlerts',
  应用性能告警: 'appAlerts',
  业务告警: 'busAlerts',
  业务故障: 'busAlerts',
  业务故障告警: 'busAlerts',
  网络性能: 'networkAlerts',
  网络性能告警: 'networkAlerts',
  网络异常: 'networkIssueAlerts',
  网络异常告警: 'networkIssueAlerts',
  用户体验: 'userAlerts',
  用户体验告警: 'userAlerts',
  安全事件: 'securityAlerts',
  安全事件告警: 'securityAlerts',
  安全告警: 'securityAlerts',
  智能分析: 'AIAlerts',
  智能分析告警: 'AIAlerts',
  AI告警: 'AIAlerts',
};

const ALERT_CATEGORY_LABEL_TO_KEY = Object.fromEntries(
  Object.entries(ALERT_CATEGORY_LABELS).map(([key, label]) => [label, key])
);

function normalizeCategoryKey(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (ALERT_CATEGORY_LABELS[text]) return text;
  return ALERT_CATEGORY_ALIASES[text]
    || ALERT_CATEGORY_LABEL_TO_KEY[text]
    || ALERT_CATEGORY_ALIASES[text.replace(/告警$/u, '')]
    || text;
}

function normalizeCategoryArray(value) {
  return toStringArray(value)
    .map(normalizeCategoryKey)
    .filter(Boolean);
}

function normalizeOptions(options = {}) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    includeRaw: Boolean(source.includeRaw),
    includeTimeline: Boolean(source.includeTimeline),
    includeDetail: Boolean(source.includeDetail),
    includeMetricSeries: Boolean(source.includeMetricSeries),
    packetHandoff: source.packetHandoff !== false,
    topObjectsLimit: Number.isFinite(Number(source.topObjectsLimit)) ? Number(source.topObjectsLimit) : 10,
    maxEvents: Number.isFinite(Number(source.maxEvents)) ? Number(source.maxEvents) : 200,
    // 间接数据包发现配置
    discoveryEnabled: source.discoveryEnabled !== false,
    discoveryTopCount: Number.isFinite(Number(source.discoveryTopCount)) ? Number(source.discoveryTopCount) : 5,
    packetBufferSeconds: Number.isFinite(Number(source.packetBufferSeconds)) ? Number(source.packetBufferSeconds) : 120,
  };
}

function normalizeCriteria(criteria = {}) {
  const source = criteria && typeof criteria === 'object' && !Array.isArray(criteria) ? criteria : {};
  return {
    ...source,
    start: normalizeTimestamp(source.start),
    end: normalizeTimestamp(source.end),
    categories: normalizeCategoryArray(source.categories),
    severities: toNumberArray(source.severities),
    objects: toStringArray(source.objects || source.groups),
    eventIds: toStringArray(source.eventIds || source.eventids || source.ids),
    metrics: toStringArray(source.metrics),
    categoryTypes: toNumberArray(source.categoryTypes),
    taskTypes: toStringArray(source.taskTypes || source.tasktypes),
    linkTypes: toNumberArray(source.linkTypes),
    granularity: Number.isFinite(Number(source.granularity)) ? Number(source.granularity) : 60,
  };
}

function normalizeAlertQuery(input = {}) {
  const alertQuery = input && typeof input === 'object' && !Array.isArray(input)
    ? (input.alertQuery && typeof input.alertQuery === 'object' ? input.alertQuery : input)
    : {};
  const mode = String(alertQuery.mode || 'summary').trim() || 'summary';
  return {
    mode,
    criteria: normalizeCriteria(alertQuery.criteria || alertQuery),
    options: normalizeOptions(alertQuery.options || {}),
  };
}

function validateAlertQuery(input = {}) {
  const query = normalizeAlertQuery(input);

  if (!SUPPORTED_MODES.has(query.mode)) {
    return fail('ALERT_MODE_UNSUPPORTED', `不支持的告警查询模式：${query.mode}`, query);
  }

  if (EXECUTABLE_TIME_MODES.has(query.mode)) {
    if (!query.criteria.start || !query.criteria.end) {
      return fail('ALERT_TIME_RANGE_REQUIRED', '告警查询需要 criteria.start 和 criteria.end 秒级时间戳。', query);
    }
    if (query.criteria.end <= query.criteria.start) {
      return fail('ALERT_TIME_RANGE_INVALID', 'criteria.end 必须大于 criteria.start。', query);
    }
  }

  if (['detail', 'detail_with_timeseries'].includes(query.mode) && query.criteria.eventIds.length === 0) {
    return fail('ALERT_EVENT_IDS_REQUIRED', '告警详情查询需要 criteria.eventIds。', query);
  }

  return {
    ok: true,
    query,
  };
}

function fail(code, message, query) {
  return {
    ok: false,
    query,
    error: { code, message },
  };
}

module.exports = {
  SUPPORTED_MODES,
  validateAlertQuery,
  normalizeAlertQuery,
  normalizeCriteria,
  normalizeOptions,
  normalizeTimestamp,
  normalizeCategoryKey,
  normalizeCategoryArray,
  toStringArray,
  toNumberArray,
};
