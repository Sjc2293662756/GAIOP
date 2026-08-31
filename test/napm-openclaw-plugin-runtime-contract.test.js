'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isExpectedSecurityRefusal
} = require('../scripts/verify-openclaw-extension-runtime');

function copyDirectorySync(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    } else {
      throw new Error(`Unsupported plugin fixture entry: ${sourcePath}`);
    }
  }
}

describe('installed extension smoke contract', () => {
  test('accepts only the typed sensitive-credential refusal result', () => {
    expect(isExpectedSecurityRefusal({
      ok: false,
      responseType: 'decision_result',
      error: { code: 'SENSITIVE_CREDENTIAL_REQUEST_BLOCKED' }
    })).toBe(true);
    expect(isExpectedSecurityRefusal({
      ok: true,
      responseType: 'security_refusal',
      error: null
    })).toBe(false);
    expect(isExpectedSecurityRefusal({
      ok: false,
      responseType: 'decision_result',
      error: { code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED' }
    })).toBe(false);
  });
});

describe('NAPM plugin in-process Skill execution contract', () => {
  let baseDir;
  let plugin;
  let RequirementParserService;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-plugin-runtime-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    jest.resetModules();
    RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    plugin = require('../napm-openclaw-plugin.remote');
  });

  afterEach(() => {
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    delete process.env.OPENCLAW_SKILLS_ROOT;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function registerHarness(pluginInstance) {
    const tools = new Map();
    const hooks = new Map();
    pluginInstance.register({
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
    return { tools, hooks };
  }

  async function executeThroughLifecycle(
    pluginInstance,
    harness,
    toolCallId,
    prompt,
    queryDraft,
    suffix
  ) {
    const ctx = {
      channelId: 'wecom',
      accountId: `runtime-account-${suffix}`,
      conversationId: `runtime-conversation-${suffix}`,
      sessionKey: `runtime-session-${suffix}`,
      sessionId: `runtime-session-${suffix}`,
      runId: `runtime-run-${suffix}`,
      messageId: `runtime-message-${suffix}`
    };
    harness.hooks.get('message_received')({ content: prompt }, ctx);
    await harness.hooks.get('before_prompt_build')({ prompt }, ctx);
    const event = {
      toolName: 'napm-skill-query',
      toolCallId,
      params: { prompt, queryDraft }
    };
    pluginInstance.__test__.bindTrustedToolContext(event, ctx);
    return harness.tools.get('napm-skill-query').execute(toolCallId, event.params);
  }

  test('executes a valid NAPM query through the registered plugin tool', async () => {
    const originalExecuteGatewayRequest = RequirementParserService.executeGatewayRequest;
    RequirementParserService.executeGatewayRequest = jest.fn(async (resolvedQuery) => ({
      ok: true,
      service: resolvedQuery.service,
      data: [{
        group: { type: 'IPAddress', argument: '10.0.0.1' },
        metricValues: [{ metric: { id: 'PLI' }, value: 12, unit: 'count' }]
      }],
      requestUrl: 'http://example.invalid/napi/query',
      error: null
    }));

    const harness = registerHarness(plugin);

    try {
      const result = await executeThroughLifecycle(
        plugin,
        harness,
        'runtime-contract-call',
        'recent packet-loss ranking',
        {
          service: 'topValues',
          queryModeKey: 'topn',
          metric: 'PLI',
          metrics: ['PLI'],
          topMetric: 'PLI',
          topCount: 10,
          groups: [{ type: 'IPAddress' }],
          start: 1777982400,
          end: 1777986000,
          format: 'json',
          userRequirement: 'recent packet-loss ranking'
        },
        'top-values'
      );

      expect(result.details).toMatchObject({
        ok: true,
        service: 'topValues',
        rows: [expect.objectContaining({ group: { type: 'IPAddress', argument: '10.0.0.1' } })]
      });
      expect(RequirementParserService.executeGatewayRequest).toHaveBeenCalledTimes(1);
    } finally {
      RequirementParserService.executeGatewayRequest = originalExecuteGatewayRequest;
    }
  });

  test('falls back to the workspace Skill root when extension-local Skills are incomplete', () => {
    const localSkillsRoot = '/extension/napm-openclaw-plugin/skills';
    const deployedSkillsRoot = '/home/netinside/.openclaw/workspace/skills';
    const completeFiles = new Set(
      plugin.__test__.requiredNapmSkillRuntimePaths.map((relativePath) => (
        path.join(deployedSkillsRoot, relativePath)
      ))
    );

    const selectedRoot = plugin.__test__.resolveOpenClawSkillsRoot({
      localSkillsRoot,
      deployedSkillsRoot,
      explicitRoot: '',
      existsSync: (candidatePath) => completeFiles.has(candidatePath)
    });

    expect(selectedRoot).toBe(deployedSkillsRoot);
  });

  test.each([
    ['WebApplication', 3, '业务系统一'],
    ['DefinedApp', 2, '已定义应用一']
  ])('executes groups metadata for %s from a minimal installed extension layout', async (
    objectType,
    applicationType,
    objectName
  ) => {
    const extensionDir = path.join(baseDir, 'extensions', 'napm-openclaw-plugin');
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'napm-openclaw-plugin.remote.js'),
      path.join(extensionDir, 'index.js')
    );
    copyDirectorySync(
      path.resolve(__dirname, '..', 'plugin'),
      path.join(extensionDir, 'plugin')
    );

    const skillsRoot = path.resolve(__dirname, '..', 'skills');
    process.env.OPENCLAW_SKILLS_ROOT = skillsRoot;
    jest.resetModules();

    const installedRequirementParser = require(path.join(
      skillsRoot,
      'openclaw-napm-query/services/RequirementParserService'
    ));
    const originalExecuteGatewayRequest = installedRequirementParser.executeGatewayRequest;
    installedRequirementParser.executeGatewayRequest = jest.fn(async (resolvedQuery) => ({
      ok: true,
      service: resolvedQuery.service,
      data: [{
        label: objectName,
        value: objectName,
        type: objectType,
        applicationType
      }],
      metadata: {
        providerType: 'applications',
        apiType: 'applications',
        applicationTypeFilter: [applicationType]
      },
      error: null
    }));

    const installedPlugin = require(path.join(extensionDir, 'index.js'));
    const installedHarness = registerHarness(installedPlugin);

    try {
      const result = await executeThroughLifecycle(
        installedPlugin,
        installedHarness,
        `minimal-extension-${objectType}`,
        `列出${objectName}`,
        {
          service: 'groups',
          queryModeKey: 'metadata',
          groups: [{ type: objectType }],
          format: 'json'
        },
        objectType
      );

      expect(result.details).toMatchObject({
        ok: true,
        service: 'groups',
        resolvedQuery: {
          service: 'groups',
          queryModeKey: 'metadata',
          groups: [{ type: objectType }]
        }
      });
      expect(result.details.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: objectName, type: objectType })
      ]));
    } finally {
      installedRequirementParser.executeGatewayRequest = originalExecuteGatewayRequest;
    }
  });
});
