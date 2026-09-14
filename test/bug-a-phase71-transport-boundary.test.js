'use strict';

const path = require('node:path');
const GroupBuilder = require('../skills/openclaw-napm-query/services/GroupBuilder');
const NapmQuerySerializer = require('../skills/openclaw-napm-query/services/NapmQuerySerializer');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');
const {
  inspectNapmPhase71TransportBoundaryContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 7.1 transport boundary verification', () => {
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

  test('locks the real group transport chain and deletion audit', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase71TransportBoundaryContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase71_group_transport_chain_is_explicit',
      'phase71_single_production_group_encoder',
      'phase71_single_production_metrics_encoder',
      'phase71_legacy_and_primary_metric_fallbacks_deleted',
      'phase71_client_is_mechanical_transport_only',
      'phase71_dead_query_helpers_removed',
      'phase71_internal_transport_fields_filtered'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });

  test('uses one mechanical GroupBuilder encoder with stable order and argument presence', () => {
    expect(GroupBuilder.buildGroupParams([
      { type: 'BusinessGroup', argument: 'abc' },
      { type: 'IPAddress' }
    ])).toEqual({
      groupType1: 'BusinessGroup',
      groupArgument1: 'abc',
      groupType2: 'IPAddress',
      numGroups: 2
    });
  });

  test('does not let transport encoding repair missing or invalid group arguments', () => {
    expect(NapmQuerySerializer.serialize({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'BusinessGroup' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5,
      start: 1788937200,
      end: 1788940800,
      format: 'json'
    }).params).toMatchObject({
      groupType1: 'BusinessGroup',
      numGroups: 1
    });
    expect(NapmQuerySerializer.serialize({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'BusinessGroup', argument: 'all' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5,
      start: 1788937200,
      end: 1788940800
    }).params.groupArgument1).toBe('all');
  });

  test.each([
    ['static invalid', {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }],
      metrics: ['TRTI'],
      topMetric: 'TRTI',
      topCount: 5,
      start: 1788937200,
      end: 1788940800
    }, { metricsForGroup: [], topValues: '[]' }],
    ['runtime unsupported', {
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
    }, { metricsForGroup: [], topValues: '[]' }]
  ])('%s stops before Serializer and data Client', async (_label, query, responses) => {
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter, responses })
    );
    const serializerSpy = jest.spyOn(NapmQuerySerializer, 'serialize');

    const result = await RequirementParserService.executeDirectGatewayRequest(query);

    expect(result.ok).toBe(false);
    expect(serializerSpy).not.toHaveBeenCalled();
    expect(counter.callsFor('topValues')).toHaveLength(0);
  });
});
