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
});
