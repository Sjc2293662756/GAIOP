'use strict';

const NapmQuerySerializer = require('../skills/openclaw-napm-query/services/NapmQuerySerializer');
const MetricExecutionKernel = require('../skills/openclaw-napm-query/services/MetricExecutionKernel');

const TIME = {
  start: 1788937200,
  end: 1788940800
};

function baseQuery(overrides = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'WebApplication', argument: 'HTTP' }],
    metrics: ['TPO', 'TPI'],
    topMetric: 'TPIO',
    topCount: 5,
    ...TIME,
    ...overrides
  };
}

describe('BUG-A Phase 7 NAPM serializer contract', () => {
  test('serializes topValues with independent topMetric and preserves metric order', () => {
    const query = baseQuery({
      repairApplied: true,
      repairAudit: { beforeFingerprint: 'secret' },
      runtimeCapability: { status: 'SUPPORTED' }
    });
    const snapshot = JSON.parse(JSON.stringify(query));

    const result = NapmQuerySerializer.serialize(query);

    expect(result).toEqual({
      service: 'topValues',
      params: {
        type: 'topValues',
        start: TIME.start,
        end: TIME.end,
        json: 'true',
        metrics: 'TPO,TPI',
        topMetric: 'TPIO',
        topCount: 5,
        groupType1: 'WebApplication',
        groupArgument1: 'HTTP',
        numGroups: 1
      }
    });
    expect(result.params).not.toHaveProperty('metric');
    expect(result.params).not.toHaveProperty('schemaVersion');
    expect(result.params).not.toHaveProperty('queryModeKey');
    expect(result.params).not.toHaveProperty('runtimeCapability');
    expect(query).toEqual(snapshot);
  });

  test('serializes averageValues without ranking fields', () => {
    const result = NapmQuerySerializer.serialize(baseQuery({
      service: 'averageValues',
      queryModeKey: 'average',
      metrics: ['PGTME', 'PGNPGE'],
      topMetric: undefined,
      topCount: undefined
    }));

    expect(result.params).toMatchObject({
      type: 'averageValues',
      metrics: 'PGTME,PGNPGE',
      start: TIME.start,
      end: TIME.end
    });
    expect(result.params).not.toHaveProperty('topMetric');
    expect(result.params).not.toHaveProperty('topCount');
  });

  test('serializes timeValues with canonical granularity only', () => {
    const result = NapmQuerySerializer.serialize(baseQuery({
      service: 'timeValues',
      queryModeKey: 'timeseries',
      metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      topMetric: undefined,
      topCount: undefined,
      granularity: 300
    }));

    expect(result.params).toMatchObject({
      type: 'timeValues',
      metrics: 'PGNPGE,PGTME,PGHTTP500',
      granularity: 300
    });
    expect(result.params).not.toHaveProperty('topMetric');
    expect(result.params).not.toHaveProperty('topCount');
    expect(result.params).not.toHaveProperty('metric');
  });

  test('keeps pageViews on its independent detail contract', () => {
    const result = NapmQuerySerializer.serialize({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'pageViews',
      queryModeKey: 'detail',
      pageFamilyId: '8573007',
      maxLimit: 20,
      ...TIME
    });

    expect(result.params).toEqual({
      type: 'pageViews',
      start: TIME.start,
      end: TIME.end,
      json: 'true',
      pageFamilyId: '8573007',
      maxLimit: 20
    });
    expect(result.params).not.toHaveProperty('metrics');
    expect(result.params).not.toHaveProperty('topMetric');
  });

  test.each([
    ['legacy metric', { metric: 'PGTME' }, 'SERIALIZATION_FAILURE'],
    ['unsupported service', { service: 'groups' }, 'SERIALIZER_SERVICE_UNSUPPORTED'],
    ['missing topCount', { topCount: undefined }, 'SERIALIZATION_FAILURE']
  ])('fails closed for %s without transport calls', (_label, overrides, code) => {
    expect(() => NapmQuerySerializer.serialize(baseQuery(overrides))).toThrow(
      expect.objectContaining({ code })
    );
  });

  test('MetricExecutionKernel consumes only serializer output', async () => {
    const query = baseQuery();
    const serializer = {
      serialize: jest.fn().mockReturnValue({
        service: 'topValues',
        params: {
          type: 'topValues',
          start: TIME.start,
          end: TIME.end,
          json: 'true',
          metrics: 'TPO,TPI',
          topMetric: 'TPIO',
          topCount: 5,
          groupType1: 'WebApplication',
          groupArgument1: 'HTTP',
          numGroups: 1
        }
      })
    };
    const client = {
      username: 'user',
      password: 'password',
      baseUrl: 'https://example.invalid/webservice/NetInside',
      get: jest.fn().mockResolvedValue('[]')
    };
    const kernel = new MetricExecutionKernel({
      napmClient: client,
      queryValidator: { validateGatewayRequest: jest.fn() },
      serializer,
      parseNapmPayload: () => []
    });
    const response = { ok: false, data: null };

    await kernel.execute(query, {
      response,
      buildGatewayRequestSummary: () => ({ service: 'topValues' }),
      buildExecutionDataSummary: () => ({})
    });

    expect(serializer.serialize).toHaveBeenCalledWith(query);
    expect(client.get).toHaveBeenCalledWith(expect.objectContaining({
      metrics: 'TPO,TPI',
      topMetric: 'TPIO',
      topCount: 5
    }));
    expect(client.get.mock.calls[0][0]).not.toHaveProperty('metric');
    expect(query).toEqual(baseQuery());
  });
});
