const path = require('path');

describe('napm-openclaw-plugin streaming preview guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  const originalAllowReasoningPreview = process.env.NAPM_ALLOW_REASONING_PREVIEW;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
    } else {
      process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
    }
    if (originalAllowReasoningPreview === undefined) {
      delete process.env.NAPM_ALLOW_REASONING_PREVIEW;
    } else {
      process.env.NAPM_ALLOW_REASONING_PREVIEW = originalAllowReasoningPreview;
    }
  });

  afterEach(() => {
    if (originalAllowReasoningPreview === undefined) {
      delete process.env.NAPM_ALLOW_REASONING_PREVIEW;
      return;
    }
    process.env.NAPM_ALLOW_REASONING_PREVIEW = originalAllowReasoningPreview;
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

  test('should cancel streaming preview chunks before final NAPM reply is ready', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('stream-preview');
    const prompt = '系统中有哪些业务？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    const result = await messageSending({
      content: '根据 Skill 文档，用户说的“业务”映射为 WebApplication。我直接用元数据服务查询 WebApplication 列表。',
      metadata: {
        streaming: true,
        isFinal: false,
        phase: 'partial'
      }
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('should cancel leaked reasoning preview even when streaming metadata is missing', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('reasoning-preview');
    const prompt = '系统中有哪些业务？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    const leakedPreview = [
      '根据 Skill 文档，用户说的“业务”映射为 WebApplication。我直接用元数据服务查询 WebApplication 列表。',
      '查询返回的结果中，WebApplication 列出了很多项，不过这些数据既有协议类项，也有实际注册的业务系统。',
      '让我筛选出本质上属于业务系统的部分。'
    ].join('');

    const result = await messageSending({
      content: leakedPreview
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('should cancel leaked english reasoning preview without streaming metadata', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('english-reasoning-preview');
    const prompt = '流量最大的应用有哪些？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    const leakedPreview = [
      'It only returned 6 results and the results are protocol-level (HTTP, HTTPS etc.) not the custom web apps.',
      'Let me try requesting with topCount bigger and also try PGBYTI.',
      "Actually, wait - the script's raw API call succeeded earlier.",
      "Now I see the data pattern. That's suspicious.",
      'Let me take a different approach and query each custom web app individually.'
    ].join(' ');

    const result = await messageSending({
      content: leakedPreview
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('should rewrite leaked english reasoning to remembered skill reply when skill result already exists', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const messageSending = hooks.get('message_sending');
    const testApi = plugin.__test__;

    const ctx = createWeComCtx('english-reasoning-with-result');
    const prompt = '流量最大的应用有哪些？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    const rememberedResult = {
      displayText: '最近一天流量最大的业务应用是回函238web，其次是可观测239web。',
      resolvedQuery: {
        service: 'topValues',
        metric: 'PGBYTO',
        groups: [{ type: 'WebApplication' }]
      }
    };

    expect(testApi.buildRememberedSkillReplyText({ result: rememberedResult })).toContain('最近一天流量最大的业务应用');
    testApi.rememberSkillResult(prompt, rememberedResult, '');

    const leakedPreview = [
      'Previously I checked WebApplication traffic.',
      'No metrics at Application level. Let me try the AllTraffic key.',
      'Actually, the most natural answer here is to show WebApplication-level traffic.',
      'Let me re-run the query with a cleaner approach.'
    ].join(' ');

    const result = await messageSending({
      content: leakedPreview
    }, ctx);

    if (result) {
      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('最近一天流量最大的业务应用');
      expect(result.content).not.toContain('Previously I checked WebApplication traffic');
      return;
    }

    expect(result).toBeUndefined();
  });

  test('should rewrite bypass process text to skill result when prompt can be refreshed', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('bypass-process-no-result');
    const prompt = '业务组都有什么下钻路径？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await messageSending({
      content: '我先写一个 Node.js 脚本，直接调用 NapmMetadataService.getDrilldownPathsForGroupType("BusinessGroup") 看看。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('BusinessGroup');
    expect(result.content).toContain('下钻');
    expect(result.content).not.toContain('Node.js 脚本');
  });

  test('should allow leaked reasoning preview when temporary preview flag is enabled', async () => {
    process.env.NAPM_ALLOW_REASONING_PREVIEW = 'true';
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');

    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('reasoning-preview-enabled');
    const prompt = '系统中有哪些业务？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);

    const leakedPreview = [
      '根据 Skill 文档，用户说的“业务”映射为 WebApplication。',
      '我直接用元数据服务查询 WebApplication 列表。',
      '查询返回的结果中，WebApplication 列出了很多项。'
    ].join('');

    const result = await messageSending({
      content: leakedPreview,
      metadata: {
        streaming: true,
        isFinal: false,
        phase: 'partial'
      }
    }, ctx);

    expect(result).toBeUndefined();
  });
});
