const pluginModule = require('../.codex-temp/napm-openclaw-plugin.remote.js');

describe('napm-openclaw-plugin overview scene guards', () => {
  const originalBoundaryMode = process.env.NAPM_RESOLUTION_BOUNDARY_MODE;
  const testApi = pluginModule.__test__;

  afterEach(() => {
    if (originalBoundaryMode === undefined) {
      delete process.env.NAPM_RESOLUTION_BOUNDARY_MODE;
    } else {
      process.env.NAPM_RESOLUTION_BOUNDARY_MODE = originalBoundaryMode;
    }
  });

  test('should not expose overview helper route in strict-only boundary', () => {
    const resolvedQuery = testApi.buildOverviewResolvedQuery('\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f');

    expect(resolvedQuery).toBeNull();
  });

  test('should preserve explicit non-overview resolvedQuery during skill arg preparation', () => {
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt: '\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f',
      userQuery: '\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f',
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

    expect(prepared.resolvedQuery.service).toBe('topValues');
    expect(prepared.resolvedQuery.overviewScene).toBeUndefined();
  });

  test('should preserve explicit overview scene during skill arg preparation', () => {
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt: '\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f',
      userQuery: '\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f',
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
    expect(prepared.resolvedQuery.overviewScene).toBe('business_group');
  });

  test('should preserve explicit resolvedQuery in strict boundary mode', () => {
    process.env.NAPM_RESOLUTION_BOUNDARY_MODE = 'strict';

    const prepared = testApi.prepareSkillExecutionArgs({
      prompt: '\u73b0\u5728\u5e94\u7528\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f',
      userQuery: '\u73b0\u5728\u5e94\u7528\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f',
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

    expect(testApi.getBoundaryMode()).toBe('strict');
    expect(prepared.resolvedQuery.service).toBe('topValues');
    expect(prepared.resolvedQuery.topMetric).toBe('BYTIO');
  });
});
