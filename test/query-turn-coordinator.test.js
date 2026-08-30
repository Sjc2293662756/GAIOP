'use strict';

const {
  QUERY_ACTIONS,
  QUERY_OUTCOMES,
  QUERY_PHASES,
  QUERY_ROUTES,
  QueryTurnCoordinator
} = require('../plugin/QueryTurnCoordinator');

describe('QueryTurnCoordinator', () => {
  let now;
  let coordinator;

  beforeEach(() => {
    now = 1000;
    coordinator = new QueryTurnCoordinator({ now: () => now, maxAgeMs: 10_000 });
  });

  test('records clarification as a normal terminal outcome', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-1',
      route: QUERY_ROUTES.NAPM_QUERY,
      question: '最近 7 天应用流量趋势如何？'
    });
    const record = coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: {
        ok: true,
        action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
        outcome: QUERY_OUTCOMES.CLARIFICATION,
        clarifyingQuestion: '请告诉我要查询哪个应用。',
        southboundAllowed: false
      }
    });

    expect(record).toMatchObject({
      phase: QUERY_PHASES.TERMINAL,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      finalContent: '请告诉我要查询哪个应用。'
    });
    expect(record.decision).not.toHaveProperty('error');
  });

  test('protects a successful result from a later failure in the same turn', () => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    coordinator.beginExecution({ scope: 'conversation-a', turnId: 'turn-1' });
    const success = coordinator.recordResult({
      scope: 'conversation-a',
      turnId: 'turn-1',
      result: { ok: true, rows: [{ value: 1 }] }
    });
    const afterFailure = coordinator.recordFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      outcome: QUERY_OUTCOMES.EXECUTION_FAILURE,
      result: { ok: false, error: { code: 'LATE_FAILURE' } }
    });

    expect(success.outcome).toBe(QUERY_OUTCOMES.RESULT);
    expect(afterFailure).toEqual(success);
  });

  test('allows one final delivery claim per turn and isolates turns', () => {
    for (const turnId of ['turn-1', 'turn-2']) {
      coordinator.begin({ scope: 'conversation-a', turnId, route: QUERY_ROUTES.NAPM_QUERY });
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId,
        decision: {
          action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
          outcome: QUERY_OUTCOMES.CLARIFICATION,
          clarifyingQuestion: `clarify-${turnId}`,
          southboundAllowed: false
        }
      });
    }

    expect(coordinator.claimDelivery('conversation-a', 'turn-1')).toBe(true);
    expect(coordinator.claimDelivery('conversation-a', 'turn-1')).toBe(false);
    expect(coordinator.claimDelivery('conversation-a', 'turn-2')).toBe(true);
    expect(coordinator.get('conversation-a', 'turn-2').finalContent).toBe('clarify-turn-2');
  });

  test('expires old records and clears a conversation scope', () => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    coordinator.begin({ scope: 'conversation-b', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    expect(coordinator.clearScope('conversation-a')).toBe(1);
    expect(coordinator.get('conversation-a', 'turn-1')).toBeNull();

    now += 10_001;
    expect(coordinator.get('conversation-b', 'turn-1')).toBeNull();
  });
});
