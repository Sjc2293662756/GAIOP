'use strict';

const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');
const MetricSemanticNormalizerService = require('../skills/openclaw-napm-query/services/MetricSemanticNormalizerService');
const ResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');

describe('BUG-A Phase 2.1 semantic lifecycle contract', () => {
  test('marks a semantically complete BottomN request unsupported and never assembles a query', () => {
    const prompt = '页面响应时间最低的5个业务';
    const workflow = WorkflowClassifierService.classifyWorkflow(prompt);

    expect(workflow.semanticContract).toMatchObject({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'UNSUPPORTED',
      operation: 'rank_bottom',
      direction: 'asc',
      targetObjectType: 'WebApplication',
      rankingMetric: 'PGTME',
      topCount: 5,
      ambiguities: [],
      unresolvedSlots: [],
      reasonCode: 'RANK_BOTTOM_UNSUPPORTED'
    });

    expect(ResolverService.resolvePrompt(prompt)).toMatchObject({
      ok: false,
      reason: 'semantic_unsupported',
      reasonCode: 'RANK_BOTTOM_UNSUPPORTED',
      queryDraft: null,
      resolvedQuery: null
    });
  });

  test.each([
    ['最低的5个业务', ['rankingMetric']],
    ['帮我查前5个', ['targetObjectType', 'rankingMetric']]
  ])('marks incomplete ranking semantics unresolved: %s', (prompt, unresolvedSlots) => {
    const workflow = WorkflowClassifierService.classifyWorkflow(prompt);

    expect(workflow.semanticContract).toMatchObject({
      status: 'UNRESOLVED',
      ambiguities: [],
      unresolvedSlots,
      reasonCode: 'SEMANTIC_UNRESOLVED'
    });
    expect(ResolverService.resolvePrompt(prompt)).toMatchObject({
      ok: false,
      reason: 'semantic_unresolved',
      reasonCode: 'SEMANTIC_UNRESOLVED',
      queryDraft: null,
      resolvedQuery: null
    });
  });

  test('keeps a no-object and no-operation multi-metric request unresolved', () => {
    expect(WorkflowClassifierService.classifyWorkflow(
      '同时查看访问量、页面响应时间和 HTTP500'
    ).semanticContract).toMatchObject({
      status: 'UNRESOLVED',
      operation: null,
      targetObjectType: null,
      primaryMetric: null,
      requestedMetrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      unresolvedSlots: ['operation']
    });
  });

  test('resolves an explicit WebApplication multi-metric trend without inventing a primary metric', () => {
    expect(WorkflowClassifierService.classifyWorkflow(
      '查看业务页面访问量、页面响应时间和 HTTP500的趋势'
    ).semanticContract).toMatchObject({
      status: 'RESOLVED',
      operation: 'timeseries',
      targetObjectType: 'WebApplication',
      primaryMetric: null,
      requestedMetrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      rankingMetric: null,
      ambiguities: [],
      unresolvedSlots: [],
      reasonCode: null
    });
  });

  test('marks ambiguity in a required metric slot and preserves structured candidates', () => {
    const metricSemantic = MetricSemanticNormalizerService.resolveMetricSemantic('同义指标', {
      targetObjectType: 'IPAddress',
      metricCatalog: {
        PLI: { domain: 'network_performance' },
        RTTI: { domain: 'network_performance' }
      },
      metricSemanticRules: {
        schemaVersion: 'phase21-test.v1',
        explicitMetricIdsFromCatalog: false,
        rules: [
          { id: 'left', metricId: 'PLI', priority: 10, specificity: 10, phrases: ['同义指标'] },
          { id: 'right', metricId: 'RTTI', priority: 10, specificity: 10, phrases: ['同义指标'] }
        ]
      }
    });
    expect(metricSemantic.status).toBe('ambiguous');

    const semanticContract = WorkflowClassifierService.buildSemanticContract({
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: 'IPAddress',
      metricSemantic,
      objectIntent: { objectType: 'IPAddress', ambiguous: false },
      rankingIntent: {
        status: 'resolved',
        topCount: 5,
        source: { type: 'test_ranking_grammar' }
      },
      timeIntent: { key: 'last1hour' },
      confidence: 0.5
    });

    expect(semanticContract).toMatchObject({
      status: 'AMBIGUOUS',
      ambiguities: [{
        slot: 'rankingMetric',
        candidates: [{ metricId: 'PLI' }, { metricId: 'RTTI' }]
      }],
      unresolvedSlots: [],
      reasonCode: 'SEMANTIC_AMBIGUOUS'
    });
    expect(Object.isFrozen(semanticContract)).toBe(true);
    expect(Object.isFrozen(semanticContract.ambiguities)).toBe(true);
    expect(Object.isFrozen(semanticContract.ambiguities[0])).toBe(true);
    expect(Object.isFrozen(semanticContract.ambiguities[0].candidates[0])).toBe(true);
    expect(ResolverService.resolveSemanticContract(semanticContract)).toMatchObject({
      ok: false,
      reason: 'semantic_ambiguous',
      reasonCode: 'SEMANTIC_AMBIGUOUS',
      queryDraft: null,
      resolvedQuery: null
    });
  });

  test('gives required-slot ambiguity precedence over a different missing required slot', () => {
    expect(WorkflowClassifierService.deriveSemanticLifecycle({
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: null,
      requestedMetrics: [],
      rankingMetric: null,
      topCount: 5,
      metricSemantic: {
        status: 'ambiguous',
        candidates: ['PLI', 'RTTI']
      },
      objectIntent: { objectType: null, ambiguous: false },
      rankingIntent: { status: 'resolved' }
    })).toMatchObject({
      status: 'AMBIGUOUS',
      ambiguities: [{ slot: 'rankingMetric' }],
      unresolvedSlots: ['targetObjectType'],
      reasonCode: 'SEMANTIC_AMBIGUOUS'
    });
  });

  test('allows only RESOLVED contracts into Query Draft assembly', () => {
    const base = {
      schemaVersion: 'napm-query-semantic.v1',
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
    };

    expect(ResolverService.resolveSemanticContract({
      ...base,
      status: 'RESOLVED'
    }, {
      prompt: '页面响应时间最高的前5个业务',
      nowSeconds: 1788940800,
      workflowType: 'metric_topn'
    })).toMatchObject({
      ok: true,
      resolvedQuery: {
        service: 'topValues',
        groups: [{ type: 'WebApplication' }],
        topMetric: 'PGTME'
      }
    });

    expect(ResolverService.resolveSemanticContract(base)).toMatchObject({
      ok: false,
      reason: 'invalid_semantic_status',
      reasonCode: 'SEMANTIC_STATUS_INVALID',
      queryDraft: null,
      resolvedQuery: null
    });
  });

  test('does not use a Resolver context default to fill a missing semantic object', () => {
    const result = ResolverService.resolveSemanticContract({
      schemaVersion: 'napm-query-semantic.v1',
      status: 'RESOLVED',
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: null,
      primaryMetric: 'PLI',
      requestedMetrics: ['PLI'],
      rankingMetric: 'PLI',
      topCount: 5,
      timeIntent: { key: 'last1hour' },
      confidence: 0.9,
      ambiguities: [],
      unresolvedSlots: [],
      reasonCode: null,
      source: {}
    }, {
      prompt: '缺对象的伪造契约',
      defaultTargetObjectType: 'IPAddress'
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_group',
      reasonCode: 'SEMANTIC_TARGET_OBJECT_REQUIRED'
    });
    expect(result.resolvedQuery).toBeUndefined();
  });
});
