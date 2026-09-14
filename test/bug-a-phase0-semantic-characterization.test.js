'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase0-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase0-test-password';

const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');
const NapmResolvedQueryResolverService = require('../skills/openclaw-napm-query/services/NapmResolvedQueryResolverService');
const QueryDecisionPolicy = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');
const {
  isMetricCompatibleWithGroupPath,
  isOwnedMetricForObjectType,
  resolveMetricOwnershipObjectType
} = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');
const {
  normalizeTopValuesRows
} = require('../skills/openclaw-napm-query/services/TopValuesResultNormalizerService');

const NOW_SECONDS = 1788940800;
const START_SECONDS = NOW_SECONDS - 3600;

const PROMPT_CASES = [
  {
    prompt: '最近业务访问较慢的前5个业务都有谁？',
    workflow: ['WebApplication', 'PGTME', 'metric_topn', 0.9, 'ranking_intent', 'rank_top', 'desc', 5],
    resolver: [true, null, 'topValues', 'WebApplication', 'PGTME', 'desc']
  },
  {
    prompt: '页面响应时间最高的前5个业务',
    workflow: ['WebApplication', 'PGTME', 'metric_topn', 0.9, 'ranking_intent', 'rank_top', 'desc', 5],
    resolver: [true, null, 'topValues', 'WebApplication', 'PGTME', 'desc']
  },
  {
    prompt: '慢页面数量最多的前5个业务',
    workflow: ['WebApplication', 'PGNSLPGE', 'metric_topn', 0.9, 'ranking_intent', 'rank_top', 'desc', 5],
    resolver: [true, null, 'topValues', 'WebApplication', 'PGNSLPGE', 'desc']
  },
  {
    prompt: '服务器响应时间最高的前5个已定义应用',
    workflow: ['DefinedApp', 'TRTI', 'metric_topn', 0.9, 'ranking_intent', 'rank_top', 'desc', 5],
    resolver: [true, null, 'topValues', 'DefinedApp', 'TRTI', 'desc']
  },
  {
    prompt: '网络时延最高的前5个IP',
    workflow: ['IPAddress', 'RTTI', 'metric_topn', 0.9, 'ranking_intent', 'rank_top', 'desc', 5],
    resolver: [true, null, 'topValues', 'IPAddress', 'RTTI', 'desc']
  },
  {
    prompt: '最低的5个业务',
    workflow: ['WebApplication', null, 'metric_topn', 0.9, 'ranking_intent', 'rank_bottom', 'asc', 5],
    resolver: [false, 'semantic_unresolved', null, null, null, null]
  },
  {
    prompt: '最少的5个业务',
    workflow: ['WebApplication', null, 'metric_topn', 0.9, 'ranking_intent', 'rank_bottom', 'asc', 5],
    resolver: [false, 'semantic_unresolved', null, null, null, null]
  }
];

function projectWorkflow(result) {
  return [
    result.targetObjectType,
    result.primaryMetric,
    result.workflowType,
    result.confidence,
    result.reason,
    result.operation,
    result.direction,
    result.topCount
  ];
}

function projectResolver(result) {
  const query = result.resolvedQuery || {};
  return [
    result.ok,
    result.reason || null,
    query.service || null,
    query.groups?.[0]?.type || null,
    query.topMetric || null,
    query.semanticConstraints?.direction || null
  ];
}

