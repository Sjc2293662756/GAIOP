'use strict';

const {
  QUERY_ACTIONS,
  QUERY_OUTCOMES,
  QUERY_PHASES,
  QUERY_ROUTES,
  QueryTurnCoordinator
} = require('../plugin/QueryTurnCoordinator');
const {
  extractPageFamilyId
} = require('../skills/shared/NapmPageViewsContract');

describe('QueryTurnCoordinator', () => {
  let now;
  let coordinator;

  beforeEach(() => {
    now = 1000;
    coordinator = new QueryTurnCoordinator({
      now: () => now,
      maxAgeMs: 10_000,
      extractPageFamilyId
    });
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

  test('adopts an unclaimed message turn when the agent run has a different identity', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-message',
      route: QUERY_ROUTES.NAPM_QUERY,
      question: '最近 7 天应用流量趋势如何？',
      sourcePrompt: '最近 7 天应用流量趋势如何？'
    });
    coordinator.bindRun({
      scope: 'conversation-a',
      runId: 'message-id',
      turnId: 'turn-message'
    });

    const adopted = coordinator.adoptReceivedTurn({
      scope: 'conversation-a',
      runId: 'agent-run-id',
      prompt: [
        'Conversation info (untrusted metadata):',
        '{"message_id":"message-id"}',
        '',
        '最近 7 天应用流量趋势如何？'
      ].join('\n')
    });

    expect(adopted).toMatchObject({
      turnId: 'turn-message',
      runId: 'agent-run-id',
      phase: QUERY_PHASES.RECEIVED
    });
    expect(coordinator.resolveTurnId('conversation-a', 'message-id')).toBe('turn-message');
    expect(coordinator.resolveTurnId('conversation-a', 'agent-run-id')).toBe('turn-message');
  });

  test('does not adopt a received turn whose source prompt does not match', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-a',
      route: QUERY_ROUTES.NAPM_QUERY,
      question: '应用 A 流量趋势',
      sourcePrompt: '应用 A 流量趋势'
    });

    expect(coordinator.adoptReceivedTurn({
      scope: 'conversation-a',
      runId: 'run-b',
      prompt: '应用 B 流量趋势'
    })).toBeNull();
    expect(coordinator.resolveTurnId('conversation-a', 'run-b')).toBe('');
    expect(coordinator.get('conversation-a', 'turn-a')).toMatchObject({
      runId: null,
      phase: QUERY_PHASES.RECEIVED
    });
  });

  test('adopts overlapping received turns only when their source prompts match', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-application',
      route: QUERY_ROUTES.NAPM_QUERY,
      question: '应用流量趋势',
      sourcePrompt: '应用流量趋势'
    });
    now += 1;
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'turn-business',
      route: QUERY_ROUTES.NAPM_QUERY,
      question: '业务流量趋势',
      sourcePrompt: '业务流量趋势'
    });

    expect(coordinator.adoptReceivedTurn({
      scope: 'conversation-a',
      runId: 'run-business',
      prompt: '业务流量趋势'
    })).toMatchObject({ turnId: 'turn-business', runId: 'run-business' });
    expect(coordinator.adoptReceivedTurn({
      scope: 'conversation-a',
      runId: 'run-application',
      prompt: '应用流量趋势'
    })).toMatchObject({ turnId: 'turn-application', runId: 'run-application' });
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

  test('stores a minimal PageFamily result set and resolves an ordinal in the same scope', () => {
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'page-rank-turn',
      route: QUERY_ROUTES.NAPM_QUERY,
      queryDraft: {
        service: 'topValues',
        start: 1785310980,
        end: 1785314580,
        groups: [{ type: 'WebApplication', argument: 'business-a' }, { type: 'PageFamily' }]
      }
    });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'page-rank-turn',
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    coordinator.beginExecution({ scope: 'conversation-a', turnId: 'page-rank-turn', attemptId: 'rank-execute' });
    coordinator.recordResult({
      scope: 'conversation-a',
      turnId: 'page-rank-turn',
      result: {
        ok: true,
        data: [
          { groupPath: 'root>pages>page 8573007/https://example.invalid/first' },
          { groupPath: 'root>pages>page 8573008/https://example.invalid/second' }
        ]
      }
    });

    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'detail-turn',
      route: QUERY_ROUTES.NAPM_QUERY
    });
    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      turnId: 'detail-turn',
      reference: { objectType: 'PageFamily', ordinal: 1 }
    })).toMatchObject({
      ok: true,
      pageFamilyId: '8573007',
      inheritedQuery: {
        start: 1785310980,
        end: 1785314580
      },
      sourceReference: {
        objectType: 'PageFamily',
        ordinal: 1,
        sourceTurnId: 'page-rank-turn'
      }
    });
    const referenceSet = coordinator.getLatestResultReference('conversation-a');
    expect(referenceSet.rows).toEqual([
      expect.objectContaining({ ordinal: 1, pageFamilyId: '8573007' }),
      expect.objectContaining({ ordinal: 2, pageFamilyId: '8573008' })
    ]);
    expect(referenceSet.rows[0]).not.toHaveProperty('groupPath');
  });

  test('rejects expired, out-of-range, wrong-type, and cross-scope references', () => {
    coordinator = new QueryTurnCoordinator({
      now: () => now,
      maxAgeMs: 10_000,
      resultReferenceMaxAgeMs: 20_000,
      extractPageFamilyId
    });
    coordinator.begin({
      scope: 'conversation-a',
      turnId: 'rank-turn',
      queryDraft: {
        service: 'topValues',
        start: 1785310980,
        end: 1785314580,
        groups: [{ type: 'PageFamily' }]
      }
    });
    coordinator.recordDecision({
      scope: 'conversation-a',
      turnId: 'rank-turn',
      decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
    });
    coordinator.beginExecution({ scope: 'conversation-a', turnId: 'rank-turn', attemptId: 'execute' });
    coordinator.recordResult({
      scope: 'conversation-a',
      turnId: 'rank-turn',
      result: { ok: true, data: [{ pageFamilyId: '8573007', page: '/first' }] }
    });
    const resultSetId = coordinator.getLatestResultReference('conversation-a').resultSetId;

    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      reference: { objectType: 'PageFamily', ordinal: 2 }
    })).toMatchObject({ ok: false, code: 'RESULT_REFERENCE_ORDINAL_OUT_OF_RANGE' });
    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      reference: { objectType: 'DefinedApp', ordinal: 1 }
    })).toMatchObject({ ok: false, code: 'RESULT_REFERENCE_OBJECT_TYPE_MISMATCH' });
    expect(coordinator.resolveResultReference({
      scope: 'conversation-b',
      reference: { resultSetId, objectType: 'PageFamily', ordinal: 1 }
    })).toMatchObject({ ok: false, code: 'RESULT_REFERENCE_SCOPE_MISMATCH' });

    now += 20_001;
    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      reference: { resultSetId, objectType: 'PageFamily', ordinal: 1 }
    })).toMatchObject({ ok: false, code: 'RESULT_REFERENCE_EXPIRED' });
  });

  test('freezes the source result set when overlapping turns begin', () => {
    const completeRanking = (turnId, pageFamilyId) => {
      coordinator.begin({
        scope: 'conversation-a',
        turnId,
        queryDraft: {
          service: 'topValues',
          start: 1785310980,
          end: 1785314580,
          groups: [{ type: 'PageFamily' }]
        }
      });
      coordinator.recordDecision({
        scope: 'conversation-a',
        turnId,
        decision: { action: QUERY_ACTIONS.EXECUTE_QUERY, southboundAllowed: true }
      });
      coordinator.beginExecution({ scope: 'conversation-a', turnId, attemptId: `${turnId}-execute` });
      coordinator.recordResult({
        scope: 'conversation-a',
        turnId,
        result: { ok: true, data: [{ pageFamilyId }] }
      });
    };

    completeRanking('rank-a', '8573007');
    const sourceA = coordinator.getLatestResultReference('conversation-a');
    coordinator.begin({ scope: 'conversation-a', turnId: 'detail-a' });
    completeRanking('rank-b', '8573999');
    const sourceB = coordinator.getLatestResultReference('conversation-a');

    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      turnId: 'detail-a',
      reference: { objectType: 'PageFamily', ordinal: 1 }
    })).toMatchObject({ ok: true, pageFamilyId: '8573007' });
    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      turnId: 'detail-a',
      reference: {
        resultSetId: sourceA.resultSetId,
        objectType: 'PageFamily',
        ordinal: 1
      }
    })).toMatchObject({ ok: true, pageFamilyId: '8573007' });
    expect(coordinator.resolveResultReference({
      scope: 'conversation-a',
      turnId: 'detail-a',
      reference: {
        resultSetId: sourceB.resultSetId,
        objectType: 'PageFamily',
        ordinal: 1
      }
    })).toMatchObject({ ok: false, code: 'RESULT_REFERENCE_SOURCE_MISMATCH' });
  });
});
