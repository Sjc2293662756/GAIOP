'use strict';

const ResolvedQueryContract = require('../skills/openclaw-napm-query/services/ResolvedQueryContract');

describe('BUG-A Phase 3 canonical ResolvedQuery contract', () => {
  test('accepts an independent topMetric outside the returned metrics', () => {
    const result = ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPI', 'TPO'],
      topMetric: 'TPIO',
      topCount: 10,
      start: 1788937200,
      end: 1788940800
    });

    expect(result).toMatchObject({
      ok: true,
      query: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'IPAddress' }],
        metrics: ['TPI', 'TPO'],
        topMetric: 'TPIO',
        topCount: 10
      }
    });
    expect(result.query.metric).toBeUndefined();
  });

  test('accepts a multi-metric average without primary or ranking fields', () => {
    const result = ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'averageValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      start: 1788937200,
      end: 1788940800
    });

    expect(result).toMatchObject({
      ok: true,
      query: {
        queryModeKey: 'average',
        metrics: ['PGNPGE', 'PGTME', 'PGHTTP500']
      }
    });
    expect(result.query).not.toHaveProperty('metric');
    expect(result.query).not.toHaveProperty('topMetric');
  });

  test('accepts a multi-metric timeseries only when granularity is present', () => {
    const result = ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'timeValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      granularity: 300,
      start: 1788937200,
      end: 1788940800
    });

    expect(result).toMatchObject({
      ok: true,
      query: {
        queryModeKey: 'timeseries',
        metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
        granularity: 300
      }
    });
    expect(result.query).not.toHaveProperty('metric');
    expect(result.query).not.toHaveProperty('topMetric');
  });

  test('keeps pageViews as a separate detail contract with a local default limit', () => {
    const result = ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'pageViews',
      pageFamilyId: '8573007',
      start: 1788937200,
      end: 1788940800
    });

    expect(result).toMatchObject({
      ok: true,
      query: {
        queryModeKey: 'detail',
        pageFamilyId: '8573007',
        maxLimit: 20
      }
    });
    expect(result.query).not.toHaveProperty('groups');
    expect(result.query).not.toHaveProperty('metrics');
    expect(result.query).not.toHaveProperty('metric');
    expect(result.query).not.toHaveProperty('topMetric');
  });

  test.each([
    ['missing metrics', { metrics: undefined }, 'METRICS_REQUIRED'],
    ['missing topMetric', { topMetric: undefined }, 'TOP_METRIC_REQUIRED'],
    ['invalid topCount', { topCount: 0 }, 'TOP_COUNT_INVALID'],
    ['legacy metric present', { metric: 'TPIO' }, 'METRIC_FORBIDDEN'],
    ['granularity present', { granularity: 300 }, 'GRANULARITY_FORBIDDEN'],
    ['conflicting query mode', { queryModeKey: 'timeseries' }, 'QUERY_MODE_CONFLICT']
  ])('rejects canonical topValues with %s', (_label, override, reasonCode) => {
    const result = ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPI', 'TPO'],
      topMetric: 'TPIO',
      topCount: 10,
      start: 1788937200,
      end: 1788940800,
      ...override
    });

    expect(result).toMatchObject({ ok: false, reasonCode });
  });

  test.each([
    ['averageValues', { topMetric: 'PGTME' }, 'TOP_METRIC_FORBIDDEN'],
    ['averageValues', { topCount: 5 }, 'TOP_COUNT_FORBIDDEN'],
    ['timeValues', { topMetric: 'PGTME', granularity: 300 }, 'TOP_METRIC_FORBIDDEN'],
    ['timeValues', {}, 'GRANULARITY_REQUIRED']
  ])('enforces required and forbidden fields for %s', (service, override, reasonCode) => {
    const result = ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v1',
      service,
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNPGE', 'PGTME'],
      start: 1788937200,
      end: 1788940800,
      ...override
    });

    expect(result).toMatchObject({ ok: false, reasonCode });
  });

  test('fails closed on an unknown ResolvedQuery schema version', () => {
    expect(ResolvedQueryContract.validateShape({
      schemaVersion: 'napm-resolved-query.v9',
      service: 'topValues'
    })).toMatchObject({
      ok: false,
      reasonCode: 'RESOLVED_QUERY_SCHEMA_UNSUPPORTED'
    });
  });
});
