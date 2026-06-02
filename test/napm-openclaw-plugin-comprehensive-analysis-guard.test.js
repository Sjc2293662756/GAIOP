const path = require('path');

describe('napm-openclaw-plugin comprehensive analysis guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
      return;
    }
    process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
  });

  function createHarness(suffix = 'comprehensive-analysis') {
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
    const ctx = {
      channelId: 'wecom',
      accountId: `acct-${suffix}`,
      conversationId: `conv-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };

    return { hooks, ctx };
  }

  function currentWindow() {
    const end = Math.floor(Date.now() / 60000) * 60;
    return {
      start: end - 3600,
      end
    };
  }

  test('should classify why/analyze ranking prompt as discover-then-analyze', () => {
    const testApi = plugin.__test__;

    expect(testApi.isComprehensiveAnalysisPrompt('丢包最严重的 IP 是谁，为什么？')).toBe(true);
    expect(testApi.isDiscoverThenAnalyzePrompt('丢包最严重的 IP 是谁，为什么？')).toBe(true);
    expect(testApi.isComprehensiveAnalysisPrompt('最近一小时丢包最高的前10个IP')).toBe(false);
  });

  test('should reject topValues when prompt asks for reason analysis', async () => {
    const { hooks, ctx } = createHarness('reject-topvalues');
    const prompt = '丢包最严重的 IP 是谁，为什么？';
    const time = currentWindow();

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
          metrics: ['PLI', 'PLO'],
          topMetric: 'PLI',
          topCount: 1,
          start: time.start,
          end: time.end,
          timeRange: { key: 'last1hour', displayText: '最近一小时' },
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('comprehensive discover-then-analyze');
    expect(result.blockReason).toContain('analysisMode="discover_then_analyze"');
  });

  test('should allow plain topValues ranking without analysis intent', async () => {
    const { hooks, ctx } = createHarness('allow-topvalues');
    const prompt = '最近一小时丢包最高的前10个IP';
    const time = currentWindow();

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
          metrics: ['PLI', 'PLO'],
          topMetric: 'PLI',
          topCount: 10,
          start: time.start,
          end: time.end,
          timeRange: { key: 'last1hour', displayText: '最近一小时' },
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result?.block).not.toBe(true);
    if (result?.params) {
      expect(result.params.resolvedQuery.service).toBe('topValues');
    }
  });

  test('should allow correct discover-then-analyze resolvedQuery', async () => {
    const { hooks, ctx } = createHarness('allow-analysis-pipeline');
    const prompt = '找到连接失败最多的地址，然后分析它';
    const time = currentWindow();

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'overview',
          queryModeKey: 'overview',
          analysisType: 'comprehensive_analysis',
          analysisMode: 'discover_then_analyze',
          analysisScene: 'network',
          overviewScene: 'network',
          analysisPipeline: {
            targetObjectType: 'IPAddress',
            selection: { rank: 1 },
            discoveryQuery: {
              service: 'topValues',
              queryModeKey: 'topn',
              groups: [{ type: 'IPAddress' }],
              metrics: ['RFCI'],
              topMetric: 'RFCI',
              topCount: 1
            }
          },
          start: time.start,
          end: time.end,
          timeRange: { key: 'last1hour', displayText: '最近一小时' },
          format: 'json'
        }
      }
    }, ctx);

    expect(result?.block).not.toBe(true);
    if (result?.params) {
      expect(result.params.resolvedQuery.service).toBe('overview');
      expect(result.params.resolvedQuery.analysisMode).toBe('discover_then_analyze');
      expect(result.params.resolvedQuery.analysisPipeline.discoveryQuery.start).toBeUndefined();
    }
  });

  test('should reject discover-then-analyze when discoveryQuery carries execution time', async () => {
    const { hooks, ctx } = createHarness('reject-discovery-time');
    const prompt = '哪个业务 HTTP 500 最严重，并分析原因？';
    const time = currentWindow();

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = await hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        userQuery: prompt,
        resolvedQuery: {
          service: 'overview',
          queryModeKey: 'overview',
          analysisType: 'comprehensive_analysis',
          analysisMode: 'discover_then_analyze',
          analysisScene: 'business',
          overviewScene: 'business',
          analysisPipeline: {
            targetObjectType: 'WebApplication',
            discoveryQuery: {
              service: 'topValues',
              groups: [{ type: 'WebApplication' }],
              metrics: ['PGHTTP500'],
              topMetric: 'PGHTTP500',
              topCount: 1,
              start: time.start,
              end: time.end
            }
          },
          start: time.start,
          end: time.end,
          timeRange: { key: 'last1hour', displayText: '最近一小时' },
          format: 'json'
        }
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('discoveryQuery must not contain start/end');
  });
});
