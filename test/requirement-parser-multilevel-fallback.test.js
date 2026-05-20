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

describe('RequirementParserService multilevel execution fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('should fallback multilevel groups inventory to scoped topValues rows', async () => {
    jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata').mockResolvedValue({
      metricsForGroup: [
        { id: 'PGNPGE', label: 'Page hits' }
      ]
    });

    const directSpy = jest.spyOn(RequirementParserService, 'executeDirectGatewayRequest')
      .mockImplementation(async (request) => {
        if (request.service === 'topValues') {
          return {
            ok: true,
            service: 'topValues',
            data: [
              { group: { argument: '回函238web', key: 'DefinedApp' } },
              { group: { argument: 'HTTP', key: 'DefinedApp' } },
              { group: { argument: '回函238web', key: 'DefinedApp' } }
            ],
            requestUrl: 'https://example.invalid/fallback',
            requestParams: { type: 'topValues' },
            requestParamsMasked: { type: 'topValues' }
          };
        }

        return {
          ok: false,
          service: request.service,
          error: { code: 'UNEXPECTED_CALL' }
        };
      });

    const result = await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      start: 1777982400,
      end: 1777986000,
      format: 'json',
      semanticConstraints: {
        operation: 'metadata_list'
      },
      groups: [
        { type: 'BusinessGroup', argument: '服务器网段' },
        { type: 'Applications' },
        { type: 'DefinedApp' }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.service).toBe('groups');
    expect(result.data).toEqual([
      { label: '回函238web', value: '回函238web', type: 'DefinedApp' },
      { label: 'HTTP', value: 'HTTP', type: 'DefinedApp' }
    ]);
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(directSpy.mock.calls[0][0]).toMatchObject({
      service: 'topValues',
      metric: 'PGNPGE',
      topMetric: 'PGNPGE'
    });
  });

  test('should fallback multilevel averageValues to topValues when upstream path is unsupported', async () => {
    jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata').mockResolvedValue({
      metricsForGroup: [
        { id: 'PGNPGC', label: 'Page hits server' }
      ]
    });

    const directSpy = jest.spyOn(RequirementParserService, 'executeDirectGatewayRequest')
      .mockImplementation(async (request) => {
        if (request.service === 'averageValues') {
          return {
            ok: false,
            service: 'averageValues',
            error: {
              code: 'UPSTREAM_GROUP_PATH_NOT_SUPPORTED',
              message: 'NAPM upstream rejected the path BusinessGroup(服务器网段) -> Applications -> DefinedApp for averageValues queries.'
            }
          };
        }

        if (request.service === 'topValues') {
          return {
            ok: true,
            service: 'topValues',
            data: [
              { group: { argument: '回函238web', key: 'DefinedApp' }, metricValues: [] }
            ],
            requestUrl: 'https://example.invalid/topvalues',
            requestParams: { type: 'topValues' },
            requestParamsMasked: { type: 'topValues' }
          };
        }

        return {
          ok: false,
          service: request.service,
          error: { code: 'UNEXPECTED_CALL' }
        };
      });

    const result = await RequirementParserService.executeGatewayRequest({
      service: 'averageValues',
      start: 1777982400,
      end: 1777986000,
      metric: 'PGNPGC',
      metrics: ['PGNPGC'],
      format: 'json',
      groups: [
        { type: 'BusinessGroup', argument: '服务器网段' },
        { type: 'Applications' },
        { type: 'DefinedApp' }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.service).toBe('topValues');
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'MULTILEVEL_SERVICE_COMPATIBILITY_FALLBACK'
      })
    ]);
    expect(directSpy).toHaveBeenCalledTimes(2);
    expect(directSpy.mock.calls[0][0].service).toBe('averageValues');
    expect(directSpy.mock.calls[1][0]).toMatchObject({
      service: 'topValues',
      metric: 'PGNPGC',
      topMetric: 'PGNPGC'
    });
  });

  test('should not treat raw multilevel groups response as stable inventory when fallback finds no rows', async () => {
    jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata').mockResolvedValue({
      metricsForGroup: [
        { id: 'PGNPGE', label: 'Page hits' }
      ]
    });

    jest.spyOn(RequirementParserService, 'executeDirectGatewayRequest')
      .mockImplementation(async (request) => {
        if (request.service === 'topValues') {
          return {
            ok: true,
            service: 'topValues',
            data: [],
            requestUrl: 'https://example.invalid/fallback-empty',
            requestParams: { type: 'topValues' },
            requestParamsMasked: { type: 'topValues' }
          };
        }

        return {
          ok: true,
          service: 'groups',
          data: [
            { children: [{ key: 'PageFamily' }] }
          ],
          requestUrl: 'https://example.invalid/groups-raw',
          requestParams: { type: 'groups' },
          requestParamsMasked: { type: 'groups' }
        };
      });

    const result = await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      start: 1777982400,
      end: 1777986000,
      format: 'json',
      semanticConstraints: {
        operation: 'metadata_list'
      },
      groups: [
        { type: 'WebApplication', argument: '回函238web' },
        { type: 'PageFamilies' },
        { type: 'PageFamily' }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual(expect.objectContaining({
      code: 'MULTILEVEL_GROUPS_INVENTORY_NOT_EXECUTABLE'
    }));
  });
});
