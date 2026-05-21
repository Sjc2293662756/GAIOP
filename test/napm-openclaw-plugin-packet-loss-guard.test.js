const path = require('path');

describe('napm-openclaw-plugin packet loss guard', () => {
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

  test('should recognize packet loss top client prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isPacketLossClientTopPrompt('\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f')).toBe(true);
    expect(testApi.isPacketLossClientTopPrompt('\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f')).toBe(false);
  });

  test('should build packet loss helper resolvedQuery', () => {
    const testApi = plugin.__test__;
    const resolvedQuery = testApi.buildPacketLossClientTopResolvedQuery('\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f');

    expect(resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'PLI',
      groups: [{ type: 'IPAddress' }],
      topCount: 1,
      format: 'json',
      userRequirement: '\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f'
    });
    expect(resolvedQuery.start).toBeGreaterThan(0);
    expect(resolvedQuery.end).toBeGreaterThan(resolvedQuery.start);
  });

  test('should preserve raw prompt and avoid injecting resolvedQuery during skill arg preparation', () => {
    const testApi = plugin.__test__;
    const prompt = '\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f';
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt,
      userQuery: prompt
    });

    expect(prepared.prompt).toBe(prompt);
    expect(prepared.userQuery).toBe(prompt);
    expect(prepared.resolvedQuery).toBeUndefined();
  });

  test('should reroute direct topn tool back through skill even after a NAPM turn is active', async () => {
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
    const beforeToolCall = hooks.get('before_tool_call');
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-loss-reroute',
      conversationId: 'conv-loss-reroute',
      sessionKey: 'session-loss-reroute',
      sessionId: 'session-loss-reroute',
      runId: 'run-loss-reroute'
    };
    const prompt = '\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    const result = await beforeToolCall({
      toolName: 'napm-topn',
      params: {
        metric: 'PLI',
        group: 'IPAddress',
        start: 1779250380,
        end: 1779336780,
        topCount: 5
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.params.__napmForwardToSkill).toBe(true);
    expect(result.params.__napmForwardPrompt).toBe(prompt);
  }, 30000);

  test('should preserve remembered packet loss skill reply text', () => {
    const testApi = plugin.__test__;
    const reply = testApi.buildPromptScopedReplyTextFromRememberedRecord('\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f', {
      resolvedQuery: {
        service: 'topValues',
        metric: 'PLI',
        topMetric: 'PLI',
        userRequirement: '\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f'
      },
      result: {
        rows: [{ object: '10.0.0.1', value: 12.5 }],
        displayText: '\u5f53\u524d\u4e22\u5305\u6700\u9ad8\u7684\u5ba2\u6237\u7aefIP\u662f 10.0.0.1\uff0c\u4e22\u5305\u7387 12.5%\u3002'
      }
    });

    expect(reply).toContain('10.0.0.1');
    expect(reply).toContain('12.5%');
  });
});
