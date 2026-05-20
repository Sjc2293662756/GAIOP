const runNapmQuery = require('../skills/openclaw-napm-query/scripts/run_napm_query.js');

describe('overview scene routing', () => {
  test('应用整体 should map to application overview', () => {
    const resolvedQuery = runNapmQuery.__test__.buildPromptFallbackResolvedQuery('现在应用整体情况怎么样？');
    expect(resolvedQuery).toBeTruthy();
    expect(resolvedQuery.service).toBe('overview');
    expect(resolvedQuery.overviewScene).toBe('application');
  });

  test('业务整体 should map to business overview', () => {
    const resolvedQuery = runNapmQuery.__test__.buildPromptFallbackResolvedQuery('现在业务整体情况怎么样？');
    expect(resolvedQuery).toBeTruthy();
    expect(resolvedQuery.service).toBe('overview');
    expect(resolvedQuery.overviewScene).toBe('business');
  });

  test('业务组整体 should map to business_group overview', () => {
    const resolvedQuery = runNapmQuery.__test__.buildPromptFallbackResolvedQuery('现在业务组整体情况怎么样？');
    expect(resolvedQuery).toBeTruthy();
    expect(resolvedQuery.service).toBe('overview');
    expect(resolvedQuery.overviewScene).toBe('business_group');
  });
});
