'use strict';

const {
  REFERENCE_ACTIONS,
  parseChineseNumber,
  parseReferenceSelection
} = require('../plugin/ReferenceSelectionParser');

describe('ReferenceSelectionParser', () => {
  test.each([
    ['看第一个的详情', 1],
    ['查看排名第一的明细', 1],
    ['第二个呢，展开看看', 2],
    ['详细看第 12 条', 12]
  ])('parses an ordinal detail selection from %s', (prompt, ordinal) => {
    expect(parseReferenceSelection(prompt)).toMatchObject({
      kind: 'ordinal',
      ordinal,
      action: REFERENCE_ACTIONS.DETAIL
    });
  });

  test('keeps an explicit result limit separate from the selected ordinal', () => {
    expect(parseReferenceSelection('详细看第一个的前 20 条')).toEqual({
      kind: 'ordinal',
      ordinal: 1,
      action: REFERENCE_ACTIONS.DETAIL,
      limit: 20
    });
  });

  test.each([
    '那最近7天的呢？',
    '换成最近 1 小时',
    '那么看今天的'
  ])('parses a contextual time change from %s', (prompt) => {
    expect(parseReferenceSelection(prompt)).toEqual({
      kind: 'time_change',
      action: REFERENCE_ACTIONS.MODIFY_TIME
    });
  });

  test.each([
    '看看最近一小时趋势',
    '最近 7 天',
    '第一个',
    '确认',
    '取消',
    '这个',
    '看它',
    '导出上面结果',
    '下载第一条',
    '',
    '普通聊天'
  ]) (
    'does not invent a detail selection for %s',
    (prompt) => {
      expect(parseReferenceSelection(prompt)).toBeNull();
    }
  );

  test.each([
    ['十', 10],
    ['十二', 12],
    ['二十', 20],
    ['21', 21]
  ])('parses supported Chinese and Arabic numbers: %s', (value, expected) => {
    expect(parseChineseNumber(value)).toBe(expected);
  });
});
