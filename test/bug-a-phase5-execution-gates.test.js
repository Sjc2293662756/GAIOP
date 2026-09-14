'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase5-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase5-test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

function query() {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'WebApplication' }],
    metrics: ['PGTME'],
    topMetric: 'PGTME',
    topCount: 5,
    start: 1788937200,
    end: 1788940800,
    format: 'json'
  };
}

describe('BUG-A Phase 5 execution gates', () => {
  let restoreClient;
  let savedBaseline;

  beforeEach(() => {
    savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
  });

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    if (savedBaseline === undefined) delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    else process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
    jest.restoreAllMocks();
  });

  test.each([
    ['Gateway', 'executeGatewayRequest'],
    ['Direct', 'executeDirectGatewayRequest']
  ])('UNKNOWN -> SUPPORTED allows %s data execution after one capability call', async (_label, method) => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({
        counter,
        responses: {
          metricsForGroup: [{ id: 'PGTME', label: 'page time' }],
          topValues: '[]'
        }
      })
    );

    const result = await RequirementParserService[method](query());

    expect(result).toMatchObject({ ok: true, service: 'topValues', data: [] });
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test.each([
    ['Gateway', 'executeGatewayRequest'],
    ['Direct', 'executeDirectGatewayRequest']
  ])('UNKNOWN -> UNSUPPORTED denies %s before data execution', async (_label, method) => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({
        counter,
        responses: {
          metricsForGroup: [],
          topValues: '[]'
        }
      })
    );

    const result = await RequirementParserService[method](query());

    expect(result).toMatchObject({
      ok: false,
      outcome: 'VALIDATION_FAILURE',
      error: { code: 'RUNTIME_METRIC_UNSUPPORTED' }
    });
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(0);
  });

  test('UNKNOWN -> INDETERMINATE fails closed without data execution', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({
        counter,
        responses: {
          metricsForGroup: new Error('capability transport failed'),
          topValues: '[]'
        }
      })
    );

    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: false,
      outcome: 'RUNTIME_CAPABILITY_FAILURE',
      error: { code: 'RUNTIME_CAPABILITY_FAILURE' }
    });
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(0);
  });
});
