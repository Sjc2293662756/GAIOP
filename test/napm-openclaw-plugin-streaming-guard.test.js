const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

describe('napm-openclaw-plugin streaming preview guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  const originalAllowReasoningPreview = process.env.NAPM_ALLOW_REASONING_PREVIEW;
  const originalAuditLogPath = process.env.NAPM_AUDIT_LOG_PATH;
  const originalReportSourceDir = process.env.NAPM_REPORT_SOURCE_DIR;
  const originalTrustedContextDir = process.env.NAPM_TRUSTED_CONTEXT_DIR;
  let baseDir;
  let plugin = null;

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-streaming-guard-'));
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
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
    if (originalAuditLogPath === undefined) {
      delete process.env.NAPM_AUDIT_LOG_PATH;
    } else {
      process.env.NAPM_AUDIT_LOG_PATH = originalAuditLogPath;
    }
    if (originalReportSourceDir === undefined) {
      delete process.env.NAPM_REPORT_SOURCE_DIR;
    } else {
      process.env.NAPM_REPORT_SOURCE_DIR = originalReportSourceDir;
    }
    if (originalTrustedContextDir === undefined) {
      delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    } else {
      process.env.NAPM_TRUSTED_CONTEXT_DIR = originalTrustedContextDir;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
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

  function buildQueryDraftForPrompt(prompt) {
    if (prompt.includes('\u7cfb\u7edf') && prompt.includes('\u4e1a\u52a1')) {
      return {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }]
      };
    }
    if (prompt.includes('\u4e22\u5305')) {
      return {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'IPAddress' }],
        metrics: ['PLI'],
        metric: 'PLI',
        topMetric: 'PLI',
        topCount: 10,
        timeRange: { key: 'last24hours' }
      };
    }
    return {
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['BYTIO'],
      metric: 'BYTIO',
      topMetric: 'BYTIO',
      topCount: 10,
      timeRange: { key: 'last24hours' }
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
      toolCallId: `query-${ctx.runId}`,
      params: {
        prompt,
        userQuery: prompt,
        queryDraft: buildQueryDraftForPrompt(prompt)
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

  test('should cancel leaked english reasoning when a current result already exists', async () => {
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

    expect(result).toEqual({ cancel: true });
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
