/**
 * ResolvedQueryTimeRangeService
 *
 * Single owner for turning user time wording / timeRangeKey into executable
 * root-level start/end timestamps for resolvedQuery construction.
 */

const DEFAULT_NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60;

function alignToMinute(seconds = DEFAULT_NOW_SECONDS()) {
  const raw = Number(seconds) > 0 ? Math.floor(Number(seconds)) : DEFAULT_NOW_SECONDS();
  return Math.floor(raw / 60) * 60;
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

function buildRelativeTimeRange(key, seconds, nowSeconds = DEFAULT_NOW_SECONDS(), displayText = '') {
  const end = alignToMinute(nowSeconds);
  const start = alignToMinute(end - Number(seconds || 0));
  return {
    key,
    displayText: displayText || key,
    start,
    end,
    source: 'time_range_resolver',
    alignment: 'minute_floor'
  };
}

function buildLocalDayTimeRange(key, dayOffset, nowSeconds = DEFAULT_NOW_SECONDS(), displayText = '') {
  const instant = new Date(alignToMinute(nowSeconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  const shanghaiDayStart = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 1000) - SHANGHAI_OFFSET_SECONDS;
  const start = alignToMinute(shanghaiDayStart + Number(dayOffset || 0) * 24 * 60 * 60);
  const end = Number(dayOffset || 0) === 0
    ? alignToMinute(nowSeconds)
    : alignToMinute(start + (24 * 60 * 60) - 60);
  return {
    key,
    displayText: displayText || key,
    start,
    end,
    source: 'time_range_resolver',
    alignment: 'minute_floor',
    boundary: 'local_day'
  };
}

function buildLast1HourTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildRelativeTimeRange('last1hour', 60 * 60, nowSeconds, '\u6700\u8fd11\u5c0f\u65f6');
}

function buildLast24HoursTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildRelativeTimeRange('last24hours', 24 * 60 * 60, nowSeconds, '\u6700\u8fd124\u5c0f\u65f6');
}

function buildTodayTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildLocalDayTimeRange('today', 0, nowSeconds, '\u4eca\u5929');
}

function buildYesterdayTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildLocalDayTimeRange('yesterday', -1, nowSeconds, '\u6628\u5929');
}

function resolveKnownTimeRangeKey(key = '', nowSeconds = DEFAULT_NOW_SECONDS()) {
  const normalized = normalizeLower(key).replace(/[_\s-]+/g, '');
  switch (normalized) {
    case 'today':
      return buildTodayTimeRange(nowSeconds);
    case 'yesterday':
      return buildYesterdayTimeRange(nowSeconds);
    case 'last1hour':
    case 'lastonehour':
      return buildLast1HourTimeRange(nowSeconds);
    case 'last24hours':
    case 'last24hour':
    case 'last1day':
      return buildLast24HoursTimeRange(nowSeconds);
    default:
      break;
  }

  const minutesMatch = normalized.match(/^last(\d{1,3})minutes?$/);
  if (minutesMatch) {
    const minutes = Number(minutesMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return buildRelativeTimeRange(`last${minutes}minutes`, minutes * 60, nowSeconds, `\u6700\u8fd1${minutes}\u5206\u949f`);
    }
  }

  const hoursMatch = normalized.match(/^last(\d{1,3})hours?$/);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return buildRelativeTimeRange(`last${hours}hours`, hours * 60 * 60, nowSeconds, `\u6700\u8fd1${hours}\u5c0f\u65f6`);
    }
  }

  const daysMatch = normalized.match(/^last(\d{1,2})days?$/);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      return buildRelativeTimeRange(`last${days}days`, days * 24 * 60 * 60, nowSeconds, `\u6700\u8fd1${days}\u5929`);
    }
  }

  const secondsMatch = normalized.match(/^last(\d{1,7})seconds?$/);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return buildRelativeTimeRange(`last${seconds}seconds`, seconds, nowSeconds, `最近${seconds}秒`);
    }
  }

  return null;
}

