const TimeUtils = require('../skills/openclaw-napm-query/src/utils/TimeUtils');

describe('TimeUtils shared time-range compatibility', () => {
  const nowMs = Date.parse('2026-08-07T08:56:40Z');
  const expectedEnd = 1786092960;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ['最近三小时', 3 * 60 * 60],
    ['最近3小时', 3 * 60 * 60],
    ['最近半小时', 30 * 60],
    ['最近90分钟', 90 * 60],
    ['最近七天', 7 * 24 * 60 * 60]
  ])('should delegate %s to the shared time owner', (prompt, durationSeconds) => {
    const result = TimeUtils.normalizeDynamicTimeRange(prompt);

    expect(result).toMatchObject({
      dynamic: true,
      start: expectedEnd - durationSeconds,
      end: expectedEnd
    });
  });

  test('should reuse the shared Chinese duration-number parser', () => {
    expect(TimeUtils.parseChineseNumber('半')).toBe(0.5);
    expect(TimeUtils.parseChineseNumber('一百零八')).toBe(108);
  });
});
