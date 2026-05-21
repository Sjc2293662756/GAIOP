const runNapmQuery = require('../skills/openclaw-napm-query/scripts/run_napm_query.js');

describe('overview scene routing under strict boundary', () => {
  test('application overview prompt should require upstream resolvedQuery by default', async () => {
    await expect(runNapmQuery.__test__.resolveInput({
      prompt: '现在应用整体情况怎么样？'
    }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('business overview resolvedQuery should remain executable', async () => {
    const input = await runNapmQuery.__test__.resolveInput({
      prompt: '现在业务整体情况怎么样？'
    }, {
      resolvedQuery: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'business',
        semanticConstraints: {
          operation: 'overview',
          overviewScene: 'business'
        },
        start: 1777982400,
        end: 1777986000
      }
    });

    expect(input.resolvedQuery.service).toBe('overview');
    expect(input.resolvedQuery.overviewScene).toBe('business');
    expect(input.resolvedQuery.semanticConstraints.operation).toBe('overview');
  });

  test('business-group overview resolvedQuery should remain executable', async () => {
    const input = await runNapmQuery.__test__.resolveInput({
      prompt: '现在业务组整体情况怎么样？'
    }, {
      resolvedQuery: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'business_group',
        semanticConstraints: {
          operation: 'overview',
          overviewScene: 'business_group'
        },
        start: 1777982400,
        end: 1777986000
      }
    });

    expect(input.resolvedQuery.service).toBe('overview');
    expect(input.resolvedQuery.overviewScene).toBe('business_group');
    expect(input.resolvedQuery.semanticConstraints.overviewScene).toBe('business_group');
  });
});
