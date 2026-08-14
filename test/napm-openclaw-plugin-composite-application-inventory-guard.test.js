const path = require('path');

describe('napm-openclaw-plugin CompositeApplication inventory guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
      return;
    }
    process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
  });

  function createHarness(suffix = 'composite-app') {
    const hooks = new Map();
    const api = {
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        if (Array.isArray(name)) {
          name.forEach((item) => hooks.set(item, handler));
          return;
        }
        hooks.set(name, handler);
      }
    };

    plugin.register(api);
    const ctx = {
      channelId: 'wecom',
      accountId: `acct-${suffix}`,
      conversationId: `conv-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };

    return { hooks, ctx };
  }

  test('should recognize auto-detected application inventory prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isCompositeApplicationInventoryPrompt('系统中有哪些自动识别的应用')).toBe(true);
    expect(testApi.isCompositeApplicationInventoryPrompt('系统中有哪些复合协议')).toBe(true);
    expect(testApi.isCompositeApplicationInventoryPrompt('自动识别应用整体情况怎么样')).toBe(false);
  });

  test('should reject overview resolvedQuery for auto-detected application inventory prompt', async () => {
    const { hooks, ctx } = createHarness('composite-app-reject');
    const prompt = '系统中有哪些自动识别的应用';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'overview',
          overviewScene: 'auto_apps',
          queryModeKey: 'auto_app_list',
          start: 1779338400,
          end: 1779938400,
          timeRange: {
            key: 'last7days',
            displayText: '近7天'
          }
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('CompositeApplication');
    expect(result.blockReason).toContain('service=groups');
    expect(result.blockReason).toContain('overview/auto_apps');
  });

  test('should allow groups CompositeApplication resolvedQuery for auto-detected application inventory prompt', async () => {
    const { hooks, ctx } = createHarness('composite-app-allow');
    const prompt = '系统中有哪些自动识别的应用';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'groups',
          queryModeKey: 'metadata',
          semanticConstraints: {
            operation: 'metadata_list'
          },
          groups: [{ type: 'CompositeApplication' }],
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeUndefined();
  });

  test('should reject CompositeApplication inventory resolvedQuery with argument all', async () => {
    const { hooks, ctx } = createHarness('composite-app-all-argument');
    const prompt = '系统中有哪些自动识别的应用';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'groups',
          queryModeKey: 'metadata',
          semanticConstraints: {
            operation: 'metadata_list'
          },
          groups: [{ type: 'CompositeApplication', argument: 'all' }],
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('CompositeApplication');
    expect(result.blockReason).toContain('argument:"all"');
  });
});
