const pluginModule = require('../.codex-temp/napm-openclaw-plugin.remote.js');

describe('napm-openclaw-plugin overview scene guards', () => {
  const testApi = pluginModule.__test__;

  test('should map 业务组整体 to business_group scene', () => {
    const resolvedQuery = testApi.buildOverviewResolvedQuery('现在业务组整体情况怎么样？');
    expect(resolvedQuery).toBeTruthy();
    expect(resolvedQuery.overviewScene).toBe('business_group');
  });

  test('should replace non-overview resolvedQuery for 应用整体 prompt', () => {
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt: '现在应用整体情况怎么样？',
      userQuery: '现在应用整体情况怎么样？',
      resolvedQuery: {
        service: 'topValues',
        groups: [{ type: 'BusinessGroup' }],
        metric: 'BYTIO',
        topMetric: 'BYTIO',
        start: 1778227800,
        end: 1778314200,
        format: 'json'
      }
    });

    expect(prepared.resolvedQuery.service).toBe('overview');
    expect(prepared.resolvedQuery.overviewScene).toBe('application');
  });

  test('should replace mismatched overview scene for 应用整体 prompt', () => {
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt: '现在应用整体情况怎么样？',
      userQuery: '现在应用整体情况怎么样？',
      resolvedQuery: {
        service: 'overview',
        overviewScene: 'business_group',
        semanticConstraints: {
          operation: 'overview',
          overviewScene: 'business_group'
        },
        groups: [{ type: 'BusinessGroup' }],
        start: 1778227800,
        end: 1778314200,
        format: 'json'
      }
    });

    expect(prepared.resolvedQuery.service).toBe('overview');
    expect(prepared.resolvedQuery.overviewScene).toBe('application');
  });
});
