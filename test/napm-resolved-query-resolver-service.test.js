const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');
const PromptRoutingService = require('../skills/openclaw-napm-query/services/PromptRoutingService');

describe('NapmResolvedQueryResolverService', () => {
  test('should resolve packet loss top IP prompt into strict topValues resolvedQuery', () => {
    const result = ResolverService.resolvePrompt('丢包最大的IP地址是谁？', {
      nowSeconds: 1779350400
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'topValues',
      queryModeKey: 'topn',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'PLI',
      groups: [{ type: 'IPAddress' }],
      topCount: 1,
      start: 1779346800,
      end: 1779350400,
      timeRange: { key: 'last1hour', displayText: '最近1小时' },
      semanticConstraints: {
        operation: 'rank_top',
        direction: 'desc'
      }
    });
    expect(result.resolvedQuery.resolutionHints.time).toMatchObject({
      source: 'time_range_resolver',
      key: 'last1hour',
      alignment: 'minute_floor'
    });
  });

  test('should resolve client IP packet loss prompt into IPAddress group for current skill contract', () => {
    const result = ResolverService.resolvePrompt('哪个客户端IP丢包最高？', {
      nowSeconds: 1779350400
    });

    expect(result.ok).toBe(true);
    expect(result.intent).toMatchObject({
      service: 'topValues',
      metric: 'PLI',
      groupType: 'IPAddress',
      topCount: 1
    });
    expect(result.resolvedQuery.groups).toEqual([{ type: 'IPAddress' }]);
  });

  test('should align generated topValues time range to minute boundaries', () => {
    const result = ResolverService.resolvePrompt('吞吐量最大的前10个IP地址是谁？', {
      nowSeconds: 1779366525
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'TPIO',
      groups: [{ type: 'IPAddress' }],
      topCount: 10,
      start: 1779362880,
      end: 1779366480
    });
    expect(result.resolvedQuery.start % 60).toBe(0);
    expect(result.resolvedQuery.end % 60).toBe(0);
  });

  test('should normalize externally provided root timestamps and strip nested executable timeRange timestamps', () => {
    const resolvedQuery = ResolverService.normalizeResolvedQueryTimeRange({
      service: 'topValues',
      start: 1779413047,
      end: 1779499449,
      timeRange: {
        key: 'custom',
        start: 1779413047,
        end: 1779499449
      }
    });

    expect(resolvedQuery.start).toBe(1779413040);
    expect(resolvedQuery.end).toBe(1779499440);
    expect(resolvedQuery.timeRange).toEqual({ key: 'custom' });
    expect(resolvedQuery.start % 60).toBe(0);
    expect(resolvedQuery.end % 60).toBe(0);
  });

  test('should reject executable data resolvedQuery that only carries time inside timeRange', () => {
    const result = ResolverService.validateResolvedQueryTimeContract({
      service: 'topValues',
      metric: 'PLI',
      metrics: ['PLI'],
      topMetric: 'PLI',
      groups: [{ type: 'IPAddress' }],
      timeRange: {
        key: 'custom',
        start: 1779413040,
        end: 1779499440
      }
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_root_execution_time',
      details: {
        service: 'topValues',
        hasRootStart: false,
        hasRootEnd: false,
        nestedTimeRangeProvided: true
      }
    });
  });

  test('should honor explicit last one hour prompt over default window', () => {
    const result = ResolverService.resolvePrompt('最近一小时连接失败数最多的是谁？', {
      nowSeconds: 1779413580
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'RFCI',
      metrics: ['RFCI'],
      topMetric: 'RFCI',
      groups: [{ type: 'IPAddress' }],
      topCount: 1,
      start: 1779409980,
      end: 1779413580,
      timeRange: { key: 'last1hour', displayText: '最近1小时' }
    });
  });

  test('should honor explicit last 24 hours prompt', () => {
    const result = ResolverService.resolvePrompt('过去24小时吞吐量最大的前10个IP地址是谁？', {
      nowSeconds: 1779413580
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'TPIO',
      topCount: 10,
      start: 1779327180,
      end: 1779413580,
      timeRange: { key: 'last24hours', displayText: '最近24小时' }
    });
  });

  test('should resolve explicit today prompt into dynamic root execution timestamps', () => {
    const result = ResolverService.resolvePrompt('今天吞吐量最大的前10个IP是谁？', {
      nowSeconds: 1779677977
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'topValues',
      metric: 'TPIO',
      topCount: 10,
      start: 1779638400,
      end: 1779724740,
      timeRange: {
        key: 'today',
        displayText: '今天'
      },
      resolutionHints: {
        time: {
          source: 'time_range_resolver',
          key: 'today',
          displayText: '今天'
        }
      }
    });
    expect(result.resolvedQuery.timeRange.start).toBeUndefined();
    expect(result.resolvedQuery.timeRange.end).toBeUndefined();
  });

  test('should resolve work group inventory prompt into groups metadata_list', () => {
    const result = ResolverService.resolvePrompt('系统中有哪些工作组？');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'BusinessGroup' }],
      semanticConstraints: {
        operation: 'metadata_list',
        workflowType: 'object_inventory',
        targetObjectType: 'BusinessGroup'
      }
    });
  });

  test('should resolve plain business inventory prompt into WebApplication metadata_list', () => {
    const result = ResolverService.resolvePrompt('现在系统中有哪些业务？');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'WebApplication' }],
      semanticConstraints: {
        operation: 'metadata_list'
      }
    });
  });

  test('should resolve metric inventory prompt into metrics metadata_list', () => {
    const result = ResolverService.resolvePrompt('业务都可以查哪些指标？');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'metrics',
      queryModeKey: 'metadata',
      groups: [{ type: 'WebApplication' }],
      semanticConstraints: {
        operation: 'metadata_list'
      }
    });
  });

  test('should resolve composite application inventory prompt into CompositeApplication metadata_list', () => {
    const result = ResolverService.resolvePrompt('系统中有哪些复合协议？');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'CompositeApplication' }],
      semanticConstraints: {
        operation: 'metadata_list'
      }
    });
  });

  test('should resolve auto-recognized application inventory prompt into CompositeApplication metadata_list', () => {
    [
      '系统中有哪些自动识别应用？',
      '系统中有哪些自动识别的应用？',
      '系统中有哪些自动识别出来的应用？',
      '系统中有哪些系统自动识别的应用？'
    ].forEach((prompt) => {
      const result = ResolverService.resolvePrompt(prompt);

      expect(result.ok).toBe(true);
      expect(result.resolvedQuery).toMatchObject({
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'CompositeApplication' }],
        semanticConstraints: {
          operation: 'metadata_list'
        }
      });
    });
  });

  test('should reject plain application inventory prompt as ambiguous', () => {
    const result = ResolverService.resolvePrompt('系统中有哪些应用？');

    expect(result).toMatchObject({
      ok: false,
      reason: 'ambiguous_application_catalog',
      diagnostics: {
        ambiguousObject: 'Application',
        candidates: expect.arrayContaining([
          'WebApplication',
          'DefinedApp',
          'BuiltinApplication',
          'CompositeApplication',
          'OtherApp'
        ])
      }
    });
  });

  test('should keep composite application wording out of DefinedApp prompt routing', () => {
    expect(PromptRoutingService.inferMetricInventoryGroup('复合协议都可以查哪些指标？')).toBe('CompositeApplication');
    expect(PromptRoutingService.inferMetricInventoryGroup('自动识别的应用都可以查哪些指标？')).toBe('CompositeApplication');
    expect(PromptRoutingService.normalizeHierarchyQuestionTarget('CompositeApplication 可以往下钻到哪里？')).toBe('CompositeApplication');
    expect(PromptRoutingService.resolvePromptRoute('系统中有哪些应用？')).toMatchObject({
      routeType: 'ambiguous_application_inventory'
    });
  });

  test('should resolve hierarchy prompt into drilldown catalog', () => {
    const result = ResolverService.resolvePrompt('BusinessGroup 可以往下钻到哪里？');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'drilldownCatalog',
      queryModeKey: 'metadata',
      groups: [{ type: 'BusinessGroup' }],
      semanticConstraints: {
        operation: 'drilldown_catalog'
      }
    });
  });
  test('should resolve plain business hierarchy prompt into WebApplication drilldown catalog', () => {
    const result = ResolverService.resolvePrompt('\u4e1a\u52a1\u6709\u54ea\u4e9b\u4e0b\u94bb\u8def\u5f84\uff1f');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'drilldownCatalog',
      queryModeKey: 'metadata',
      groups: [{ type: 'WebApplication' }],
      semanticConstraints: {
        operation: 'drilldown_catalog',
        targetObjectType: 'WebApplication'
      }
    });
  });

  test('should keep explicit business group hierarchy prompt as BusinessGroup', () => {
    const result = ResolverService.resolvePrompt('\u4e1a\u52a1\u7ec4\u6709\u54ea\u4e9b\u4e0b\u94bb\u8def\u5f84\uff1f');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'drilldownCatalog',
      queryModeKey: 'metadata',
      groups: [{ type: 'BusinessGroup' }],
      semanticConstraints: {
        operation: 'drilldown_catalog',
        targetObjectType: 'BusinessGroup'
      }
    });
  });
});
