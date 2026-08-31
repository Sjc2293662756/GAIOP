'use strict';

const {
  QUERY_ACTIONS,
  QUERY_OUTCOMES,
  evaluateQueryDecision
} = require('../skills/openclaw-napm-query/services/QueryDecisionPolicy');

function buildQuery(overrides = {}) {
  return {
    service: 'timeValues',
    queryModeKey: 'timeseries',
    groups: [{ type: 'DefinedApp' }],
    metric: 'TPIO',
    metrics: ['TPIO'],
    granularity: 3600,
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
      topCount: 10
    })]
  ])('executes a complete %s', (_label, queryDraft) => {
    expect(evaluateQueryDecision({ queryDraft })).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.EXECUTE_QUERY,
      southboundAllowed: true,
      resolvedQuery: queryDraft
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
      reasonCode: 'INCOMPLETE_QUERY_DRAFT'
    });
  });

  test('does not hide technical omissions behind an application-name clarification', () => {
    const decision = evaluateQueryDecision({
      prompt: '最近 7 天应用流量趋势如何？',
      queryDraft: buildQuery({ metrics: [], metric: undefined }),
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
      reasonCode: 'INCOMPLETE_RESOLVED_QUERY',
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

  test('allows an explicit multilevel drilldown path validated against the groups tree', () => {
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
      action: QUERY_ACTIONS.EXECUTE_QUERY,
      southboundAllowed: true,
      resolvedQuery: queryDraft
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

  test('keeps an ordinary single-group query executable without path planning', () => {
    const queryDraft = buildQuery({
      groups: [{ type: 'DefinedApp', argument: 'HTTP' }]
    });

    expect(evaluateQueryDecision({ queryDraft })).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.EXECUTE_QUERY,
      southboundAllowed: true,
      resolvedQuery: queryDraft
    });
  });
});
