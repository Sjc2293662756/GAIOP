const path = require('path');

describe('napm-openclaw-plugin out-of-scope guard', () => {
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

  function createApiHarness() {
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
    return { hooks, tools };
  }

  function createWeComCtx(suffix) {
    return {
      channelId: 'wecom',
      accountId: `acct-${suffix}`,
      conversationId: `conv-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };
  }

  test('should rewrite weather prompt during message_sending', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('weather-send');
    const prompt = '今天天气怎么样？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await messageSending({
      content: '北京今天（5月14日）天气：晴，29°C。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('我当前只处理系统监控');
    expect(result.content).toContain('天气');
  });

  test('should rewrite weather prompt during before_message_write', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeMessageWrite = hooks.get('before_message_write');

    const ctx = createWeComCtx('weather-write');
    const prompt = '今天天气怎么样？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '北京今天（5月14日）天气：晴，29°C。' }]
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.message.content[0].text).toContain('我当前只处理系统监控');
    expect(result.message.content[0].text).toContain('天气');
  });
});
