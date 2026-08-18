const ConversationOperationState = require('../plugin/ConversationOperationState');

describe('ConversationOperationState', () => {
  let now;
  let store;

  beforeEach(() => {
    now = 1_780_000_000_000;
    store = new ConversationOperationState({
      now: () => now,
      resultMaxAgeMs: 1_000,
      reportMaxAgeMs: 2_000,
      queryContextMaxAgeMs: 30 * 60 * 1_000,
      maxEntries: 2
    });
  });

  test('keeps the latest result inside its conversation scope', () => {
    const resultA = { ok: true, reportData: { title: 'A report' } };
    const resultB = { ok: true, reportData: { title: 'B report' } };
    store.rememberSkillResult({ scope: 'wecom:account:a', promptKey: 'wecom:account:a::query', result: resultA });
    store.rememberSkillResult({ scope: 'wecom:account:b', promptKey: 'wecom:account:b::query', result: resultB });

    expect(store.getLatestSkillResult('wecom:account:a').result).toBe(resultA);
    expect(store.getLatestSkillResult('wecom:account:b').result).toBe(resultB);
    expect(store.getLatestSkillResult('')).toBeNull();
  });

  test('expires stale records and does not return them as a fallback', () => {
    store.rememberSkillResult({ scope: 'wecom:account:a', promptKey: 'wecom:account:a::query', result: { ok: true } });
    now += 1_001;

    expect(store.getLatestSkillResult('wecom:account:a')).toBeNull();
    expect(store.getSkillResult('wecom:account:a::query')).toBeNull();
  });

  test('stores report exports per conversation scope only', () => {
    store.rememberReportExport({ scope: 'wecom:account:a', prompt: 'export', result: { ok: true }, reportId: 'a' });
    store.rememberReportExport({ scope: 'wecom:account:b', prompt: 'export', result: { ok: true }, reportId: 'b' });

    expect(store.getReportExport('wecom:account:a').reportId).toBe('a');
    expect(store.getReportExport('wecom:account:b').reportId).toBe('b');
  });

  test('keeps lightweight query context longer than result data and clears it by scope', () => {
    const resolvedQuery = {
      service: 'timeValues',
      queryModeKey: 'timeseries',
      groups: [{ type: 'TotalTraffic' }],
      metrics: ['TPIO'],
      timeRange: { key: 'last24hours' },
      granularity: 3600
    };
    store.rememberQueryContext({
      scope: 'wecom:account:a',
      turnId: 'turn-a',
      sourceTool: 'napm-skill-query',
      resolvedQuery
    });

    now += 7 * 60 * 1_000;
    expect(store.getLatestSkillResult('wecom:account:a')).toBeNull();
    expect(store.getLatestQueryContext('wecom:account:a')).toMatchObject({
      turnId: 'turn-a',
      sourceTool: 'napm-skill-query',
      resolvedQuery
    });

    store.clearScope('wecom:account:a');
    expect(store.getLatestQueryContext('wecom:account:a')).toBeNull();
  });

  test('expires lightweight query context after its dedicated lifetime', () => {
    store.rememberQueryContext({
      scope: 'wecom:account:a',
      sourceTool: 'napm-skill-query',
      resolvedQuery: { service: 'timeValues' }
    });
    now += (30 * 60 * 1_000) + 1;

    expect(store.getLatestQueryContext('wecom:account:a')).toBeNull();
  });
});
