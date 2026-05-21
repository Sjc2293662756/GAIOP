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

  test('should refresh overview reply during message_sending when remembered result is not overview', async () => {
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
    const messageSending = hooks.get('message_sending');
    const beforeMessageWrite = hooks.get('before_message_write');
    const skillTool = tools.get('napm-skill-query');
    expect(typeof messageReceived).toBe('function');
    expect(typeof beforePromptBuild).toBe('function');
    expect(typeof messageSending).toBe('function');
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

    const prompt = '\u73b0\u5728\u5e94\u7528\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f';

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
        content: [{ type: 'text', text: '\u65e7\u7684\u81ea\u7531\u56de\u7b54' }]
      }
    }, ctx);

    expect(beforeWriteResult).toBeUndefined();

    const result = await messageSending({
      content: '\u65e7\u7684\u81ea\u7531\u56de\u7b54'
    }, ctx);

    expect(result).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect(result.content).toMatch(/(?:\u5e94\u7528.*\u6982\u89c8|\u5f53\u524d\u5e94\u7528\u6574\u4f53)/);
    expect(result.content).not.toContain('\u4e1a\u52a1\u7ec4\u6d41\u91cf\u72b6\u51b5');
  }, 30000);
});
