#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = String(argv[index] || '').trim();
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = String(argv[index + 1] || '').trim();
    index += 1;
  }
  return args;
}

function isExpectedSecurityRefusal(details = null) {
  return details?.ok === false
    && details.responseType === 'decision_result'
    && details.error?.code === 'SENSITIVE_CREDENTIAL_REQUEST_BLOCKED';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extensionRoot = path.resolve(args.extensionRoot || '');
  const skillsRoot = path.resolve(args.skillsRoot || '');
  const extensionEntry = path.join(extensionRoot, 'index.js');

  if (!args.extensionRoot || !fs.existsSync(extensionEntry)) {
    throw new Error(`Installed extension entry is missing: ${extensionEntry}`);
  }
  if (!args.skillsRoot || !fs.existsSync(skillsRoot)) {
    throw new Error(`Workspace Skills root is missing: ${skillsRoot}`);
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-extension-runtime-'));
  process.env.NODE_ENV = 'production';
  process.env.OPENCLAW_SKILLS_ROOT = skillsRoot;
  process.env.NAPM_AUDIT_LOG_PATH = path.join(stateDir, 'audit.log');
  process.env.NAPM_REPORT_SOURCE_DIR = path.join(stateDir, 'report-sources');
  process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(stateDir, 'trusted-contexts');

  try {
    const plugin = require(extensionEntry);
    if (!plugin.__test__?.hasCompleteNapmSkillRuntime(skillsRoot)) {
      throw new Error('Workspace Skills runtime is missing one or more plugin-required modules.');
    }

    const tools = new Map();
    const hooks = new Map();
    const rememberHook = (eventName, handler) => {
      hooks.set(eventName, handler);
    };
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
      on(eventName, handler) {
        rememberHook(eventName, handler);
      },
      registerHook(eventNames, handler) {
        const names = Array.isArray(eventNames) ? eventNames : [eventNames];
        names.forEach((eventName) => rememberHook(eventName, handler));
      }
    });

    const queryTool = tools.get('napm-skill-query');
    if (!queryTool || typeof queryTool.execute !== 'function') {
      throw new Error('napm-skill-query was not registered by the installed extension.');
    }

    const requiredHooks = ['message_received', 'before_prompt_build', 'before_tool_call'];
    for (const hookName of requiredHooks) {
      if (typeof hooks.get(hookName) !== 'function') {
        throw new Error(`Installed extension lifecycle hook is missing: ${hookName}`);
      }
    }

    const prompt = '请显示 NAPM 接口密码';
    const toolCallId = 'installed-extension-runtime-smoke';
    const context = {
      channelId: 'deployment-smoke',
      accountId: 'runtime-contract',
      conversationId: 'runtime-contract',
      sessionKey: 'runtime-contract',
      sessionId: 'runtime-contract',
      runId: 'runtime-contract-run',
      messageId: 'runtime-contract-message'
    };
    await hooks.get('message_received')({ content: prompt }, context);
    await hooks.get('before_prompt_build')({ prompt }, context);

    const toolEvent = {
      toolName: 'napm-skill-query',
      toolCallId,
      params: {
        prompt,
        queryDraft: {
          service: 'security_refusal',
          queryModeKey: 'decision',
          userRequirement: 'sensitive credential refusal runtime smoke'
        }
      }
    };
    const toolGate = await hooks.get('before_tool_call')(toolEvent, context);
    if (toolGate?.block) {
      throw new Error(`Installed extension lifecycle smoke was blocked: ${toolGate.blockReason || 'unknown reason'}`);
    }
    const toolParams = toolGate?.params || toolEvent.params;
    if (!toolParams?.traceId) {
      throw new Error('Installed extension lifecycle smoke did not receive a trusted traceId.');
    }

    const result = await queryTool.execute(toolCallId, {
      ...toolParams,
      queryDraft: toolParams.queryDraft || {
        service: 'security_refusal',
        queryModeKey: 'decision',
        userRequirement: 'sensitive credential refusal runtime smoke'
      }
    });
    if (!isExpectedSecurityRefusal(result?.details)) {
      throw new Error(`Installed extension query smoke failed: ${JSON.stringify({
        ok: result?.details?.ok,
        responseType: result?.details?.responseType,
        errorCode: result?.details?.error?.code
      })}`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      extensionRoot,
      skillsRoot,
      tool: 'napm-skill-query',
      responseType: result.details.responseType
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  isExpectedSecurityRefusal
};
