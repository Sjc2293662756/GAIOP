'use strict';

const { createHash } = require('crypto');
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('fs');
const { dirname, join } = require('path');

class AlertEventStoreService {
  constructor({ dataDir, maxEntries = 100000, retentionDays = 31 }) {
    this.filePath = join(dataDir, 'alerts.jsonl');
    this.maxEntries = maxEntries;
    this.retentionMs = Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    this.events = [];
    mkdirSync(dirname(this.filePath), { recursive: true });
    this._load();
  }

  _eventTime(event) {
    const numeric = Number(event?.occurredAt || event?.receivedAt);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(event?.occurredAt || event?.receivedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  _prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    this.events = this.events
      .filter((event) => this._eventTime(event) >= cutoff)
      .slice(0, this.maxEntries);
  }

  _load() {
    if (!existsSync(this.filePath)) return;
    const rows = readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const row of rows.slice(-this.maxEntries)) {
      try { this.events.push(JSON.parse(row)); } catch (_err) { /* ignore one corrupt historical row */ }
    }
    this.events.sort((left, right) => right.receivedAt - left.receivedAt);
    this._prune();
  }

  save(event) {
    const id = createHash('sha256')
      .update([event.category, event.eventId || event.ruleId || '', event.occurredAt, event.name].join('|'))
      .digest('hex')
      .slice(0, 32);
    const stored = { ...event, id };
    if (this.events.some((item) => item.id === id)) return { stored: false, event: stored };

    appendFileSync(this.filePath, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o640 });
    this.events.unshift(stored);
    this._prune();
    return { stored: true, event: stored };
  }

  list({ page = 1, pageSize = 10, severity, category, keyword, startAt, endAt } = {}) {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    const start = Number(startAt);
    const end = Number(endAt);
    const hasStart = startAt !== null && startAt !== undefined && startAt !== '' && Number.isFinite(start);
    const hasEnd = endAt !== null && endAt !== undefined && endAt !== '' && Number.isFinite(end);
    const filtered = this.events.filter((event) => {
      const occurredAt = this._eventTime(event);
      if (hasStart && occurredAt < start) return false;
      if (hasEnd && occurredAt > end) return false;
      if (severity && event.severity !== severity) return false;
      if (category && event.category !== category) return false;
      if (!normalizedKeyword) return true;
      return [event.name, event.sourceIp, event.eventId].some((value) => String(value || '').toLowerCase().includes(normalizedKeyword));
    });
    const offset = Math.max(0, (page - 1) * pageSize);
    return { alerts: filtered.slice(offset, offset + pageSize), availableCount: filtered.length, hasMore: offset + pageSize < filtered.length };
  }
}

module.exports = AlertEventStoreService;
