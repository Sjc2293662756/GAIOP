const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeReportData(title) {
  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'quick_report',
    title,
    sections: []
  };
}

function makeContext(conversationId) {
  return {
    channelId: 'wecom',
    accountId: 'default',
    conversationId,
    runId: `run-${conversationId}`,
    sessionId: `session-${conversationId}`
  };
}

function createHarness(plugin) {
  const hooks = new Map();
  plugin.register({
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    registerTool() {},
    registerCommand() {},
    registerHook(name, handler) {
      hooks.set(name, handler);
    }
  });
  return hooks;
}

describe('napm-openclaw-plugin conversation isolation', () => {
  const originalReportSourceDir = process.env.NAPM_REPORT_SOURCE_DIR;
  const originalTrustedContextDir = process.env.NAPM_TRUSTED_CONTEXT_DIR;
  const originalAuditLogPath = process.env.NAPM_AUDIT_LOG_PATH;
  let plugin;
  let hooks;
  let stateDir;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-conversation-isolation-'));
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(stateDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(stateDir, 'trusted-contexts');
    process.env.NAPM_AUDIT_LOG_PATH = path.join(stateDir, 'audit.log');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
    hooks = createHarness(plugin);
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  afterAll(() => {
    restoreEnv('NAPM_REPORT_SOURCE_DIR', originalReportSourceDir);
    restoreEnv('NAPM_TRUSTED_CONTEXT_DIR', originalTrustedContextDir);
    restoreEnv('NAPM_AUDIT_LOG_PATH', originalAuditLogPath);
  });

  function bindScope(conversationId, toolCallId, traceId = '') {
    const event = {
      toolName: 'napm-report-export',
      toolCallId,
      params: {
        prompt: 'export the previous result',
        traceId
      }
    };
    hooks.get('before_tool_call')(event, makeContext(conversationId));
    return event.params;
  }

  test('injects a trusted trace and ignores a caller-provided trace', () => {
    const params = bindScope('conversation-a', 'call-a', 'caller-controlled-trace');

    expect(params.traceId).not.toBe('caller-controlled-trace');
    expect(plugin.__test__.getTrustedConversationKey(params)).toBe(
      plugin.__test__.getConversationKey(makeContext('conversation-a'))
    );
  });

  test('does not allow conversation B to export conversation A remembered reportData', () => {
    const paramsA = bindScope('conversation-a', 'call-a');
    const paramsB = bindScope('conversation-b', 'call-b');
    const scopeA = plugin.__test__.getTrustedConversationKey(paramsA);

    plugin.__test__.rememberSkillResult('query for A', {
      ok: true,
      reportData: makeReportData('Report for A')
    }, scopeA);

    const inputA = plugin.__test__.buildReportInputForExport(paramsA);
    const inputB = plugin.__test__.buildReportInputForExport(paramsB);

    expect(inputA.ok).toBe(true);
    expect(inputA.reportData.title).toBe('Report for A');
    expect(inputB).toMatchObject({
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND'
    });
  });

  test('does not create a remembered-result scope for direct calls without hook context', () => {
    plugin.__test__.rememberSkillResult('unsafe direct call', {
      ok: true,
      reportData: makeReportData('Unsafe report')
    }, '');

    expect(plugin.__test__.buildReportInputForExport({ prompt: 'export' })).toMatchObject({
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND'
    });
  });

  test('does not rewrite conversation B from a remembered alert in conversation A', async () => {
    const ctxA = makeContext('conversation-a');
    const ctxB = makeContext('conversation-b');
    const paramsA = bindScope('conversation-a', 'alert-call-a');
    const promptB = '\u6700\u8fd1\u4e00\u5c0f\u65f6\u6709\u54ea\u4e9b\u544a\u8b66\uff1f';
    const scopeA = plugin.__test__.getTrustedConversationKey(paramsA);

    plugin.__test__.rememberSkillResult(promptB, {
      ok: true,
      service: 'alertsSummary',
      narrationInput: { schema: 'openclaw_napm_alert.v1' },
      summary: { total: 1, bySeverity: { critical: 1, major: 0, minor: 0 } },
      events: [{ group: 'only-in-conversation-a', severity: 4, name: 'alert-a' }]
    }, scopeA);

    hooks.get('message_received')({ content: promptB }, ctxB);
    const result = await hooks.get('message_sending')({ content: 'No verified alert result is available.' }, ctxB);

    expect(result.content).not.toContain('only-in-conversation-a');
    expect(result.content).toContain('napm-alert-query');
    expect(plugin.__test__.getConversationKey(ctxA)).not.toBe(plugin.__test__.getConversationKey(ctxB));
  });
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
