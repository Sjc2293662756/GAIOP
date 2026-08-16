const TimeRangeService = require('../skills/openclaw-napm-query/services/ResolvedQueryTimeRangeService');

describe('ResolvedQueryTimeRangeService', () => {
  test('should resolve today dynamically from current runtime date', () => {
    const today = TimeRangeService.resolveTimeRange('今天吞吐量最大的前10个IP是谁？', {
      nowSeconds: 1779677940
    });
    const nextDay = TimeRangeService.resolveTimeRange('今天吞吐量最大的前10个IP是谁？', {
      nowSeconds: 1779764340
    });

    expect(today).toMatchObject({
      key: 'today',
      displayText: '今天',
      start: 1779638400,
      end: 1779677940,
      source: 'time_range_resolver'
    });
    expect(nextDay).toMatchObject({
      key: 'today',
      displayText: '今天',
      start: 1779724800,
      end: 1779764340
    });
    expect(nextDay.start - today.start).toBe(24 * 60 * 60);
    expect(today.start % 60).toBe(0);
    expect(today.end % 60).toBe(0);
  });

  test('should resolve yesterday as previous local day window', () => {
    const result = TimeRangeService.resolveTimeRange('昨天丢包率最高的IP是谁？', {
      nowSeconds: 1779677940
    });

    expect(result).toMatchObject({
      key: 'yesterday',
      displayText: '昨天',
      start: 1779552000,
      end: 1779638340,
      boundary: 'local_day'
    });
  });

  test('should resolve explicit and default relative windows with minute alignment', () => {
    const lastHour = TimeRangeService.resolveTimeRange('最近一小时连接失败数最多的是谁？', {
      nowSeconds: 1779677977
    });
    const defaultRange = TimeRangeService.resolveTimeRange('吞吐量最高的IP是谁？', {
      nowSeconds: 1779677977
    });

    expect(lastHour).toMatchObject({
      key: 'last1hour',
      start: 1779674340,
      end: 1779677940
    });
    expect(defaultRange).toMatchObject({
      key: 'last1hour',
      start: 1779674340,
      end: 1779677940
    });
  });

  test.each([
    ['最近三小时的告警情况', 'last3hours', 3 * 60 * 60],
    ['最近3小时的告警情况', 'last3hours', 3 * 60 * 60],
    ['最近七小时的告警情况', 'last7hours', 7 * 60 * 60],
    ['最近90分钟的告警情况', 'last90minutes', 90 * 60],
    ['最近半小时的告警情况', 'last30minutes', 30 * 60],
    ['最近七天的告警情况', 'last7days', 7 * 24 * 60 * 60],
    ['最近一周的 HTTP 500 情况', 'last7days', 7 * 24 * 60 * 60],
    ['近两周的 HTTP 400 情况', 'last14days', 14 * 24 * 60 * 60]
  ])('should infer %s as the canonical key %s', (prompt, key, durationSeconds) => {
    const result = TimeRangeService.resolveTimeRange(prompt, {
      nowSeconds: 1786093000
    });

    expect(result).toMatchObject({
      key,
      start: 1786092960 - durationSeconds,
      end: 1786092960
    });
  });

  test('should keep legacy lastNseconds keys executable at the shared boundary', () => {
    const result = TimeRangeService.resolveKnownTimeRangeKey('last10800seconds', 1786093000);

    expect(result).toMatchObject({
      key: 'last10800seconds',
      start: 1786082160,
      end: 1786092960
    });
  });
});
