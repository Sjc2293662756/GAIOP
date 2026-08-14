'use strict';

const {
  ALERT_CATEGORY_LABELS,
  ALERT_SEVERITY_LABELS,
  CATEGORY_TYPE_TO_GROUP_TYPE,
  CATEGORY_TYPE_TO_ALERT_CATEGORY,
  ALERT_TASK_TYPE_LABELS,
  ALERT_LINK_TYPE_LABELS,
  TIMELINE_ORDER_WARNING,
} = require('./AlertConstants');

function toArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeEvent(rawEvent = {}, context = {}) {
  const severity = normalizeNumber(rawEvent.severity);
  const categoryType = normalizeNumber(rawEvent.categoryType);
  const taskTypeKey = rawEvent.tasktype != null ? Number(rawEvent.tasktype) : null;
  const linkType = normalizeNumber(rawEvent.linkType);
  const group = normalizeString(rawEvent.group) || normalizeString(context.group);

  return {
    id: rawEvent.id != null ? String(rawEvent.id) : null,
    // detail 接口不返 category，从 categoryType 推导告警大类
    category: context.category || CATEGORY_TYPE_TO_ALERT_CATEGORY[categoryType] || null,
    categoryLabel: ALERT_CATEGORY_LABELS[context.category || CATEGORY_TYPE_TO_ALERT_CATEGORY[categoryType]] || context.category || null,
    group,
    severity,
    severityLabel: ALERT_SEVERITY_LABELS[severity] || null,
    period: normalizeNumber(rawEvent.period),
    start: normalizeNumber(rawEvent.start),
    end: normalizeNumber(rawEvent.end),
    name: normalizeString(rawEvent.name),
    metrics: toArray(rawEvent.metrics).map(String).filter(Boolean),
    value: toArray(rawEvent.value),
    baseline: toArray(rawEvent.baseline),
    unit: toArray(rawEvent.unit).map(String).filter(Boolean),
    categoryType,
    groupType: CATEGORY_TYPE_TO_GROUP_TYPE[categoryType] || null,
    condition: normalizeString(rawEvent.condition),
    operation: normalizeString(rawEvent.operation),
    tasktype: rawEvent.tasktype != null ? String(rawEvent.tasktype) : null,
    taskTypeLabel: ALERT_TASK_TYPE_LABELS[taskTypeKey] || null,
    linkType,
    linkTypeLabel: ALERT_LINK_TYPE_LABELS[linkType] || null,
    raw: context.includeRaw ? rawEvent : undefined,
  };
}

function normalizeSummary(summaryPayload = {}, options = {}) {
  const events = [];
  const includeRaw = Boolean(options.includeRaw);
  for (const [category, groups] of Object.entries(summaryPayload || {})) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
    for (const [group, groupEvents] of Object.entries(groups)) {
      for (const event of toArray(groupEvents)) {
        if (!event || typeof event !== 'object') continue;
        events.push(normalizeEvent(event, { category, group, includeRaw }));
      }
    }
  }
  return events;
}

function normalizeDetail(detailPayload = [], options = {}) {
  return toArray(detailPayload)
    .filter((item) => item && typeof item === 'object')
    .map((item) => normalizeEvent(item, { includeRaw: Boolean(options.includeRaw) }));
}

function normalizeTimeline(timelinePayload = {}) {
  const buckets = [];
  for (const [category, bucketMap] of Object.entries(timelinePayload || {})) {
    if (!bucketMap || typeof bucketMap !== 'object' || Array.isArray(bucketMap)) continue;
    for (const [bucketStart, rawCounts] of Object.entries(bucketMap)) {
      const counts = toArray(rawCounts);
      buckets.push({
        category,
        categoryLabel: ALERT_CATEGORY_LABELS[category] || category,
        bucketStart: normalizeNumber(bucketStart),
        minor: normalizeNumber(counts[0]) || 0,
        critical: normalizeNumber(counts[1]) || 0,
        major: normalizeNumber(counts[2]) || 0,
        rawCounts: counts,
        orderWarning: TIMELINE_ORDER_WARNING,
      });
    }
  }
  return buckets.sort((left, right) => (left.bucketStart || 0) - (right.bucketStart || 0));
}

function normalizeMetricSeries(payload = {}, context = {}) {
  const values = Array.isArray(payload?.metricValues)
    ? payload.metricValues.flatMap((item) => toArray(item?.values))
    : [];
  return {
    eventId: context.eventId || null,
    metric: context.metric || null,
    group: context.group || null,
    categoryType: context.categoryType ?? null,
    groupType: context.groupType || null,
    granularity: context.granularity || 60,
    intervalStart: normalizeNumber(payload?.interval?.start),
    values,
    unit: context.unit || null,
  };
}

function filterEvents(events = [], criteria = {}) {
  return events.filter((event) => {
    if (
      criteria.categories?.length
      && !criteria.categories.includes(event.category)
      && !criteria.categories.includes(event.categoryLabel)
    ) return false;
    if (criteria.severities?.length && !criteria.severities.includes(event.severity)) return false;
    if (criteria.objects?.length && !criteria.objects.includes(event.group)) return false;
    if (criteria.eventIds?.length && !criteria.eventIds.includes(String(event.id))) return false;
    // 仅当事件自身有 metrics 时才按指标名过滤。
    // NAPM alertsDetail API 可能对某些事件返回 metrics:[]，
    // 此时不应因 criteria.metrics 有值而误杀事件。
    if (criteria.metrics?.length && event.metrics.length > 0 && !event.metrics.some((metric) => criteria.metrics.includes(metric))) return false;
    if (criteria.categoryTypes?.length && !criteria.categoryTypes.includes(event.categoryType)) return false;
    if (criteria.taskTypes?.length && !criteria.taskTypes.includes(String(event.tasktype))) return false;
    if (criteria.linkTypes?.length && !criteria.linkTypes.includes(event.linkType)) return false;
    return true;
  });
}

function sortAlertEvents(events = []) {
  return [...events].sort((left, right) => {
    const severityDiff = Number(right.severity || 0) - Number(left.severity || 0);
    if (severityDiff !== 0) return severityDiff;

    const startDiff = Number(right.start || 0) - Number(left.start || 0);
    if (startDiff !== 0) return startDiff;

    const endDiff = Number(right.end || 0) - Number(left.end || 0);
    if (endDiff !== 0) return endDiff;

    return Number(right.id || 0) - Number(left.id || 0);
  });
}

module.exports = {
  normalizeEvent,
  normalizeSummary,
  normalizeDetail,
  normalizeTimeline,
  normalizeMetricSeries,
  filterEvents,
  sortAlertEvents,
  toArray,
};
