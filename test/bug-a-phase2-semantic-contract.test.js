'use strict';

const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');
const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');

describe('BUG-A Phase 2 canonical query semantic contract', () => {
  test('classifies slow business Top5 into one canonical semantic contract', () => {
    const result = WorkflowClassifierService.classifyWorkflow(
      '最近业务访问较慢的前5个业务都有谁？'
    );

    expect(result.semanticContract).toMatchObject({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'RESOLVED',
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: 'WebApplication',
      primaryMetric: 'PGTME',
      requestedMetrics: ['PGTME'],
      rankingMetric: 'PGTME',
      topCount: 5,
      timeIntent: expect.any(Object),
      confidence: expect.any(Number),
      source: {
        object: expect.any(Object),
        metric: expect.any(Object),
        ranking: expect.any(Object)
      }
    });
  });

  test('resolver consumes the semantic contract without reinterpreting a contradictory raw prompt', () => {
    const result = ResolverService.resolveSemanticContract({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'RESOLVED',
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: 'WebApplication',
      primaryMetric: 'PGTME',
      requestedMetrics: ['PGTME'],
      rankingMetric: 'PGTME',
      topCount: 5,
      timeIntent: { key: 'last1hour' },
      confidence: 0.9,
      ambiguities: [],
      unresolvedSlots: [],
      reasonCode: null,
      source: {}
    }, {
      prompt: '最低的99个IP，按服务器响应时间排行',
      nowSeconds: 1788940800,
      workflowType: 'metric_topn'
    });

    expect(result).toMatchObject({
      ok: true,
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'topValues',
        groups: [{ type: 'WebApplication' }],
        metrics: ['PGTME'],
        topMetric: 'PGTME',
        topCount: 5,
        semanticConstraints: {
          operation: 'rank_top',
          direction: 'desc'
        }
      }
    });
  });

  test.each([
    ['最近业务访问较慢的前5个业务都有谁？', 'WebApplication', 'PGTME', 5],
    ['页面响应时间最高的前5个业务', 'WebApplication', 'PGTME', 5],
    ['慢页面数量最多的前5个业务', 'WebApplication', 'PGNSLPGE', 5],
    ['服务器响应时间最高的前5个已定义应用', 'DefinedApp', 'TRTI', 5],
    ['网络时延最高的前5个IP', 'IPAddress', 'RTTI', 5]
  ])('classifies and resolves the required TopN case: %s', (
    prompt,
    targetObjectType,
    metricId,
    topCount
  ) => {
    const workflow = WorkflowClassifierService.classifyWorkflow(prompt);
    expect(workflow.semanticContract).toMatchObject({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'RESOLVED',
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType,
      primaryMetric: metricId,
      requestedMetrics: [metricId],
      rankingMetric: metricId,
      topCount
    });

    expect(ResolverService.resolvePrompt(prompt, { nowSeconds: 1788940800 })).toMatchObject({
      ok: true,
      resolvedQuery: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'topValues',
        groups: [{ type: targetObjectType }],
        metrics: [metricId],
        topMetric: metricId,
        topCount,
        semanticConstraints: {
          operation: 'rank_top',
          direction: 'desc'
        }
      }
    });
  });

  test.each([
    '最低的5个业务',
    '最少的5个业务'
  ])('keeps BottomN unresolved when its ranking metric is missing: %s', (prompt) => {
    const workflow = WorkflowClassifierService.classifyWorkflow(prompt);
    expect(workflow.semanticContract).toMatchObject({
      operation: 'rank_bottom',
      direction: 'asc',
      targetObjectType: 'WebApplication',
      topCount: 5,
      status: 'UNRESOLVED',
      unresolvedSlots: ['rankingMetric']
    });
    expect(ResolverService.resolvePrompt(prompt)).toMatchObject({
      ok: false,
      reason: 'semantic_unresolved',
      reasonCode: 'SEMANTIC_UNRESOLVED',
      resolvedQuery: null
    });
  });

  test('keeps a multi-metric request without object or operation unresolved', () => {
    expect(WorkflowClassifierService.classifyWorkflow(
      '同时查看访问量、页面响应时间和 HTTP500'
    ).semanticContract).toMatchObject({
      status: 'UNRESOLVED',
      operation: null,
      targetObjectType: null,
      primaryMetric: null,
      requestedMetrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      rankingMetric: null,
      unresolvedSlots: ['operation']
    });
  });

  test('builds a resolved multi-metric trend contract without primaryMetric', () => {
    expect(WorkflowClassifierService.classifyWorkflow(
      '查看业务页面访问量、页面响应时间和 HTTP500的趋势'
    ).semanticContract).toMatchObject({
      status: 'RESOLVED',
      operation: 'timeseries',
      targetObjectType: 'WebApplication',
      primaryMetric: null,
      requestedMetrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      rankingMetric: null
    });
  });

  test.each([
    ['业务页面响应时间平均值', 'average'],
    ['业务页面访问量趋势', 'timeseries'],
    ['查看页面访问实例详情', 'detail_list'],
    ['业务支持哪些指标', 'metadata_list']
  ])('represents the required non-ranking operation for %s', (prompt, operation) => {
    expect(WorkflowClassifierService.classifyWorkflow(prompt).semanticContract).toMatchObject({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'RESOLVED',
      operation,
      direction: null,
      topCount: null
    });
  });

  test('separates requested metrics from the ranking metric', () => {
    expect(WorkflowClassifierService.classifyWorkflow(
      '同时查看流入吞吐量和流出吞吐量，按总吞吐量排行前10'
    ).semanticContract).toMatchObject({
      operation: 'rank_top',
      direction: 'desc',
      requestedMetrics: ['TPI', 'TPO'],
      primaryMetric: null,
      rankingMetric: 'TPIO',
      topCount: 10
    });
  });

  test('removes only the metric inside the ranking clause when wording is repeated', () => {
    expect(WorkflowClassifierService.classifyWorkflow(
      '同时查看总吞吐量和流入吞吐量，按总吞吐量排行前10'
    ).semanticContract).toMatchObject({
      requestedMetrics: ['TPIO', 'TPI'],
      rankingMetric: 'TPIO',
      topCount: 10
    });
  });

  test('fails closed on an unknown semantic schema version', () => {
    expect(ResolverService.resolveSemanticContract({
      schemaVersion: 'unknown.v9',
      operation: 'rank_top'
    })).toMatchObject({
      ok: false,
      reason: 'unsupported_semantic_schema',
      reasonCode: 'SEMANTIC_SCHEMA_UNSUPPORTED',
      queryDraft: null,
      resolvedQuery: null
    });
  });

  test('resolver preserves ambiguous metric candidates instead of choosing one', () => {
    expect(ResolverService.resolveSemanticContract({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'AMBIGUOUS',
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: 'IPAddress',
      primaryMetric: null,
      requestedMetrics: [],
      rankingMetric: null,
      topCount: 5,
      timeIntent: { key: 'last1hour' },
      confidence: 0.5,
      ambiguities: [{
        slot: 'rankingMetric',
        candidates: [{ metricId: 'PLI' }, { metricId: 'RTTI' }]
      }],
      unresolvedSlots: [],
      reasonCode: 'SEMANTIC_AMBIGUOUS',
      source: {
        metric: {
          status: 'ambiguous',
          candidates: ['PLI', 'RTTI']
        }
      }
    })).toMatchObject({
      ok: false,
      reason: 'semantic_ambiguous',
      reasonCode: 'SEMANTIC_AMBIGUOUS',
      resolvedQuery: null,
      diagnostics: {
        ambiguities: [{
          slot: 'rankingMetric',
          candidates: [{ metricId: 'PLI' }, { metricId: 'RTTI' }]
        }]
      }
    });
  });
});
