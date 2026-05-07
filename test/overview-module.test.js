const {
  resolveOverviewScene,
  resolveOverviewDepth,
  buildOverviewQueries,
  executeOverviewModule,
  __test__
} = require('../skills/openclaw-napm-query/scripts/overview-module');
const ClarificationGateService = require('../skills/openclaw-napm-query/services/ClarificationGateService');

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

  test('should resolve overview depth from explicit prompt signal', () => {
    const depth = resolveOverviewDepth({
      prompt: '请给我一个快速网络概览',
      payload: {},
      intent: {},
      resolvedQuery: {}
    });

    expect(depth).toBe('fast');
  });

  test('should build candidate queries for application scene', () => {
    const queries = buildOverviewQueries('application', 1774339020, 1776844620);
    const keys = queries.map((item) => item.key);
    expect(keys).toContain('applicationAlertSummary');
    expect(keys).toContain('appDistributionTop');
    expect(keys).toContain('topApplicationThroughput');
  });

  test('should not block overview query with object clarification gate', () => {
    const gate = ClarificationGateService.buildObjectGate({
      service: 'averageValues',
      queryModeKey: 'overview',
      userRequirement: '今天网络情况怎么样？',
      semanticConstraints: {
        operation: 'overview'
      },
      resolutionHints: {
        group: {
          type: 'IPAddress',
          explicit: false,
          defaulted: true,
          candidates: [
            { objectType: 'IPAddress', score: 0.22 },
            { objectType: 'ClientIPs', score: 0.05 },
            { objectType: 'BusinessGroup', score: 0.05 },
            { objectType: 'WebApplication', score: 0.05 }
          ]
        }
      },
      groups: [
        { type: 'IPAddress' }
      ]
    });

    expect(gate).toBeNull();
  });

  test('should extract nested group object value for overview child queries', () => {
    const value = __test__.pickBestGroupValue({
      group: {
        argument: '10.0.0.1',
        type: 'IPAddress'
      },
      metricValues: [
        {
          metric: { id: 'TPIO' },
          value: 100
        }
      ]
    }, 'IPAddress', ['TPIO']);

    expect(value).toBe('10.0.0.1');
  });

  test('should generate child linked queries from top result when budget allows', async () => {
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
      prompt: '请给我一个深入的网络整体概览趋势',
      payload: { overviewScene: 'network', overviewDepth: 'deep' },
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
    expect(ipParent.children.length).toBeGreaterThan(0);
    expect(ipParent.children.map((item) => item.argumentValue)).toContain('1.1.1.1');
  });

  test('should build module summaries and partial render policy', async () => {
    const executeGatewayRequest = jest.fn(async (query) => {
      if (query.service === 'alertsSummary') {
        return {
          ok: true,
          service: 'alertsSummary',
          data: [
            {
              busAlerts: {
                系统A: [
                  { severity: 3, group: '系统A', metrics: ['PGNPGE'] }
                ]
              }
            }
          ],
          requestUrl: 'http://fake/alerts',
          error: null
        };
      }

      if (query.service === 'topValues' && query.groups?.[0]?.type === 'IPAddress' && !query.groups?.[0]?.argument) {
        return {
          ok: true,
          service: 'topValues',
          data: [
            {
              group: { argument: '1.1.1.1' },
              metricValues: [{ metric: { id: 'TPIO' }, value: 100, unit: 'kb/sec' }]
            }
          ],
          requestUrl: 'http://fake/top-ip',
          error: null
        };
      }

      return {
        ok: true,
        service: query.service,
        data: [],
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

    const alertModule = (result?.overview?.modules || []).find((item) => item.key === 'networkAlertSummary');
    const ipModule = (result?.overview?.modules || []).find((item) => item.key === 'topIpThroughput');

    expect(Array.isArray(result?.overview?.modules)).toBe(true);
    expect(alertModule?.summary).toContain('告警');
    expect(ipModule?.summary).toContain('IP');
    expect(Array.isArray(result?.overview?.topFindings)).toBe(true);
    expect(result.overview.topFindings.length).toBeGreaterThan(0);
    expect(Array.isArray(result?.overview?.selectedCandidates)).toBe(true);
    expect(Array.isArray(result?.overview?.skippedCandidates)).toBe(true);
    expect(result?.overview?.renderPolicy?.allowPartialResult).toBe(true);
    expect(result?.overview?.executionMeta?.queryCount).toBeGreaterThan(0);
  });
});
