'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase1-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase1-test-password';

const QueryDecisionPolicy = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');
const {
  OBJECT_METRIC_COMPATIBILITY,
  DOCUMENTED_PRODUCT_BASELINE,
  OBJECT_METRIC_COVERAGE,
  classifyObjectMetricCompatibility,
  isMetricCompatibleWithGroupPath
} = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');

const START_SECONDS = 1788940800 - 3600;
const END_SECONDS = 1788940800;

describe('BUG-A Phase 1 Object x Metric ownership tri-state contract', () => {
  test('coverage metadata binds service, exact path, baseline, exhaustiveness, allow-list and source', () => {
    expect(OBJECT_METRIC_COVERAGE).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'topValues',
        groupPathSignature: 'WebApplication',
        supportedProductBaseline: DOCUMENTED_PRODUCT_BASELINE,
        exhaustive: true,
        allowedMetricIds: expect.arrayContaining(['PGNPGE', 'PGTME']),
        source: expect.any(String)
      })
    ]));
  });

  test.each([
    [
      'exact exhaustive coverage and allowed metric',
      {
        service: 'topValues',
        groupPath: [{ type: 'WebApplication' }],
        metricId: 'PGTME',
        productBaseline: DOCUMENTED_PRODUCT_BASELINE
      },
      'KNOWN_COMPATIBLE'
    ],
    [
      'exact exhaustive coverage and legal but unlisted metric',
      {
        service: 'topValues',
        groupPath: ['WebApplication'],
        metricId: 'TRTI',
        productBaseline: DOCUMENTED_PRODUCT_BASELINE
      },
      'KNOWN_INCOMPATIBLE'
    ],
    [
      'non-exhaustive coverage',
      {
        service: 'topValues',
        groupPath: ['WebApplication', 'PageFamily'],
        metricId: 'PGTME',
        productBaseline: DOCUMENTED_PRODUCT_BASELINE
      },
      'UNKNOWN'
    ],
    [
      'exact DefinedApp topValues coverage',
      {
        service: 'topValues',
        groupPath: ['DefinedApp'],
        metricId: 'TRTI',
        productBaseline: DOCUMENTED_PRODUCT_BASELINE
      },
      'KNOWN_COMPATIBLE'
    ],
    [
      'exact WebApplication averageValues coverage',
      {
        service: 'averageValues',
        groupPath: ['WebApplication'],
        metricId: 'PGTME',
        productBaseline: DOCUMENTED_PRODUCT_BASELINE
      },
      'KNOWN_COMPATIBLE'
    ],
    [
      'baseline mismatch',
      {
        service: 'topValues',
        groupPath: ['WebApplication'],
        metricId: 'PGTME',
        productBaseline: 'unsupported-product-baseline'
      },
      'UNKNOWN'
    ],
    [
      'baseline unknown',
      {
        service: 'topValues',
        groupPath: ['WebApplication'],
        metricId: 'PGTME'
      },
      'UNKNOWN'
    ]
  ])('%s -> %s', (_label, input, expected) => {
    expect(classifyObjectMetricCompatibility(input)).toBe(
      OBJECT_METRIC_COMPATIBILITY[expected]
    );
  });

  test('ownership classification does not create a METRIC_UNKNOWN or existence result', () => {
    const result = classifyObjectMetricCompatibility({
      service: 'topValues',
      groupPath: ['WebApplication'],
      metricId: 'PGSUPERFAST',
      productBaseline: DOCUMENTED_PRODUCT_BASELINE
    });

    expect(result).toBe(OBJECT_METRIC_COMPATIBILITY.KNOWN_INCOMPATIBLE);
    expect(result).not.toBe('METRIC_UNKNOWN');
  });

  test('legacy boolean API remains unchanged for unknown paths in Phase 1', () => {
    expect(isMetricCompatibleWithGroupPath(['FutureObject'], 'PGSUPERFAST')).toBe(true);
  });

  test('Phase 4 wires QueryDecisionPolicy to the Phase 1 tri-state API', () => {
    const queryDraft = {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }],
      metrics: ['TRTI'],
      topMetric: 'TRTI',
      topCount: 5,
      start: START_SECONDS,
      end: END_SECONDS,
      format: 'json'
    };

    expect(QueryDecisionPolicy.evaluateQueryDecision({
      prompt: '最近业务访问较慢的前5个业务都有谁？',
      queryDraft
    })).toMatchObject({
      action: 'REJECT_QUERY',
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
      southboundAllowed: false
    });
  });
});
