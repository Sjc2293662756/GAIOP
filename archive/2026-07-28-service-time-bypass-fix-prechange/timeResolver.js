'use strict';

const TimeRangeService = require('../../services/ResolvedQueryTimeRangeService');

const NEEDS_TIME = new Set([
  'topValues',
  'averageValues',
  'timeValues',
  'overview',
  'topValues_multi_protocol',
]);

function floorToMinute(value) {
  return Math.floor(Number(value) / 60) * 60;
}

function toUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric >= 100000000000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function normalizeTimeKey(value = '') {
  return String(value || '').trim();
}

function resolveExecutionTime(options = {}) {
  const nowSeconds = toUnixSeconds(options.nowSeconds) || Math.floor(Date.now() / 1000);
  const key = normalizeTimeKey(options.timeRangeKey || options.key);
  const start = toUnixSeconds(options.start);
  const end = toUnixSeconds(options.end);

  if (key) {
    const resolved = TimeRangeService.resolveKnownTimeRangeKey(key, nowSeconds);
    if (!resolved) {
      return {
        ok: false,
        reason: 'unsupported_time_range_key',
        message: `Unsupported timeRange.key: ${key}.`,
        requestedKey: key
      };
    }
    return { ok: true, ...resolved, requestedKey: key };
  }

  if (start != null || end != null) {
    if (start == null || end == null || end <= start) {
      return {
        ok: false,
        reason: 'invalid_explicit_time_range',
        message: 'Explicit start/end must both be valid Unix timestamps and end must be greater than start.'
      };
    }
    return {
      ok: true,
      key: 'custom',
      displayText: '自定义时间范围',
      start: floorToMinute(start),
      end: floorToMinute(end),
      source: 'explicit_execution_time',
      alignment: 'minute_floor'
    };
  }

  const defaultKey = normalizeTimeKey(options.defaultKey) || 'last1hour';
  const resolved = TimeRangeService.resolveKnownTimeRangeKey(defaultKey, nowSeconds);
  if (!resolved) {
    throw new Error(`Invalid default time range key: ${defaultKey}`);
  }
  return { ok: true, ...resolved, requestedKey: defaultKey };
}

function resolveTimeFromKey(timeKey, nowSeconds) {
  const resolved = resolveExecutionTime({ timeRangeKey: timeKey, nowSeconds, defaultKey: 'last1hour' });
  if (resolved.ok) return resolved;
  return resolveExecutionTime({ nowSeconds, defaultKey: 'last1hour' });
}

function applyTimeOverride(resolvedQuery, overrideNowMs) {
  if (!resolvedQuery || typeof resolvedQuery !== 'object') return resolvedQuery;
  if (!NEEDS_TIME.has(String(resolvedQuery.service || '').trim())) return resolvedQuery;

  const hasNestedExecutionTime = resolvedQuery.timeRange
    && typeof resolvedQuery.timeRange === 'object'
    && (resolvedQuery.timeRange.start != null || resolvedQuery.timeRange.end != null);
  if (!resolvedQuery.timeRange?.key && !resolvedQuery.start && !resolvedQuery.end && hasNestedExecutionTime) {
    return resolvedQuery;
  }

  const range = resolveExecutionTime({
    timeRangeKey: resolvedQuery.timeRange?.key,
    start: resolvedQuery.start,
    end: resolvedQuery.end,
    nowSeconds: overrideNowMs ? Math.floor(overrideNowMs / 1000) : undefined,
    defaultKey: 'last1hour'
  });
  if (!range.ok) return resolvedQuery;

  resolvedQuery.start = range.start;
  resolvedQuery.end = range.end;
  resolvedQuery.timeRange = {
    ...(resolvedQuery.timeRange && typeof resolvedQuery.timeRange === 'object' ? resolvedQuery.timeRange : {}),
    key: range.key,
    displayText: resolvedQuery.timeRange?.displayText || range.displayText
  };
  return resolvedQuery;
}

function applyToolTimeRange(params = {}, options = {}) {
  const target = params && typeof params === 'object' ? params : {};
  const current = target.timeRange && typeof target.timeRange === 'object' ? target.timeRange : {};
  const range = resolveExecutionTime({
    timeRangeKey: current.key || target.timeRangeKey,
    start: current.start ?? target.start,
    end: current.end ?? target.end,
    nowSeconds: options.nowMs ? Math.floor(options.nowMs / 1000) : undefined,
    defaultKey: options.defaultKey || 'last24hours'
  });
  if (!range.ok) return range;

  target.start = range.start;
  target.end = range.end;
  target.timeRange = {
    ...current,
    key: range.key,
    displayText: current.displayText || range.displayText,
    start: range.start,
    end: range.end
  };
  return range;
}

function applyFaultTimeRange(params = {}, options = {}) {
  const target = params && typeof params === 'object' ? params : {};
  const current = target.timeRange && typeof target.timeRange === 'object' ? target.timeRange : {};
  const faultWindow = current.faultWindow && typeof current.faultWindow === 'object' ? current.faultWindow : {};
  const range = resolveExecutionTime({
    timeRangeKey: current.key || target.timeRangeKey,
    start: faultWindow.start ?? current.start ?? target.start,
    end: faultWindow.end ?? current.end ?? target.end,
    nowSeconds: options.nowMs ? Math.floor(options.nowMs / 1000) : undefined,
    defaultKey: options.defaultKey || 'last24hours'
  });
  if (!range.ok) return range;

  target.start = range.start;
  target.end = range.end;
  target.timeRange = {
    ...current,
    key: range.key,
    displayText: current.displayText || range.displayText,
    start: range.start,
    end: range.end,
    faultWindow: { ...faultWindow, start: range.start, end: range.end }
  };
  return range;
}

module.exports = {
  NEEDS_TIME,
  floorToMinute,
  toUnixSeconds,
  resolveExecutionTime,
  resolveTimeFromKey,
  applyTimeOverride,
  applyToolTimeRange,
  applyFaultTimeRange,
};
