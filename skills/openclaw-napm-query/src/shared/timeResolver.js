'use strict';

const TimeRangeService = require('../../services/ResolvedQueryTimeRangeService');

const NEEDS_TIME = new Set([
  'topValues',
  'averageValues',
  'timeValues',
  'overview',
  'topValues_multi_protocol',
]);

const EXECUTION_TIME_RANGE = Symbol('napm.executionTimeRange');
const SYSTEM_CLOCK = Object.freeze({
  nowSeconds: () => Math.floor(Date.now() / 1000)
});

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

function resolveNowSeconds(options = {}) {
  const explicitNow = toUnixSeconds(options.nowSeconds);
  if (explicitNow != null) return explicitNow;

  const clock = options.clock || SYSTEM_CLOCK;
  if (!clock || typeof clock.nowSeconds !== 'function') {
    throw new Error('Clock must provide nowSeconds().');
  }
  const nowSeconds = toUnixSeconds(clock.nowSeconds());
  if (nowSeconds == null) {
    throw new Error('Clock returned an invalid Unix timestamp.');
  }
  return nowSeconds;
}

function createExecutionTimeRange(range = {}) {
  const start = floorToMinute(toUnixSeconds(range.start));
  const end = floorToMinute(toUnixSeconds(range.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
    throw new Error('ExecutionTimeRange requires minute-aligned start/end with end greater than start.');
  }

  const immutableRange = {
    ...range,
    ok: true,
    start,
    end,
    alignment: 'minute_floor'
  };
  Object.defineProperty(immutableRange, EXECUTION_TIME_RANGE, { value: true });
  return Object.freeze(immutableRange);
}

function isExecutionTimeRange(range) {
  return Boolean(
    range
    && range[EXECUTION_TIME_RANGE] === true
    && Object.isFrozen(range)
    && Number.isFinite(Number(range.start))
    && Number.isFinite(Number(range.end))
    && Number(range.start) % 60 === 0
    && Number(range.end) % 60 === 0
    && Number(range.end) > Number(range.start)
  );
}

function requireExecutionTimeRange(range, consumer = 'service') {
  if (isExecutionTimeRange(range)) return range;
  const error = new Error(`${consumer} requires an immutable ExecutionTimeRange from TimeRangeResolver.`);
  error.code = 'EXECUTION_TIME_RANGE_REQUIRED';
  throw error;
}

function createFaultExecutionTimeRange(range, baselineRange = null) {
  const primaryRange = requireExecutionTimeRange(range, 'Fault time normalization');
  const baseline = baselineRange
    ? requireExecutionTimeRange(baselineRange, 'Fault baseline time normalization')
    : null;
  const immutableRange = {
    ...primaryRange,
    faultWindow: Object.freeze({ start: primaryRange.start, end: primaryRange.end }),
    baselineWindow: baseline
      ? Object.freeze({ start: baseline.start, end: baseline.end })
      : null
  };
  Object.defineProperty(immutableRange, EXECUTION_TIME_RANGE, { value: true });
  return Object.freeze(immutableRange);
}

function resolveExecutionTime(options = {}) {
  const nowSeconds = resolveNowSeconds(options);
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
    return createExecutionTimeRange({ ...resolved, requestedKey: key });
  }

  if (start != null || end != null) {
    if (start == null || end == null || end <= start) {
      return {
        ok: false,
        reason: 'invalid_explicit_time_range',
        message: 'Explicit start/end must both be valid Unix timestamps and end must be greater than start.'
      };
    }
    return createExecutionTimeRange({
      ok: true,
      key: 'custom',
      displayText: '\u81ea\u5b9a\u4e49\u65f6\u95f4\u8303\u56f4',
      start: floorToMinute(start),
      end: floorToMinute(end),
      source: 'explicit_execution_time',
      alignment: 'minute_floor'
    });
  }

  const defaultKey = normalizeTimeKey(options.defaultKey) || 'last1hour';
  const resolved = TimeRangeService.resolveKnownTimeRangeKey(defaultKey, nowSeconds);
  if (!resolved) {
    throw new Error(`Invalid default time range key: ${defaultKey}`);
  }
  return createExecutionTimeRange({ ...resolved, requestedKey: defaultKey });
}

function resolveTimeFromKey(timeKey, nowSeconds) {
  return resolveExecutionTime({ timeRangeKey: timeKey, nowSeconds });
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

  const fixedTimeMode = String(resolvedQuery?.executionOptions?.timeMode || '').trim() === 'fixed';
  const declaredTimeKey = normalizeTimeKey(resolvedQuery.timeRange?.key || resolvedQuery.timeRangeKey);
  const hasExplicitStart = toUnixSeconds(resolvedQuery.start) != null;
  const hasExplicitEnd = toUnixSeconds(resolvedQuery.end) != null;
  if (!declaredTimeKey && !hasExplicitStart && !hasExplicitEnd) {
    return resolvedQuery;
  }

  const range = resolveExecutionTime({
    timeRangeKey: fixedTimeMode ? '' : declaredTimeKey,
    start: resolvedQuery.start,
    end: resolvedQuery.end,
    nowSeconds: overrideNowMs ? Math.floor(overrideNowMs / 1000) : undefined
  });
  if (!range.ok) return resolvedQuery;

  resolvedQuery.start = range.start;
  resolvedQuery.end = range.end;
  resolvedQuery.executionTimeRange = range;
  resolvedQuery.timeRange = {
    ...(resolvedQuery.timeRange && typeof resolvedQuery.timeRange === 'object' ? resolvedQuery.timeRange : {}),
    key: range.key,
    displayText: fixedTimeMode ? range.displayText : (resolvedQuery.timeRange?.displayText || range.displayText)
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
  target.executionTimeRange = range;
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

  const baselineWindow = current.baselineWindow && typeof current.baselineWindow === 'object'
    ? current.baselineWindow
    : null;
  const hasBaselineStart = baselineWindow?.start;
  const hasBaselineEnd = baselineWindow?.end;
  let baselineRange = null;
  if (hasBaselineStart != null || hasBaselineEnd != null) {
    baselineRange = resolveExecutionTime({
      start: hasBaselineStart,
      end: hasBaselineEnd,
      nowSeconds: options.nowMs ? Math.floor(options.nowMs / 1000) : undefined
    });
    if (!baselineRange.ok) return baselineRange;
  }

  const executionTimeRange = createFaultExecutionTimeRange(range, baselineRange);

  target.start = executionTimeRange.start;
  target.end = executionTimeRange.end;
  target.executionTimeRange = executionTimeRange;
  target.timeRange = {
    ...current,
    key: executionTimeRange.key,
    displayText: current.displayText || executionTimeRange.displayText,
    start: executionTimeRange.start,
    end: executionTimeRange.end,
    faultWindow: { ...faultWindow, start: executionTimeRange.start, end: executionTimeRange.end },
    baselineWindow: executionTimeRange.baselineWindow
      ? { ...baselineWindow, ...executionTimeRange.baselineWindow }
      : baselineWindow
  };
  return executionTimeRange;
}

module.exports = {
  NEEDS_TIME,
  SYSTEM_CLOCK,
  floorToMinute,
  toUnixSeconds,
  resolveNowSeconds,
  createExecutionTimeRange,
  isExecutionTimeRange,
  requireExecutionTimeRange,
  createFaultExecutionTimeRange,
  resolveExecutionTime,
  resolveTimeFromKey,
  applyTimeOverride,
  applyToolTimeRange,
  applyFaultTimeRange,
};
