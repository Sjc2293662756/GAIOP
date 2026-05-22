const path = require('path');

describe('napm-openclaw-plugin business inventory guard', () => {
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

  test('should recognize business object inventory prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isBusinessObjectInventoryPrompt('\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f')).toBe(true);
    expect(testApi.isBusinessObjectInventoryPrompt('\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f')).toBe(false);
  });

  test('should not build business object inventory helper resolvedQuery in strict-only boundary', () => {
    const testApi = plugin.__test__;
    const resolvedQuery = testApi.buildBusinessObjectInventoryResolvedQuery('\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f');

    expect(resolvedQuery).toBeNull();
  });

  test('should preserve raw prompt and avoid injecting resolvedQuery during skill arg preparation', () => {
    const testApi = plugin.__test__;
    const prompt = '\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f';
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt,
      userQuery: prompt
    });

    expect(prepared.prompt).toBe(prompt);
    expect(prepared.userQuery).toBe(prompt);
    expect(prepared.resolvedQuery).toBeUndefined();
  });

  test('should preserve raw prompt and avoid injecting resolvedQuery in canonical skill params', () => {
    const testApi = plugin.__test__;
    const prompt = '\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f';
    const prepared = testApi.buildCanonicalSkillToolParams(prompt, {});

    expect(prepared.prompt).toBe(prompt);
    expect(prepared.userQuery).toBe(prompt);
    expect(prepared.resolvedQuery).toBeUndefined();
  });

  test('should block business inventory skill call without upstream resolvedQuery', async () => {
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
      accountId: 'acct-business-group-block',
      conversationId: 'conv-business-group-block',
      sessionKey: 'session-business-group-block',
      sessionId: 'session-business-group-block',
      runId: 'run-business-group-block'
    };

    const prompt = '系统中有哪些工作组？';
    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('resolvedQuery');
    expect(result.blockReason).toContain('OpenClaw must construct resolvedQuery first');
  }, 30000);

  test('should allow business-group inventory skill call with upstream resolvedQuery', async () => {
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
      accountId: 'acct-business-group-allow',
      conversationId: 'conv-business-group-allow',
      sessionKey: 'session-business-group-allow',
      sessionId: 'session-business-group-allow',
      runId: 'run-business-group-allow'
    };

    const prompt = '系统中有哪些工作组？';
    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'groups',
          queryModeKey: 'metadata',
          semanticConstraints: {
            operation: 'metadata_list',
            targetObjectType: 'BusinessGroup'
          },
          groups: [{ type: 'BusinessGroup' }],
          start: 1779336000,
          end: 1779422400,
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.params).toMatchObject({
      prompt,
      userQuery: prompt,
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'BusinessGroup' }]
      }
    });
    expect(result.params.traceId).toContain('napm-run-business-group-allow');
  }, 30000);
});
