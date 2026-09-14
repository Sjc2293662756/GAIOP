'use strict';

const plugin = require('../napm-openclaw-plugin.remote');
const LegacyMetricInputAdapter = require('../skills/openclaw-napm-query/services/LegacyMetricInputAdapter');

describe('BUG-A Phase 3 plugin canonical Query Contract boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('accepts independent topMetric without manufacturing legacy metric', () => {
    const result = plugin.__test__.validateResolvedQueryAgainstSpec({
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
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        queryModeKey: 'topn',
        metrics: ['TPI', 'TPO'],
        topMetric: 'TPIO'
      }
    });
    expect(result.resolvedQuery.metric).toBeUndefined();
  });

  test('invokes the legacy adapter once at the input boundary and never during replay preparation', () => {
    const adapterSpy = jest.spyOn(LegacyMetricInputAdapter, 'adapt');
    const once = plugin.__test__.prepareSkillExecutionArgs({
      resolvedQuery: {
        service: 'topValues',
        groups: [{ type: 'WebApplication' }],
        metric: 'PGTME',
        topCount: 5,
        start: 1788937200,
        end: 1788940800
      }
    });
    const replay = plugin.__test__.prepareSkillExecutionArgs(once);

    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(replay.resolvedQuery).toMatchObject({
      schemaVersion: 'napm-resolved-query.v1',
      metrics: ['PGTME'],
      topMetric: 'PGTME'
    });
    expect(replay.resolvedQuery.metric).toBeUndefined();
  });

  test('does not invoke the legacy adapter for a canonical query', () => {
    const adapterSpy = jest.spyOn(LegacyMetricInputAdapter, 'adapt');

    plugin.__test__.prepareSkillExecutionArgs({
      queryDraft: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'topValues',
        groups: [{ type: 'IPAddress' }],
        metrics: ['TPI', 'TPO'],
        topMetric: 'TPIO',
        topCount: 10,
        start: 1788937200,
        end: 1788940800
      }
    });

    expect(adapterSpy).not.toHaveBeenCalled();
  });

  test('preserves a deterministic legacy conflict at the prepared plugin boundary', () => {
    const prepared = plugin.__test__.prepareSkillExecutionArgs({
      resolvedQuery: {
        service: 'topValues',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGTME'],
        topMetric: 'PGTME',
        metric: 'TRTI',
        topCount: 5,
        start: 1788937200,
        end: 1788940800
      }
    });

    expect(plugin.__test__.validatePreparedResolvedQuery(prepared)).toMatchObject({
      ok: false,
      reasonCode: 'LEGACY_METRIC_CONFLICT',
      resolvedQuery: null
    });
  });

  test('allows declarative relative time only during plugin construction', () => {
    const query = {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'timeValues',
      groups: [{ type: 'WebApplication', argument: '业务A' }],
      metrics: ['PGTME'],
      granularity: 300,
      timeRange: { key: 'last24hours' }
    };

    expect(plugin.__test__.validateResolvedQueryAgainstSpec(query, {
      phase: 'construction'
    })).toMatchObject({ ok: true });
    expect(plugin.__test__.validateResolvedQueryAgainstSpec(query)).toMatchObject({
      ok: false,
      reasonCode: 'START_REQUIRED'
    });
  });
});
