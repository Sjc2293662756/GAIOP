'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase4-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase4-test-password';

const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

function query(metricId = 'TRTI') {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    groups: [{ type: 'WebApplication' }],
    metrics: [metricId],
    topMetric: metricId,
    topCount: 5,
    start: 1788937200,
    end: 1788940800
  };
}

describe('BUG-A Phase 4 static execution gates', () => {
  let counter;
  let restoreClient;

  beforeEach(() => {
    counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );
  });

  afterEach(() => {
    restoreClient?.();
    jest.restoreAllMocks();
  });

  test('executeGatewayRequest blocks known incompatibility before metadata and data', async () => {
    const validator = jest.spyOn(Validator, 'validate');
    const metadataReview = jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata');
    const kernel = jest.spyOn(RequirementParserService.metricExecutionKernel, 'execute');

    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: false,
      outcome: 'VALIDATION_FAILURE',
      error: { code: 'OBJECT_METRIC_INCOMPATIBLE' },
      executableValidation: { status: 'KNOWN_INCOMPATIBLE' }
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(metadataReview).not.toHaveBeenCalled();
    expect(kernel).not.toHaveBeenCalled();
    expect(counter.snapshot().total).toBe(0);
  });

  test('executeDirectGatewayRequest blocks an unknown metric before Kernel and NapmClient', async () => {
    const validator = jest.spyOn(Validator, 'validate');
    const kernel = jest.spyOn(RequirementParserService.metricExecutionKernel, 'execute');

    const result = await RequirementParserService.executeDirectGatewayRequest(query('PGSUPERFAST'));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'METRIC_UNKNOWN' },
      executableValidation: { status: 'METRIC_UNKNOWN' }
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(kernel).not.toHaveBeenCalled();
    expect(counter.snapshot().total).toBe(0);
  });

  test('UNKNOWN stops before metadata, Kernel, and metricsForGroup in Phase 4', async () => {
    const savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    try {
      const metadataReview = jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata');
      const kernel = jest.spyOn(RequirementParserService.metricExecutionKernel, 'execute');
      const result = await RequirementParserService.executeGatewayRequest(query('PGTME'));

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'RUNTIME_CAPABILITY_REQUIRED' },
        executableValidation: { status: 'UNKNOWN' }
      });
      expect(metadataReview).not.toHaveBeenCalled();
      expect(kernel).not.toHaveBeenCalled();
      expect(counter.callsFor('metricsForGroup')).toHaveLength(0);
      expect(counter.snapshot().total).toBe(0);
    } finally {
      process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
    }
  });

  test('contract invalid is aggregated by the shared validator before all calls', async () => {
    const validator = jest.spyOn(Validator, 'validate');
    const invalid = query('PGTME');
    delete invalid.topMetric;

    const result = await RequirementParserService.executeGatewayRequest(invalid);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'TOP_METRIC_REQUIRED' },
      executableValidation: { status: 'CONTRACT_INVALID' }
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(counter.snapshot().total).toBe(0);
  });
});
