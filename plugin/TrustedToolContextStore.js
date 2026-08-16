'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

function hashTraceId(traceId) {
  return crypto.createHash('sha256').update(traceId).digest('hex');
}

class TrustedToolContextStore {
  constructor(options = {}) {
    this.baseDir = path.resolve(String(options.baseDir || path.join(process.cwd(), '.napm-trusted-contexts')));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    this.maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES;
    this._ensureDirectory();
  }

  put({ traceId, scope, turnId = '', toolName = '' } = {}) {
    const id = normalize(traceId);
    const ownerScope = normalize(scope);
    if (!id || id.length > 512 || !ownerScope) {
      return { ok: false, errorCode: 'TRUSTED_CONTEXT_INVALID' };
    }

    const createdAt = this.now();
    const record = {
      traceIdHash: hashTraceId(id),
      scope: ownerScope,
      turnId: normalize(turnId) || null,
      toolName: normalize(toolName) || null,
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    this._prune();
    this._writeAtomic(record);
    this._trim();
    return { ok: true, ...record };
  }

  get(traceId) {
    const id = normalize(traceId);
    if (!id || id.length > 512) {
      return { ok: false, errorCode: 'TRUSTED_CONTEXT_NOT_FOUND' };
    }

    const traceIdHash = hashTraceId(id);
    const record = this._read(traceIdHash);
    if (!record || record.traceIdHash !== traceIdHash) {
      return { ok: false, errorCode: 'TRUSTED_CONTEXT_NOT_FOUND' };
    }
    if (!this._isFresh(record)) {
      this._delete(traceIdHash);
      return { ok: false, errorCode: 'TRUSTED_CONTEXT_EXPIRED' };
    }
    return { ok: true, ...record };
  }

  clearScope(scope) {
    const ownerScope = normalize(scope);
    if (!ownerScope) {
      return 0;
    }

    let cleared = 0;
    for (const record of this._list()) {
      if (normalize(record.scope) === ownerScope) {
        this._delete(record.traceIdHash);
        cleared += 1;
      }
    }
    return cleared;
  }

  evictExpired() {
    this._prune();
  }

  _ensureDirectory() {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch (_error) {
      // Windows does not expose POSIX modes.
    }
  }

  _filePath(traceIdHash) {
    return path.join(this.baseDir, `${traceIdHash}.json`);
  }

  _writeAtomic(record) {
    const target = this._filePath(record.traceIdHash);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch (_error) {
      // Windows does not expose POSIX modes.
    }
    fs.renameSync(temp, target);
  }

  _read(traceIdHash) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._filePath(traceIdHash), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this._delete(traceIdHash);
      }
      return null;
    }
  }

  _list() {
    let names = [];
    try {
      names = fs.readdirSync(this.baseDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (_error) {
      return [];
    }
    return names
      .map((name) => this._read(name.slice(0, -5)))
      .filter(Boolean);
  }

  _delete(traceIdHash) {
    try {
      fs.unlinkSync(this._filePath(traceIdHash));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  _prune() {
    for (const record of this._list()) {
      if (!this._isFresh(record)) {
        this._delete(record.traceIdHash);
      }
    }
  }

  _trim() {
    const records = this._list().sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    while (records.length > this.maxEntries) {
      this._delete(records.shift().traceIdHash);
    }
  }

  _isFresh(record) {
    return Boolean(
      record
      && normalize(record.scope)
      && Number(record.createdAt) > 0
      && Number(record.expiresAt) > Number(this.now())
    );
  }
}

TrustedToolContextStore.hashTraceId = hashTraceId;

module.exports = TrustedToolContextStore;
