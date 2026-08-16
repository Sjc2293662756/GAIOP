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

  test('should distinguish packet metrics from packet capture operations', () => {
    const testApi = plugin.__test__;

    expect(testApi.isPacketCapturePrompt('Show the top IPs by packet loss rate.')).toBe(false);
    expect(testApi.isPacketCapturePrompt('Analyze the packet loss trend for this business.')).toBe(false);
    expect(testApi.isPacketCapturePrompt('\u6700\u8fd1\u4e22\u5305\u8f83\u5927\u7684\u524d10\u4e2aIP\u90fd\u6709\u54ea\u4e9b\uff1f')).toBe(false);
    expect(testApi.isPacketCapturePrompt('Capture packets for 10.0.0.1.')).toBe(true);
    expect(testApi.isPacketCapturePrompt('Download the raw packet payload.')).toBe(true);
    expect(testApi.isPacketCapturePrompt('Analyze this pcap file.')).toBe(true);
    expect(testApi.isPacketCapturePrompt('\u4e0b\u8f7d\u8fd9\u4e2a\u544a\u8b66\u7684\u6570\u636e\u5305\u5e76\u5206\u6790\u3002')).toBe(true);
  });

  test('should not build packet loss helper resolvedQuery in strict-only boundary', () => {
    const testApi = plugin.__test__;
    const resolvedQuery = testApi.buildPacketLossClientTopResolvedQuery('\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f');

    expect(resolvedQuery).toBeNull();
  });

  test('should preserve raw packet loss prompt without injecting resolvedQuery', () => {
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

  test('should route packet loss rankings as metric queries instead of packet capture requests', async () => {
    const hooks = new Map();
    plugin.register({
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        const names = Array.isArray(name) ? name : [name];
        names.forEach((eventName) => hooks.set(eventName, handler));
      }
    });

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-loss-ranking',
      conversationId: 'conv-loss-ranking',
      sessionKey: 'session-loss-ranking',
      sessionId: 'session-loss-ranking',
      runId: 'run-loss-ranking'
    };
    const prompt = 'Show the top 10 IP addresses with the highest packet loss in the last hour.';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'topValues',
          queryModeKey: 'topn',
          metric: 'PLI',
          topMetric: 'PLI',
          groups: [{ type: 'IPAddress', argument: null }],
          start: 1786070400,
          end: 1786074000,
          topCount: 10,
          sortOrder: 'desc',
          userRequirement: prompt
        }
      }
    }, ctx);

    expect(result?.block).not.toBe(true);
    expect(result?.blockReason || '').not.toContain('napm-packet-analysis');
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
});
