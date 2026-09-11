'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase0-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase0-test-password';

const plugin = require('../napm-openclaw-plugin.remote');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const QueryValidator = require('../skills/openclaw-napm-query/services/QueryValidator');
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

const BASE_QUERY = Object.freeze({
  schemaVersion: 'napm-resolved-query.v1',
  service: 'topValues',
  queryModeKey: 'topn',
  groups: [{ type: 'WebApplication' }],
  topCount: 5,
  start: 1788937200,
  end: 1788940800,
  format: 'json'
});

function buildQuery(fields) {
  return {
    ...BASE_QUERY,
    groups: BASE_QUERY.groups.map((group) => ({ ...group })),
    ...fields
  };
}

const CASES = {
  official: buildQuery({
    metrics: ['PGNPGE', 'PGHTTP500'],
    topMetric: 'PGTME'
  }),
  legacy: buildQuery({
    metric: 'PGTME'
  }),
  conflict: buildQuery({
    metrics: ['PGTME'],
    topMetric: 'PGTME',
    metric: 'TRTI'
  }),
  multi: buildQuery({
    metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
    topMetric: 'PGTME'
  })
};

describe('BUG-A Phase 0 metric characterization migrated by Phase 3', () => {
  let restoreClient = null;

  function installFake() {
    const counter = new SouthboundCallCounter();
    const client = new FakeNapmClient({ counter });
    restoreClient = installRequirementParserFakeClient(RequirementParserService, client);
    return counter;
  }

  afterEach(() => {
    if (restoreClient) {
      restoreClient();
      restoreClient = null;
    }
    jest.restoreAllMocks();
  });

  test('plugin accepts the official independent sorting metric contract', () => {
    const result = plugin.__test__.validateResolvedQueryAgainstSpec(CASES.official);

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        topMetric: 'PGTME',
        metrics: ['PGNPGE', 'PGHTTP500']
      }
    });
    expect(result.resolvedQuery.metric).toBeUndefined();
  });

  test('plugin adapts a legacy-only metric at the explicit input boundary', () => {
    const prepared = plugin.__test__.prepareSkillExecutionArgs({ resolvedQuery: CASES.legacy });

    expect(prepared).toMatchObject({
      resolvedQuery: {
        metrics: ['PGTME'],
        topMetric: 'PGTME'
      }
    });
    expect(prepared.resolvedQuery.metric).toBeUndefined();
  });

  test('plugin rejects conflicting legacy and canonical roles deterministically', () => {
    const prepared = plugin.__test__.prepareSkillExecutionArgs({ resolvedQuery: CASES.conflict });
    const result = plugin.__test__.validatePreparedResolvedQuery(prepared);

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'LEGACY_METRIC_CONFLICT',
      resolvedQuery: null
    });
  });

  test('plugin keeps a canonical multi-metric query free of singular metric', () => {
    const result = plugin.__test__.validateResolvedQueryAgainstSpec(CASES.multi);

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
        topMetric: 'PGTME'
      }
    });
    expect(result.resolvedQuery.metric).toBeUndefined();
  });

  test.each([
    ['official shape', CASES.official, true, null],
    ['multi metric', CASES.multi, true, null],
    ['legacy field at canonical validator', CASES.legacy, false, 'METRIC_FORBIDDEN'],
    ['conflicting legacy field at canonical validator', CASES.conflict, false, 'METRIC_FORBIDDEN']
  ])(
    'QueryValidator consumes the shared canonical contract: %s',
    (_label, input, expectedOk, expectedReasonCode) => {
      const mutableInput = JSON.parse(JSON.stringify(input));
      let observedError = null;
      try {
        QueryValidator.validateGatewayRequest(mutableInput);
      } catch (error) {
        observedError = error;
      }

      expect(observedError === null).toBe(expectedOk);
      if (expectedReasonCode) {
        expect(observedError).toMatchObject({
          code: 'QUERY_SHAPE_INVALID',
          details: { reasonCodes: [expectedReasonCode] }
        });
      }
    }
  );

  test.each([
    [
      'official shape',
      CASES.official,
      { metrics: ['PGNPGE', 'PGHTTP500'], topMetric: 'PGTME' }
    ],
    [
      'multi metric',
      CASES.multi,
      { metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'], topMetric: 'PGTME' }
    ]
  ])(
    'metadata constraint preserves canonical metric roles: %s',
    (_label, input, expected) => {
      const result = QueryMetadataConstraintService.constrain(input, '');

      expect(result.query.metrics).toEqual(expected.metrics);
      expect(result.query.topMetric).toBe(expected.topMetric);
      expect(result.query.metric).toBeUndefined();
    }
  );

  test.each([
    ['official shape', CASES.official, 'PGTME', 'PGNPGE,PGHTTP500'],
    ['legacy-only metric', CASES.legacy, 'PGTME', 'PGTME'],
    ['multi metric', CASES.multi, 'PGTME', 'PGNPGE,PGTME,PGHTTP500']
  ])(
    'gateway and kernel emit the canonical wire roles: %s',
    async (_label, input, expectedTopMetric, expectedMetrics) => {
      const counter = installFake();

      const result = await RequirementParserService.executeGatewayRequest(input);

      expect(result).toMatchObject({
        ok: true,
        requestParams: {
          type: 'topValues',
          topMetric: expectedTopMetric,
          metrics: expectedMetrics
        }
      });
      expect(counter.callsFor('topValues')).toHaveLength(1);
      expect(counter.snapshot().total).toBe(2);
    }
  );

  test('gateway rejects conflicting legacy input before southbound calls', async () => {
    const counter = installFake();
    const result = await RequirementParserService.executeGatewayRequest(CASES.conflict);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'LEGACY_METRIC_CONFLICT' },
      requestParams: null
    });
    expect(counter.snapshot().total).toBe(0);
  });

  test.each([
    ['official shape', CASES.official],
    ['multi metric', CASES.multi]
  ])(
    'direct execution accepts canonical %s',
    async (_label, input) => {
      const counter = installFake();

      const result = await RequirementParserService.executeDirectGatewayRequest(input);

      expect(result).toMatchObject({
        ok: true,
        requestParams: { type: 'topValues' }
      });
      expect(counter.callsFor('topValues')).toHaveLength(1);
    }
  );
});
