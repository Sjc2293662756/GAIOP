const InspectionTrafficAnalysisService = require('../skills/openclaw-napm-inspection/services/InspectionTrafficAnalysisService');
const { __test__ } = require('../skills/openclaw-napm-inspection/services/InspectionTrafficAnalysisService');

describe('InspectionTrafficAnalysisService', () => {
  test.each([
    [3600, 60],
    [86400, 3600],
    [604800, 86400]
  ])('selects a supported granularity from the window duration (%s seconds)', (duration, expected) => {
    expect(__test__.selectGranularity(duration)).toBe(expected);
  });

  test('normalizes timeValues rows and computes evidence-backed stats', () => {
    const dataset = __test__.normalizeTimeSeriesDataset({
      rows: [
        { timestamp: 1000, TPIO: 10, TPI: 4, TPO: 6 },
        { timestamp: 1060, metrics: { TPIO: { value: 0 }, TPI: 0, TPO: 0 } },
        { timestamp: 1240, metricValues: [{ metric: 'TPIO', value: 100 }] }
      ]
    }, {
      granularity: 60,
      metrics: ['TPIO', 'TPI', 'TPO'],
      primaryMetric: 'TPIO'
    });

    expect(dataset.points).toHaveLength(3);
    expect(dataset.stats).toMatchObject({
      max: 100,
      min: 0,
      missingPointCount: 2,
      zeroSegmentCount: 1
    });
  });

  test('collects recent hour and day traffic using TotalTraffic timeValues', async () => {
    const calls = [];
    const client = {
      async getTimeValues(params) {
        calls.push(params);
        return {
          requestUrlRedacted: `https://napm.test/NetInside?type=timeValues&Password=***&granularity=${params.granularity}`,
          data: {
            rows: [
              { timestamp: params.start, TPIO: 10, TPI: 5, TPO: 5 },
              { timestamp: params.start + params.granularity, TPIO: 12, TPI: 6, TPO: 6 }
            ]
          }
        };
      }
    };
    const service = new InspectionTrafficAnalysisService({
      client,
      nowSeconds: 1710003600,
      timezone: 'Asia/Shanghai'
    });

    const result = await service.collect();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      metrics: 'TPIO,TPI,TPO',
      groupType1: 'TotalTraffic',
      granularity: 60
    });
    expect(calls[1].granularity).toBe(3600);
    expect(result.status).toBe('ok');
    expect(result.recentHour.queryEvidence).toMatchObject({
      service: 'timeValues',
      metrics: ['TPIO', 'TPI', 'TPO']
    });
    expect(result.findings[0].text).toContain('最近1小时');
  });

  test('uses response granularity for dataset timestamps and gap statistics', async () => {
    const client = {
      async getTimeValues(params) {
        return {
          data: {
            interval: { start: params.start, end: params.end },
            granularity: 3600,
            metricValues: [
              { metric: { id: 'TPIO' }, values: [10, 12] },
              { metric: { id: 'TPI' }, values: [5, 6] },
              { metric: { id: 'TPO' }, values: [5, 6] }
            ]
          }
        };
      }
    };
    const service = new InspectionTrafficAnalysisService({ client, nowSeconds: 1710003600 });

    const result = await service.collect();
    const recentHour = result.recentHour;

    expect(recentHour.queryEvidence).toMatchObject({
      granularity: 60,
      requestedGranularity: 60,
      actualGranularity: 3600,
      granularityMismatch: true
    });
    expect(recentHour.dataset).toMatchObject({
      requestedGranularity: 60,
      actualGranularity: 3600,
      granularitySource: 'response',
      granularityMismatch: true,
      stats: { missingPointCount: 0 }
    });
    expect(recentHour.dataset.points[1].timestamp - recentHour.dataset.points[0].timestamp).toBe(3600);
  });

  test('passes a duration-derived granularity for a non-default query window', async () => {
    let request;
    const service = new InspectionTrafficAnalysisService({
      nowSeconds: 1710003600,
      client: {
        async getTimeValues(params) {
          request = params;
          return { data: { rows: [{ timestamp: params.start, TPIO: 1 }] } };
        }
      }
    });

    const window = await service.queryWindow({
      id: 'traffic-custom-window',
      title: '自定义窗口',
      durationSeconds: 10800
    });

    expect(request).toMatchObject({
      start: 1709992800,
      end: 1710003600,
      granularity: 300
    });
    expect(window.dataset.requestedGranularity).toBe(300);
  });

  test('aggregates oversized daily windows by Shanghai calendar week', async () => {
    const start = 1750003200;
    const end = start + 365 * 86400;
    const service = new InspectionTrafficAnalysisService({
      nowSeconds: end,
      maxPoints: 120,
      client: {
        async getTimeValues(params) {
          return {
            data: {
              interval: { start: params.start, end: params.end },
              granularity: 86400,
              rows: Array.from({ length: 365 }, (_value, index) => ({
                timestamp: start + index * 86400,
                TPIO: index + 1,
                TPI: index,
                TPO: 1
              }))
            }
          };
        }
      }
    });

    const result = await service.queryWindow({
      id: 'traffic-year',
      title: '最近一年流量分布趋势',
      start,
      end,
      durationSeconds: end - start
    });

    expect(result.dataset.points.length).toBeLessThanOrEqual(53);
    expect(result.dataset.effectiveGranularity).toBe(604800);
    expect(result.dataset.aggregation).toMatchObject({
      method: 'calendar_week_average',
      sourceGranularity: 86400,
      effectiveGranularity: 604800,
      status: 'applied'
    });
    expect(result.queryEvidence).toMatchObject({
      actualGranularity: 86400,
      effectiveGranularity: 604800,
      aggregation: expect.objectContaining({ method: 'calendar_week_average' })
    });
  });

  test('collects the selected primary window plus explicit context windows', async () => {
    const calls = [];
    const service = new InspectionTrafficAnalysisService({
      nowSeconds: 1786093000,
      client: {
        async getTimeValues(params) {
          calls.push(params);
          return {
            data: { rows: [{ timestamp: params.start, TPIO: 1, TPI: 1, TPO: 0 }] }
          };
        }
      }
    });

    const result = await service.collect({
      reportWindow: { key: 'last7days', displayText: '最近7天' },
      primaryWindow: {
        id: 'traffic-primary', key: 'last7days', displayText: '最近7天',
        start: 1785488160, end: 1786092960, durationSeconds: 604800
      },
      contextWindows: [
        { id: 'recent-day', key: 'last1day', displayText: '最近1天', start: 1786006560, end: 1786092960, durationSeconds: 86400 },
        { id: 'recent-hour', key: 'last1hour', displayText: '最近1小时', start: 1786089360, end: 1786092960, durationSeconds: 3600 }
      ]
    });

    expect(calls.map((item) => item.granularity)).toEqual([86400, 3600, 60]);
    expect(result.primary).toMatchObject({ key: 'last7days', durationSeconds: 604800, title: '最近7天流量分布趋势' });
    expect(result.contextDay).toMatchObject({ key: 'last1day' });
    expect(result.contextHour).toMatchObject({ key: 'last1hour' });
    expect(result.recentHour).toBe(result.contextHour);
    expect(result.recentDay).toBe(result.contextDay);
  });

  test('does not fabricate 1970 timestamps when interval.start is absent', () => {
    const dataset = __test__.normalizeTimeSeriesDataset({
      granularity: 60,
      metricValues: [
        { metric: { id: 'TPIO' }, values: [10, 20] }
      ]
    }, { metrics: ['TPIO'], granularity: 60 });

    expect(dataset.points).toEqual([
      expect.objectContaining({ timestamp: null, time: '1', TPIO: 10 }),
      expect.objectContaining({ timestamp: null, time: '2', TPIO: 20 })
    ]);
    expect(dataset.points.some((point) => String(point.time).includes('1970'))).toBe(false);
  });

  test('builds warning finding when dataset has gaps or zero traffic', () => {
    const finding = __test__.buildFindingForDataset('最近1小时', 'traffic.stats', {
      points: [{ TPIO: 0 }],
      stats: {
        missingPointCount: 1,
        zeroSegmentCount: 1,
        spikeCount: 0
      }
    });

    expect(finding.level).toBe('warning');
    expect(finding.evidenceRefs).toEqual(['traffic.stats']);
    expect(finding.text).toContain('疑似缺点');
  });
});
