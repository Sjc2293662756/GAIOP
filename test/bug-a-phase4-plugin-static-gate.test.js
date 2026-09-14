'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('BUG-A Phase 4 plugin static executable gate', () => {
  let baseDir;
  let plugin;
  let hooks;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-phase4-plugin-'));
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
        (Array.isArray(name) ? name : [name]).forEach((item) => hooks.set(item, handler));
      }
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('blocks known incompatible query before Query Skill or NapmClient', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
    const NapmClient = require('../skills/openclaw-napm-query/services/NapmClient');
    const querySkill = require('../skills/openclaw-napm-query/scripts/run_napm_query');
    const skill = jest.spyOn(querySkill, 'handleSkillCall');
    const validator = jest.spyOn(Validator, 'validate');
    const gateway = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
    const clientGet = jest.spyOn(NapmClient.prototype, 'get');
    const prompt = '页面响应时间最高的前5个业务';
    const ctx = {
      channelId: 'wecom', accountId: 'phase4', conversationId: 'phase4',
      sessionKey: 'phase4', sessionId: 'phase4', runId: 'phase4-run', messageId: 'phase4-message'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      toolCallId: 'phase4-call',
      params: {
        prompt,
        queryDraft: {
          schemaVersion: 'napm-resolved-query.v1',
          service: 'topValues',
          groups: [{ type: 'WebApplication' }],
          metrics: ['TRTI'],
          topMetric: 'TRTI',
          topCount: 5,
          timeRange: { key: 'last1hour' }
        }
      }
    }, ctx);

    expect(result).toMatchObject({ block: true });
    expect(result.blockReason).toContain('OBJECT_METRIC_INCOMPATIBLE');
    expect(validator).toHaveBeenCalledTimes(1);
    expect(skill).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
    expect(clientGet).not.toHaveBeenCalled();
  });

  test('admits UNKNOWN capability to Query Skill runtime confirmation without Plugin metadata access', async () => {
    const savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    try {
      const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
      const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
      const NapmClient = require('../skills/openclaw-napm-query/services/NapmClient');
      const querySkill = require('../skills/openclaw-napm-query/scripts/run_napm_query');
      const skill = jest.spyOn(querySkill, 'handleSkillCall');
      const validator = jest.spyOn(Validator, 'validate');
      const gateway = jest.spyOn(RequirementParserService, 'executeGatewayRequest');
      const clientGet = jest.spyOn(NapmClient.prototype, 'get');
      const prompt = '页面响应时间最高的前5个业务';
      const ctx = {
        channelId: 'wecom', accountId: 'phase4-unknown', conversationId: 'phase4-unknown',
        sessionKey: 'phase4-unknown', sessionId: 'phase4-unknown',
        runId: 'phase4-unknown-run', messageId: 'phase4-unknown-message'
      };
      hooks.get('message_received')({ content: prompt }, ctx);
      await hooks.get('before_prompt_build')({ prompt }, ctx);
      const result = hooks.get('before_tool_call')({
        toolName: 'napm-skill-query',
        toolCallId: 'phase4-unknown-call',
        params: {
          prompt,
          queryDraft: {
            schemaVersion: 'napm-resolved-query.v1',
            service: 'topValues',
            groups: [{ type: 'WebApplication' }],
            metrics: ['PGTME'],
            topMetric: 'PGTME',
            topCount: 5,
            timeRange: { key: 'last1hour' }
          }
        }
      }, ctx);

      expect(result.block).not.toBe(true);
      expect(result.params).toMatchObject({
        resolvedQuery: {
          groups: [{ type: 'WebApplication' }],
          metrics: ['PGTME']
        }
      });
      expect(validator).toHaveBeenCalledTimes(1);
      expect(skill).not.toHaveBeenCalled();
      expect(gateway).not.toHaveBeenCalled();
      expect(clientGet).not.toHaveBeenCalled();
    } finally {
      if (savedBaseline === undefined) delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
      else process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
    }
  });
});
