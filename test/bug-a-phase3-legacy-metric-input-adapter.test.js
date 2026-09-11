'use strict';

const LegacyMetricInputAdapter = require('../skills/openclaw-napm-query/services/LegacyMetricInputAdapter');

const BASE_TOP_QUERY = Object.freeze({
  service: 'topValues',
  groups: [{ type: 'WebApplication' }],
  topCount: 5,
  start: 1788937200,
  end: 1788940800
});

function topQuery(fields = {}) {
  return {
    ...BASE_TOP_QUERY,
    groups: BASE_TOP_QUERY.groups.map((group) => ({ ...group })),
    ...fields
  };
}

describe('BUG-A Phase 3 LegacyMetricInputAdapter', () => {
  test('migrates a legacy-only topValues metric into canonical roles exactly once', () => {
    const result = LegacyMetricInputAdapter.adapt(topQuery({ metric: 'PGTME' }));

    expect(result).toMatchObject({
      ok: true,
      adapted: true,
      warnings: [{ code: 'LEGACY_METRIC_DEPRECATED' }],
      query: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'topValues',
        queryModeKey: 'topn',
        metrics: ['PGTME'],
        topMetric: 'PGTME'
      }
    });
    expect(result.query.metric).toBeUndefined();
  });

  test('preserves complete canonical topValues fields when legacy metric is redundant', () => {
    const result = LegacyMetricInputAdapter.adapt(topQuery({
      schemaVersion: 'napm-resolved-query.v1',
      metrics: ['PGTME'],
      topMetric: 'PGTME',
      metric: 'PGTME'
    }));

    expect(result).toMatchObject({
      ok: true,
      adapted: true,
      warnings: [{ code: 'LEGACY_METRIC_DEPRECATED', kind: 'redundant' }],
      query: {
        metrics: ['PGTME'],
        topMetric: 'PGTME'
      }
    });
    expect(result.query.metric).toBeUndefined();
  });

  test.each([
    [
      'fills only topMetric when metrics already exist',
      topQuery({ metrics: ['TPI', 'TPO'], metric: 'TPIO' }),
      { metrics: ['TPI', 'TPO'], topMetric: 'TPIO' }
    ],
    [
      'fills metrics when matching topMetric already exists',
      topQuery({ topMetric: 'TPIO', metric: 'TPIO' }),
      { metrics: ['TPIO'], topMetric: 'TPIO' }
    ],
    [
      'migrates an average legacy metric',
      {
        service: 'averageValues',
        groups: [{ type: 'WebApplication' }],
        metric: 'PGTME',
        start: 1788937200,
        end: 1788940800
      },
      { queryModeKey: 'average', metrics: ['PGTME'] }
    ],
    [
      'removes a redundant timeValues legacy metric',
      {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'timeValues',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGNPGE', 'PGTME'],
        metric: 'PGTME',
        granularity: 300,
        start: 1788937200,
        end: 1788940800
      },
      { queryModeKey: 'timeseries', metrics: ['PGNPGE', 'PGTME'] }
    ]
  ])('%s', (_label, input, expected) => {
    const result = LegacyMetricInputAdapter.adapt(input);

    expect(result).toMatchObject({ ok: true, adapted: true, query: expected });
    expect(result.query.metric).toBeUndefined();
  });

  test.each([
    [
      'rejects a complete topValues conflict',
      topQuery({ metrics: ['PGTME'], topMetric: 'PGTME', metric: 'TRTI' }),
      'LEGACY_METRIC_CONFLICT'
    ],
    [
      'rejects a partial topValues conflict',
      topQuery({ topMetric: 'TPIO', metric: 'TPI' }),
      'LEGACY_METRIC_PARTIAL_CONFLICT'
    ],
    [
      'rejects an average metrics conflict',
      {
        service: 'averageValues',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGNPGE', 'PGTME'],
        metric: 'TRTI',
        start: 1788937200,
        end: 1788940800
      },
      'LEGACY_METRIC_CONFLICT'
    ],
    [
      'rejects legacy metric for pageViews',
      {
        service: 'pageViews',
        metric: 'PGTME',
        pageFamilyId: '8573007',
        start: 1788937200,
        end: 1788940800
      },
      'LEGACY_METRIC_NOT_ALLOWED_FOR_SERVICE'
    ]
  ])('%s', (_label, input, reasonCode) => {
    expect(LegacyMetricInputAdapter.adapt(input)).toMatchObject({
      ok: false,
      reasonCode,
      query: null
    });
  });
});
