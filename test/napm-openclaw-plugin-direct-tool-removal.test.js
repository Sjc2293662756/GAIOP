const path = require('path');

describe('napm-openclaw-plugin direct tool removal', () => {
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

  test('should only register napm-skill-query as public NAPM tool/command', () => {
    const hooks = new Map();
    const tools = new Map();
    const commands = new Map();
    const api = {
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      registerTool(def) {
        tools.set(def.name, def);
      },
      registerCommand(def) {
        commands.set(def.name, def);
      },
      registerHook(name, handler) {
        if (Array.isArray(name)) {
          name.forEach((item) => hooks.set(item, handler));
          return;
        }
        hooks.set(name, handler);
      }
    };

    plugin.register(api);

    expect(Array.from(tools.keys())).toEqual(['napm-skill-query']);
    expect(Array.from(commands.keys())).toEqual(['napm-skill-query']);
    expect(tools.has('napm-topn')).toBe(false);
    expect(tools.has('napm-average')).toBe(false);
    expect(tools.has('napm-timeseries')).toBe(false);
  });

  test('should block removed legacy direct tool names in before_tool_call', async () => {
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

    const beforeToolCall = hooks.get('before_tool_call');
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-direct-tool-removal',
      conversationId: 'conv-direct-tool-removal',
      sessionKey: 'session-direct-tool-removal',
      sessionId: 'session-direct-tool-removal',
      runId: 'run-direct-tool-removal'
    };

    const result = await beforeToolCall({
      toolName: 'napm-topn',
      params: {
        metric: 'TPIO',
        group: 'BusinessGroup',
        start: 1778227800,
        end: 1778314200,
        topCount: 5
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('napm-topn');
    expect(result.blockReason).toContain('removed');
    expect(result.blockReason).toContain('napm-skill-query');
  });
});
