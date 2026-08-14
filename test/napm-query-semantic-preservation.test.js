const plugin = require('../napm-openclaw-plugin.remote');
const { applyTimeOverride } = require('../skills/openclaw-napm-query/src/shared/timeResolver');

describe('NAPM query semantic preservation', () => {
  test('preserves a complete structured Top 5 and materializes its relative time at execution', () => {
    const prompt = '查询过去1小时总流量最高的5个IP';
    const prepared = plugin.__test__.buildCanonicalSkillToolParams(prompt, {
      resolvedQuery: {
        service: 'topValues',
        queryModeKey: 'topn',
        metric: 'BYTIO',
        metrics: ['BYTIO'],
        topMetric: 'BYTIO',
        topCount: 5,
        groups: [{ type: 'IPAddress' }],
        timeRange: {
          key: 'last1hour',
          displayText: '过去1小时'
        },
        format: 'json'
      }
    });
    expect(prepared.resolvedQuery.start).toBeUndefined();
    expect(prepared.resolvedQuery.end).toBeUndefined();

    applyTimeOverride(prepared.resolvedQuery, 1785316800000);

    expect(prepared.resolvedQuery).toMatchObject({
      service: 'topValues',
      queryModeKey: 'topn',
      metric: 'BYTIO',
      metrics: ['BYTIO'],
      topMetric: 'BYTIO',
      groups: [{ type: 'IPAddress' }],
      topCount: 5,
      start: 1785313200,
      end: 1785316800,
      timeRange: { key: 'last1hour' },
      format: 'json',
      executionOptions: { timeMode: 'relative' }
    });
  });

  test.each([
    '查询过去1小时总流量最高的5个IP',
    '最近24小时流量趋势',
    '现在网络整体情况怎么样？'
  ])('does not construct resolvedQuery from prompt-only input: %s', (prompt) => {
    const prepared = plugin.__test__.buildCanonicalSkillToolParams(prompt, {});

    expect(prepared.resolvedQuery).toBeUndefined();
    expect(plugin.__test__.validateResolvedQueryAgainstSpec(prepared.resolvedQuery)).toMatchObject({
      ok: false,
      reason: 'missing_resolved_query'
    });
  });

  test('does not repair an invalid explicit resolvedQuery from prompt text', () => {
    const prompt = '查询过去1小时总流量最高的5个IP';
    const prepared = plugin.__test__.buildCanonicalSkillToolParams(prompt, {
      resolvedQuery: {
        service: 'topValues',
        groups: [{ type: 'IPAddress' }],
        metrics: ['BYTIO'],
        topMetric: 'BYTIO',
        topCount: 5,
        timeRange: { key: 'lastNminutes' }
      }
    });

    expect(prepared.resolvedQuery.timeRange.key).toBe('lastNminutes');
    expect(prepared.resolvedQuery.start).toBeUndefined();
    expect(plugin.__test__.validateResolvedQueryAgainstSpec(prepared.resolvedQuery)).toMatchObject({
      ok: false,
      reason: 'unsupported_time_range_key'
    });
  });

  test('mechanically canonicalizes raw fields without rewriting fixed query semantics', () => {
    const prompt = [
      '请直接执行一次 NAPM Web Services 查询，不要进行指标映射、参数改写或二次语义解析。',
      'service=topValues numGroups=1 groupType1=IPAddress',
      'start=1785310980 end=1785314580 metrics=BYTI,BYTO,BYTIO',
      'topMetric=BYTIO topCount=5 csv=true',
      '按照累计双向总流量 BYTIO 从高到低排序的前 5 个 IP。'
    ].join(' ');
    const prepared = plugin.__test__.buildCanonicalSkillToolParams(prompt, {
      nowSeconds: 1785314760,
      resolvedQuery: {
        service: 'topValues',
        numGroups: 1,
        groupType1: 'IPAddress',
        start: 1785310980,
        end: 1785314580,
        metrics: 'BYTI,BYTO,BYTIO',
        topMetric: 'BYTIO',
        topCount: 5,
        csv: true
      }
    });

    expect(prepared.resolvedQuery).toMatchObject({
      service: 'topValues',
      queryModeKey: 'topn',
      metric: 'BYTIO',
      metrics: ['BYTI', 'BYTO', 'BYTIO'],
      topMetric: 'BYTIO',
      groups: [{ type: 'IPAddress' }],
      topCount: 5,
      start: 1785310980,
      end: 1785314580,
      format: 'json',
      executionOptions: { timeMode: 'fixed' }
    });
    expect(prepared.resolvedQuery.timeRange?.key).not.toBe('last1hour');
  });

  test('rejects a sort metric that is absent from the requested metric set', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec({
      service: 'topValues',
      queryModeKey: 'topn',
      metrics: ['BYTI', 'BYTO'],
      topMetric: 'BYTIO',
      groups: [{ type: 'IPAddress' }],
      topCount: 5,
      start: 1785310980,
      end: 1785314580
    });

    expect(validation).toMatchObject({
      ok: false,
      reason: 'top_metric_not_in_metrics'
    });
  });

  test('rejects a semantic target that differs from the terminal group', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec({
      service: 'topValues',
      queryModeKey: 'topn',
      metrics: ['BYTIO'],
      topMetric: 'BYTIO',
      groups: [{ type: 'BusinessGroup' }],
      topCount: 5,
      start: 1785310980,
      end: 1785314580,
      semanticConstraints: {
        targetObjectType: 'IPAddress'
      }
    });

    expect(validation).toMatchObject({
      ok: false,
      reason: 'target_group_mismatch'
    });
  });

  test('rejects a placeholder time key even when timestamps are present', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec({
      service: 'topValues',
      queryModeKey: 'topn',
      metrics: ['BYTIO'],
      topMetric: 'BYTIO',
      groups: [{ type: 'IPAddress' }],
      topCount: 5,
      start: 1785310980,
      end: 1785314580,
      timeRange: { key: 'lastNminutes' }
    });

    expect(validation).toMatchObject({
      ok: false,
      reason: 'unsupported_time_range_key'
    });
  });

  test('accepts custom as declarative metadata for a fixed time range', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec({
      service: 'topValues',
      queryModeKey: 'topn',
      metrics: ['BYTIO'],
      topMetric: 'BYTIO',
      groups: [{ type: 'IPAddress' }],
      topCount: 5,
      start: 1785310980,
      end: 1785314580,
      timeRange: { key: 'custom' },
      executionOptions: { timeMode: 'fixed' }
    });

    expect(validation.ok).toBe(true);
    expect(validation.resolvedQuery.executionOptions.timeMode).toBe('fixed');
  });
});
