'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('NAPM plugin OpenClaw native-command isolation', () => {
  let baseDir;
  let plugin;
  let hooks;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-native-command-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
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
      runId: `run-${suffix}`,
      agentId: 'main'
    };
  }

  function receive(ctx, content) {
    return hooks.get('message_received')({ content }, ctx);
  }

  test('parses the OpenClaw command namespace without treating paths as commands', () => {
    expect(plugin.__test__.parseOpenClawControlCommand('/new')).toMatchObject({
      name: 'new',
      resetsSession: true
    });
    expect(plugin.__test__.parseOpenClawControlCommand('/reset@ops_bot')).toMatchObject({
      name: 'reset',
      resetsSession: true
    });
    expect(plugin.__test__.parseOpenClawControlCommand('/model gpt-5')).toMatchObject({
      name: 'model',
      resetsSession: false
    });
    expect(plugin.__test__.parseOpenClawControlCommand('/var/log/openclaw')).toBeNull();
    expect(plugin.__test__.parseOpenClawControlCommand('现在系统情况怎么样？')).toBeNull();
  });

  test.each([
    ['/new', '✅ New session started.'],
    ['/reset', '✅ Session reset.'],
    ['/help', 'OpenClaw help'],
    ['/status', 'OpenClaw status: connected'],
    ['/model gpt-5', 'Model switched to gpt-5'],
    ['/command-added-later', 'Unknown command: /command-added-later']
  ])('preserves native output for %s in both outgoing hooks', async (command, confirmation) => {
    const ctx = createCtx(command.replace(/\W+/g, '-'));
    receive(ctx, command);

    await expect(hooks.get('message_sending')({ content: confirmation }, ctx)).resolves.toBeUndefined();
    expect(hooks.get('before_message_write')({
      message: { role: 'assistant', content: confirmation }
    }, ctx)).toBeUndefined();
  });

  test('bypasses prompt, agent and tool guards for a native-command turn', async () => {
    const ctx = createCtx('all-hooks');
    receive(ctx, '/status');

    expect(hooks.get('before_prompt_build')({ prompt: '/status' }, ctx)).toBeUndefined();
    expect(hooks.get('before_agent_start')({ prompt: '/status' }, ctx)).toBeUndefined();
    expect(hooks.get('before_tool_call')({
      toolName: 'exec',
      params: { command: 'openclaw status' }
    }, ctx)).toBeUndefined();
  });

  test('expires a native-command bypass after 30 seconds', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-07T13:00:00+08:00'));
    try {
      const ctx = createCtx('ttl');
      receive(ctx, '/help');
      expect(plugin.__test__.isNativeCommandTurn(ctx)).toBe(true);

      jest.advanceTimersByTime(30_001);

      expect(plugin.__test__.isNativeCommandTurn(ctx)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each(['/new', '/reset'])('%s clears query, report, trusted trace and media state for its scope', (command) => {
    const ctx = createCtx(command.slice(1));
    const prompt = '给我最近七天的系统综述报告';
    receive(ctx, prompt);

    const toolEvent = {
      toolName: 'napm-summary',
      params: { prompt }
    };
    const toolResult = hooks.get('before_tool_call')(toolEvent, ctx);
    const trustedParams = toolResult?.params || toolEvent.params;
    const scope = plugin.__test__.getTrustedConversationKey(trustedParams);
    const turnId = plugin.__test__.getTrustedTurnId(trustedParams);
    expect(scope).toBe(plugin.__test__.getConversationKey(ctx));

    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      summary: { overallStatus: 'warning' }
    }, scope, 'napm-summary', turnId);
    plugin.__test__.rememberReportExportResult(prompt, {
      ok: true,
      filePath: '/tmp/old-report.docx'
    }, scope);
    expect(plugin.__test__.dedupeOutgoingMediaForConversation({
      mediaUrl: 'https://example.test/old-report.docx'
    }, ctx)?.fresh).toHaveLength(1);

    receive(ctx, command);

    expect(plugin.__test__.getLatestRememberedSkillRecord(scope)).toBeNull();
    expect(plugin.__test__.isFreshReportExportResult(scope)).toBe(false);
    expect(plugin.__test__.getTrustedConversationKey(trustedParams)).toBe('');
    expect(plugin.__test__.dedupeOutgoingMediaForConversation({
      mediaUrl: 'https://example.test/old-report.docx'
    }, ctx)?.fresh).toHaveLength(1);
  });

  test('/status preserves prior NAPM context for the next ordinary follow-up', async () => {
    const ctx = createCtx('status-context');
    receive(ctx, '现在系统情况怎么样？');
    receive(ctx, '/status');
    await expect(hooks.get('message_sending')({ content: 'OpenClaw status: connected' }, ctx)).resolves.toBeUndefined();

    receive(ctx, '继续分析');
    const outgoing = await hooks.get('message_sending')({
      content: '需要继续执行 NAPM skill。',
      metadata: { isFinal: true }
    }, ctx);

    expect(outgoing?.content || '').not.toContain('像天气、闲聊、泛问答这类内容不在当前技能范围内');
  });

  test('the next ordinary message clears command bypass and still enforces product scope', async () => {
    const ctx = createCtx('weather');
    receive(ctx, '/help');
    await expect(hooks.get('message_sending')({ content: 'OpenClaw help' }, ctx)).resolves.toBeUndefined();

    receive(ctx, '今天天气怎么样？');
    const outgoing = await hooks.get('message_sending')({ content: '今天晴。' }, ctx);

    expect(outgoing?.content).toContain('像天气、闲聊、泛问答这类内容不在当前技能范围内');
  });

  test('does not use shared agentId as a cross-conversation guard key', async () => {
    const firstCtx = createCtx('first');
    const secondCtx = createCtx('second');
    receive(firstCtx, '今天天气怎么样？');
    receive(secondCtx, '你好');

    const outgoing = await hooks.get('message_sending')({ content: 'unrelated OpenClaw output' }, secondCtx);

    expect(outgoing).toBeUndefined();
  });
});
