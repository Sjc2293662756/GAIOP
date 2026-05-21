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
      start: 1779264000,
      end: 1779350400,
      timeRange: { key: 'last24hours' },
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
