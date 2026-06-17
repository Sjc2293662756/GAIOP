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

  test('should rewrite alert summary final answer to fixed table from remembered result', async () => {
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
          name: '外部应用性能下降'
        },
        {
          id: '2',
          severity: 3,
          severityLabel: '重大',
          categoryLabel: '网络异常告警',
          group: '101.254.114.237',
          name: '数据库上传数据异常监控'
        }
      ]
    }, '');

    const result = await messageSending({
      content: '最近一小时告警主要集中在应用性能下降，建议进一步排查。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('| 级别 | 类型 | 对象 | 描述 |');
    expect(result.content).toContain('| 🔴 紧急 | 应用性能 | HTTPS | 外部应用性能下降 |');
    expect(result.content).not.toContain('建议进一步排查。');
  });
});
