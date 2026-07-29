'use strict';

class ConversationOperationState {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.resultMaxAgeMs = Number(options.resultMaxAgeMs) || 90 * 1000;
    this.reportMaxAgeMs = Number(options.reportMaxAgeMs) || 5 * 60 * 1000;
    this.maxEntries = Number(options.maxEntries) || 2000;
    this.skillByPrompt = new Map();
    this.latestSkillByScope = new Map();
    this.debugByPrompt = new Map();
    this.latestDebugByScope = new Map();
    this.reportByScope = new Map();
  }

  rememberSkillResult({ scope, promptKey, result, requestUrl = '', resolvedQuery = null }) {
    if (!this._isUsableScope(scope) || !promptKey || !result || typeof result !== 'object') {
      return null;
    }

    const record = {
      promptKey,
      conversationKey: scope,
      updatedAt: this.now(),
      requestUrl: String(requestUrl || '').trim(),
      resolvedQuery: resolvedQuery && typeof resolvedQuery === 'object' ? resolvedQuery : null,
      result
    };
    this._prune();
    this.skillByPrompt.set(promptKey, record);
    this.latestSkillByScope.set(scope, record);
    this._trim(this.skillByPrompt);
    this._trim(this.latestSkillByScope);
    return record;
  }

  getSkillResult(promptKey) {
    return this._getFresh(this.skillByPrompt, promptKey, this.resultMaxAgeMs);
  }

  getLatestSkillResult(scope) {
    if (!this._isUsableScope(scope)) {
      return null;
    }
    return this._getFresh(this.latestSkillByScope, scope, this.resultMaxAgeMs);
  }

  rememberDebugApi({ scope, promptKey, requestUrl }) {
    const normalizedUrl = String(requestUrl || '').trim();
    if (!this._isUsableScope(scope) || !promptKey || !normalizedUrl) {
      return null;
    }

    const record = {
      conversationKey: scope,
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

  rememberReportExport({ scope, prompt, result, filePath = '', downloadUrl = '', reportId = '' }) {
    if (!this._isUsableScope(scope) || !result || typeof result !== 'object' || !result.ok) {
      return null;
    }

    const record = {
      prompt: String(prompt || '').trim() || null,
      conversationKey: scope,
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

  getReportExport(scope) {
    if (!this._isUsableScope(scope)) {
      return null;
    }
    return this._getFresh(this.reportByScope, scope, this.reportMaxAgeMs);
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
    this._pruneMap(this.latestSkillByScope, this.resultMaxAgeMs);
    this._pruneMap(this.debugByPrompt, this.resultMaxAgeMs);
    this._pruneMap(this.latestDebugByScope, this.resultMaxAgeMs);
    this._pruneMap(this.reportByScope, this.reportMaxAgeMs);
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
}

module.exports = ConversationOperationState;
