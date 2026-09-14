'use strict';

const RuntimeMetricCapabilityService = require('../skills/openclaw-napm-query/services/RuntimeMetricCapabilityService');
const ExecutionAdmission = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutionAdmissionService');
const NapmMetadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');
const {
  SouthboundCallCounter,
  FakeNapmClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

function query(groups = [{ type: 'WebApplication' }]) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups,
    metrics: ['PGNPGE', 'PGTME'],
    topMetric: 'PGTME',
    topCount: 5,
    start: 1788937200,
    end: 1788940800
  };
}

function unknownValidation(overrides = {}) {
  return {
    ok: false,
    status: 'UNKNOWN',
    reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
    requiredRuntimeChecks: [
      {
        type: 'METRIC_CAPABILITY',
        provider: 'METRICS_FOR_GROUP',
        service: 'topValues',
        groupPathSignature: 'WebApplication',
        metricId: 'PGNPGE',
        roles: ['RETURN_METRIC']
      },
      {
        type: 'METRIC_CAPABILITY',
        provider: 'METRICS_FOR_GROUP',
        service: 'topValues',
        groupPathSignature: 'WebApplication',
        metricId: 'PGTME',
        roles: ['RETURN_METRIC', 'RANKING_METRIC']
      },
      ...([])
    ],
    ...overrides
  };
}

