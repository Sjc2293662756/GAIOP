const path = require('path');

describe('napm-openclaw-plugin overview fallback guard', () => {
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

  test('should force overview refresh from current prompt when remembered result is not overview', async () => {
    const hooks = new Map();
    const tools = new Map();
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

    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const skillTool = tools.get('napm-skill-query');
    const beforeMessageWrite = hooks.get('before_message_write');
    expect(typeof messageReceived).toBe('function');
    expect(typeof beforePromptBuild).toBe('function');
    expect(typeof beforeMessageWrite).toBe('function');
    expect(skillTool).toBeTruthy();

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-a',
      conversationId: 'conv-a',
      sessionKey: 'session-a',
      sessionId: 'session-a',
      runId: 'run-a'
    };

    messageReceived({
      content: '现在应用整体情况怎么样？'
    }, ctx);

    await beforePromptBuild({
      prompt: '现在应用整体情况怎么样？'
    }, ctx);

    await skillTool.execute('tool-call-1', {
      prompt: '现在应用整体情况怎么样？',
      userQuery: '现在应用整体情况怎么样？',
      resolvedQuery: {
        service: 'topValues',
        metric: 'BYTIO',
        groups: [{ type: 'BusinessGroup' }],
        start: 1778227800,
        end: 1778314200,
        topMetric: 'BYTIO',
        topCount: 5,
        format: 'json'
      }
    });

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '旧的自由回答' }]
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.message).toBeTruthy();
    const text = result.message.content?.[0]?.text || '';
    expect(text).toContain('应用整体');
    expect(text).not.toContain('业务组流量状况');
  }, 30000);
});
