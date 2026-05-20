process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

jest.mock('../skills/openclaw-napm-query/services/NapmMetadataService', () => ({
  getFlattenedGroups: jest.fn(async () => ([
    { type: 'DefinedApp' },
    { type: 'WebApplication' },
    { type: 'BusinessGroup' },
    { type: 'IPAddress' },
    { type: 'Prefix24' },
    { type: 'IPConversation' },
    { type: 'TotalTraffic' },
    { type: 'ExternalIPs' },
    { type: 'OtherApp' },
    { type: 'MemberIPs' }
  ])),
  getGranularities: jest.fn(async () => ([3600])),
  reviewQuery: jest.fn(async () => ({
    issues: [],
    suggestions: [],
    granularities: [3600]
  }))
}));

const {
  resolveOverviewScene,
  resolveOverviewDepth,
  buildOverviewQueries,
  executeOverviewModule,
  extractOverviewSlots,
  compileOverviewPlan,
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

  test('should resolve unknown port traffic prompts to security scene', () => {
    const scene = resolveOverviewScene({
      prompt: '未知TCP端口流量情况',
      payload: {},
      intent: {},
      resolvedQuery: {
        groups: [{ type: 'TotalTraffic' }]
      }
    });

    expect(scene).toBe('security');
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
    expect(keys).toContain('appFailureTop');
    expect(keys).not.toContain('topApplicationThroughput');
  });

  test('should build distinct root query bundles for system and network scenes', () => {
    const systemKeys = buildOverviewQueries('system', 1774339020, 1776844620).map((item) => item.key);
    const networkKeys = buildOverviewQueries('network', 1774339020, 1776844620).map((item) => item.key);

    expect(systemKeys).toEqual([
      'topDefinedAppThroughput',
      'unknownTcpConnectionTop',
      'overallTrafficTrend',
      'systemAlertSummary'
    ]);
    expect(networkKeys).toEqual([
      'networkAlertSummary',
      'packetLossInboundTop',
      'packetLossOutboundTop',
      'overallTrafficTrend',
      'topIpThroughput',
      'topIpConnectionFailures',
      'focusedIpConnectionSnapshot',
      'focusedIpConnectionTrend'
    ]);
    expect(systemKeys).not.toContain('topIpThroughput');
    expect(networkKeys).not.toContain('topDefinedAppThroughput');
  });

  test('should not include alertsSummary roots in business or business_group overview scenes', () => {
    const businessKeys = buildOverviewQueries('business', 1774339020, 1776844620).map((item) => item.key);
    const businessGroupKeys = buildOverviewQueries('business_group', 1774339020, 1776844620).map((item) => item.key);

    expect(businessKeys).not.toContain('businessAlertSummary');
    expect(businessGroupKeys).not.toContain('businessGroupAlertSummary');
    expect(businessKeys).toEqual([
      'topBusinessRealtime',
      'topBusinessVisits'
    ]);
    expect(businessGroupKeys).toEqual([
      'topBusinessGroupThroughput',
      'topBusinessGroupConnections'
    ]);
  });

  test('should follow scene profile for application deep overview', async () => {
    const executeGatewayRequest = jest.fn(async (query) => ({
      ok: true,
      service: query.service,
      data: query.service === 'topValues'
        ? [
            {
              group: { argument: 'HTTP' },
              metricValues: [{ metric: { id: query.topMetric || query.metric || query.metrics?.[0] }, value: 10, unit: 'kb/s' }]
            }
          ]
        : [
            {
              metricValues: [
                {
                  metric: { id: query.metric || query.metrics?.[0] || 'TPIO' },
                  values: [1, 2, 3],
                  unit: 'kb/s'
                }
              ]
            }
          ],
      requestUrl: 'http://fake/overview',
      error: null
    }));

    const result = await executeOverviewModule({
      prompt: '请给我一个深入的应用整体概览',
      payload: { overviewScene: 'application', overviewDepth: 'deep' },
      intent: { goal: 'overview' },
      resolvedQuery: {
        start: 1774339020,
        end: 1776844620,
        groups: []
      },
      executeGatewayRequest
    });

    const selectedRootKeys = (result?.overview?.selectedCandidates || [])
      .filter((item) => item.role !== 'child')
      .map((item) => item.candidateId);
    const selectedChildKeys = (result?.overview?.selectedCandidates || [])
      .filter((item) => item.role === 'child')
      .map((item) => item.candidateId);

    expect(selectedRootKeys).toEqual([
      'applicationAlertSummary',
      'appDistributionTop',
      'appFailureTop'
    ]);
    expect(selectedChildKeys).toEqual([
      'appTrafficAnalysisTop',
      'appAccessTrendByTopApp',
      'appExperienceTrendByTopApp',
      'appSessionTopByTopApp'
    ]);
    expect(selectedRootKeys).not.toContain('topBusinessGroupThroughput');
    expect(selectedRootKeys).not.toContain('topApplicationThroughput');
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

  test('should prioritize focused IP analysis modules when overview has focusIpAddress', async () => {
    const executeGatewayRequest = jest.fn(async (query) => ({
      ok: true,
      service: query.service,
      data: query.service === 'timeValues'
        ? [{
            metricValues: (query.metrics || []).map((metricId) => ({
              metric: { id: metricId },
              values: [1, 2, 3],
              unit: metricId === 'RFCI' ? 'files' : 'count'
            }))
          }]
        : [{
            metricValues: (query.metrics || []).map((metricId) => ({
              metric: { id: metricId },
              value: metricId === 'RFCI' ? 2100677 : 2470337,
              unit: 'count'
            }))
          }],
      requestUrl: 'http://fake/focused-ip',
      error: null
    }));

    const result = await executeOverviewModule({
      prompt: '对 101.254.114.237 做连接失败综合分析',
      payload: { overviewScene: 'network', overviewDepth: 'deep' },
      intent: { goal: 'overview' },
      resolvedQuery: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'network',
        start: 1774339020,
        end: 1776844620,
        groups: [{ type: 'IPAddress', argument: '101.254.114.237' }],
        semanticConstraints: {
          operation: 'overview',
          anchorObject: {
            type: 'IPAddress',
            argument: '101.254.114.237'
          }
        }
      },
      executeGatewayRequest
    });

    const selectedRootKeys = (result?.overview?.selectedCandidates || [])
      .filter((item) => item.role !== 'child')
      .map((item) => item.candidateId);

    expect(selectedRootKeys).toContain('focusedIpConnectionSnapshot');
    expect(selectedRootKeys).toContain('focusedIpConnectionTrend');
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

  test('should read focus anchor from contextGroups and anchorObject.argument', () => {
    const slots = extractOverviewSlots({
      prompt: '今天应用的情况怎么样？',
      resolvedQuery: {
        groups: [{ type: 'DefinedApp' }],
        contextGroups: [{ type: 'DefinedApp', argument: '办公OA' }],
        semanticConstraints: {
          anchorObject: {
            type: 'DefinedApp',
            argument: '办公OA'
          }
        }
      }
    });

    expect(slots.focusObject).toEqual({
      type: 'DefinedApp',
      value: '办公OA'
    });
    expect(slots.slotValues.focusDefinedApp).toBe('办公OA');
    expect(slots.anchorGroups).toEqual([
      { type: 'DefinedApp', argument: '办公OA' }
    ]);
  });

  test('should inherit scoped context group into overview root query', () => {
    const compiled = compileOverviewPlan({
      overviewPlan: {
        scene: 'application',
        depth: 'standard',
        budget: { maxChildren: 0 },
        planningPolicy: {},
        slots: {
          scene: 'application',
          questionType: 'overview',
          metricCodes: ['TPIO'],
          metricDomains: ['traffic'],
          objectTypes: ['DefinedApp'],
          requestedTopCount: null,
          focusObject: { type: 'DefinedApp', value: '办公OA' },
          anchorGroups: [{ type: 'DefinedApp', argument: '办公OA' }],
          slotValues: {
            focusDefinedApp: '办公OA'
          }
        },
        selectedRootCandidates: [
          {
            score: 100,
            scoreReasons: ['test'],
            candidate: {
              id: 'topApplicationThroughput',
              label: 'Top Application Throughput',
              role: 'root',
              request: {
                service: 'topValues',
                metric: 'TPIO',
                metrics: ['TPIO'],
                groups: [{ type: 'DefinedApp' }],
                topCount: 5
              }
            }
          }
        ],
        selectedChildCandidates: [],
        skippedCandidates: []
      },
      timeRange: {
        start: 1774339020,
        end: 1776844620
      },
      seedGroups: [{ type: 'DefinedApp' }]
    });

    expect(compiled.executionItems[0].query.groups).toEqual([
      { type: 'DefinedApp', argument: '办公OA' }
    ]);
  });

  test('should normalize legacy metricDomain names into overview planner tokens', () => {
    const slots = extractOverviewSlots({
      prompt: '请给我网络质量概览',
      intent: {
        metricDomain: 'NetworkQuality',
        metricDomainCandidates: [
          { metricDomain: 'WebExperience' },
          { metricDomain: 'ApplicationPerformance' }
        ]
      },
      resolvedQuery: {
        metricDomain: 'TcpStability'
      }
    });

    expect(slots.metricDomains).toEqual(expect.arrayContaining([
      'network',
      'experience',
      'session',
      'error',
      'business',
      'application'
    ]));
  });
});
