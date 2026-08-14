const plugin = require('../napm-openclaw-plugin.remote.js');

describe('NAPM cross-skill routing contract', () => {
  test.each([
    '查询最近一天的告警摘要',
    '查看告警时间线',
    'event id 123 的告警详情',
    '解释 SysLog 告警通知字段'
  ])('classifies alert-event requests for napm-alert-query: %s', (prompt) => {
    expect(plugin.__test__.isAlertEventPrompt(prompt)).toBe(true);
  });

  test.each([
    '分析支付web的报错原因',
    '排查 10.0.0.1 网络慢的根因',
    '给“统一认证平台”做故障诊断'
  ])('routes named-target diagnosis away from query skill: %s', (prompt) => {
    expect(plugin.__test__.hasSpecificFaultDiagnosisTarget(prompt)).toBe(true);
    expect(plugin.__test__.isFaultDiagnosisPrompt(prompt)).toBe(true);
  });

  test.each([
    '哪个业务400报错最多？',
    'HTTP 500最多的Web应用排行',
    '页面性能分析',
    '分析一下业务故障情况'
  ])('keeps rankings and unnamed analysis out of targeted diagnosis: %s', (prompt) => {
    expect(plugin.__test__.isFaultDiagnosisPrompt(prompt)).toBe(false);
  });

  test('uses a resolved group argument as the named target for continuation wording', () => {
    expect(plugin.__test__.isFaultDiagnosisPrompt('分析这个业务的故障', {
      hasExplicitTarget: true
    })).toBe(true);
  });

  test('before_tool_call blocks query skill for alert and named fault requests', async () => {
    const hooks = new Map();
    const api = {
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        if (Array.isArray(name)) {
          name.forEach((item) => hooks.set(item, handler));
          return;
        }
        hooks.set(name, handler);
      }
    };
    plugin.register(api);
    const ctx = {
      channelId: 'wecom',
      accountId: 'routing-contract',
      conversationId: 'routing-contract',
      sessionKey: 'routing-contract',
      runId: 'routing-contract'
    };
    const tryQuery = async (prompt, resolvedQuery) => {
      hooks.get('message_received')({ content: prompt }, ctx);
      await hooks.get('before_prompt_build')({ prompt }, ctx);
      return hooks.get('before_tool_call')({
        toolName: 'napm-skill-query',
        params: { prompt, resolvedQuery }
      }, ctx);
    };

    const alertResult = await tryQuery('查询最近一天的告警摘要', {
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'WebApplication' }]
    });
    expect(alertResult).toMatchObject({ block: true });
    expect(alertResult.blockReason).toContain('napm-alert-query');

    const faultResult = await tryQuery('分析支付web的报错原因', {
      service: 'overview',
      queryModeKey: 'overview',
      overviewScene: 'web_application',
      groups: [{ type: 'WebApplication', argument: '支付web' }],
      timeRange: { key: 'last1hour' }
    });
    expect(faultResult).toMatchObject({ block: true });
    expect(faultResult.blockReason).toContain('napm-fault-diagnosis');
  });
});
