'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;
const REFERENCE_ID_PATTERN = /^GJ-[A-Z2-9]{6,16}$/;
const SENSITIVE_KEY_PATTERN = /(password|passwd|token|secret|authorization|api[-_]?key|access[-_]?key|private[-_]?key|credential|cookie)/i;
const SENSITIVE_URL_PARAM_PATTERN = /([?&](?:password|passwd|token|secret|authorization|api[_-]?key|cookie)=)[^&#\s]*/gi;
const SENSITIVE_URL_USERINFO_PATTERN = /(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

function cloneSafe(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value
      .replace(SENSITIVE_URL_USERINFO_PATTERN, '$1***:***@')
      .replace(SENSITIVE_URL_PARAM_PATTERN, '$1***');
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneSafe(item, seen));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '***' : cloneSafe(item, seen);
  }
  return output;
}

function hashEventId(eventId) {
  return crypto.createHash('sha256').update(normalize(eventId)).digest('hex');
}

function mergeObjects(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    output[key] = isPlainObject(output[key]) && isPlainObject(value)
      ? mergeObjects(output[key], value)
      : value;
  }
  return output;
}

function isValidReferenceId(referenceId) {
  return REFERENCE_ID_PATTERN.test(normalize(referenceId));
}

function createReferenceId(randomBytes = crypto.randomBytes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `GJ-${suffix}`;
}

class AlertReferenceStore {
  constructor(options = {}) {
    this.baseDir = path.resolve(String(
      options.baseDir
      || process.env.NAPM_ALERT_REFERENCE_DIR
      || path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.openclaw', 'state', 'napm-alert-references')
    ));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    this.maxEntries = Number(options.maxEntries) > 0
      ? Number(options.maxEntries)
      : (Number(process.env.NAPM_ALERT_REFERENCE_MAX_ENTRIES) > 0
        ? Number(process.env.NAPM_ALERT_REFERENCE_MAX_ENTRIES)
        : DEFAULT_MAX_ENTRIES);
    this._ensureDirectory();
  }

  put(record = {}) {
    const referenceId = normalize(record.referenceId);
    const eventId = normalize(record?.alert?.eventId || record.eventId);
    if (!isValidReferenceId(referenceId)) {
      return this._error('ALERT_REFERENCE_ID_INVALID', '告警引用编号无效。');
    }
    if (!eventId) {
      return this._error('ALERT_REFERENCE_EVENT_ID_MISSING', '告警引用缺少事件 ID。');
    }

    const now = this.now();
    const source = cloneSafe(record);
    const normalized = {
      schemaVersion: Number(source.schemaVersion) || 1,
      ...source,
      referenceId,
      createdAt: Number(source.createdAt) > 0 ? Number(source.createdAt) : now,
      updatedAt: now,
      expiresAt: Number(source.expiresAt) > now ? Number(source.expiresAt) : now + this.ttlMs,
    };
    this._prune();
    this._writeAtomic(normalized);
    this._trim();
    return { ok: true, ...normalized };
  }

  get(referenceId) {
    const id = normalize(referenceId);
    if (!isValidReferenceId(id)) return this._error('ALERT_REFERENCE_NOT_FOUND', '未找到指定的告警引用。');
    const record = this._read(id);
    if (!record) return this._error('ALERT_REFERENCE_NOT_FOUND', '未找到指定的告警引用。');
    if (!this._isFresh(record)) {
      this._delete(id);
      return this._error('ALERT_REFERENCE_EXPIRED', '指定的告警引用已过期。');
    }
    return { ok: true, ...record };
  }

  findByEventId(eventId) {
    const target = normalize(eventId);
    if (!target) return null;
    this._prune();
    const record = this._list()
      .filter((item) => normalize(item?.alert?.eventId || item.eventId) === target)
      .filter((item) => this._isFresh(item))
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))[0];
    return record ? { ok: true, ...record } : null;
  }

  update(referenceId, patch = {}) {
    const current = this.get(referenceId);
    if (!current.ok) return current;
    const next = {
      ...mergeObjects(current, cloneSafe(patch)),
      referenceId: current.referenceId,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      expiresAt: Number(patch.expiresAt) > this.now() ? Number(patch.expiresAt) : current.expiresAt,
    };
    return this.put(next);
  }

  claim(referenceId, lease = {}) {
    const current = this.get(referenceId);
    if (!current.ok) return current;
    const now = this.now();
    const existing = isPlainObject(current.analysisLease) ? current.analysisLease : null;
    if (existing && Number(existing.expiresAt) > now && normalize(existing.owner) !== normalize(lease.owner)) {
      return this._error('ALERT_REFERENCE_BUSY', '该告警正在分析中，请稍后重试。');
    }
    return this.update(referenceId, {
      status: lease.status || 'ANALYZING',
      analysisLease: {
        owner: normalize(lease.owner) || `worker-${process.pid}`,
        expiresAt: now + (Number(lease.leaseMs) > 0 ? Number(lease.leaseMs) : 120000),
      },
    });
  }

  pruneExpired() {
    this._prune();
  }

  clearAll() {
    let count = 0;
    for (const record of this._list()) {
      if (this._delete(record.referenceId)) count += 1;
    }
    return count;
  }

  _ensureDirectory() {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.baseDir, 0o700); } catch (_error) { /* Windows */ }
  }

  _filePath(referenceId) {
    return path.join(this.baseDir, `${referenceId}.json`);
  }

  _writeAtomic(record) {
    const target = this._filePath(record.referenceId);
    const temporary = path.join(this.baseDir, `.${record.referenceId}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch (_error) { /* Windows */ }
    fs.renameSync(temporary, target);
  }

  _read(referenceId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._filePath(referenceId), 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') this._delete(referenceId);
      return null;
    }
  }

  _list() {
    let names = [];
    try {
      names = fs.readdirSync(this.baseDir).filter((name) => REFERENCE_ID_PATTERN.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
    } catch (_error) {
      return [];
    }
    return names.map((name) => this._read(name.slice(0, -5))).filter(Boolean);
  }

  _delete(referenceId) {
    try {
      fs.unlinkSync(this._filePath(referenceId));
      return true;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
      return false;
    }
  }

  _prune() {
    for (const record of this._list()) {
      if (!this._isFresh(record)) this._delete(record.referenceId);
    }
  }

  _trim() {
    const records = this._list().sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    while (records.length > this.maxEntries) this._delete(records.shift().referenceId);
  }

  _isFresh(record) {
    return Boolean(record && Number(record.expiresAt) > Number(this.now()));
  }

  _error(errorCode, message) {
    return { ok: false, errorCode, message };
  }
}

AlertReferenceStore.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
AlertReferenceStore.REFERENCE_ID_PATTERN = REFERENCE_ID_PATTERN;
AlertReferenceStore.createReferenceId = createReferenceId;
AlertReferenceStore.hashEventId = hashEventId;

module.exports = AlertReferenceStore;
