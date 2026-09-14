'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'bug-a-final-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'bug-a-final-password';

const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');
const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const NapmQuerySerializer = require('../skills/openclaw-napm-query/services/NapmQuerySerializer');
const AtomicQueryRepairService = require('../skills/openclaw-napm-query/services/AtomicQueryRepairService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

const BASELINE = 'netinside-napm-web-services-20201218+api-construction-rules-0725';

function query(overrides = {}) {
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
    format: 'json',
    ...overrides
  };
}

describe('BUG-A final regression', () => {
  let restoreClient;
  let savedBaseline;

  beforeEach(() => {
    savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
  });

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    if (savedBaseline === undefined) delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    else process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
    jest.restoreAllMocks();
  });

  test('A: original slow-business Top5 resolves to WebApplication + PGTME', () => {
    const semantic = WorkflowClassifierService.classifyWorkflow('最近业务访问较慢的前5个业务都有谁？');
    const resolved = ResolverService.resolvePrompt('最近业务访问较慢的前5个业务都有谁？', { nowSeconds: 1788940800 });

    expect(semantic.semanticContract).toMatchObject({
      status: 'RESOLVED',
      operation: 'rank_top',
      targetObjectType: 'WebApplication',
      requestedMetrics: ['PGTME'],
      rankingMetric: 'PGTME',
      topCount: 5
    });
    expect(resolved.resolvedQuery).toMatchObject({
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGTME'],
      topMetric: 'PGTME',
      topCount: 5
    });
    expect(resolved.resolvedQuery.metric).toBeUndefined();
  });

  test('B: original query Static VALID executes once and becomes SUCCESS', async () => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: [{ value: 3 }] } })
    );

    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: true,
      outcome: 'SUCCESS',
      stage: 'execution',
      queryExecuted: true,
      dataRequestAttempted: true,
      dataRequestSucceeded: true,
      rowCount: 1
    });
    expect(counter.callsFor('topValues')).toHaveLength(1);
    expect(counter.callsFor('metricsForGroup')).toHaveLength(0);
  });

  test('C: WebApplication + TRTI is VALIDATION_FAILURE with zero data calls', async () => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );

    const result = await RequirementParserService.executeGatewayRequest(query({ metrics: ['TRTI'], topMetric: 'TRTI' }));

    expect(result).toMatchObject({
      ok: false,
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
      dataRequestAttempted: false
    });
    expect(counter.snapshot().total).toBe(0);
  });

  test('D: Static UNKNOWN + runtime unsupported is VALIDATION_FAILURE with no data transport', async () => {
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { metricsForGroup: [] } })
    );

    const result = await RequirementParserService.executeGatewayRequest(query({ metrics: ['TRTI'], topMetric: 'TRTI' }));

    expect(result).toMatchObject({
      ok: false,
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'RUNTIME_METRIC_UNSUPPORTED',
      runtimeCapability: { status: 'UNSUPPORTED' },
      dataRequestAttempted: false
    });
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(0);
  });

  test('E: legal empty response is NO_DATA only after a successful data call', async () => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );

    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: true,
      outcome: 'NO_DATA',
      dataRequestAttempted: true,
      dataRequestSucceeded: true,
      responseParseSucceeded: true,
      rowCount: 0
    });
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('F: network failure after data request is EXECUTION_FAILURE', async () => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: new Error('timeout') } })
    );

    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: false,
      outcome: 'EXECUTION_FAILURE',
      stage: 'execution',
      queryExecuted: true,
      dataRequestAttempted: true,
      dataRequestSucceeded: false
    });
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('G: independent topMetric remains separate in transport', () => {
    const result = NapmQuerySerializer.serialize(query({
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPI', 'TPO'],
      topMetric: 'TPIO'
    }));

    expect(result.params).toMatchObject({ metrics: 'TPI,TPO', topMetric: 'TPIO' });
    expect(result.params).not.toHaveProperty('metric');
  });

  test('H: unknown metric is VALIDATION_FAILURE without capability or data calls', async () => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );

    const result = await RequirementParserService.executeDirectGatewayRequest(query({ metrics: ['PGSUPERFAST'], topMetric: 'PGSUPERFAST' }));

    expect(result).toMatchObject({
      ok: false,
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'METRIC_UNKNOWN',
      dataRequestAttempted: false
    });
    expect(counter.snapshot().total).toBe(0);
  });

  test('I: safe duplicate-metric repair executes the repaired query once', async () => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const original = query({ groups: [{ type: 'IPAddress' }], metrics: ['TPIO', 'TPIO'], topMetric: 'TPIO' });

    const result = await RequirementParserService.executeGatewayRequest(original);

    expect(result).toMatchObject({ ok: true, outcome: 'NO_DATA', dataRequestAttempted: true });
    expect(result.requestParams.metrics).toBe('TPIO');
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('J: unsafe repair suggestion is rejected before execution', () => {
    const result = AtomicQueryRepairService.repair(query(), {
      suggestions: [{
        path: 'metrics',
        before: ['PGTME'],
        after: ['PGNPGE'],
        reasonCode: 'NORMALIZE_METRIC_ID_CASE',
        semanticImpact: 'NONE'
      }]
    });

    expect(result).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'UNSAFE_REPAIR_SUGGESTION'
    });
  });
});
