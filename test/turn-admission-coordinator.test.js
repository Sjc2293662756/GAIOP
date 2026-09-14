'use strict';

const {
  TURN_ADMISSION_ACTIONS,
  TurnAdmissionCoordinator
} = require('../plugin/TurnAdmissionCoordinator');

function queryCandidate(overrides = {}) {
  return {
    domain: 'QUERY',
    artifactId: 'result-set-1',
    artifactType: 'authoritative_ranking_result',
    objectType: 'WebApplication',
    supportedActions: ['DETAIL'],
    route: 'napm_candidate',
    queryRoute: 'NAPM_QUERY',
    expectedTool: 'napm-skill-query',
    workflow: 'result_drilldown',
    ...overrides
  };
}

describe('TurnAdmissionCoordinator', () => {
  test('turns a model-owned short follow-up into an immutable Query admission', () => {
    const coordinator = new TurnAdmissionCoordinator();
    const decision = coordinator.decide({
      prompt: '看第一个的详情',
      baseDecision: { route: 'model_owned' },
      contextCandidates: [queryCandidate()],
      identity: {
        conversationKey: 'scope-1',
        turnId: 'turn-1',
        runId: 'run-1',
        messageId: 'message-1'
      }
    });

    expect(decision).toMatchObject({
      route: 'napm_candidate',
      queryRoute: 'NAPM_QUERY',
      action: TURN_ADMISSION_ACTIONS.EXECUTE_TOOL,
      expectedTool: 'napm-skill-query',
      workflow: 'result_drilldown',
      reasonCode: 'AUTHORITATIVE_RESULT_FOLLOWUP',
      conversationKey: 'scope-1',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      sourceDomain: 'QUERY',
      sourceArtifactId: 'result-set-1',
      sourceObjectType: 'WebApplication',
      selection: { kind: 'ordinal', ordinal: 1, action: 'DETAIL' }
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.selection)).toBe(true);
  });

  test('does not override an explicit out-of-scope decision', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '看第一个的详情',
      baseDecision: { route: 'explicit_out_of_scope' },
      contextCandidates: [queryCandidate()]
    });

    expect(decision).toMatchObject({
      route: 'explicit_out_of_scope',
      action: TURN_ADMISSION_ACTIONS.REJECT,
      source: 'base_policy'
    });
  });

  test('keeps an unrelated prompt model-owned even when an artifact exists', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '今天天气不错',
      baseDecision: { route: 'model_owned' },
      contextCandidates: [queryCandidate()]
    });

    expect(decision).toMatchObject({
      route: 'model_owned',
      action: TURN_ADMISSION_ACTIONS.MODEL_OWNED,
      source: 'base_policy'
    });
  });

  test('requires clarification when no authoritative context exists', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '看第一个的详情',
      baseDecision: { route: 'model_owned' },
      contextCandidates: []
    });

    expect(decision).toMatchObject({
      route: 'model_owned',
      action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
      reasonCode: 'TURN_ADMISSION_CONTEXT_REQUIRED',
      expectedTool: null
    });
  });

  test('requires clarification between multiple domains that support the same selection', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '看第一个的详情',
      baseDecision: { route: 'model_owned' },
      contextCandidates: [
        queryCandidate(),
        queryCandidate({ domain: 'ALERT', artifactId: 'alerts-1', expectedTool: 'napm-alert-query' })
      ]
    });

    expect(decision).toMatchObject({
      route: 'model_owned',
      action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
      reasonCode: 'TURN_ADMISSION_AMBIGUOUS',
      expectedTool: null
    });
  });

  test('selects the freshest authoritative domain instead of a stale Query artifact', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '看第一个的详情',
      baseDecision: { route: 'model_owned' },
      contextCandidates: [
        queryCandidate({ updatedAt: 100 }),
        queryCandidate({
          domain: 'ALERT',
          artifactId: 'alerts-1',
          objectType: 'AlertEvent',
          expectedTool: 'napm-alert-query',
          updatedAt: 200,
          items: [{ ordinal: 1, eventId: '369652' }]
        })
      ]
    });

    expect(decision).toMatchObject({
      sourceDomain: 'ALERT',
      sourceArtifactId: 'alerts-1',
      expectedTool: 'napm-alert-query',
      selectedItem: { ordinal: 1, eventId: '369652' }
    });
  });

  test('clarifies an ordinal outside the authoritative artifact', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '看第二个的详情',
      baseDecision: { route: 'model_owned' },
      contextCandidates: [queryCandidate({
        domain: 'ALERT',
        objectType: 'AlertEvent',
        expectedTool: 'napm-alert-query',
        items: [{ ordinal: 1, eventId: '369652' }]
      })]
    });

    expect(decision).toMatchObject({
      action: 'ASK_CLARIFYING_QUESTION',
      reasonCode: 'RESULT_REFERENCE_ORDINAL_OUT_OF_RANGE',
      expectedTool: null
    });
  });

  test('does not fall back to a stale Query ranking behind a newer unmigrated artifact', () => {
    const decision = new TurnAdmissionCoordinator().decide({
      prompt: '看第一个的详情',
      baseDecision: { route: 'model_owned' },
      contextCandidates: [
        queryCandidate({ updatedAt: 100 }),
        {
          domain: 'PACKET',
          artifactId: 'skill-result:turn-packet',
          artifactType: 'authoritative_skill_result_boundary',
          supportedActions: ['DETAIL'],
          route: 'napm_candidate',
          requiresClarification: true,
          updatedAt: 200
        }
      ]
    });

    expect(decision).toMatchObject({
      action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
      reasonCode: 'TURN_ADMISSION_CONTEXT_NOT_MIGRATED',
      sourceDomain: 'PACKET',
      expectedTool: null
    });
  });
});
