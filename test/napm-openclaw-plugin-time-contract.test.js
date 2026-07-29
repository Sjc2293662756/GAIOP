const path = require('path');
const TimeRangeService = require('../skills/openclaw-napm-query/services/ResolvedQueryTimeRangeService');

describe('napm-openclaw-plugin resolvedQuery time contract guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
      return;
    }
    process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
  });

  function createHarness() {
    const hooks = new Map();
    const api = {
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
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
    return { hooks };
  }

  test('should reject executable timestamps carried only by timeRange at plugin boundary', async () => {
    const { hooks } = createHarness();
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-time-contract',
      conversationId: 'conv-time-contract',
      sessionKey: 'session-time-contract',
      sessionId: 'session-time-contract',
      runId: 'run-time-contract'
    };
    const prompt = '丢包率最高的IP是谁？';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'topValues',
          queryModeKey: 'topn',
          groups: [{ type: 'IPAddress' }],
          metrics: ['PLI'],
          topMetric: 'PLI',
          topCount: 1,
          timeRange: {
            start: 1779638400,
            end: 1779724799
          },
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('root-level start/end');
    expect(result.blockReason).toContain('timeRange.start/timeRange.end');
  });

  test('should recompute a keyed window instead of trusting stale root timestamps', async () => {
    jest.useFakeTimers().setSystemTime(new Date(1779677977000));
    try {
    const { hooks } = createHarness();
    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-time-contract-ok',
      conversationId: 'conv-time-contract-ok',
      sessionKey: 'session-time-contract-ok',
      sessionId: 'session-time-contract-ok',
      runId: 'run-time-contract-ok'
    };
    const prompt = '丢包率最高的IP是谁？';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'topValues',
          queryModeKey: 'topn',
          groups: [{ type: 'IPAddress' }],
          metrics: ['PLI'],
          topMetric: 'PLI',
          topCount: 1,
          start: 1779638400,
          end: 1779724740,
          timeRange: {
            key: 'today',
            displayText: '今天'
          },
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.params).toMatchObject({
      resolvedQuery: {
        service: 'topValues',
        start: 1779638400,
        end: 1779677940
      }
    });
    } finally {
      jest.useRealTimers();
    }
  });

  test('tool execute should return boundary error before calling skill for malformed time contract', async () => {
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
      registerHook() {}
    };
    plugin.register(api);

    const result = await tools.get('napm-skill-query').execute('tool-time-contract', {
      prompt: '丢包率最高的IP是谁？',
      userQuery: '丢包率最高的IP是谁？',
      resolvedQuery: {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'IPAddress' }],
        metrics: ['PLI'],
        topMetric: 'PLI',
        topCount: 1,
        timeRange: {
          start: 1779638400,
          end: 1779724799
        },
        format: 'json'
      }
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.error.code).toBe('UPSTREAM_RESOLVED_QUERY_INVALID');
    expect(result.details.error.reason).toBe('invalid_time_field_location');
    expect(result.details.resolvedQuerySummary.hasNestedTimeRangeStart).toBe(true);
    expect(result.details.resolvedQuerySummary.start).toBeNull();
  });
  test('should resolve deterministic time range patches for OpenClaw construction', () => {
    const result = TimeRangeService.resolveTimeRange({
      timeRangeKey: 'last1hour',
      prompt: 'last hour'
    }, {
      nowSeconds: 1779952020
    });

    expect({
      ok: true,
      ...result,
      resolvedQueryPatch: {
        start: result.start,
        end: result.end,
        timeRange: {
          key: result.key
        },
        resolutionHints: {
          time: {
            source: result.source,
            key: result.key
          }
        }
      }
    }).toMatchObject({
      ok: true,
      source: 'time_range_resolver',
      key: 'last1hour',
      start: 1779948420,
      end: 1779952020,
      resolvedQueryPatch: {
        start: 1779948420,
        end: 1779952020,
        timeRange: {
          key: 'last1hour'
        },
        resolutionHints: {
          time: {
            source: 'time_range_resolver',
            key: 'last1hour'
          }
        }
      }
    });
  });

  test('should reject relative time timestamps that drift far from current server time', () => {
    const validation = plugin.__test__.validateResolvedQueryAgainstSpec({
      service: 'topValues',
      queryModeKey: 'data',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 10,
      start: 1811120820,
      end: 1811124420,
      timeRange: {
        key: 'last1hour',
        displayText: '最近一小时'
      },
      resolutionHints: {
        time: {
          source: 'message_timestamp',
          originalTime: '2026-05-28 15:07',
          alignment: 'minute_floor'
        }
      }
    }, {
      nowSeconds: 1779952020
    });

    expect(validation.ok).toBe(false);
    expect(validation.reason).toBe('relative_time_range_stale_or_miscalculated');
    expect(validation.message).toContain('napm-resolve-time-range');
    expect(validation.details).toMatchObject({
      timeRangeKey: 'last1hour',
      expectedStart: 1779948420,
      expectedEnd: 1779952020
    });
  });
});
