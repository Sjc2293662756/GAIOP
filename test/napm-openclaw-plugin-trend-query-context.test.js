'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('NAPM plugin trend query contract and contextual follow-up', () => {
  let baseDir;
  let plugin;
  let hooks;
  let tools;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-18T02:45:00.000Z'));
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-trend-context-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    delete process.env.SHOW_UPSTREAM_API_IN_REPLY;
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
    hooks = new Map();
    tools = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
      registerHook(name, handler) {
        const names = Array.isArray(name) ? name : [name];
        names.forEach((eventName) => hooks.set(eventName, handler));
      }
    });
  });

  afterEach(() => {
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    delete process.env.SHOW_UPSTREAM_API_IN_REPLY;
    jest.useRealTimers();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function createCtx(suffix) {
    return {
      channelId: 'wecom',
      accountId: `account-${suffix}`,
      conversationId: `conversation-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };
  }

  function buildTrendQuery(timeRangeKey = 'last24hours', granularity = 3600, options = {}) {
    const query = {
      service: 'timeValues',
      queryModeKey: 'timeseries',
      metrics: ['TPIO'],
      metric: 'TPIO',
      topMetric: 'TPIO',
      groups: [{ type: 'TotalTraffic' }],
      timeRange: { key: timeRangeKey },
      granularity
    };
    if (options.omitGroups) {
      delete query.groups;
    }
    return query;
  }

  function buildDefinedAppTrendQuery(options = {}) {
    const query = buildTrendQuery('last7days', 86400);
    query.groups = [{ type: 'DefinedApp' }];
    if (options.argument !== undefined) {
      query.groups[0].argument = options.argument;
    }
    return query;
  }

  async function startTurn(ctx, prompt) {
    hooks.get('message_received')({ content: prompt }, ctx);
    return hooks.get('before_prompt_build')({ prompt }, ctx);
  }

  function callQueryTool(ctx, prompt, resolvedQuery) {
    const event = {
      toolName: 'napm-skill-query',
      toolCallId: `call-${ctx.runId}`,
      params: { prompt, resolvedQuery }
    };
    const result = hooks.get('before_tool_call')(event, ctx);
    return { event, result, params: result?.params || event.params };
  }

  async function rememberEmptyInitialTrend(ctx) {
    const prompt = '最近一天的总流量的趋势怎么样？';
    await startTurn(ctx, prompt);
    const query = buildTrendQuery();
    const bound = callQueryTool(ctx, prompt, query);
    expect(bound.result?.block).not.toBe(true);
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      service: 'timeValues',
      resolvedQuery: query,
      rows: [],
      data: [],
      summary: { title: '未查到数据', empty: true, rowCount: 0 }
    }, scope, 'napm-skill-query', turnId);
    return { scope, turnId };
  }

  test('requires an explicit object scope for timeValues', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec(
      buildTrendQuery('last24hours', 3600, { omitGroups: true }),
      { phase: 'construction' }
    );

    expect(validation).toMatchObject({
      ok: false,
      reason: 'incomplete_resolved_query'
    });
    expect(validation.message).toContain('groups');
  });

  test('requires a concrete DefinedApp argument for a single-object trend query', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec(
      buildDefinedAppTrendQuery(),
      { phase: 'construction' }
    );

    expect(validation).toMatchObject({
      ok: false,
      reason: 'group_argument_required'
    });
    expect(validation.message).toContain('DefinedApp');
    expect(validation.message).toContain('argument');
  });

  test('rejects an argument on the TotalTraffic scope', () => {
    const query = buildTrendQuery();
    query.groups = [{ type: 'TotalTraffic', argument: 'HTTP' }];

    const validation = plugin.__test__.validateResolvedQueryAgainstSpec(
      query,
      { phase: 'construction' }
    );

    expect(validation).toMatchObject({
      ok: false,
      reason: 'group_argument_forbidden'
    });
  });

  test('allows the query tool to return clarification when an application prompt maps to TotalTraffic', async () => {
    const ctx = createCtx('application-total-traffic-mismatch');
    const prompt = '最近 7 天应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const attemptedQuery = callQueryTool(ctx, prompt, buildTrendQuery('last7days', 86400));

    expect(attemptedQuery.result?.block).not.toBe(true);
    expect(attemptedQuery.params.resolvedQuery.groups).toEqual([{ type: 'TotalTraffic' }]);
  });

  test('rejects the same application scope mismatch at direct tool execution', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'timeValues',
        data: [],
        error: null
      });
    try {
      const prompt = '最近 7 天应用流量趋势如何？';
      const result = await tools.get('napm-skill-query').execute('direct-application-mismatch', {
        prompt,
        resolvedQuery: buildTrendQuery('last7days', 3600)
      });

      expect(executeGatewayRequest).not.toHaveBeenCalled();
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({
        ok: true,
        responseType: 'clarification_required',
        decision: {
          action: 'ASK_CLARIFYING_QUESTION',
          reasonCode: 'APPLICATION_SCOPE_MISMATCH',
          southboundAllowed: false
        }
      });
      expect(result.details).not.toHaveProperty('error');
      expect(result.details.decision.clarifyingQuestion).toContain('具体应用名称');
      expect(result.content[0].text).toContain('总流量趋势');
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('uses resolvedQuery.userRequirement when direct execution omits the trace prompt', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, service: 'timeValues', data: [], error: null });

    try {
      const result = await tools.get('napm-skill-query').execute('direct-application-mismatch-without-prompt', {
        resolvedQuery: {
          ...buildTrendQuery('last7days', 3600),
          userRequirement: '最近 7 天应用流量趋势如何？'
        }
      });

      expect(executeGatewayRequest).not.toHaveBeenCalled();
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({
        ok: true,
        responseType: 'clarification_required',
        decision: {
          action: 'ASK_CLARIFYING_QUESTION',
          reasonCode: 'APPLICATION_SCOPE_MISMATCH'
        }
      });
      expect(result.content[0].text).toContain('具体应用名称');
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('returns a user-facing clarification when DefinedApp has no argument', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest');

    try {
      const result = await tools.get('napm-skill-query').execute('direct-missing-application-argument', {
        prompt: '最近 7 天应用流量趋势如何？',
        resolvedQuery: buildDefinedAppTrendQuery()
      });

      expect(executeGatewayRequest).not.toHaveBeenCalled();
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({
        ok: true,
        responseType: 'clarification_required',
        decision: {
          action: 'ASK_CLARIFYING_QUESTION',
          reasonCode: 'GROUP_ARGUMENT_REQUIRED',
          southboundAllowed: false
        }
      });
      expect(result.details).not.toHaveProperty('error');
      expect(result.details.decision.clarifyingQuestion).toContain('具体应用名称');
      expect(result.content[0].text).toContain('具体应用名称');
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('keeps the clarification authoritative through both output hooks', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctx = createCtx('application-clarification-turn');
    const prompt = '最近 7 天应用流量趋势如何？';

    try {
      await startTurn(ctx, prompt);
      const bound = callQueryTool(ctx, prompt, buildDefinedAppTrendQuery());
      expect(bound.result?.block).not.toBe(true);

      const toolResult = await tools.get('napm-skill-query').execute('application-clarification', bound.params);
      const scope = plugin.__test__.getTrustedConversationKey(bound.params);
      const turnId = plugin.__test__.getTrustedTurnId(bound.params);
      const turn = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
      expect(executeGatewayRequest).not.toHaveBeenCalled();
      expect(toolResult.isError).toBe(false);
      expect(turn).toMatchObject({
        phase: 'TERMINAL',
        outcome: 'CLARIFICATION'
      });

      const written = hooks.get('before_message_write')({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '当前问题必须经 NAPM skill 执行后才能回答。' }]
        }
      }, ctx);
      expect(written.message.content[0].text).toContain('具体应用名称');
      expect(written.message.content[0].text).not.toContain('未拿到有效 skill 结果');

      const first = await hooks.get('message_sending')({
        content: written.message.content,
        metadata: { isFinal: true }
      }, ctx);
      const duplicate = await hooks.get('message_sending')({
        content: written.message.content,
        metadata: { isFinal: true }
      }, ctx);
      expect(first.content).toContain('具体应用名称');
      expect(duplicate).toEqual({ cancel: true });
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('executes a new named-application turn after the user supplies the requested name', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'timeValues',
        data: [{ timestamp: 1787742000, value: 10 }],
        error: null
      });
    const ctx = createCtx('application-name-followup');
    const initialPrompt = '最近 7 天应用流量趋势如何？';

    try {
      await startTurn(ctx, initialPrompt);
      const clarificationCall = callQueryTool(ctx, initialPrompt, buildDefinedAppTrendQuery());
      const clarification = await tools.get('napm-skill-query').execute(
        'application-name-clarification',
        clarificationCall.params
      );
      const firstTurnId = plugin.__test__.getTrustedTurnId(clarificationCall.params);
      expect(clarification.details.responseType).toBe('clarification_required');
      expect(executeGatewayRequest).not.toHaveBeenCalled();

      ctx.runId = 'run-application-name-followup-2';
      const followUpPrompt = 'HTTP';
      await startTurn(ctx, followUpPrompt);
      const namedCall = callQueryTool(ctx, followUpPrompt, buildDefinedAppTrendQuery({ argument: 'HTTP' }));
      const secondTurnId = plugin.__test__.getTrustedTurnId(namedCall.params);
      expect(namedCall.result?.block).not.toBe(true);
      expect(secondTurnId).not.toBe(firstTurnId);

      const result = await tools.get('napm-skill-query').execute('application-name-query', namedCall.params);
      expect(executeGatewayRequest).toHaveBeenCalledTimes(1);
      expect(result.details.ok).toBe(true);
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('keeps an explicit global traffic trend executable at direct tool execution', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'timeValues',
        data: [],
        error: null
      });

    try {
      const result = await tools.get('napm-skill-query').execute('direct-global-trend', {
        prompt: '最近 7 天总流量趋势如何？',
        resolvedQuery: buildTrendQuery('last7days', 3600)
      });

      expect(executeGatewayRequest).toHaveBeenCalledTimes(1);
      expect(result.details).toMatchObject({ ok: true, service: 'timeValues' });
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('keeps an explicit global traffic trend on TotalTraffic', async () => {
    const ctx = createCtx('explicit-global-traffic');
    const prompt = '最近 7 天总流量趋势如何？';
    await startTurn(ctx, prompt);
    const attemptedQuery = callQueryTool(ctx, prompt, buildTrendQuery('last7days', 86400));

    expect(attemptedQuery.result?.block).not.toBe(true);
    expect(attemptedQuery.params.resolvedQuery.groups).toEqual([{ type: 'TotalTraffic' }]);
  });

  test('keeps a named application trend on DefinedApp', async () => {
    const ctx = createCtx('named-application-traffic');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const query = buildTrendQuery('last7days', 86400);
    query.groups = [{ type: 'DefinedApp', argument: 'HTTP' }];
    const attemptedQuery = callQueryTool(ctx, prompt, query);

    expect(attemptedQuery.result?.block).not.toBe(true);
    expect(attemptedQuery.params.resolvedQuery.groups).toEqual([
      { type: 'DefinedApp', argument: 'HTTP' }
    ]);
  });

  test('documents TotalTraffic in the query tool contract', () => {
    const definition = tools.get('napm-skill-query');

    expect(definition.description).toContain('TotalTraffic');
    expect(definition.parameters.properties.queryDraft).toEqual(expect.any(Object));
    expect(definition.parameters.anyOf).toEqual(expect.arrayContaining([
      { required: ['queryDraft'] },
      { required: ['resolvedQuery'] }
    ]));
    expect(definition.parameters.properties.resolvedQuery.properties.groups.description)
      .toContain('timeValues');
  });

  test('accepts queryDraft as the primary clarification input', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const executeGatewayRequest = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    try {
      const result = await tools.get('napm-skill-query').execute('query-draft-clarification', {
        prompt: '最近 7 天应用流量趋势如何？',
        queryDraft: buildDefinedAppTrendQuery()
      });

      expect(result).toMatchObject({
        isError: false,
        details: {
          ok: true,
          responseType: 'clarification_required',
          decision: { action: 'ASK_CLARIFYING_QUESTION' }
        }
      });
      expect(executeGatewayRequest).not.toHaveBeenCalled();
    } finally {
      executeGatewayRequest.mockRestore();
    }
  });

  test('allows a seven-minute-later time-range follow-up from an empty successful trend result', async () => {
    const ctx = createCtx('empty-trend-followup');
    const initial = await rememberEmptyInitialTrend(ctx);
    jest.advanceTimersByTime(7 * 60 * 1000);
    ctx.runId = 'run-empty-trend-followup-2';

    const prompt = '那最近7天的呢？';
    const promptContext = await startTurn(ctx, prompt);
    expect(promptContext.appendSystemContext).toContain('MODEL-OWNED');

    const followUp = callQueryTool(ctx, prompt, buildTrendQuery('last7days', 86400));

    expect(followUp.result?.block).not.toBe(true);
    expect(followUp.params.resolvedQuery).toMatchObject({
      service: 'timeValues',
      groups: [{ type: 'TotalTraffic' }],
      timeRange: { key: 'last7days' },
      granularity: 86400
    });
    const audit = fs.readFileSync(process.env.NAPM_AUDIT_LOG_PATH, 'utf8');
    expect(audit).toContain('napm_plugin_contextual_query_followup_allowed');
    expect(audit).toContain(initial.turnId);
  });

  test('routes an incomplete contextual trend query to resolvedQuery repair instead of the model-owned block', async () => {
    const ctx = createCtx('incomplete-trend-followup');
    await rememberEmptyInitialTrend(ctx);
    jest.advanceTimersByTime(7 * 60 * 1000);
    ctx.runId = 'run-incomplete-trend-followup-2';

    const prompt = '那最近7天的呢？';
    await startTurn(ctx, prompt);
    const followUp = callQueryTool(
      ctx,
      prompt,
      buildTrendQuery('last7days', 86400, { omitGroups: true })
    );

    expect(followUp.result).toMatchObject({ block: true });
    expect(followUp.result.blockReason).toContain('groups');
    expect(followUp.result.blockReason).not.toContain('模型直接回答');
  });

  test('does not authorize an identity follow-up that does not change the prior query time', async () => {
    const ctx = createCtx('identity-after-trend');
    await rememberEmptyInitialTrend(ctx);
    jest.advanceTimersByTime(7 * 60 * 1000);
    ctx.runId = 'run-identity-after-trend-2';

    const prompt = '那你呢？';
    await startTurn(ctx, prompt);
    const attemptedQuery = callQueryTool(ctx, prompt, buildTrendQuery());

    expect(attemptedQuery.result).toMatchObject({ block: true });
    expect(attemptedQuery.result.blockReason).toContain('模型直接回答');
  });

  test('does not share contextual query authorization across conversations', async () => {
    const sourceCtx = createCtx('source-conversation');
    await rememberEmptyInitialTrend(sourceCtx);
    const otherCtx = createCtx('other-conversation');
    jest.advanceTimersByTime(7 * 60 * 1000);

    const prompt = '那最近7天的呢？';
    await startTurn(otherCtx, prompt);
    const attemptedQuery = callQueryTool(otherCtx, prompt, buildTrendQuery('last7days', 86400));

    expect(attemptedQuery.result).toMatchObject({ block: true });
    expect(attemptedQuery.result.blockReason).toContain('模型直接回答');
  });

  test.each([
    [
      'metric',
      () => ({
        ...buildTrendQuery('last7days', 86400),
        metric: 'BYTIO',
        topMetric: 'BYTIO',
        metrics: ['BYTIO']
      })
    ],
    [
      'object scope',
      () => ({
        ...buildTrendQuery('last7days', 86400),
        groups: [{ type: 'IPAddress', argument: '192.0.2.10' }]
      })
    ]
  ])('does not authorize a contextual follow-up that changes the prior %s', async (_label, buildQuery) => {
    const ctx = createCtx(`changed-${_label}`);
    await rememberEmptyInitialTrend(ctx);
    jest.advanceTimersByTime(7 * 60 * 1000);
    ctx.runId = `run-changed-${_label}-2`;

    const prompt = '那最近7天的呢？';
    await startTurn(ctx, prompt);
    const attemptedQuery = callQueryTool(ctx, prompt, buildQuery());

    expect(attemptedQuery.result).toMatchObject({ block: true });
    expect(attemptedQuery.result.blockReason).toContain('模型直接回答');
  });

  test('does not authorize a contextual follow-up after query context expires', async () => {
    const ctx = createCtx('expired-context');
    await rememberEmptyInitialTrend(ctx);
    jest.advanceTimersByTime((30 * 60 * 1000) + 1);
    ctx.runId = 'run-expired-context-2';

    const prompt = '那最近7天的呢？';
    await startTurn(ctx, prompt);
    const attemptedQuery = callQueryTool(ctx, prompt, buildTrendQuery('last7days', 86400));

    expect(attemptedQuery.result).toMatchObject({ block: true });
    expect(attemptedQuery.result.blockReason).toContain('模型直接回答');
  });
});
