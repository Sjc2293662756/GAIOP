'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase41-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase41-test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
const {
  DOCUMENTED_PRODUCT_BASELINE
} = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');
const OverviewExecution = require('../skills/openclaw-napm-query/scripts/OverviewExecution');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

const START_SECONDS = 1788937200;
const END_SECONDS = 1788940800;

function buildValidQuery(overrides = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'IPAddress' }],
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5,
    start: START_SECONDS,
    end: END_SECONDS,
    format: 'json',
    ...overrides
  };
}

describe('BUG-A Phase 4.1 static gate verification', () => {
  let restoreClient;

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    jest.restoreAllMocks();
  });

  test('checks Metric Catalog existence before ownership classification', () => {
    jest.resetModules();
    const ownership = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');
    const classify = jest.spyOn(ownership, 'classifyObjectMetricCompatibility');
    const mapping = require('../skills/openclaw-napm-query/services/MetricMappingService');
    const isValidMetricCode = jest.spyOn(mapping, 'isValidMetricCode');
    const freshValidator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');

    const result = freshValidator.validate(buildValidQuery({
      metrics: ['PGTME', 'PGSUPERFAST'],
      topMetric: 'PGTME'
    }), { productBaseline: DOCUMENTED_PRODUCT_BASELINE });

    expect(result).toMatchObject({
      status: 'METRIC_UNKNOWN',
      reasonCode: 'METRIC_UNKNOWN',
      issues: [expect.objectContaining({
        field: 'metrics[1]',
        metricId: 'PGSUPERFAST'
      })]
    });
    expect(isValidMetricCode).toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  test('revalidates a consumed prepared proof on same-instance replay', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const captured = {};
    const direct = RequirementParserService.executeDirectGatewayRequest.bind(RequirementParserService);
    jest.spyOn(RequirementParserService, 'executeDirectGatewayRequest').mockImplementation(
      async (query, context) => {
        captured.query = query;
        return direct(query, context);
      }
    );
    const first = await RequirementParserService.executeGatewayRequest(buildValidQuery());
    const admission = jest.spyOn(RequirementParserService, 'evaluateExecutableQueryAdmission');
    const second = await direct(captured.query);

    expect(first).toMatchObject({ ok: true, service: 'topValues' });
    expect(second).toMatchObject({ ok: true, service: 'topValues' });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('topValues')).toHaveLength(2);
  });

  test('does not trust an externally forged prepared marker', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );
    const admission = jest.spyOn(RequirementParserService, 'evaluateExecutableQueryAdmission');

    const result = await RequirementParserService.executeDirectGatewayRequest({
      ...buildValidQuery({
        groups: [{ type: 'WebApplication' }],
        metrics: ['TRTI'],
        topMetric: 'TRTI'
      }),
      prepared: true,
      proof: 'serialized-proof'
    });

    expect(result).toMatchObject({
      ok: false,
       error: { code: 'OBJECT_METRIC_INCOMPATIBLE' }
    });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(counter.snapshot().total).toBe(0);
  });

  test('does not accept a prepared proof across parser instances', async () => {
    const savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    const parserA = new RequirementParserService.constructor();
    const parserB = new RequirementParserService.constructor();
    const captured = {};
    const parserACounter = new SouthboundCallCounter();
    const parserBCounter = new SouthboundCallCounter();
    const restoreParserB = installRequirementParserFakeClient(
      parserB,
      new FakeNapmClient({ counter: parserBCounter })
    );
    const restoreParserA = installRequirementParserFakeClient(
      parserA,
      new FakeNapmClient({
        counter: parserACounter,
        responses: {
          metricsForGroup: [{ id: 'TPIO' }, { id: 'PGTME' }],
          topValues: []
        }
      })
    );
    jest.spyOn(parserA, 'reviewGatewayRequestMetadata').mockResolvedValue(null);
    jest.spyOn(parserA, 'executeDirectGatewayRequest').mockImplementation(async (query) => {
      captured.query = query;
      return { ok: true, service: query.service, data: [] };
    });
    const parserBValidation = jest.spyOn(parserB, 'evaluateExecutableQueryAdmission');
    jest.spyOn(parserB.metricExecutionKernel, 'execute').mockResolvedValue({ ok: true, data: [] });

    await parserA.executeGatewayRequest(buildValidQuery());
    captured.query.groups = [{ type: 'WebApplication' }];
    captured.query.metrics = ['TRTI'];
    captured.query.topMetric = 'TRTI';

    const result = await parserB.executeDirectGatewayRequest(captured.query);

    expect(result).toMatchObject({
      ok: false,
       error: { code: 'RUNTIME_METRIC_UNSUPPORTED' }
    });
    expect(parserBValidation).toHaveBeenCalledTimes(1);
    expect(parserACounter.callsFor('metricsForGroup')).toHaveLength(2);
    expect(parserACounter.callsFor('topValues')).toHaveLength(0);
    expect(parserACounter.snapshot().total).toBe(2);
    expect(parserBCounter.snapshot().total).toBe(0);
    restoreParserA();
    restoreParserB();
    if (savedBaseline === undefined) delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    else process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
  });

  test('blocks an invalid overview child through the same Gateway gate', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({
        counter,
        responses: {
          topValues: ({ params }) => params.groupType1 === 'IPAddress'
            ? [{ IPAddress: '10.0.0.1', TPIO: '1' }]
            : []
        }
      })
    );
    const kernel = jest.spyOn(RequirementParserService.metricExecutionKernel, 'execute');

    const result = await OverviewExecution.executeOverviewPlan({
      compiledPlan: {
        scene: 'verification',
        depth: 'deep',
        budget: { maxChildren: 1, maxRetriesPerQuery: 0, timeoutMs: 0 },
        selectedCandidates: [],
        skippedCandidates: [],
        executionItems: [{
          candidateId: 'root',
          planId: 'phase41',
          label: 'root',
          role: 'root',
          query: buildValidQuery(),
          childPlans: [{
            candidateId: 'invalid-child',
            planId: 'phase41',
            label: 'invalid child',
            role: 'child',
            parentCandidateId: 'root',
            querySeed: buildValidQuery({
              groups: [{ type: 'WebApplication' }],
              metrics: ['TRTI'],
              topMetric: 'TRTI'
            }),
            deriveArgument: { targetParam: 'groupArgument1' },
            maxChildQueries: 1
          }]
        }]
      },
      executeGatewayRequest: (query) => RequirementParserService.executeGatewayRequest(query),
      extractTopGroupValues: (rows) => rows.map((row) => row.IPAddress).filter(Boolean),
      applyArgumentByTargetParam: (groups, _targetParam, value) => {
        groups[0].argument = value;
      }
    });

    const child = result.executionItems[0].children[0];
    expect(child).toMatchObject({
      ok: false,
      error: { code: 'OBJECT_METRIC_INCOMPATIBLE' }
    });
    expect(kernel).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });
});