describe('BUG-A Phase 5 Runtime Metric Capability', () => {
  test('returns SUPPORTED and calls metricsForGroup once per exact path', async () => {
    const provider = jest.fn().mockResolvedValue({
      ok: true,
      status: 'SUPPORTED_LIST',
      supportedMetricIds: ['PGNPGE', 'PGTME']
    });
    const service = new RuntimeMetricCapabilityService({
      metadataService: { getMetricsForGroupPathEvidence: provider }
    });

    const result = await service.confirm({
      query: query(),
      staticValidation: unknownValidation()
    });

    expect(result).toMatchObject({
      status: 'SUPPORTED',
      provider: 'METRICS_FOR_GROUP',
      metadataCalls: 1
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({ metricId: 'PGNPGE', status: 'SUPPORTED' }),
      expect.objectContaining({
        metricId: 'PGTME',
        status: 'SUPPORTED',
        roles: ['RETURN_METRIC', 'RANKING_METRIC']
      })
    ]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith([{ type: 'WebApplication' }]);
  });

  test('accepts the documented capitalized Id metric field without alias repair', async () => {
    const counter = new SouthboundCallCounter();
    const originalClient = NapmMetadataService.napmClient;
    NapmMetadataService.napmClient = new FakeNapmClient({
      counter,
      responses: { metricsForGroup: [{ Id: 'PGTME', Label: 'page time' }] }
    });
    try {
      const result = await NapmMetadataService.getMetricsForGroupPathEvidence([
        { type: 'WebApplication' }
      ]);
      expect(result).toMatchObject({
        ok: true,
        status: 'SUPPORTED_LIST',
        supportedMetricIds: ['PGTME']
      });
      expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    } finally {
      NapmMetadataService.napmClient = originalClient;
    }
  });

  test('returns UNSUPPORTED for a valid empty capability list', async () => {
    const service = new RuntimeMetricCapabilityService({
      metadataService: {
        getMetricsForGroupPathEvidence: jest.fn().mockResolvedValue({
          ok: true,
          status: 'SUPPORTED_LIST',
          supportedMetricIds: []
        })
      }
    });

    await expect(service.confirm({
      query: query(),
      staticValidation: unknownValidation()
    })).resolves.toMatchObject({
      status: 'UNSUPPORTED',
      reasonCode: 'RUNTIME_METRIC_UNSUPPORTED',
      evidence: expect.arrayContaining([expect.objectContaining({ status: 'UNSUPPORTED' })])
    });
  });

  test('returns INDETERMINATE for fetch failure or malformed response', async () => {
    const provider = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 'INDETERMINATE', reasonCode: 'RUNTIME_CAPABILITY_FETCH_FAILED' });
    const service = new RuntimeMetricCapabilityService({
      metadataService: { getMetricsForGroupPathEvidence: provider }
    });

    const failed = await service.confirm({ query: query(), staticValidation: unknownValidation() });
    expect(failed).toMatchObject({ status: 'INDETERMINATE', reasonCode: 'RUNTIME_CAPABILITY_FAILURE' });

    provider.mockResolvedValueOnce({ ok: true, status: 'SUPPORTED_LIST', supportedMetricIds: null });
    const malformed = await service.confirm({ query: query(), staticValidation: unknownValidation() });
    expect(malformed).toMatchObject({ status: 'INDETERMINATE' });
  });

  test('does not handle UNKNOWN without the METRICS_FOR_GROUP provider', async () => {
    const provider = jest.fn();
    const service = new RuntimeMetricCapabilityService({
      metadataService: { getMetricsForGroupPathEvidence: provider }
    });
    const result = await service.confirm({
      query: query(),
      staticValidation: unknownValidation({
        requiredRuntimeChecks: [{
          type: 'SERVICE_CAPABILITY',
          provider: 'OTHER_PROVIDER',
          service: 'topValues',
          groupPathSignature: 'WebApplication',
          metricId: 'PGTME',
          roles: ['RANKING_METRIC']
        }]
      })
    });
    expect(result).toMatchObject({
      status: 'INDETERMINATE',
      reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNRESOLVED',
      metadataCalls: 0
    });
    expect(provider).not.toHaveBeenCalled();
  });

  test('does not mutate the canonical query while producing evidence', async () => {
    const service = new RuntimeMetricCapabilityService({
      metadataService: {
        getMetricsForGroupPathEvidence: jest.fn().mockResolvedValue({
          ok: true,
          status: 'SUPPORTED_LIST',
          supportedMetricIds: ['PGTME']
        })
      }
    });
    const original = query();
    const snapshot = JSON.parse(JSON.stringify(original));

    await service.confirm({ query: original, staticValidation: unknownValidation() });

    expect(original).toEqual(snapshot);
  });

  test('does not infer METRICS_FOR_GROUP when provider is absent', async () => {
    const provider = jest.fn();
    const service = new RuntimeMetricCapabilityService({
      metadataService: { getMetricsForGroupPathEvidence: provider }
    });
    const result = await service.confirm({
      query: query(),
      staticValidation: unknownValidation({
        requiredRuntimeChecks: [{
          type: 'METRIC_CAPABILITY',
          service: 'topValues',
          groupPathSignature: 'WebApplication',
          metricId: 'PGTME',
          roles: ['RANKING_METRIC']
        }]
      })
    });
    expect(result).toMatchObject({
      status: 'INDETERMINATE',
      reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNRESOLVED',
      metadataCalls: 0
    });
    expect(provider).not.toHaveBeenCalled();
  });

  test('keeps static VALID and static deny paths at zero runtime calls', async () => {
    const validator = {
      validate: jest.fn()
        .mockReturnValueOnce({ ok: true, status: 'VALID', reasonCode: 'EXECUTABLE_QUERY_VALID' })
        .mockReturnValueOnce({ ok: false, status: 'KNOWN_INCOMPATIBLE', reasonCode: 'OBJECT_METRIC_INCOMPATIBLE' })
    };
    const runtime = { confirm: jest.fn() };
    const admission = new ExecutionAdmission({ validator, runtimeService: runtime });

    await expect(admission.evaluate(query())).resolves.toMatchObject({
      ok: true,
      finalAdmission: 'ALLOW',
      runtimeCapability: null
    });
    await expect(admission.evaluate(query())).resolves.toMatchObject({
      ok: false,
      finalAdmission: 'DENY_STATIC',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE'
    });
    expect(runtime.confirm).not.toHaveBeenCalled();
  });

  test('maps runtime outcomes to allow, unsupported deny, and capability failure', async () => {
    const validator = {
      validate: jest.fn().mockReturnValue({
        ok: false,
        status: 'UNKNOWN',
        reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
        requiredRuntimeChecks: []
      })
    };
    const runtime = { confirm: jest.fn() };
    const admission = new ExecutionAdmission({ validator, runtimeService: runtime });

    runtime.confirm.mockResolvedValueOnce({ status: 'SUPPORTED', evidence: [], metadataCalls: 1 });
    await expect(admission.evaluate(query())).resolves.toMatchObject({
      ok: true,
      finalAdmission: 'ALLOW',
      reasonCode: 'RUNTIME_CAPABILITY_SUPPORTED'
    });
    runtime.confirm.mockResolvedValueOnce({ status: 'UNSUPPORTED', evidence: [], metadataCalls: 1 });
    await expect(admission.evaluate(query())).resolves.toMatchObject({
      ok: false,
      finalAdmission: 'DENY_RUNTIME_UNSUPPORTED',
      reasonCode: 'RUNTIME_METRIC_UNSUPPORTED'
    });
    runtime.confirm.mockResolvedValueOnce({ status: 'INDETERMINATE', evidence: [], metadataCalls: 1 });
    await expect(admission.evaluate(query())).resolves.toMatchObject({
      ok: false,
      finalAdmission: 'RUNTIME_CAPABILITY_FAILURE',
      reasonCode: 'RUNTIME_CAPABILITY_FAILURE'
    });
  });
});
