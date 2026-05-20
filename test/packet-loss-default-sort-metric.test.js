process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const { getOverviewCandidate } = require('../skills/openclaw-napm-query/scripts/OverviewCandidateRegistry');
const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');
const { buildOpenClawReplyContract } = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');

describe('packet loss ranking default sort metric', () => {
  test('should keep packet-loss topValues resolvedQuery topMetric aligned with metric by default', () => {
    const normalized = __test__.normalizeResolvedQueryShape({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      groups: [{ type: 'IPAddress' }],
      userRequirement: '现在丢包最多的客户端是谁？'
    });

    expect(normalized.metric).toBe('PLI');
    expect(normalized.metrics).toEqual(['PLI']);
    expect(normalized.topMetric).toBe('PLI');
  });

  test('should preserve explicit ranking metric from user text', () => {
    const normalized = __test__.normalizeResolvedQueryShape({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      groups: [{ type: 'IPAddress' }],
      userRequirement: '现在按丢包率排序看丢包最多的客户端是谁？'
    });

    expect(normalized.topMetric).toBe('PLI');
  });

  test('should preserve explicit non-loss topMetric already provided', () => {
    const request = RequirementParserService.normalizeTopLevelQueryShape({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'BYTIO',
      groups: [{ type: 'IPAddress' }],
      userRequirement: '看丢包最多的客户端'
    });

    expect(request.topMetric).toBe('BYTIO');
  });

  test('should keep mirrored loss topMetric when it already matches the semantic metric', () => {
    const request = RequirementParserService.normalizeTopLevelQueryShape({
      service: 'topValues',
      metric: 'PLO',
      metrics: ['PLO'],
      topMetric: 'PLO',
      groups: [{ type: 'IPAddress' }],
      userRequirement: '出方向丢包最多的客户端是谁？'
    });

    expect(request.metric).toBe('PLO');
    expect(request.topMetric).toBe('PLO');
  });

  test('overview packet-loss candidates should continue to rank by TPIO', () => {
    expect(getOverviewCandidate('packetLossInboundTop')?.request).toMatchObject({
      metrics: ['PLI'],
      topMetric: 'TPIO'
    });
    expect(getOverviewCandidate('packetLossOutboundTop')?.request).toMatchObject({
      metrics: ['PLO'],
      topMetric: 'TPIO'
    });
  });

  test('display should show default sort metric equal to packet-loss metric when user did not specify ranking metric', () => {
    const normalized = __test__.normalizeResolvedQueryShape({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      groups: [{ type: 'IPAddress' }],
      userRequirement: '现在丢包最多的客户端是谁？'
    });

    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: normalized,
      summary: {
        title: '排行结果',
        highlights: [
          `指标：${normalized.metric}`,
          `排序指标：${normalized.topMetric}`
        ],
        rowCount: 1,
        empty: false,
        topMetric: normalized.topMetric
      },
      rows: [
        { object: '111.36.57.69', values: { PLI: 15.77 }, units: { PLI: '%' } }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.explanation).toContain('PLI');
    expect(payload.summary.highlights).toContain('排序指标：PLI');
  });

  test('display should show explicit ranking metric when user specified it', () => {
    const normalized = __test__.normalizeResolvedQueryShape({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      groups: [{ type: 'IPAddress' }],
      userRequirement: '现在按丢包率排序看丢包最多的客户端是谁？'
    });

    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: normalized,
      summary: {
        title: '排行结果',
        highlights: [
          `指标：${normalized.metric}`,
          `排序指标：${normalized.topMetric}`
        ],
        rowCount: 1,
        empty: false,
        topMetric: normalized.topMetric
      },
      rows: [
        { object: '111.36.57.69', values: { PLI: 15.77 }, units: { PLI: '%' } }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(normalized.topMetric).toBe('PLI');
    expect(payload.summary.highlights).toContain('排序指标：PLI');
  });
});
