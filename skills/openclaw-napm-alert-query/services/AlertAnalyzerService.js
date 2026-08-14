'use strict';

const { ALERT_CATEGORY_LABELS } = require('./AlertConstants');

function increment(map, key, amount = 1) {
  const normalized = key == null || key === '' ? 'unknown' : String(key);
  map[normalized] = (map[normalized] || 0) + amount;
}

function buildTopEntries(countMap, limit = 10, mapper = null) {
  return Object.entries(countMap)
    .map(([key, count]) => (mapper ? mapper(key, count) : { key, count }))
    .sort((left, right) => (right.count || 0) - (left.count || 0))
    .slice(0, limit);
}

function analyzeEvents(events = [], options = {}) {
  const bySeverityCode = {};
  const byCategory = {};
  const byCategoryDetail = {};
  const byObject = {};
  const byMetric = {};
  let maxSeverity = null;
  let longestEvent = null;

  for (const event of events) {
    increment(bySeverityCode, event.severity);
    increment(byCategory, event.category);
    collectCategoryDetail(byCategoryDetail, event);
    increment(byObject, event.group);
    for (const metric of event.metrics || []) {
      increment(byMetric, metric);
    }
    if (event.severity != null && (maxSeverity == null || event.severity > maxSeverity)) {
      maxSeverity = event.severity;
    }
    if (!longestEvent || Number(event.period || 0) > Number(longestEvent.period || 0)) {
      longestEvent = event;
    }
  }

  const topObjectsLimit = Number.isFinite(Number(options.topObjectsLimit)) ? Number(options.topObjectsLimit) : 10;
  const categoryOverviewLimit = Number.isFinite(Number(options.categoryOverviewLimit))
    ? Number(options.categoryOverviewLimit)
    : 3;

  return {
    total: events.length,
    bySeverity: {
      minor: bySeverityCode[2] || 0,
      major: bySeverityCode[3] || 0,
      critical: bySeverityCode[4] || 0,
      unknown: Object.entries(bySeverityCode)
        .filter(([key]) => !['2', '3', '4'].includes(key))
        .reduce((sum, [, count]) => sum + count, 0),
    },
    byCategory,
    byCategoryDetail: buildCategoryDetails(byCategoryDetail, categoryOverviewLimit),
    topObjects: buildTopEntries(byObject, topObjectsLimit, (group, count) => {
      const objectEvents = events.filter((event) => String(event.group || 'unknown') === group);
      return {
        group,
        count,
        maxSeverity: objectEvents.reduce((max, event) => Math.max(max, Number(event.severity || 0)), 0) || null,
      };
    }),
    topMetrics: buildTopEntries(byMetric, topObjectsLimit, (metric, count) => ({ metric, count })),
    maxSeverity,
    longestEventId: longestEvent?.id || null,
    longestPeriod: longestEvent?.period || null,
  };
}

function collectCategoryDetail(map, event = {}) {
  const category = event.category || event.categoryLabel || 'unknown';
  if (!map[category]) {
    map[category] = {
      category,
      categoryLabel: event.categoryLabel || ALERT_CATEGORY_LABELS[category] || category,
      total: 0,
      bySeverity: {
        minor: 0,
        major: 0,
        critical: 0,
        unknown: 0,
      },
      events: [],
    };
  }

  const detail = map[category];
  detail.total += 1;
  if (Number(event.severity) === 4) detail.bySeverity.critical += 1;
  else if (Number(event.severity) === 3) detail.bySeverity.major += 1;
  else if (Number(event.severity) === 2) detail.bySeverity.minor += 1;
  else detail.bySeverity.unknown += 1;
  detail.events.push(event);
}

function buildCategoryDetails(map = {}, categoryOverviewLimit = 3) {
  return Object.values(map)
    .map((detail) => ({
      category: detail.category,
      categoryLabel: detail.categoryLabel,
      total: detail.total,
      bySeverity: detail.bySeverity,
      overviewEvents: buildOverviewEvents(detail.events, categoryOverviewLimit),
    }))
    .sort((left, right) => {
      const leftSeverity = severityScore(left.bySeverity);
      const rightSeverity = severityScore(right.bySeverity);
      if (rightSeverity !== leftSeverity) return rightSeverity - leftSeverity;
      if (right.total !== left.total) return right.total - left.total;
      return String(left.categoryLabel || left.category).localeCompare(String(right.categoryLabel || right.category), 'zh-Hans-CN');
    });
}

function buildOverviewEvents(events = [], limit = 3) {
  const map = new Map();
  for (const event of events) {
    const key = [
      event.group || '',
      event.name || '',
      event.severity || '',
    ].join('\u0000');
    if (!map.has(key)) {
      map.set(key, {
        ...event,
        triggerCount: 0,
        firstStart: event.start || null,
        lastEnd: event.end || null,
        totalPeriod: 0,
      });
    }
    const item = map.get(key);
    item.triggerCount += 1;
    if (event.start && (!item.firstStart || Number(event.start) < Number(item.firstStart))) {
      item.firstStart = event.start;
    }
    if (event.end && (!item.lastEnd || Number(event.end) > Number(item.lastEnd))) {
      item.lastEnd = event.end;
    }
    if (Number(event.period || 0) > 0) {
      item.totalPeriod += Number(event.period || 0);
    }
  }

  return Array.from(map.values())
    .map((item) => ({
      ...item,
      start: item.firstStart || item.start,
      end: item.lastEnd || item.end,
      period: item.totalPeriod > 0 ? item.totalPeriod : item.period,
    }))
    .slice(0, limit);
}

function severityScore(bySeverity = {}) {
  if (Number(bySeverity.critical || 0) > 0) return 4;
  if (Number(bySeverity.major || 0) > 0) return 3;
  if (Number(bySeverity.minor || 0) > 0) return 2;
  return 0;
}

function analyzeTimeline(buckets = []) {
  const byCategory = {};
  let peakBucket = null;

  for (const bucket of buckets) {
    const total = Number(bucket.minor || 0) + Number(bucket.major || 0) + Number(bucket.critical || 0);
    increment(byCategory, bucket.category, total);
    if (!peakBucket || total > peakBucket.total) {
      peakBucket = {
        ...bucket,
        total,
      };
    }
  }

  return {
    bucketCount: buckets.length,
    byCategory,
    peakBucket,
  };
}

module.exports = {
  analyzeEvents,
  analyzeTimeline,
  buildCategoryDetails,
  buildOverviewEvents,
};
