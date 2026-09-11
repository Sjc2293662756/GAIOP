'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase0-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase0-test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const QueryDecisionPolicy = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');
const ExecutionFailureClassifier = require('../skills/openclaw-napm-query/services/ExecutionFailureClassifier');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

const START_SECONDS = 1788937200;
const END_SECONDS = 1788940800;

function buildWebApplicationTrtiQuery(metricId = 'TRTI') {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'WebApplication' }],
    metrics: [metricId],
    topMetric: metricId,
    topCount: 5,
    start: START_SECONDS,
    end: END_SECONDS,
    format: 'json',
    userRequirement: '最近业务访问较慢的前5个业务都有谁？'
  };
}

describe('BUG-A Phase 0 execution and southbound characterization baseline', () => {
  let restoreClient = null;

  function installFake(responses = {}) {
    const counter = new SouthboundCallCounter();
    const client = new FakeNapmClient({ counter, responses });
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

  test('baseline_southbound_counter_records_all_required_metadata_and_data_services', async () => {
    const counter = new SouthboundCallCounter();
    const client = new FakeNapmClient({ counter });
    const metadataServices = [
      'applications',
      'businessGroups',
      'groups',
      'groupArguments',
      'metrics',
      'metricsForGroup',
      'granularities'
    ];
    const dataServices = ['topValues', 'averageValues', 'timeValues', 'pageViews'];

    for (const type of metadataServices) {
      await client.getJson({ type });
    }
    for (const type of dataServices) {
      await client.get({ type });
    }

    expect(counter.snapshot()).toEqual({
      total: 11,
      metadata: Object.fromEntries(metadataServices.map((type) => [type, 1])),
      data: Object.fromEntries(dataServices.map((type) => [type, 1]))
    });
  });

  test('Phase 4 executeGatewayRequest blocks static incompatibility before metadata', async () => {
    const counter = installFake();
    const policySpy = jest.spyOn(QueryDecisionPolicy, 'evaluateQueryDecision');
    const constraintSpy = jest.spyOn(QueryMetadataConstraintService, 'constrain');
    const metadataReviewSpy = jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata');

    const result = await RequirementParserService.executeGatewayRequest(
      buildWebApplicationTrtiQuery()
    );

    expect(policySpy).not.toHaveBeenCalled();
    expect(constraintSpy).not.toHaveBeenCalled();
    expect(metadataReviewSpy).not.toHaveBeenCalled();
    expect(counter.snapshot().total).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      service: 'topValues',
      data: [],
      error: { code: 'OBJECT_METRIC_INCOMPATIBLE' },
      requestParams: null
    });
  });

  test('baseline_current_metadata_review_still_calls_applications_and_metricsForGroup_for_static_incompatibility', async () => {
    const counter = installFake();

    const review = await RequirementParserService.reviewGatewayRequestMetadata(
      buildWebApplicationTrtiQuery()
    );

    expect(review).toBeTruthy();
    expect(counter.snapshot()).toEqual({
      total: 2,
      metadata: {
        applications: 1,
        businessGroups: 0,
        groups: 0,
        groupArguments: 0,
        metrics: 0,
        metricsForGroup: 1,
        granularities: 0
      },
      data: {
        topValues: 0,
        averageValues: 0,
        timeValues: 0,
        pageViews: 0
      }
    });
  });

  test('Phase 4 direct execution blocks static incompatibility before Kernel', async () => {
    const counter = installFake();
    const policySpy = jest.spyOn(QueryDecisionPolicy, 'evaluateQueryDecision');
    const constraintSpy = jest.spyOn(QueryMetadataConstraintService, 'constrain');
    const metadataReviewSpy = jest.spyOn(RequirementParserService, 'reviewGatewayRequestMetadata');
    const validatorSpy = jest.spyOn(
      RequirementParserService.queryValidator,
      'validateGatewayRequest'
    );
    const kernelSpy = jest.spyOn(RequirementParserService.metricExecutionKernel, 'execute');

    const result = await RequirementParserService.executeDirectGatewayRequest(
      buildWebApplicationTrtiQuery()
    );

    expect(policySpy).not.toHaveBeenCalled();
    expect(constraintSpy).not.toHaveBeenCalled();
    expect(metadataReviewSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
    expect(kernelSpy).not.toHaveBeenCalled();
    expect(counter.snapshot().total).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      service: 'topValues',
      data: [],
      error: { code: 'OBJECT_METRIC_INCOMPATIBLE' },
      requestParams: null
    });
  });

  test.each([
    {
      label: 'metrics without groups routes to metrics',
      queryFields: { service: 'metrics' },
      expectedService: 'metrics'
    },
    {
      label: 'metrics with groups routes to metricsForGroup',
      queryFields: { service: 'metrics', groups: [{ type: 'WebApplication' }] },
      expectedService: 'metricsForGroup'
    },
    {
      label: 'groups without groups routes to groups',
      queryFields: { service: 'groups' },
      expectedService: 'groups'
    },
    {
      label: 'groups with one WebApplication group routes to applications',
      queryFields: { service: 'groups', groups: [{ type: 'WebApplication' }] },
      expectedService: 'applications'
    }
  ])(
    'characterization_current_metadata_overload: $label',
    async ({ queryFields, expectedService }) => {
      const counter = installFake();
      const query = {
        queryModeKey: 'metadata',
        start: START_SECONDS,
        end: END_SECONDS,
        format: 'json',
        ...queryFields
      };

      const result = await RequirementParserService.executeDirectGatewayRequest(query);

      expect(result.ok).toBe(true);
      expect(result.requestParams.type).toBe(expectedService);
      expect(counter.snapshot().total).toBe(1);
      expect(counter.callsFor(expectedService)).toHaveLength(1);
    }
  );

  test('characterization_current_successful_empty_rows_remain_ok_without_failure_classification', async () => {
    installFake({ topValues: '[]' });

    const result = await RequirementParserService.executeDirectGatewayRequest(
      buildWebApplicationTrtiQuery('PGTME')
    );

    expect(result).toMatchObject({
      ok: true,
      data: [],
      error: null
    });
    expect(result.outcome).toBeUndefined();
  });

  test.each([
    ['empty', 'METRIC_EMPTY'],
    ['no data', 'METRIC_EMPTY']
  ])(
    'characterization_current_error_text_%s_is_guessed_as_no_data',
    (message, expectedCategory) => {
      const classification = ExecutionFailureClassifier.classify(
        new Error(message),
        { service: 'topValues' }
      );

      expect(classification).toMatchObject({
        category: expectedCategory,
        domain: 'metric',
        service: 'topValues',
        retryable: false
      });
    }
  );

  test('characterization_current_http_error_is_classified_before_empty_text', () => {
    const classification = ExecutionFailureClassifier.classify({
      status: 400,
      message: '400 Bad Request: no data'
    }, {
      service: 'topValues'
    });

    expect(classification).toMatchObject({
      category: 'NAPM_UPSTREAM_400',
      domain: 'metric',
      retryable: true
    });
  });

  test('characterization_current_parse_error_is_generic_upstream_failure', () => {
    const classification = ExecutionFailureClassifier.classify(
      new SyntaxError('Unexpected token while parsing CSV'),
      { service: 'topValues' }
    );

    expect(classification).toMatchObject({
      category: 'NAPM_UPSTREAM_ERROR',
      domain: 'metric',
      retryable: true
    });
  });
});
