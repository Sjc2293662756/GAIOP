'use strict';

const crypto = require('node:crypto');

class ConversationOperationState {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.resultMaxAgeMs = Number(options.resultMaxAgeMs) || 90 * 1000;
    this.reportMaxAgeMs = Number(options.reportMaxAgeMs) || 5 * 60 * 1000;
    this.maxEntries = Number(options.maxEntries) || 2000;
    this.queryRepairBudget = Number.isInteger(options.queryRepairBudget)
      ? Math.max(0, options.queryRepairBudget)
      : 1;
    this.skillByPrompt = new Map();
    this.skillByTurn = new Map();
    this.latestSkillByScope = new Map();
    this.queryFailureByPrompt = new Map();
    this.queryFailureByTurn = new Map();
    this.skillExecutionFailureByPrompt = new Map();
    this.skillExecutionFailureByTurn = new Map();
    this.debugByPrompt = new Map();
    this.latestDebugByScope = new Map();
    this.reportByScope = new Map();
    this.fallbackDeliveryByTurn = new Map();
    this.finalDeliveryByTurn = new Map();
    this.preparedFinalByTurn = new Map();
  }

  rememberSkillResult({ scope, turnId = '', promptKey, result, requestUrl = '', resolvedQuery = null }) {
    if (!this._isUsableScope(scope) || !promptKey || !result || typeof result !== 'object') {
      return null;
    }

    const normalizedTurnId = this._normalizeTurnId(turnId);
    const turnKey = this._buildTurnKey(scope, normalizedTurnId);
    const existingTurnRecord = turnKey
      ? this._getFresh(this.skillByTurn, turnKey, this.resultMaxAgeMs)
      : null;
    const existingPromptRecord = this._getFresh(this.skillByPrompt, promptKey, this.resultMaxAgeMs);
    const protectedSuccess = this._isExplicitSuccess(existingTurnRecord?.result)
      ? existingTurnRecord
      : (this._isExplicitSuccess(existingPromptRecord?.result) ? existingPromptRecord : null);
    if (protectedSuccess && this._isExplicitFailure(result)) {
      return protectedSuccess;
    }

    const record = {
      recordType: 'skill_execution_result',
      promptKey,
      conversationKey: scope,
      turnId: normalizedTurnId || null,
      updatedAt: this.now(),
      requestUrl: String(requestUrl || '').trim(),
      resolvedQuery: resolvedQuery && typeof resolvedQuery === 'object' ? resolvedQuery : null,
      result
    };
    this._prune();
    this.skillByPrompt.set(promptKey, record);
    if (turnKey) {
      this.skillByTurn.set(turnKey, record);
    }
    this.latestSkillByScope.set(scope, record);
    if (this._isExplicitSuccess(result)) {
      this.clearQueryFailureForTurn(scope, normalizedTurnId);
      this.clearSkillExecutionFailureForTurn(scope, normalizedTurnId);
    }
    this._trim(this.skillByPrompt);
    this._trim(this.skillByTurn);
    this._trim(this.latestSkillByScope);
    return record;
  }

  rememberQueryFailure({ scope, turnId = '', promptKey, result, resolvedQuery = null }) {
    if (!this._isUsableScope(scope) || !promptKey || !this._isExplicitFailure(result)) {
      return null;
    }

    const normalizedTurnId = this._normalizeTurnId(turnId);
    const turnKey = this._buildTurnKey(scope, normalizedTurnId);
    const recordKey = turnKey || promptKey;
    const existing = this._getFresh(
      turnKey ? this.queryFailureByTurn : this.queryFailureByPrompt,
      recordKey,
      this.resultMaxAgeMs
    );
    const fingerprint = this._fingerprintQueryFailure(result, resolvedQuery);
    const attemptCount = Number(existing?.attemptCount || 0) + 1;
    const duplicate = Boolean(existing?.fingerprint && existing.fingerprint === fingerprint);
    const mayRepair = !duplicate && attemptCount <= this.queryRepairBudget;
    const record = {
      recordType: 'query_validation_failure',
      promptKey,
      conversationKey: String(scope).trim(),
      turnId: normalizedTurnId || null,
      updatedAt: this.now(),
      result,
      resolvedQuery: resolvedQuery && typeof resolvedQuery === 'object' ? resolvedQuery : null,
      fingerprint,
      attemptCount,
      duplicate,
      mayRepair,
      terminal: !mayRepair
    };

    this._prune();
    this.queryFailureByPrompt.set(promptKey, record);
    if (turnKey) {
      this.queryFailureByTurn.set(turnKey, record);
    }
    this._trim(this.queryFailureByPrompt);
    this._trim(this.queryFailureByTurn);
    return record;
  }

  getQueryFailureForTurn(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key) {
      return null;
    }
    return this._getFresh(this.queryFailureByTurn, key, this.resultMaxAgeMs);
  }

  clearQueryFailureForTurn(scope, turnId) {
    return this._clearTurnRecord(
      this.queryFailureByTurn,
      this.queryFailureByPrompt,
      scope,
      turnId
    );
  }

  rememberSkillExecutionFailure({ scope, turnId = '', promptKey, result, resolvedQuery = null }) {
    if (!this._isUsableScope(scope) || !promptKey || !this._isExplicitFailure(result)) {
      return null;
    }

    const normalizedTurnId = this._normalizeTurnId(turnId);
    const turnKey = this._buildTurnKey(scope, normalizedTurnId);
    const record = {
      recordType: 'skill_execution_failure',
      promptKey,
      conversationKey: String(scope).trim(),
      turnId: normalizedTurnId || null,
      updatedAt: this.now(),
      result,
      resolvedQuery: resolvedQuery && typeof resolvedQuery === 'object' ? resolvedQuery : null
    };

    this._prune();
    this.skillExecutionFailureByPrompt.set(promptKey, record);
    if (turnKey) {
      this.skillExecutionFailureByTurn.set(turnKey, record);
    }
    this._trim(this.skillExecutionFailureByPrompt);
    this._trim(this.skillExecutionFailureByTurn);
    return record;
  }

  getSkillExecutionFailureForTurn(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key) {
      return null;
    }
    return this._getFresh(this.skillExecutionFailureByTurn, key, this.resultMaxAgeMs);
  }

  clearSkillExecutionFailureForTurn(scope, turnId) {
    return this._clearTurnRecord(
      this.skillExecutionFailureByTurn,
      this.skillExecutionFailureByPrompt,
      scope,
      turnId
    );
  }

  getSkillResult(promptKey) {
    return this._getFresh(this.skillByPrompt, promptKey, this.resultMaxAgeMs);
  }

  getSkillResultForTurn(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key) {
      return null;
    }
    return this._getFresh(this.skillByTurn, key, this.resultMaxAgeMs);
  }

  getLatestSkillResult(scope) {
    if (!this._isUsableScope(scope)) {
      return null;
    }
    return this._getFresh(this.latestSkillByScope, scope, this.resultMaxAgeMs);
  }

  rememberDebugApi({ scope, turnId = '', promptKey, requestUrl }) {
    const normalizedUrl = String(requestUrl || '').trim();
    if (!this._isUsableScope(scope) || !promptKey || !normalizedUrl) {
      return null;
    }

    const record = {
      conversationKey: scope,
      turnId: this._normalizeTurnId(turnId) || null,
      promptKey,
      requestUrl: normalizedUrl,
      updatedAt: this.now()
    };
    this._prune();
    this.debugByPrompt.set(promptKey, record);
    this.latestDebugByScope.set(scope, record);
    this._trim(this.debugByPrompt);
    this._trim(this.latestDebugByScope);
    return record;
  }

  getDebugApi(promptKey) {
    return this._getFresh(this.debugByPrompt, promptKey, this.resultMaxAgeMs);
  }

  getLatestDebugApi(scope) {
    if (!this._isUsableScope(scope)) {
      return null;
    }
    return this._getFresh(this.latestDebugByScope, scope, this.resultMaxAgeMs);
  }

  rememberReportExport({ scope, turnId = '', prompt, result, filePath = '', downloadUrl = '', reportId = '' }) {
    if (!this._isUsableScope(scope) || !result || typeof result !== 'object' || !result.ok) {
      return null;
    }

    const record = {
      prompt: String(prompt || '').trim() || null,
      conversationKey: scope,
      turnId: this._normalizeTurnId(turnId) || null,
      updatedAt: this.now(),
      result,
      filePath: String(filePath || '').trim(),
      downloadUrl: String(downloadUrl || '').trim(),
      reportId: String(reportId || '').trim()
    };
    this._prune();
    this.reportByScope.set(scope, record);
    this._trim(this.reportByScope);
    return record;
  }

  getReportExport(scope, turnId = '') {
    if (!this._isUsableScope(scope)) {
      return null;
    }
    const record = this._getFresh(this.reportByScope, scope, this.reportMaxAgeMs);
    const normalizedTurnId = this._normalizeTurnId(turnId);
    if (!record || !normalizedTurnId || !record.turnId) {
      return record;
    }
    return record.turnId === normalizedTurnId ? record : null;
  }

  claimFallbackDelivery(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key) {
      return true;
    }
    const existing = this._getFresh(this.fallbackDeliveryByTurn, key, this.resultMaxAgeMs);
    if (existing) {
      return false;
    }
    this.fallbackDeliveryByTurn.set(key, { updatedAt: this.now() });
    this._trim(this.fallbackDeliveryByTurn);
    return true;
  }

  claimFinalDelivery(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key) {
      return true;
    }
    const existing = this._getFresh(this.finalDeliveryByTurn, key, this.resultMaxAgeMs);
    if (existing) {
      return false;
    }
    this.finalDeliveryByTurn.set(key, { conversationKey: scope, updatedAt: this.now() });
    this._trim(this.finalDeliveryByTurn);
    return true;
  }

  prepareFinalContent({ scope, turnId, content, source = '', workflowState = '' }) {
    const key = this._buildTurnKey(scope, turnId);
    const normalizedContent = String(content || '').trim();
    if (!key || !normalizedContent) {
      return null;
    }

    this._prune();
    const claimed = this._getFresh(this.finalDeliveryByTurn, key, this.resultMaxAgeMs);
    const existing = this._getFresh(this.preparedFinalByTurn, key, this.resultMaxAgeMs);
    if (claimed) {
      return existing;
    }

    const fingerprint = crypto.createHash('sha256').update(normalizedContent, 'utf8').digest('hex');
    if (existing?.fingerprint === fingerprint) {
      return existing;
    }

    const record = {
      conversationKey: String(scope).trim(),
      turnId: this._normalizeTurnId(turnId),
      content: normalizedContent,
      fingerprint,
      source: String(source || '').trim() || 'unknown',
      workflowState: String(workflowState || '').trim() || null,
      state: 'FINAL_CONTENT_READY',
      updatedAt: this.now()
    };
    this.preparedFinalByTurn.set(key, record);
    this._trim(this.preparedFinalByTurn);
    return record;
  }

  getPreparedFinalContent(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key) {
      return null;
    }
    return this._getFresh(this.preparedFinalByTurn, key, this.resultMaxAgeMs);
  }

  claimPreparedFinalDelivery(scope, turnId) {
    const key = this._buildTurnKey(scope, turnId);
    if (!key || !this._getFresh(this.preparedFinalByTurn, key, this.resultMaxAgeMs)) {
      return false;
    }
    if (this._getFresh(this.finalDeliveryByTurn, key, this.resultMaxAgeMs)) {
      return false;
    }
    this.finalDeliveryByTurn.set(key, {
      conversationKey: String(scope).trim(),
      turnId: this._normalizeTurnId(turnId),
      state: 'FINAL_DELIVERY_CLAIMED',
      updatedAt: this.now()
    });
    this._trim(this.finalDeliveryByTurn);
    return true;
  }

  clearScope(scope) {
    const normalizedScope = String(scope || '').trim();
    if (!normalizedScope) {
      return 0;
    }

    const turnKeyPrefix = `${normalizedScope}::`;
    let cleared = 0;
    for (const map of [
      this.skillByPrompt,
      this.skillByTurn,
      this.latestSkillByScope,
      this.queryFailureByPrompt,
      this.queryFailureByTurn,
      this.skillExecutionFailureByPrompt,
      this.skillExecutionFailureByTurn,
      this.debugByPrompt,
      this.latestDebugByScope,
      this.reportByScope,
      this.fallbackDeliveryByTurn,
      this.finalDeliveryByTurn,
      this.preparedFinalByTurn
    ]) {
      for (const [key, record] of map.entries()) {
        const belongsToScope = String(record?.conversationKey || '').trim() === normalizedScope
          || key === normalizedScope
          || String(key).startsWith(turnKeyPrefix);
        if (belongsToScope && map.delete(key)) {
          cleared += 1;
        }
      }
    }
    return cleared;
  }

  evictExpired() {
    this._prune();
  }

  _getFresh(map, key, maxAgeMs) {
    const record = map.get(key) || null;
    if (!this._isFresh(record, maxAgeMs)) {
      if (record) {
        map.delete(key);
      }
      return null;
    }
    return record;
  }

  _prune() {
    this._pruneMap(this.skillByPrompt, this.resultMaxAgeMs);
    this._pruneMap(this.skillByTurn, this.resultMaxAgeMs);
    this._pruneMap(this.latestSkillByScope, this.resultMaxAgeMs);
    this._pruneMap(this.queryFailureByPrompt, this.resultMaxAgeMs);
    this._pruneMap(this.queryFailureByTurn, this.resultMaxAgeMs);
    this._pruneMap(this.skillExecutionFailureByPrompt, this.resultMaxAgeMs);
    this._pruneMap(this.skillExecutionFailureByTurn, this.resultMaxAgeMs);
    this._pruneMap(this.debugByPrompt, this.resultMaxAgeMs);
    this._pruneMap(this.latestDebugByScope, this.resultMaxAgeMs);
    this._pruneMap(this.reportByScope, this.reportMaxAgeMs);
    this._pruneMap(this.fallbackDeliveryByTurn, this.resultMaxAgeMs);
    this._pruneMap(this.finalDeliveryByTurn, this.resultMaxAgeMs);
    this._pruneMap(this.preparedFinalByTurn, this.resultMaxAgeMs);
  }

  _pruneMap(map, maxAgeMs) {
    for (const [key, record] of map.entries()) {
      if (!this._isFresh(record, maxAgeMs)) {
        map.delete(key);
      }
    }
  }

  _trim(map) {
    while (map.size > this.maxEntries) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  _isFresh(record, maxAgeMs) {
    return Boolean(
      record
      && Number(record.updatedAt) > 0
      && (this.now() - Number(record.updatedAt)) <= maxAgeMs
    );
  }

  _isUsableScope(scope) {
    return Boolean(String(scope || '').trim());
  }

  _isExplicitSuccess(result) {
    return Boolean(result && typeof result === 'object' && result.ok === true && !result.error);
  }

  _isExplicitFailure(result) {
    return Boolean(result && typeof result === 'object' && (result.ok === false || result.error));
  }

  _fingerprintQueryFailure(result, resolvedQuery) {
    const payload = {
      code: result?.error?.code || result?.code || null,
      reason: result?.error?.reason || result?.reason || null,
      message: result?.error?.message || result?.message || null,
      resolvedQuery: resolvedQuery && typeof resolvedQuery === 'object' ? resolvedQuery : null
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  _clearTurnRecord(turnMap, promptMap, scope, turnId) {
    const turnKey = this._buildTurnKey(scope, turnId);
    if (!turnKey) {
      return 0;
    }

    const record = this._getFresh(turnMap, turnKey, this.resultMaxAgeMs);
    if (!record) {
      return 0;
    }
    turnMap.delete(turnKey);
    if (record.promptKey && promptMap.get(record.promptKey) === record) {
      promptMap.delete(record.promptKey);
    }
    return 1;
  }

  _normalizeTurnId(turnId) {
    return String(turnId || '').trim();
  }

  _buildTurnKey(scope, turnId) {
    const normalizedScope = String(scope || '').trim();
    const normalizedTurnId = this._normalizeTurnId(turnId);
    return normalizedScope && normalizedTurnId
      ? `${normalizedScope}::${normalizedTurnId}`
      : '';
  }
}

module.exports = ConversationOperationState;
