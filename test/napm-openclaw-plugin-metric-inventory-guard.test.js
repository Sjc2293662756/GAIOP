const path = require('path');

describe('napm-openclaw-plugin metric inventory guard', () => {
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

  function completeBoundQueryResult(prompt, bound, result) {
    const testApi = plugin.__test__;
    const scope = testApi.getTrustedConversationKey(bound.params);
    const turnId = testApi.getTrustedTurnId(bound.params);
    testApi.queryTurnCoordinator.beginExecution({
      scope,
      turnId,
      attemptId: 'metric-inventory-query',
      queryDraft: bound.params.resolvedQuery
    });
    const rememberedRecord = testApi.rememberSkillResult(
      prompt,
      result,
      scope,
      'napm-skill-query',
      turnId
    );
    const finalContent = testApi.buildRememberedSkillReplyText(rememberedRecord);
    testApi.queryTurnCoordinator.recordResult({ scope, turnId, result, finalContent });
    return { scope, turnId, finalContent };
  }

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

  test('should synchronously rewrite from the authoritative Query Turn result without refresh', async () => {
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

    const bound = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'metrics',
          queryModeKey: 'metadata',
          groups: [{ type: 'WebApplication' }],
          semanticConstraints: {
            operation: 'metadata_list',
            targetObjectType: 'WebApplication'
          }
        }
      }
    }, ctx);
    const completed = completeBoundQueryResult(prompt, bound, {
      ok: true,
      displayText: '业务可查指标已返回。',
      resolvedQuery: bound.params.resolvedQuery
    });

    const result = beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '旧的泛化错误回答' }]
      }
    }, ctx);

    expect(result).not.toBeInstanceOf(Promise);
    expect(result?.message?.content?.[0]?.text).toBe(completed.finalContent);
  }, 30000);

  test('should not rewrite a metric inventory answer that mentions another object type', async () => {
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

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-defined-app-reference',
      conversationId: 'conv-metric-defined-app-reference',
      sessionKey: 'session-metric-defined-app-reference',
      sessionId: 'session-metric-defined-app-reference',
      runId: 'run-metric-defined-app-reference'
    };
    const prompt = '业务有哪些指标可以用？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    const bound = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'metrics',
          queryModeKey: 'metadata',
          groups: [{ type: 'WebApplication' }]
        }
      }
    }, ctx);
    completeBoundQueryResult(prompt, bound, {
      ok: true,
      service: 'metrics',
      resolvedQuery: bound.params.resolvedQuery,
      summary: { title: '指标列表', rowCount: 2, empty: false },
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'PGTME', label: '页面延时', unit: 'sec' }
      ],
      narrationStructure: { responseType: 'metric_list', displayText: null }
    });

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '业务（WebApplication）共返回 2 个指标。另有应用类（DefinedApp）指标可单独查询。'
        }]
      }
    }, ctx);

    expect(result?.message?.content?.[0]?.text).toContain('PGNPGE');
    expect(result?.message?.content?.[0]?.text).toContain('PGTME');
    expect(result?.message?.content?.[0]?.text).toContain('业务访问');
    expect(result?.message?.content?.[0]?.text).toContain('业务性能');
    expect(result?.message?.content?.[0]?.text).not.toMatch(/^\d+\.\s+/m);
    expect(result?.message?.content?.[0]?.text).not.toContain('另有应用类');
    expect(result?.message?.content?.[0]?.text).not.toBe('指标列表');
  }, 30000);

  test('should use the deterministic metric inventory in async message_sending path', async () => {
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
      accountId: 'acct-metric-send',
      conversationId: 'conv-metric-send',
      sessionKey: 'session-metric-send',
      sessionId: 'session-metric-send',
      runId: 'run-metric-send'
    };

    const prompt = '业务都可以查哪些指标？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const bound = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'metrics',
          queryModeKey: 'metadata',
          groups: [{ type: 'WebApplication' }],
          semanticConstraints: {
            operation: 'metadata_list',
            targetObjectType: 'WebApplication'
          }
        }
      }
    }, ctx);
    completeBoundQueryResult(prompt, bound, {
      ok: true,
      service: 'metrics',
      summary: { title: '指标列表', rowCount: 2, empty: false },
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'PGRT', label: '页面访问率', unit: 'pages/min' }
      ],
      narrationStructure: { responseType: 'metric_list', displayText: null },
      resolvedQuery: bound.params.resolvedQuery
    });

    const result = await messageSending({
      content: 'NAPM中业务维度可查的指标：流量类：总吞吐、入向吞吐、出向吞吐'
    }, ctx);

    expect(result?.content).toContain('PGNPGE');
    expect(result?.content).toContain('PGRT');
    expect(result?.content).toContain(
      '页面访问（访问数 PGNPGE，pages；访问率 PGRT，pages/min）'
    );
    expect(result?.content).not.toMatch(/^\d+\.\s+/m);
    expect(result?.content).not.toContain('总吞吐');

    const persisted = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '模型再次改写的错误文本' }]
      }
    }, ctx);
    expect(persisted?.message?.content?.[0]?.text).toBe(result?.content);
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

    expect(result?.content).toContain('本轮未拿到有效 skill 结果');
  }, 30000);

  test('should not reuse a prior metric inventory result in a new turn', async () => {
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
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-metric-fresh-turn',
      conversationId: 'conv-metric-fresh-turn',
      sessionKey: 'session-metric-fresh-turn',
      sessionId: 'session-metric-fresh-turn',
      runId: 'run-metric-fresh-turn-1'
    };
    const prompt = '业务有哪些指标可以用？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    const bound = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'metrics',
          queryModeKey: 'metadata',
          groups: [{ type: 'WebApplication' }]
        }
      }
    }, ctx);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      service: 'metrics',
      displayText: '上一轮业务指标结果',
      resolvedQuery: bound.params.resolvedQuery
    }, plugin.__test__.getTrustedConversationKey(bound.params), 'napm-skill-query', plugin.__test__.getTrustedTurnId(bound.params));

    ctx.runId = 'run-metric-fresh-turn-2';
    messageReceived({ content: prompt }, ctx);
    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '模型未调用本轮 Skill 的旧答案' }]
      }
    }, ctx);

    expect(result?.message?.content?.[0]?.text).toContain('本轮未拿到有效 skill 结果');
  }, 30000);

  test('should rewrite unverified business metric inventory before persistence', async () => {
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

    expect(result?.message?.content?.[0]?.text).toContain('本轮未拿到有效 skill 结果');
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
    expect(result.blockReason).toContain('OpenClaw may reconstruct resolvedQuery once');
  }, 30000);

  test('should advertise queryDraft-first contract with a resolvedQuery compatibility alias', () => {
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
    expect(skillTool.description).toContain('structured queryDraft');
    expect(skillTool.description).toContain('legacy alias: resolvedQuery');
    expect(skillTool.parameters.properties.queryDraft.description).toContain('QueryDecisionPolicy');
    expect(skillTool.parameters.anyOf).toEqual(expect.arrayContaining([
      { required: ['queryDraft'] },
      { required: ['resolvedQuery'] }
    ]));
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

    expect(result?.content).toContain('本轮未拿到有效 skill 结果');
  }, 30000);
});
