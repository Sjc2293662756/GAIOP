'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('NAPM plugin report handoff integration', () => {
  let baseDir;
  let plugin;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-plugin-report-'));
    process.env.NAPM_REPORT_SOURCE_DIR = baseDir;
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
  });

  afterEach(() => {
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    delete process.env.NAPM_AUDIT_LOG_PATH;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test.each([
    'napm-summary',
    'napm-inspection-snapshot',
    'napm-fault-diagnosis',
    'napm-alert-query',
    'napm-skill-query',
    'napm-packet-analysis'
  ])('stores a source for %s with sessionKey-only context', (sourceTool) => {
    const event = { toolName: sourceTool, params: {} };
    const ctx = { sessionKey: 'wecom:account-1:conversation-7' };
    plugin.__test__.bindTrustedToolContext(event, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(event.params);

    const record = plugin.__test__.rememberSkillResult(
      `source prompt ${sourceTool}`,
      { details: { reportData: { reportType: 'summary_report', title: sourceTool } } },
      scope,
      sourceTool
    );

    expect(scope).toBe('session:wecom:account-1:conversation-7');
    expect(record.reportSourceId).toMatch(/^rps_/);
    const reportInput = plugin.__test__.buildReportInputForExport({
      traceId: event.params.traceId,
      reportSourceId: record.reportSourceId,
      prompt: 'export this report'
    });
    expect(reportInput).toMatchObject({
      ok: true,
      source: 'report_source_store',
      reportData: { title: sourceTool }
    });
  });

  test('does not depend on truncated tool details and survives a module restart', () => {
    const event = { toolName: 'napm-summary', params: {} };
    plugin.__test__.bindTrustedToolContext(event, { sessionKey: 'session-restart' });
    const scope = plugin.__test__.getTrustedConversationKey(event.params);
    const record = plugin.__test__.rememberSkillResult(
      'daily report',
      { details: { reportData: { reportType: 'summary_report', title: '完整源数据', rows: [{ value: 42 }] } } },
      scope,
      'napm-summary'
    );

    jest.resetModules();
    const restartedPlugin = require('../napm-openclaw-plugin.remote');
    const restartedEvent = { toolName: 'napm-report-export', params: {} };
    restartedPlugin.__test__.bindTrustedToolContext(restartedEvent, { sessionKey: 'session-restart' });
    const reportInput = restartedPlugin.__test__.buildReportInputForExport({
      traceId: restartedEvent.params.traceId,
      reportSourceId: record.reportSourceId,
      prompt: 'export this report'
    });

    expect(reportInput.reportData).toMatchObject({
      title: '完整源数据',
      rows: [{ value: 42 }]
    });
  });

  test('trusted conversation scope survives a plugin module boundary', () => {
    const event = { toolName: 'napm-summary', params: {} };
    const traceId = plugin.__test__.bindTrustedToolContext(event, {
      sessionKey: 'session-module-boundary'
    });

    jest.resetModules();
    const isolatedPlugin = require('../napm-openclaw-plugin.remote');

    expect(isolatedPlugin.__test__.getTrustedConversationKey({ traceId })).toBe(
      'session:session-module-boundary'
    );
  });

  test('audits persisted report-source resolution and successful generation without report data', () => {
    const event = { toolName: 'napm-summary', params: {} };
    const traceId = plugin.__test__.bindTrustedToolContext(event, { sessionKey: 'session-audit' });
    const scope = plugin.__test__.getTrustedConversationKey(event.params);
    const record = plugin.__test__.rememberSkillResult(
      'daily summary',
      { reportData: { reportType: 'summary_report', title: 'Daily summary' } },
      scope,
      'napm-summary'
    );
    const reportInput = plugin.__test__.buildReportInputForExport({
      traceId,
      reportSourceId: record.reportSourceId,
      prompt: 'export daily summary'
    });

    plugin.__test__.auditReportExportSourceResolved(reportInput, { traceId });
    plugin.__test__.auditReportGenerated({
      ok: true,
      reportId: 'napm_daily_summary_1',
      format: 'docx',
      title: 'Daily summary'
    }, reportInput, { traceId });

    const events = fs.readFileSync(path.join(baseDir, 'audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const resolved = events.find((entry) => entry.event === 'report_export_source_resolved');
    const generated = events.find((entry) => entry.event === 'report_generated');

    expect(resolved).toMatchObject({
      traceId,
      reportSourceId: record.reportSourceId,
      source: 'report_source_store',
      sourceTool: 'napm-summary'
    });
    expect(generated).toMatchObject({
      traceId,
      reportSourceId: record.reportSourceId,
      reportId: 'napm_daily_summary_1',
      format: 'docx'
    });
    expect(JSON.stringify(events)).not.toContain('Daily summary');
  });

  test('keeps sources distinct and rejects cross-session access', () => {
    const firstEvent = { toolName: 'napm-summary', params: {} };
    plugin.__test__.bindTrustedToolContext(firstEvent, { sessionKey: 'session-a' });
    const firstScope = plugin.__test__.getTrustedConversationKey(firstEvent.params);
    const first = plugin.__test__.rememberSkillResult(
      'summary a',
      { reportData: { reportType: 'summary_report', title: 'A' } },
      firstScope,
      'napm-summary'
    );
    const second = plugin.__test__.rememberSkillResult(
      'alert a',
      { reportData: { reportType: 'alert_report', title: 'B' } },
      firstScope,
      'napm-alert-query'
    );

    expect(plugin.__test__.buildReportInputForExport({
      traceId: firstEvent.params.traceId,
      prompt: 'export this report'
    })).toMatchObject({ ok: false, errorCode: 'REPORT_SOURCE_AMBIGUOUS' });
    expect(plugin.__test__.buildReportInputForExport({
      traceId: firstEvent.params.traceId,
      reportSourceId: first.reportSourceId,
      prompt: 'export this report'
    }).reportData.title).toBe('A');

    const otherEvent = { toolName: 'napm-report-export', params: {} };
    plugin.__test__.bindTrustedToolContext(otherEvent, { sessionKey: 'session-b' });
    expect(plugin.__test__.buildReportInputForExport({
      traceId: otherEvent.params.traceId,
      reportSourceId: second.reportSourceId,
      prompt: 'export this report'
    })).toMatchObject({ ok: false, errorCode: 'REPORT_SOURCE_FORBIDDEN' });
  });

  test('blocks direct file generation for report intents', () => {
    const hooks = new Map();
    plugin.register({
      registerTool() {},
      registerHook(name, handler) {
        hooks.set(name, handler);
      },
      logger: { info() {}, warn() {}, error() {} }
    });

    const beforeToolCall = hooks.get('before_tool_call');
    const prompt = 'export the current report to Word';
    const ctx = {
      sessionKey: 'session-report-guard',
      runId: 'run-report-guard'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    const blocked = beforeToolCall({
      toolName: 'exec',
      params: { prompt }
    }, ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.blockReason).toContain('napm-report-export');

    const allowed = beforeToolCall({
      toolName: 'napm-report-export',
      params: { prompt }
    }, ctx);
    expect(allowed?.params?.traceId).toMatch(/^napm-/);
  });

  test('uses current OpenClaw typed hooks and returns trusted params for frozen tool input', () => {
    const typedHooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) {
        typedHooks.set(name, handler);
      },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:report-hook-contract',
      runId: 'run-report-hook-contract'
    };
    const beforeAgentStart = typedHooks.get('before_agent_start');
    const beforeToolCall = typedHooks.get('before_tool_call');

    expect(beforeAgentStart).toEqual(expect.any(Function));
    expect(beforeToolCall).toEqual(expect.any(Function));

    beforeAgentStart({
      prompt: "Generate today's system-wide NAPM overview report as a Word document."
    }, ctx);

    const summaryParams = Object.freeze({
      prompt: "Generate today's system-wide NAPM overview report as a Word document.",
      scope: { type: 'global' },
      timeRange: { key: 'today' }
    });
    const allowed = beforeToolCall({
      toolName: 'napm-summary',
      toolCallId: 'summary-call-1',
      params: summaryParams
    }, ctx);

    expect(summaryParams.traceId).toBeUndefined();
    expect(allowed?.params?.traceId).toMatch(/^napm-/);
    expect(plugin.__test__.getTrustedConversationKey(allowed.params)).toBe(
      'session:agent:main:explicit:report-hook-contract'
    );

    const blocked = beforeToolCall({
      toolName: 'exec',
      toolCallId: 'exec-call-1',
      params: Object.freeze({ command: 'generate report.docx' })
    }, ctx);
    expect(blocked).toMatchObject({ block: true });
  });

  test('does not rewrite a successful report export into the generic skill-required reply', async () => {
    const hooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:report-delivery',
      channelId: 'wecom',
      runId: 'run-report-delivery'
    };
    const sourcePrompt = '给我系统的综述报告！';
    hooks.get('message_received')({ content: sourcePrompt }, ctx);
    hooks.get('before_agent_start')({ prompt: sourcePrompt }, ctx);
    const prompt = '为什么没有给我报告？';
    hooks.get('message_received')({ content: prompt }, ctx);
    hooks.get('before_agent_start')({ prompt }, ctx);

    const exportCall = hooks.get('before_tool_call')({
      toolName: 'napm-report-export',
      params: { prompt }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(exportCall.params);
    plugin.__test__.rememberReportExportResult(prompt, {
      ok: true,
      title: '全局综述报告',
      format: 'docx',
      downloadUrl: '/reports/napm_global.docx',
      filePath: '/tmp/napm_global.docx'
    }, scope, plugin.__test__.getTrustedTurnId(exportCall.params));

    const genericGuardReply = '当前问题必须经 NAPM skill 执行后才能回答。\n本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。';
    const rewritten = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: genericGuardReply }]
      }
    }, ctx);

    expect(rewritten?.message?.content?.[0]?.text).toContain('报告已生成：全局综述报告');
    expect(rewritten?.message?.content?.[0]?.text).not.toContain('/reports/napm_global.docx');
    expect(rewritten?.message?.content?.[0]?.text).not.toContain('/tmp/napm_global.docx');
    expect(rewritten?.message?.content?.[0]?.text).not.toContain('未拿到有效 skill 结果');

    const sending = await hooks.get('message_sending')({ content: genericGuardReply }, ctx);
    expect(sending?.content).toContain('报告已生成：全局综述报告');
    expect(sending?.content).not.toContain('/reports/napm_global.docx');
    expect(sending?.content).not.toContain('/tmp/napm_global.docx');
    expect(sending?.content).not.toContain('未拿到有效 skill 结果');
  });

  test('queues a successful current-turn report as a native reply payload with Word media', async () => {
    const hooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:report-reply-dispatch',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'report-user',
      runId: 'run-report-reply-dispatch'
    };
    const prompt = '给我应用的最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    hooks.get('before_agent_start')({ prompt }, ctx);
    const exportCall = hooks.get('before_tool_call')({
      toolName: 'napm-report-export',
      params: { prompt }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(exportCall.params);
    plugin.__test__.rememberReportExportResult(prompt, {
      ok: true,
      title: 'NAPM 应用综述报告',
      format: 'docx',
      downloadUrl: '/reports/napm_app.docx',
      filePath: '/tmp/napm_app.docx'
    }, scope, plugin.__test__.getTrustedTurnId(exportCall.params));

    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 })),
      waitForIdle: jest.fn(async () => {}),
      getFailedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: jest.fn()
    };
    const hookResult = await hooks.get('reply_dispatch')({
      ctx: {
        SessionKey: ctx.sessionKey,
        Surface: 'wecom',
        AccountId: 'default',
        From: 'report-user',
        Body: prompt,
        MessageSid: 'message-report-reply-dispatch'
      },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, {
      dispatcher,
      onReplyStart: jest.fn(async () => {}),
      recordProcessed: jest.fn(),
      markIdle: jest.fn()
    });

    expect(hookResult).toMatchObject({ handled: true, queuedFinal: true });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('报告已生成'),
      mediaUrl: '/tmp/napm_app.docx',
      mediaUrls: ['/tmp/napm_app.docx']
    }));
  });

  test('owns a first-turn summary in reply_dispatch and queues the generated Word once', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true, reportSourceId: 'rps_first_turn' },
      metadata: { reportSourceId: 'rps_first_turn' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockResolvedValue({
      details: {
        ok: true,
        title: 'NAPM 应用综述报告',
        format: 'docx',
        downloadUrl: '/reports/napm_first_turn.docx',
        filePath: '/tmp/napm_first_turn.docx'
      }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:first-turn-reply-dispatch',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'first-turn-user',
      runId: 'run-first-turn-reply-dispatch'
    };
    const prompt = '给我应用的最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };
    const result = await hooks.get('reply_dispatch')({
      ctx: {
        SessionKey: ctx.sessionKey,
        Surface: 'wecom',
        AccountId: 'default',
        From: 'first-turn-user',
        Body: prompt,
        MessageSid: 'message-first-turn-reply-dispatch'
      },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, {
      dispatcher,
      onReplyStart: jest.fn(async () => {}),
      recordProcessed: jest.fn(),
      markIdle: jest.fn()
    });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).toHaveBeenCalledWith(
      'automatic-report-export',
      expect.objectContaining({ reportSourceId: 'rps_first_turn', format: 'docx' })
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('报告已生成'),
      mediaUrls: ['/tmp/napm_first_turn.docx']
    }));
  });

  test('treats export success without a file path as a deterministic summary failure', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true, reportSourceId: 'rps_missing_file' },
      metadata: { reportSourceId: 'rps_missing_file' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockResolvedValue({
      details: {
        ok: true,
        title: 'NAPM 系统综述报告',
        format: 'docx'
      }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:summary-export-missing-file',
      channelId: 'wecom',
      runId: 'run-summary-export-missing-file'
    };
    const prompt = '给我系统最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'summary-missing-file-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).toHaveBeenCalledTimes(1);
    const payload = dispatcher.sendFinalReply.mock.calls[0][0];
    expect(payload).toEqual({
      text: '综述报告生成失败：数据汇总或文档导出未完成，请稍后重试。'
    });
    expect(payload.text).not.toContain('报告已生成');
  });

  test('returns a deterministic failure when automatic summary collection fails', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: false, errorCode: 'SUMMARY_TEST_FAILURE' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute');

    const ctx = {
      sessionKey: 'agent:main:explicit:automatic-summary-failure',
      channelId: 'wecom',
      runId: 'run-automatic-summary-failure'
    };
    const prompt = '给我系统最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'summary-failure-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: '综述报告生成失败：数据汇总或文档导出未完成，请稍后重试。'
    });
  });

  test('does not export when automatic summary has no report source', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute');

    const ctx = {
      sessionKey: 'agent:main:explicit:automatic-summary-no-source',
      channelId: 'wecom',
      runId: 'run-automatic-summary-no-source'
    };
    const prompt = '给我系统最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'summary-no-source-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: '综述报告生成失败：数据汇总或文档导出未完成，请稍后重试。'
    });
  });

  test('does not export when automatic summary omits its success flag', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { reportSourceId: 'rps_missing_success_flag' },
      metadata: { reportSourceId: 'rps_missing_success_flag' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute');

    const ctx = {
      sessionKey: 'agent:main:explicit:automatic-summary-missing-success',
      channelId: 'wecom',
      runId: 'run-automatic-summary-missing-success'
    };
    const prompt = '给我系统最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'summary-missing-success-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: '综述报告生成失败：数据汇总或文档导出未完成，请稍后重试。'
    });
  });

  test('returns a deterministic failure when automatic summary export fails', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true, reportSourceId: 'rps_export_failure' },
      metadata: { reportSourceId: 'rps_export_failure' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockResolvedValue({
      details: { ok: false, errorCode: 'EXPORT_TEST_FAILURE' }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:automatic-summary-export-failure',
      channelId: 'wecom',
      runId: 'run-automatic-summary-export-failure'
    };
    const prompt = '给我系统最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'summary-export-failure-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: '综述报告生成失败：数据汇总或文档导出未完成，请稍后重试。'
    });
  });

  test('keeps a single-business analysis report on summary instead of fault diagnosis', () => {
    const hooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:single-business-analysis-routing',
      runId: 'run-single-business-analysis-routing'
    };
    const prompt = '生成回溯238web的单个业务分析报告';
    hooks.get('before_agent_start')({ prompt }, ctx);

    const blocked = hooks.get('before_tool_call')({
      toolName: 'napm-fault-diagnosis',
      params: { prompt, description: prompt }
    }, ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.blockReason).toContain('napm-summary');

    const allowed = hooks.get('before_tool_call')({
      toolName: 'napm-summary',
      params: {
        prompt,
        scope: { type: 'webApplication' },
        timeRange: { key: 'last24hours' }
      }
    }, ctx);
    expect(allowed?.params?.traceId).toMatch(/^napm-/);
  });

  test('routes a first-turn timed inspection report through inspection snapshot, never summary', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-inspection-snapshot'), 'execute').mockResolvedValue({
      details: {
        ok: true,
        reportSourceId: 'rps_first_turn_inspection',
        summary: {
          title: 'NAPM 系统巡检报告',
          status: 'warning',
          highlights: [
            '近一日流量存在明显波动。',
            '检测到 5 次慢访问。',
            'HTTP 400 错误共 714 次。'
          ]
        },
        reportData: {
          reportType: 'inspection_report',
          templateId: 'napm_traffic_health_inspection_v1'
        }
      },
      metadata: { reportSourceId: 'rps_first_turn_inspection' }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true, reportSourceId: 'rps_wrong_summary' },
      metadata: { reportSourceId: 'rps_wrong_summary' }
    });
    const reportDetails = {
      ok: true,
      title: 'NAPM 系统巡检报告',
      format: 'docx',
      downloadUrl: '/reports/napm_inspection.docx',
      filePath: '/tmp/napm_inspection.docx'
    };
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockImplementation(async (_id, args) => {
      plugin.__test__.rememberReportExportResult(
        prompt,
        reportDetails,
        plugin.__test__.getTrustedConversationKey(args),
        plugin.__test__.getTrustedTurnId(args)
      );
      return { details: reportDetails };
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:first-turn-inspection',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'first-turn-inspection-user',
      runId: 'run-first-turn-inspection'
    };
    const prompt = '给我最近七天的系统巡检报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };
    const result = await hooks.get('reply_dispatch')({
      ctx: {
        SessionKey: ctx.sessionKey,
        Surface: 'wecom',
        AccountId: 'default',
        From: 'first-turn-inspection-user',
        Body: prompt,
        MessageSid: 'message-first-turn-inspection'
      },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, {
      dispatcher,
      onReplyStart: jest.fn(async () => {}),
      recordProcessed: jest.fn(),
      markIdle: jest.fn()
    });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-inspection-snapshot').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-summary').execute).not.toHaveBeenCalled();
    expect(tools.get('napm-report-export').execute).toHaveBeenCalledWith(
      'automatic-inspection-report-export',
      expect.objectContaining({
        reportSourceId: 'rps_first_turn_inspection',
        format: 'docx'
      })
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    const finalPayload = dispatcher.sendFinalReply.mock.calls[0][0];
    expect(finalPayload).toMatchObject({
      mediaUrl: '/tmp/napm_inspection.docx',
      mediaUrls: ['/tmp/napm_inspection.docx']
    });
    expect(finalPayload.text).toContain('系统巡检报告已生成：NAPM 系统巡检报告');
    expect(finalPayload.text).toContain('总体状态：需关注');
    expect(finalPayload.text).toContain('重点发现：');
    expect(finalPayload.text).toContain('- 近一日流量存在明显波动。');
    expect(finalPayload.text).toContain('- 检测到 5 次慢访问。');
    expect(finalPayload.text).toContain('- HTTP 400 错误共 714 次。');
    expect(finalPayload.text).toContain('完整巡检报告已作为附件发送。');
    expect(finalPayload.text).not.toContain('下载链接');
    expect(finalPayload.text).not.toContain('文件路径');
    expect(finalPayload.text).not.toContain('/reports/napm_inspection.docx');
    expect(finalPayload.text).not.toContain('/tmp/napm_inspection.docx');

    const sendingResult = await hooks.get('message_sending')({
      content: finalPayload.text,
      mediaUrl: finalPayload.mediaUrl,
      mediaUrls: finalPayload.mediaUrls,
      metadata: { isFinal: true }
    }, ctx);
    expect(sendingResult?.content).toBe(finalPayload.text);

    const writeResult = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: finalPayload.text }]
      }
    }, ctx);
    expect(writeResult?.message?.content?.[0]?.text).toBe(finalPayload.text);
  });

  test('does not repeat inspection collection, export, or delivery for duplicate reply dispatch', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-inspection-snapshot'), 'execute').mockResolvedValue({
      details: {
        ok: true,
        reportData: {
          reportType: 'inspection_report',
          templateId: 'napm_traffic_health_inspection_v1'
        }
      },
      metadata: { reportSourceId: 'rps_duplicate_inspection' }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true },
      metadata: { reportSourceId: 'rps_wrong_duplicate_summary' }
    });

    const prompt = '给我最近七天的系统巡检报告！';
    const reportDetails = {
      ok: true,
      title: 'NAPM 系统巡检报告',
      format: 'docx',
      downloadUrl: '/reports/napm_inspection_once.docx',
      filePath: '/tmp/napm_inspection_once.docx'
    };
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockImplementation(async (_id, args) => {
      plugin.__test__.rememberReportExportResult(
        prompt,
        reportDetails,
        plugin.__test__.getTrustedConversationKey(args),
        plugin.__test__.getTrustedTurnId(args)
      );
      return { details: reportDetails };
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:duplicate-inspection',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'duplicate-inspection-user',
      runId: 'run-duplicate-inspection'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };
    const event = {
      ctx: {
        SessionKey: ctx.sessionKey,
        Surface: 'wecom',
        AccountId: 'default',
        From: 'duplicate-inspection-user',
        Body: prompt,
        MessageSid: 'message-duplicate-inspection'
      },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    };
    const hookCtx = {
      dispatcher,
      onReplyStart: jest.fn(async () => {}),
      recordProcessed: jest.fn(),
      markIdle: jest.fn()
    };

    const first = await hooks.get('reply_dispatch')(event, hookCtx);
    const duplicate = await hooks.get('reply_dispatch')(event, hookCtx);

    expect(first).toMatchObject({ handled: true, queuedFinal: true });
    expect(duplicate).toMatchObject({ handled: true, queuedFinal: false });
    expect(tools.get('napm-inspection-snapshot').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-summary').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  test('returns a deterministic inspection failure without falling back to summary', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-inspection-snapshot'), 'execute').mockResolvedValue({
      details: { ok: false, errorCode: 'INSPECTION_TEST_FAILURE' }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true },
      metadata: { reportSourceId: 'rps_wrong_failure_summary' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockResolvedValue({
      details: { ok: true, filePath: '/tmp/should-not-exist.docx' }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:inspection-failure',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'inspection-failure-user',
      runId: 'run-inspection-failure'
    };
    const prompt = '给我最近七天的系统巡检报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };
    const result = await hooks.get('reply_dispatch')({
      ctx: {
        SessionKey: ctx.sessionKey,
        Surface: 'wecom',
        AccountId: 'default',
        From: 'inspection-failure-user',
        Body: prompt
      },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, {
      dispatcher,
      onReplyStart: jest.fn(async () => {}),
      recordProcessed: jest.fn(),
      markIdle: jest.fn()
    });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-inspection-snapshot').execute).toHaveBeenCalledTimes(1);
    expect(tools.get('napm-report-export').execute).not.toHaveBeenCalled();
    expect(tools.get('napm-summary').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining('巡检报告生成失败')
    });
  });

  test('does not auto-run either report workflow for a mixed inspection and summary request', async () => {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-inspection-snapshot'), 'execute');
    jest.spyOn(tools.get('napm-summary'), 'execute');
    jest.spyOn(tools.get('napm-report-export'), 'execute');

    const ctx = {
      sessionKey: 'agent:main:explicit:mixed-report',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'mixed-report-user',
      runId: 'run-mixed-report'
    };
    const prompt = '先巡检再生成综述报告';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 0 }))
    };
    const result = await hooks.get('reply_dispatch')({
      ctx: {
        SessionKey: ctx.sessionKey,
        Surface: 'wecom',
        AccountId: 'default',
        From: 'mixed-report-user',
        Body: prompt
      },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toBeUndefined();
    expect(tools.get('napm-inspection-snapshot').execute).not.toHaveBeenCalled();
    expect(tools.get('napm-summary').execute).not.toHaveBeenCalled();
    expect(tools.get('napm-report-export').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  test('derives last7days for a first-turn summary request and leaves sync transcript untouched', async () => {
    expect(plugin.__test__.buildAutomaticSummaryToolArgs('给我系统最近七天的综述报告！')).toMatchObject({
      scope: { type: 'global' },
      timeRange: { key: 'last7days' },
      format: 'docx'
    });

    const hooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    const ctx = {
      sessionKey: 'agent:main:explicit:first-turn-summary',
      channelId: 'wecom',
      runId: 'run-first-turn-summary'
    };
    const prompt = '给我系统最近七天的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    hooks.get('before_agent_start')({ prompt }, ctx);

    const result = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '当前问题必须经 NAPM skill 执行后才能回答。\n本轮未拿到有效 skill 结果' }]
      }
    }, ctx);

    expect(result).toBeUndefined();
  });

  test('replays the latest report for a delivery follow-up and suppresses duplicate media', async () => {
    const hooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    const ctx = {
      sessionKey: 'agent:main:explicit:report-followup',
      channelId: 'wecom',
      runId: 'run-report-followup-1'
    };
    const sourcePrompt = '给我应用的最近七天的综述报告！';
    hooks.get('message_received')({ content: sourcePrompt }, ctx);
    hooks.get('before_agent_start')({ prompt: sourcePrompt }, ctx);
    const exportCall = hooks.get('before_tool_call')({
      toolName: 'napm-report-export',
      params: { prompt: sourcePrompt }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(exportCall.params);
    const previousTurnId = plugin.__test__.getTrustedTurnId(exportCall.params);
    plugin.__test__.rememberReportExportResult(sourcePrompt, {
      ok: true,
      title: '应用综述报告',
      format: 'docx',
      downloadUrl: '/reports/napm_app.docx',
      filePath: '/tmp/napm_app.docx'
    }, scope, previousTurnId);

    ctx.runId = 'run-report-followup-2';
    const followUp = '报告呢？没有给我？';
    hooks.get('message_received')({ content: followUp }, ctx);
    hooks.get('before_agent_start')({ prompt: followUp }, ctx);

    const first = await hooks.get('message_sending')({
      content: '当前问题必须经 NAPM skill 执行后才能回答。',
      mediaUrl: '/tmp/napm_app.docx',
      mediaUrls: ['/tmp/napm_app.docx'],
      metadata: { isFinal: true }
    }, ctx);
    expect(first?.content).toContain('报告已生成');
    expect(first?.mediaUrls).toEqual(['/tmp/napm_app.docx']);

    const duplicate = await hooks.get('message_sending')({
      content: '当前问题必须经 NAPM skill 执行后才能回答。',
      mediaUrl: '/tmp/napm_app.docx',
      mediaUrls: ['/tmp/napm_app.docx'],
      metadata: { isFinal: true }
    }, ctx);
    expect(duplicate).toEqual({ cancel: true });

    const rewritten = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '当前问题必须经 NAPM skill 执行后才能回答。' }]
      }
    }, ctx);
    expect(rewritten?.message?.content?.[0]?.text).toContain('报告已生成');
  });

  test('suppresses stale report media on a non-report turn', async () => {
    const hooks = new Map();
    plugin.register({
      registerTool() {},
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    const ctx = {
      sessionKey: 'agent:main:explicit:stale-media',
      channelId: 'wecom',
      runId: 'run-stale-media'
    };
    hooks.get('message_received')({ content: '继续分析' }, ctx);
    hooks.get('before_agent_start')({ prompt: '继续分析' }, ctx);
    const result = await hooks.get('message_sending')({
      content: '继续分析中',
      mediaUrl: '/tmp/napm_app.docx',
      mediaUrls: ['/tmp/napm_app.docx'],
      metadata: { isFinal: true }
    }, ctx);
    expect(result).toMatchObject({ mediaUrls: [], mediaUrl: null });
  });

  test('deduplicates the original report path and WeCom outbound copy', () => {
    const ctx = { sessionKey: 'agent:main:explicit:media-path-alias', channelId: 'wecom' };
    const original = '/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output/napm_应用综述报告_20260812_154540.docx';
    const outbound = '/home/netinside/.openclaw/media/outbound/napm_应用综述报告_20260812_154540---0b48983e-674d-4a9f-8486-59688c79d983.docx';
    expect(plugin.__test__.dedupeOutgoingMediaForConversation({ mediaUrl: original }, ctx)?.fresh).toEqual([original]);
    expect(plugin.__test__.dedupeOutgoingMediaForConversation({ mediaUrl: outbound }, ctx)?.fresh).toEqual([]);
  });

  test.each([
    ['业务', 'webApplication', '业务'],
    ['应用', 'application', '应用'],
    ['业务组', 'businessGroup', '业务组'],
    ['网络', 'network', '网络'],
    ['告警', 'alert', '告警']
  ])('maps %s summary requests to the matching scope', (label, type, scopeLabel) => {
    const args = plugin.__test__.buildAutomaticSummaryToolArgs(`给我${label}的最近七天的综述报告！`);
    expect(args).toMatchObject({
      scope: { type, label: scopeLabel },
      timeRange: { key: 'last7days' },
      format: 'docx'
    });
  });

  test.each([
    '给我回溯238web的综述报告！',
    '生成回溯238web的单个业务分析报告'
  ])('passes a resolved WebApplication target through the automatic summary handoff: %s', async (prompt) => {
    const hooks = new Map();
    const tools = new Map();
    const { NapmObjectTargetResolver } = require('../skills/shared/NapmObjectTargetResolver');
    plugin.__test__.setAutomaticSummaryTargetResolver(new NapmObjectTargetResolver({
      catalogProvider: async () => [
        { name: '回溯238web', applicationType: 3 },
        { name: 'HTTPS', applicationType: 2 }
      ]
    }));
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute').mockResolvedValue({
      details: { ok: true, reportSourceId: 'rps_single_business' },
      metadata: { reportSourceId: 'rps_single_business' }
    });
    jest.spyOn(tools.get('napm-report-export'), 'execute').mockResolvedValue({
      details: {
        ok: true,
        title: '回溯238web 业务综述报告',
        format: 'docx',
        filePath: '/tmp/backtrack-238.docx'
      }
    });

    const ctx = {
      sessionKey: 'agent:main:explicit:single-business-summary',
      channelId: 'wecom',
      runId: 'run-single-business-summary'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'single-business-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).toHaveBeenCalledWith(
      'automatic-summary',
      expect.objectContaining({
        scope: {
          type: 'webApplication',
          label: '业务',
          target: {
            groupType: 'WebApplication',
            groupArgument: '回溯238web',
            groupLabel: '回溯238web'
          }
        },
        title: '回溯238web 业务综述报告'
      })
    );
    expect(tools.get('napm-report-export').execute).toHaveBeenCalledTimes(1);
  });

  test('does not generate an overall report when a named summary target is unresolved', async () => {
    const hooks = new Map();
    const tools = new Map();
    const { NapmObjectTargetResolver } = require('../skills/shared/NapmObjectTargetResolver');
    plugin.__test__.setAutomaticSummaryTargetResolver(new NapmObjectTargetResolver({
      catalogProvider: async () => []
    }));
    plugin.register({
      registerTool(definition) { tools.set(definition.name, definition); },
      on(name, handler) { hooks.set(name, handler); },
      registerHook() {},
      logger: { info() {}, warn() {}, error() {} }
    });
    jest.spyOn(tools.get('napm-summary'), 'execute');
    jest.spyOn(tools.get('napm-report-export'), 'execute');

    const ctx = {
      sessionKey: 'agent:main:explicit:missing-summary-target',
      channelId: 'wecom',
      runId: 'run-missing-summary-target'
    };
    const prompt = '给我不存在对象ABC的综述报告！';
    hooks.get('message_received')({ content: prompt }, ctx);
    const dispatcher = {
      sendFinalReply: jest.fn(() => true),
      getQueuedCounts: jest.fn(() => ({ tool: 0, block: 0, final: 1 }))
    };

    const result = await hooks.get('reply_dispatch')({
      ctx: { SessionKey: ctx.sessionKey, Surface: 'wecom', From: 'missing-target-user', Body: prompt },
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      suppressUserDelivery: false,
      sendPolicy: 'allow'
    }, { dispatcher });

    expect(result).toMatchObject({ handled: true, queuedFinal: true });
    expect(tools.get('napm-summary').execute).not.toHaveBeenCalled();
    expect(tools.get('napm-report-export').execute).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: expect.stringContaining('未在 NAPM 对象目录中找到')
    });
  });
});
