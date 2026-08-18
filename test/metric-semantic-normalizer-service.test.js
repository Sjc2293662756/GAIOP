const MetricSemanticNormalizerService = require('../skills/openclaw-napm-query/services/MetricSemanticNormalizerService');
const ResolutionSpecService = require('../skills/openclaw-napm-query/services/ResolutionSpecService');

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

  test('should map the reported total-traffic trend wording with the real spec aliases', () => {
    const metricSpec = ResolutionSpecService.getMetricSpec();
    const result = MetricSemanticNormalizerService.resolveMetricSemantic(
      '最近一天的总流量的趋势怎么样？',
      { specMetricAliases: metricSpec.aliases }
    );

    expect(result).toMatchObject({
      metric: 'TPIO',
      source: 'resolution_spec_alias',
      matchedAlias: '流量的趋势'
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

  test.each([
    ['最近一天总流量趋势', 'TPIO'],
    ['总流量速率', 'TPIO'],
    ['累计流量', 'BYTIO'],
    ['流量大小', 'BYTIO']
  ])('should use longest spec aliases for traffic semantics: %s', (prompt, expectedMetric) => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic(prompt, {
      specMetricAliases: {
        TPIO: ['流量趋势', '流量速率', '吞吐', '带宽'],
        BYTIO: ['累计流量', '流量大小', '流量', '字节数']
      }
    });

    expect(result).toMatchObject({
      metric: expectedMetric,
      source: 'resolution_spec_alias'
    });
  });

  test('should expose semantic presence for workflow arbitration', () => {
    expect(MetricSemanticNormalizerService.hasMetricSemantic('有哪些页面出现400报错')).toBe(true);
    expect(MetricSemanticNormalizerService.hasMetricSemantic('系统中有哪些业务')).toBe(false);
  });
});
