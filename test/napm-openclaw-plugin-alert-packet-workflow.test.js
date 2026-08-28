'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');

describe('NAPM OpenClaw alert packet workflow boundary', () => {
  let baseDir;
  let plugin;
  let hooks;
  let tools;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-alert-packet-plugin-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    process.env.NAPM_ALERT_REFERENCE_DIR = baseDir;
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
    delete process.env.NAPM_ALERT_REFERENCE_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('requires the composite tool and restores canonical fixed alert fields', async () => {
    const prompt = [
      '分析告警数据包 eventId=745278 start=1786327320 end=1786327560 用户体验时间（服务器）',
      '触发指标值: 用户体验时间（服务器）=3055.3701毫秒',
      '告警级别: 紧急',
      '触发条件: 如果 用户体验时间（服务器） > 3000.0 则为 Critical'
    ].join('\n');
    const ctx = {
      channelId: 'wecom',
      accountId: 'alert-packet-account',
      conversationId: 'alert-packet-conversation',
      sessionKey: 'alert-packet-session',
      sessionId: 'alert-packet-session',
      runId: 'alert-packet-run'
    };

    hooks.get('message_received')({ content: prompt }, ctx);
    const promptBuild = await hooks.get('before_prompt_build')({ prompt }, ctx);

    expect(tools.has('napm-alert-packet-analysis')).toBe(true);
    expect(promptBuild.appendSystemContext).toContain('napm-alert-packet-analysis');

    for (const toolName of ['napm-alert-query', 'napm-packet-analysis', 'napm-skill-query', 'napm-summary']) {
      const blocked = hooks.get('before_tool_call')({
        toolName,
        params: { prompt }
      }, ctx);
      expect(blocked).toMatchObject({
        block: true,
        blockReason: expect.stringContaining('ALERT_PACKET_WORKFLOW_REQUIRED')
      });
    }

    const allowed = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: {
        prompt: 'wrong prompt',
        eventId: '1',
        start: 1,
        end: 2,
        timeRange: { key: 'last1hour' }
      }
    }, ctx);

    expect(allowed).toMatchObject({
      params: {
        prompt,
        eventId: '745278',
        start: 1786327320,
        end: 1786327560,
        triggerMetrics: {
          names: ['用户体验时间（服务器）'],
          values: [3055.3701],
          units: ['毫秒'],
          severity: '紧急'
        }
      }
    });
    expect(allowed.params).not.toHaveProperty('timeRange');
  });

  test('accepts reference-only input for the composite tool before plugin restoration', () => {
    const definition = tools.get('napm-alert-packet-analysis');
    const validate = new Ajv({ allErrors: true }).compile(definition.parameters);

    expect(validate({
      prompt: '分析告警 GJ-QFH9QC4Z',
      referenceId: 'GJ-QFH9QC4Z'
    })).toBe(true);
  });

  test('keeps numeric compatibility while rejecting incomplete or unsafe composite inputs', () => {
    const definition = tools.get('napm-alert-packet-analysis');
    const validate = new Ajv({ allErrors: true }).compile(definition.parameters);

    expect(validate({
      prompt: '分析告警数据包 eventId=795097 start=1787647440 end=1787647680',
      eventId: '795097',
      start: 1787647440,
      end: 1787647680
    })).toBe(true);
    expect(validate({ prompt: '分析告警 GJ-QFH9QC4Z' })).toBe(false);
    expect(validate({
      prompt: '分析告警 GJ-QFH9QC4Z',
      referenceId: 'not-a-gj-reference'
    })).toBe(false);
    expect(validate({
      prompt: '分析告警 GJ-QFH9QC4Z',
      referenceId: 'GJ-QFH9QC4Z',
      timeRange: { key: 'last1hour' }
    })).toBe(false);
  });

  test('classifies a GJ alert analysis as alert-packet and suppresses leaked final reasoning', async () => {
    const prompt = '分析告警 GJ-QFH9QC4Z';
    const ctx = {
      channelId: 'wecom',
      accountId: 'gj-alert-account',
      conversationId: 'gj-alert-conversation',
      sessionKey: 'gj-alert-session',
      sessionId: 'gj-alert-session',
      runId: 'gj-alert-run'
    };

    expect(plugin.__test__.isAlertPacketAnalysisPrompt(prompt)).toBe(true);
    expect(plugin.__test__.isAlertEventPrompt(prompt)).toBe(true);

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const leakedReasoning = [
      'The guard is intercepting all my secondary tool attempts.',
      'The problem is that the schema validation still demands eventId/start/end.',
      'I should explain this limitation to the user.'
    ].join(' ');
    await expect(hooks.get('message_sending')({
      content: leakedReasoning,
      kind: 'final'
    }, ctx)).resolves.toMatchObject({ cancel: true });

    const writeResult = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: leakedReasoning }]
      }
    }, ctx);
    expect(writeResult?.message?.content?.[0]?.text).toContain('当前告警引用尚未完成数据包分析');
    expect(writeResult?.message?.content?.[0]?.text).not.toContain('The guard is intercepting');
  });

  test('restores a pending packet confirmation when the next turn only says start analysis', async () => {
    const referenceStore = new (require('../plugin/AlertReferenceStore'))({ baseDir });
    referenceStore.put({
      referenceId: 'GJ-C2NT23',
      alert: { eventId: '800183', start: 1787835240, end: 1787835480 },
      packet: {
        window: { start: 1787835240, end: 1787835480 },
        candidates: [{
          candidateId: 'GJ-C2NT23-P1',
          rank: 1,
          ips: ['10.0.0.1', '10.0.0.2'],
          packetWindow: { start: 1787835240, end: 1787835480 },
          packetQuery: {
            mode: 'preview_download_analyze',
            criteria: { ips: ['10.0.0.1', '10.0.0.2'], start: 1787835240, end: 1787835480 }
          }
        }]
      },
      triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2926.1699, unit: '毫秒' }],
      analysis: { profileId: 'server_user_experience_time', profileVersion: 1 }
    });

    const ctx = {
      channelId: 'wecom', accountId: 'confirm-account', conversationId: 'confirm-conversation',
      sessionKey: 'confirm-session', sessionId: 'confirm-session', runId: 'confirm-run-1'
    };
    const firstPrompt = '分析告警 GJ-C2NT23';
    hooks.get('message_received')({ content: firstPrompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt: firstPrompt }, ctx);
    const firstCall = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: { prompt: firstPrompt, referenceId: 'GJ-C2NT23' }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(firstCall.params);
    const firstTurnId = plugin.__test__.getTrustedTurnId(firstCall.params);
    plugin.__test__.rememberSkillResult(firstPrompt, {
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState: 'DOWNLOAD_CONFIRMATION_REQUIRED',
      referenceId: 'GJ-C2NT23',
      eventId: '800183',
      timeRange: { start: 1787835240, end: 1787835480 },
      candidateId: 'GJ-C2NT23-P1',
      triggerMetrics: { names: ['用户体验时间（服务器）'], values: [2926.1699], units: ['毫秒'] },
      packetAnalyses: [{
        rank: 1,
        candidate: { candidateId: 'GJ-C2NT23-P1' },
        ok: false,
        result: {
          ok: false,
          error: { code: 'PACKET_PREVIEW_REQUIRES_CONFIRMATION', message: '下载前需要用户确认。' },
          decision: { next_action: 'CONFIRM_DOWNLOAD' }
        }
      }],
      error: { code: 'DOWNLOAD_CONFIRMATION_REQUIRED', message: '数据包预览完成，下载前需要用户确认。' },
      narrationInput: { schema: 'openclaw_napm_alert_packet_analysis.v1' }
    }, scope, 'napm-alert-packet-analysis', firstTurnId);

    const confirmationPrompt = '开始分析！';
    const nextCtx = { ...ctx, runId: 'confirm-run-2' };
    hooks.get('message_received')({ content: confirmationPrompt }, nextCtx);
    const promptBuild = await hooks.get('before_prompt_build')({ prompt: confirmationPrompt }, nextCtx);
    expect(promptBuild.appendSystemContext).toContain('napm-alert-packet-analysis');

    const guard = plugin.__test__.getGuardState(nextCtx);
    expect(guard).toMatchObject({
      canonicalPrompt: '分析 GJ-C2NT23-P1',
      userPrompt: confirmationPrompt,
      alertPacketContinuationPrompt: true,
      alertPacketPreviewRiskAccepted: true,
      alertPacketReferenceId: 'GJ-C2NT23',
      alertPacketCandidateId: 'GJ-C2NT23-P1'
    });

    const wrongTool = hooks.get('before_tool_call')({
      toolName: 'napm-alert-query',
      params: { prompt: confirmationPrompt }
    }, nextCtx);
    expect(wrongTool).toMatchObject({ block: true });

    const continued = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: { prompt: confirmationPrompt }
    }, nextCtx);
    expect(continued).toMatchObject({
      params: {
        prompt: expect.stringContaining('分析告警数据包 eventId=800183'),
        referenceId: 'GJ-C2NT23',
        candidateId: 'GJ-C2NT23-P1',
        previewRiskAccepted: true,
        eventId: '800183',
        start: 1787835240,
        end: 1787835480
      }
    });
  });

  test('restores a pending candidate selection when the next turn asks to analyze candidates in order', async () => {
    const referenceStore = new (require('../plugin/AlertReferenceStore'))({ baseDir });
    referenceStore.put({
      referenceId: 'GJ-BATCH23',
      alert: { eventId: '800300', start: 1787819820, end: 1787820060 },
      packet: {
        window: { start: 1787819700, end: 1787820180 },
        candidates: [1, 2, 3].map((rank) => ({
          candidateId: `GJ-BATCH23-P${rank}`,
          rank,
          ips: [`10.0.0.${rank}`, `10.0.1.${rank}`],
          packetWindow: { start: 1787819700, end: 1787820180 },
          packetQuery: {
            mode: 'preview_download_analyze',
            criteria: {
              ips: [`10.0.0.${rank}`, `10.0.1.${rank}`],
              start: 1787819700,
              end: 1787820180
            }
          }
        }))
      },
      triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2803.78, unit: '毫秒' }],
      analysis: { profileId: 'server_user_experience_time', profileVersion: 1 }
    });

    const ctx = {
      channelId: 'wecom', accountId: 'batch-account', conversationId: 'batch-conversation',
      sessionKey: 'batch-session', sessionId: 'batch-session', runId: 'batch-run-1'
    };
    const firstPrompt = '分析告警 GJ-BATCH23';
    hooks.get('message_received')({ content: firstPrompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt: firstPrompt }, ctx);
    const firstCall = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: { prompt: firstPrompt, referenceId: 'GJ-BATCH23' }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(firstCall.params);
    const firstTurnId = plugin.__test__.getTrustedTurnId(firstCall.params);
    plugin.__test__.rememberSkillResult(firstPrompt, {
      ok: true,
      workflowType: 'alert_packet_analysis',
      workflowState: 'CANDIDATE_SELECTION_REQUIRED',
      referenceId: 'GJ-BATCH23',
      eventId: '800300',
      timeRange: { start: 1787819700, end: 1787820180 },
      candidateOptions: [
        { candidateId: 'GJ-BATCH23-P1', rank: 1 },
        { candidateId: 'GJ-BATCH23-P2', rank: 2 },
        { candidateId: 'GJ-BATCH23-P3', rank: 3 }
      ],
      packetAnalyses: [],
      triggerMetrics: { names: ['用户体验时间（服务器）'], values: [2803.78], units: ['毫秒'] },
      error: { code: 'CANDIDATE_SELECTION_REQUIRED' },
      narrationInput: { schema: 'openclaw_napm_alert_packet_analysis.v1' }
    }, scope, 'napm-alert-packet-analysis', firstTurnId);

    const nextCtx = { ...ctx, runId: 'batch-run-2' };
    const batchPrompt = '按顺序分析！';
    expect([
      '按顺序分析！',
      '按顺序都进行分析！',
      '依次分析',
      '逐一进行分析',
      '分析所有候选'
    ].every((prompt) => plugin.__test__.isAlertPacketBatchPrompt(prompt, {
      alertPacketReferenceId: 'GJ-BATCH23',
      alertPacketWorkflowState: 'CANDIDATE_SELECTION_REQUIRED'
    }))).toBe(true);
    hooks.get('message_received')({ content: batchPrompt }, nextCtx);
    await hooks.get('before_prompt_build')({ prompt: batchPrompt }, nextCtx);

    const guard = plugin.__test__.getGuardState(nextCtx);
    expect(guard).toMatchObject({
      canonicalPrompt: '分析告警 GJ-BATCH23 按顺序分析全部候选',
      userPrompt: batchPrompt,
      alertPacketContinuationPrompt: true,
      alertPacketPreviewRiskAccepted: false,
      alertPacketAnalyzeAllCandidates: true,
      alertPacketReferenceId: 'GJ-BATCH23'
    });

    const continued = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: { prompt: batchPrompt }
    }, nextCtx);
    expect(continued).toMatchObject({
      params: {
        prompt: expect.stringContaining('分析告警数据包 eventId=800300'),
        referenceId: 'GJ-BATCH23',
        analyzeAllCandidates: true,
        eventId: '800300',
        start: 1787819700,
        end: 1787820180,
        triggerMetrics: {
          names: ['用户体验时间（服务器）'],
          values: [2803.78]
        }
      }
    });
  });

  test('describes referenceId as a supported composite-tool entry point', () => {
    const definition = tools.get('napm-alert-packet-analysis');
    expect(definition.description).toMatch(/GJ-[^ ]*|referenceId/i);
    expect(definition.description).toMatch(/引用|reference/i);
  });

  test('suppresses a tool-call preamble and delivers the captured terminal report once', async () => {
    const prompt = '分析告警数据包 eventId=745506 start=1786341600 end=1786341840';
    const ctx = {
      channelId: 'wecom',
      accountId: 'alert-packet-delivery-account',
      conversationId: 'alert-packet-delivery-conversation',
      sessionKey: 'alert-packet-delivery-session',
      sessionId: 'alert-packet-delivery-session',
      runId: 'alert-packet-delivery-run'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const toolEvent = {
      toolName: 'napm-alert-packet-analysis',
      params: { prompt, eventId: '745506', start: 1786341600, end: 1786341840 }
    };
    const bound = hooks.get('before_tool_call')(toolEvent, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);

    const toolPreamble = "I'll analyze this alert packet using the composite tool for alert+packet analysis.";
    const preambleWriteResult = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: toolPreamble },
          { type: 'toolCall', name: 'napm-alert-packet-analysis', arguments: bound.params }
        ]
      }
    }, ctx);
    expect(preambleWriteResult).toBeUndefined();

    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      workflowType: 'alert_packet_analysis',
      workflowState: 'COMPLETED',
      eventId: '745506',
      timeRange: { start: 1786341600, end: 1786341840 },
      triggerMetrics: {
        names: ['用户体验时间（服务器）'],
        values: [12289],
        units: ['毫秒'],
        severity: '紧急'
      },
      narrationInput: {
        schema: 'openclaw_napm_alert_packet_analysis.v1',
        packetAnalyses: [{ ok: true }]
      }
    }, scope, 'napm-alert-packet-analysis', turnId);

    const finalReport = [
      '告警事件 745506 数据包分析结论',
      '用户体验时间（服务器）达到 12289 毫秒。',
      '数据包证据显示，服务器响应等待是本次用户体验时间升高的主要原因。'
    ].join('\n');
    const finalWriteResult = hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: finalReport }]
      }
    }, ctx);
    expect(finalWriteResult?.message?.content?.[0]?.text).toContain('告警事件 745506 数据包分析结果');
    expect(finalWriteResult?.message?.content?.[0]?.text).toContain('告警触发信息');
    expect(finalWriteResult?.message?.content?.[0]?.text).not.toContain('服务器响应等待是本次用户体验时间升高的主要原因');

    const progressDelivery = await hooks.get('message_sending')({
      content: toolPreamble,
      kind: 'final',
      metadata: { isFinal: true }
    }, ctx);
    const terminalDelivery = await hooks.get('message_sending')({
      content: finalReport,
      kind: 'final',
      metadata: { isFinal: true }
    }, ctx);
    const duplicateFinal = await hooks.get('message_sending')({
      content: finalReport,
      kind: 'final',
      metadata: { isFinal: true }
    }, ctx);

    expect(progressDelivery).toEqual({ cancel: true });
    expect(terminalDelivery?.content).toContain('告警事件 745506 数据包分析结果');
    expect(terminalDelivery?.content).toContain('告警触发信息');
    expect(terminalDelivery?.content).not.toContain('服务器响应等待是本次用户体验时间升高的主要原因');
    expect(terminalDelivery.content).not.toContain("I'll analyze");
    expect(duplicateFinal).toEqual({ cancel: true });
  });

  test('builds a deterministic final reply when no model final was persisted', async () => {
    const prompt = '分析告警数据包 eventId=745506 start=1786341600 end=1786341840';
    const ctx = {
      channelId: 'wecom', accountId: 'fallback-account', conversationId: 'fallback-conversation',
      sessionKey: 'fallback-session', sessionId: 'fallback-session', runId: 'fallback-run'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const bound = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: { prompt, eventId: '745506', start: 1786341600, end: 1786341840 }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState: 'PARTIAL_PACKET_ANALYSIS',
      eventId: '745506',
      timeRange: { start: 1786341600, end: 1786341840 },
      triggerMetrics: {
        names: ['用户体验时间（服务器）'], values: [12289], units: ['毫秒'], severity: '紧急'
      },
      alert: {
        details: [{ id: 745506, name: '应用性能下降' }],
        packetHandoff: { candidates: [{ rank: 1, ipPair: '10.0.0.10 -> 10.0.0.20' }] }
      },
      packetAnalyses: [
        { rank: 1, ok: true, result: { summary: { highlights: ['发现 TCP 重传率升高。'] } } },
        { rank: 2, ok: false, error: { message: '数据包不可见' } }
      ],
      error: { code: 'PARTIAL_PACKET_ANALYSIS', message: '部分数据包候选分析失败，已保留成功结果。' },
      narrationInput: { schema: 'openclaw_napm_alert_packet_analysis.v1' }
    }, scope, 'napm-alert-packet-analysis', turnId);

    const outgoing = await hooks.get('message_sending')({
      content: "I'll analyze this alert packet using the composite tool for alert+packet analysis."
    }, ctx);

    expect(outgoing?.content).toContain('告警事件 745506');
    expect(outgoing?.content).toContain('12289');
    expect(outgoing?.content).toContain('PARTIAL_PACKET_ANALYSIS');
    expect(outgoing?.content).toContain('专项观察：发现 TCP 重传率升高。');
    expect(outgoing?.content).not.toContain('narrationInput');
    expect(outgoing?.content).not.toContain('Password=');
  });

  test('does not deliver model planning text when reference packet analysis fails', async () => {
    const prompt = '分析告警 GJ-DTWFTMGF';
    const ctx = {
      channelId: 'wecom', accountId: 'failed-reference-account', conversationId: 'failed-reference-conversation',
      sessionKey: 'failed-reference-session', sessionId: 'failed-reference-session', runId: 'failed-reference-run'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const bound = hooks.get('before_tool_call')({
      toolName: 'napm-alert-packet-analysis',
      params: { prompt, referenceId: 'GJ-DTWFTMGF' }
    }, ctx);
    const scope = plugin.__test__.getTrustedConversationKey(bound.params);
    const turnId = plugin.__test__.getTrustedTurnId(bound.params);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState: 'PACKET_ANALYSIS_FAILED',
      referenceId: 'GJ-DTWFTMGF',
      eventId: '800086',
      timeRange: { start: 1787803920, end: 1787804160 },
      triggerMetrics: {
        names: ['用户体验时间（服务器）'], values: [2808.1201], units: ['毫秒'], severity: '重大',
        condition: '如果 用户体验时间（服务器） > 3000.0 则为 Critical 否则 如果 用户体验时间（服务器） > 2000.0 则为 Major'
      },
      packetAnalyses: [{
        rank: 1,
        candidate: { ipPair: '101.254.114.237 -> 101.254.114.238' },
        ok: false,
        error: { message: '数据包分析接口未返回有效结果。' }
      }],
      error: { code: 'PACKET_ANALYSIS_FAILED', message: '数据包候选分析均未成功。' },
      narrationInput: { schema: 'openclaw_napm_alert_packet_analysis.v1' }
    }, scope, 'napm-alert-packet-analysis', turnId);

    const modelPlanningText = [
      "The packet analysis for this alert reference returned no successful results. Let me check if there's additional context I can gather about this alert.",
      'The result indicates that the packet candidate analysis for alert GJ-DTWFTMGF did not succeed. Let me provide the summary to the user based on what the tool returned.',
      '**告警 GJ-DTWFTMGF 分析结果：数据包候选分析未成功。**',
      '如需进一步排查，可尝试：直接提供该告警对应的 eventId，或确认是否为 linkType=2 告警。'
    ].join('\n\n');

    const writeResult = hooks.get('before_message_write')({
      message: { role: 'assistant', content: [{ type: 'text', text: modelPlanningText }] }
    }, ctx);
    const writtenText = writeResult?.message?.content?.[0]?.text || '';
    expect(writtenText).toContain('告警引用 GJ-DTWFTMGF 数据包分析结果');
    expect(writtenText).toContain('用户体验时间（服务器）');
    expect(writtenText).not.toContain('The packet analysis for this alert reference');
    expect(writtenText).not.toContain('直接提供该告警对应的 eventId');

    const outgoing = await hooks.get('message_sending')({
      content: modelPlanningText,
      kind: 'final',
      metadata: { isFinal: true }
    }, ctx);
    expect(outgoing?.content).toContain('告警引用 GJ-DTWFTMGF 数据包分析结果');
    expect(outgoing?.content).toContain('PACKET_ANALYSIS_FAILED');
    expect(outgoing?.content).not.toContain('The result indicates');
    expect(outgoing?.content).not.toContain('linkType=2');
  });

  test('/new clears the prepared and claimed final state for the next alert packet turn', async () => {
    const prompt = '分析告警数据包 eventId=745506 start=1786341600 end=1786341840';
    const ctx = {
      channelId: 'wecom', accountId: 'new-account', conversationId: 'new-conversation',
      sessionKey: 'new-session', sessionId: 'new-session', runId: 'new-run'
    };
    const rememberCompletedResult = () => {
      const bound = hooks.get('before_tool_call')({
        toolName: 'napm-alert-packet-analysis',
        params: { prompt, eventId: '745506', start: 1786341600, end: 1786341840 }
      }, ctx);
      plugin.__test__.rememberSkillResult(prompt, {
        ok: true,
        workflowType: 'alert_packet_analysis',
        workflowState: 'COMPLETED',
        eventId: '745506',
        timeRange: { start: 1786341600, end: 1786341840 },
        packetAnalyses: [{ rank: 1, ok: true, result: { summary: { highlights: ['分析完成。'] } } }],
        narrationInput: { schema: 'openclaw_napm_alert_packet_analysis.v1' }
      }, plugin.__test__.getTrustedConversationKey(bound.params), 'napm-alert-packet-analysis', plugin.__test__.getTrustedTurnId(bound.params));
    };

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    rememberCompletedResult();
    const first = await hooks.get('message_sending')({ content: 'tool preamble' }, ctx);
    const duplicate = await hooks.get('message_sending')({ content: 'duplicate' }, ctx);
    expect(first?.content).toContain('告警事件 745506');
    expect(duplicate).toEqual({ cancel: true });

    hooks.get('message_received')({ content: '/new' }, ctx);
    await expect(hooks.get('message_sending')({ content: 'New session started.' }, ctx)).resolves.toBeUndefined();
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    rememberCompletedResult();

    const nextTurn = await hooks.get('message_sending')({ content: 'tool preamble' }, ctx);
    expect(nextTurn?.content).toContain('告警事件 745506');
  });

  test('leaves ordinary alert queries and ordinary packet analysis on their existing tools', async () => {
    const alertCtx = {
      channelId: 'wecom', accountId: 'ordinary-alert', conversationId: 'ordinary-alert',
      sessionKey: 'ordinary-alert', sessionId: 'ordinary-alert', runId: 'ordinary-alert'
    };
    const alertPrompt = '最近一小时的告警情况';
    hooks.get('message_received')({ content: alertPrompt }, alertCtx);
    await hooks.get('before_prompt_build')({ prompt: alertPrompt }, alertCtx);
    const alertCall = hooks.get('before_tool_call')({
      toolName: 'napm-alert-query',
      params: {
        mode: 'summary',
        criteria: { timeRange: { key: 'last1hour' } }
      }
    }, alertCtx);
    expect(alertCall?.block).not.toBe(true);
    expect(alertCall?.params).toMatchObject({ prompt: alertPrompt, mode: 'summary' });

    const packetCtx = {
      channelId: 'wecom', accountId: 'ordinary-packet', conversationId: 'ordinary-packet',
      sessionKey: 'ordinary-packet', sessionId: 'ordinary-packet', runId: 'ordinary-packet'
    };
    const packetPrompt = '分析 101.254.114.237 最近五分钟的数据包';
    hooks.get('message_received')({ content: packetPrompt }, packetCtx);
    await hooks.get('before_prompt_build')({ prompt: packetPrompt }, packetCtx);
    const packetCall = hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      params: {
        prompt: packetPrompt,
        mode: 'preview_download_analyze',
        criteria: { ips: ['101.254.114.237'], start: 1786327200, end: 1786327500 }
      }
    }, packetCtx);
    expect(packetCall?.block).not.toBe(true);
  });
});
