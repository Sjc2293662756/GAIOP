const path = require('path');

describe('napm-openclaw-plugin metric inventory guard', () => {
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

  test('should recognize plain business metric inventory prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isMetricInventoryPrompt('业务都可以查哪些指标？')).toBe(true);
    expect(testApi.inferMetricInventoryGroup('业务都可以查哪些指标？')).toBe('WebApplication');
    expect(testApi.inferMetricInventoryGroup('业务组都可以查哪些指标？')).toBe('BusinessGroup');
    expect(testApi.buildMetricInventoryResolvedQuery('业务都可以查哪些指标？')).toBeNull();
  });

  test('should classify detailed metric inventory follow-up as detail prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isMetricInventoryDetailPrompt('详细点')).toBe(true);
    expect(testApi.isMetricInventoryDetailPrompt('把每一类展开一下')).toBe(true);
    expect(testApi.isMetricInventoryDetailPrompt('业务都可以查哪些指标？')).toBe(false);
  });

  test('should leave before_message_write as a synchronous non-refresh hook', async () => {
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
      accountId: 'acct-metric',
      conversationId: 'conv-metric',
      sessionKey: 'session-metric',
      sessionId: 'session-metric',
      runId: 'run-metric'
    };

    const prompt = '业务都可以查哪些指标？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    await skillTool.execute('tool-call-1', {
      prompt,
      userQuery: prompt,
      resolvedQuery: {
        service: 'topValues',
        metric: 'TPIO',
        groups: [{ type: 'BusinessGroup' }],
        start: 1778227800,
        end: 1778314200,
        topMetric: 'TPIO',
        topCount: 5,
        format: 'json'
      }
    });

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '旧的泛化错误回答' }]
      }
    }, ctx);

    expect(result).toBeUndefined();
  }, 30000);

  test('should require upstream resolvedQuery instead of rewriting metric inventory reply during async message_sending path', async () => {
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
    const skillTool = tools.get('napm-skill-query');

    expect(typeof messageReceived).toBe('function');
    expect(typeof beforePromptBuild).toBe('function');
    expect(typeof messageSending).toBe('function');
    expect(skillTool).toBeTruthy();

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-send',
      conversationId: 'conv-metric-send',
      sessionKey: 'session-metric-send',
      sessionId: 'session-metric-send',
      runId: 'run-metric-send'
    };

    const prompt = '业务都可以查哪些指标？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    await skillTool.execute('tool-call-2', {
      prompt,
      userQuery: prompt,
      resolvedQuery: {
        service: 'topValues',
        metric: 'TPIO',
        groups: [{ type: 'BusinessGroup' }],
        start: 1778227800,
        end: 1778314200,
        topMetric: 'TPIO',
        topCount: 5,
        format: 'json'
      }
    });

    const result = await messageSending({
      content: 'NAPM中业务维度可查的指标：流量类：总吞吐、入向吞吐、出向吞吐'
    }, ctx);

    expect(result).toBeUndefined();
  }, 30000);

  test('should require upstream resolvedQuery when model never called tool', async () => {
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
    const messageSending = hooks.get('message_sending');

    expect(typeof messageReceived).toBe('function');
    expect(typeof messageSending).toBe('function');

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-fallback',
      conversationId: 'conv-metric-fallback',
      sessionKey: 'session-metric-fallback',
      sessionId: 'session-metric-fallback',
      runId: 'run-metric-fallback'
    };

    const prompt = '业务都可以查哪些指标？';
    messageReceived({ content: prompt }, ctx);

    const result = await messageSending({
      content: 'NAPM中业务维度可查的指标：流量类：总吞吐、入向吞吐、出向吞吐'
    }, ctx);

    expect(result).toBeUndefined();
  }, 30000);

  test('should not rewrite business metric inventory reply during before_message_write', async () => {
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

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-before-write',
      conversationId: 'conv-metric-before-write',
      sessionKey: 'session-metric-before-write',
      sessionId: 'session-metric-before-write',
      runId: 'run-metric-before-write'
    };

    const prompt = '业务都可以查哪些指标？';
    messageReceived({ content: [{ type: 'text', text: prompt }] }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '业务组（BusinessGroup）视角可查指标如下：BGPKTS、BGBITS、BGRTT、BGRETRANSPCT。'
        }]
      }
    }, ctx);

    expect(result).toBeUndefined();
  }, 30000);

  test('should block metric inventory skill call without upstream resolvedQuery', async () => {
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
      accountId: 'acct-metric-canonical',
      conversationId: 'conv-metric-canonical',
      sessionKey: 'session-metric-canonical',
      sessionId: 'session-metric-canonical',
      runId: 'run-metric-canonical'
    };

    const rawPrompt = '业务都可以查哪些指标？';
    messageReceived({ content: rawPrompt }, ctx);
    await beforePromptBuild({ prompt: rawPrompt }, ctx);

    const result = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt: '业务组BusinessGroup都可以查哪些指标？列出所有可查指标',
        userQuery: '业务组BusinessGroup都可以查哪些指标？列出所有可查指标'
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('resolvedQuery');
    expect(result.blockReason).toContain('OpenClaw must construct resolvedQuery first');
  }, 30000);

  test('should advertise resolvedQuery-first contract in skill tool description', () => {
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
    const skillTool = tools.get('napm-skill-query');

    expect(skillTool).toBeTruthy();
    expect(skillTool.description).toContain('structured resolvedQuery');
    expect(skillTool.parameters.properties.resolvedQuery.description).toContain('Required');
  });

  test('should block exec when raw session prompt is a business metric inventory ask', async () => {
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
    const beforeToolCall = hooks.get('before_tool_call');

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-exec-block',
      conversationId: 'conv-metric-exec-block',
      sessionKey: 'session-metric-exec-block',
      sessionId: 'session-metric-exec-block',
      runId: 'run-metric-exec-block'
    };

    const rawPrompt = '业务都可以查哪些指标？';
    messageReceived({ content: rawPrompt }, ctx);

    const result = await beforeToolCall({
      toolName: 'exec',
      params: {
        command: 'curl https://101.254.114.238/webservice/NetInside?type=metricsForGroup&groupType1=BusinessGroup'
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('napm-skill-query');
  }, 30000);

  test('should block removed direct napm tool for business metric inventory ask', async () => {
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
    const beforeToolCall = hooks.get('before_tool_call');

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-direct-reroute',
      conversationId: 'conv-metric-direct-reroute',
      sessionKey: 'session-metric-direct-reroute',
      sessionId: 'session-metric-direct-reroute',
      runId: 'run-metric-direct-reroute'
    };

    const rawPrompt = '业务都可以查哪些指标？';
    messageReceived({ content: rawPrompt }, ctx);

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
  }, 30000);

  test('should require upstream resolvedQuery for metric inventory details without a remembered skill result', async () => {
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
    const skillTool = tools.get('napm-skill-query');

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-detail',
      conversationId: 'conv-metric-detail',
      sessionKey: 'session-metric-detail',
      sessionId: 'session-metric-detail',
      runId: 'run-metric-detail'
    };

    const firstPrompt = '业务都可以查哪些指标？';
    messageReceived({ content: firstPrompt }, ctx);
    await beforePromptBuild({ prompt: firstPrompt }, ctx);
    await skillTool.execute('tool-call-detail-1', {
      prompt: firstPrompt,
      userQuery: firstPrompt
    });

    messageReceived({ content: '详细点' }, ctx);

    const result = await messageSending({
      content: 'This is a NAPM metric inquiry — let me query the skill to get a clear picture.'
    }, ctx);

    expect(result).toBeUndefined();
  }, 30000);
});
