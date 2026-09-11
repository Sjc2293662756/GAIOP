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
    schemaVersion: 'napm-resolved-query.v1',
    service: 'timeValues',
    queryModeKey: 'timeseries',
    groups: [{ type: 'DefinedApp' }],
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
      queryModeKey: 'average',
      granularity: undefined
    }));

    expect(result.error?.code).toBe('GROUP_ARGUMENT_REQUIRED');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.getJson).not.toHaveBeenCalled();
  });

  test('executes an explicit DefinedApp trend with Phase 4 coverage', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }]
    }));

    expect(result).toMatchObject({ ok: true });
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
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 10,
      start: 1787742000,
      end: 1787745600,
      format: 'json'
    });

    expect(inventory.error?.code).not.toBe('GROUP_ARGUMENT_REQUIRED');
    expect(ranking).toMatchObject({ ok: true });
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

  test('executes an argument-free TotalTraffic trend with Phase 4 coverage', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'TotalTraffic' }]
    }));

    expect(result).toMatchObject({ ok: true });
  });

  test('does not confuse UNKNOWN multi-level capability with argument requirements', async () => {
    const client = RequirementParserService.napmClient;
    const result = await RequirementParserService.executeGatewayRequest(buildQuery({
      groups: [{ type: 'IPAddress' }, { type: 'DefinedApp' }]
    }));

    expect(result.error?.code).not.toBe('GROUP_ARGUMENT_REQUIRED');
    expect(result.error?.code).toBe('RUNTIME_CAPABILITY_REQUIRED');
    expect(client.get).not.toHaveBeenCalled();
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
