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

function parseDurationAmount(value = '') {
  const text = normalizeText(value);
  if (!text) return null;
  if (text === '\u534a') return 0.5;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;

  const digitMap = {
    '\u96f6': 0,
    '\u4e00': 1,
    '\u4e8c': 2,
    '\u4e24': 2,
    '\u4e09': 3,
    '\u56db': 4,
    '\u4e94': 5,
    '\u516d': 6,
    '\u4e03': 7,
    '\u516b': 8,
    '\u4e5d': 9
  };
  if (Object.prototype.hasOwnProperty.call(digitMap, text)) {
    return digitMap[text];
  }

  const parseUnderOneHundred = (source) => {
    const normalizedSource = String(source || '').replace(/^\u96f6+/, '');
    if (!normalizedSource) return 0;
    if (normalizedSource === '\u5341') return 10;
    const tenIndex = normalizedSource.indexOf('\u5341');
    if (tenIndex === -1) {
      return Object.prototype.hasOwnProperty.call(digitMap, normalizedSource) ? digitMap[normalizedSource] : null;
    }
    const left = normalizedSource.slice(0, tenIndex);
    const right = normalizedSource.slice(tenIndex + 1);
    const tens = left ? digitMap[left] : 1;
    const ones = right ? digitMap[right] : 0;
    return Number.isFinite(tens) && Number.isFinite(ones) ? (tens * 10) + ones : null;
  };

  const hundredIndex = text.indexOf('\u767e');
  if (hundredIndex !== -1) {
    const left = text.slice(0, hundredIndex);
    const right = text.slice(hundredIndex + 1);
    const hundreds = digitMap[left];
    const remainder = parseUnderOneHundred(right);
    return Number.isFinite(hundreds) && Number.isFinite(remainder)
      ? (hundreds * 100) + remainder
      : null;
  }

  return parseUnderOneHundred(text);
}

function buildCanonicalRelativeTimeKey(amountValue, unitValue = '') {
  const amount = Number(amountValue);
  const unit = normalizeLower(unitValue);
  if (!Number.isFinite(amount) || amount <= 0) return '';

  const isMinute = /^(?:\u5206\u949f|\u5206|minutes?|mins?)$/i.test(unit);
  const isHour = /^(?:\u5c0f\u65f6|\u65f6|hours?|hrs?)$/i.test(unit);
  const isDay = /^(?:\u5929|\u65e5|days?)$/i.test(unit);

  if (isMinute && Number.isInteger(amount) && amount <= 999) {
    return `last${amount}minutes`;
  }
  if (isHour) {
    if (Number.isInteger(amount) && amount <= 999) {
      return amount === 1 ? 'last1hour' : `last${amount}hours`;
    }
    const minutes = amount * 60;
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 999) {
      return `last${minutes}minutes`;
    }
  }
  if (isDay) {
    if (Number.isInteger(amount) && amount <= 999) {
      return amount === 1 ? 'last1day' : `last${amount}days`;
    }
    const hours = amount * 24;
    if (Number.isInteger(hours) && hours > 0 && hours <= 999) {
      return hours === 1 ? 'last1hour' : `last${hours}hours`;
    }
  }

  return '';
}

