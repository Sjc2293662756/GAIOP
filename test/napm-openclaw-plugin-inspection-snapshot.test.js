const path = require('path');

function makeInspectionSource() {
  return {
    applianceInfo: {
      properties: [
        { key: 'hostname', value: 'NAPM-01' },
        { key: 'ipAddress', value: '192.0.2.10' },
        { key: 'SerialNumber', value: 'ARXVXA-123456' },
        { key: 'appliance_time', value: 1710003600 },
        { key: 'uptime', value: '2 days' },
        { key: 'packetPerSecond', value: '1000' },
        { key: 'connPerSecond', value: '80' },
        { key: 'ipsPerMinute', value: '33' },
        { key: 'packetDrops', value: '0' },
        { key: 'packetDupRate', value: '0' },
        { key: 'diskusage', value: '100/500' },
        { key: 'cpuUsage', value: '20' },
        { key: 'datainfo', value: 1710003600 },
        { key: '1minDataRetention', value: '10' },
        { key: '1minMaxRetention', value: '30' },
        { key: 'applicationCnt', value: '12' },
        { key: 'applStandardCnt', value: '4' },
        { key: 'applServerCnt', value: '3' },
        { key: 'applWebCnt', value: '5' },
        { key: 'applUrlCnt', value: '88' },
        { key: 'busGroupCnt', value: '6' }
      ]
    },
    packetsInfo: { rbRange: [1710000000, 1710003600] },
    aboutHtml: '<span id="sysVersion">NetInside 4.0.9</span>',
    trafficAnalysis: {
      status: 'ok',
      recentHour: {
        queryEvidence: { service: 'timeValues', metrics: ['TPIO'], requestUrlRedacted: 'https://napm.test/?Password=***' },
        dataset: { metrics: ['TPIO'], points: [{ time: '2026-06-16 10:00:00', TPIO: 1 }], stats: { avg: 1 } }
      },
      findings: [{ level: 'ok', text: '最近1小时流量曲线连续。', evidenceRefs: ['trafficAnalysis.recentHour.dataset.stats'] }]
    },
    businessPerformance: {
      status: 'ok',
      queryEvidence: [{ id: 'business-slow-access-top', service: 'topValues', metrics: ['PGSLPCT'], requestUrlRedacted: 'https://napm.test/?Password=***' }],
      slowAccess: [],
      httpErrors: [],
      findings: [{ level: 'ok', text: '最近7日业务慢访问和 HTTP 400/500 报错未发现明显异常。', evidenceRefs: ['businessPerformance.rows'] }]
    }
  };
}

describe('napm-openclaw-plugin inspection snapshot integration', () => {
  const originalInspectionExecutor = process.env.NAPM_INSPECTION_EXECUTOR;
  let plugin;

  beforeEach(() => {
    process.env.NAPM_INSPECTION_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-inspection/scripts/run_inspection_snapshot.js');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalInspectionExecutor === undefined) {
      delete process.env.NAPM_INSPECTION_EXECUTOR;
    } else {
      process.env.NAPM_INSPECTION_EXECUTOR = originalInspectionExecutor;
    }
  });

  test('should register inspection snapshot tool in production', () => {
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

    expect(Array.from(tools.keys()).sort()).toEqual([
      'napm-alert-packet-analysis',
      'napm-alert-query',
      'napm-fault-diagnosis',
      'napm-inspection-snapshot',
      'napm-packet-analysis',
      'napm-report-export',
      'napm-skill-query',
      'napm-summary'
    ]);
  });

  test('should expose inspection inputs in the production schema', () => {
    const tool = plugin.__test__.createInspectionSnapshotToolDefinition();

    expect(tool.parameters.properties).toMatchObject({
      prompt: { type: 'string', description: expect.any(String) },
      customerName: { type: 'string', description: expect.any(String) },
      reportDate: { type: 'string', description: expect.any(String) },
      source: { type: 'object', description: expect.any(String), additionalProperties: true }
    });
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  test('should execute inspection snapshot and remember reportData', async () => {
    const tool = plugin.__test__.createInspectionSnapshotToolDefinition();
    const args = {
      prompt: '生成北京烟草巡检报告',
      customerName: '北京烟草',
      reportDate: '2026-06-16',
      source: makeInspectionSource()
    };
    const ctx = {
      channelId: 'wecom',
      accountId: 'inspection-test',
      conversationId: 'inspection-test'
    };
    plugin.__test__.bindTrustedToolContext({
      toolName: 'napm-inspection-snapshot',
      toolCallId: 'inspection-1',
      params: args
    }, ctx);

    const result = await tool.execute('inspection-1', args);

    expect(result.details.ok).toBe(true);
    expect(result.details.reportData).toMatchObject({
      reportType: 'inspection_report',
      templateId: 'napm_traffic_health_inspection_v1'
    });
    expect(result.content[0].text).toContain('巡检数据已生成');
    const conversationKey = plugin.__test__.getConversationKey(ctx);
    expect(plugin.__test__.getLatestRememberedSkillRecord(conversationKey).result.reportData.reportType).toBe('inspection_report');
  });

  test('should persist snapshot reportData when execute receives hook-returned trace params', async () => {
    const hooks = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerCommand() {},
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerHook() {
        throw new Error('production typed hooks must register through api.on');
      }
    });
    const ctx = {
      channelId: 'wecom',
      accountId: 'inspection-hook-trace',
      conversationId: 'inspection-hook-trace',
      sessionKey: 'inspection-hook-trace',
      runId: 'inspection-hook-trace'
    };
    const prompt = '\u7ed9\u6211\u6700\u8fd1\u4e00\u5929\u7cfb\u7edf\u7684\u5de1\u68c0\u62a5\u544a';
    const snapshotEvent = {
      toolName: 'napm-inspection-snapshot',
      toolCallId: 'inspection-hook-trace-call',
      params: { prompt, source: makeInspectionSource() }
    };

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const hookResult = await hooks.get('before_tool_call')(snapshotEvent, ctx);

    expect(hookResult).toMatchObject({
      params: expect.objectContaining({ traceId: expect.any(String) })
    });
    const result = await plugin.__test__.createInspectionSnapshotToolDefinition()
      .execute('inspection-hook-trace-call', hookResult.params);
    const conversationKey = plugin.__test__.getConversationKey(ctx);

    expect(result.details.ok).toBe(true);
    expect(plugin.__test__.getLatestRememberedSkillRecord(conversationKey).result.reportData.reportType)
      .toBe('inspection_report');
  });

  test('should expose user-facing inspection snapshot reply', () => {
    const text = plugin.__test__.buildInspectionSnapshotReply({
      ok: true,
      summary: {
        title: '北京烟草基于AI的全流量性能分析平台健康检查报告',
        status: 'ok',
        highlights: ['本次巡检未发现明显异常。']
      },
      reportData: { reportType: 'inspection_report' }
    });

    expect(text).toContain('巡检数据已生成');
    expect(text).toContain('napm-report-export');
  });
});