describe('BUG-A Phase 0 semantic characterization migrated by Phase 2', () => {
  test.each(PROMPT_CASES)(
    'characterization_current_behavior_workflow_classifier: $prompt',
    ({ prompt, workflow }) => {
      const result = WorkflowClassifierService.classifyWorkflow(prompt);

      expect(projectWorkflow(result)).toEqual(workflow);
      expect(result.semanticContract).toMatchObject({
        schemaVersion: 'napm-query-semantic.v1',
        operation: workflow[5],
        direction: workflow[6],
        topCount: workflow[7]
      });
    }
  );

  test.each(PROMPT_CASES)(
    'characterization_current_behavior_resolver: $prompt',
    ({ prompt, resolver }) => {
      const result = NapmResolvedQueryResolverService.resolvePrompt(prompt, {
        nowSeconds: NOW_SECONDS
      });

      expect(projectResolver(result)).toEqual(resolver);
      if (result.ok) {
        expect(result.resolvedQuery.queryModeKey).toBe('topn');
        expect(result.resolvedQuery.topCount).toBe(5);
        expect(result.resolvedQuery.start).toBe(START_SECONDS);
        expect(result.resolvedQuery.end).toBe(NOW_SECONDS);
        expect(result.resolvedQuery.metrics).toEqual([result.resolvedQuery.topMetric]);
        expect(result.resolvedQuery.metric).toBeUndefined();
      }
    }
  );

  test.each([
    ['WebApplication', 'TRTI', false, false, 'WebApplication'],
    ['WebApplication', 'PGTME', true, true, 'WebApplication'],
    ['WebApplication', 'PGNSLPGE', true, true, 'WebApplication'],
    ['DefinedApp', 'TRTI', true, true, 'DefinedApp'],
    ['IPAddress', 'RTTI', true, true, 'IPAddress'],
    ['IPAddress', 'PLI', true, true, 'IPAddress']
  ])(
    'baseline_current_object_metric_ownership %s + %s',
    (objectType, metric, compatible, owned, resolvedObjectType) => {
      const groups = [{ type: objectType }];

      expect(isMetricCompatibleWithGroupPath(groups, metric)).toBe(compatible);
      expect(isOwnedMetricForObjectType(objectType, metric)).toBe(owned);
      expect(resolveMetricOwnershipObjectType(groups)).toBe(resolvedObjectType);
    }
  );

  test('Phase 4 policy blocks statically incompatible WebApplication TRTI', () => {
    const queryDraft = {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }],
      metrics: ['TRTI'],
      topMetric: 'TRTI',
      topCount: 5,
      start: START_SECONDS,
      end: NOW_SECONDS,
      format: 'json'
    };

    const decision = QueryDecisionPolicy.evaluateQueryDecision({
      prompt: '最近业务访问较慢的前5个业务都有谁？',
      queryDraft
    });

    expect(decision).toMatchObject({
      ok: false,
      action: 'REJECT_QUERY',
      outcome: 'VALIDATION_FAILURE',
      reasonCode: 'OBJECT_METRIC_INCOMPATIBLE',
      southboundAllowed: false
    });
  });

  test('characterization_current_constraint_warns_but_preserves_webapplication_trti', () => {
    const query = {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'WebApplication' }],
      metrics: ['TRTI'],
      topMetric: 'TRTI',
      topCount: 5,
      start: START_SECONDS,
      end: NOW_SECONDS,
      format: 'json'
    };

    const result = QueryMetadataConstraintService.constrain(
      query,
      '最近业务访问较慢的前5个业务都有谁？'
    );

    expect(result.warnings).toContain(
      'metric_group_ownership_incompatible:TRTI:WebApplication'
    );
    expect(result.corrections).toEqual([]);
    expect(result.compatibility).toMatchObject({
      metric: 'TRTI',
      selectedGroup: 'WebApplication',
      isCompatible: false
    });
    expect(result.query).toMatchObject({
      metrics: ['TRTI'],
      topMetric: 'TRTI',
      groups: [{ type: 'WebApplication' }]
    });
    expect(result.query.metric).toBeUndefined();
  });

  test('phase2_migration_does_not_reorder_returned_topn_to_fake_bottomn', () => {
    const rows = [100, 90, 80, 70, 60].map((value) => ({
      group: { argument: `value-${value}` },
      values: { PGTME: value }
    }));

    const normalized = normalizeTopValuesRows(rows, {
      topMetric: 'PGTME',
      semanticConstraints: { direction: 'asc' }
    });

    expect(normalized.map((row) => row.values.PGTME)).toEqual([100, 90, 80, 70, 60]);
    expect(normalized.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});
