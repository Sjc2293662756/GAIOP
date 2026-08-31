'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('NAPM plugin authoritative query turn lifecycle', () => {
  let baseDir;
  let plugin;
  let hooks;
  let tools;
  let RequirementParserService;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-query-turn-integration-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
    RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
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
    jest.restoreAllMocks();
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function createCtx(runId, messageId = `${runId}-message`) {
    return {
      channelId: 'wecom',
      accountId: 'shared-account',
      conversationId: 'shared-conversation',
      sessionKey: 'shared-session',
      sessionId: 'shared-session',
      runId,
      messageId
    };
  }

  async function startTurn(ctx, prompt) {
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
  }

  function callBeforeTool(ctx, toolCallId, params) {
    const event = { toolName: 'napm-skill-query', toolCallId, params };
    const hookResult = hooks.get('before_tool_call')(event, ctx);
    return {
      event,
      hookResult,
      params: hookResult?.params || event.params
    };
  }

  async function executeBound(toolCallId, bound) {
    return tools.get('napm-skill-query').execute(toolCallId, bound.params);
  }

  function bindTrustedDirect(ctx, params, options = {}) {
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = options.turnId || `direct-turn-${ctx.runId}`;
    if (options.createTurn !== false) {
      plugin.__test__.queryTurnCoordinator.begin({
        scope,
        turnId,
        runId: ctx.runId,
        route: options.route || 'NAPM_QUERY',
        question: params.prompt || '',
        semanticQuestion: params.prompt || '',
        queryDraft: params.queryDraft || params.resolvedQuery || null
      });
    } else {
      plugin.__test__.queryTurnCoordinator.bindRun({ scope, runId: ctx.runId, turnId });
    }
    const event = {
      toolName: options.toolName || 'napm-skill-query',
      params: { ...params }
    };
    const traceId = plugin.__test__.bindTrustedToolContext(event, ctx);
    return { scope, turnId, params: { ...event.params, traceId } };
  }

  function buildTrendDraft(groupType, argument) {
    const group = { type: groupType };
    if (argument !== undefined) group.argument = argument;
    return {
      service: 'timeValues',
      queryModeKey: 'timeseries',
      groups: [group],
      metrics: ['TPIO'],
      metric: 'TPIO',
      topMetric: 'TPIO',
      granularity: 3600,
      timeRange: { key: 'last7days' }
    };
  }

  function buildTopQuery() {
    return {
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGHTTP500'],
      metric: 'PGHTTP500',
      topMetric: 'PGHTTP500',
      topCount: 10,
      timeRange: { key: 'last7days' }
    };
  }

  test('declares clarificationAnswer as a schema-valid Query Turn continuation input', () => {
    const queryTool = tools.get('napm-skill-query');
    expect(queryTool.parameters.properties.clarificationAnswer).toMatchObject({
      type: 'string',
      minLength: 1
    });
    expect(queryTool.parameters.anyOf).toContainEqual({ required: ['clarificationAnswer'] });
  });

  test('keeps overlapping runs bound to their own turns through Tool and output hooks', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctxA = createCtx('run-a');
    const ctxB = createCtx('run-b');
    const promptA = '最近 7 天应用流量趋势如何？';
    const promptB = '最近 7 天业务流量趋势如何？';

    await startTurn(ctxA, promptA);
    await startTurn(ctxB, promptB);
    const scope = plugin.__test__.getConversationKey(ctxA);
    const turnA = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctxA.runId);
    const turnB = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctxB.runId);

    const boundA = callBeforeTool(ctxA, 'call-a', {
      prompt: promptA,
      queryDraft: buildTrendDraft('DefinedApp')
    });
    const boundB = callBeforeTool(ctxB, 'call-b', {
      prompt: promptB,
      queryDraft: buildTrendDraft('WebApplication')
    });

    expect(turnA).toBeTruthy();
    expect(turnB).toBeTruthy();
    expect(turnA).not.toBe(turnB);
    expect(plugin.__test__.getTrustedTurnId(boundA.params)).toBe(turnA);
    expect(plugin.__test__.getTrustedTurnId(boundB.params)).toBe(turnB);
    await executeBound('call-a', boundA);
    await executeBound('call-b', boundB);
    expect(southbound).not.toHaveBeenCalled();

    const recordA = plugin.__test__.queryTurnCoordinator.get(scope, turnA);
    const recordB = plugin.__test__.queryTurnCoordinator.get(scope, turnB);
    expect(recordA.finalContent).toContain('应用');
    expect(recordB.finalContent).toContain('业务');

    const writtenA = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: 'wrong-a' }] }
    }, ctxA);
    const writtenB = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: 'wrong-b' }] }
    }, ctxB);
    expect(writtenA.message.content[0].text).toBe(recordA.finalContent);
    expect(writtenB.message.content[0].text).toBe(recordB.finalContent);

    await expect(hooks.get('message_sending')({ content: 'wrong-a' }, ctxA))
      .resolves.toEqual({ content: recordA.finalContent });
    await expect(hooks.get('message_sending')({ content: 'duplicate-a' }, ctxA))
      .resolves.toEqual({ cancel: true });
    await expect(hooks.get('message_sending')({ content: 'wrong-b' }, ctxB))
      .resolves.toEqual({ content: recordB.finalContent });
  });

  test('fails closed when overlapping output hooks have no run or message identity', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctxA = createCtx('run-identity-a');
    const ctxB = createCtx('run-identity-b');
    const promptA = '最近 7 天应用流量趋势如何？';
    const promptB = '最近 7 天业务流量趋势如何？';

    await startTurn(ctxA, promptA);
    await startTurn(ctxB, promptB);
    const boundA = callBeforeTool(ctxA, 'identity-call-a', {
      prompt: promptA,
      queryDraft: buildTrendDraft('DefinedApp')
    });
    const boundB = callBeforeTool(ctxB, 'identity-call-b', {
      prompt: promptB,
      queryDraft: buildTrendDraft('WebApplication')
    });
    await executeBound('identity-call-a', boundA);
    await executeBound('identity-call-b', boundB);
    expect(southbound).not.toHaveBeenCalled();

    const scope = plugin.__test__.getConversationKey(ctxA);
    const turnA = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctxA.runId);
    const turnB = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctxB.runId);
    const terminalA = plugin.__test__.queryTurnCoordinator.get(scope, turnA);
    const terminalB = plugin.__test__.queryTurnCoordinator.get(scope, turnB);
    const identitylessCtx = {
      channelId: ctxA.channelId,
      accountId: ctxA.accountId,
      conversationId: ctxA.conversationId,
      sessionKey: ctxA.sessionKey,
      sessionId: ctxA.sessionId
    };

    expect(terminalA.deliveryClaimed).toBe(false);
    expect(terminalB.deliveryClaimed).toBe(false);
    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: 'run A model final' }] }
    }, identitylessCtx);
    const sent = await hooks.get('message_sending')({ content: 'run A model final' }, identitylessCtx);

    const writtenText = written?.message?.content?.[0]?.text || '';
    expect(writtenText).toContain('无法确认所属的 NAPM 查询轮次');
    expect(writtenText).not.toBe('run A model final');
    expect(writtenText).not.toBe(terminalA.finalContent);
    expect(writtenText).not.toBe(terminalB.finalContent);
    expect(sent).toEqual({ cancel: true });
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnB).deliveryClaimed).toBe(false);
  });

  test('fails closed when output hooks carry an identity that was never bound', async () => {
    const rows = [{ label: 'HTTP', value: 'HTTP', type: 'DefinedApp', applicationType: 2 }];
    jest.spyOn(RequirementParserService, 'executeGatewayRequest').mockResolvedValue({
      ok: true,
      service: 'groups',
      rows,
      data: rows,
      summary: { empty: false, rowCount: rows.length },
      error: null
    });
    const ctxA = createCtx('run-bound-a');
    const ctxB = createCtx('run-bound-b');
    await startTurn(ctxA, '最近 7 天应用流量趋势如何？');
    await startTurn(ctxB, '系统中有哪些应用？');
    const boundB = callBeforeTool(ctxB, 'bound-inventory-call', {
      prompt: '系统中有哪些应用？',
      queryDraft: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'DefinedApp' }]
      }
    });
    await executeBound('bound-inventory-call', boundB);

    const scope = plugin.__test__.getConversationKey(ctxB);
    const turnB = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctxB.runId);
    const terminalB = plugin.__test__.queryTurnCoordinator.get(scope, turnB);
    expect(terminalB).toMatchObject({ phase: 'TERMINAL', outcome: 'RESULT', deliveryClaimed: false });

    const unboundCtx = {
      ...ctxA,
      runId: 'run-never-bound',
      messageId: 'message-never-bound'
    };
    const written = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'unbound model final' },
          { type: 'toolCall', id: 'unbound-call', name: 'napm-skill-query', arguments: {} }
        ]
      }
    }, unboundCtx);
    const sent = await hooks.get('message_sending')({ content: 'unbound model final' }, unboundCtx);

    const writtenText = written?.message?.content?.[0]?.text || '';
    expect(writtenText).toContain('无法确认所属的 NAPM 查询轮次');
    expect(writtenText).not.toBe('unbound model final');
    expect(writtenText).not.toBe(terminalB.finalContent);
    expect(written.message.content).toHaveLength(1);
    expect(sent).toEqual({ cancel: true });
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnB).deliveryClaimed).toBe(false);
  });

  test('restores and consumes the pending draft when the user only replies with an application name', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'timeValues',
        data: [{ timestamp: 1787742000, value: 10 }],
        error: null
      });
    const ctx1 = createCtx('run-clarification');
    const initialPrompt = '最近 7 天应用流量趋势如何？';
    await startTurn(ctx1, initialPrompt);
    const clarificationCall = callBeforeTool(ctx1, 'clarification-call', {
      prompt: initialPrompt,
      queryDraft: buildTrendDraft('TotalTraffic')
    });
    await executeBound('clarification-call', clarificationCall);

    const scope = plugin.__test__.getConversationKey(ctx1);
    const firstTurnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx1.runId);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, firstTurnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'CLARIFICATION'
    });
    expect(plugin.__test__.queryTurnCoordinator.getPending(scope)).toBeTruthy();
    expect(plugin.__test__.queryTurnCoordinator.getPending(scope).queryDraft).toMatchObject({
      groups: [{ type: 'DefinedApp' }],
      semanticConstraints: { targetObjectType: 'DefinedApp' }
    });
    expect(southbound).not.toHaveBeenCalled();

    const ctx2 = createCtx('run-answer');
    await startTurn(ctx2, 'HTTP');
    const resumedCall = callBeforeTool(ctx2, 'answer-call', {
      prompt: 'HTTP',
      clarificationAnswer: 'HTTP'
    });
    expect(resumedCall.hookResult?.block).not.toBe(true);
    expect(resumedCall.params.queryDraft).toMatchObject({
      service: 'timeValues',
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }],
      metrics: ['TPIO'],
      timeRange: { key: 'last7days' },
      granularity: 3600
    });

    const secondTurnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx2.runId);
    expect(secondTurnId).not.toBe(firstTurnId);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, secondTurnId).parentTurnId).toBe(firstTurnId);
    const result = await executeBound('answer-call', resumedCall);
    expect(result.details.ok).toBe(true);
    expect(southbound).toHaveBeenCalledTimes(1);
    expect(southbound.mock.calls[0][0]).toMatchObject({
      service: 'timeValues',
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }],
      metrics: ['TPIO'],
      timeRange: { key: 'last7days' },
      granularity: 3600
    });
    expect(plugin.__test__.queryTurnCoordinator.getPending(scope)).toBeNull();
    expect(plugin.__test__.queryTurnCoordinator.get(scope, firstTurnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'CLARIFICATION'
    });
  });

  test('delivers a real Skill clarification as a normal clarification without southbound calls', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctx = createCtx('run-skill-clarification');
    const prompt = '查询 HTTP 应用流量趋势，执行前请补充范围。';
    await startTurn(ctx, prompt);
    const bound = callBeforeTool(ctx, 'skill-clarification-call', {
      prompt,
      queryDraft: {
        ...buildTrendDraft('DefinedApp', 'HTTP'),
        clarificationGate: {
          required: true,
          question: '请补充查询范围。'
        }
      }
    });

    const result = await executeBound('skill-clarification-call', bound);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: false,
      details: {
        ok: true,
        responseType: 'clarification_required',
        decision: {
          action: 'ASK_CLARIFYING_QUESTION',
          outcome: 'CLARIFICATION',
          southboundAllowed: false
        }
      }
    });
    expect(result.details.error).toBeNull();
    expect(terminal).toMatchObject({
      phase: 'TERMINAL',
      action: 'ASK_CLARIFYING_QUESTION',
      outcome: 'CLARIFICATION',
      attempts: [{ status: 'SUCCEEDED' }]
    });
    expect(terminal.finalContent).toContain('请补充查询范围');

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: '错误的执行失败提示' }] }
    }, ctx);
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    await expect(hooks.get('message_sending')({ content: '错误的执行失败提示' }, ctx))
      .resolves.toEqual({ content: terminal.finalContent });
  });

  test.each([
    ['RESULT', [{ timestamp: 1787742000, value: 10 }]],
    ['NO_DATA', []]
  ])('builds and delivers authoritative %s final content exactly once', async (expectedOutcome, data) => {
    jest.spyOn(RequirementParserService, 'executeGatewayRequest').mockResolvedValue({
      ok: true,
      service: 'timeValues',
      data,
      error: null
    });
    const ctx = createCtx(`run-${expectedOutcome.toLowerCase()}`);
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const bound = callBeforeTool(ctx, `${expectedOutcome}-call`, {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });
    await executeBound(`${expectedOutcome}-call`, bound);

    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    expect(terminal).toMatchObject({ phase: 'TERMINAL', outcome: expectedOutcome });
    expect(terminal.finalContent).toEqual(expect.any(String));
    expect(terminal.finalContent.length).toBeGreaterThan(0);

    const afterLateFailure = plugin.__test__.queryTurnCoordinator.recordFailure({
      scope,
      turnId,
      outcome: 'EXECUTION_FAILURE',
      result: { ok: false },
      finalContent: 'late failure'
    });
    expect(afterLateFailure).toEqual(terminal);

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: 'model text' }] }
    }, ctx);
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    await expect(hooks.get('message_sending')({ content: 'model text' }, ctx))
      .resolves.toEqual({ content: terminal.finalContent });
    await expect(hooks.get('message_sending')({ content: 'model text again' }, ctx))
      .resolves.toEqual({ cancel: true });
  });

  test('suppresses a replayed Tool execution after the Query Turn is terminal', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest').mockResolvedValue({
      ok: true,
      service: 'timeValues',
      data: [{ timestamp: 1787742000, value: 10 }],
      error: null
    });
    const ctx = createCtx('run-terminal-tool-replay');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const bound = callBeforeTool(ctx, 'initial-tool-call', {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });

    const first = await executeBound('initial-tool-call', bound);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    const replay = await executeBound('replayed-tool-call', bound);

    expect(terminal).toMatchObject({ phase: 'TERMINAL', outcome: 'RESULT' });
    expect(replay.details).toEqual(first.details);
    expect(southbound).toHaveBeenCalledTimes(1);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toEqual(terminal);
  });

  test('suppresses an overlapping Tool replay while the first execution is still running', async () => {
    const southboundResolvers = [];
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockImplementation(() => new Promise((resolve) => {
        southboundResolvers.push(resolve);
      }));
    const ctx = createCtx('run-overlapping-tool-replay');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const bound = callBeforeTool(ctx, 'overlap-initial-call', {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });

    const firstExecution = executeBound('overlap-initial-call', bound);
    await new Promise((resolve) => setImmediate(resolve));
    const replayExecution = executeBound('overlap-replay-call', {
      params: {
        ...bound.params,
        queryDraft: { service: 'timeValues' },
        resolvedQuery: { service: 'timeValues' }
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    const southboundCallCount = southbound.mock.calls.length;
    const executing = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    for (const resolve of southboundResolvers) {
      resolve({
        ok: true,
        service: 'timeValues',
        data: [{ timestamp: 1787742000, value: 10 }],
        error: null
      });
    }
    const [first, replay] = await Promise.all([firstExecution, replayExecution]);

    expect(first.details.ok).toBe(true);
    expect(southboundCallCount).toBe(1);
    expect(replay).toMatchObject({
      isError: false,
      details: {
        ok: true,
        responseType: 'QUERY_EXECUTION_IN_PROGRESS'
      }
    });
    expect(executing).toMatchObject({
      phase: 'EXECUTING',
      attempts: [{ attemptId: 'overlap-initial-call', status: 'STARTED' }]
    });
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'RESULT'
    });
  });

  test('fails closed before validation when direct Tool execution has no trusted turn identity', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, service: 'timeValues', data: [], error: null });

    const result = await tools.get('napm-skill-query').execute('identityless-direct-call', {
      prompt: '最近 7 天总流量趋势如何？',
      queryDraft: buildTrendDraft('TotalTraffic')
    });

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        responseType: 'LIFECYCLE_BINDING_REQUIRED',
        error: { code: 'LIFECYCLE_TURN_BINDING_REQUIRED' }
      }
    });
  });

  test('terminates a decided query when the Tool adapter never executes', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctx = createCtx('run-decided-without-execute');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    callBeforeTool(ctx, 'decided-without-execute-call', {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });

    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'DECIDED',
      action: 'EXECUTE_QUERY',
      outcome: null
    });

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: '模型误称查询已完成。' }] }
    }, ctx);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);

    expect(terminal).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'CONTRACT_VIOLATION',
      contractViolation: { reasonCode: 'QUERY_TOOL_EXECUTION_NOT_STARTED' }
    });
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    await expect(hooks.get('message_sending')({ content: '模型误称查询已完成。' }, ctx))
      .resolves.toEqual({ content: terminal.finalContent });
    await expect(hooks.get('message_sending')({ content: '重复发送' }, ctx))
      .resolves.toEqual({ cancel: true });
    expect(southbound).not.toHaveBeenCalled();
  });

  test('terminates an executing query when final output arrives without a result', async () => {
    let resolveSouthbound;
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockImplementation(() => new Promise((resolve) => {
        resolveSouthbound = resolve;
      }));
    const ctx = createCtx('run-executing-without-result');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const bound = callBeforeTool(ctx, 'executing-without-result-call', {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });
    const execution = executeBound('executing-without-result-call', bound);
    await new Promise((resolve) => setImmediate(resolve));

    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'EXECUTING',
      action: 'EXECUTE_QUERY',
      outcome: null
    });
    expect(resolveSouthbound).toEqual(expect.any(Function));

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: '模型误称查询已完成。' }] }
    }, ctx);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    const sent = await hooks.get('message_sending')({ content: '模型误称查询已完成。' }, ctx);
    const duplicate = await hooks.get('message_sending')({ content: '重复发送' }, ctx);

    resolveSouthbound({
      ok: true,
      service: 'timeValues',
      data: [{ timestamp: 1787742000, value: 10 }],
      error: null
    });
    await execution;

    expect(terminal).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'EXECUTION_FAILURE',
      attempts: [{ status: 'FAILED', reasonCode: 'QUERY_EXECUTION_RESULT_MISSING' }]
    });
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    expect(sent).toEqual({ content: terminal.finalContent });
    expect(duplicate).toEqual({ cancel: true });
    expect(southbound).toHaveBeenCalledTimes(1);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'EXECUTION_FAILURE',
      finalContent: terminal.finalContent,
      deliveryClaimed: true
    });
  });

  test('records a deterministic contract violation when a required query Tool is omitted', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctx = createCtx('run-tool-omitted');
    const prompt = '最近 7 天应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);

    const written = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '模型直接回答了总流量趋势。' }]
      }
    }, ctx);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    expect(terminal).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'CONTRACT_VIOLATION',
      contractViolation: { reasonCode: 'MODEL_OMITTED_REQUIRED_TOOL' }
    });
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    expect(southbound).not.toHaveBeenCalled();
    await expect(hooks.get('message_sending')({ content: 'model text' }, ctx))
      .resolves.toEqual({ content: terminal.finalContent });
    await expect(hooks.get('message_sending')({ content: 'model text' }, ctx))
      .resolves.toEqual({ cancel: true });
  });

  test('blocks a wrong safe Tool without changing an ordinary query route', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctx = createCtx('run-wrong-summary-tool');
    const prompt = '最近 7 天应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);

    const hookResult = hooks.get('before_tool_call')({
      toolName: 'napm-summary',
      toolCallId: 'wrong-summary-call',
      params: {
        prompt,
        scope: 'global',
        timeRange: { key: 'last7days' }
      }
    }, ctx);

    expect(hookResult).toMatchObject({ block: true });
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      route: 'NAPM_QUERY',
      phase: 'RECEIVED'
    });
    expect(southbound).not.toHaveBeenCalled();

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: '错误的全局综述结果' }] }
    }, ctx);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    expect(terminal).toMatchObject({
      route: 'NAPM_QUERY',
      phase: 'TERMINAL',
      outcome: 'CONTRACT_VIOLATION',
      contractViolation: { reasonCode: 'MODEL_OMITTED_REQUIRED_TOOL' }
    });
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    await expect(hooks.get('message_sending')({ content: '错误的全局综述结果' }, ctx))
      .resolves.toEqual({ content: terminal.finalContent });
    await expect(hooks.get('message_sending')({ content: '重复发送' }, ctx))
      .resolves.toEqual({ cancel: true });
    expect(southbound).not.toHaveBeenCalled();
  });

  test('records omitted-Tool contract violation for a non-streaming reasoning final', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const ctx = createCtx('run-reasoning-final');
    const prompt = '最近 7 天应用流量趋势如何？';
    const reasoningFinal = [
      'The user is asking about application traffic over the last seven days.',
      'Let me try another approach before querying the monitoring system.',
      'Actually, wait, I should inspect the available data and then provide the answer.'
    ].join(' ');
    await startTurn(ctx, prompt);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: reasoningFinal }] }
    }, ctx);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);
    expect(terminal).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'CONTRACT_VIOLATION',
      contractViolation: { reasonCode: 'MODEL_OMITTED_REQUIRED_TOOL' }
    });
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    expect(southbound).not.toHaveBeenCalled();

    await expect(hooks.get('message_sending')({ content: reasoningFinal }, ctx))
      .resolves.toEqual({ content: terminal.finalContent });
    await expect(hooks.get('message_sending')({ content: reasoningFinal }, ctx))
      .resolves.toEqual({ cancel: true });
  });

  test('does not terminate a Query Turn for a streaming partial before the Tool call', async () => {
    jest.spyOn(RequirementParserService, 'executeGatewayRequest').mockResolvedValue({
      ok: true,
      service: 'timeValues',
      data: [{ timestamp: 1787742000, value: 10 }],
      error: null
    });
    const ctx = createCtx('run-streaming-partial');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(ctx, prompt);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);

    const partial = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '正在查询...' }],
        metadata: { streaming: true, isFinal: false, phase: 'partial' }
      }
    }, ctx);
    expect(partial).toBeUndefined();
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'RECEIVED',
      outcome: null
    });

    const bound = callBeforeTool(ctx, 'streaming-result-call', {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });
    await executeBound('streaming-result-call', bound);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'RESULT'
    });
  });

  test('uses the stable message binding when the runtime changes runId between lifecycle hooks', async () => {
    jest.spyOn(RequirementParserService, 'executeGatewayRequest').mockResolvedValue({
      ok: true,
      service: 'timeValues',
      data: [{ timestamp: 1787742000, value: 10 }],
      error: null
    });
    const receivedCtx = createCtx('run-received', 'stable-message');
    const prompt = '最近 7 天 HTTP 应用流量趋势如何？';
    await startTurn(receivedCtx, prompt);
    const scope = plugin.__test__.getConversationKey(receivedCtx);
    const expectedTurnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, 'stable-message');
    const laterCtx = { ...receivedCtx, runId: 'run-before-tool' };

    const bound = callBeforeTool(laterCtx, 'changed-run-call', {
      prompt,
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    });
    expect(plugin.__test__.getTrustedTurnId(bound.params)).toBe(expectedTurnId);
    await executeBound('changed-run-call', bound);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, expectedTurnId);
    expect(terminal).toMatchObject({ phase: 'TERMINAL', outcome: 'RESULT' });

    const written = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: 'wrong' }] }
    }, laterCtx);
    expect(written.message.content[0].text).toBe(terminal.finalContent);
    await expect(hooks.get('message_sending')({ content: 'wrong' }, laterCtx))
      .resolves.toEqual({ content: terminal.finalContent });
  });

  test('records Query Attempts, permits one repair, and terminates a repeated failure', async () => {
    const ctx = createCtx('run-repair-failure');
    const prompt = '最近一周 HTTP 500 错误排行';
    await startTurn(ctx, prompt);
    const invalidDraft = {
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }]
    };
    const first = callBeforeTool(ctx, 'attempt-1', { prompt, queryDraft: invalidDraft });
    const replay = callBeforeTool(ctx, 'attempt-1', { prompt, queryDraft: invalidDraft });
    const repeated = callBeforeTool(ctx, 'attempt-2', { prompt, queryDraft: invalidDraft });
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    const terminal = plugin.__test__.queryTurnCoordinator.get(scope, turnId);

    expect(first.hookResult.blockReason).toContain('may repair queryDraft once');
    expect(replay.hookResult.blockReason).toContain('may repair queryDraft once');
    expect(repeated.hookResult.blockReason).toContain('repair budget exhausted');
    expect(terminal).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'VALIDATION_FAILURE',
      attempts: [
        { attemptId: 'attempt-1', status: 'FAILED' },
        { attemptId: 'attempt-2', status: 'FAILED', duplicate: true }
      ]
    });
  });

  test('retains the failed Query Attempt when the repaired query succeeds', async () => {
    jest.spyOn(RequirementParserService, 'executeGatewayRequest').mockResolvedValue({
      ok: true,
      service: 'topValues',
      data: [{ name: '业务A', value: 2 }],
      error: null
    });
    const ctx = createCtx('run-repair-success');
    const prompt = '最近一周 HTTP 500 错误排行';
    await startTurn(ctx, prompt);
    const first = callBeforeTool(ctx, 'attempt-1', {
      prompt,
      queryDraft: {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'WebApplication' }]
      }
    });
    expect(first.hookResult.block).toBe(true);

    const repaired = callBeforeTool(ctx, 'attempt-2', { prompt, queryDraft: buildTopQuery() });
    expect(repaired.hookResult?.block).not.toBe(true);
    await executeBound('attempt-2', repaired);
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    expect(plugin.__test__.queryTurnCoordinator.get(scope, turnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'RESULT',
      attempts: [
        { attemptId: 'attempt-1', status: 'FAILED' },
        { attemptId: 'attempt-2', status: 'SUCCEEDED' }
      ]
    });
  });

  test.each([
    [
      'CompositeApplication inventory mapped to overview',
      '系统中有哪些自动识别的应用？',
      {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'auto_apps',
        timeRange: { key: 'last7days' }
      },
      'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH'
    ],
    [
      'DefinedApp inventory mapped to WebApplication',
      '系统中有哪些应用？',
      {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }]
      },
      'OBJECT_INVENTORY_CONTRACT_MISMATCH'
    ],
    [
      'CompositeApplication inventory with an extra group',
      '系统中有哪些自动识别的应用？',
      {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'CompositeApplication' }, { type: 'IPAddress' }]
      },
      'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH'
    ],
    [
      'promptless CompositeApplication inventory mapped to overview',
      undefined,
      {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'auto_apps',
        timeRange: { key: 'last7days' },
        semanticConstraints: {
          workflowType: 'object_inventory',
          operation: 'metadata_list',
          targetObjectType: 'CompositeApplication'
        }
      },
      'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH'
    ],
    [
      'promptless auto_apps overview without semantic constraints',
      undefined,
      {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'auto_apps',
        timeRange: { key: 'last7days' }
      },
      'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH'
    ]
  ])('blocks %s at direct Tool execution without southbound calls', async (_label, prompt, queryDraft, reasonCode) => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, data: [] });
    const direct = bindTrustedDirect(createCtx(`run-${reasonCode}-${_label}`), {
      prompt,
      queryDraft
    });
    const result = await tools.get('napm-skill-query').execute(`direct-${reasonCode}`, direct.params);

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        decision: {
          outcome: 'VALIDATION_FAILURE',
          reasonCode,
          southboundAllowed: false
        }
      }
    });
  });

  test('clarifies an application trend mapped to TotalTraffic at direct Tool execution without southbound calls', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, data: [] });
    const prompt = '最近 7 天应用流量趋势如何？';
    const direct = bindTrustedDirect(createCtx('run-direct-application-scope'), {
      prompt,
      queryDraft: buildTrendDraft('TotalTraffic')
    });
    const result = await tools.get('napm-skill-query').execute('direct-application-scope', direct.params);

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        ok: true,
        responseType: 'clarification_required',
        decision: {
          outcome: 'CLARIFICATION',
          reasonCode: 'APPLICATION_SCOPE_MISMATCH',
          southboundAllowed: false
        }
      }
    });
  });

  test('guides an application ranking scope mismatch toward DefinedApp without asking for one application', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, data: [] });
    const ctx = createCtx('run-application-ranking-scope-repair');
    const prompt = '应用流量最高的是哪些？';
    await startTurn(ctx, prompt);
    const blocked = callBeforeTool(ctx, 'application-ranking-scope-repair', {
      prompt,
      queryDraft: {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'TotalTraffic' }],
        metrics: ['TPIO'],
        topMetric: 'TPIO',
        topCount: 10,
        timeRange: { key: 'last7days' }
      }
    });

    expect(blocked.hookResult).toMatchObject({ block: true });
    expect(blocked.hookResult.blockReason).toContain('topValues with DefinedApp');
    expect(blocked.hookResult.blockReason).not.toContain('追问具体应用名称');
    expect(southbound).not.toHaveBeenCalled();
  });

  test('clarifies a promptless DefinedApp semantic target mapped to TotalTraffic without southbound calls', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, data: [] });
    const queryDraft = {
      ...buildTrendDraft('TotalTraffic'),
      semanticConstraints: { targetObjectType: 'DefinedApp' }
    };
    const direct = bindTrustedDirect(createCtx('run-direct-semantic-application-scope'), {
      queryDraft
    });
    const result = await tools.get('napm-skill-query').execute(
      'direct-semantic-application-scope',
      direct.params
    );

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        ok: true,
        responseType: 'clarification_required',
        decision: {
          outcome: 'CLARIFICATION',
          reasonCode: 'APPLICATION_SCOPE_MISMATCH',
          southboundAllowed: false
        }
      }
    });
  });

  test('resumes a real pending clarification from clarificationAnswer at direct Tool execution', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'timeValues',
        data: [{ timestamp: 1787742000, value: 10 }],
        error: null
      });
    const initialCtx = createCtx('run-direct-resume-initial');
    const prompt = '最近 7 天应用流量趋势如何？';
    await startTurn(initialCtx, prompt);
    const clarificationCall = callBeforeTool(initialCtx, 'direct-resume-clarification', {
      prompt,
      queryDraft: buildTrendDraft('TotalTraffic')
    });
    await executeBound('direct-resume-clarification', clarificationCall);

    const scope = plugin.__test__.getConversationKey(initialCtx);
    const parentTurnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(scope, initialCtx.runId);
    expect(plugin.__test__.queryTurnCoordinator.getPending(scope)).toBeTruthy();
    expect(southbound).not.toHaveBeenCalled();

    const answerCtx = createCtx('run-direct-resume-answer');
    const direct = bindTrustedDirect(answerCtx, { clarificationAnswer: 'HTTP' }, {
      createTurn: false,
      turnId: 'direct-resumed-turn'
    });
    expect(plugin.__test__.queryTurnCoordinator.get(scope, direct.turnId)).toBeNull();

    const result = await tools.get('napm-skill-query').execute('direct-resume-answer', direct.params);

    expect(result.details.ok).toBe(true);
    expect(southbound).toHaveBeenCalledTimes(1);
    expect(southbound.mock.calls[0][0]).toMatchObject({
      service: 'timeValues',
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }],
      metrics: ['TPIO'],
      granularity: 3600,
      timeRange: { key: 'last7days' }
    });
    expect(plugin.__test__.queryTurnCoordinator.get(scope, direct.turnId)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'RESULT',
      parentTurnId,
      resumedFromClarification: true,
      clarificationAnswer: 'HTTP'
    });
    expect(plugin.__test__.queryTurnCoordinator.getPending(scope)).toBeNull();
  });

  test('blocks direct query execution when the trusted turn route is not NAPM_QUERY', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, data: [{ timestamp: 1787742000, value: 10 }] });
    const direct = bindTrustedDirect(createCtx('run-direct-wrong-route'), {
      prompt: '最近 7 天 HTTP 应用流量趋势如何？',
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    }, {
      route: 'OTHER_SKILL'
    });

    const result = await tools.get('napm-skill-query').execute('direct-wrong-route', direct.params);

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        error: { code: 'QUERY_TURN_ROUTE_MISMATCH' }
      }
    });
    expect(plugin.__test__.queryTurnCoordinator.get(direct.scope, direct.turnId)).toMatchObject({
      route: 'OTHER_SKILL',
      phase: 'RECEIVED'
    });
  });

  test('blocks direct query execution when the trusted tool name is not napm-skill-query', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({ ok: true, data: [{ timestamp: 1787742000, value: 10 }] });
    const direct = bindTrustedDirect(createCtx('run-direct-wrong-tool-name'), {
      prompt: '最近 7 天 HTTP 应用流量趋势如何？',
      queryDraft: buildTrendDraft('DefinedApp', 'HTTP')
    }, {
      toolName: 'napm-summary'
    });

    const result = await tools.get('napm-skill-query').execute('direct-wrong-tool-name', direct.params);

    expect(southbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        error: { code: 'QUERY_TOOL_IDENTITY_MISMATCH' }
      }
    });
    expect(plugin.__test__.queryTurnCoordinator.get(direct.scope, direct.turnId)).toMatchObject({
      route: 'NAPM_QUERY',
      phase: 'RECEIVED'
    });
  });

  test('blocks an unverified multi-group query before Query Skill, NapmClient, or southbound execution', async () => {
    const querySkill = require('../skills/openclaw-napm-query/scripts/run_napm_query');
    const NapmClient = require('../skills/openclaw-napm-query/services/NapmClient');
    const skill = jest.spyOn(querySkill, 'handleSkillCall');
    const clientGet = jest.spyOn(NapmClient.prototype, 'get');
    const clientGetJson = jest.spyOn(NapmClient.prototype, 'getJson');
    const clientPost = jest.spyOn(NapmClient.prototype, 'post');
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const queryDraft = buildTrendDraft('DefinedApp', 'HTTP');
    queryDraft.groups.push({ type: 'DefinedApp', argument: 'HTTPS' });
    const direct = bindTrustedDirect(createCtx('run-direct-unverified-multi-group'), {
      prompt: '最近 7 天 HTTP 和 HTTPS 应用流量趋势如何？',
      queryDraft
    });

    const result = await tools.get('napm-skill-query').execute(
      'direct-unverified-multi-group',
      direct.params
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        ok: false,
        decision: {
          outcome: 'VALIDATION_FAILURE',
          reasonCode: 'MULTI_GROUP_PATH_UNVERIFIED',
          southboundAllowed: false
        }
      }
    });
    expect(skill).not.toHaveBeenCalled();
    expect(clientGet).not.toHaveBeenCalled();
    expect(clientGetJson).not.toHaveBeenCalled();
    expect(clientPost).not.toHaveBeenCalled();
    expect(southbound).not.toHaveBeenCalled();
  });

  test('executes a direct multi-group query only with a validated static drilldown path', async () => {
    const southbound = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'topValues',
        data: [{ group: { key: 'DefinedApp', argument: 'HTTP' }, value: 10 }],
        error: null
      });
    const groups = [
      { type: 'BusinessGroup', argument: 'server-segment' },
      { type: 'Applications', argument: null },
      { type: 'DefinedApp', argument: null }
    ];
    const direct = bindTrustedDirect(createCtx('run-direct-validated-multi-group'), {
      prompt: '继续下钻 server-segment 业务组中的应用流量排行',
      queryDraft: {
        service: 'topValues',
        queryModeKey: 'topn',
        groups,
        metrics: ['TPIO'],
        metric: 'TPIO',
        topMetric: 'TPIO',
        topCount: 10,
        timeRange: { key: 'last7days' },
        pathPlanning: {
          applied: true,
          shouldApply: true,
          strategy: 'static_groups_tree',
          followUpAction: 'drilldown',
          anchorType: 'BusinessGroup',
          plannedGroups: groups,
          selectedPath: ['BusinessGroup', 'Applications', 'DefinedApp']
        }
      }
    });

    const result = await tools.get('napm-skill-query').execute(
      'direct-validated-multi-group',
      direct.params
    );

    expect(result.details.ok).toBe(true);
    expect(southbound).toHaveBeenCalledTimes(1);
    expect(southbound.mock.calls[0][0]).toMatchObject({
      service: 'topValues',
      groups
    });
  });

  test('never treats the latest conversation turn as the active turn without a run guard', () => {
    expect(plugin.__test__.getActiveTurnId({ turnId: 'latest-conversation-turn' }, null)).toBe('');
    expect(plugin.__test__.getActiveTurnId(
      { turnId: 'latest-conversation-turn' },
      { turnId: 'bound-run-turn' }
    )).toBe('bound-run-turn');
  });
});
