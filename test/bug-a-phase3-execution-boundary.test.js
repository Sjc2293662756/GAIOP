'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase3-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase3-test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const LegacyMetricInputAdapter = require('../skills/openclaw-napm-query/services/LegacyMetricInputAdapter');
const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

function canonicalTopQuery() {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    groups: [{ type: 'WebApplication' }],
    metrics: ['PGTME'],
    topMetric: 'PGTME',
    topCount: 10,
    start: 1788937200,
    end: 1788940800
  };
}

describe('BUG-A Phase 3 canonical execution boundary', () => {
  let restoreClient = null;
  let counter = null;

  beforeEach(() => {
    counter = new SouthboundCallCounter();
    const client = new FakeNapmClient({ counter });
    restoreClient = installRequirementParserFakeClient(RequirementParserService, client);
  });

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    counter = null;
    jest.restoreAllMocks();
  });

  test('keeps the canonical query metric-free through prepare and execution', async () => {
    const adapterSpy = jest.spyOn(LegacyMetricInputAdapter, 'adapt');
    const result = await RequirementParserService.executeGatewayRequest(canonicalTopQuery());

    expect(result).toMatchObject({
      ok: true,
      requestParams: {
        type: 'topValues',
        metrics: 'PGTME',
        topMetric: 'PGTME',
        topCount: 10
      }
    });
    expect(adapterSpy).not.toHaveBeenCalled();
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('adapts a legacy execution input once before prepare and direct execution', async () => {
    const adapterSpy = jest.spyOn(LegacyMetricInputAdapter, 'adapt');
    const result = await RequirementParserService.executeGatewayRequest({
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metric: 'PGTME',
      topCount: 5,
      start: 1788937200,
      end: 1788940800
    });

    expect(result).toMatchObject({
      ok: true,
      warnings: [{ code: 'LEGACY_METRIC_DEPRECATED' }],
      requestParams: {
        type: 'topValues',
        metrics: 'PGTME',
        topMetric: 'PGTME'
      }
    });
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });

  test('rejects a legacy conflict before metadata and data calls', async () => {
    const adapterSpy = jest.spyOn(LegacyMetricInputAdapter, 'adapt');
    const result = await RequirementParserService.executeGatewayRequest({
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGTME'],
      topMetric: 'PGTME',
      metric: 'TRTI',
      topCount: 5,
      start: 1788937200,
      end: 1788940800
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'LEGACY_METRIC_CONFLICT',
        category: 'QUERY_SHAPE_INVALID'
      },
      requestParams: null
    });
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(counter.snapshot().total).toBe(0);
  });

  test('executes Resolver canonical output without invoking the legacy adapter', async () => {
    const adapterSpy = jest.spyOn(LegacyMetricInputAdapter, 'adapt');
    const resolved = ResolverService.resolvePrompt('页面响应时间最高的前5个业务', {
      nowSeconds: 1788940800
    });
    const result = await RequirementParserService.executeGatewayRequest(resolved.resolvedQuery);

    expect(result.ok).toBe(true);
    expect(adapterSpy).not.toHaveBeenCalled();
    expect(counter.callsFor('topValues')).toHaveLength(1);
  });
});
