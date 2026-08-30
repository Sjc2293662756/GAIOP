'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');

describe('NAPM plugin structured query authority', () => {
  let baseDir;
  let plugin;
  let hooks;
  let originalExecutor;
  let originalGuardMode;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-structured-authority-'));
    originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
    originalGuardMode = process.env.NAPM_QUERY_SEMANTIC_GUARD_MODE;
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    process.env.NAPM_QUERY_SEMANTIC_GUARD_MODE = 'shadow';
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
    hooks = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        const names = Array.isArray(name) ? name : [name];
        names.forEach((eventName) => hooks.set(eventName, handler));
      }
    });
  });

  afterEach(() => {
    if (originalExecutor === undefined) delete process.env.NAPM_SKILL_EXECUTOR;
    else process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
    if (originalGuardMode === undefined) delete process.env.NAPM_QUERY_SEMANTIC_GUARD_MODE;
    else process.env.NAPM_QUERY_SEMANTIC_GUARD_MODE = originalGuardMode;
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function createContext(suffix) {
    return {
      channelId: 'webchat',
      accountId: `account-${suffix}`,
      conversationId: `conversation-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };
  }

  async function callBeforeTool(prompt, resolvedQuery, suffix) {
    const ctx = createContext(suffix);
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const params = { prompt, userQuery: prompt, resolvedQuery };
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params
    }, ctx);
    return { result, forwarded: result?.params || params };
  }

  function buildHttp500TopQuery() {
    return {
      service: 'topValues',
      queryModeKey: 'topn',
      metric: 'PGHTTP500',
      metrics: ['PGHTTP500'],
      topMetric: 'PGHTTP500',
      groups: [{ type: 'WebApplication' }],
      topCount: 20,
      start: 1786060800,
      end: 1786665600,
      executionOptions: { timeMode: 'fixed' },
      format: 'json'
    };
  }

  test('forwards a spec-valid HTTP 500 TopN query despite inventory wording in the trace prompt', async () => {
    const { result, forwarded } = await callBeforeTool(
      '最近一周有哪些业务出现较多 HTTP 500 错误？',
      buildHttp500TopQuery(),
      'mixed-ranking'
    );

    expect(result?.block).not.toBe(true);
    expect(forwarded.resolvedQuery).toMatchObject({
      service: 'topValues',
      topMetric: 'PGHTTP500',
      groups: [{ type: 'WebApplication' }]
    });
  });

  test('forwards the HTTP 500 TopN produced by the resolver without semantic reconstruction', async () => {
    const prompt = '最近一周有哪些业务出现较多 HTTP 500 错误？';
    const compiled = ResolverService.resolvePrompt(prompt, { nowSeconds: 1786676400 });
    const { result, forwarded } = await callBeforeTool(
      prompt,
      compiled.resolvedQuery,
      'resolver-to-plugin'
    );

    expect(compiled.ok).toBe(true);
    expect(result?.block).not.toBe(true);
    expect(forwarded.resolvedQuery).toMatchObject({
      service: 'topValues',
      topMetric: 'PGHTTP500',
      groups: [{ type: 'WebApplication' }],
      timeRange: { key: 'last7days' }
    });
  });

  test('blocks a structured ranking query when the user asked for an object inventory', async () => {
    const ranking = await callBeforeTool(
      '最近一周有哪些业务出现较多 HTTP 500 错误？',
      buildHttp500TopQuery(),
      'ranking-prompt'
    );
    const inventory = await callBeforeTool(
      '系统中有哪些业务？',
      buildHttp500TopQuery(),
      'inventory-prompt'
    );

    expect(ranking.result?.block).not.toBe(true);
    expect(inventory.result).toMatchObject({ block: true });
    expect(inventory.result.blockReason).toContain('对象清单');
  });

  test('continues to block a structurally invalid query', async () => {
    const { result } = await callBeforeTool(
      '最近一周 HTTP 500 错误排行',
      { service: 'topValues', queryModeKey: 'topn', groups: [{ type: 'WebApplication' }] },
      'invalid-query'
    );

    expect(result).toMatchObject({ block: true });
    expect(result.blockReason).toContain('topMetric');
  });

  test('allows one construction repair and stops a second failure in the same turn', async () => {
    const prompt = '最近一周 HTTP 500 错误排行';
    const ctx = createContext('repair-budget');
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const buildEvent = (toolCallId) => ({
      toolName: 'napm-skill-query',
      toolCallId,
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'topValues',
          queryModeKey: 'topn',
          groups: [{ type: 'WebApplication' }]
        }
      }
    });

    const first = await hooks.get('before_tool_call')(buildEvent('attempt-1'), ctx);
    const second = await hooks.get('before_tool_call')(buildEvent('attempt-2'), ctx);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);

    expect(first.blockReason).toContain('may reconstruct resolvedQuery once');
    expect(second.blockReason).toContain('repair budget exhausted');
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'VALIDATION_FAILURE',
      attempts: [
        { attemptId: 'attempt-1', status: 'FAILED' },
        { attemptId: 'attempt-2', status: 'FAILED' }
      ]
    });
  });
});
