'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

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

    const tools = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
      registerHook() {}
    });

    try {
      const result = await tools.get('napm-skill-query').execute('runtime-contract-call', {
        prompt: 'recent packet-loss ranking',
        resolvedQuery: {
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
        }
      });

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
});
