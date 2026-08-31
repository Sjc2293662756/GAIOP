'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'napm-openclaw-plugin.remote.js'));
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-remote-turn-smoke-'));

process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');

function createContext(suffix) {
  return {
    channelId: 'wecom',
    accountId: `smoke-account-${suffix}`,
    conversationId: `smoke-conversation-${suffix}`,
    sessionKey: `smoke-session-${suffix}`,
    sessionId: `smoke-session-${suffix}`,
    runId: `smoke-run-${suffix}`
  };
}

async function main() {
  const plugin = require(pluginPath);
  const hooks = new Map();
  const registeredTools = new Map();

  plugin.register({
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    registerTool(definition) {
      registeredTools.set(definition.name, definition);
    },
    registerCommand() {},
    registerHook(name, handler) {
      const names = Array.isArray(name) ? name : [name];
      names.forEach((eventName) => hooks.set(eventName, handler));
    }
  });

  async function startTurn(ctx, prompt, promptBuildText = prompt) {
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt: promptBuildText }, ctx);
  }

  const nativeCommandCtx = createContext('native-command');
  hooks.get('message_received')({ content: '/new' }, nativeCommandCtx);
  assert.equal(
    hooks.get('before_prompt_build')({ prompt: '/new' }, nativeCommandCtx),
    undefined,
    'native commands must bypass prompt routing'
  );
  assert.equal(
    hooks.get('before_agent_start')({ prompt: '/new' }, nativeCommandCtx),
    undefined,
    'native commands must bypass agent routing'
  );
  assert.equal(
    hooks.get('before_tool_call')({ toolName: 'exec', params: {} }, nativeCommandCtx),
    undefined,
    'native commands must bypass tool guards'
  );
  assert.equal(
    await hooks.get('message_sending')({ content: '✅ New session started.' }, nativeCommandCtx),
    undefined,
    'native command confirmations must not be rewritten while sending'
  );
  assert.equal(
    hooks.get('before_message_write')({
      message: { role: 'assistant', content: '✅ New session started.' }
    }, nativeCommandCtx),
    undefined,
    'native command confirmations must not be rewritten before transcript write'
  );

  const resetStateCtx = createContext('native-reset-state');
  const resetStatePrompt = '现在系统情况怎么样？';
  hooks.get('message_received')({ content: resetStatePrompt }, resetStateCtx);
  const trustedToolEvent = {
    toolName: 'napm-summary',
    params: { prompt: resetStatePrompt }
  };
  const trustedToolResult = hooks.get('before_tool_call')(trustedToolEvent, resetStateCtx);
  const trustedParams = trustedToolResult?.params || trustedToolEvent.params;
  const resetScope = plugin.__test__.getTrustedConversationKey(trustedParams);
  const resetTurnId = plugin.__test__.getTrustedTurnId(trustedParams);
  plugin.__test__.rememberSkillResult(
    resetStatePrompt,
    { ok: true, summary: { overallStatus: 'warning' } },
    resetScope,
    'napm-summary',
    resetTurnId
  );
  plugin.__test__.rememberReportExportResult(
    resetStatePrompt,
    { ok: true, filePath: '/tmp/old-report.docx' },
    resetScope
  );
  assert.equal(
    plugin.__test__.dedupeOutgoingMediaForConversation({ mediaUrl: 'https://example.test/old-report.docx' }, resetStateCtx)?.fresh.length,
    1
  );
  hooks.get('message_received')({ content: '/reset' }, resetStateCtx);
  assert.equal(plugin.__test__.getLatestRememberedSkillRecord(resetScope), null, 'reset must clear skill results');
  assert.equal(plugin.__test__.isFreshReportExportResult(resetScope), false, 'reset must clear report results');
  assert.equal(plugin.__test__.getTrustedConversationKey(trustedParams), '', 'reset must revoke trusted traces');
  assert.equal(
    plugin.__test__.dedupeOutgoingMediaForConversation({ mediaUrl: 'https://example.test/old-report.docx' }, resetStateCtx)?.fresh.length,
    1,
    'reset must clear media dedupe state'
  );

  const sharedAgentFirstCtx = { agentId: 'main', runId: 'native-shared-agent-first' };
  const sharedAgentSecondCtx = { agentId: 'main', runId: 'native-shared-agent-second' };
  hooks.get('message_received')({ content: '今天天气怎么样？' }, sharedAgentFirstCtx);
  assert.deepEqual(
    await hooks.get('message_sending')({ content: 'unrelated OpenClaw output' }, sharedAgentSecondCtx),
    { cancel: true },
    'identity without a conversation scope must fail outbound delivery closed'
  );

  const validationCtx = createContext('blocked-validation');
  const validationPrompt = '过去 24 小时的吞吐量趋势如何？';
  await startTurn(validationCtx, validationPrompt, [
    'Conversation info (untrusted metadata):',
    '{"message_id":"remote-smoke-validation"}',
    '',
    validationPrompt
  ].join('\n'));
  const blocked = hooks.get('before_tool_call')({
    toolName: 'napm-skill-query',
    params: {
      prompt: validationPrompt,
      resolvedQuery: {
        service: 'timeseries',
        queryModeKey: 'timeseries'
      }
    }
  }, validationCtx);
  assert.equal(blocked?.block, true, 'invalid service must be blocked before execution');
  const validationSendingResult = await hooks.get('message_sending')({
    content: blocked.blockReason,
    metadata: { isFinal: true }
  }, validationCtx);
  assert.match(
    validationSendingResult?.content || '',
    /查询参数未构造完整/,
    'construction-phase validation result must use the safe typed failure reply'
  );
  assert.doesNotMatch(
    validationSendingResult?.content || '',
    /UPSTREAM_RESOLVED_QUERY_INVALID|requiredFields|resolvedQuerySummary/,
    'construction-phase validation result must not expose the internal boundary contract'
  );

  const packetLossCtx = createContext('packet-loss-ranking');
  const packetLossPrompt = 'Show the top 10 IP addresses with the highest packet loss in the last hour.';
  await startTurn(packetLossCtx, packetLossPrompt);
  const packetLossQueryResult = hooks.get('before_tool_call')({
    toolName: 'napm-skill-query',
    params: {
      prompt: packetLossPrompt,
      resolvedQuery: {
        service: 'topValues',
        queryModeKey: 'topn',
        metric: 'PLI',
        topMetric: 'PLI',
        groups: [{ type: 'IPAddress', argument: null }],
        start: 1786070400,
        end: 1786074000,
        topCount: 10,
        sortOrder: 'desc',
        userRequirement: packetLossPrompt
      }
    }
  }, packetLossCtx);
  assert.notEqual(packetLossQueryResult?.block, true, 'packet-loss rankings must stay in metric query routing');

  const packetCaptureCtx = createContext('packet-capture');
  const packetCapturePrompt = 'Capture packets for 10.0.0.1 and analyze the pcap.';
  await startTurn(packetCaptureCtx, packetCapturePrompt);
  const packetCaptureQueryResult = hooks.get('before_tool_call')({
    toolName: 'napm-skill-query',
    params: { prompt: packetCapturePrompt }
  }, packetCaptureCtx);
  assert.equal(packetCaptureQueryResult?.block, true, 'packet capture must not enter metric query routing');
  assert.match(packetCaptureQueryResult?.blockReason || '', /napm-packet-analysis/);

  const toolCallCtx = createContext('tool-call');
  await startTurn(toolCallCtx, '给我业务最近七天的综述报告！');
  const toolCallMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: '先执行综述查询。' },
      {
        type: 'toolCall',
        id: 'remote-summary-call-1',
        name: 'napm-summary',
        arguments: { prompt: '给我业务最近七天的综述报告！' }
      }
    ]
  };
  const writeResult = await hooks.get('before_message_write')({ message: toolCallMessage }, toolCallCtx);
  assert.equal(writeResult, undefined, 'assistant toolCall messages must remain unchanged');
  assert.equal(toolCallMessage.content[1].type, 'toolCall');

  const reportDispatchCtx = createContext('report-reply-dispatch');
  const reportDispatchPrompt = '给我应用最近七天的综述报告！';
  await startTurn(reportDispatchCtx, reportDispatchPrompt);
  const reportDispatchToolEvent = {
    toolName: 'napm-report-export',
    params: { prompt: reportDispatchPrompt }
  };
  const boundReportDispatchCall = hooks.get('before_tool_call')(reportDispatchToolEvent, reportDispatchCtx);
  const reportDispatchScope = plugin.__test__.getTrustedConversationKey(boundReportDispatchCall.params);
  const reportDispatchTurnId = plugin.__test__.getTrustedTurnId(boundReportDispatchCall.params);
  plugin.__test__.rememberReportExportResult(reportDispatchPrompt, {
    ok: true,
    title: 'NAPM 应用综述报告',
    format: 'docx',
    downloadUrl: '/reports/napm-report-dispatch.docx',
    filePath: '/tmp/napm-report-dispatch.docx'
  }, reportDispatchScope, reportDispatchTurnId);
  const dispatchedReportPayloads = [];
  const reportDispatchResult = await hooks.get('reply_dispatch')({
    ctx: {
      SessionKey: reportDispatchCtx.sessionKey,
      Surface: reportDispatchCtx.channelId,
      AccountId: reportDispatchCtx.accountId,
      From: reportDispatchCtx.conversationId,
      Body: reportDispatchPrompt,
      MessageSid: 'remote-report-dispatch-message'
    },
    runId: reportDispatchCtx.runId,
    sessionKey: reportDispatchCtx.sessionKey,
    suppressUserDelivery: false,
    sendPolicy: 'allow'
  }, {
    dispatcher: {
      sendFinalReply(payload) {
        dispatchedReportPayloads.push(payload);
        return true;
      },
      getQueuedCounts() {
        return { tool: 0, block: 0, final: dispatchedReportPayloads.length };
      }
    },
    async onReplyStart() {},
    recordProcessed() {},
    markIdle() {}
  });
  assert.equal(reportDispatchResult?.handled, true, 'report delivery must be owned by reply_dispatch');
  assert.equal(reportDispatchResult?.queuedFinal, true, 'report reply must be queued as final');
  assert.equal(dispatchedReportPayloads.length, 1, 'report reply must be queued once');
  assert.deepEqual(
    dispatchedReportPayloads[0]?.mediaUrls,
    ['/tmp/napm-report-dispatch.docx'],
    'native report reply payload must carry Word media'
  );

  const previewCtx = createContext('preview');
  await startTurn(previewCtx, '现在系统情况怎么样？');
  const previewResult = await hooks.get('message_sending')({
    content: '我先直接调用底层 API 重试一次，再给出系统状态。',
    metadata: { streaming: true, isFinal: false, phase: 'partial' }
  }, previewCtx);
  assert.deepEqual(previewResult, { cancel: true }, 'streaming previews must be cancelled before rewriting');

  const fallbackCtx = createContext('fallback');
  await startTurn(fallbackCtx, '现在系统情况怎么样？');
  const fallbackEvent = {
    content: '尝试直接调用底层 API 重试，但还没有拿到 skill 结果。',
    metadata: { isFinal: true }
  };
  const firstFallback = await hooks.get('message_sending')(fallbackEvent, fallbackCtx);
  const duplicateFallback = await hooks.get('message_sending')(fallbackEvent, fallbackCtx);
  assert.match(firstFallback?.content || '', /本轮未拿到有效 skill 结果/);
  assert.deepEqual(duplicateFallback, { cancel: true }, 'a turn may deliver only one generic fallback');

  const alertPacketCtx = createContext('alert-packet-final-delivery');
  const alertPacketWriteCtx = {
    sessionKey: alertPacketCtx.sessionKey,
    sessionId: alertPacketCtx.sessionId,
    runId: alertPacketCtx.runId
  };
  const alertPacketDeliveryCtx = {
    channelId: alertPacketCtx.channelId,
    accountId: alertPacketCtx.accountId,
    conversationId: alertPacketCtx.conversationId,
    runId: alertPacketCtx.runId
  };
  const alertPacketPrompt = '分析告警数据包 eventId=745506 start=1786341600 end=1786341840';
  await startTurn(alertPacketCtx, alertPacketPrompt);
  const alertPacketToolEvent = {
    toolName: 'napm-alert-packet-analysis',
    params: {
      prompt: alertPacketPrompt,
      eventId: '745506',
      start: 1786341600,
      end: 1786341840
    }
  };
  const boundAlertPacketCall = hooks.get('before_tool_call')(alertPacketToolEvent, alertPacketCtx);
  const alertPacketScope = plugin.__test__.getTrustedConversationKey(boundAlertPacketCall.params);
  const alertPacketTurnId = plugin.__test__.getTrustedTurnId(boundAlertPacketCall.params);
  const alertPacketPreamble = "I'll analyze this alert packet using the composite tool for alert+packet analysis.";
  assert.equal(
    hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: alertPacketPreamble },
          { type: 'toolCall', name: 'napm-alert-packet-analysis', arguments: boundAlertPacketCall.params }
        ]
      }
    }, alertPacketWriteCtx),
    undefined,
    'tool-call preamble must not be prepared as final content'
  );
  plugin.__test__.rememberSkillResult(alertPacketPrompt, {
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
    packetAnalyses: [{
      rank: 1,
      ok: true,
      candidate: { ipPair: '10.0.0.10 -> 10.0.0.20' },
      result: { summary: { highlights: ['发现 TCP 重传率升高。'] } }
    }],
    narrationInput: { schema: 'openclaw_napm_alert_packet_analysis.v1' }
  }, alertPacketScope, 'napm-alert-packet-analysis', alertPacketTurnId);
  const alertPacketFinal = [
    '告警事件 745506 数据包分析结论',
    '用户体验时间（服务器）达到 12289 毫秒。',
    '数据包证据显示，服务器响应等待是本次用户体验时间升高的主要原因。'
  ].join('\n');
  const alertPacketWritten = hooks.get('before_message_write')({
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: alertPacketFinal }] }
    }, alertPacketWriteCtx);
  const alertPacketCanonicalFinal = alertPacketWritten?.message?.content?.[0]?.text || '';
  assert.match(
    alertPacketCanonicalFinal,
    /告警事件 745506 数据包分析结果/,
    'the transcript must persist the deterministic alert packet final'
  );
  assert.deepEqual(
    await hooks.get('message_sending')({ content: alertPacketPreamble, metadata: { isFinal: true } }, alertPacketDeliveryCtx),
    { cancel: true },
    'the outgoing tool progress payload must be suppressed'
  );
  assert.deepEqual(
    await hooks.get('message_sending')({ content: alertPacketFinal, metadata: { isFinal: true } }, alertPacketDeliveryCtx),
    { content: alertPacketCanonicalFinal },
    'the terminal payload must deliver the prepared model final'
  );
  assert.deepEqual(
    await hooks.get('message_sending')({ content: alertPacketFinal, metadata: { isFinal: true } }, alertPacketDeliveryCtx),
    { cancel: true },
    'duplicate alert packet finals must be cancelled'
  );

  const splitIdentityPrompt = '最近 7 天应用流量趋势如何？';
  const splitIdentityMessageId = 'remote-smoke-split-message';
  const splitIdentityRunId = 'remote-smoke-split-run';
  const splitIdentitySessionKey = 'remote-smoke-split-session';
  const splitIdentityReceivedCtx = {
    channelId: 'wecom',
    sessionKey: splitIdentitySessionKey,
    messageId: splitIdentityMessageId
  };
  const splitIdentityAgentCtx = {
    agentId: 'main',
    sessionKey: splitIdentitySessionKey,
    sessionId: 'remote-smoke-split-session-id',
    runId: splitIdentityRunId
  };
  const splitIdentityTranscriptCtx = {
    agentId: 'main',
    sessionKey: splitIdentitySessionKey
  };
  const splitIdentitySendingCtx = {
    channelId: 'wecom',
    sessionKey: splitIdentitySessionKey,
    messageId: splitIdentityMessageId
  };
  const splitIdentityPromptBuildText = [
    'Conversation info (untrusted metadata):',
    '```json',
    JSON.stringify({ message_id: splitIdentityMessageId, sender_id: 'remote-smoke' }),
    '```',
    '',
    splitIdentityPrompt
  ].join('\n');
  hooks.get('message_received')(
    { content: splitIdentityPrompt, messageId: splitIdentityMessageId },
    splitIdentityReceivedCtx
  );
  await hooks.get('before_prompt_build')(
    { prompt: splitIdentityPromptBuildText, messages: [] },
    splitIdentityAgentCtx
  );
  await hooks.get('before_agent_start')(
    { prompt: splitIdentityPromptBuildText, messages: [] },
    splitIdentityAgentCtx
  );
  const splitIdentityScope = plugin.__test__.getConversationKey(splitIdentityAgentCtx);
  const splitIdentityMessageTurnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(
    splitIdentityScope,
    splitIdentityMessageId
  );
  const splitIdentityRunTurnId = plugin.__test__.queryTurnCoordinator.resolveTurnId(
    splitIdentityScope,
    splitIdentityRunId
  );
  assert.equal(
    splitIdentityRunTurnId,
    splitIdentityMessageTurnId,
    'messageId and runId must resolve to one authoritative Query Turn'
  );
  const splitIdentityToolEvent = {
    toolName: 'napm-skill-query',
    toolCallId: 'remote-smoke-split-call',
    params: {
      prompt: splitIdentityPrompt,
      queryDraft: {
        service: 'timeValues',
        queryModeKey: 'timeseries',
        groups: [{ type: 'DefinedApp' }],
        metrics: ['TPIO'],
        metric: 'TPIO',
        granularity: 3600,
        timeRange: { key: 'last7days' }
      }
    }
  };
  const splitIdentityBound = hooks.get('before_tool_call')(
    splitIdentityToolEvent,
    splitIdentityAgentCtx
  );
  const splitIdentityToolResult = await registeredTools.get('napm-skill-query').execute(
    splitIdentityToolEvent.toolCallId,
    splitIdentityBound?.params || splitIdentityToolEvent.params
  );
  const splitIdentityFinal = splitIdentityToolResult?.details?.displayText || '';
  assert.match(splitIdentityFinal, /请告诉我要查询哪个应用/);
  assert.equal(
    hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: splitIdentityFinal }]
      }
    }, splitIdentityTranscriptCtx),
    undefined,
    'identityless transcript hook must not replace the authoritative clarification'
  );
  assert.deepEqual(
    await hooks.get('message_sending')(
      { content: splitIdentityFinal },
      splitIdentitySendingCtx
    ),
    { content: splitIdentityFinal },
    'message-bound delivery must use the run-bound clarification'
  );

  const queryTool = registeredTools.get('napm-skill-query');
  const resolvedQuerySchema = queryTool?.parameters?.properties?.resolvedQuery;
  const serviceEnum = resolvedQuerySchema?.properties?.service?.enum || [];
  for (const service of [
    'topValues',
    'averageValues',
    'timeValues',
    'overview',
    'groups',
    'metrics',
    'drilldownCatalog',
    'topValues_multi_protocol'
  ]) {
    assert.ok(serviceEnum.includes(service), `query schema must include service=${service}`);
  }
  for (const field of ['granularity', 'overviewScene', 'protocolQueries', 'filters', 'executionOptions']) {
    assert.ok(resolvedQuerySchema.properties[field], `query schema must include ${field}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
      pluginPath,
      checks: [
      'native_command_hooks_bypassed',
      'native_reset_state_cleared',
      'shared_agent_guard_isolated',
      'construction_validation_result_safely_rendered',
      'packet_loss_metric_routed_to_query',
      'packet_capture_routed_to_analysis',
      'tool_call_preserved',
      'report_reply_dispatched_with_word_media',
      'streaming_preview_cancelled',
      'fallback_deduplicated',
      'split_hook_scope_progress_suppressed_terminal_delivered_once',
      'split_message_and_run_identity_delivers_clarification',
      'spec_derived_schema_complete'
    ]
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
