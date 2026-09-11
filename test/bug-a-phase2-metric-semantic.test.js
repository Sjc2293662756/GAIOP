'use strict';

const MetricSemanticNormalizerService = require('../skills/openclaw-napm-query/services/MetricSemanticNormalizerService');

describe('BUG-A Phase 2 MetricSemanticNormalizerService', () => {
  test('resolves slow business access to PGTME from canonical metric rules', () => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic(
      '最近业务访问较慢的前5个业务都有谁？',
      { targetObjectType: 'WebApplication' }
    )).toMatchObject({
      status: 'resolved',
      primaryMetric: 'PGTME',
      requestedMetrics: ['PGTME'],
      source: {
        type: 'resolution_spec_metric_semantic_rules'
      }
    });
  });

  test.each([
    ['慢页面数量最多的前5个业务', 'WebApplication', 'PGNSLPGE'],
    ['服务器响应时间最高的前5个已定义应用', 'DefinedApp', 'TRTI'],
    ['网络时延最高的前5个IP', 'IPAddress', 'RTTI']
  ])('uses object-constrained metric semantics: %s', (prompt, targetObjectType, metricId) => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic(prompt, {
      targetObjectType
    })).toMatchObject({
      status: 'resolved',
      primaryMetric: metricId,
      requestedMetrics: [metricId]
    });
  });

  test('prefers the specific slow-page-count phrase over generic slow semantics', () => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic(
      '慢页面数量最多的前5个业务',
      { targetObjectType: 'WebApplication' }
    )).toMatchObject({
      status: 'resolved',
      primaryMetric: 'PGNSLPGE',
      requestedMetrics: ['PGNSLPGE'],
      matchedRuleIds: ['web-slow-page-count']
    });
  });

  test('prefers an explicit catalog metric ID over an overlapping semantic phrase', () => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic('PLI', {
      targetObjectType: 'IPAddress',
      metricCatalog: {
        PLI: { domain: 'network_performance' },
        RTTI: { domain: 'network_performance' }
      },
      metricSemanticRules: {
        schemaVersion: 'test.v1',
        explicitMetricIdsFromCatalog: true,
        rules: [
          { id: 'misleading-phrase', metricId: 'RTTI', priority: 999, specificity: 999, phrases: ['PLI'] }
        ]
      }
    })).toMatchObject({
      status: 'resolved',
      primaryMetric: 'PLI',
      requestedMetrics: ['PLI'],
      matchedRuleIds: ['explicit-metric-id']
    });
  });

  test('returns ambiguous candidates instead of selecting the first equal rule', () => {
    const result = MetricSemanticNormalizerService.resolveMetricSemantic('同义指标', {
      targetObjectType: 'IPAddress',
      metricCatalog: {
        PLI: { domain: 'network_performance' },
        RTTI: { domain: 'network_performance' }
      },
      metricSemanticRules: {
        schemaVersion: 'test.v1',
        explicitMetricIdsFromCatalog: false,
        rules: [
          { id: 'left', metricId: 'PLI', priority: 10, specificity: 10, phrases: ['同义指标'] },
          { id: 'right', metricId: 'RTTI', priority: 10, specificity: 10, phrases: ['同义指标'] }
        ]
      }
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      primaryMetric: null,
      requestedMetrics: [],
      candidates: ['PLI', 'RTTI']
    });
  });

  test('keeps multiple requested metrics without forcing a primary metric', () => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic(
      '同时查看访问量、页面响应时间和 HTTP500',
      { targetObjectType: 'WebApplication' }
    )).toMatchObject({
      status: 'resolved',
      primaryMetric: null,
      requestedMetrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      rankingMetric: null
    });
  });

  test('keeps rankingMetric independent from requestedMetrics', () => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic(
      '同时查看流入吞吐量和流出吞吐量，按总吞吐量排行前10',
      {
        targetObjectType: 'IPAddress',
        rankingMetricText: '总吞吐量'
      }
    )).toMatchObject({
      status: 'resolved',
      primaryMetric: null,
      requestedMetrics: ['TPI', 'TPO'],
      rankingMetric: 'TPIO'
    });
  });

  test('uses object constraints for disambiguation without becoming an execution hard gate', () => {
    expect(MetricSemanticNormalizerService.resolveMetricSemantic(
      '业务的服务器响应时间',
      { targetObjectType: 'WebApplication' }
    )).toMatchObject({
      status: 'resolved',
      primaryMetric: 'TRTI',
      requestedMetrics: ['TRTI']
    });
  });
});
