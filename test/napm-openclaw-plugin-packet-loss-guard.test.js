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

  test('should recognize packet-loss top prompts without explicit client wording', () => {
    const testApi = plugin.__test__;

    expect(testApi.isPacketLossClientTopPrompt('现在丢包最大的地址是谁？')).toBe(true);
    expect(testApi.isPacketLossClientTopPrompt('现在丢包最多的客户端是谁？')).toBe(true);
    expect(testApi.isPacketLossClientTopPrompt('现在按丢包率排序看丢包最大的IP是谁？')).toBe(true);
    expect(testApi.isPacketLossClientTopPrompt('现在系统整体情况怎么样？')).toBe(false);
  });

  test('should build packet-loss resolvedQuery with metric-aligned sort and top1 default', () => {
    const testApi = plugin.__test__;
    const resolvedQuery = testApi.buildPacketLossClientTopResolvedQuery('现在丢包最大的地址是谁？');

    expect(resolvedQuery).toBeTruthy();
    expect(resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'PLI',
      groups: [{ type: 'IPAddress' }],
      topCount: 1,
      format: 'json',
      userRequirement: '现在丢包最大的地址是谁？'
    });
    expect(resolvedQuery.start).toBeGreaterThan(0);
    expect(resolvedQuery.end).toBeGreaterThan(resolvedQuery.start);
  });

  test('should inject packet-loss resolvedQuery into skill execution args', () => {
    const testApi = plugin.__test__;
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt: '现在丢包最大的地址是谁？',
      userQuery: '现在丢包最大的地址是谁？'
    });

    expect(prepared.resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'PLI',
      groups: [{ type: 'IPAddress' }]
    });
  });

  test('should rewrite packet-loss topn result into concise user-facing answer', async () => {
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
      accountId: 'acct-loss',
      conversationId: 'conv-loss',
      sessionKey: 'session-loss',
      sessionId: 'session-loss',
      runId: 'run-loss'
    };

    const prompt = '现在丢包最大的地址是谁？';
    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    await skillTool.execute('tool-call-loss', {
      prompt,
      userQuery: prompt,
      resolvedQuery: {
        service: 'topValues',
        metric: 'PLI',
        metrics: ['PLI'],
        topMetric: 'PLI',
        groups: [{ type: 'IPAddress' }],
        start: 1778216700,
        end: 1778303100,
        topCount: 1,
        format: 'json',
        userRequirement: prompt
      }
    });

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I see the issue - 让我换个角度继续查。' }]
      }
    }, ctx);

    expect(result).toBeTruthy();
    const text = result.message.content?.[0]?.text || '';
    expect(text).toContain('丢包最大的地址');
    expect(text).toContain('数据时间');
    expect(text).not.toContain('I see the issue');
  }, 30000);
});
