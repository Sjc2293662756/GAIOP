process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
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
const NapmMetadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');

describe('execution kernel stability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('should execute topValues metric-only request without metrics.join crash', async () => {
    const result = await RequirementParserService.executeDirectGatewayRequest({
      service: 'topValues',
      start: 1779413040,
      end: 1779499440,
      metric: 'PLI',
      topMetric: 'PLI',
      topCount: 10,
      groups: [{ type: 'IPAddress' }]
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.requestParams).toMatchObject({
      type: 'topValues',
      metrics: 'PLI',
      topMetric: 'PLI',
      topCount: 10,
      groupType1: 'IPAddress',
      numGroups: 1
    });
  });

  test('should return QUERY_SHAPE_INVALID instead of TypeError when metrics cannot be derived', async () => {
    const result = await RequirementParserService.executeDirectGatewayRequest({
      service: 'averageValues',
      start: 1779413040,
      end: 1779499440,
      groups: [{ type: 'IPAddress' }]
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'QUERY_SHAPE_INVALID'
    });
    expect(result.error.message).toContain('Metrics array is required');
  });

  test('should keep PageFamily groupArguments argumentType errors as metadata contract errors', async () => {
    jest.spyOn(NapmMetadataService, 'getGroupDefinition').mockResolvedValue({
      key: 'PageFamily',
      hasArgument: true
    });

    const result = await RequirementParserService.executeDirectGatewayRequest({
      service: 'groups',
      start: 1779413040,
      end: 1779499440,
      groups: [{ type: 'PageFamily' }]
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'METADATA_ARGUMENT_TYPE_UNRESOLVED',
      details: {
        requestedObjectType: 'PageFamily',
        effectiveObjectType: 'PageFamily',
        providerType: 'groupArguments'
      }
    });
  });

  test('should expose dependency contract self-check for ownership helpers', () => {
    expect(RequirementParserService.assertDependencyContracts()).toBe(true);
  });
});
