const {
  resolveOverviewScene,
  buildOverviewQueries,
  executeOverviewModule
} = require('../skills/openclaw-napm-query/scripts/overview-module');

describe('overview-module', () => {
  test('should resolve scene from chinese prompt keyword', () => {
    const scene = resolveOverviewScene({
      prompt: '网络整体概览',
      payload: {},
      intent: {},
      resolvedQuery: {
        groups: [{ type: 'TotalTraffic' }]
      }
    });

    expect(scene).toBe('network');
  });

  test('should include alertsSummary templates in application scene', () => {
    const queries = buildOverviewQueries('application', 1774339020, 1776844620);
    const keys = queries.map((item) => item.key);
    expect(keys).toContain('applicationAlertSummary');
  });

  test('should generate child linked queries from top result', async () => {
    const executeGatewayRequest = jest.fn(async (query) => {
      if (query.service === 'topValues' && query.groups?.[0]?.type === 'IPAddress' && !query.groups?.[0]?.argument) {
        return {
          ok: true,
          service: 'topValues',
          data: [
            { IPAddress: '1.1.1.1', TPIO: '100' },
            { IPAddress: '2.2.2.2', TPIO: '90' }
          ],
          requestUrl: 'http://fake/top-ip',
          error: null
        };
      }

      return {
        ok: true,
        service: query.service,
        data: [{ value: 1 }],
        requestUrl: 'http://fake/any',
        error: null
      };
    });

    const result = await executeOverviewModule({
      prompt: '网络整体概览',
      payload: { overviewScene: 'network' },
      intent: { goal: 'overview' },
      resolvedQuery: {
        start: 1774339020,
        end: 1776844620,
        groups: [{ type: 'TotalTraffic' }]
      },
      executeGatewayRequest
    });

    const ipParent = (result?.overview?.queries || []).find((item) => item.key === 'topIpThroughput');
    expect(result.ok).toBe(true);
    expect(ipParent).toBeTruthy();
    expect(Array.isArray(ipParent.children)).toBe(true);
    expect(ipParent.children.length).toBe(2);
    expect(ipParent.children.map((item) => item.argumentValue)).toEqual(['1.1.1.1', '2.2.2.2']);
  });
});
