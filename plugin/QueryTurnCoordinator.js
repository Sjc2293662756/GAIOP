'use strict';

const QUERY_ROUTES = Object.freeze({
  MODEL_OWNED: 'MODEL_OWNED',
  NAPM_QUERY: 'NAPM_QUERY',
  OTHER_SKILL: 'OTHER_SKILL'
});

const QUERY_PHASES = Object.freeze({
  RECEIVED: 'RECEIVED',
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
  EXECUTION_FAILURE: 'EXECUTION_FAILURE'
});

const PROTECTED_OUTCOMES = new Set([
  QUERY_OUTCOMES.CLARIFICATION,
  QUERY_OUTCOMES.RESULT,
  QUERY_OUTCOMES.NO_DATA,
  QUERY_OUTCOMES.REJECTION
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class QueryTurnCoordinator {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxAgeMs = Number(options.maxAgeMs) || 90 * 1000;
    this.maxEntries = Number(options.maxEntries) || 2000;
    this.turns = new Map();
  }

  begin({ scope, turnId, route = QUERY_ROUTES.NAPM_QUERY, question = '', queryDraft = null } = {}) {
    const key = this._key(scope, turnId);
    if (!key) return null;
    const existing = this._fresh(key);
    if (existing) return clone(existing);

    const record = {
      conversationKey: String(scope).trim(),
      turnId: String(turnId).trim(),
      route,
      phase: QUERY_PHASES.RECEIVED,
      action: null,
      outcome: null,
      question: String(question || '').trim() || null,
      queryDraft: clone(queryDraft),
      decision: null,
      result: null,
      finalContent: '',
      deliveryClaimed: false,
      updatedAt: this.now()
    };
    this._set(key, record);
    return clone(record);
  }

  recordDecision({ scope, turnId, route = QUERY_ROUTES.NAPM_QUERY, question = '', queryDraft = null, decision } = {}) {
    if (!decision || typeof decision !== 'object') return null;
    const key = this._key(scope, turnId);
    if (!key) return null;
    const current = this._fresh(key) || this.begin({ scope, turnId, route, question, queryDraft });
    if (current.phase === QUERY_PHASES.TERMINAL && PROTECTED_OUTCOMES.has(current.outcome)) {
      return clone(current);
    }

    const action = String(decision.action || '').trim();
    const terminal = action === QUERY_ACTIONS.ASK_CLARIFYING_QUESTION
      || action === QUERY_ACTIONS.REJECT_QUERY;
    const outcome = terminal
      ? (decision.outcome || (action === QUERY_ACTIONS.ASK_CLARIFYING_QUESTION
        ? QUERY_OUTCOMES.CLARIFICATION
        : QUERY_OUTCOMES.REJECTION))
      : null;
    const finalContent = terminal
      ? String(decision.clarifyingQuestion || decision.rejectionMessage || '').trim()
      : '';
    const next = {
      ...current,
      route,
      phase: terminal ? QUERY_PHASES.TERMINAL : QUERY_PHASES.DECIDED,
      action,
      outcome,
      question: String(question || current.question || '').trim() || null,
      queryDraft: clone(queryDraft || decision.queryDraft || current.queryDraft),
      decision: clone(decision),
      finalContent,
      updatedAt: this.now()
    };
    this._set(key, next);
    return clone(next);
  }

  beginExecution({ scope, turnId } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._fresh(key) : null;
    if (!current || current.phase === QUERY_PHASES.TERMINAL) return clone(current);
    if (current.action !== QUERY_ACTIONS.EXECUTE_QUERY) return clone(current);
    const next = { ...current, phase: QUERY_PHASES.EXECUTING, updatedAt: this.now() };
    this._set(key, next);
    return clone(next);
  }

  recordResult({ scope, turnId, result, finalContent = '' } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._fresh(key) : null;
    if (!current) return null;
    if (current.phase === QUERY_PHASES.TERMINAL && PROTECTED_OUTCOMES.has(current.outcome)) {
      return clone(current);
    }
    const empty = Boolean(result?.summary?.empty)
      || (Array.isArray(result?.rows) && result.rows.length === 0)
      || (Array.isArray(result?.data) && result.data.length === 0);
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      outcome: empty ? QUERY_OUTCOMES.NO_DATA : QUERY_OUTCOMES.RESULT,
      result: clone(result),
      finalContent: String(finalContent || '').trim(),
      updatedAt: this.now()
    };
    this._set(key, next);
    return clone(next);
  }

  recordFailure({ scope, turnId, outcome = QUERY_OUTCOMES.EXECUTION_FAILURE, result, finalContent = '' } = {}) {
    const key = this._key(scope, turnId);
    const current = key ? this._fresh(key) : null;
    if (!current) return null;
    if (current.phase === QUERY_PHASES.TERMINAL && PROTECTED_OUTCOMES.has(current.outcome)) {
      return clone(current);
    }
    const next = {
      ...current,
      phase: QUERY_PHASES.TERMINAL,
      outcome,
      result: clone(result),
      finalContent: String(finalContent || '').trim(),
      updatedAt: this.now()
    };
    this._set(key, next);
    return clone(next);
  }

  get(scope, turnId) {
    const key = this._key(scope, turnId);
    return key ? clone(this._fresh(key)) : null;
  }

  claimDelivery(scope, turnId) {
    const key = this._key(scope, turnId);
    const current = key ? this._fresh(key) : null;
    if (!current || current.phase !== QUERY_PHASES.TERMINAL || !current.finalContent || current.deliveryClaimed) {
      return false;
    }
    this._set(key, { ...current, deliveryClaimed: true, updatedAt: this.now() });
    return true;
  }

  clearScope(scope) {
    const normalized = String(scope || '').trim();
    if (!normalized) return 0;
    let cleared = 0;
    for (const [key, record] of this.turns.entries()) {
      if (record.conversationKey === normalized && this.turns.delete(key)) cleared += 1;
    }
    return cleared;
  }

  _key(scope, turnId) {
    const normalizedScope = String(scope || '').trim();
    const normalizedTurnId = String(turnId || '').trim();
    return normalizedScope && normalizedTurnId ? `${normalizedScope}::${normalizedTurnId}` : '';
  }

  _fresh(key) {
    const record = this.turns.get(key) || null;
    if (!record) return null;
    if ((this.now() - Number(record.updatedAt || 0)) > this.maxAgeMs) {
      this.turns.delete(key);
      return null;
    }
    return record;
  }

  _set(key, record) {
    this.turns.set(key, record);
    while (this.turns.size > this.maxEntries) {
      this.turns.delete(this.turns.keys().next().value);
    }
  }
}

module.exports = {
  QUERY_ACTIONS,
  QUERY_OUTCOMES,
  QUERY_PHASES,
  QUERY_ROUTES,
  QueryTurnCoordinator
};
