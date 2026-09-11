'use strict';

const {
  DOCUMENTED_PRODUCT_BASELINE
} = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');
const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
const QueryDecisionPolicy = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');

function query(fields = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    groups: [{ type: 'WebApplication' }],
    metrics: ['TRTI'],
    topMetric: 'TRTI',
    topCount: 5,
    start: 1788937200,
    end: 1788940800,
    ...fields
  };
}

describe('BUG-A Phase 4 shared executable validator', () => {
  test('classifies a known incompatible metric with a verified baseline', () => {
    expect(Validator.validate(query(), {
      productBaseline: DOCUMENTED_PRODUCT_BASELINE
    })).toMatchObject({
      ok: false,
      status: 'KNOWN_INCOMPATIBLE',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
      issues: expect.arrayContaining([expect.objectContaining({
        field: 'metrics[0]',
        metricId: 'TRTI',
        service: 'topValues',
        groupPathSignature: 'WebApplication',
        role: 'RETURN_METRIC'
      })]),
      requiredRuntimeChecks: []
    });
  });

  test('reports an unknown metric before ownership classification', () => {
    expect(Validator.validate(query({
      metrics: ['PGSUPERFAST'],
      topMetric: 'PGSUPERFAST'
    }), {
      productBaseline: DOCUMENTED_PRODUCT_BASELINE
    })).toMatchObject({
      ok: false,
      status: 'METRIC_UNKNOWN',
      reasonCode: 'METRIC_UNKNOWN',
      issues: expect.arrayContaining([expect.objectContaining({
        field: 'metrics[0]',
        metricId: 'PGSUPERFAST'
      })]),
      requiredRuntimeChecks: []
    });
  });

  test('keeps a compatible metric UNKNOWN when no trusted baseline is supplied', () => {
    expect(Validator.validate(query({
      metrics: ['PGTME'],
      topMetric: 'PGTME'
    }))).toMatchObject({
      ok: false,
      status: 'UNKNOWN',
      reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
      requiredRuntimeChecks: [{
        service: 'topValues',
        groupPathSignature: 'WebApplication',
        metricId: 'PGTME',
        roles: ['RETURN_METRIC', 'RANKING_METRIC']
      }]
    });
  });

  test('accepts a statically compatible metric with the verified baseline', () => {
    expect(Validator.validate(query({
      metrics: ['PGTME'],
      topMetric: 'PGTME'
    }), {
      productBaseline: DOCUMENTED_PRODUCT_BASELINE
    })).toMatchObject({
      ok: true,
      status: 'VALID',
      reasonCode: 'EXECUTABLE_QUERY_VALID'
    });
  });

  test('maps static incompatibility and UNKNOWN to deterministic Policy outcomes', () => {
    expect(QueryDecisionPolicy.evaluateQueryDecision({
      queryDraft: query(),
      executableValidationContext: { productBaseline: DOCUMENTED_PRODUCT_BASELINE }
    })).toMatchObject({
      action: 'REJECT_QUERY',
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
      southboundAllowed: false
    });

    expect(QueryDecisionPolicy.evaluateQueryDecision({
      queryDraft: query({ metrics: ['PGTME'], topMetric: 'PGTME' }),
      executableValidationContext: { productBaseline: '' }
    })).toMatchObject({
      action: 'RUNTIME_CONFIRMATION_REQUIRED',
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
      southboundAllowed: false
    });
  });

  test('checks every return metric and the ranking metric as independent roles', () => {
    const mixed = Validator.validate(query({
      metrics: ['PGNPGE', 'TRTI'],
      topMetric: 'PGTME'
    }), { productBaseline: DOCUMENTED_PRODUCT_BASELINE });
    expect(mixed).toMatchObject({
      status: 'KNOWN_INCOMPATIBLE',
      issues: [expect.objectContaining({
        field: 'metrics[1]',
        metricId: 'TRTI',
        role: 'RETURN_METRIC'
      })]
    });

    const ranking = Validator.validate(query({
      metrics: ['PGNPGE', 'PGTME'],
      topMetric: 'TRTI'
    }), { productBaseline: DOCUMENTED_PRODUCT_BASELINE });
    expect(ranking).toMatchObject({
      status: 'KNOWN_INCOMPATIBLE',
      issues: [expect.objectContaining({
        field: 'topMetric',
        metricId: 'TRTI',
        role: 'RANKING_METRIC'
      })]
    });
  });

  test('does not require an independent topMetric to appear in metrics', () => {
    const result = Validator.validate({
      ...query(),
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPI', 'TPO'],
      topMetric: 'TPIO'
    }, { productBaseline: DOCUMENTED_PRODUCT_BASELINE });

    expect(result).toMatchObject({
      status: 'VALID',
      reasonCode: 'EXECUTABLE_QUERY_VALID'
    });
    expect(result.issues).toEqual([]);
    expect(result.requiredRuntimeChecks).toEqual([]);
  });

  test('valid pageViews bypasses metric existence and ownership checks', () => {
    expect(Validator.validate({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'pageViews',
      pageFamilyId: '8573007',
      start: 1788937200,
      end: 1788940800
    })).toMatchObject({
      ok: true,
      status: 'VALID'
    });
  });
});
