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
    const decision = evaluateQueryDecision({
      prompt: '最近 7 天应用流量趋势如何？',
      queryDraft: buildQuery({ groups: [{ type: 'TotalTraffic' }] })
    });

    expect(decision).toMatchObject({
      ok: true,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      reasonCode: 'APPLICATION_SCOPE_MISMATCH',
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
});
