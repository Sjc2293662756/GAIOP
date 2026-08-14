'use strict';

const crypto = require('node:crypto');

const OUTPUT_PHASES = new Set(['progress', 'partial', 'terminal', 'terminal_error']);

class AssistantOutputLedger {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : 90 * 1000;
    this.maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 2000;
    this.sequence = 0;
    this.records = new Map();
  }

  recordOutput({
    scope,
    turnId,
    text,
    phase,
    stopReason = '',
    hasToolCall = false,
    assistantMessageIndex = null,
    providerPhase = '',
    attemptId = ''
  } = {}) {
    const conversationKey = String(scope || '').trim();
    const normalizedTurnId = String(turnId || '').trim();
    const normalizedText = this._normalizeText(text);
    const normalizedPhase = String(phase || '').trim().toLowerCase();
    if (
      !conversationKey
      || !normalizedTurnId
      || !normalizedText
      || !OUTPUT_PHASES.has(normalizedPhase)
    ) {
      return null;
    }

    this._prune();
    const sequence = ++this.sequence;
    const record = {
      outputId: `assistant-output-${sequence}`,
      conversationKey,
      turnId: normalizedTurnId,
      sequence,
      phase: normalizedPhase,
      stopReason: String(stopReason || '').trim() || null,
      hasToolCall: Boolean(hasToolCall),
      assistantMessageIndex: Number.isInteger(assistantMessageIndex) ? assistantMessageIndex : null,
      providerPhase: String(providerPhase || '').trim() || null,
      attemptId: String(attemptId || '').trim() || null,
      fingerprint: this._fingerprint(normalizedText),
      textLength: normalizedText.length,
      state: 'PENDING_DELIVERY',
      recordedAt: this.now(),
      updatedAt: this.now(),
      consumedAt: null
    };
    this.records.set(record.outputId, record);
    this._trim();
    return record;
  }

  recordToolProgress(args = {}) {
    return this.recordOutput({
      ...args,
      phase: 'progress',
      hasToolCall: true
    });
  }

  consumeProgressDelivery({ scope, turnId, text } = {}) {
    const conversationKey = String(scope || '').trim();
    const normalizedTurnId = String(turnId || '').trim();
    const normalizedText = this._normalizeText(text);
    if (!conversationKey || !normalizedTurnId || !normalizedText) {
      return null;
    }

    this._prune();
    const fingerprint = this._fingerprint(normalizedText);
    for (const record of this.records.values()) {
      if (
        record.conversationKey !== conversationKey
        || record.turnId !== normalizedTurnId
        || record.phase !== 'progress'
        || record.state !== 'PENDING_DELIVERY'
        || record.textLength !== normalizedText.length
        || record.fingerprint !== fingerprint
      ) {
        continue;
      }

      record.state = 'PROGRESS_DELIVERY_SUPPRESSED';
      record.consumedAt = this.now();
      record.updatedAt = record.consumedAt;
      return record;
    }
    return null;
  }

  clearScope(scope) {
    const conversationKey = String(scope || '').trim();
    if (!conversationKey) {
      return 0;
    }

    let cleared = 0;
    for (const [outputId, record] of this.records.entries()) {
      if (record.conversationKey === conversationKey && this.records.delete(outputId)) {
        cleared += 1;
      }
    }
    return cleared;
  }

  evictExpired() {
    this._prune();
  }

  getRecords(scope = '', turnId = '') {
    const conversationKey = String(scope || '').trim();
    const normalizedTurnId = String(turnId || '').trim();
    this._prune();
    return Array.from(this.records.values()).filter((record) => (
      (!conversationKey || record.conversationKey === conversationKey)
      && (!normalizedTurnId || record.turnId === normalizedTurnId)
    ));
  }

  _normalizeText(text) {
    return String(text || '').trim();
  }

  _fingerprint(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  }

  _prune() {
    const now = this.now();
    for (const [outputId, record] of this.records.entries()) {
      if ((now - Number(record.updatedAt || 0)) > this.maxAgeMs) {
        this.records.delete(outputId);
      }
    }
  }

  _trim() {
    while (this.records.size > this.maxEntries) {
      const oldestOutputId = this.records.keys().next().value;
      this.records.delete(oldestOutputId);
    }
  }
}

module.exports = AssistantOutputLedger;
module.exports.OUTPUT_PHASES = OUTPUT_PHASES;
