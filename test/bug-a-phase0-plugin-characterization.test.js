'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');

describe('BUG-A Phase 0 plugin adapter characterization baseline', () => {
  let baseDir;
  let plugin;
  let tools;
  let RequirementParserService;
  let QueryDecisionPolicy;
  let QuerySkill;
  let counter;
  let restoreClient;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-bug-a-phase0-plugin-'));
    process.env.NETINSIDE_HOST = 'https://example.invalid/webservice/NetInside';
    process.env.NETINSIDE_USERNAME = 'phase0-test-user';
    process.env.NETINSIDE_PASSWORD = 'phase0-test-password';
    process.env.NAPM_AUDIT_LOG_PATH = path.join(baseDir, 'audit.log');
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(baseDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');

    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
    RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    QueryDecisionPolicy = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');
    QuerySkill = require('../skills/openclaw-napm-query/scripts/run_napm_query');

    counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter })
    );

    tools = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
      registerHook() {}
    });
  });

  afterEach(() => {
    if (restoreClient) {
      restoreClient();
      restoreClient = null;
    }
    jest.restoreAllMocks();
    delete process.env.NAPM_AUDIT_LOG_PATH;
    delete process.env.NAPM_REPORT_SOURCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function createTrustedDirectArgs(queryDraft) {
    const prompt = '最近业务访问较慢的前5个业务都有谁？';
    const ctx = {
      channelId: 'wecom',
      accountId: 'phase0-account',
      conversationId: 'phase0-conversation',
      sessionKey: 'phase0-session',
      sessionId: 'phase0-session',
      runId: 'phase0-plugin-run',
      messageId: 'phase0-plugin-message'
    };
    const scope = plugin.__test__.getConversationKey(ctx);
    const turnId = 'phase0-plugin-turn';
    plugin.__test__.queryTurnCoordinator.begin({
      scope,
      turnId,
      runId: ctx.runId,
      route: 'NAPM_QUERY',
      question: prompt,
      semanticQuestion: prompt,
      queryDraft
    });
    const event = {
      toolName: 'napm-skill-query',
      params: { prompt, queryDraft }
    };
    const traceId = plugin.__test__.bindTrustedToolContext(event, ctx);
    const admissionDecision = {
      conversationKey: scope,
      turnId,
      runId: ctx.runId,
      messageId: ctx.messageId,
      route: 'napm_candidate',
      action: 'EXECUTE_TOOL',
      expectedTool: 'napm-skill-query',
      workflow: 'phase0_characterization',
      reasonCode: 'BASE_TURN_POLICY'
    };
    expect(plugin.__test__.authorizeTrustedToolContext(
      traceId,
      event.params,
      admissionDecision
    )).toBe(true);
    return {
      scope,
      turnId,
      params: { ...event.params, traceId }
    };
  }

  test('phase4_shared_gate_blocks_webapplication_trti_before_skill_and_southbound', async () => {
    const queryDraft = {
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }],
      metric: 'TRTI',
      metrics: ['TRTI'],
      topMetric: 'TRTI',
      topCount: 5,
      start: 1788937200,
      end: 1788940800,
      format: 'json',
      semanticConstraints: {
        workflowType: 'metric_topn',
        operation: 'rank_top',
        direction: 'desc',
        targetObjectType: 'WebApplication'
      }
    };
    const trusted = createTrustedDirectArgs(queryDraft);
    const policySpy = jest.spyOn(QueryDecisionPolicy, 'evaluateQueryDecision');
    const skillSpy = jest.spyOn(QuerySkill, 'handleSkillCall');
    const metadataReviewSpy = jest.spyOn(
      RequirementParserService,
      'reviewGatewayRequestMetadata'
    );

    const result = await tools.get('napm-skill-query').execute(
      'phase0-plugin-tool-call',
      trusted.params
    );

    expect(policySpy).toHaveBeenCalledTimes(1);
    expect(skillSpy).not.toHaveBeenCalled();
    expect(metadataReviewSpy).not.toHaveBeenCalled();
    expect(counter.snapshot().total).toBe(0);
    expect(result.details).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_QUERY_DRAFT_INVALID' },
      decision: {
        reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
        southboundAllowed: false
      }
    });
    expect(plugin.__test__.queryTurnCoordinator.get(trusted.scope, trusted.turnId)).toMatchObject({
      phase: 'REPAIR_PENDING',
      outcome: null,
      repairBudget: {
        limit: 1,
        used: 1,
        remaining: 0
      }
    });
  });
});
