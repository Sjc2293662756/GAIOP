'use strict';

const crypto = require('node:crypto');

const QUERY_ROUTES = Object.freeze({
  MODEL_OWNED: 'MODEL_OWNED',
  NAPM_QUERY: 'NAPM_QUERY',
  OTHER_SKILL: 'OTHER_SKILL'
});

const QUERY_PHASES = Object.freeze({
  RECEIVED: 'RECEIVED',
  REPAIR_PENDING: 'REPAIR_PENDING',
  DECIDED: 'DECIDED',
  EXECUTING: 'EXECUTING',
  TERMINAL: 'TERMINAL'
});

const QUERY_ACTIONS = Object.freeze({
  ASK_CLARIFYING_QUESTION: 'ASK_CLARIFYING_QUESTION',
  EXECUTE_QUERY: 'EXECUTE_QUERY',
  REJECT_QUERY: 'REJECT_QUERY'
});

const QUERY_OUTCOMES = Object.freeze({
  CLARIFICATION: 'CLARIFICATION',
  RESULT: 'RESULT',
  NO_DATA: 'NO_DATA',
  REJECTION: 'REJECTION',
  VALIDATION_FAILURE: 'VALIDATION_FAILURE',
  EXECUTION_FAILURE: 'EXECUTION_FAILURE',
  CONTRACT_VIOLATION: 'CONTRACT_VIOLATION'
});

const QUERY_ATTEMPT_KINDS = Object.freeze({
  CONSTRUCTION: 'CONSTRUCTION',
  EXECUTION: 'EXECUTION'
});

