'use strict';

const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');

class AlertReceiverSettingsStore {
  constructor({ dataDir, defaultEnabled = true }) {
    this.filePath = join(dataDir, 'receiver-settings.json');
    this.settings = { enabled: Boolean(defaultEnabled) };
    mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (!existsSync(this.filePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof stored?.enabled === 'boolean') this.settings.enabled = stored.enabled;
    } catch (_error) {
      // Keep the deployment default if a prior settings file is unavailable or malformed.
    }
  }

  get() {
    return { ...this.settings };
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const next = { enabled };
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
      this.settings = next;
      return this.get();
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

module.exports = AlertReceiverSettingsStore;
