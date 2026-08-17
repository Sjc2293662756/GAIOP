'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ConversationOperationState = require('../plugin/ConversationOperationState');
const TrustedToolContextStore = require('../plugin/TrustedToolContextStore');

describe('NAPM turn state', () => {
  test('correlates results and fallback delivery by scope plus turnId', () => {
    const state = new ConversationOperationState({ now: () => 1000 });
    const first = state.rememberSkillResult({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::original',
      result: { ok: true, value: 'first' }
    });
    const second = state.rememberSkillResult({
      scope: 'session:one',
      turnId: 'turn-2',
      promptKey: 'session:one::metadata-prefixed',
      result: { ok: true, value: 'second' }
    });

    expect(state.getSkillResultForTurn('session:one', 'turn-1')).toBe(first);
    expect(state.getSkillResultForTurn('session:one', 'turn-2')).toBe(second);
    expect(state.claimFallbackDelivery('session:one', 'turn-1')).toBe(true);
    expect(state.claimFallbackDelivery('session:one', 'turn-1')).toBe(false);
    expect(state.claimFallbackDelivery('session:one', 'turn-2')).toBe(true);
    expect(state.claimFinalDelivery('session:one', 'turn-1')).toBe(true);
    expect(state.claimFinalDelivery('session:one', 'turn-1')).toBe(false);
    expect(state.claimFinalDelivery('session:one', 'turn-2')).toBe(true);
  });

  test('keeps a successful turn result when a later explicit failure is remembered', () => {
    const state = new ConversationOperationState({ now: () => 1000 });
    const success = state.rememberSkillResult({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: { ok: true, rows: [{ value: 'Web-01' }] }
    });

    const remembered = state.rememberSkillResult({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: { ok: false, error: { code: 'UPSTREAM_RESOLVED_QUERY_INVALID' } }
    });

    expect(remembered).toBe(success);
    expect(state.getSkillResultForTurn('session:one', 'turn-1')).toBe(success);
    expect(state.getLatestSkillResult('session:one')).toBe(success);
  });

  test('allows one query repair and terminates repeated or subsequent construction failures', () => {
    const state = new ConversationOperationState({ now: () => 1000, queryRepairBudget: 1 });
    const failure = {
      ok: false,
      error: { code: 'UPSTREAM_RESOLVED_QUERY_INVALID', reason: 'missing_metric' }
    };

    const first = state.rememberQueryFailure({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: failure,
      resolvedQuery: { service: 'topValues' }
    });
    const repeated = state.rememberQueryFailure({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: failure,
      resolvedQuery: { service: 'topValues' }
    });

    expect(first).toMatchObject({ attemptCount: 1, mayRepair: true, terminal: false });
    expect(repeated).toMatchObject({ attemptCount: 2, mayRepair: false, terminal: true, duplicate: true });
    expect(state.getQueryFailureForTurn('session:one', 'turn-1')).toBe(repeated);
  });

  test('clears a construction failure after a valid query is accepted for the turn', () => {
    const state = new ConversationOperationState({ now: () => 1000, queryRepairBudget: 1 });
    state.rememberQueryFailure({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: {
        ok: false,
        error: { code: 'UPSTREAM_RESOLVED_QUERY_INVALID', reason: 'incomplete_resolved_query' }
      },
      resolvedQuery: { service: 'groups', queryModeKey: 'metadata' }
    });

    expect(state.clearQueryFailureForTurn('session:one', 'turn-1')).toBe(1);
    expect(state.getQueryFailureForTurn('session:one', 'turn-1')).toBeNull();
  });

  test('stores and clears a Skill execution failure separately from query construction', () => {
    const state = new ConversationOperationState({ now: () => 1000 });
    const record = state.rememberSkillExecutionFailure({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: {
        ok: false,
        error: { code: 'NAPM_SKILL_EXECUTION_FAILED' }
      },
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }]
      }
    });

    expect(record).toMatchObject({ recordType: 'skill_execution_failure' });
    expect(state.getSkillExecutionFailureForTurn('session:one', 'turn-1')).toBe(record);
    expect(state.getQueryFailureForTurn('session:one', 'turn-1')).toBeNull();
    expect(state.clearSkillExecutionFailureForTurn('session:one', 'turn-1')).toBe(1);
    expect(state.getSkillExecutionFailureForTurn('session:one', 'turn-1')).toBeNull();
  });

  test('claims final delivery only after current-turn content is prepared', () => {
    const state = new ConversationOperationState({ now: () => 1000 });

    expect(state.claimPreparedFinalDelivery('session:one', 'turn-1')).toBe(false);
    expect(state.getPreparedFinalContent('session:one', 'turn-1')).toBeNull();

    const prepared = state.prepareFinalContent({
      scope: 'session:one',
      turnId: 'turn-1',
      content: '告警事件 745506 的数据包证据显示，服务器响应等待是本次时延升高的主要原因。',
      source: 'assistant_final',
      workflowState: 'COMPLETED'
    });

    expect(prepared).toMatchObject({
      conversationKey: 'session:one',
      turnId: 'turn-1',
      content: expect.stringContaining('745506'),
      source: 'assistant_final',
      workflowState: 'COMPLETED',
      state: 'FINAL_CONTENT_READY',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(state.getPreparedFinalContent('session:one', 'turn-1')).toBe(prepared);
    expect(state.claimPreparedFinalDelivery('session:one', 'turn-1')).toBe(true);
    expect(state.claimPreparedFinalDelivery('session:one', 'turn-1')).toBe(false);
  });

  test('persists turnId with trusted tool context', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-trusted-turn-'));
    try {
      const store = new TrustedToolContextStore({ baseDir, now: () => 1000 });
      expect(store.put({
        traceId: 'trace-1',
        scope: 'session:one',
        turnId: 'turn-1',
        toolName: 'napm-summary'
      })).toMatchObject({ ok: true, turnId: 'turn-1' });
      expect(store.get('trace-1')).toMatchObject({
        ok: true,
        scope: 'session:one',
        turnId: 'turn-1',
        toolName: 'napm-summary'
      });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('clears all operation records for one scope without affecting another scope', () => {
    const state = new ConversationOperationState({ now: () => 1000 });
    state.rememberSkillResult({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      result: { ok: true }
    });
    state.rememberDebugApi({
      scope: 'session:one',
      turnId: 'turn-1',
      promptKey: 'session:one::prompt',
      requestUrl: 'https://example.test/query'
    });
    state.rememberReportExport({
      scope: 'session:one',
      prompt: 'report',
      result: { ok: true }
    });
    state.claimFallbackDelivery('session:one', 'turn-1');
    state.claimFinalDelivery('session:one', 'turn-1');
    state.prepareFinalContent({
      scope: 'session:one',
      turnId: 'turn-1',
      content: 'prepared final',
      source: 'deterministic_fallback',
      workflowState: 'COMPLETED'
    });
    state.rememberSkillResult({
      scope: 'session:two',
      turnId: 'turn-2',
      promptKey: 'session:two::prompt',
      result: { ok: true, value: 'keep' }
    });

    expect(state.clearScope('session:one')).toBeGreaterThan(0);

    expect(state.getSkillResult('session:one::prompt')).toBeNull();
    expect(state.getSkillResultForTurn('session:one', 'turn-1')).toBeNull();
    expect(state.getLatestSkillResult('session:one')).toBeNull();
    expect(state.getDebugApi('session:one::prompt')).toBeNull();
    expect(state.getLatestDebugApi('session:one')).toBeNull();
    expect(state.getReportExport('session:one')).toBeNull();
    expect(state.claimFallbackDelivery('session:one', 'turn-1')).toBe(true);
    expect(state.claimFinalDelivery('session:one', 'turn-1')).toBe(true);
    expect(state.getPreparedFinalContent('session:one', 'turn-1')).toBeNull();
    expect(state.claimPreparedFinalDelivery('session:one', 'turn-1')).toBe(false);
    expect(state.getLatestSkillResult('session:two')?.result?.value).toBe('keep');
  });

  test('clears persisted trusted contexts for one scope only', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-trusted-clear-'));
    try {
      const store = new TrustedToolContextStore({ baseDir, now: () => 1000 });
      store.put({ traceId: 'trace-one', scope: 'session:one', turnId: 'turn-1' });
      store.put({ traceId: 'trace-two', scope: 'session:two', turnId: 'turn-2' });

      expect(store.clearScope('session:one')).toBe(1);
      expect(store.get('trace-one')).toMatchObject({ ok: false, errorCode: 'TRUSTED_CONTEXT_NOT_FOUND' });
      expect(store.get('trace-two')).toMatchObject({ ok: true, scope: 'session:two' });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
