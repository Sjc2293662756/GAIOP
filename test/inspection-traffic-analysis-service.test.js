const InspectionTrafficAnalysisService = require('../skills/openclaw-napm-inspection/services/InspectionTrafficAnalysisService');
const { __test__ } = require('../skills/openclaw-napm-inspection/services/InspectionTrafficAnalysisService');

describe('InspectionTrafficAnalysisService', () => {
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
