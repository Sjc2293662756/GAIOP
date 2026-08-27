process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://napm.test/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

jest.mock('../skills/openclaw-napm-query/services/NapmClient', () => {
  return jest.fn().mockImplementation(() => ({
    username: process.env.NETINSIDE_USERNAME,
    password: process.env.NETINSIDE_PASSWORD,
    baseUrl: process.env.NETINSIDE_HOST,
    get: jest.fn().mockResolvedValue('[]'),
    getJson: jest.fn().mockResolvedValue([])
  }));
});

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const { handleSkillCall } = require('../skills/openclaw-napm-query/scripts/run_napm_query');

function buildQuery(overrides = {}) {
  return {
    service: 'timeValues',
    queryModeKey: 'timeseries',
    groups: [{ type: 'DefinedApp' }],
    metric: 'TPIO',
    metrics: ['TPIO'],
    granularity: 86400,
    start: 1787140800,
    end: 1787745600,
    format: 'json',
    ...overrides
  };
}

describe('query argument policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('blocks an incomplete DefinedApp trend before metadata or data calls', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'GROUP_ARGUMENT_REQUIRED'
      }
    });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.getJson).not.toHaveBeenCalled();
  });

  test('blocks an incomplete DefinedApp average before metadata or data calls', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      service: 'averageValues',
      queryModeKey: 'average'
    }));

    expect(result.error?.code).toBe('GROUP_ARGUMENT_REQUIRED');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.getJson).not.toHaveBeenCalled();
  });

  test('keeps an explicit DefinedApp trend executable', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }]
    }));

    expect(result.ok).toBe(true);
    expect(result.requestParams).toMatchObject({
      groupType1: 'DefinedApp',
      groupArgument1: 'HTTP',
      numGroups: 1
    });
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test('keeps DefinedApp inventory and topValues discovery argument-optional', async () => {
    const client = RequirementParserService.napmClient;
    const inventory = await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'DefinedApp' }],
      format: 'json'
    });
    const ranking = await RequirementParserService.executeGatewayRequest({
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'DefinedApp' }],
      metric: 'TPIO',
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 10,
      start: 1787742000,
      end: 1787745600,
      format: 'json'
    });

    expect(inventory.error?.code).not.toBe('GROUP_ARGUMENT_REQUIRED');
    expect(ranking.error?.code).not.toBe('GROUP_ARGUMENT_REQUIRED');
    expect(client.get).toHaveBeenCalled();
  });

  test('rejects an argument on TotalTraffic without silently deleting it', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'TotalTraffic', argument: 'HTTP' }]
    }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'GROUP_ARGUMENT_FORBIDDEN'
      }
    });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.getJson).not.toHaveBeenCalled();
  });

  test('keeps an argument-free TotalTraffic trend executable', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'TotalTraffic' }]
    }));

    expect(result.ok).toBe(true);
    expect(result.requestParams).toMatchObject({
      groupType1: 'TotalTraffic',
      numGroups: 1
    });
    expect(result.requestParams.groupArgument1).toBeUndefined();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test('does not apply single-object argument requirements to a multi-level path', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'IPAddress' }, { type: 'DefinedApp' }]
    }));

    expect(result.error?.code).not.toBe('GROUP_ARGUMENT_REQUIRED');
    expect(client.get).toHaveBeenCalled();
  });

  test('returns a clarification contract for a missing single-object argument', async () => {
    const result = await handleSkillCall({
      prompt: '最近 7 天应用流量趋势如何？',
      resolvedQuery: buildQuery()
    });

    expect(result).toMatchObject({
      ok: false,
      responseMode: 'verbatim_display_text',
      narrationInput: {
        result: {
          narrationStructure: {
            responseType: 'decision_result'
          }
        }
      }
    });
    expect(result.displayText).toContain('具体应用名称');
  });
});