function parseExplicitTimeRangePrompt(prompt = '') {
  const text = normalizeText(prompt);
  if (!text) return null;

  if (/(?:\u672c\u5b63\u5ea6|\u5f53\u524d\u5b63\u5ea6|\u8fd9\u4e2a\u5b63\u5ea6|\u672c\u5b63|\bcurrent\s+quarter\b)/i.test(text)) {
    return { key: 'currentQuarter', displayText: '\u5f53\u524d\u81ea\u7136\u5b63\u5ea6' };
  }
  if (/(?:\u4e0a\u4e2a\u5b63\u5ea6|\u4e0a\u4e00\u5b63\u5ea6|\u4e0a\u5b63|\bprevious\s+quarter\b)/i.test(text)) {
    return { key: 'previousQuarter', displayText: '\u4e0a\u4e00\u4e2a\u81ea\u7136\u5b63\u5ea6' };
  }
  if (/(?:\u6700\u8fd1\u4e00\u4e2a\u5b63\u5ea6|\u6700\u8fd1\u4e00\u5b63|\u8fc7\u53bb\u4e00\u4e2a\u5b63\u5ea6|\u8fd1\u4e00\u4e2a\u5b63\u5ea6|\b(?:last|past)\s+quarter\b)/i.test(text)) {
    return { key: 'last90days', displayText: '\u6700\u8fd1\u4e00\u4e2a\u5b63\u5ea6' };
  }
  if (/(?:\u672c\u5e74|\u4eca\u5e74|\u5f53\u524d\u5e74\u5ea6|\u672c\u5e74\u5ea6|\bcurrent\s+year\b)/i.test(text)) {
    return { key: 'currentYear', displayText: '\u5f53\u524d\u81ea\u7136\u5e74' };
  }
  if (/(?:\u53bb\u5e74|\u4e0a\u4e00\u5e74|\u4e0a\u5e74\u5ea6|\u4e0a\u4e00\u5e74\u5ea6|\bprevious\s+year\b|\blast\s+year\b)/i.test(text)) {
    return { key: 'previousYear', displayText: '\u4e0a\u4e00\u4e2a\u81ea\u7136\u5e74' };
  }
  if (/(?:\u6700\u8fd1\u4e00\u5e74|\u8fc7\u53bb\u4e00\u5e74|\u8fd1\u4e00\u5e74|\blast\s+365\s+days?\b)/i.test(text)) {
    return { key: 'last365days', displayText: '\u6700\u8fd1\u4e00\u5e74' };
  }

  const todayMatch = text.match(/(\u4eca\u5929|\u4eca\u65e5|\u5f53\u5929|\btoday\b)/i);
  if (todayMatch) {
    return { key: 'today', displayText: todayMatch[0] };
  }
  const yesterdayMatch = text.match(/(\u6628\u5929|\u6628\u65e5|\byesterday\b)/i);
  if (yesterdayMatch) {
    return { key: 'yesterday', displayText: yesterdayMatch[0] };
  }

  const chineseWeekMatch = text.match(/(?:\u6700\u8fd1|\u8fd1|\u8fc7\u53bb|\u524d)\s*([0-9]+(?:\.[0-9]+)?|[\u96f6\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u534a]+)?\s*(?:\u4e2a)?\s*(?:\u5468|\u661f\u671f)/i);
  if (chineseWeekMatch) {
    const weeks = chineseWeekMatch[1] ? parseDurationAmount(chineseWeekMatch[1]) : 1;
    const key = buildCanonicalRelativeTimeKey(Number(weeks) * 7, '\u5929');
    return key ? { key, displayText: chineseWeekMatch[0].replace(/\s+/g, '') } : null;
  }

  const chineseMatch = text.match(/(?:\u6700\u8fd1|\u8fd1|\u8fc7\u53bb|\u524d)\s*([0-9]+(?:\.[0-9]+)?|[\u96f6\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u534a]+)\s*(?:\u4e2a)?\s*(\u5206\u949f|\u5206|\u5c0f\u65f6|\u65f6|\u5929|\u65e5)/i);
  if (chineseMatch) {
    const key = buildCanonicalRelativeTimeKey(
      parseDurationAmount(chineseMatch[1]),
      chineseMatch[2]
    );
    return key ? { key, displayText: chineseMatch[0].replace(/\s+/g, '') } : null;
  }

  const englishMatch = text.match(/(?:last|past)\s*([0-9]+(?:\.[0-9]+)?)?\s*(minutes?|mins?|hours?|hrs?|days?)/i);
  if (englishMatch) {
    const key = buildCanonicalRelativeTimeKey(
      englishMatch[1] == null ? 1 : Number(englishMatch[1]),
      englishMatch[2]
    );
    return key ? { key, displayText: englishMatch[0].trim() } : null;
  }

  if (/(?:\u5f53\u524d\u5c0f\u65f6|\u8fd9\u4e2a\u5c0f\u65f6)/.test(text)) {
    return { key: 'last1hour', displayText: '\u6700\u8fd11\u5c0f\u65f6' };
  }

  return null;
}

function inferExplicitTimeRangeKeyFromPrompt(prompt = '') {
  return parseExplicitTimeRangePrompt(prompt)?.key || '';
}

function hasExplicitTimeRangeExpression(prompt = '') {
  const text = normalizeText(prompt);
  if (!text) return false;
  return Boolean(
    /(\u4eca\u5929|\u4eca\u65e5|\u5f53\u5929|\u6628\u5929|\u6628\u65e5|\btoday\b|\byesterday\b)/i.test(text)
    || /(?:\u6700\u8fd1|\u8fd1|\u8fc7\u53bb|\u524d)\s*[^\uff0c\u3002\uff01\uff1f\n]{1,16}\s*(?:\u5206\u949f|\u5206|\u5c0f\u65f6|\u65f6|\u5929|\u65e5)/i.test(text)
    || /(?:\u6700\u8fd1|\u8fd1|\u8fc7\u53bb|\u524d)\s*[^\uff0c\u3002\uff01\uff1f\n]{0,12}\s*(?:\u5468|\u661f\u671f)/i.test(text)
    || /(?:last|past)\s*[^,.;!?\n]{0,16}\s*(?:minutes?|mins?|hours?|hrs?|days?)/i.test(text)
    || /(?:\u5f53\u524d\u5c0f\u65f6|\u8fd9\u4e2a\u5c0f\u65f6)/.test(text)
    || /(?:\u5b63\u5ea6|\u5e74\u5ea6|\u672c\u5e74|\u4eca\u5e74|\u53bb\u5e74|\b(?:current|previous|last)\s+(?:quarter|year)\b)/i.test(text)
  );
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
  const shanghaiDayStart = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 1000)
    - SHANGHAI_OFFSET_SECONDS;
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