const QUERY_ATTEMPT_STATUSES = Object.freeze({
  STARTED: 'STARTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED'
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isEmptyResult(result = null) {
  return Boolean(result?.summary?.empty)
    || (Array.isArray(result?.rows) && result.rows.length === 0)
    || (Array.isArray(result?.data) && result.data.length === 0);
}

function buildFallbackFinalContent(result = null, empty = false) {
  const direct = normalizeText(
    result?.displayText
    || result?.summary?.displayText
    || result?.replyText
    || result?.narrationStructure?.displayText
  );
  if (direct) return direct;

  const lines = [];
  const title = normalizeText(result?.summary?.title);
  if (title) lines.push(title);
  if (Array.isArray(result?.summary?.highlights)) {
    lines.push(...result.summary.highlights.map(normalizeText).filter(Boolean));
  }
  if (lines.length > 0) return lines.join('\n');
  return empty ? '当前查询未查到数据。' : 'NAPM 查询已完成。';
}

class QueryTurnCoordinator {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxAgeMs = Number(options.maxAgeMs) || 90 * 1000;
    this.pendingMaxAgeMs = Number(options.pendingMaxAgeMs) || 30 * 60 * 1000;
    this.maxEntries = Number(options.maxEntries) || 2000;
    this.queryRepairBudget = Number.isInteger(options.queryRepairBudget)
      ? Math.max(0, options.queryRepairBudget)
      : 1;
    this.turns = new Map();
    this.runBindings = new Map();
    this.pendingByScope = new Map();
  }

  begin({
    scope,
    turnId,
    runId = '',
    route = QUERY_ROUTES.NAPM_QUERY,
    question = '',
    semanticQuestion = '',
    queryDraft = null,
    parentTurnId = '',
    resumedFromClarification = false,
    clarificationAnswer = ''
  } = {}) {
    const key = this._key(scope, turnId);
    if (!key) return null;
    const existing = this._freshTurn(key);
    if (existing) {
      this.bindRun({ scope, runId, turnId });
      return clone(existing);
    }

    const record = {
      conversationKey: normalizeText(scope),
      turnId: normalizeText(turnId),
      runId: normalizeText(runId) || null,
      parentTurnId: normalizeText(parentTurnId) || null,
      resumedFromClarification: Boolean(resumedFromClarification),
      clarificationAnswer: normalizeText(clarificationAnswer) || null,
      route,
      phase: QUERY_PHASES.RECEIVED,
      action: null,
      outcome: null,
      question: normalizeText(question) || null,
      semanticQuestion: normalizeText(semanticQuestion || question) || null,
      queryDraft: clone(queryDraft),
      decision: null,
      attempts: [],
      repairBudget: {
        limit: this.queryRepairBudget,
        used: 0,
        remaining: this.queryRepairBudget
      },
      result: null,
      finalContent: '',
      contractViolation: null,
      deliveryClaimed: false,
      updatedAt: this.now()
    };
    this._setTurn(key, record);
    this.bindRun({ scope, runId, turnId });
    return clone(record);
  }

  bindRun({ scope, runId, turnId } = {}) {
    const key = this._runKey(scope, runId);
    const normalizedTurnId = normalizeText(turnId);
    if (!key || !normalizedTurnId) return false;
    const existing = this._freshRunBinding(key);
    if (existing) return existing.turnId === normalizedTurnId;
    this.runBindings.set(key, {
      conversationKey: normalizeText(scope),
      runId: normalizeText(runId),
      turnId: normalizedTurnId,
      updatedAt: this.now()
    });
    this._trim(this.runBindings);
    return true;
  }

  resolveTurnId(scope, runId) {
    const key = this._runKey(scope, runId);
    return key ? normalizeText(this._freshRunBinding(key)?.turnId) : '';
  }

  getByRun(scope, runId) {
    const turnId = this.resolveTurnId(scope, runId);
    return turnId ? this.get(scope, turnId) : null;
  }

  setRoute({ scope, turnId, route } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (!current || !Object.values(QUERY_ROUTES).includes(route)) return clone(current);
    return clone(current);
  }

  recordDecision({
    scope,
    turnId,
    route = QUERY_ROUTES.NAPM_QUERY,
    question = '',
    queryDraft = null,
    decision,
    attemptId = ''
  } = {}) {
    if (!decision || typeof decision !== 'object') return null;
    const key = this._key(scope, turnId);
    if (!key) return null;
    const current = this._freshTurn(key) || this.begin({ scope, turnId, route, question, queryDraft });
    if ([QUERY_PHASES.EXECUTING, QUERY_PHASES.TERMINAL].includes(current.phase)) {
      return clone(current);
    }

    if (decision.outcome === QUERY_OUTCOMES.VALIDATION_FAILURE) {
      return this.recordValidationFailure({
        scope,
        turnId,
        attemptId,
        queryDraft: queryDraft || decision.queryDraft,
        validation: decision.validation || decision,
        result: decision,
        finalContent: decision.finalContent
      });
    }

    const action = normalizeText(decision.action);
    const terminal = action === QUERY_ACTIONS.ASK_CLARIFYING_QUESTION
      || action === QUERY_ACTIONS.REJECT_QUERY;
    const outcome = terminal
      ? (decision.outcome || (action === QUERY_ACTIONS.ASK_CLARIFYING_QUESTION
        ? QUERY_OUTCOMES.CLARIFICATION
        : QUERY_OUTCOMES.REJECTION))
      : null;
    const finalContent = terminal
      ? normalizeText(decision.clarifyingQuestion || decision.rejectionMessage)
      : '';
    const next = {
      ...current,
      route: current.route,
      phase: terminal ? QUERY_PHASES.TERMINAL : QUERY_PHASES.DECIDED,
      action,
      outcome,
      question: normalizeText(question || current.question) || null,
      queryDraft: clone(decision.queryDraft || queryDraft || current.queryDraft),
      decision: clone(decision),
      finalContent,
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    if (outcome === QUERY_OUTCOMES.CLARIFICATION) this._rememberPending(next);
    return clone(next);
  }

  recordValidationFailure({
    scope,
    turnId,
    attemptId = '',
    queryDraft = null,
    validation = null,
    result = null,
    finalContent = ''
  } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (!current) return null;
    if ([QUERY_PHASES.EXECUTING, QUERY_PHASES.TERMINAL].includes(current.phase)) {
      return clone(current);
    }

    const normalizedAttemptId = normalizeText(attemptId) || `construction-${current.attempts.length + 1}`;
    if (current.attempts.some((attempt) => attempt.attemptId === normalizedAttemptId)) return clone(current);
    const failureFingerprint = fingerprint({ queryDraft, validation });
    const priorFailures = current.attempts.filter((attempt) => (
      attempt.kind === QUERY_ATTEMPT_KINDS.CONSTRUCTION
      && attempt.status === QUERY_ATTEMPT_STATUSES.FAILED
    ));
    const duplicate = priorFailures.some((attempt) => attempt.fingerprint === failureFingerprint);
    const mayRepair = priorFailures.length === 0 && current.repairBudget.remaining > 0;
    const attempt = {
      attemptId: normalizedAttemptId,
      ordinal: current.attempts.length + 1,
      kind: QUERY_ATTEMPT_KINDS.CONSTRUCTION,
      status: QUERY_ATTEMPT_STATUSES.FAILED,
      fingerprint: failureFingerprint,
      reasonCode: normalizeText(validation?.reasonCode || validation?.reason || validation?.code) || null,
      duplicate,
      repairOffered: mayRepair,
      updatedAt: this.now()
    };
    const repairBudget = mayRepair
      ? {
          ...current.repairBudget,
          used: current.repairBudget.used + 1,
          remaining: Math.max(0, current.repairBudget.remaining - 1)
        }
      : current.repairBudget;
    const terminal = !mayRepair;
    const next = {
      ...current,
      phase: terminal ? QUERY_PHASES.TERMINAL : QUERY_PHASES.REPAIR_PENDING,
      action: terminal ? QUERY_ACTIONS.REJECT_QUERY : null,
      outcome: terminal ? QUERY_OUTCOMES.VALIDATION_FAILURE : null,
      queryDraft: clone(queryDraft || current.queryDraft),
      attempts: [...current.attempts, attempt],
      repairBudget,
      result: clone(result || validation),
      finalContent: terminal
        ? (normalizeText(finalContent) || '查询参数未构造完整，本轮已停止重试。')
        : '',
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    return clone(next);
  }

  beginExecution({ scope, turnId, attemptId = '', queryDraft = null } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (!current || current.phase === QUERY_PHASES.TERMINAL) return clone(current);
    if (
      current.phase !== QUERY_PHASES.DECIDED
      || current.action !== QUERY_ACTIONS.EXECUTE_QUERY
    ) {
      return clone(current);
    }

    const normalizedAttemptId = normalizeText(attemptId) || `execution-${current.attempts.length + 1}`;
    if (current.attempts.some((attempt) => attempt.attemptId === normalizedAttemptId)) return clone(current);
    const attempt = {
      attemptId: normalizedAttemptId,
      ordinal: current.attempts.length + 1,
      kind: QUERY_ATTEMPT_KINDS.EXECUTION,
      status: QUERY_ATTEMPT_STATUSES.STARTED,
      fingerprint: fingerprint(queryDraft || current.queryDraft),
      reasonCode: null,
      duplicate: false,
      repairOffered: false,
      updatedAt: this.now()
    };
    const next = {
      ...current,
      phase: QUERY_PHASES.EXECUTING,
      queryDraft: clone(queryDraft || current.queryDraft),
      attempts: [...current.attempts, attempt],
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    return clone(next);
  }

  recordExecutionClarification({
    scope,
    turnId,
    decision = null,
    result = null,
    finalContent = ''
  } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (
      !current
      || current.route !== QUERY_ROUTES.NAPM_QUERY
      || current.phase !== QUERY_PHASES.EXECUTING
    ) {
      return clone(current);
    }

    const clarifyingQuestion = normalizeText(
      decision?.clarifyingQuestion
      || decision?.clarifying_question
      || result?.displayText
      || result?.summary?.displayText
    );
    const normalizedDecision = {
      ...(clone(decision) || {}),
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      clarifyingQuestion,
      southboundAllowed: false
    };
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
      outcome: QUERY_OUTCOMES.CLARIFICATION,
      decision: normalizedDecision,
      queryDraft: clone(normalizedDecision.queryDraft || current.queryDraft),
      attempts: this._completeExecutionAttempt(current.attempts, QUERY_ATTEMPT_STATUSES.SUCCEEDED),
      result: clone(result),
      finalContent: normalizeText(finalContent) || clarifyingQuestion || '请补充查询范围后重试。',
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    this._rememberPending(next);
    return clone(next);
  }

  recordResult({ scope, turnId, result, finalContent = '' } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (
      !current
      || current.route !== QUERY_ROUTES.NAPM_QUERY
      || current.phase !== QUERY_PHASES.EXECUTING
    ) {
      return clone(current);
    }
    const empty = isEmptyResult(result);
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      outcome: empty ? QUERY_OUTCOMES.NO_DATA : QUERY_OUTCOMES.RESULT,
      attempts: this._completeExecutionAttempt(current.attempts, QUERY_ATTEMPT_STATUSES.SUCCEEDED),
      result: clone(result),
      finalContent: normalizeText(finalContent) || buildFallbackFinalContent(result, empty),
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    return clone(next);
  }

  recordFailure({ scope, turnId, outcome = QUERY_OUTCOMES.EXECUTION_FAILURE, result, finalContent = '' } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (
      !current
      || current.route !== QUERY_ROUTES.NAPM_QUERY
      || current.phase !== QUERY_PHASES.EXECUTING
    ) {
      return clone(current);
    }
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      outcome,
      attempts: outcome === QUERY_OUTCOMES.EXECUTION_FAILURE
        ? this._completeExecutionAttempt(current.attempts, QUERY_ATTEMPT_STATUSES.FAILED, result)
        : current.attempts,
      result: clone(result),
      finalContent: normalizeText(finalContent) || 'NAPM 查询执行失败，请稍后重试。',
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    return clone(next);
  }

  recordRepairAbandoned({ scope, turnId, result = null, finalContent = '' } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (
      !current
      || current.route !== QUERY_ROUTES.NAPM_QUERY
      || current.phase !== QUERY_PHASES.REPAIR_PENDING
    ) {
      return clone(current);
    }
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      action: QUERY_ACTIONS.REJECT_QUERY,
      outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
      result: clone(result || current.result),
      finalContent: normalizeText(finalContent) || '查询参数未构造完整，本轮已停止重试。',
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    return clone(next);
  }

  recordContractViolation({ scope, turnId, reasonCode = 'QUERY_TOOL_CONTRACT_VIOLATION', finalContent = '' } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (!current) return null;
    if (current.phase === QUERY_PHASES.TERMINAL) return clone(current);
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      outcome: QUERY_OUTCOMES.CONTRACT_VIOLATION,
      contractViolation: {
        reasonCode: normalizeText(reasonCode) || 'QUERY_TOOL_CONTRACT_VIOLATION',
        recordedAt: this.now()
      },
      finalContent: normalizeText(finalContent) || '本轮未执行必需的 NAPM 查询工具，无法提供查询结果。',
      updatedAt: this.now()
    };
    this._setTurn(key, next);
    return clone(next);
  }

  get(scope, turnId) {
    const key = this._key(scope, turnId);
    return key ? clone(this._freshTurn(key)) : null;
  }

  getPending(scope) {
    const normalizedScope = normalizeText(scope);
    return normalizedScope ? clone(this._freshPending(normalizedScope)) : null;
  }

  resumePending({ scope, turnId, runId = '', answer = '' } = {}) {
    const normalizedScope = normalizeText(scope);
    const normalizedAnswer = normalizeText(answer);
    const pending = normalizedScope ? this._freshPending(normalizedScope) : null;
    if (!pending || !normalizedAnswer) return null;

    const queryDraft = clone(pending.queryDraft);
    const missingField = (pending.missingFields || []).find((field) => /^groups\[\d+\]\.argument$/.test(field));
    const match = missingField?.match(/^groups\[(\d+)\]\.argument$/);
    const groupIndex = match ? Number(match[1]) : -1;
    if (!queryDraft || !Array.isArray(queryDraft.groups) || !queryDraft.groups[groupIndex]) return null;
    queryDraft.groups[groupIndex] = {
      ...queryDraft.groups[groupIndex],
      argument: normalizedAnswer
    };

    const key = this._key(normalizedScope, turnId);
    const existing = key ? this._freshTurn(key) : null;
    if (existing && existing.phase !== QUERY_PHASES.RECEIVED) return null;

    let record;
    if (existing) {
      record = {
        ...existing,
        parentTurnId: pending.turnId,
        resumedFromClarification: true,
        clarificationAnswer: normalizedAnswer,
        route: existing.route,
        question: normalizedAnswer,
        semanticQuestion: normalizeText(pending.semanticQuestion || pending.question) || null,
        queryDraft,
        updatedAt: this.now()
      };
      this._setTurn(key, record);
      this.bindRun({ scope: normalizedScope, runId, turnId });
      record = clone(record);
    } else {
      record = this.begin({
        scope: normalizedScope,
        turnId,
        runId,
        route: QUERY_ROUTES.NAPM_QUERY,
        question: normalizedAnswer,
        semanticQuestion: pending.semanticQuestion || pending.question,
        queryDraft,
        parentTurnId: pending.turnId,
        resumedFromClarification: true,
        clarificationAnswer: normalizedAnswer
      });
    }
    if (!record) return null;
    this.pendingByScope.delete(normalizedScope);
    return record;
  }

  claimDelivery(scope, turnId) {
    const key = this._key(scope, turnId);
    const current = key ? this._freshTurn(key) : null;
    if (!current || current.phase !== QUERY_PHASES.TERMINAL || !current.finalContent || current.deliveryClaimed) {
      return false;
    }
    this._setTurn(key, { ...current, deliveryClaimed: true, updatedAt: this.now() });
    return true;
  }

  clearScope(scope) {
    const normalized = normalizeText(scope);
    if (!normalized) return 0;
    let cleared = 0;
    for (const [key, record] of this.turns.entries()) {
      if (record.conversationKey === normalized && this.turns.delete(key)) cleared += 1;
    }
    for (const [key, record] of this.runBindings.entries()) {
      if (record.conversationKey === normalized && this.runBindings.delete(key)) cleared += 1;
    }
    if (this.pendingByScope.delete(normalized)) cleared += 1;
    return cleared;
  }

  _rememberPending(record) {
    if (!record?.conversationKey || !record?.turnId || !record?.queryDraft) return;
    const missingFields = Array.isArray(record?.decision?.missingFields)
      ? record.decision.missingFields.map(normalizeText).filter(Boolean)
      : [];
    if (!missingFields.some((field) => /^groups\[\d+\]\.argument$/.test(field))) return;
    this.pendingByScope.set(record.conversationKey, {
      conversationKey: record.conversationKey,
      turnId: record.turnId,
      question: record.question,
      semanticQuestion: record.semanticQuestion || record.question,
      queryDraft: clone(record.queryDraft),
      missingFields,
      updatedAt: this.now()
    });
    this._trim(this.pendingByScope);
  }

  _completeExecutionAttempt(attempts = [], status, result = null) {
    const next = clone(attempts) || [];
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (
        next[index].kind === QUERY_ATTEMPT_KINDS.EXECUTION
        && next[index].status === QUERY_ATTEMPT_STATUSES.STARTED
      ) {
        next[index] = {
          ...next[index],
          status,
          reasonCode: status === QUERY_ATTEMPT_STATUSES.FAILED
            ? normalizeText(result?.error?.code || result?.code || result?.reason) || null
            : null,
          updatedAt: this.now()
        };
        return next;
      }
    }
    return next;
  }

  _key(scope, turnId) {
    const normalizedScope = normalizeText(scope);
    const normalizedTurnId = normalizeText(turnId);
    return normalizedScope && normalizedTurnId ? `${normalizedScope}::${normalizedTurnId}` : '';
  }

  _runKey(scope, runId) {
    const normalizedScope = normalizeText(scope);
    const normalizedRunId = normalizeText(runId);
    return normalizedScope && normalizedRunId ? `${normalizedScope}::run::${normalizedRunId}` : '';
  }

  _freshTurn(key) {
    return this._fresh(this.turns, key, this.maxAgeMs);
  }

  _freshRunBinding(key) {
    return this._fresh(this.runBindings, key, this.maxAgeMs);
  }

  _freshPending(scope) {
    return this._fresh(this.pendingByScope, scope, this.pendingMaxAgeMs);
  }

  _fresh(map, key, maxAgeMs) {
    const record = map.get(key) || null;
    if (!record) return null;
    if ((this.now() - Number(record.updatedAt || 0)) > maxAgeMs) {
      map.delete(key);
      return null;
    }
    return record;
  }

  _setTurn(key, record) {
    this.turns.set(key, record);
    this._trim(this.turns);
  }

  _trim(map) {
    while (map.size > this.maxEntries) map.delete(map.keys().next().value);
  }
}

module.exports = {
  QUERY_ACTIONS,
  QUERY_ATTEMPT_KINDS,
  QUERY_ATTEMPT_STATUSES,
  QUERY_OUTCOMES,
  QUERY_PHASES,
  QUERY_ROUTES,
  QueryTurnCoordinator
};
