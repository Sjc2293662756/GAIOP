'use strict';

const ExecutionOutcomeContract = require('../skills/openclaw-napm-query/services/ExecutionOutcomeContract');
const ExecutionOutcomeMapper = require('../skills/openclaw-napm-query/services/ExecutionOutcomeMapper');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const NapmQuerySerializer = require('../skills/openclaw-napm-query/services/NapmQuerySerializer');
const {
  buildOpenClawReplyContract
} = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');
const plugin = require('../napm-openclaw-plugin.remote');
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
    ...overrides
  };
}

describe('BUG-A Phase 8 unified execution outcome contract', () => {
  let restoreClient;

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    jest.restoreAllMocks();
  });

  test('defines execution outcomes separately from semantic lifecycle', () => {
    expect(Object.values(ExecutionOutcomeContract.EXECUTION_OUTCOMES)).toEqual([
      'SUCCESS',
      'NO_DATA',
      'VALIDATION_FAILURE',
      'RUNTIME_CAPABILITY_FAILURE',
      'SERIALIZATION_FAILURE',
      'EXECUTION_FAILURE'
    ]);
    expect(Object.values(ExecutionOutcomeContract.EXECUTION_OUTCOMES)).not.toEqual(
      expect.arrayContaining(['AMBIGUOUS', 'UNRESOLVED', 'UNSUPPORTED'])
    );
  });

  test.each([
    ['valid rows', { ok: true, data: [{ value: 1 }], dataRequestAttempted: true, dataRequestSucceeded: true, responseParseSucceeded: true }, 'SUCCESS', 'execution'],
    ['valid empty', { ok: true, data: [], dataRequestAttempted: true, dataRequestSucceeded: true, responseParseSucceeded: true }, 'NO_DATA', 'execution'],
    ['static validation', { ok: false, error: { code: 'OBJECT_METRIC_INCOMPATIBLE' } }, 'VALIDATION_FAILURE', 'static_validation'],
    ['runtime unsupported', { ok: false, error: { code: 'RUNTIME_METRIC_UNSUPPORTED' } }, 'VALIDATION_FAILURE', 'runtime_capability'],
    ['runtime failure', { ok: false, error: { code: 'RUNTIME_CAPABILITY_FAILURE' } }, 'RUNTIME_CAPABILITY_FAILURE', 'runtime_capability'],
    ['serialization', { ok: false, error: { code: 'SERIALIZATION_FAILURE' } }, 'SERIALIZATION_FAILURE', 'serialization'],
    ['data failure', { ok: false, error: { code: 'NAPM_UPSTREAM_ERROR' }, dataRequestAttempted: true }, 'EXECUTION_FAILURE', 'execution'],
    ['parse failure', { ok: false, error: { code: 'RESPONSE_PARSE_FAILED' }, dataRequestAttempted: true, dataRequestSucceeded: true, responseParseSucceeded: false }, 'EXECUTION_FAILURE', 'response_parse']
  ])('maps %s deterministically', (_label, result, outcome, stage) => {
    expect(ExecutionOutcomeMapper.mapResult(result)).toMatchObject({
      outcome,
      stage,
      queryExecuted: outcome === 'SUCCESS' || outcome === 'NO_DATA' || outcome === 'EXECUTION_FAILURE'
    });
  });

  test('RequirementParser marks successful rows and empty rows with execution proof', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: '[]' } })
    );
    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: true,
      outcome: 'NO_DATA',
      stage: 'execution',
      queryExecuted: true,
      dataRequestAttempted: true,
      dataRequestSucceeded: true,
      responseParseSucceeded: true,
      rowCount: 0
    });
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('RequirementParser maps serializer invariant failure before NapmClient', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );
    const serializerSpy = jest.spyOn(NapmQuerySerializer, 'serialize').mockImplementation(() => {
      const error = new Error('serializer invariant');
      error.code = 'SERIALIZATION_FAILURE';
      throw error;
    });

    const result = await RequirementParserService.executeDirectGatewayRequest(query());

    expect(result).toMatchObject({
      ok: false,
      outcome: 'SERIALIZATION_FAILURE',
      stage: 'serialization',
      queryExecuted: false,
      dataRequestAttempted: false
    });
    expect(serializerSpy).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('topValues')).toHaveLength(0);
  });

  test('maps a data transport error to EXECUTION_FAILURE after one attempted request', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: new Error('timeout') } })
    );

    const result = await RequirementParserService.executeDirectGatewayRequest(query());

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

  test('maps a malformed successful payload to response-parse EXECUTION_FAILURE', async () => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses: { topValues: 'not-json' } })
    );

    const result = await RequirementParserService.executeDirectGatewayRequest(query());

    expect(result).toMatchObject({
      ok: false,
      outcome: 'EXECUTION_FAILURE',
      stage: 'response_parse',
      queryExecuted: true,
      dataRequestAttempted: true,
      dataRequestSucceeded: true,
      responseParseSucceeded: false
    });
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('narration preserves validation outcome instead of rewriting it as no data', () => {
    const output = buildOpenClawReplyContract({
      ok: false,
      service: 'topValues',
      data: [],
      dataRequestAttempted: false,
      outcome: 'VALIDATION_FAILURE',
      stage: 'static_validation',
      error: { code: 'OBJECT_METRIC_INCOMPATIBLE', message: 'invalid object metric' },
      summary: { title: '未查到数据', empty: true, rowCount: 0 },
      responseType: 'decision_result'
    }, { forwardDisplayText: true });

    expect(output).toMatchObject({
      outcome: 'VALIDATION_FAILURE',
      queryExecuted: false,
      dataRequestAttempted: false,
      narrationInput: { outcome: 'VALIDATION_FAILURE' }
    });
    expect(output.summary.displayText).not.toContain('未查到数据');
  });

  test('does not convert a zero-call validation result into NO_DATA', () => {
    const result = ExecutionOutcomeMapper.mapResult({
      ok: false,
      data: [],
      error: { code: 'METRIC_UNKNOWN' },
      dataRequestAttempted: false
    });

    expect(result).toMatchObject({
      outcome: 'VALIDATION_FAILURE',
      queryExecuted: false,
      dataRequestAttempted: false,
      rowCount: null
    });
  });

  test('Plugin makeToolResult consumes the same structured outcome', () => {
    const toolResult = plugin.__test__.makeToolResult({
      ok: true,
      service: 'topValues',
      data: [],
      dataRequestAttempted: true,
      dataRequestSucceeded: true,
      responseParseSucceeded: true
    });

    expect(toolResult.details).toMatchObject({
      outcome: 'NO_DATA',
      queryExecuted: true,
      dataRequestAttempted: true,
      rowCount: 0
    });
    expect(toolResult.isError).toBe(false);
  });
});