function getShanghaiDateParts(nowSeconds = DEFAULT_NOW_SECONDS()) {
  const instant = new Date(alignToMinute(nowSeconds) * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
}

function shanghaiLocalStartSeconds(year, monthIndex, day = 1) {
  return Math.floor(Date.UTC(year, monthIndex, day) / 1000) - SHANGHAI_OFFSET_SECONDS;
}

function buildCalendarPeriodTimeRange(key, period, offset = 0, nowSeconds = DEFAULT_NOW_SECONDS(), displayText = '') {
  const parts = getShanghaiDateParts(nowSeconds);
  let year = Number(parts.year);
  let monthIndex = Number(parts.month) - 1;
  if (period === 'quarter') {
    monthIndex = Math.floor(monthIndex / 3) * 3 + Number(offset || 0) * 3;
  } else {
    monthIndex = Number(offset || 0) * 12;
  }
  year += Math.floor(monthIndex / 12);
  monthIndex %= 12;
  if (monthIndex < 0) {
    monthIndex += 12;
    year -= 1;
  }

  const start = alignToMinute(shanghaiLocalStartSeconds(year, monthIndex, 1));
  const nextMonthIndex = period === 'quarter' ? monthIndex + 3 : monthIndex + 12;
  const nextYear = year + Math.floor(nextMonthIndex / 12);
  const nextStart = shanghaiLocalStartSeconds(nextYear, nextMonthIndex % 12, 1);
  const end = Number(offset || 0) === 0
    ? alignToMinute(nowSeconds)
    : alignToMinute(nextStart - 60);
  return {
    key,
    displayText: displayText || key,
    start,
    end,
    source: 'time_range_resolver',
    alignment: 'minute_floor',
    boundary: period === 'quarter' ? 'local_quarter' : 'local_year'
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

function buildCurrentQuarterTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildCalendarPeriodTimeRange('currentQuarter', 'quarter', 0, nowSeconds, '\u5f53\u524d\u81ea\u7136\u5b63\u5ea6');
}

function buildPreviousQuarterTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildCalendarPeriodTimeRange('previousQuarter', 'quarter', -1, nowSeconds, '\u4e0a\u4e00\u4e2a\u81ea\u7136\u5b63\u5ea6');
}

function buildCurrentYearTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildCalendarPeriodTimeRange('currentYear', 'year', 0, nowSeconds, '\u5f53\u524d\u81ea\u7136\u5e74');
}

function buildPreviousYearTimeRange(nowSeconds = DEFAULT_NOW_SECONDS()) {
  return buildCalendarPeriodTimeRange('previousYear', 'year', -1, nowSeconds, '\u4e0a\u4e00\u4e2a\u81ea\u7136\u5e74');
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
    case 'currentquarter':
      return buildCurrentQuarterTimeRange(nowSeconds);
    case 'previousquarter':
      return buildPreviousQuarterTimeRange(nowSeconds);
    case 'currentyear':
      return buildCurrentYearTimeRange(nowSeconds);
    case 'previousyear':
      return buildPreviousYearTimeRange(nowSeconds);
    default:
      break;
  }

  const secondsMatch = normalized.match(/^last(\d{1,8})seconds?$/);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 60 && seconds % 60 === 0) {
      return buildRelativeTimeRange(`last${seconds}seconds`, seconds, nowSeconds, `\u6700\u8fd1${seconds}\u79d2`);
    }
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

  const daysMatch = normalized.match(/^last(\d{1,3})days?$/);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      return buildRelativeTimeRange(`last${days}days`, days * 24 * 60 * 60, nowSeconds, `\u6700\u8fd1${days}\u5929`);
    }
  }

  return null;
}

function inferTimeRangeKeyFromPrompt(prompt = '') {
  return inferExplicitTimeRangeKeyFromPrompt(prompt) || 'last1hour';
}

function resolvePromptTimeRange(prompt = '', options = {}) {
  const parsed = parseExplicitTimeRangePrompt(prompt);
  if (!parsed) return null;

  const nowSeconds = options.nowSeconds || DEFAULT_NOW_SECONDS();
  const resolved = resolveKnownTimeRangeKey(parsed.key, nowSeconds);
  if (!resolved) return null;

  return {
    ...resolved,
    key: parsed.key,
    requestedKey: parsed.key,
    displayText: parsed.displayText || resolved.displayText,
    prompt: normalizeText(prompt)
  };
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

module.exports = {
  alignToMinute,
  buildRelativeTimeRange,
  buildLocalDayTimeRange,
  buildLast1HourTimeRange,
  buildLast24HoursTimeRange,
  buildTodayTimeRange,
  buildYesterdayTimeRange,
  buildCurrentQuarterTimeRange,
  buildPreviousQuarterTimeRange,
  buildCurrentYearTimeRange,
  buildPreviousYearTimeRange,
  parseDurationAmount,
  buildCanonicalRelativeTimeKey,
  parseExplicitTimeRangePrompt,
  inferExplicitTimeRangeKeyFromPrompt,
  hasExplicitTimeRangeExpression,
  inferTimeRangeKeyFromPrompt,
  resolvePromptTimeRange,
  resolveKnownTimeRangeKey,
  resolveTimeRange
};
