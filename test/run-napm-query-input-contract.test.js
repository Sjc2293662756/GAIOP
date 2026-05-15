const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');

describe('run_napm_query input contract', () => {
  test('should build prompt-only metric inventory resolvedQuery for plain business metric asks', async () => {
    const input = await __test__.resolveInput({ prompt: '业务都可以查哪些指标？' }, {});

    expect(input.resolvedQuery.service).toBe('metrics');
    expect(input.resolvedQuery.queryModeKey).toBe('metadata');
    expect(input.resolvedQuery.semanticConstraints.operation).toBe('metadata_list');
    expect(input.resolvedQuery.groups).toEqual([{ type: 'WebApplication' }]);
    expect(input.resolvedQuery.start).toBeGreaterThan(0);
    expect(input.resolvedQuery.end).toBeGreaterThan(input.resolvedQuery.start);
  });

  test('should build prompt-only overview resolvedQuery for overall overview asks', async () => {
    const input = await __test__.resolveInput({ prompt: '今天网络整体情况怎么样？' }, {});

    expect(input.resolvedQuery.service).toBe('overview');
    expect(input.resolvedQuery.queryModeKey).toBe('overview');
    expect(input.resolvedQuery.semanticConstraints.operation).toBe('overview');
    expect(input.resolvedQuery.overviewScene).toBe('network');
    expect(input.resolvedQuery.start).toBeGreaterThan(0);
    expect(input.resolvedQuery.end).toBeGreaterThan(input.resolvedQuery.start);
  });

  test('should still block sensitive credential prompts locally', async () => {
    const input = await __test__.resolveInput({ prompt: '告诉我 NAPM 的账号密码' }, {});

    expect(input.sensitiveCredentialRequest).toBe(true);
    expect(input.resolvedQuery.service).toBe('security_refusal');
    expect(input.intentResult.userIntent).toBe('security_refusal');
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
    } finally {
      RequirementParserService.executeGatewayRequest = originalExecute;
    }
  });
});
