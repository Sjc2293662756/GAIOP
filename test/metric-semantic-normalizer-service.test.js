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
      source: 'metric_semantic_normalizer'
    });
  });

  test('should prefer resolution spec aliases when provided', () => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic('页面访问数最多', {
      specMetricAliases: {
        PGNPGE: ['页面访问数']
      }
    });

    expect(result).toMatchObject({
      metric: 'PGNPGE',
      source: 'resolution_spec_alias',
      matchedAlias: '页面访问数'
    });
  });

  test('should expose semantic presence for workflow arbitration', () => {
    expect(MetricSemanticNormalizerService.hasMetricSemantic('有哪些页面出现400报错')).toBe(true);
    expect(MetricSemanticNormalizerService.hasMetricSemantic('系统中有哪些业务')).toBe(false);
  });
});
