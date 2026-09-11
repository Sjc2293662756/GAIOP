'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

function queryDraft() {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'WebApplication' }],
    metrics: ['PGTME'],
    topMetric: 'PGTME',
    topCount: 5,
    start: 1788937200,
    end: 1788940800,
    format: 'json'
  };
}

describe('BUG-A Phase 5 Plugin runtime gate', () => {
  let baseDir;
  let plugin;
  let hooks;
  let tools;
  let restoreClient;
  let savedBaseline;

  beforeEach(() => {
    savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-phase5-plugin-'));
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
    hooks = new Map();
    tools = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(definition) { tools.set(definition.name, definition); },
      registerCommand() {},
      registerHook(name, handler) {
        (Array.isArray(name) ? name : [name]).forEach((item) => hooks.set(item, handler));
      }
    });
  });

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    jest.restoreAllMocks();
    if (savedBaseline === undefined) delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    else process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function executeWithCapabilityResponse(response) {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const QuerySkill = require('../skills/openclaw-napm-query/scripts/run_napm_query');
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({
        counter,
        responses: {
          metricsForGroup: response,
          topValues: '[]'
        }
      })
    );
    const skill = jest.spyOn(QuerySkill, 'handleSkillCall');
    const ctx = {
      channelId: 'wecom',
      accountId: 'phase5-plugin',
      conversationId: 'phase5-plugin',
      sessionKey: 'phase5-plugin',
      sessionId: 'phase5-plugin',
      runId: `phase5-plugin-${Date.now()}`,
      messageId: 'phase5-plugin-message'
    };
    const prompt = '页面响应时间最高的前5个业务';
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const constructed = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      toolCallId: 'phase5-plugin-construction',
      params: { prompt, userQuery: prompt, queryDraft: queryDraft() }
    }, ctx);
    expect(constructed.block).not.toBe(true);

    const result = await tools.get('napm-skill-query').execute(
      'phase5-plugin-execute',
      constructed.params
    );
    return { counter, skill, result };
  }

  test('UNKNOWN invokes Query Skill once and allows data only after SUPPORTED', async () => {
    const { counter, skill, result } = await executeWithCapabilityResponse([
      { id: 'PGTME', label: 'page time' }
    ]);

    expect(skill).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
    expect(result.details).toMatchObject({ ok: true });
  });

  test('UNKNOWN invokes Query Skill once but blocks data after UNSUPPORTED', async () => {
    const { counter, skill, result } = await executeWithCapabilityResponse([]);

    expect(skill).toHaveBeenCalledTimes(1);
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(0);
    expect(result.details).toMatchObject({
      ok: false,
      error: { code: 'RUNTIME_METRIC_UNSUPPORTED' }
    });
  });
});
