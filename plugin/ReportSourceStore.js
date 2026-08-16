'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 20;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const REPORT_SOURCE_ID_PATTERN = /^rps_[a-f0-9-]{16,100}$/;
const SENSITIVE_KEY_PATTERN = /(password|passwd|token|secret|authorization|api[-_]?key|access[-_]?key|private[-_]?key|credential)/i;
const SENSITIVE_URL_PARAM_PATTERN = /([?&](?:password|passwd|token|secret|authorization|api[_-]?key)=)[^&#\s]*/gi;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeScope(scope) {
  return String(scope == null ? '' : scope).trim();
}

function hashScope(scope) {
  return crypto.createHash('sha256').update(scope).digest('hex');
}

function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value.replace(SENSITIVE_URL_PARAM_PATTERN, '$1***');
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '***' : redactSensitive(item, seen);
  }
  return output;
}

function cloneJson(value) {
  return redactSensitive(value);
}

class ReportSourceStore {
  constructor(options = {}) {
    this.baseDir = path.resolve(String(options.baseDir || path.join(process.cwd(), '.napm-report-sources')));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    this.maxEntriesPerScope = Number(options.maxEntriesPerScope) > 0
      ? Number(options.maxEntriesPerScope)
      : DEFAULT_MAX_ENTRIES_PER_SCOPE;
    this.maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => `rps_${crypto.randomUUID()}`;
    this._ensureDirectory();
  }

  put({ scope, sourceTool = '', reportType = '', promptKey = '', reportData } = {}) {
    const ownerScope = normalizeScope(scope);
    if (!ownerScope) {
      return this._error('REPORT_SCOPE_MISSING', '无法保存报告源：缺少可信会话范围。');
    }
    if (!isPlainObject(reportData)) {
      return this._error('REPORT_DATA_INVALID', '无法保存报告源：reportData 不是对象。');
    }

    const normalizedReportData = cloneJson(reportData);
    const record = {
      reportSourceId: String(this.idFactory()).trim(),
      ownerScopeHash: hashScope(ownerScope),
      sourceTool: String(sourceTool || '').trim() || 'napm-unknown',
      reportType: String(reportType || normalizedReportData.reportType || '').trim() || null,
      promptKey: String(promptKey || '').trim() || null,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      reportData: normalizedReportData
    };
    if (!REPORT_SOURCE_ID_PATTERN.test(record.reportSourceId)) {
      return this._error('REPORT_SOURCE_ID_INVALID', '无法保存报告源：源编号无效。');
    }

    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      return this._error('REPORT_SOURCE_TOO_LARGE', `报告源超过 ${this.maxBytes} 字节限制。`);
    }

    this._prune();
    this._writeAtomic(record);
    this._trimScope(record.ownerScopeHash);
    return { ok: true, ...record };
  }

  get({ reportSourceId, scope } = {}) {
    const id = String(reportSourceId || '').trim();
    const ownerScope = normalizeScope(scope);
    if (!ownerScope) {
      return this._error('REPORT_SCOPE_MISSING', '导出报告失败：缺少可信会话范围。');
    }
    if (!REPORT_SOURCE_ID_PATTERN.test(id)) {
      return this._error('REPORT_SOURCE_NOT_FOUND', '未找到指定的报告源。');
    }

    const record = this._read(id);
    if (!record) {
      return this._error('REPORT_SOURCE_NOT_FOUND', '未找到指定的报告源。');
    }
    if (record.ownerScopeHash !== hashScope(ownerScope)) {
      return this._error('REPORT_SOURCE_FORBIDDEN', '当前会话无权读取该报告源。');
    }
    if (!this._isFresh(record)) {
      this._delete(id);
      return this._error('REPORT_SOURCE_EXPIRED', '指定的报告源已过期，请重新生成报告。');
    }
    return { ok: true, ...record };
  }

  findForScope(scope) {
    const ownerScope = normalizeScope(scope);
    if (!ownerScope) {
      return this._error('REPORT_SCOPE_MISSING', '导出报告失败：缺少可信会话范围。');
    }
    this._prune();
    const ownerHash = hashScope(ownerScope);
    const records = this._list().filter((record) => (
      record.ownerScopeHash === ownerHash && this._isFresh(record)
    ));
    records.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (records.length === 0) {
      return this._error('REPORT_SOURCE_NOT_FOUND', '当前会话没有可导出的报告源。');
    }
    if (records.length > 1) {
      return {
        ...this._error('REPORT_SOURCE_AMBIGUOUS', '当前会话存在多个报告源，请明确提供 reportSourceId。'),
        candidates: records.slice(0, 20).map((record) => ({
          reportSourceId: record.reportSourceId,
          sourceTool: record.sourceTool,
          reportType: record.reportType,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt
        }))
      };
    }
    return { ok: true, ...records[0] };
  }

  clearScope(scope) {
    const ownerScope = normalizeScope(scope);
    if (!ownerScope) {
      return 0;
    }

    const ownerScopeHash = hashScope(ownerScope);
    let cleared = 0;
    for (const record of this._list()) {
      if (record.ownerScopeHash === ownerScopeHash) {
        this._delete(record.reportSourceId);
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

  _filePath(id) {
    return path.join(this.baseDir, `${id}.json`);
  }

  _tmpFilePath(id) {
    return path.join(this.baseDir, `.${id}.${process.pid}.${Date.now()}.tmp`);
  }

  _writeAtomic(record) {
    const target = this._filePath(record.reportSourceId);
    const temp = this._tmpFilePath(record.reportSourceId);
    fs.writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch (_error) {
      // Windows does not expose POSIX modes.
    }
    fs.renameSync(temp, target);
  }

  _read(id) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._filePath(id), 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this._delete(id);
      }
      return null;
    }
  }

  _list() {
    let names = [];
    try {
      names = fs.readdirSync(this.baseDir).filter((name) => name.startsWith('rps_') && name.endsWith('.json'));
    } catch (_error) {
      return [];
    }
    return names.map((name) => this._read(name.slice(0, -5))).filter(Boolean);
  }

  _delete(id) {
    try {
      fs.unlinkSync(this._filePath(id));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  _prune() {
    for (const record of this._list()) {
      if (!this._isFresh(record)) {
        this._delete(record.reportSourceId);
      }
    }
  }

  _trimScope(ownerScopeHash) {
    const records = this._list()
      .filter((record) => record.ownerScopeHash === ownerScopeHash)
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    while (records.length > this.maxEntriesPerScope) {
      const oldest = records.shift();
      this._delete(oldest.reportSourceId);
    }
  }

  _isFresh(record) {
    return Boolean(
      record
      && Number(record.createdAt) > 0
      && Number(record.expiresAt) > Number(this.now())
    );
  }

  _error(errorCode, message) {
    return { ok: false, errorCode, message };
  }
}

ReportSourceStore.hashScope = hashScope;
ReportSourceStore.redactSensitive = redactSensitive;

module.exports = ReportSourceStore;
