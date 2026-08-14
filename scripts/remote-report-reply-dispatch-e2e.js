'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'napm-openclaw-plugin.remote.js'));
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-reply-dispatch-e2e-'));

process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');

async function main() {
  const plugin = require(pluginPath);
  const hooks = new Map();
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

  const prompt = '给我应用的最近七天的综述报告！';
  const runtimeCtx = {
    sessionKey: `explicit:report-e2e:${Date.now()}`,
    channelId: 'wecom',
    accountId: 'smoke',
    conversationId: 'report-e2e',
    runId: `run-report-e2e-${Date.now()}`
  };
  hooks.get('message_received')({ content: prompt }, runtimeCtx);

  const payloads = [];
  const result = await hooks.get('reply_dispatch')({
    ctx: {
      SessionKey: runtimeCtx.sessionKey,
      Surface: runtimeCtx.channelId,
      AccountId: runtimeCtx.accountId,
      From: runtimeCtx.conversationId,
      Body: prompt,
      MessageSid: runtimeCtx.runId
    },
    runId: runtimeCtx.runId,
    sessionKey: runtimeCtx.sessionKey,
    suppressUserDelivery: false,
    sendPolicy: 'allow'
  }, {
    dispatcher: {
      sendFinalReply(payload) {
        payloads.push(payload);
        return true;
      },
      getQueuedCounts() {
        return { tool: 0, block: 0, final: payloads.length };
      }
    },
    async onReplyStart() {},
    recordProcessed() {},
    markIdle() {}
  });

  assert.equal(result?.handled, true);
  assert.equal(result?.queuedFinal, true);
  assert.equal(payloads.length, 1);
  assert.match(payloads[0]?.text || '', /报告已生成/);
  assert.equal(payloads[0]?.mediaUrls?.length, 1);
  assert.equal(payloads[0]?.mediaUrl, payloads[0]?.mediaUrls?.[0]);
  assert.equal(path.extname(payloads[0].mediaUrl).toLowerCase(), '.docx');
  assert.equal(fs.existsSync(payloads[0].mediaUrl), true);
  assert.ok(fs.statSync(payloads[0].mediaUrl).size > 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    handled: result.handled,
    queuedFinal: result.queuedFinal,
    payloadCount: payloads.length,
    mediaUrl: payloads[0].mediaUrl,
    fileSize: fs.statSync(payloads[0].mediaUrl).size
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
