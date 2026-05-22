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
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');

describe('execution boundary repair policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('should preserve explicit multilevel path without path repair permission', () => {
    const request = RequirementParserService.normalizeTopLevelQueryShape({
      service: 'groups',
      groups: [
        { type: 'IPAddress', argument: '192.0.2.10' },
        { type: 'Applications' },
        { type: 'DefinedApp' }
      ],
      userRequirement: 'show applications for 192.0.2.10'
    });

    expect(request.groups.map((group) => group.type)).toEqual([
      'IPAddress',
      'Applications',
      'DefinedApp'
    ]);
    expect(request.pathPlanning).toBeUndefined();
  });

  test('should apply static path repair only when explicitly allowed', () => {
    const request = RequirementParserService.normalizeTopLevelQueryShape({
      service: 'groups',
      executionOptions: {
        allowPathRepair: true
      },
      groups: [
        { type: 'WebApplication', argument: 'demo-web' }
      ],
      userRequirement: 'show page family for this web application'
    });

    expect(request.groups.map((group) => group.type)).toEqual([
      'WebApplication',
      'PageFamilies',
      'PageFamily'
    ]);
    expect(request.pathPlanning.selectedPath).toEqual([
      'WebApplication',
      'PageFamilies',
      'PageFamily'
    ]);
  });

  test('should not fallback missing metric or groups without metadata repair permission', () => {
    const result = QueryMetadataConstraintService.constrain({
      service: 'topValues',
      topCount: 10
    }, 'top ip');

    expect(result.query.metric).toBeUndefined();
    expect(result.query.metrics).toBeUndefined();
    expect(result.query.groups).toBeUndefined();
    expect(result.warnings).toContain('missing_groups_without_repair');
  });

  test('should allow legacy metadata repair only when explicitly allowed', () => {
    const result = QueryMetadataConstraintService.constrain({
      service: 'topValues',
      topCount: 10,
      executionOptions: {
        allowMetadataRepair: true
      }
    }, 'top ip');

    expect(result.query.metric).toBe('TPIO');
    expect(result.query.metrics).toEqual(['TPIO']);
    expect(result.query.groups).toEqual([{ type: 'IPAddress' }]);
  });

  test('should not run multilevel inventory fallback unless explicitly allowed', async () => {
    jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata').mockResolvedValue({
      metricsForGroup: [
        { id: 'PGNPGE', label: 'Page hits' }
      ]
    });

    const directSpy = jest.spyOn(RequirementParserService, 'executeDirectGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'groups',
        data: [],
        requestParams: { type: 'groups' },
        requestParamsMasked: { type: 'groups' }
      });

    await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      start: 1777982400,
      end: 1777986000,
      format: 'json',
      semanticConstraints: {
        operation: 'metadata_list'
      },
      groups: [
        { type: 'BusinessGroup', argument: 'server-segment' },
        { type: 'Applications' },
        { type: 'DefinedApp' }
      ]
    });

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(directSpy.mock.calls[0][0].service).toBe('groups');
  });
});
