'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase6-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase6-test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
const Contract = require('../skills/openclaw-napm-query/services/ResolvedQueryContract');
const ExecutionAdmission = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutionAdmissionService');
const AtomicQueryRepairService = require('../skills/openclaw-napm-query/services/AtomicQueryRepairService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

function query(overrides = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'IPAddress' }],
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5,
    start: 1788937200,
    end: 1788940800,
    format: 'json',
    ...overrides
  };
}

describe('BUG-A Phase 6 execution repair and revalidation', () => {
  let restoreClient;

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    jest.restoreAllMocks();
  });

  test('repairs a missing derived queryModeKey before execution and keeps input immutable', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const original = query({ queryModeKey: undefined });
    const snapshot = JSON.parse(JSON.stringify(original));
    const validator = jest.spyOn(Validator, 'validate');

    const result = await RequirementParserService.executeDirectGatewayRequest(original);

    expect(result).toMatchObject({ ok: true, service: 'topValues' });
    expect(result.requestParams.type).toBe('topValues');
    expect(original).toEqual(snapshot);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('repairs duplicate metrics once and sends the repaired canonical set', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const original = query({ metrics: ['TPIO', 'TPIO'] });
    const snapshot = JSON.parse(JSON.stringify(original));

    const result = await RequirementParserService.executeGatewayRequest(original);

    expect(result).toMatchObject({ ok: true });
    expect(result.requestParams.metrics).toBe('TPIO');
    expect(original).toEqual(snapshot);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('rejects a conflicting queryModeKey without metadata or data calls', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );

    const result = await RequirementParserService.executeGatewayRequest(query({
      queryModeKey: 'timeseries'
    }));

    expect(result).toMatchObject({
      ok: false,
      outcome: 'VALIDATION_FAILURE',
      error: { code: 'QUERY_MODE_CONFLICT' }
    });
    expect(counter.snapshot().total).toBe(0);
  });

  test('does not repair a valid query with no data', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({ ok: true, data: [] });
    expect(result.repair?.repairApplied).not.toBe(true);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('revalidates a repaired candidate through Contract and Static Validator', async () => {
    const candidate = query({ queryModeKey: 'topn', metrics: ['TPIO'] });
    const validator = {
      validate: jest.fn().mockReturnValue({
        ok: false,
        status: 'KNOWN_INCOMPATIBLE',
        reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
        issues: []
      })
    };
    const repairService = {
      repair: jest.fn().mockReturnValue({
        status: 'REPAIR_APPLIED',
        repairApplied: true,
        query: candidate,
        changes: [{
          path: 'groups[0].argument',
          before: undefined,
          after: '10.0.0.1',
          reasonCode: 'NORMALIZE_GROUP_ARGUMENT',
          source: 'test',
          semanticImpact: 'NONE'
        }]
      })
    };
    const admission = new ExecutionAdmission({ validator, repairService, runtimeService: { confirm: jest.fn() } });
    const contractSpy = jest.spyOn(Contract, 'validateShape');

    const result = await admission.evaluate(query(), { phase: 'execution' });

    expect(result).toMatchObject({
      ok: false,
      finalAdmission: 'DENY_STATIC',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
      postRepairValidation: { ok: true }
    });
    expect(contractSpy).toHaveBeenCalledWith(candidate, { phase: 'execution' });
    expect(validator.validate).toHaveBeenCalledWith(candidate, expect.any(Object));
    expect(result.runtimeCapability).toBeNull();
  });

  test('fails closed when repair produces an invalid canonical candidate', async () => {
    const invalidCandidate = query({ queryModeKey: 'timeseries' });
    const validator = { validate: jest.fn() };
    const runtime = { confirm: jest.fn() };
    const admission = new ExecutionAdmission({
      validator,
      runtimeService: runtime,
      repairService: {
        repair: jest.fn().mockReturnValue({
          status: 'REPAIR_APPLIED',
          repairApplied: true,
          query: invalidCandidate,
          changes: []
        })
      }
    });

    await expect(admission.evaluate(query())).resolves.toMatchObject({
      ok: false,
      reasonCode: 'POST_REPAIR_VALIDATION_FAILED',
      finalAdmission: 'DENY_STATIC'
    });
    expect(validator.validate).not.toHaveBeenCalled();
    expect(runtime.confirm).not.toHaveBeenCalled();
  });

  test('rechecks runtime capability with the repaired candidate and never reuses old evidence', async () => {
    const repaired = query({ groups: [{ type: 'WebApplication', argument: 'HTTP' }] });
    const validator = {
      validate: jest.fn().mockReturnValue({
        ok: false,
        status: 'UNKNOWN',
        reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
        requiredRuntimeChecks: [{
          type: 'METRIC_CAPABILITY',
          provider: 'METRICS_FOR_GROUP',
          service: 'topValues',
          groupPathSignature: 'WebApplication',
          metricId: 'PGTME',
          roles: ['RANKING_METRIC']
        }]
      })
    };
    const runtime = {
      confirm: jest.fn().mockResolvedValue({
        status: 'SUPPORTED',
        metadataCalls: 1,
        evidence: []
      })
    };
    const repairService = {
      repair: jest.fn().mockReturnValue({
        status: 'REPAIR_APPLIED',
        repairApplied: true,
        query: repaired,
        changes: [{
          path: 'groups[0].argument',
          before: undefined,
          after: 'HTTP',
          reasonCode: 'NORMALIZE_GROUP_ARGUMENT',
          source: 'test',
          semanticImpact: 'NONE'
        }]
      })
    };
    const admission = new ExecutionAdmission({ validator, repairService, runtimeService: runtime });

    const first = await admission.evaluate(query());
    const second = await admission.evaluate(query());

    expect(first).toMatchObject({ ok: true, finalAdmission: 'ALLOW', query: repaired });
    expect(second).toMatchObject({ ok: true, finalAdmission: 'ALLOW', query: repaired });
    expect(runtime.confirm).toHaveBeenCalledTimes(2);
    expect(runtime.confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ query: repaired }));
    expect(runtime.confirm).toHaveBeenNthCalledWith(2, expect.objectContaining({ query: repaired }));
  });

  test('invalidates a prepared proof when the query fingerprint changes', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const prepared = query();
    RequirementParserService.executableValidationProofs.set(
      prepared,
      AtomicQueryRepairService.fingerprint(prepared)
    );
    prepared.topMetric = 'BYTIO';
    const admissionSpy = jest.spyOn(RequirementParserService, 'evaluateExecutableQueryAdmission');

    const result = await RequirementParserService.executeDirectGatewayRequest(prepared);

    expect(result).toMatchObject({ ok: true, service: 'topValues' });
    expect(admissionSpy).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });
});
