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
