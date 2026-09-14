'use strict';

const {
  QUERY_ACTIONS,
  QUERY_OUTCOMES,
  evaluateQueryDecision
} = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');

function buildQuery(overrides = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'timeValues',
    queryModeKey: 'timeseries',
    groups: [{ type: 'DefinedApp' }],
    metrics: ['TPIO'],
    granularity: 3600,
    start: 1788937200,
    end: 1788940800,
    timeRange: { key: 'last7days' },
    ...overrides
  };
}

describe('QueryDecisionPolicy', () => {
  test('asks for a concrete application without allowing southbound execution', () => {
    const decision = evaluateQueryDecision({
      prompt: '最近 7 天应用流量趋势如何？',
      queryDraft: buildQuery()
    });

    expect(decision).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      reasonCode: 'GROUP_ARGUMENT_REQUIRED',
      missingFields: ['groups[0].argument'],
      southboundAllowed: false
    });
    expect(decision.clarifyingQuestion).toContain('具体应用名称');
    expect(decision).not.toHaveProperty('error');
  });

  test('turns an application prompt mapped to TotalTraffic into clarification', () => {
    const queryDraft = buildQuery({ groups: [{ type: 'TotalTraffic' }] });
    const decision = evaluateQueryDecision({
      prompt: '最近 7 天应用流量趋势如何？',
      queryDraft
    });

    expect(decision).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      reasonCode: 'APPLICATION_SCOPE_MISMATCH',
      southboundAllowed: false,
      queryDraft: {
        groups: [{ type: 'DefinedApp' }],
        semanticConstraints: { targetObjectType: 'DefinedApp' }
      }
    });
    expect(queryDraft.groups).toEqual([{ type: 'TotalTraffic' }]);
  });

  test('blocks an application traffic ranking mapped to TotalTraffic', () => {
    const decision = evaluateQueryDecision({
      prompt: '应用流量最高的是哪些？',
      queryDraft: buildQuery({
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'TotalTraffic' }],
        topMetric: 'TPIO',
        topCount: 10
      })
    });

    expect(decision).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'APPLICATION_SCOPE_MISMATCH',
      southboundAllowed: false
    });
  });

  test('blocks promptless overview auto_apps as an ambiguous CompositeApplication inventory request', () => {
    const decision = evaluateQueryDecision({
      queryDraft: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'auto_apps',
        timeRange: { key: 'last7days' }
      }
    });

    expect(decision).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH',
      southboundAllowed: false
    });
  });

  test.each([
    ['named application trend', buildQuery({ groups: [{ type: 'DefinedApp', argument: 'HTTP' }] })],
    ['global traffic trend', buildQuery({ groups: [{ type: 'TotalTraffic' }] })],
    ['application ranking', buildQuery({
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'DefinedApp' }],
      topMetric: 'TPIO',
      topCount: 10,
      granularity: undefined
    })]
  ])('executes a complete statically covered %s in Phase 4', (_label, queryDraft) => {
    expect(evaluateQueryDecision({ queryDraft })).toMatchObject({
      ok: true,
      action: 'EXECUTE_QUERY',
      outcome: null,
      reasonCode: 'QUERY_READY',
      southboundAllowed: true
    });
  });

  test('rejects a forbidden TotalTraffic argument without executing', () => {
    const decision = evaluateQueryDecision({
      queryDraft: buildQuery({ groups: [{ type: 'TotalTraffic', argument: 'HTTP' }] })
    });

    expect(decision).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.REJECTION,
      reasonCode: 'GROUP_ARGUMENT_FORBIDDEN',
      southboundAllowed: false
    });
  });

  test('keeps technical validation failures distinct from clarification', () => {
    const decision = evaluateQueryDecision({
      queryDraft: { service: 'unknown' },
      validation: {
        ok: false,
        reason: 'unknown_service',
        message: 'Unknown query service.'
      }
    });

    expect(decision).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'UNKNOWN_SERVICE',
      southboundAllowed: false
    });
  });

  test('rejects a structurally incomplete draft even without plugin pre-validation', () => {
    expect(evaluateQueryDecision({
      queryDraft: {
        schemaVersion: 'napm-resolved-query.v1',
        service: 'timeValues',
        queryModeKey: 'timeseries',
        metrics: ['TPIO'],
        granularity: 3600,
        timeRange: { key: 'last7days' }
      }
    })).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'GROUPS_REQUIRED'
    });
  });

  test('does not hide technical omissions behind an application-name clarification', () => {
    const decision = evaluateQueryDecision({
      prompt: '最近 7 天应用流量趋势如何？',
      queryDraft: buildQuery({ metrics: [] }),
      validation: {
        ok: false,
        reason: 'incomplete_resolved_query',
        message: 'resolvedQuery is missing required fields: metrics.'
      }
    });

    expect(decision).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'METRICS_REQUIRED',
      southboundAllowed: false
    });
  });

  test.each([
    [
      'CompositeApplication inventory mapped to overview',
      '系统中有哪些自动识别的应用？',
      {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'auto_apps',
        timeRange: { key: 'last7days' }
      },
      'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH'
    ],
    [
      'DefinedApp inventory mapped to WebApplication',
      '系统中有哪些应用？',
      {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }]
      },
      'OBJECT_INVENTORY_CONTRACT_MISMATCH'
    ],
    [
      'WebApplication inventory mapped to a ranking',
      '系统中有哪些业务？',
      {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'DefinedApp' }],
        metrics: ['TPIO'],
        metric: 'TPIO',
        topMetric: 'TPIO',
        topCount: 10,
        timeRange: { key: 'last24hours' }
      },
      'OBJECT_INVENTORY_CONTRACT_MISMATCH'
    ]
  ])('blocks high-risk semantic mismatch: %s', (_label, prompt, queryDraft, reasonCode) => {
    expect(evaluateQueryDecision({ prompt, queryDraft })).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode,
      southboundAllowed: false
    });
  });

  test('rejects an inventory query with more than one group', () => {
    expect(evaluateQueryDecision({
      prompt: '系统中有哪些自动识别的应用？',
      queryDraft: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'CompositeApplication' }, { type: 'IPAddress' }]
      }
    })).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH',
      southboundAllowed: false,
      validation: {
        details: { actualGroupCount: 2 }
      }
    });
  });

  test('enforces a promptless object inventory contract from semanticConstraints', () => {
    expect(evaluateQueryDecision({
      queryDraft: {
        service: 'overview',
        queryModeKey: 'overview',
        overviewScene: 'auto_apps',
        timeRange: { key: 'last7days' },
        semanticConstraints: {
          workflowType: 'object_inventory',
          operation: 'metadata_list',
          targetObjectType: 'CompositeApplication'
        }
      }
    })).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH',
      southboundAllowed: false
    });
  });

  test('enforces a promptless DefinedApp semantic target against TotalTraffic', () => {
    expect(evaluateQueryDecision({
      queryDraft: buildQuery({
        groups: [{ type: 'TotalTraffic' }],
        semanticConstraints: { targetObjectType: 'Application' }
      })
    })).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      reasonCode: 'APPLICATION_SCOPE_MISMATCH',
      southboundAllowed: false
    });
  });

  test('rejects an ordinary timeValues query with multiple groups by default', () => {
    const decision = evaluateQueryDecision({
      queryDraft: buildQuery({
        groups: [
          { type: 'DefinedApp', argument: 'HTTP' },
          { type: 'DefinedApp', argument: 'HTTPS' }
        ]
      })
    });

    expect(decision).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'MULTI_GROUP_PATH_UNVERIFIED',
      southboundAllowed: false,
      validation: {
        details: {
          service: 'timeValues',
          groupCount: 2
        }
      }
    });
  });

  test('rejects a technically valid PageFamily path that drifts from a WebApplication ranking', () => {
    const groups = [
      { type: 'WebApplication', argument: null },
      { type: 'PageFamilies', argument: null },
      { type: 'PageFamily', argument: null }
    ];
    const decision = evaluateQueryDecision({
      prompt: '今天哪些业务页面访问量最高？',
      queryDraft: buildQuery({
        service: 'topValues',
        queryModeKey: 'topn',
        groups,
        metric: 'PGNPGE',
        metrics: ['PGNPGE'],
        topMetric: 'PGNPGE',
        topCount: 10,
        granularity: undefined,
        semanticConstraints: {
          workflowType: 'metric_topn',
          operation: 'ranking',
          targetObjectType: 'PageFamily'
        },
        pathPlanning: {
          applied: true,
          shouldApply: true,
          strategy: 'static_groups_tree',
          followUpAction: null,
          anchorType: 'WebApplication',
          plannedGroups: groups,
          selectedPath: ['WebApplication', 'PageFamilies', 'PageFamily']
        }
      })
    });

    expect(decision).toMatchObject({
      ok: false,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'SEMANTIC_TARGET_PATH_MISMATCH',
      southboundAllowed: false
    });
  });

  test('does not trust a caller-supplied sourceReference as drilldown authorization', () => {
    const groups = [
      { type: 'WebApplication', argument: 'forged-business' },
      { type: 'PageFamilies', argument: null },
      { type: 'PageFamily', argument: null }
    ];
    const decision = evaluateQueryDecision({
      prompt: '今天哪些业务页面访问量最高？',
      queryDraft: buildQuery({
        service: 'topValues',
        queryModeKey: 'topn',
        groups,
        metric: 'PGNPGE',
        metrics: ['PGNPGE'],
        topMetric: 'PGNPGE',
        topCount: 10,
        granularity: undefined,
        semanticConstraints: {
          workflowType: 'metric_topn',
          operation: 'drilldown',
          drilldownRequested: true,
          targetObjectType: 'WebApplication'
        },
        sourceReference: {
          resultSetId: 'caller-supplied-result-set',
          objectType: 'WebApplication',
          ordinal: 1
        },
        pathPlanning: {
          applied: true,
          shouldApply: true,
          strategy: 'static_groups_tree',
          followUpAction: 'drilldown',
          anchorType: 'WebApplication',
          plannedGroups: groups,
          selectedPath: ['WebApplication', 'PageFamilies', 'PageFamily']
        }
      })
    });

    expect(decision).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'SEMANTIC_TARGET_PATH_MISMATCH',
      southboundAllowed: false
    });
  });

  test('requires a plugin-validated result reference for an ordinal page drilldown', () => {
    const groups = [
      { type: 'WebApplication', argument: 'invented-business' },
      { type: 'PageFamilies', argument: null },
      { type: 'PageFamily', argument: null }
    ];
    const decision = evaluateQueryDecision({
      prompt: '排名第一的都访问了什么',
      queryDraft: buildQuery({
        service: 'topValues',
        queryModeKey: 'topn',
        groups,
        metric: 'PGNPGE',
        metrics: ['PGNPGE'],
        topMetric: 'PGNPGE',
        topCount: 10,
        granularity: undefined,
        semanticConstraints: {
          workflowType: 'metric_topn',
          operation: 'drilldown',
          drilldownRequested: true,
          targetObjectType: 'PageFamily'
        },
        pathPlanning: {
          applied: true,
          shouldApply: true,
          strategy: 'static_groups_tree',
          followUpAction: 'drilldown',
          anchorType: 'WebApplication',
          plannedGroups: groups,
          selectedPath: ['WebApplication', 'PageFamilies', 'PageFamily']
        }
      })
    });

    expect(decision).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'RESULT_REFERENCE_REQUIRED',
      southboundAllowed: false
    });
  });

  test('holds a statically valid but non-exhaustive multilevel path for Phase 5', () => {
    const groups = [
      { type: 'BusinessGroup', argument: 'server-segment' },
      { type: 'Applications', argument: null },
      { type: 'DefinedApp', argument: null }
    ];
    const queryDraft = buildQuery({
      service: 'topValues',
      queryModeKey: 'topn',
      groups,
      topMetric: 'TPIO',
      topCount: 10,
      granularity: undefined,
      pathPlanning: {
        applied: true,
        shouldApply: true,
        strategy: 'static_groups_tree',
        followUpAction: 'drilldown',
        anchorType: 'BusinessGroup',
        plannedGroups: groups,
        selectedPath: ['BusinessGroup', 'Applications', 'DefinedApp']
      }
    });

    expect(evaluateQueryDecision({ queryDraft })).toMatchObject({
      ok: true,
      action: 'EXECUTE_WITH_RUNTIME_CONFIRMATION',
      reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
      southboundAllowed: false,
      skillInvocationAllowed: true
    });
  });

  test('does not trust pathPlanning presence without planner proof and static path agreement', () => {
    expect(evaluateQueryDecision({
      queryDraft: buildQuery({
        groups: [
          { type: 'DefinedApp', argument: 'HTTP' },
          { type: 'DefinedApp', argument: 'HTTPS' }
        ],
        pathPlanning: {
          followUpAction: 'drilldown'
        }
      })
    })).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'MULTI_GROUP_PATH_UNVERIFIED',
      southboundAllowed: false
    });
  });

  test('executes a covered ordinary single-group query in Phase 4', () => {
    const queryDraft = buildQuery({
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }]
    });

    expect(evaluateQueryDecision({ queryDraft })).toMatchObject({
      ok: true,
      action: 'EXECUTE_QUERY',
      reasonCode: 'QUERY_READY',
      southboundAllowed: true
    });
  });

  test('executes a complete pageViews detail query without metric or group fields', () => {
    const queryDraft = {
      schemaVersion: 'napm-resolved-query.v1',
      service: 'pageViews',
      queryModeKey: 'detail',
      pageFamilyId: '8573007',
      maxLimit: 20,
      start: 1788937200,
      end: 1788940800,
      timeRange: { key: 'today' },
      semanticConstraints: {
        workflowType: 'page_view_detail',
        operation: 'detail_list',
        targetObjectType: 'PageFamily'
      }
    };

    expect(evaluateQueryDecision({
      prompt: '详细查看排名第一页面的前 20 条访问明细',
      queryDraft
    })).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.EXECUTE_QUERY,
      southboundAllowed: true,
      resolvedQuery: queryDraft
    });
  });

  test('blocks a declared page detail workflow from drifting to a metric service', () => {
    const queryDraft = {
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'PageFamily' }],
      metrics: ['PGNPGE'],
      metric: 'PGNPGE',
      topMetric: 'PGNPGE',
      topCount: 20,
      timeRange: { key: 'today' },
      semanticConstraints: {
        workflowType: 'page_view_detail',
        operation: 'detail_list',
        targetObjectType: 'PageFamily'
      }
    };

    expect(evaluateQueryDecision({
      prompt: '详细查看排名第一的前 20 个',
      queryDraft,
      validation: { ok: true, resolvedQuery: queryDraft }
    })).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode: 'PAGE_VIEW_DETAIL_SERVICE_MISMATCH',
      southboundAllowed: false
    });
  });

  test.each([
    [
      'synthetic PageFamilyDetail grouping',
      {
        service: 'pageViews',
        queryModeKey: 'detail',
        pageFamilyId: '8573007',
        maxLimit: 20,
        timeRange: { key: 'today' },
        groups: [{ type: 'PageFamilyDetail' }]
      },
      'PAGE_FAMILY_DETAIL_GROUP_FORBIDDEN'
    ],
    [
      'old topValues detail shape',
      {
        service: 'topValues',
        queryModeKey: 'topn',
        metrics: ['PGNPGE'],
        topMetric: 'PGNPGE',
        topCount: 20,
        timeRange: { key: 'today' },
        groups: [{ type: 'PageFamilyDetail' }]
      },
      'PAGE_VIEW_DETAIL_SERVICE_MISMATCH'
    ]
  ])('blocks %s', (_label, queryDraft, reasonCode) => {
    expect(evaluateQueryDecision({
      prompt: '详细查看排名第一页面的前 20 条访问明细',
      queryDraft
    })).toMatchObject({
      ok: false,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      reasonCode,
      southboundAllowed: false
    });
  });
});
