const path = require('path');

describe('napm-openclaw-plugin streaming preview guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  const originalAllowReasoningPreview = process.env.NAPM_ALLOW_REASONING_PREVIEW;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
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
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerTool(def) {
        tools.set(def.name, def);
      },
      registerCommand() {},
      registerHook() {
        throw new Error('production typed hooks must register through api.on');
      }
    };

    plugin.register(api);
    return {
      hooks,
      tools
    };
  }

  function createChannelCtx(channelId, suffix) {
    return {
      channelId,
      accountId: `acct-${suffix}`,
      conversationId: `conv-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };
  }

  async function primeNapmTurn(hooks, ctx, prompt) {
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt
      }
    }, ctx);
  }

  test('should cancel streaming preview chunks before final NAPM reply is ready on wecom', async () => {
    const { hooks } = createApiHarness();
    const messageSending = hooks.get('message_sending');
    const ctx = createChannelCtx('wecom', 'stream-preview');
    const prompt = '\u7cfb\u7edf\u4e2d\u6709\u54ea\u4e9b\u4e1a\u52a1\uff1f';

    await primeNapmTurn(hooks, ctx, prompt);

    const result = await messageSending({
      content: 'The user is asking about business objects. Let me use the metadata service first.',
      metadata: {
        streaming: true,
        isFinal: false,
        phase: 'partial'
      }
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('should cancel a non-streaming tool preamble while the NAPM tool call is pending on wecom', async () => {
    const { hooks } = createApiHarness();
    const messageSending = hooks.get('message_sending');
    const ctx = createChannelCtx('wecom', 'tool-preamble');
    const prompt = '查询过去1小时总流量最高的5个IP';

    await primeNapmTurn(hooks, ctx, prompt);

    const result = await messageSending({
      content: '这是一个排行查询（TopN），走 `napm-skill-query`。'
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('should block a wecom preamble before the NAPM tool call and preserve the final skill reply', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeMessageWrite = hooks.get('before_message_write');
    const beforeToolCall = hooks.get('before_tool_call');
    const afterToolCall = hooks.get('after_tool_call');
    const ctx = createChannelCtx('wecom', 'pretool-write');
    const prompt = '查询过去1小时总流量最高的5个IP';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const preambleResult = beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '我会调用 NAPM 查询工具。' }]
      }
    }, ctx);
    expect(preambleResult).toEqual({ block: true });

    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: { prompt, userQuery: prompt }
    }, ctx);
    await afterToolCall({
      toolName: 'napm-skill-query',
      result: {
        details: {
          ok: true,
          displayText: '过去1小时总流量最高的5个IP已查询完成。',
          resolvedQuery: {
            service: 'topValues',
            metric: 'BYTIO',
            groups: [{ type: 'IPAddress' }]
          }
        }
      }
    }, ctx);

    const finalResult = beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '原始模型文本。' }]
      }
    }, ctx);
    expect(finalResult?.message?.content?.[0]?.text).toContain('过去1小时总流量最高的5个IP已查询完成。');
  });

  test('should find a skill result through the original WECOM scope when message writing has a reduced context', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const beforeMessageWrite = hooks.get('before_message_write');
    const testApi = plugin.__test__;
    const sourceCtx = { ...createChannelCtx('wecom', 'scope-bridge'), agentId: 'main' };
    const deliveryCtx = {
      channelId: 'wecom',
      sessionKey: sourceCtx.sessionKey,
      agentId: sourceCtx.agentId
    };
    const prompt = '查询过去1小时总流量最高的5个IP';

    messageReceived({ content: prompt }, sourceCtx);
    await beforePromptBuild({ prompt }, sourceCtx);
    await beforeToolCall({
      toolName: 'napm-skill-query',
      params: { prompt, userQuery: prompt }
    }, sourceCtx);
    testApi.rememberSkillResult(prompt, {
      ok: true,
      displayText: '已从原始企业微信会话范围取回真实查询结果。',
      resolvedQuery: {
        service: 'topValues',
        metric: 'BYTIO',
        groups: [{ type: 'IPAddress' }]
      }
    }, testApi.getConversationKey(sourceCtx));

    const result = beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '原始模型文本。' }]
      }
    }, deliveryCtx);

    expect(result?.message?.content?.[0]?.text).toContain('已从原始企业微信会话范围取回真实查询结果。');
  });

  test('should preserve the core /new confirmation instead of rewriting it as out of scope', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const ctx = createChannelCtx('wecom', 'session-command');

    messageReceived({ content: '系统中有哪些业务？' }, ctx);
    await beforePromptBuild({ prompt: '系统中有哪些业务？' }, ctx);
    messageReceived({ content: '/new' }, ctx);
    await beforePromptBuild({ prompt: '/new' }, ctx);

    await expect(messageSending({ content: '已开始新会话。' }, ctx)).resolves.toBeUndefined();
  });

  test('should cancel leaked english reasoning preview without streaming metadata on wecom', async () => {
    const { hooks } = createApiHarness();
    const messageSending = hooks.get('message_sending');
    const ctx = createChannelCtx('wecom', 'english-reasoning-preview');
    const prompt = '\u6d41\u91cf\u6700\u5927\u7684\u5e94\u7528\u6709\u54ea\u4e9b\uff1f';

    await primeNapmTurn(hooks, ctx, prompt);

    const leakedPreview = [
      'It only returned protocol-level results.',
      'Let me try another approach.',
      'Actually the raw API call succeeded earlier.'
    ].join(' ');

    const result = await messageSending({
      content: leakedPreview
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('should rewrite leaked english reasoning to remembered skill reply when skill result already exists', async () => {
    const { hooks } = createApiHarness();
    const messageSending = hooks.get('message_sending');
    const testApi = plugin.__test__;
    const ctx = createChannelCtx('wecom', 'english-reasoning-with-result');
    const prompt = '\u6d41\u91cf\u6700\u5927\u7684\u5e94\u7528\u6709\u54ea\u4e9b\uff1f';

    await primeNapmTurn(hooks, ctx, prompt);

    const rememberedResult = {
      displayText: '\u6700\u8fd1\u4e00\u5929\u6d41\u91cf\u6700\u5927\u7684\u4e1a\u52a1\u5e94\u7528\u662f\u56de\u51fd238web\uff0c\u5176\u6b21\u662f\u53ef\u89c2\u6d4b239web\u3002',
      resolvedQuery: {
        service: 'topValues',
        metric: 'PGBYTO',
        groups: [{ type: 'WebApplication' }]
      }
    };

    testApi.rememberSkillResult(prompt, rememberedResult, testApi.getConversationKey(ctx));

    const leakedPreview = [
      'Previously I checked WebApplication traffic.',
      'Let me re-run the query with a cleaner approach.'
    ].join(' ');

    const result = await messageSending({
      content: leakedPreview
    }, ctx);

    if (result) {
      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('\u6700\u8fd1\u4e00\u5929\u6d41\u91cf\u6700\u5927\u7684\u4e1a\u52a1\u5e94\u7528');
      expect(result.content).not.toContain('Previously I checked WebApplication traffic');
      return;
    }

    expect(result).toBeUndefined();
  });

  test('should allow leaked reasoning preview when temporary preview flag is enabled on non-wecom channels', async () => {
    process.env.NAPM_ALLOW_REASONING_PREVIEW = 'true';
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');

    const { hooks } = createApiHarness();
    const messageSending = hooks.get('message_sending');
    const ctx = createChannelCtx('web', 'reasoning-preview-enabled');
    const prompt = '\u7cfb\u7edf\u4e2d\u6709\u54ea\u4e9b\u4e1a\u52a1\uff1f';

    await primeNapmTurn(hooks, ctx, prompt);

    const leakedPreview = [
      'The user is asking about business objects.',
      'Let me use the metadata service first.'
    ].join(' ');

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

  test('should still cancel leaked reasoning preview on wecom even when preview flag is enabled', async () => {
    process.env.NAPM_ALLOW_REASONING_PREVIEW = 'true';
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');

    const { hooks } = createApiHarness();
    const messageSending = hooks.get('message_sending');
    const ctx = createChannelCtx('wecom', 'reasoning-preview-enabled-wecom');
    const prompt = '\u54ea\u4e2a\u5ba2\u6237\u7aefIP\u4e22\u5305\u6700\u9ad8\uff1f';

    await primeNapmTurn(hooks, ctx, prompt);

    const leakedPreview = [
      'The user is asking about which client IP has the highest packet loss.',
      'This is a NAPM-related query.',
      'Let me use the NAPM skill to process this.'
    ].join(' ');

    const result = await messageSending({
      content: leakedPreview,
      metadata: {
        streaming: true,
        isFinal: false,
        phase: 'partial'
      }
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });
});
