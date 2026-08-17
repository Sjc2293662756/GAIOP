'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toolPreambleFixture = require('./fixtures/openclaw/tool-preamble-then-final.json');

describe('NAPM plugin turn-aware result and message lifecycle', () => {
  let baseDir;
  let plugin;
  let hooks;
  let tools;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-turn-lifecycle-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
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

  async function startTurn(ctx, prompt, promptBuildText = prompt) {
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt: promptBuildText }, ctx);
  }

  function bindToolCall(ctx, toolName, params) {
    const event = { toolName, toolCallId: `${toolName}-call`, params };
    const hookResult = hooks.get('before_tool_call')(event, ctx);
    return {
      event,
      params: hookResult?.params || event.params
    };
  }

  function buildDefinedAppResult() {
    const rows = [
      { label: '回溯238', value: '回溯238', type: 'DefinedApp', applicationType: 2 },
      { label: 'Esxi-local', value: 'Esxi-local', type: 'DefinedApp', applicationType: 2 },
      { label: 'HIS系统1', value: 'HIS系统1', type: 'DefinedApp', applicationType: 2 }
    ];
    return {
      ok: true,
      service: 'groups',
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'DefinedApp' }],
        semanticConstraints: {
          operation: 'metadata_list',
          workflowType: 'object_inventory',
          targetObjectType: 'DefinedApp'
        }
      },
      rows,
      data: rows,
      metadata: {
        requestedObjectType: 'DefinedApp',
        effectiveObjectType: 'DefinedApp',
        providerType: 'applications',
        apiType: 'applications',
        applicationTypeFilter: [2],
        applicationCatalogRole: 'defined_application'
      },
      summary: {
        title: '对象列表',
        highlights: [],
        rowCount: rows.length,
        empty: false
      },
      displayText: null,
      replyText: null,
      responseType: 'group_list',
      narrationStructure: {
        responseType: 'group_list',
        title: '对象列表',
        itemCount: rows.length,
        items: rows.map((row, index) => ({
          rank: index + 1,
          value: row.value,
          type: row.type,
          applicationType: row.applicationType
        })),
        displayText: null
      }
    };
  }

  function rememberCurrentTurnResult(ctx, prompt, result = buildDefinedAppResult()) {
    const bound = bindToolCall(ctx, 'napm-skill-query', {
      prompt,
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'Application' }]
      }
    });
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    plugin.__test__.rememberSkillResult(prompt, result, scope, 'napm-skill-query', turnId);
    return { scope, turnId };
  }

  test('finds a successful current-turn result even when prompt-build text has metadata prefixes', async () => {
    const ctx = createCtx('metadata-result');
    const prompt = '现在系统情况怎么样？';
    const prefixedPrompt = [
      'Conversation info (untrusted metadata):',
      '{"message_id":"wx-123","sender":"user"}',
      '',
      prompt
    ].join('\n');

    await startTurn(ctx, prompt, prefixedPrompt);
    const bound = bindToolCall(ctx, 'napm-summary', {
      prompt,
      scope: { type: 'global' },
      timeRange: { key: 'last1hour' }
    });
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      summary: {
        overallStatus: 'critical',
        displayText: '系统当前处于严重状态，有 55 条告警。'
      }
    }, scope, 'napm-summary', turnId);

    const outgoing = await hooks.get('message_sending')({
      content: '系统当前处于严重状态，有 55 条告警。',
      metadata: { isFinal: true }
    }, ctx);

    expect(turnId).toBeTruthy();
    expect(outgoing).toBeUndefined();
  });

  test('rewrites a title-only DefinedApp answer from the current skill rows', async () => {
    const ctx = createCtx('defined-app-render');
    const prompt = '现在系统有哪些应用？';
    await startTurn(ctx, prompt);
    rememberCurrentTurnResult(ctx, prompt);

    const outgoing = await hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '对象列表' }]
      }
    }, ctx);
    const text = outgoing?.message?.content?.[0]?.text || '';

    expect(text).toContain('3 个已定义应用');
    expect(text).toContain('回溯238');
    expect(text).toContain('Esxi-local');
    expect(text).not.toBe('对象列表');
  });

  test('does not accept a previous-turn object inventory result as current-turn evidence', async () => {
    const ctx = createCtx('defined-app-fresh-turn');
    const prompt = '现在系统有哪些应用？';
    await startTurn(ctx, prompt);
    rememberCurrentTurnResult(ctx, prompt);

    ctx.runId = 'run-defined-app-fresh-turn-2';
    await startTurn(ctx, prompt);
    const outgoing = await hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '对象列表' }]
      }
    }, ctx);
    const text = outgoing?.message?.content?.[0]?.text || '';

    expect(text).toContain('本轮未拿到有效 skill 结果');
  });

  test('replays the latest successful list for a missing-result follow-up without routing assistant text', async () => {
    const ctx = createCtx('defined-app-result-followup');
    const prompt = '现在系统有哪些应用？';
    await startTurn(ctx, prompt);
    rememberCurrentTurnResult(ctx, prompt);

    ctx.runId = 'run-defined-app-result-followup-2';
    await startTurn(ctx, '为什么没有返回？');
    const outgoing = await hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '已经查到 3 个应用，需要我针对某个应用做下钻分析吗？'
        }]
      }
    }, ctx);
    const text = outgoing?.message?.content?.[0]?.text || '';

    expect(text).toContain('3 个已定义应用');
    expect(text).toContain('HIS系统1');
    expect(text).not.toContain('当前问题属于 NAPM 下钻/层级目录查询');
  });

  test('never rewrites an intermediate assistant message that contains a toolCall', async () => {
    const ctx = createCtx('tool-call-preserved');
    const prompt = '给我业务最近七天的综述报告！';
    await startTurn(ctx, prompt);
    const toolCallMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: '先执行综述查询。' },
        {
          type: 'toolCall',
          id: 'summary-call-1',
          name: 'napm-summary',
          arguments: { prompt }
        }
      ]
    };

    const result = await hooks.get('before_message_write')({ message: toolCallMessage }, ctx);

    expect(result).toBeUndefined();
    expect(toolCallMessage.content[1]).toMatchObject({
      type: 'toolCall',
      id: 'summary-call-1',
      name: 'napm-summary'
    });
  });

  test('suppresses a recorded tool progress payload before delivering the terminal alert reply', async () => {
    const ctx = createCtx('alert-tool-progress');
    const prompt = toolPreambleFixture.prompt;
    const [progressMessage, , terminalMessage] = toolPreambleFixture.turn.messages;
    const progressText = progressMessage.content[0].text;
    const terminalText = terminalMessage.content[0].text;
    const deterministicReply = '最近24小时 告警查询结果\n告警总数：1741 条';
    await startTurn(ctx, prompt);

    const bound = bindToolCall(ctx, 'napm-alert-query', {
      prompt,
      mode: 'summary',
      criteria: { timeRange: { key: 'last24hours' } }
    });
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      service: 'alertsSummary',
      summary: { total: 1741 },
      narrationInput: {
        schema: 'openclaw_napm_alert.v1',
        displayText: deterministicReply
      }
    }, scope, 'napm-alert-query', turnId);

    expect(await hooks.get('before_message_write')({ message: progressMessage }, ctx)).toBeUndefined();
    await hooks.get('before_message_write')({ message: terminalMessage }, ctx);

    const progressDelivery = await hooks.get('message_sending')({ content: progressText }, ctx);
    const terminalDelivery = await hooks.get('message_sending')({ content: terminalText }, ctx);

    expect(progressDelivery).toEqual({ cancel: true });
    expect(terminalDelivery).toEqual({ content: deterministicReply });
  });

  test('suppresses tool progress when write and delivery hooks expose different scope identities', async () => {
    const inboundCtx = createCtx('split-hook-scope');
    const writeCtx = {
      sessionKey: inboundCtx.sessionKey,
      sessionId: inboundCtx.sessionId,
      runId: inboundCtx.runId
    };
    const deliveryCtx = {
      channelId: inboundCtx.channelId,
      accountId: inboundCtx.accountId,
      conversationId: inboundCtx.conversationId
    };
    const progressText = 'I will query the current alert summary now.';

    await startTurn(inboundCtx, '现在系统都有哪些告警？');
    expect(hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: progressText },
          { type: 'toolCall', name: 'napm-alert-query', arguments: {} }
        ]
      }
    }, writeCtx)).toBeUndefined();

    await expect(hooks.get('message_sending')({
      content: progressText,
      metadata: { channel: 'wecom', accountId: inboundCtx.accountId }
    }, deliveryCtx)).resolves.toEqual({ cancel: true });
  });

  test('cancels a streaming preview before bypass/fallback rewriting', async () => {
    const ctx = createCtx('preview-first');
    await startTurn(ctx, '现在系统情况怎么样？');

    const result = await hooks.get('message_sending')({
      content: '我先直接调用底层 API 重试一次，再给出系统状态。',
      metadata: { streaming: true, isFinal: false, phase: 'partial' }
    }, ctx);

    expect(result).toEqual({ cancel: true });
  });

  test('delivers at most one generic fallback in a user turn', async () => {
    const ctx = createCtx('fallback-dedupe');
    await startTurn(ctx, '现在系统情况怎么样？');
    const event = {
      content: '尝试直接调用底层 API 重试，但还没有拿到 skill 结果。',
      metadata: { isFinal: true }
    };

    const first = await hooks.get('message_sending')(event, ctx);
    const second = await hooks.get('message_sending')(event, ctx);

    expect(first?.content).toContain('本轮未拿到有效 skill 结果');
    expect(second).toEqual({ cancel: true });
  });

  test('publishes a spec-derived query schema and structured hard validation errors', async () => {
    const tool = tools.get('napm-skill-query');
    const resolvedQuerySchema = tool.parameters.properties.resolvedQuery;

    expect(resolvedQuerySchema.properties.service.enum).toEqual(expect.arrayContaining([
      'topValues',
      'averageValues',
      'timeValues',
      'overview',
      'groups',
      'metrics',
      'drilldownCatalog',
      'topValues_multi_protocol'
    ]));
    expect(resolvedQuerySchema.properties).toEqual(expect.objectContaining({
      granularity: expect.any(Object),
      overviewScene: expect.any(Object),
      protocolQueries: expect.any(Object),
      filters: expect.any(Object),
      executionOptions: expect.any(Object)
    }));
    expect(tool.description).toContain('groups requires service, queryModeKey, groups');
    expect(tool.description).toContain('groups=[{type:"WebApplication"}]');
    expect(resolvedQuerySchema.properties.groups.description).toContain('DefinedApp');

    const result = await tool.execute('invalid-service-call', {
      prompt: '过去 24 小时的吞吐量趋势如何？',
      resolvedQuery: {
        service: 'timeseries',
        queryModeKey: 'timeseries'
      }
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      responseType: 'BOUNDARY_VALIDATION_ERROR',
      allowedServices: expect.arrayContaining(['timeValues']),
      expectedQueryModeKey: null
    });
    expect(result.details.error.message).toContain('napm-resolution-spec.v1.json');
  });

  test('remembers construction-phase validation failures in the current turn', async () => {
    const ctx = createCtx('blocked-validation');
    const prompt = '过去 24 小时的吞吐量趋势如何？';
    await startTurn(ctx, prompt, [
      'Conversation info (untrusted metadata):',
      '{"message_id":"blocked-validation"}',
      '',
      prompt
    ].join('\n'));

    const hookResult = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'timeseries',
          queryModeKey: 'timeseries'
        }
      }
    }, ctx);
    expect(hookResult).toMatchObject({ block: true });

    const outgoing = await hooks.get('message_sending')({
      content: hookResult.blockReason,
      metadata: { isFinal: true }
    }, ctx);
    expect(outgoing?.content).toContain('查询参数未构造完整');
    expect(outgoing?.content).not.toContain('UPSTREAM_RESOLVED_QUERY_INVALID');
  });

  test('does not expose a superseded construction failure after a valid retry', async () => {
    const ctx = createCtx('metadata-repair-runtime-failure');
    const prompt = '现在系统中有哪些业务？';
    await startTurn(ctx, prompt);

    const invalidCall = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'groups',
          queryModeKey: 'metadata'
        }
      }
    }, ctx);
    expect(invalidCall).toMatchObject({ block: true });

    const repairedCall = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'groups',
          queryModeKey: 'metadata',
          groups: [{ type: 'WebApplication' }]
        }
      }
    }, ctx);
    expect(repairedCall?.block).not.toBe(true);

    const outgoing = await hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'NAPM query tool execution failed.' }]
      }
    }, ctx);
    const text = outgoing?.message?.content?.[0]?.text || '';

    expect(text).toContain('本轮未拿到有效 skill 结果');
    expect(text).not.toContain('UPSTREAM_RESOLVED_QUERY_INVALID');
    expect(text).not.toContain('requiredFields');
    expect(text).not.toContain('resolvedQuerySummary');
  });

  test('renders validation and execution failures without serializing internal contracts', () => {
    const validationReply = plugin.__test__.buildRememberedSkillReplyText({
      recordType: 'query_validation_failure',
      result: {
        ok: false,
        responseType: 'BOUNDARY_VALIDATION_ERROR',
        error: { code: 'UPSTREAM_RESOLVED_QUERY_INVALID' },
        requiredFields: ['service', 'queryModeKey', 'groups']
      }
    });
    const executionReply = plugin.__test__.buildRememberedSkillReplyText({
      recordType: 'skill_execution_failure',
      result: {
        ok: false,
        responseType: 'SKILL_EXECUTION_ERROR',
        error: { code: 'NAPM_SKILL_EXECUTION_FAILED' }
      }
    });

    expect(validationReply).toContain('查询参数未构造完整');
    expect(validationReply).not.toContain('UPSTREAM_RESOLVED_QUERY_INVALID');
    expect(validationReply).not.toContain('requiredFields');
    expect(executionReply).toContain('NAPM 查询工具执行失败');
    expect(executionReply).not.toContain('NAPM_SKILL_EXECUTION_FAILED');
  });
});
