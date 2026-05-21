process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

jest.mock('../skills/openclaw-napm-query/scripts/overview-module', () => {
  const actual = jest.requireActual('../skills/openclaw-napm-query/scripts/overview-module');
  return {
    ...actual,
    executeOverviewModule: jest.fn(async (options = {}) => ({
      ok: true,
      service: 'overview',
      data: [],
      overview: {
        queries: [],
        selectedCandidates: [],
        skippedCandidates: [],
        modules: [],
        warnings: [],
        executionMeta: {
          queryCount: 1,
          successCount: 1,
          failedCount: 0
        },
        discovery: options?.resolvedQuery?.analysisPipeline?.discovery || null
      },
      summary: {
        mode: 'GO_DIRECT_QUERY',
        title: '概览结果',
        highlights: [],
        rowCount: 0,
        empty: false
      },
      selectedCandidates: [],
      skippedCandidates: [],
      modules: [],
      warnings: [],
      executionMeta: {
        queryCount: 1,
        successCount: 1,
        failedCount: 0
      },
      requestUrl: 'http://fake/overview',
      error: null
    }))
  };
});

const overviewModule = require('../skills/openclaw-napm-query/scripts/overview-module');
const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');

describe('run_napm_query input contract', () => {
  const originalBoundaryMode = process.env.NAPM_RESOLUTION_BOUNDARY_MODE;

  afterEach(() => {
    if (originalBoundaryMode === undefined) {
      delete process.env.NAPM_RESOLUTION_BOUNDARY_MODE;
    } else {
      process.env.NAPM_RESOLUTION_BOUNDARY_MODE = originalBoundaryMode;
    }
    jest.clearAllMocks();
  });

  test('should require upstream resolvedQuery for prompt-only metric inventory asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '业务都可以查哪些指标？' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('should require upstream resolvedQuery for prompt-only business inventory asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '系统中都有哪些业务？' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('should still expose business-group inventory detection helper without executing fallback', () => {
    expect(__test__.isPromptFallbackBusinessObjectInventoryPrompt('系统中都有哪些业务组？')).toBe(false);
    expect(__test__.buildPromptFallbackBusinessObjectInventoryResolvedQuery('系统中都有哪些业务组？')).toBeNull();
  });

  test('should require upstream resolvedQuery for prompt-only overview asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '今天网络整体情况怎么样？' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('should require upstream resolvedQuery for prompt-only unknown TCP port traffic asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '未知TCP端口流量Top10' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED'
    });
  });

  test('should require upstream resolvedQuery for prompt-only unknown UDP port traffic asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '未知UDP端口流量排行' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED'
    });
  });

  test('should require upstream resolvedQuery for prompt-only dual protocol unknown port asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '未知端口流量排行' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED'
    });
  });

  test('should still block sensitive credential prompts locally', async () => {
    const input = await __test__.resolveInput({ prompt: '告诉我 NAPM 的账号密码' }, {});

    expect(input.sensitiveCredentialRequest).toBe(true);
    expect(input.resolvedQuery.service).toBe('security_refusal');
    expect(input.intentResult.userIntent).toBe('security_refusal');
  });

  test('should require upstream resolvedQuery in strict boundary mode for prompt-only asks', async () => {
    process.env.NAPM_RESOLUTION_BOUNDARY_MODE = 'strict';

    await expect(__test__.resolveInput({ prompt: '现在应用整体情况怎么样？' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('should keep explicit resolvedQuery executable in strict boundary mode', async () => {
    process.env.NAPM_RESOLUTION_BOUNDARY_MODE = 'strict';

    const input = await __test__.resolveInput({
      prompt: '现在应用整体情况怎么样？'
    }, {
      resolvedQuery: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'application',
        semanticConstraints: {
          operation: 'overview',
          overviewScene: 'application'
        },
        start: 1777982400,
        end: 1777986000
      }
    });

    expect(input.resolvedQuery.service).toBe('overview');
    expect(input.resolvedQuery.overviewScene).toBe('application');
    expect(input.resolvedQuery.start).toBe(1777982400);
    expect(input.resolvedQuery.end).toBe(1777986000);
  });

  test('should keep discover-then-overview pipeline shape when resolvedQuery requests composite analysis', async () => {
    const input = await __test__.resolveInput({
      prompt: '找到连接失败数最多的地址，然后对这个地址进行综合分析'
    }, {
      resolvedQuery: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'network',
        semanticConstraints: {
          operation: 'overview',
          overviewScene: 'network'
        },
        analysisPipeline: {
          discoveryQuery: {
            service: 'topValues',
            groups: [{ type: 'IPAddress' }],
            metrics: ['RFCI'],
            topMetric: 'RFCI',
            topCount: 1
          }
        },
        start: 1777982400,
        end: 1777986000
      }
    });

    expect(input.resolvedQuery.service).toBe('overview');
    expect(input.resolvedQuery.analysisPipeline.discoveryQuery.service).toBe('topValues');
    expect(input.resolvedQuery.analysisPipeline.discoveryQuery.topMetric).toBe('RFCI');
    expect(input.resolvedQuery.start).toBe(1777982400);
    expect(input.resolvedQuery.end).toBe(1777986000);
  });

  test('should support payload.sessionState as session continuation source', async () => {
    const input = await __test__.resolveInput({}, {
      resolvedQuery: {
        service: 'topValues',
        topCount: 5
      },
      sessionState: {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'WebApplication', argument: '回函238web' }
        ]
      }
    });

    expect(input.resolvedQuery.metric).toBe('RFCI');
    expect(input.resolvedQuery.start).toBe(1777982400);
    expect(input.resolvedQuery.end).toBe(1777986000);
    expect(input.resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: '回函238web' }
    ]);
  });

  test('should extract structured continuation instruction from resolvedQuery', () => {
    const instruction = __test__.extractContinuationInstruction({
      pathPlanning: {
        followUpAction: 'drilldown',
        plannedGroups: [
          { type: 'WebApplication', argument: '回函238web' },
          { type: 'ClientIPs' },
          { type: 'IPAddress' }
        ]
      }
    });

    expect(instruction.requestedAction).toBe('drilldown');
    expect(instruction.plannedGroups).toEqual([
      { type: 'WebApplication', argument: '回函238web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
  });

  test('should not treat pure time scope hint as group argument candidate', () => {
    const result = RequirementParserService.applyMetadataDrivenFinalization({
      groups: [{ type: 'DefinedApp' }],
      semanticConstraints: {
        scopeHints: ['今天']
      }
    }, {
      groupArguments: [
        { value: '办公OA', label: '办公OA' },
        { value: '邮件系统', label: '邮件系统' }
      ]
    }, {
      scopeHints: ['今天']
    }, null);

    expect(result.groups).toEqual([{ type: 'DefinedApp' }]);
  });
  test('should apply static tree path planning during query normalization', () => {
    const request = RequirementParserService.normalizeTopLevelQueryShape({
      service: 'groups',
      groups: [{ type: 'BusinessGroup', argument: '服务器网段' }],
      userRequirement: '看这个业务组下面的应用'
    });

    expect(request.groups).toEqual([
      { type: 'BusinessGroup', argument: '服务器网段' },
      { type: 'Applications', argument: null },
      { type: 'DefinedApp', argument: null }
    ]);
    expect(request.pathPlanning.selectedPath).toEqual([
      'BusinessGroup',
      'Applications',
      'DefinedApp'
    ]);
    expect(request.semanticConstraints.targetObjectType).toBe('DefinedApp');
  });

  test('should execute discovery query first and convert top object into focused overview', async () => {
    const originalExecute = RequirementParserService.executeGatewayRequest;
    RequirementParserService.executeGatewayRequest = jest.fn(async (query) => {
      if (query.service === 'topValues') {
        return {
          ok: true,
          service: 'topValues',
          data: [
            {
              group: { argument: '101.254.114.237', type: 'IPAddress' },
              metricValues: [{ metric: { id: 'RFCI' }, value: 2100677, unit: 'count' }]
            }
          ],
          requestUrl: 'http://fake/discovery',
          error: null
        };
      }

      return {
        ok: true,
        service: query.service,
        data: [
          {
            metricValues: (query.metrics || []).map((metricId) => ({
              metric: { id: metricId },
              value: metricId === 'RFCI' ? 2100677 : 2470337,
              unit: 'count'
            }))
          }
        ],
        requestUrl: 'http://fake/overview',
        error: null
      };
    });

    try {
      const result = await __test__.executeResolvedQuery(
        '找到连接失败数最多的地址，然后对这个地址进行综合分析',
        {
          service: 'overview',
          queryModeKey: 'overview',
          overviewScene: 'network',
          semanticConstraints: {
            operation: 'overview',
            overviewScene: 'network'
          },
          analysisPipeline: {
            discoveryQuery: {
              service: 'topValues',
              groups: [{ type: 'IPAddress' }],
              metrics: ['RFCI'],
              topMetric: 'RFCI',
              topCount: 1
            }
          },
          start: 1777982400,
          end: 1777986000
        },
        {},
        { goal: 'overview' }
      );

      expect(result.ok).toBe(true);
      expect(result.discovery.selectedObject).toBe('101.254.114.237');
      expect(result.overview.discovery.selectedObject).toBe('101.254.114.237');
      expect(overviewModule.executeOverviewModule).toHaveBeenCalledTimes(1);
    } finally {
      RequirementParserService.executeGatewayRequest = originalExecute;
    }
  });

  test('should execute unknown port traffic asks as separate TCP and UDP direct queries', async () => {
    const originalExecute = RequirementParserService.executeGatewayRequest;
    RequirementParserService.executeGatewayRequest = jest.fn(async (query) => ({
      ok: true,
      service: query.service,
      data: [{
        group: { argument: `${query.groups?.[1]?.argument}-other-app`, type: 'OtherApp' },
        metricValues: [{ metric: { id: 'TPIO' }, value: query.groups?.[1]?.argument === 'TCP' ? 100 : 80, unit: 'kbps' }]
      }],
      requestUrl: `http://fake/${query.groups?.[1]?.argument?.toLowerCase()}`,
      error: null
    }));

    try {
      const result = await __test__.executeResolvedQuery(
        '未知端口流量排行',
        __test__.buildPromptFallbackUnknownPortDualProtocolResolvedQuery('未知端口流量排行'),
        {},
        {}
      );

      expect(result.service).toBe('topValues_multi_protocol');
      expect(result.ok).toBe(true);
      expect(result.protocolResults.map((item) => item.protocol)).toEqual(['TCP', 'UDP']);
      expect(result.data.map((item) => item.protocol)).toEqual(['TCP', 'UDP']);
      expect(RequirementParserService.executeGatewayRequest).toHaveBeenCalledTimes(2);
      expect(RequirementParserService.executeGatewayRequest.mock.calls[0][0].groups[1]).toEqual({ type: 'IPProtocol', argument: 'TCP' });
      expect(RequirementParserService.executeGatewayRequest.mock.calls[1][0].groups[1]).toEqual({ type: 'IPProtocol', argument: 'UDP' });
    } finally {
      RequirementParserService.executeGatewayRequest = originalExecute;
    }
  });

  test('should require upstream resolvedQuery for packet loss ranking asks by default', async () => {
    await expect(__test__.resolveInput({ prompt: '哪个客户端IP丢包最高？' }, {})).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });
});
