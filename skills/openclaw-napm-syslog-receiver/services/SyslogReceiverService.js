'use strict';

const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const SyslogParserService = require('../../openclaw-napm-syslog-watcher/services/SyslogParserService');
const SyslogAlertNormalizer = require('./SyslogAlertNormalizer');

class SyslogReceiverService {
  constructor({ syslogPath, eventStore, enabled = true }) {
    this.syslogPath = syslogPath;
    this.eventStore = eventStore;
    this.enabled = enabled;
    this.parser = new SyslogParserService();
    this.normalizer = new SyslogAlertNormalizer();
    this.tailProcess = null;
    this.running = false;
    this.lastReceivedAt = null;
    this.lastErrorCode = null;
    this.reconnectTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._startTail();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.tailProcess?.kill('SIGTERM');
    this.tailProcess = null;
  }

  setEnabled(enabled) { this.enabled = Boolean(enabled); }

  health() {
    return {
      state: this.running && !this.lastErrorCode ? 'healthy' : 'degraded',
      enabled: this.enabled,
      lastReceivedAt: this.lastReceivedAt,
      lastErrorCode: this.lastErrorCode,
    };
  }

  _startTail() {
    const child = spawn('tail', ['-F', '-n', '0', this.syslogPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.tailProcess = child;
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      const complete = buffer.subarray(0, lastNewline);
      buffer = buffer.subarray(lastNewline + 1);
      const utf8 = complete.toString('utf8');
      const text = utf8.includes('\uFFFD') ? iconv.decode(complete, 'gbk') : utf8;
      text.split('\n').forEach((line) => this._handleLine(line.trim()));
    });
    child.on('error', () => { this.lastErrorCode = 'SYSLOG_TAIL_START_FAILED'; });
    child.on('close', () => {
      if (!this.running) return;
      this.lastErrorCode = 'SYSLOG_TAIL_RECONNECTING';
      this.reconnectTimer = setTimeout(() => this._startTail(), 5000);
    });
  }

  _handleLine(line) {
    if (!line) return;
    const parsed = this.parser.parse(line);
    if (!parsed) return;
    this.lastReceivedAt = Date.now();
    this.lastErrorCode = null;
    if (!this.enabled) return;
    this.eventStore.save(this.normalizer.normalize(parsed, this.lastReceivedAt));
  }
}

module.exports = SyslogReceiverService;
