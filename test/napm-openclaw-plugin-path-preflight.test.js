const path = require('path');

describe('napm-openclaw-plugin path preflight', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
      return;
    }
    process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
  });

  test('should preflight explicit object path into planned drilldown groups', () => {
    const testApi = plugin.__test__;
    const next = testApi.prepareSkillExecutionArgs({
      prompt: '看这个业务组下面的应用',
      userQuery: '看这个业务组下面的应用',
      resolvedQuery: {
        service: 'groups',
        groups: [{ type: 'BusinessGroup', argument: '服务器网段' }],
        format: 'json'
      }
    });

    expect(next.resolvedQuery.groups).toEqual([
      { type: 'BusinessGroup', argument: '服务器网段' },
      { type: 'Applications', argument: null },
      { type: 'DefinedApp', argument: null }
    ]);
    expect(next.resolvedQuery.pathPlanning).toMatchObject({
      applied: true,
      preflightSource: 'napm_openclaw_plugin',
      selectedPath: ['BusinessGroup', 'Applications', 'DefinedApp']
    });
    expect(next.resolvedQuery.semanticConstraints).toMatchObject({
      targetObjectType: 'DefinedApp'
    });
    expect(next.resolvedQuery.resolutionHints).toMatchObject({
      group: {
        type: 'DefinedApp',
        source: 'plugin_path_preflight'
      }
    });
  });

  test('should preflight continuation prompt from session last_groups when resolvedQuery has no groups', () => {
    const testApi = plugin.__test__;
    const next = testApi.prepareSkillExecutionArgs({
      prompt: '继续看下面的页面',
      userQuery: '继续看下面的页面',
      sessionState: {
        last_groups: [{ type: 'WebApplication', argument: '回函238web' }]
      },
      resolvedQuery: {
        service: 'groups',
        semanticConstraints: {
          followUpAction: 'drilldown'
        },
        format: 'json'
      }
    });

    expect(next.resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: '回函238web' },
      { type: 'PageFamilies', argument: null },
      { type: 'PageFamily', argument: null }
    ]);
    expect(next.resolvedQuery.pathPlanning).toMatchObject({
      followUpAction: 'drilldown',
      selectedPath: ['WebApplication', 'PageFamilies', 'PageFamily']
    });
    expect(next.resolvedQuery.semanticConstraints).toMatchObject({
      followUpAction: 'drilldown',
      targetObjectType: 'PageFamily'
    });
  });

  test('should not rewrite overview resolvedQuery during path preflight', () => {
    const testApi = plugin.__test__;
    const next = testApi.prepareSkillExecutionArgs({
      prompt: '现在应用整体情况怎么样？',
      userQuery: '现在应用整体情况怎么样？',
      resolvedQuery: {
        service: 'overview',
        overviewScene: 'application',
        semanticConstraints: {
          operation: 'overview',
          overviewScene: 'application'
        },
        groups: [{ type: 'BusinessGroup', argument: '服务器网段' }],
        format: 'json'
      }
    });

    expect(next.resolvedQuery.service).toBe('overview');
    expect(next.resolvedQuery.overviewScene).toBe('application');
    expect(next.resolvedQuery.pathPlanning).toBeUndefined();
  });

  test('should expose canonical skill tool params with preflighted path', () => {
    const testApi = plugin.__test__;
    const next = testApi.buildCanonicalSkillToolParams('看这个业务组下面的应用', {
      resolvedQuery: {
        service: 'groups',
        groups: [{ type: 'BusinessGroup', argument: '服务器网段' }],
        format: 'json'
      }
    });

    expect(next.prompt).toBe('看这个业务组下面的应用');
    expect(next.userQuery).toBe('看这个业务组下面的应用');
    expect(next.resolvedQuery.pathPlanning).toMatchObject({
      selectedPath: ['BusinessGroup', 'Applications', 'DefinedApp']
    });
  });
});
