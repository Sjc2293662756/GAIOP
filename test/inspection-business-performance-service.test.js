const InspectionBusinessPerformanceService = require('../skills/openclaw-napm-inspection/services/InspectionBusinessPerformanceService');
const { __test__ } = require('../skills/openclaw-napm-inspection/services/InspectionBusinessPerformanceService');

describe('InspectionBusinessPerformanceService', () => {
  test('builds slow access and HTTP error findings from TopN query rows', () => {
    const service = new InspectionBusinessPerformanceService({
      thresholds: {
        businessSlowRatioWarningGreaterThan: 0,
        businessHttp400WarningGreaterThan: 0,
        businessHttp500WarningGreaterThan: 0
      }
    });
    const result = service.buildFromQueryResults({
      slow: {
        id: 'business-slow-access-top',
        range: { start: 100, end: 200 },
        requestUrlRedacted: 'https://napm.test/NetInside?Password=***&type=topValues',
        raw: {
          rows: [
            { name: '统一认证', PGSLPCT: 12.3456, PGNSLPGE: 8, PGTME: 2300 }
          ]
        }
      },
      http400: {
        id: 'business-http400-top',
        range: { start: 100, end: 200 },
        requestUrlRedacted: 'https://napm.test/NetInside?Password=***&type=topValues',
        raw: [{ WebApplication: '订单平台', PGHTTP400: '7' }]
      },
      http500: {
        id: 'business-http500-top',
        range: { start: 100, end: 200 },
        requestUrlRedacted: 'https://napm.test/NetInside?Password=***&type=topValues',
        raw: [{ WebApplication: '订单平台', PGHTTP500: 2 }]
      }
    });

    expect(result.status).toBe('warning');
    expect(result.slowAccess[0]).toMatchObject({
      businessName: '统一认证',
      ratio: '12.346%',
      slowCount: 8,
      avgPageDelayMs: 2300
    });
    expect(result.httpErrors[0]).toMatchObject({
      businessName: '订单平台',
      http400: 7,
      http500: 2
    });
    expect(result.findings.map((item) => item.text).join('\n')).toContain('慢访问');
    expect(result.queryEvidence).toHaveLength(3);
  });

  test('collects the required WebApplication TopN metrics', async () => {
    const calls = [];
    const client = {
      async getTopValues(params) {
        calls.push(params);
        return {
          requestUrlRedacted: `https://napm.test/NetInside?Password=***&topMetric=${params.topMetric}`,
          data: []
        };
      }
    };
    const service = new InspectionBusinessPerformanceService({
      client,
      nowSeconds: 1710003600
    });

    const result = await service.collect();

    expect(calls.map((call) => call.topMetric)).toEqual(['PGSLPCT', 'PGHTTP400', 'PGHTTP500']);
    expect(calls.every((call) => call.groupType1 === 'WebApplication')).toBe(true);
    expect(result.status).toBe('unknown');
    expect(result.findings[0].text).toContain('未获取到业务性能数据');
  });

  test('normalizes supported TopN row shapes', () => {
    expect(__test__.normalizeTopRows([
      { argument: '业务A', metrics: { PGHTTP500: { value: '5' } } }
    ], ['PGHTTP500'])).toEqual([
      expect.objectContaining({ businessName: '业务A', PGHTTP500: 5 })
    ]);
    expect(__test__.mergeErrorRows(
      [{ businessName: '业务A', PGHTTP400: 1 }],
      [{ businessName: '业务A', PGHTTP500: 2 }]
    )[0]).toMatchObject({ http400: 1, http500: 2 });
  });
});
