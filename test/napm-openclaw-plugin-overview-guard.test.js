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

  test('should not rewrite overview reply when output layer is skill-display-only', async () => {
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
    const beforeMessageWrite = hooks.get('before_message_write');
    const skillTool = tools.get('napm-skill-query');
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

    const prompt = '现在应用整体情况怎么样？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    await skillTool.execute('tool-call-1', {
      prompt,
      userQuery: prompt,
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

    const beforeWriteResult = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '旧的自由回答' }]
      }
    }, ctx);

    expect(beforeWriteResult).toBeUndefined();
  }, 30000);
});
