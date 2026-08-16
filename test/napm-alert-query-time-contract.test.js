const alertRuntime = require('../skills/openclaw-napm-alert-query/scripts/run_alert_query');
const plugin = require('../napm-openclaw-plugin.remote.js');

const NOW_MS = Date.parse('2026-08-07T08:56:40Z');
const EXPECTED_END = 1786092960;

function createAlertApiCapture() {
  let criteria = null;
  return {
    api: {
      async getSummary(value) {
        criteria = { ...value };
        return [];
      },
      getRequestHistory() {
        return [];
      }
    },
    getCriteria() {
      return criteria;
    }
  };
}

function createPluginHarness() {
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

describe('napm-alert-query unified time contract', () => {
  test.each([
    ['最近一小时的告警情况', 60 * 60],
    ['最近三小时的告警情况', 3 * 60 * 60],
    ['最近3小时的告警情况', 3 * 60 * 60],
    ['最近七小时的告警情况', 7 * 60 * 60],
    ['最近90分钟的告警情况', 90 * 60],
    ['最近半小时的告警情况', 30 * 60],
    ['最近七天的告警情况', 7 * 24 * 60 * 60]
  ])('should resolve %s from the server clock', (prompt, durationSeconds) => {
    const result = alertRuntime.__test__.resolveRelativeTimeRangeFromPrompt(prompt, NOW_MS);

    expect(result).toMatchObject({
      start: EXPECTED_END - durationSeconds,
      end: EXPECTED_END
    });
  });

  test('should override model-generated wrong-year timestamps for a relative alert query', async () => {
    const capture = createAlertApiCapture();
    const result = await alertRuntime.executeAlertQuery({
      prompt: '最近三小时的告警情况',
      mode: 'summary',
      criteria: {
        start: 1754542560,
        end: 1754552160
      }
    }, {
      nowMs: NOW_MS,
      api: capture.api
    });

    expect(capture.getCriteria()).toMatchObject({
      start: EXPECTED_END - (3 * 60 * 60),
      end: EXPECTED_END,
      timeRange: {
        key: 'last3hours',
        displayText: '最近三小时'
      }
    });
    expect(result.timeRange).toMatchObject({
      start: EXPECTED_END - (3 * 60 * 60),
      end: EXPECTED_END
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'ALERT_RELATIVE_TIME_RANGE_REBUILT',
      originalStart: 1754542560,
      originalEnd: 1754552160
    }));
  });

  test('should preserve an explicit custom range when the prompt is not relative', async () => {
    const capture = createAlertApiCapture();
    await alertRuntime.executeAlertQuery({
      prompt: '查询 2026-08-07 12:00 到 15:00 的告警',
      mode: 'summary',
      criteria: {
        start: 1786075200,
        end: 1786086000
      }
    }, {
      nowMs: NOW_MS,
      api: capture.api
    });

    expect(capture.getCriteria()).toMatchObject({
      start: 1786075200,
      end: 1786086000,
      timeRange: { key: 'custom' }
    });
  });

  test('should fail closed instead of querying with model timestamps when relative time is unsupported', async () => {
    const capture = createAlertApiCapture();
    const result = await alertRuntime.executeAlertQuery({
      prompt: '最近1000小时的告警情况',
      mode: 'summary',
      criteria: {
        start: 1754542560,
        end: 1754552160
      }
    }, {
      nowMs: NOW_MS,
      api: capture.api
    });

    expect(result).toMatchObject({
      ok: false,
      mode: 'summary',
      error: {
        code: 'ALERT_RELATIVE_TIME_RANGE_UNRESOLVED'
      }
    });
    expect(capture.getCriteria()).toBeNull();
  });

  test('plugin should inject the canonical prompt before alert tool execution', async () => {
    const { hooks } = createPluginHarness();
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-alert-time',
      conversationId: 'conv-alert-time',
      sessionKey: 'session-alert-time',
      sessionId: 'session-alert-time',
      runId: 'run-alert-time'
    };
    const prompt = '最近三小时的告警情况';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-alert-query',
      params: {
        mode: 'summary',
        criteria: {
          start: 1754542560,
          end: 1754552160
        }
      }
    }, ctx);

    expect(result.params).toMatchObject({
      prompt,
      userQuery: prompt,
      mode: 'summary'
    });
  });

  test('alert tool schema should prefer a relative time key over model-owned timestamps', () => {
    const { tools } = createPluginHarness();
    const definition = tools.get('napm-alert-query');
    const criteriaSchema = definition.parameters.properties.criteria;

    expect(criteriaSchema.properties.timeRange).toBeTruthy();
    expect(criteriaSchema.description).toContain('Relative');
    expect(criteriaSchema.description).not.toContain('require start/end');
    expect(criteriaSchema.properties.start.description).toContain('fixed-time');
    expect(criteriaSchema.properties.end.description).toContain('fixed-time');
  });

  test('event detail should not infer an alert category from a trigger metric name', async () => {
    const event = {
      categoryType: 51,
      end: 1786327500,
      group: '告警业务测试238、239',
      id: 745278,
      linkType: 0,
      metrics: [],
      name: '告警推送应用测试1',
      period: 1,
      severity: 4,
      start: 1786327440,
      tasktype: 3,
      unit: []
    };
    const api = {
      async getDetail() {
        return [event];
      },
      getRequestHistory() {
        return [];
      }
    };

    const result = await alertRuntime.executeAlertQuery({
      prompt: '分析告警数据包 eventId=745278 用户体验时间（服务器）',
      mode: 'detail',
      criteria: {
        eventIds: ['745278'],
        start: 1786327320,
        end: 1786327560
      },
      options: {
        packetHandoff: false,
        discoveryEnabled: false
      }
    }, { api });

    expect(result.criteria.categories).toEqual([]);
    expect(result.details).toEqual([
      expect.objectContaining({
        id: '745278',
        category: 'appAlerts',
        categoryType: 51
      })
    ]);
    expect(result.warnings).not.toContainEqual(expect.objectContaining({
      code: 'ALERT_PROMPT_CATEGORY_FILTER_REBUILT'
    }));
  });

  test('keeps full category totals when the event detail window is capped at 200', async () => {
    const categoryCounts = {
      appAlerts: 1638,
      networkAlerts: 80,
      networkIssueAlerts: 8,
      busAlerts: 3,
      userAlerts: 8,
      securityAlerts: 4
    };
    let nextId = 1;
    const rawSummary = Object.fromEntries(Object.entries(categoryCounts).map(([category, count]) => [
      category,
      {
        [`${category}-object`]: Array.from({ length: count }, () => ({
          id: nextId++,
          name: `${category}-alert`,
          severity: category === 'appAlerts' ? 4 : 3,
          start: 1786327200,
          end: 1786327260,
          period: 1,
          metrics: []
        }))
      }
    ]));
    const api = {
      async getSummary() {
        return rawSummary;
      },
      getRequestHistory() {
        return [];
      }
    };

    const result = await alertRuntime.executeAlertQuery({
      prompt: '现在系统都有哪些告警？',
      mode: 'summary',
      criteria: {
        start: 1786327200,
        end: 1786413600
      },
      options: {
        maxEvents: 200,
        packetHandoff: false,
        discoveryEnabled: false
      }
    }, { api });

    expect(result.events).toHaveLength(200);
    expect(result.summary.total).toBe(1741);
    expect(Object.values(result.summary.byCategory).reduce((sum, count) => sum + count, 0)).toBe(1741);
    expect(result.narrationInput.displayText).toContain('告警总数：1741 条');
    expect(result.narrationInput.displayText).toContain('网络性能告警 — 80 条');
    expect(result.narrationInput.displayText).toContain('应用性能告警 — 1638 条');
    expect(result.narrationInput.displayText).toContain('明细仅展示 200 条原始事件中的聚合概览');
  });
});