function inferTimeRangeKeyFromPrompt(prompt = '') {
  const text = normalizeText(prompt);
  const lower = normalizeLower(text);

  if (/(\u4eca\u5929|\u4eca\u65e5|\u5f53\u5929|\btoday\b)/i.test(text)) {
    return 'today';
  }
  if (/(\u6628\u5929|\u6628\u65e5|\byesterday\b)/i.test(text)) {
    return 'yesterday';
  }

  const minuteMatch = lower.match(/(?:\u6700\u8fd1|\u8fc7\u53bb|\u8fd1|last|past)\s*(\d{1,3})\s*(?:\u5206\u949f|\u5206|minutes?|mins?)/i);
  if (minuteMatch) {
    return `last${Number(minuteMatch[1])}minutes`;
  }

  if (/(?:\u6700\u8fd1|\u8fc7\u53bb|\u8fd1)\s*(?:\u4e00|1)\s*(?:\u4e2a)?\s*\u5c0f\u65f6|last\s*(?:1\s*)?hour|past\s*(?:1\s*)?hour|\u5f53\u524d\u5c0f\u65f6|\u8fd9\u4e2a\u5c0f\u65f6/.test(text)) {
    return 'last1hour';
  }

  const hourMatch = lower.match(/(?:\u6700\u8fd1|\u8fc7\u53bb|\u8fd1|last|past)\s*(\d{1,3})\s*(?:\u5c0f\u65f6|\u4e2a\u5c0f\u65f6|hours?|hrs?)/i);
  if (hourMatch) {
    return `last${Number(hourMatch[1])}hours`;
  }

  if (/(?:\u6700\u8fd1|\u8fc7\u53bb|\u8fd1)\s*(?:\u4e00|1)\s*(?:\u5929|\u65e5)|(?:\u6700\u8fd1|\u8fc7\u53bb|\u8fd1)\s*24\s*(?:\u5c0f\u65f6|\u4e2a\u5c0f\u65f6)|last\s*(?:1\s*)?day|past\s*(?:1\s*)?day|last\s*24\s*hours?|past\s*24\s*hours?/i.test(text)) {
    return 'last24hours';
  }

  const dayMatch = lower.match(/(?:\u6700\u8fd1|\u8fc7\u53bb|\u8fd1|last|past)\s*(\d{1,2})\s*(?:\u5929|\u65e5|days?)/i);
  if (dayMatch) {
    return `last${Number(dayMatch[1])}days`;
  }

  return 'last1hour';
}

function resolveTimeRange(input = '', options = {}) {
  const nowSeconds = options.nowSeconds || DEFAULT_NOW_SECONDS();
  const explicitKey = typeof input === 'object' && input
    ? normalizeText(input.timeRangeKey || input.key || input?.timeRange?.key)
    : '';
  const prompt = typeof input === 'object' && input
    ? normalizeText(input.prompt || input.userRequirement || input.userQuery)
    : normalizeText(input);

  const key = explicitKey || inferTimeRangeKeyFromPrompt(prompt);
  const resolved = resolveKnownTimeRangeKey(key, nowSeconds) || buildLast1HourTimeRange(nowSeconds);
  return {
    ...resolved,
    key,
    requestedKey: key,
    prompt
  };
}

// 时间戳年份合理性校验：防止 LLM 自行计算时间戳时出现年份错误（如 2025 vs 2026）。
const MAX_TIMESTAMP_AGE_SECONDS = 400 * 24 * 60 * 60; // ~1.1 年容差（用于非年份错的情况）
function isTimestampFresh(timestamp, nowSeconds = DEFAULT_NOW_SECONDS()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) {
    return false;
  }
  // 年份不匹配 → 直接判定为错误，不管距离多远
  const tsYear = new Date(value * 1000).getFullYear();
  const nowYear = new Date(nowSeconds * 1000).getFullYear();
  if (tsYear !== nowYear) {
    return false;
  }
  return Math.abs(nowSeconds - value) <= MAX_TIMESTAMP_AGE_SECONDS;
}

function validateTimeRangeFreshness(start, end, nowSeconds = DEFAULT_NOW_SECONDS()) {
  const issues = [];
  if (!isTimestampFresh(start, nowSeconds)) {
    const year = new Date(Number(start) * 1000).getFullYear();
    issues.push(`start timestamp year=${year} is too far from current server time (off by >1 year)`);
  }
  if (!isTimestampFresh(end, nowSeconds)) {
    const year = new Date(Number(end) * 1000).getFullYear();
    issues.push(`end timestamp year=${year} is too far from current server time (off by >1 year)`);
  }
  return {
    ok: issues.length === 0,
    issues,
    nowSeconds
  };
}

function autoCorrectTimestampIfStale(timestamp, nowSeconds = DEFAULT_NOW_SECONDS()) {
  // 年份不匹配 → 直接修正
  const tsDate = new Date(Number(timestamp) * 1000);
  const nowDate = new Date(nowSeconds * 1000);
  if (tsDate.getFullYear() !== nowDate.getFullYear()) {
    tsDate.setFullYear(nowDate.getFullYear());
    return alignToMinute(Math.floor(tsDate.getTime() / 1000));
  }
  if (isTimestampFresh(timestamp, nowSeconds)) {
    return Number(timestamp);
  }
  // 距离太远（>400天且同年）→ 仍然修正
  tsDate.setFullYear(nowDate.getFullYear());
  return alignToMinute(Math.floor(tsDate.getTime() / 1000));
}

module.exports = {
  SHANGHAI_OFFSET_SECONDS,
  alignToMinute,
  buildRelativeTimeRange,
  buildLocalDayTimeRange,
  buildLast1HourTimeRange,
  buildLast24HoursTimeRange,
  buildTodayTimeRange,
  buildYesterdayTimeRange,
  inferTimeRangeKeyFromPrompt,
  resolveKnownTimeRangeKey,
  resolveTimeRange,
  isTimestampFresh,
  validateTimeRangeFreshness,
  autoCorrectTimestampIfStale
};
