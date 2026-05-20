const path = require('path');

describe('napm-openclaw-plugin meta follow-up guard', () => {
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
    return {
      hooks,
      tools
    };
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

  test('should recognize napm meta follow-up prompt from previous napm context', () => {
    const testApi = plugin.__test__;
    expect(testApi.isNapmMetaFollowUpPrompt('你这次用了多长时间？时间都消耗在哪里了？', { napmRelated: true })).toBe(true);
    expect(testApi.isNapmMetaFollowUpPrompt('你构成api的思路是什么和方法来源是哪里？', { napmRelated: true })).toBe(true);
    expect(testApi.isNapmMetaFollowUpPrompt('今天星期几？', { napmRelated: true })).toBe(false);
  });

  test('should require skill-backed reply for napm meta follow-up without remembered result', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('meta-followup-required');

    messageReceived({ content: '业务组都有什么下钻路径？' }, ctx);
    await beforePromptBuild({ prompt: '业务组都有什么下钻路径？' }, ctx);

    messageReceived({ content: '你这次用了多长时间？时间都消耗在哪里了？' }, ctx);
    await beforePromptBuild({ prompt: '你这次用了多长时间？时间都消耗在哪里了？' }, ctx);

    const result = await messageSending({
      content: '从收到问题到返回结果约 8 秒，我先写了 Node.js 脚本，然后又重试了一次。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('必须经 NAPM skill 执行后才能回答');
    expect(result.content).not.toContain('Node.js 脚本');
    expect(result.content).not.toContain('约 8 秒');
  });
});
