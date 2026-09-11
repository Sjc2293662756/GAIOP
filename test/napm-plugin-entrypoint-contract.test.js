'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createFixture(repoRoot, prefix, divergentRemote = false) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const extensionRoot = path.join(fixtureRoot, 'extension');
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'napm-openclaw-plugin.remote.js'), path.join(extensionRoot, 'index.js'));
  if (divergentRemote) {
    fs.writeFileSync(path.join(extensionRoot, 'napm-openclaw-plugin.remote.js'), '// divergent entry\n');
  } else {
    fs.copyFileSync(path.join(repoRoot, 'napm-openclaw-plugin.remote.js'), path.join(extensionRoot, 'napm-openclaw-plugin.remote.js'));
  }
  fs.copyFileSync(path.join(repoRoot, 'napm-openclaw-plugin.index.mjs'), path.join(extensionRoot, 'index.mjs'));
  fs.cpSync(path.join(repoRoot, 'plugin'), path.join(extensionRoot, 'plugin'), { recursive: true });
  return { fixtureRoot, extensionRoot };
}

function runVerifier(repoRoot, extensionRoot) {
  return spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'verify-openclaw-extension-runtime.js'),
    '--extensionRoot', extensionRoot,
    '--skillsRoot', path.join(repoRoot, 'skills')
  ], { encoding: 'utf8' });
}

describe('NAPM plugin entrypoint contract', () => {
  test('index.mjs loads the identical index.js compatibility source through the runtime verifier', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const { fixtureRoot, extensionRoot } = createFixture(repoRoot, 'napm-entrypoint-contract-');
    try {
      expect(sha256(path.join(extensionRoot, 'index.js')))
        .toBe(sha256(path.join(extensionRoot, 'napm-openclaw-plugin.remote.js')));
      const result = runVerifier(repoRoot, extensionRoot);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"ok": true');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('index.mjs refuses divergent compatibility entrypoints before plugin startup', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const { fixtureRoot, extensionRoot } = createFixture(repoRoot, 'napm-entrypoint-mismatch-', true);
    try {
      const result = runVerifier(repoRoot, extensionRoot);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('entrypoint mismatch');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
