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

  test('records an execution-time Skill clarification as a successful terminal attempt', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-1',
      route: QUERY_ROUTES.NAPM_QUERY,
      queryDraft: { service: 'timeValues', groups: [{ type: 'DefinedApp', argument: 'HTTP' }] }
    });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    coordinator.beginExecution({ scope: 'conversation-a', turnId: 'turn-1', attemptId: 'execution-1' });

    const record = coordinator.recordExecutionClarification({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: {
        action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
        outcome: QUERY_OUTCOMES.CLARIFICATION,
        clarifyingQuestion: '请补充查询范围。',
        southboundAllowed: false
      },
      result: {
        ok: true,
        responseType: 'clarification_required',
        displayText: '请补充查询范围。'
      }
    });

    expect(record).toMatchObject({
      phase: QUERY_PHASES.TERMINAL,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      attempts: [{ attemptId: 'execution-1', status: 'SUCCEEDED' }],
      finalContent: '请补充查询范围。'
    });
  });

  test.each([
    QUERY_PHASES.RECEIVED,
    QUERY_PHASES.REPAIR_PENDING,
    QUERY_PHASES.DECIDED
  ])('rejects result and failure transitions from %s', (phase) => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    if (phase === QUERY_PHASES.REPAIR_PENDING) {
      coordinator.recordValidationFailure({
        scope: 'conversation-a',
        turnId: 'turn-1',
        attemptId: 'construction-1',
        queryDraft: { service: 'timeValues' },
        validation: { reason: 'missing_groups' }
      });
    } else if (phase === QUERY_PHASES.DECIDED) {
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId: 'turn-1',
        decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
      });
    }
    const before = coordinator.get('conversation-a', 'turn-1');

    expect(coordinator.recordResult({
      scope: 'conversation-a',
      turnId: 'turn-1',
      result: { ok: true, rows: [{ value: 1 }] },
      finalContent: '不应写入。'
    })).toEqual(before);
    expect(coordinator.recordFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      result: { ok: false, error: { code: 'INVALID_TRANSITION' } },
      finalContent: '不应写入。'
    })).toEqual(before);
    expect(coordinator.get('conversation-a', 'turn-1')).toEqual(before);
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
      result: { ok: true, rows: [{ value: 1 }] },
      finalContent: '查询成功。'
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

  test('does not move an executing turn back to decided or start another execution attempt', () => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    const executing = coordinator.beginExecution({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'execution-1'
    });

    const replayedDecision = coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    const replayedValidationFailure = coordinator.recordValidationFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'late-construction-failure',
      queryDraft: { service: 'timeValues' },
      validation: { reason: 'incomplete_query_draft' }
    });
    const replayedExecution = coordinator.beginExecution({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'execution-2'
    });

    expect(executing).toMatchObject({
      phase: QUERY_PHASES.EXECUTING,
      attempts: [{ attemptId: 'execution-1', status: 'STARTED' }]
    });
    expect(replayedDecision).toEqual(executing);
    expect(replayedValidationFailure).toEqual(executing);
    expect(replayedExecution).toEqual(executing);
  });

  test.each([
    QUERY_OUTCOMES.CLARIFICATION,
    QUERY_OUTCOMES.RESULT,
    QUERY_OUTCOMES.NO_DATA,
    QUERY_OUTCOMES.REJECTION,
    QUERY_OUTCOMES.VALIDATION_FAILURE,
    QUERY_OUTCOMES.EXECUTION_FAILURE,
    QUERY_OUTCOMES.CONTRACT_VIOLATION
  ])('never mutates a terminal %s outcome', (outcome) => {
    const turnId = `terminal-${outcome}`;
    coordinator.begin({ scope: 'conversation-a', turnId, route: QUERY_ROUTES.NAPM_QUERY });

    if (outcome === QUERY_OUTCOMES.CLARIFICATION) {
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId,
        decision: {
          action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
          outcome,
          clarifyingQuestion: '请补充应用名称。'
        }
      });
    } else if (outcome === QUERY_OUTCOMES.REJECTION) {
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId,
        decision: {
          action: QUERY_ACTIONS.REJECT_QUERY,
          outcome,
          rejectionMessage: '不支持该查询。'
        }
      });
    } else if (outcome === QUERY_OUTCOMES.RESULT || outcome === QUERY_OUTCOMES.NO_DATA) {
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId,
        decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
      });
      coordinator.beginExecution({ scope: 'conversation-a', turnId, attemptId: `${turnId}-execute` });
      coordinator.recordResult({
        scope: 'conversation-a',
        turnId,
        result: outcome === QUERY_OUTCOMES.NO_DATA
          ? { ok: true, rows: [] }
          : { ok: true, rows: [{ value: 1 }] },
        finalContent: outcome === QUERY_OUTCOMES.NO_DATA ? '未查到数据。' : '查询成功。'
      });
    } else if (outcome === QUERY_OUTCOMES.CONTRACT_VIOLATION) {
      coordinator.recordContractViolation({
        scope: 'conversation-a',
        turnId,
        reasonCode: 'MODEL_OMITTED_REQUIRED_TOOL',
        finalContent: '本轮未调用查询工具。'
      });
    } else if (outcome === QUERY_OUTCOMES.VALIDATION_FAILURE) {
      coordinator.recordValidationFailure({
        scope: 'conversation-a',
        turnId,
        attemptId: `${turnId}-construction-1`,
        validation: { reasonCode: 'INVALID_QUERY_DRAFT' },
        finalContent: '查询失败。'
      });
      coordinator.recordValidationFailure({
        scope: 'conversation-a',
        turnId,
        attemptId: `${turnId}-construction-2`,
        validation: { reasonCode: 'INVALID_QUERY_DRAFT' },
        finalContent: '查询失败。'
      });
    } else {
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId,
        decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
      });
      coordinator.beginExecution({ scope: 'conversation-a', turnId, attemptId: `${turnId}-execute` });
      coordinator.recordFailure({
        scope: 'conversation-a',
        turnId,
        outcome,
        result: { ok: false, error: { code: outcome } },
        finalContent: '查询失败。'
      });
    }

    const terminal = coordinator.get('conversation-a', turnId);
    now += 1;
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId,
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    coordinator.beginExecution({ scope: 'conversation-a', turnId, attemptId: 'late-execute' });
    coordinator.recordResult({
      scope: 'conversation-a',
      turnId,
      result: { ok: true, rows: [{ value: 2 }] },
      finalContent: '错误覆盖。'
    });
    coordinator.recordFailure({
      scope: 'conversation-a',
      turnId,
      outcome: QUERY_OUTCOMES.EXECUTION_FAILURE,
      result: { ok: false },
      finalContent: '错误覆盖。'
    });

    expect(coordinator.get('conversation-a', turnId)).toEqual(terminal);
  });

  test('records validation attempts with one repair budget and terminates a repeated failure', () => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    const first = coordinator.recordValidationFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      queryDraft: { service: 'topValues' },
      validation: { reason: 'missing_top_metric' },
      finalContent: '查询参数未构造完整。'
    });

    expect(first).toMatchObject({
      phase: QUERY_PHASES.REPAIR_PENDING,
      outcome: null,
      repairBudget: { limit: 1, used: 1, remaining: 0 },
      attempts: [{
        attemptId: 'attempt-1',
        kind: 'CONSTRUCTION',
        status: 'FAILED',
        repairOffered: true
      }]
    });

    const replay = coordinator.recordValidationFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      queryDraft: { service: 'topValues' },
      validation: { reason: 'missing_top_metric' },
      finalContent: '查询参数未构造完整。'
    });
    expect(replay).toEqual(first);

    const repeated = coordinator.recordValidationFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'attempt-2',
      queryDraft: { service: 'topValues' },
      validation: { reason: 'missing_top_metric' },
      finalContent: '查询参数未构造完整。'
    });
    expect(repeated).toMatchObject({
      phase: QUERY_PHASES.TERMINAL,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      attempts: [
        { attemptId: 'attempt-1' },
        { attemptId: 'attempt-2', duplicate: true, repairOffered: false }
      ]
    });
  });

  test('preserves failed construction attempts when the one repair succeeds', () => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    coordinator.recordValidationFailure({
      scope: 'conversation-a',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      queryDraft: { service: 'timeValues' },
      validation: { reason: 'missing_groups' },
      finalContent: '查询参数未构造完整。'
    });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      queryDraft: { service: 'timeValues', groups: [{ type: 'TotalTraffic' }] },
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    coordinator.beginExecution({ scope: 'conversation-a', turnId: 'turn-1', attemptId: 'attempt-2' });
    const success = coordinator.recordResult({
      scope: 'conversation-a',
      turnId: 'turn-1',
      result: { ok: true, rows: [{ value: 1 }] },
      finalContent: '查询成功。'
    });

    expect(success).toMatchObject({
      phase: QUERY_PHASES.TERMINAL,
      outcome: QUERY_OUTCOMES.RESULT,
      attempts: [
        { attemptId: 'attempt-1', status: 'FAILED' },
        { attemptId: 'attempt-2', status: 'SUCCEEDED' }
      ]
    });
  });

  test('binds each run to an immutable turn and resumes a pending clarification once', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-1',
      runId: 'run-1',
      route: QUERY_ROUTES.NAPM_QUERY,
      queryDraft: {
        service: 'timeValues',
        groups: [{ type: 'DefinedApp' }],
        metrics: ['TPIO']
      }
    });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      decision: {
        action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
        outcome: QUERY_OUTCOMES.CLARIFICATION,
        missingFields: ['groups[0].argument'],
        clarifyingQuestion: '请补充应用名称。'
      }
    });

    const resumed = coordinator.resumePending({
      scope: 'conversation-a',
      turnId: 'turn-2',
      runId: 'run-2',
      answer: 'HTTP'
    });

    expect(coordinator.resolveTurnId('conversation-a', 'run-1')).toBe('turn-1');
    expect(coordinator.resolveTurnId('conversation-a', 'run-2')).toBe('turn-2');
    expect(resumed).toMatchObject({
      turnId: 'turn-2',
      parentTurnId: 'turn-1',
      queryDraft: {
        service: 'timeValues',
        groups: [{ type: 'DefinedApp', argument: 'HTTP' }],
        metrics: ['TPIO']
      }
    });
    expect(coordinator.getPending('conversation-a')).toBeNull();
    expect(coordinator.resumePending({
      scope: 'conversation-a',
      turnId: 'turn-3',
      runId: 'run-3',
      answer: 'HTTP'
    })).toBeNull();
    expect(coordinator.get('conversation-a', 'turn-1')).toMatchObject({
      phase: QUERY_PHASES.TERMINAL,
      outcome: QUERY_OUTCOMES.CLARIFICATION
    });
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

  test('keeps the route immutable before and after a terminal outcome', () => {
    coordinator.begin({ scope: 'conversation-a', turnId: 'turn-1', route: QUERY_ROUTES.NAPM_QUERY });
    expect(coordinator.setRoute({
      scope: 'conversation-a',
      turnId: 'turn-1',
      route: QUERY_ROUTES.OTHER_SKILL
    })).toMatchObject({ route: QUERY_ROUTES.NAPM_QUERY, phase: QUERY_PHASES.RECEIVED });
    expect(coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'turn-1',
      route: QUERY_ROUTES.OTHER_SKILL,
      decision: {
        action: QUERY_ACTIONS.EXECUTE_QUERY,
        outcome: null,
        southboundAllowed: true
      }
    })).toMatchObject({ route: QUERY_ROUTES.NAPM_QUERY, phase: QUERY_PHASES.DECIDED });
    coordinator.recordContractViolation({
      scope: 'conversation-a',
      turnId: 'turn-1',
      finalContent: 'terminal'
    });
    const terminal = coordinator.get('conversation-a', 'turn-1');
    expect(coordinator.setRoute({
      scope: 'conversation-a',
      turnId: 'turn-1',
      route: QUERY_ROUTES.NAPM_QUERY
    })).toEqual(terminal);
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
