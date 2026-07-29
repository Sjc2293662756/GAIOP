describe('napm-openclaw-plugin alert query integration', () => {
  let plugin;

  beforeEach(() => {
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
  });

  function createApiHarness() {
    const hooks = new Map();
    const tools = new Map();
    const api = {
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
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
    return { hooks, tools };
  }

  function createWeComCtx(suffix) {
    return {
      channelId: 'wecom',
      accountId: `acct-${suffix}`,
      conversationId: `conv-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };
  }

  test('should register alert query tool in production', () => {
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
      'napm-alert-query',
      'napm-inspection-snapshot',
      'napm-packet-analysis',
      'napm-report-export',
      'napm-skill-query'
    ]);
  });

  test('should build alert executor payload from top-level criteria', () => {
    const payload = plugin.__test__.buildAlertExecutorPayload({
      prompt: '最近一小时有哪些紧急告警',
      mode: 'summary',
      criteria: {
        start: 1781488800,
        end: 1781492400,
        severities: [4]
      }
    });

    expect(payload.prompt).toBe('最近一小时有哪些紧急告警');
    expect(payload.alertQuery).toMatchObject({
      mode: 'summary',
      criteria: {
        start: 1781488800,
        end: 1781492400,
        severities: [4]
      }
    });
  });

  test('should expose alert query tool definition schema', () => {
    const tool = plugin.__test__.createAlertQueryToolDefinition();

    expect(tool.name).toBe('napm-alert-query');
    expect(tool.parameters.properties.mode.enum).toContain('detail_with_timeseries');
    expect(tool.description).toContain('read-only');
    expect(String(tool.execute)).toContain('finalAnswer');
    expect(String(tool.execute)).toContain('verbatim_final_answer');
    expect(String(tool.execute)).not.toContain('details:');
  });

  test('should instruct model to output alert finalAnswer verbatim', () => {
    const context = plugin.__test__.buildNapmRoutingSystemContext();

    expect(context).toContain('Alert final-answer contract');
    expect(context).toContain('output that text verbatim');
    expect(context).toContain('do not regroup by severity');
    expect(context).toContain('① 应用性能告警 — N 条');
  });

  test('should render fixed alert summary table reply', () => {
    const text = plugin.__test__.buildAlertQueryReply({
      ok: true,
      timeRange: { start: 1781488800, end: 1781492400 },
      summary: {
        total: 2,
        bySeverity: { critical: 1, major: 1, minor: 0 }
      },
      events: [
        {
          id: '369652',
          severityLabel: '紧急',
          severity: 4,
          categoryLabel: '网络性能告警',
          group: '192.168.1.16',
          name: '吞吐过高'
        },
        {
          id: '369653',
          severityLabel: '重大',
          severity: 3,
          categoryLabel: '应用性能告警',
          group: 'HTTPS',
          name: '外部应用性能下降'
        }
      ],
      packetHandoff: { available: true },
      requestUrl: 'https://example.test/webservice/NetInside?UserName=GAIOP&Password=***&type=alertsSummary&start=1781488800&end=1781492400&json=true'
    });

    expect(text).toContain('告警总数：2 条');
    expect(text).toContain('🔴 紧急：1 条');
    expect(text).toContain('🟠 重大：1 条');
    expect(text).toContain('| 级别 | 类型 | 对象 | 描述 |');
    expect(text).toContain('| 🔴 紧急 | 网络性能 | 192.168.1.16 | 吞吐过高 |');
    expect(text).toContain('| 🟠 重大 | 应用性能 | HTTPS | 外部应用性能下降 |');
    expect(text).toContain('初步判断：');
    expect(text).toContain('packetHandoff');
    expect(text).toContain('Debug API:');
    expect(text).toContain('type=alertsSummary');
    expect(text).toContain('Password=***');
  });

  test('should render grouped alert summary by category when no alert type is specified', () => {
    const text = plugin.__test__.buildAlertQueryReply({
      ok: true,
      mode: 'summary',
      criteria: {
        start: 1781488800,
        end: 1781492400,
        categories: []
      },
      timeRange: { displayText: '最近一小时' },
      summary: {
        total: 3,
        bySeverity: { critical: 1, major: 1, minor: 1 },
        byCategoryDetail: [
          {
            category: 'networkAlerts',
            categoryLabel: '网络性能告警',
            total: 2,
            bySeverity: { critical: 1, major: 0, minor: 1 },
            overviewEvents: [
              {
                id: '369652',
                severityLabel: '紧急',
                severity: 4,
                group: '192.168.1.16',
                name: '吞吐过高',
                triggerCount: 2,
                period: 120,
                start: 1781680980
              }
            ]
          },
          {
            category: 'appAlerts',
            categoryLabel: '应用性能告警',
            total: 1,
            bySeverity: { critical: 0, major: 1, minor: 0 },
            overviewEvents: [
              {
                id: '369653',
                severityLabel: '重大',
                severity: 3,
                group: 'HTTPS',
                name: '外部应用性能下降',
                triggerCount: 1,
                period: 1,
                start: 1781680980
              }
            ]
          }
        ]
      },
      events: []
    });

    expect(text).toContain('最近一小时告警汇总：共 3 条');
    expect(text).toContain('① 网络性能告警 — 2 条');
    expect(text).toContain('🔴 紧急 1 条 | 🟢 轻微 1 条');
    expect(text).toContain('对象：192.168.1.16（吞吐过高）');
    expect(text).toContain('② 应用性能告警 — 1 条');
    expect(text).toContain('🟠 重大 1 条');
    expect(text).toContain('- 🔴 吞吐过高触发：对象 192.168.1.16 触发了 2 次告警，持续时长为 2 分钟，开始时间为 2026-06-17 15:23。');
    expect(text).toContain('- 🟠 外部应用性能下降触发：对象 HTTPS 触发了 1 次告警，持续时长为 1 分钟，开始时间为 2026-06-17 15:23。');
    expect(text).toContain('吞吐过高触发：对象 192.168.1.16 触发了 2 次告警，持续时长为 2 分钟，开始时间为 2026-06-17 15:23。');
    expect(text).toContain('外部应用性能下降触发：对象 HTTPS 触发了 1 次告警，持续时长为 1 分钟，开始时间为 2026-06-17 15:23。');
    expect(text).not.toContain('告警总数：3 条');
  });

  test('should keep global alert table when an alert type is specified', () => {
    const text = plugin.__test__.buildAlertQueryReply({
      ok: true,
      mode: 'summary',
      criteria: {
        start: 1781488800,
        end: 1781492400,
        categories: ['appAlerts']
      },
      summary: {
        total: 1,
        bySeverity: { critical: 0, major: 1, minor: 0 }
      },
      events: [
        {
          id: '369653',
          severityLabel: '重大',
          severity: 3,
          categoryLabel: '应用性能告警',
          group: 'HTTPS',
          name: '外部应用性能下降'
        }
      ]
    });

    expect(text).toContain('告警总数：1 条');
    expect(text).toContain('| 级别 | 类型 | 对象 | 描述 |');
    expect(text).toContain('| 🟠 重大 | 应用性能 | HTTPS | 外部应用性能下降 |');
    expect(text).not.toContain('应用性能告警：');
  });

  test('should classify alert event questions separately from broad overview prompts', () => {
    expect(plugin.__test__.isAlertEventPrompt('最近一小时有哪些告警？')).toBe(true);
    expect(plugin.__test__.isAlertEventPrompt('告警 369652 的详情是什么？')).toBe(true);
    expect(plugin.__test__.isAlertEventPrompt('最近一小时告警数量趋势怎么样？')).toBe(true);
    expect(plugin.__test__.isAlertEventPrompt('最近一小时系统整体情况怎么样？')).toBe(false);
  });

  test('should require napm-alert-query result before sending no-alert answer', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const ctx = createWeComCtx('alert-no-result');
    const prompt = '最近一小时有哪些告警？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await messageSending({
      content: '最近一小时（21:03 ~ 22:03）没有产生任何告警。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('napm-alert-query');
    expect(result.content).toContain('没有拿到可核验的告警查询结果');
    expect(result.content).not.toContain('没有产生任何告警');
  });

  test('should block napm-skill-query for alert event prompts', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeToolCall = hooks.get('before_tool_call');
    const ctx = createWeComCtx('alert-wrong-tool');
    const prompt = '最近一小时有哪些告警？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = beforeToolCall({
      toolName: 'napm-skill-query',
      params: { prompt }
    }, ctx);

    expect(result).toMatchObject({
      block: true
    });
    expect(result.blockReason).toContain('napm-alert-query');
  });

  test('should answer alert skill meta follow-up only from alert skill record', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const ctx = createWeComCtx('alert-meta-no-record');
    const prompt = '最近一小时有哪些告警？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    messageReceived({ content: '你使用的是告警查询skill么？' }, ctx);
    await beforePromptBuild({ prompt: '你使用的是告警查询skill么？' }, ctx);

    const result = await messageSending({
      content: '是的，使用的是 NAPM 告警查询专用工具 napm-alert-query，模式为 summary，告警总数为 0。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('当前没有可核验的 napm-alert-query 执行记录');
    expect(result.content).not.toContain('告警总数为 0');
  });

  test('should rewrite generic alert summary final answer to grouped category template from remembered result', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const ctx = createWeComCtx('alert-fixed-table');
    const prompt = '最近一小时有哪些告警？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      mode: 'summary',
      service: 'alertsSummary',
      narrationInput: { schema: 'openclaw_napm_alert.v1' },
      timeRange: { displayText: '最近一小时' },
      summary: {
        total: 2,
        bySeverity: { critical: 1, major: 1, minor: 0 }
      },
      events: [
        {
          id: '1',
          severity: 4,
          severityLabel: '紧急',
          categoryLabel: '应用性能告警',
          group: 'HTTPS',
          name: '外部应用性能下降',
          triggerCount: 1,
          period: 60,
          start: 1781680980
        },
        {
          id: '2',
          severity: 3,
          severityLabel: '重大',
          categoryLabel: '网络异常告警',
          group: '101.254.114.237',
          name: '数据库上传数据异常监控',
          triggerCount: 1,
          period: 60,
          start: 1781680980
        }
      ]
    }, plugin.__test__.getConversationKey(ctx));

    const result = await messageSending({
      content: '最近一小时告警主要集中在应用性能下降，建议进一步排查。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('① 应用性能告警 — 1 条');
    expect(result.content).toContain('② 网络异常告警 — 1 条');
    expect(result.content).toContain('- 🔴 外部应用性能下降触发：对象 HTTPS 触发了 1 次告警，持续时长为 1 分钟，开始时间为 2026-06-17 15:23。');
    expect(result.content).toContain('外部应用性能下降触发：对象 HTTPS 触发了 1 次告警，持续时长为 1 分钟，开始时间为 2026-06-17 15:23。');
    expect(result.content).not.toContain('建议进一步排查。');
  });

  test('should rewrite severity-grouped freeform alert answer when prompt punctuation differs', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const ctx = createWeComCtx('alert-punctuation-normalized');
    const prompt = '最近一小时有哪些告警';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    plugin.__test__.rememberSkillResult('最近一小时有哪些告警？', {
      ok: true,
      mode: 'summary',
      service: 'alertsSummary',
      criteria: { start: 1781677500, end: 1781681100, categories: [] },
      narrationInput: { schema: 'openclaw_napm_alert.v1' },
      timeRange: { displayText: '最近一小时' },
      summary: {
        total: 3,
        bySeverity: { critical: 1, major: 1, minor: 1 },
        byCategoryDetail: [
          {
            category: 'appAlerts',
            categoryLabel: '应用性能告警',
            total: 2,
            bySeverity: { critical: 1, major: 1, minor: 0 },
            overviewEvents: [
              {
                severity: 4,
                severityLabel: '紧急',
                group: 'HTTP',
                name: '内部应用性能下降',
                triggerCount: 1,
                period: 1,
                start: 1781680980
              }
            ]
          },
          {
            category: 'securityAlerts',
            categoryLabel: '安全事件告警',
            total: 1,
            bySeverity: { critical: 0, major: 0, minor: 1 },
            overviewEvents: [
              {
                severity: 2,
                severityLabel: '轻微',
                group: '101.254.114.242',
                name: '服务器疑似遭受攻击',
                triggerCount: 1,
                period: 1,
                start: 1781680980
              }
            ]
          }
        ]
      },
      events: []
    }, plugin.__test__.getConversationKey(ctx));

    const result = await messageSending({
      content: [
        '最近一小时（15:25 ~ 16:25）共触发 32 个告警，分布如下：',
        '🔴 紧急告警（6个）',
        'HTTP — 内部应用性能下降（16:07）',
        '🟠 重大告警（11个）',
        '另有8个应用性能重大告警',
        '🟢 轻微告警（15个）'
      ].join('\n')
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('① 应用性能告警 — 2 条');
    expect(result.content).toContain('② 安全事件告警 — 1 条');
    expect(result.content).toContain('🔴 紧急 1 条 | 🟠 重大 1 条');
    expect(result.content).toContain('🟢 轻微 1 条');
    expect(result.content).toContain('服务器疑似遭受攻击触发：对象 101.254.114.242 触发了 1 次告警，持续时长为 1 分钟，开始时间为 2026-06-17 15:23。');
    expect(result.content).not.toContain('🔴 紧急告警（6个）');
  });

  test('should rewrite freeform alert summary from latest alert record when prompt key misses', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const ctx = createWeComCtx('alert-latest-fallback');
    const prompt = '最近一小时有哪些告警';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    plugin.__test__.rememberSkillResult('tool-generated-alert-summary-prompt', {
      ok: true,
      mode: 'summary',
      service: 'alertsSummary',
      criteria: { categories: [] },
      narrationInput: { schema: 'openclaw_napm_alert.v1' },
      timeRange: { displayText: '最近一小时' },
      summary: {
        total: 2,
        bySeverity: { critical: 1, major: 1, minor: 0 },
        byCategoryDetail: [
          {
            category: 'appAlerts',
            categoryLabel: '应用性能告警',
            total: 1,
            bySeverity: { critical: 1, major: 0, minor: 0 },
            overviewEvents: [
              {
                severity: 4,
                severityLabel: '紧急',
                group: 'HTTP',
                name: '内部应用性能下降',
                triggerCount: 1,
                period: 1,
                start: 1781680980
              }
            ]
          },
          {
            category: 'networkIssueAlerts',
            categoryLabel: '网络异常告警',
            total: 1,
            bySeverity: { critical: 0, major: 1, minor: 0 },
            overviewEvents: [
              {
                severity: 3,
                severityLabel: '重大',
                group: '101.254.114.237',
                name: '数据库上传数据异常监控',
                triggerCount: 1,
                period: 5,
                start: 1781680980
              }
            ]
          }
        ]
      },
      events: []
    }, plugin.__test__.getConversationKey(ctx));

    const result = await messageSending({
      content: [
        'Now: Wed Jun 17 17:02 CST 2026 -> start≈16:02, end≈17:02. 最近一小时共触发 30 条告警，分布如下：',
        '① 应用性能告警 — 21 条（最多）',
        '🔴 紧急 1 条 | 🟠 重大 7 条 | 🟢 轻微 13 条',
        '当前最需要关注：',
        'HTTPS 外部应用性能下降持续13分钟'
      ].join('\n')
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('最近一小时告警汇总：共 2 条');
    expect(result.content).toContain('① 应用性能告警 — 1 条');
    expect(result.content).toContain('② 网络异常告警 — 1 条');
    expect(result.content).toContain('数据库上传数据异常监控触发：对象 101.254.114.237 触发了 1 次告警，持续时长为 5 分钟，开始时间为 2026-06-17 15:23。');
    expect(result.content).not.toContain('Now: Wed');
    expect(result.content).not.toContain('当前最需要关注');
  });
});
