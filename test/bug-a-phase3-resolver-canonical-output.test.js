'use strict';

const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');
const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');

describe('BUG-A Phase 3 Semantic to canonical ResolvedQuery mapping', () => {
  test('maps slow-business Top5 without emitting the legacy metric field', () => {
    const result = ResolverService.resolvePrompt(
      '最近业务访问较慢的前5个业务都有谁？',
      { nowSeconds: 1788940800 }
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGTME'],
        topMetric: 'PGTME',
        topCount: 5,
        start: 1788937200,
        end: 1788940800
      }
    });
    expect(result.resolvedQuery.metric).toBeUndefined();
  });

  test('maps an explicit multi-metric ranking without forcing topMetric into metrics', () => {
    const semanticContract = WorkflowClassifierService.classifyWorkflow(
      '同时查看流入吞吐量和流出吞吐量，按总吞吐量排行前10个IP'
    ).semanticContract;
    const result = ResolverService.resolveSemanticContract(semanticContract, {
      prompt: '同时查看流入吞吐量和流出吞吐量，按总吞吐量排行前10个IP',
      nowSeconds: 1788940800,
      workflowType: 'metric_topn'
    });

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        metrics: ['TPI', 'TPO'],
        topMetric: 'TPIO',
        groups: [{ type: 'IPAddress' }]
      }
    });
    expect(result.resolvedQuery.metric).toBeUndefined();
  });

  test('maps a resolved multi-metric trend to canonical timeValues fields', () => {
    const result = ResolverService.resolvePrompt(
      '查看业务页面访问量、页面响应时间和 HTTP500的趋势',
      { nowSeconds: 1788940800 }
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'timeValues',
        queryModeKey: 'timeseries',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
        granularity: 60,
        start: 1788937200,
        end: 1788940800
      }
    });
    expect(result.resolvedQuery).not.toHaveProperty('metric');
    expect(result.resolvedQuery).not.toHaveProperty('topMetric');
  });

  test('maps average semantics to metrics[] without ranking fields', () => {
    const result = ResolverService.resolvePrompt(
      '业务页面响应时间平均值',
      { nowSeconds: 1788940800 }
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'averageValues',
        queryModeKey: 'average',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGTME']
      }
    });
    expect(result.resolvedQuery).not.toHaveProperty('metric');
    expect(result.resolvedQuery).not.toHaveProperty('topMetric');
    expect(result.resolvedQuery).not.toHaveProperty('topCount');
  });
});
