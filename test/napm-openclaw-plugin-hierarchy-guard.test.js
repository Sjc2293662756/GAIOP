const path = require('path');

describe('napm-openclaw-plugin hierarchy fallback guard', () => {
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

  test('should recognize hierarchy drilldown prompts', () => {
    const testApi = plugin.__test__;
    expect(testApi.isHierarchyCatalogPrompt('业务组都有哪些下钻路径？')).toBe(true);
    expect(testApi.isHierarchyCatalogPrompt('IP地址支持哪些下钻路径？')).toBe(true);
    expect(testApi.normalizeHierarchyQuestionTarget('BusinessGroup 可以往下钻到哪里？')).toBe('BusinessGroup');
    expect(testApi.normalizeHierarchyQuestionTarget('IP地址支持哪些下钻路径？')).toBe('IPAddress');
  });

  test('should synchronously use the authoritative hierarchy result without refresh', async () => {
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
      accountId: 'acct-b',
      conversationId: 'conv-b',
      sessionKey: 'session-b',
      sessionId: 'session-b',
      runId: 'run-b'
    };

    const prompt = '业务组都有哪些下钻路径？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const bound = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'drilldownCatalog',
          queryModeKey: 'metadata',
          groups: [{ type: 'BusinessGroup' }],
          userRequirement: prompt
        }
      }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    const queryResult = {
      ok: true,
      displayText: '业务组下钻路径已返回。',
      resolvedQuery: bound.params.resolvedQuery
    };
    plugin.__test__.queryTurnCoordinator.beginExecution({
      scope,
      turnId,
      attemptId: 'hierarchy-query',
      queryDraft: bound.params.resolvedQuery
    });
    plugin.__test__.rememberSkillResult(prompt, queryResult, scope, 'napm-skill-query', turnId);
    plugin.__test__.queryTurnCoordinator.recordResult({
      scope,
      turnId,
      result: queryResult,
      finalContent: queryResult.displayText
    });

    const result = beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '模型自由回答的泛化话术' }]
      }
    }, ctx);

    expect(result).not.toBeInstanceOf(Promise);
    expect(result?.message?.content?.[0]?.text).toBe(queryResult.displayText);
  }, 30000);

  test('should require upstream resolvedQuery for hierarchy prompt when model skipped tool', async () => {
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
      accountId: 'acct-hierarchy-fallback',
      conversationId: 'conv-hierarchy-fallback',
      sessionKey: 'session-hierarchy-fallback',
      sessionId: 'session-hierarchy-fallback',
      runId: 'run-hierarchy-fallback'
    };

    const prompt = 'BusinessGroup 可以往下钻到哪里？';
    messageReceived({ content: prompt }, ctx);

    const result = await messageSending({
      content: 'NAPM中业务组的下钻路径通常包括：按业务系统、按IP下钻'
    }, ctx);

    expect(result).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('service=drilldownCatalog');
    expect(result.content).toContain('napm-skill-query');
    expect(result.content).toContain('本轮没有拿到有效的 drilldownCatalog skill 结果');
  }, 30000);

  test('should block manual children-empty hierarchy inference for drilldown prompts', async () => {
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

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-hierarchy-manual',
      conversationId: 'conv-hierarchy-manual',
      sessionKey: 'session-hierarchy-manual',
      sessionId: 'session-hierarchy-manual',
      runId: 'run-hierarchy-manual'
    };

    const prompt = '现在业务组有哪些下钻路径？';
    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await messageSending({
      content: [
        '读取本地静态文件 groups-tree.static.json，找到 key: "BusinessGroup" 节点。',
        '该节点 children: []，所以系统中 BusinessGroup 在维度树中没有子节点。',
        'BusinessGroup -> IPAddress 等组合路径是基于 NAPM 维度体系的理解推测。'
      ].join('\n')
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('service=drilldownCatalog');
    expect(result.content).toContain('napm-skill-query');
    expect(result.content).not.toContain('该节点 children: []');
    expect(result.content).not.toContain('BusinessGroup -> IPAddress');
  }, 30000);
});
