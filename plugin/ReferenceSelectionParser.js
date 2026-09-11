'use strict';

const REFERENCE_ACTIONS = Object.freeze({
  DETAIL: 'DETAIL',
  MODIFY_TIME: 'MODIFY_TIME'
});

const CHINESE_NUMBER_VALUES = Object.freeze({
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseChineseNumber(value = '') {
  const text = normalizeText(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return Number.isSafeInteger(numeric) ? numeric : null;
  }
  if (Object.prototype.hasOwnProperty.call(CHINESE_NUMBER_VALUES, text)) {
    return CHINESE_NUMBER_VALUES[text];
  }
  const tenMatch = text.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (!tenMatch) return null;
  const tens = tenMatch[1] ? CHINESE_NUMBER_VALUES[tenMatch[1]] : 1;
  const ones = tenMatch[2] ? CHINESE_NUMBER_VALUES[tenMatch[2]] : 0;
  return (tens * 10) + ones;
}

function parseOrdinal(text = '') {
  const match = normalizeText(text).match(
    /(?:排名|排行)?第\s*([零一二两三四五六七八九十\d]+)\s*(?:名|个|条|项|页|份)?/
  );
  if (!match) return null;
  const ordinal = parseChineseNumber(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : null;
}

function parseLimit(text = '') {
  const match = normalizeText(text).match(/前\s*([一二两三四五六七八九十\d]+)\s*(?:个|条|项|页|份)?/);
  if (!match) return null;
  const limit = parseChineseNumber(match[1]);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

function hasDetailAction(text = '') {
  const normalized = normalizeText(text);
  return /(详情|明细|详细|展开|下钻|钻取|访问了什么|访问了哪些|访问(?:的)?(?:页面|地址|URL)|有哪些页面|查看|看看|看|呢[？?]?$)/i.test(normalized);
}

function parseReferenceSelection(prompt = '') {
  const text = normalizeText(prompt);
  if (!text) return null;

  const hasContinuationCue = /(?:^|[，,。\s])(?:那|那么|改成|换成|上面|上述|刚才|前面)|(?:的)?呢[？?]?$/i.test(text);
  const hasTimeExpression = /(?:最近|过去|近)\s*[零一二两三四五六七八九十百\d]+\s*(?:秒|分钟|小时|天|日|周|月)|今天|昨天|本周|本月/i.test(text);
  if (hasContinuationCue && hasTimeExpression) {
    return Object.freeze({
      kind: 'time_change',
      action: REFERENCE_ACTIONS.MODIFY_TIME
    });
  }

  const ordinal = parseOrdinal(text);
  if (!ordinal || !hasDetailAction(text)) return null;

  const limit = parseLimit(text);
  return Object.freeze({
    kind: 'ordinal',
    ordinal,
    action: REFERENCE_ACTIONS.DETAIL,
    ...(limit ? { limit } : {})
  });
}

module.exports = {
  REFERENCE_ACTIONS,
  parseChineseNumber,
  parseReferenceSelection
};
