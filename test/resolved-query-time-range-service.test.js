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
      end: 1779724740,
      source: 'time_range_resolver'
    });
    expect(nextDay).toMatchObject({
      key: 'today',
      displayText: '今天',
      start: 1779724800,
      end: 1779811140
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
});
