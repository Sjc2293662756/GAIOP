'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('BUG-A Phase 4.1 Plugin time materialization order', () => {
  let baseDir;
  let plugin;
  let hooks;
  let tools;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-phase41-time-'));
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
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
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

  test('allows declarative relative time at construction, then materializes it before execution validation', async () => {
    const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
    const Validator = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator');
    const prompt = '最近1小时总流量趋势如何？';
    const ctx = {
      channelId: 'wecom',
      accountId: 'phase41-time',
      conversationId: 'phase41-time',
      sessionKey: 'phase41-time',
      sessionId: 'phase41-time',
      runId: 'phase41-time-run',
      messageId: 'phase41-time-message'
    };
    const queryDraft = {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'timeValues',
      queryModeKey: 'timeseries',
      groups: [{ type: 'TotalTraffic' }],
      metrics: ['TPIO'],
      granularity: 3600,
      timeRange: { key: 'last1hour' },
      format: 'json'
    };

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const construction = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      toolCallId: 'phase41-time-construction',
      params: { prompt, userQuery: prompt, queryDraft }
    }, ctx);

    expect(construction.block).not.toBe(true);
    expect(construction.params.resolvedQuery).not.toHaveProperty('start');
    expect(construction.params.resolvedQuery).not.toHaveProperty('end');
    expect(construction.params.resolvedQuery.timeRange).toMatchObject({ key: 'last1hour' });

    const parser = jest.spyOn(RequirementParserService, 'executeGatewayRequest')
      .mockResolvedValue({
        ok: true,
        service: 'timeValues',
        data: [],
        error: null,
        requestParams: { type: 'timeValues' }
      });
    const validator = jest.spyOn(Validator, 'validate');

    await tools.get('napm-skill-query').execute(
      'phase41-time-execute',
      construction.params
    );

    expect(parser).toHaveBeenCalledTimes(1);
    const executedQuery = parser.mock.calls[0][0];
    expect(executedQuery.start).toEqual(expect.any(Number));
    expect(executedQuery.end).toEqual(expect.any(Number));
    expect(executedQuery.start).toBeGreaterThan(0);
    expect(executedQuery.end).toBeGreaterThan(executedQuery.start);
    expect(executedQuery.start % 60).toBe(0);
    expect(executedQuery.end % 60).toBe(0);
    expect(validator.mock.calls.some(([query]) => (
      Number.isInteger(query?.start)
      && Number.isInteger(query?.end)
      && query.end > query.start
    ))).toBe(true);
  });
});
