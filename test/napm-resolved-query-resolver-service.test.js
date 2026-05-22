const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');

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
      timeRange: { key: 'last1hour' },
      semanticConstraints: {
        operation: 'rank_top',
        direction: 'desc'
      }
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

  test('should normalize externally provided resolvedQuery timestamps to minute boundaries', () => {
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
    expect(resolvedQuery.timeRange.start).toBe(1779413040);
    expect(resolvedQuery.timeRange.end).toBe(1779499440);
    expect(resolvedQuery.start % 60).toBe(0);
    expect(resolvedQuery.end % 60).toBe(0);
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
      timeRange: { key: 'last1hour' }
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
      timeRange: { key: 'last24hours' }
    });
  });

  test('should resolve work group inventory prompt into groups metadata_list', () => {
    const result = ResolverService.resolvePrompt('系统中有哪些工作组？');

    expect(result.ok).toBe(true);
    expect(result.resolvedQuery).toMatchObject({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'BusinessGroup' }],
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
});
