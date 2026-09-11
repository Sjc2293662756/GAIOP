'use strict';

const AtomicQueryRepairService = require('../skills/openclaw-napm-query/services/AtomicQueryRepairService');

function query(overrides = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    groups: [{ type: 'WebApplication', argument: ' HTTP ' }],
    metrics: ['pgtme', 'PGTME'],
    topMetric: 'pgtme',
    topCount: 5,
    start: 1788937200,
    end: 1788940800,
    ...overrides
  };
}

describe('BUG-A Phase 6 atomic query repair', () => {
  test('creates one auditable safe plan and applies it atomically', () => {
    const original = query();
    const snapshot = JSON.parse(JSON.stringify(original));
    const plan = AtomicQueryRepairService.plan(original);

    expect(plan).toMatchObject({
      status: 'REPAIR_APPLICABLE',
      changes: expect.arrayContaining([
        expect.objectContaining({ path: 'metrics', reasonCode: 'REMOVE_DUPLICATE_METRIC' }),
        expect.objectContaining({ path: 'topMetric', reasonCode: 'NORMALIZE_METRIC_ID_CASE' }),
        expect.objectContaining({ path: 'groups[0].argument', reasonCode: 'NORMALIZE_GROUP_ARGUMENT' })
      ]),
      beforeFingerprint: expect.any(String)
    });
    const applied = AtomicQueryRepairService.apply(original, plan);

    expect(applied).toMatchObject({
      status: 'REPAIR_APPLIED',
      query: {
        metrics: ['PGTME'],
        topMetric: 'PGTME',
        groups: [{ type: 'WebApplication', argument: 'HTTP' }]
      },
      afterFingerprint: expect.any(String)
    });
    expect(applied.beforeFingerprint).not.toBe(applied.afterFingerprint);
    expect(original).toEqual(snapshot);
  });

  test('returns NO_REPAIR_NEEDED for a canonical query', () => {
    const result = AtomicQueryRepairService.repair(query({
      groups: [{ type: 'WebApplication', argument: 'HTTP' }],
      metrics: ['PGTME'],
      topMetric: 'PGTME',
      queryModeKey: 'topn'
    }));

    expect(result).toMatchObject({
      status: 'NO_REPAIR_NEEDED',
      query: expect.objectContaining({ metrics: ['PGTME'] }),
      changes: []
    });
  });

  test('derives a missing queryModeKey but rejects a conflicting one', () => {
    expect(AtomicQueryRepairService.repair(query({ queryModeKey: undefined }))).toMatchObject({
      status: 'REPAIR_APPLIED',
      query: { queryModeKey: 'topn' },
      changes: expect.arrayContaining([expect.objectContaining({
        path: 'queryModeKey',
        reasonCode: 'DERIVE_QUERY_MODE_KEY'
      })])
    });

    expect(AtomicQueryRepairService.plan(query({ queryModeKey: 'timeseries' }))).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'QUERY_MODE_CONFLICT'
    });
  });

  test('rejects semantic metric/object/service replacement suggestions', () => {
    const result = AtomicQueryRepairService.plan(query(), {
      suggestions: [
        { path: 'metrics', before: ['TRTI'], after: ['PGTME'], semanticImpact: 'NONE' },
        { path: 'groups[0].type', before: 'WebApplication', after: 'DefinedApp', semanticImpact: 'NONE' },
        { path: 'service', before: 'topValues', after: 'averageValues', semanticImpact: 'NONE' }
      ]
    });

    expect(result).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'UNSAFE_REPAIR_SUGGESTION'
    });
  });

  test('rejects legacy metric input instead of repairing it after the adapter boundary', () => {
    expect(AtomicQueryRepairService.plan(query({ metric: 'PGTME' }))).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'LEGACY_INPUT_REQUIRES_ADAPTER'
    });
  });

  test('detects conflicting changes to the same path', () => {
    const plan = AtomicQueryRepairService.buildPlan(query(), [
      { path: 'topMetric', before: 'pgtme', after: 'PGTME', reasonCode: 'NORMALIZE_METRIC_ID_CASE', source: 'atomic' },
      { path: 'topMetric', before: 'pgtme', after: 'PGNPGE', reasonCode: 'NORMALIZE_METRIC_ID_CASE', source: 'atomic' }
    ]);

    expect(plan).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'REPAIR_CONFLICT'
    });
  });

  test('does not repair missing metrics or change explicit metric meaning', () => {
    expect(AtomicQueryRepairService.plan(query({
      groups: [{ type: 'WebApplication', argument: 'HTTP' }],
      metrics: [],
      topMetric: 'PGTME',
      queryModeKey: 'topn'
    }))).toMatchObject({
      status: 'NO_REPAIR_NEEDED',
      changes: []
    });
    expect(AtomicQueryRepairService.plan(query({ topMetric: 'TRTI' }))).not.toMatchObject({
      changes: expect.arrayContaining([
        expect.objectContaining({ path: 'topMetric', after: 'PGTME' })
      ])
    });
  });

  test('rejects a suggestion that drops a requested metric', () => {
    const result = AtomicQueryRepairService.plan(query({
      metrics: ['PGTME', 'TRTI']
    }), {
      suggestions: [{
        path: 'metrics',
        before: ['PGTME', 'TRTI'],
        after: ['PGTME'],
        reasonCode: 'REMOVE_DUPLICATE_METRIC',
        semanticImpact: 'NONE'
      }]
    });

    expect(result).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'UNSAFE_REPAIR_SUGGESTION'
    });
  });

  test('accepts a metadata suggestion only when it matches a deterministic safe transform', () => {
    const original = query({
      groups: [{ type: 'WebApplication', argument: ' HTTP ' }],
      metrics: ['PGTME'],
      topMetric: 'PGTME',
      queryModeKey: 'topn'
    });
    const result = AtomicQueryRepairService.repair(original, {
      suggestions: [{
        path: 'groups[0].argument',
        before: ' HTTP ',
        after: 'HTTP',
        reasonCode: 'NORMALIZE_GROUP_ARGUMENT',
        semanticImpact: 'NONE',
        source: 'metadata'
      }]
    });

    expect(result).toMatchObject({
      status: 'REPAIR_APPLIED',
      query: { groups: [{ argument: 'HTTP' }] },
      changes: [expect.objectContaining({ source: 'metadata' })]
    });
  });

  test('rejects a stale plan instead of applying a partial candidate', () => {
    const original = query({ queryModeKey: undefined });
    const plan = AtomicQueryRepairService.plan(original);
    const changed = query({ queryModeKey: undefined, userRequirement: 'changed after planning' });

    expect(AtomicQueryRepairService.apply(changed, plan)).toMatchObject({
      status: 'REPAIR_REJECTED',
      reasonCode: 'REPAIR_PLAN_STALE'
    });
    expect(original.queryModeKey).toBeUndefined();
  });
});
