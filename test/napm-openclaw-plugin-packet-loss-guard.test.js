const path = require('path');

describe('napm-openclaw-plugin packet loss guard', () => {
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

  test('should recognize packet loss top client prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isPacketLossClientTopPrompt('\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f')).toBe(true);
    expect(testApi.isPacketLossClientTopPrompt('\u4e22\u5305\u6700\u5927\u7684IP\u5730\u5740\u662f\u8c01\uff1f')).toBe(true);
    expect(testApi.isPacketLossClientTopPrompt('\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f')).toBe(false);
  });

  test('should not build packet loss helper resolvedQuery in strict-only boundary', () => {
    const testApi = plugin.__test__;
    const resolvedQuery = testApi.buildPacketLossClientTopResolvedQuery('\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f');

    expect(resolvedQuery).toBeNull();
  });

  test('should not auto-resolve raw packet loss prompt before skill execution', () => {
    const testApi = plugin.__test__;
    const prompt = '\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f';
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt,
      userQuery: prompt,
      nowSeconds: 1779350400
    });

    expect(prepared.prompt).toBe(prompt);
    expect(prepared.userQuery).toBe(prompt);
    expect(prepared.resolvedQuery).toBeUndefined();
    expect(testApi.validateResolvedQueryAgainstSpec(prepared.resolvedQuery)).toMatchObject({
      ok: false,
      reason: 'missing_resolved_query'
    });
  });

  test('should preserve an explicit invalid metric instead of repairing it from prompt text', () => {
    const testApi = plugin.__test__;
    const prompt = '\u6700\u8fd1\u4e22\u5305\u7387\u6700\u9ad8\u7684\u524d10\u4e2aIP\u90fd\u6709\u8c01\uff1f';
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt,
      userQuery: prompt,
      nowSeconds: 1780974060,
      resolvedQuery: {
        service: 'topValues',
        start: 1717891200,
        end: 1717923600,
        timeRange: { key: 'last1hour', displayText: '\u6700\u8fd11\u5c0f\u65f6' },
        metric: 'packetLossRate',
        topCount: 10,
        groups: [{ type: 'IPAddress' }],
        order: 'desc'
      }
    });

    expect(prepared.resolvedQuery).toMatchObject({
      service: 'topValues',
      queryModeKey: 'topn',
      metric: 'packetLossRate',
      metrics: ['packetLossRate'],
      topMetric: 'packetLossRate',
      groups: [{ type: 'IPAddress' }],
      topCount: 10,
      start: 1717891200,
      end: 1717923600
    });
  });

  test('should normalize topValues queryModeKey to topn without replacing valid explicit query', () => {
    const testApi = plugin.__test__;
    const prompt = '\u6700\u8fd1\u4e00\u5c0f\u65f6\u4e22\u5305\u7387\u6700\u9ad8\u7684\u524d10\u4e2aIP';
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt,
      userQuery: prompt,
      nowSeconds: 1780974060,
      resolvedQuery: {
        service: 'topValues',
        queryModeKey: 'topValues',
        metric: 'PLI',
        metrics: ['PLI'],
        topMetric: 'PLI',
        groups: [{ type: 'IPAddress' }],
        topCount: 10,
        start: 1780970460,
        end: 1780974060,
        timeRange: { key: 'last1hour', displayText: '\u6700\u8fd11\u5c0f\u65f6' },
        format: 'json'
      }
    });

    expect(prepared.resolvedQuery).toMatchObject({
      service: 'topValues',
      queryModeKey: 'topn',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'PLI',
      groups: [{ type: 'IPAddress' }],
      topCount: 10,
      start: 1780970460,
      end: 1780974060
    });
  });

  test('should block removed direct topn tool even after a NAPM turn is active', async () => {
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
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('napm-topn');
    expect(result.blockReason).toContain('removed');
    expect(result.blockReason).toContain('napm-skill-query');
  }, 30000);

  test('should preserve remembered packet loss skill display text', () => {
    const testApi = plugin.__test__;
    const reply = testApi.buildRememberedSkillReplyText({
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

  test('should keep OpenClaw continuation skill result when tool prompt differs from user short prompt', async () => {
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
    const beforeMessageWrite = hooks.get('before_message_write');
    const skillTool = tools.get('napm-skill-query');
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-loss-continuation',
      conversationId: 'conv-loss-continuation',
      sessionKey: 'session-loss-continuation',
      sessionId: 'session-loss-continuation',
      runId: 'run-loss-continuation'
    };
    const shortPrompt = '\u6700\u8fd1\u4e00\u5929\u4e22\u5305\u5462\uff1f';
    const expandedPrompt = '\u6700\u8fd1\u4e00\u5929\u4e22\u5305\u6700\u4e25\u91cd\u7684\u524d10\u4e2aIP';
    const resolvedQuery = {
      service: 'topValues',
      queryModeKey: 'data',
      groups: [{ type: 'IPAddress' }],
      metrics: ['PLI', 'PLO'],
      topMetric: 'PLI',
      topCount: 10,
      start: 1779840000,
      end: 1779926400,
      timeRange: { key: 'last24hours', displayText: '\u6700\u8fd1\u4e00\u5929' },
      userRequirement: expandedPrompt,
      format: 'json'
    };

    messageReceived({ content: shortPrompt }, ctx);
    await beforePromptBuild({ prompt: shortPrompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt: expandedPrompt,
        userQuery: expandedPrompt,
        traceId: 'trace-loss-continuation',
        resolvedQuery
      }
    }, ctx);

    plugin.__test__.rememberDebugApiForPromptAliases([
      shortPrompt,
      expandedPrompt
    ], {
      ok: true,
      service: 'topValues',
      resolvedQuery,
      displayText: '\u6700\u8fd1\u4e00\u5929\u4e22\u5305\u6700\u4e25\u91cd\u7684IP\u662f 10.0.0.1\u3002'
    }, 'conv-loss-continuation');

    const result = beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '\u6700\u8fd1\u4e00\u5929\u4e22\u5305\u6700\u4e25\u91cd\u7684IP\u662f 10.0.0.1\u3002'
        }]
      }
    }, ctx);

    expect(skillTool).toBeTruthy();
    expect(result).toBeUndefined();
  });

  test('before_tool_call should block a missing resolvedQuery instead of invoking the resolver', async () => {
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
      accountId: 'acct-loss-auto-resolve',
      conversationId: 'conv-loss-auto-resolve',
      sessionKey: 'session-loss-auto-resolve',
      sessionId: 'session-loss-auto-resolve',
      runId: 'run-loss-auto-resolve'
    };
    const prompt = '\u6700\u8fd1\u4e22\u5305\u7387\u6700\u9ad8\u7684\u524d10\u4e2aIP\u90fd\u6709\u8c01\uff1f';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        nowSeconds: 1780974060
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('structured resolvedQuery');
    expect(result.blockReason).toContain('construct resolvedQuery first');
  });
});
