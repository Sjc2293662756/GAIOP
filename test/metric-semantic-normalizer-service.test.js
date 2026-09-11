const MetricSemanticNormalizerService = require('../skills/openclaw-napm-query/services/MetricSemanticNormalizerService');

describe('MetricSemanticNormalizerService', () => {
  test.each([
    ['400错误', 'PGHTTP400'],
    ['400报错', 'PGHTTP400'],
    ['HTTP400异常', 'PGHTTP400'],
    ['4xx错误最多', 'PGHTTP400'],
    ['出现 400 状态码', 'PGHTTP400'],
    ['500错误', 'PGHTTP500'],
    ['500报错', 'PGHTTP500'],
    ['HTTP500异常', 'PGHTTP500'],
    ['5xx错误最多', 'PGHTTP500']
  ])('should normalize %s to %s', (prompt, expectedMetric) => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic(prompt);

    expect(result).toMatchObject({
      metric: expectedMetric,
      source: {
        type: 'resolution_spec_metric_semantic_rules'
      }
    });
  });

  test('should map the reported total-traffic trend wording with canonical machine rules', () => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic(
      '最近一天的总流量的趋势怎么样？'
    );

    expect(result).toMatchObject({
      metric: 'TPIO',
      source: { type: 'resolution_spec_metric_semantic_rules' },
      matchedAlias: '流量的趋势'
    });
  });

  test('should ignore deprecated caller-provided metric aliases', () => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic('仅旧别名', {
      specMetricAliases: {
        PGNPGE: ['仅旧别名']
      }
    });

    expect(result).toMatchObject({
      status: 'unresolved',
      primaryMetric: null,
      requestedMetrics: []
    });
  });

  test.each([
    ['最近一天总流量趋势', 'TPIO'],
    ['总流量速率', 'TPIO'],
    ['累计流量', 'BYTIO'],
    ['流量大小', 'BYTIO']
  ])('should use the most specific canonical rule for traffic semantics: %s', (prompt, expectedMetric) => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic(prompt);

    expect(result).toMatchObject({
      metric: expectedMetric,
      source: { type: 'resolution_spec_metric_semantic_rules' }
    });
  });

  test('should expose semantic presence for workflow arbitration', () => {
    expect(MetricSemanticNormalizerService.hasMetricSemantic('有哪些页面出现400报错')).toBe(true);
    expect(MetricSemanticNormalizerService.hasMetricSemantic('系统中有哪些业务')).toBe(false);
  });
});
