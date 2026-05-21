const path = require('path');

describe('napm-openclaw-plugin resolver tools', () => {
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

  test('should register resolver and mainflow tools for OpenClaw', () => {
    const tools = new Map();
    const api = {
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
      registerHook() {}
    };

    plugin.register(api);

    expect(tools.has('napm-resolve-query')).toBe(true);
    expect(tools.has('napm-mainflow-query')).toBe(true);
    expect(tools.has('napm-skill-query')).toBe(true);
  });

  test('resolver tool should construct resolvedQuery without calling skill executor', async () => {
    const resolverTool = plugin.__test__.createResolvedQueryResolverToolDefinition();
    const result = await resolverTool.execute('tool-call-1', {
      prompt: '系统中有哪些工作组？'
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.resolvedQuery).toMatchObject({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'BusinessGroup' }]
    });
  });

  test('before_tool_call should allow napm-resolve-query for active NAPM prompt', async () => {
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
      accountId: 'acct-resolver',
      conversationId: 'conv-resolver',
      sessionKey: 'session-resolver',
      sessionId: 'session-resolver',
      runId: 'run-resolver'
    };
    const prompt = '丢包最大的IP地址是谁？';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-resolve-query',
      params: { prompt }
    }, ctx);

    expect(result).toBeUndefined();
  });

  test('before_tool_call should block non-NAPM tools and redirect to mainflow resolver', async () => {
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
      accountId: 'acct-resolver-block',
      conversationId: 'conv-resolver-block',
      sessionKey: 'session-resolver-block',
      sessionId: 'session-resolver-block',
      runId: 'run-resolver-block'
    };
    const prompt = '吞吐量最大的前10个IP地址是谁？';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'exec',
      params: {
        command: 'curl https://101.254.114.238/webservice/NetInside?type=topValues'
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('napm-mainflow-query');
    expect(result.blockReason).toContain('napm-resolve-query');
    expect(result.blockReason).toContain('napm-skill-query');
  });
});
