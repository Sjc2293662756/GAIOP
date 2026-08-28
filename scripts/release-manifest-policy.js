#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseReleaseVersion(version) {
  const value = String(version || '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid release version: ${value || '<empty>'}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

function compareReleaseVersions(leftVersion, rightVersion) {
  const left = parseReleaseVersion(leftVersion);
  const right = parseReleaseVersion(rightVersion);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const comparison = comparePrereleaseIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison > 0 ? 1 : -1;
  }
  return 0;
}

function normalizeManifest(manifest = {}, source = 'manifest') {
  const version = String(manifest?.version || '').trim();
  const commit = String(manifest?.commit || '').trim().toLowerCase();
  parseReleaseVersion(version);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid release commit in ${source}: ${commit || '<empty>'}`);
  }
  return { version, commit };
}

function readReleaseManifest(manifestPath) {
  const source = String(manifestPath || '').trim();
  if (!source) throw new Error('Manifest path is required.');
  const manifest = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  return normalizeManifest(manifest, source);
}

function sameManifest(left, right) {
  return Boolean(left && right)
    && String(left.version) === String(right.version)
    && String(left.commit).toLowerCase() === String(right.commit).toLowerCase();
}

function evaluateReleaseInstallPolicy(incomingManifest, activeManifest = null, options = {}) {
  const incoming = normalizeManifest(incomingManifest, 'incoming release');
  if (!activeManifest) {
    return { allowed: true, reason: 'no_active_manifest', incoming };
  }

  const active = normalizeManifest(activeManifest, 'active release');
  if (sameManifest(incoming, active)) {
    return { allowed: true, reason: 'same_commit', incoming, active };
  }
  if (incoming.version === active.version) {
    return { allowed: false, reason: 'version_commit_mismatch', incoming, active };
  }

  const comparison = compareReleaseVersions(incoming.version, active.version);
  if (comparison < 0) {
    return options.allowDowngrade
      ? { allowed: true, reason: 'explicit_downgrade', incoming, active }
      : { allowed: false, reason: 'version_downgrade', incoming, active };
  }
  if (comparison > 0) {
    return { allowed: true, reason: 'newer_version', incoming, active };
  }
  return { allowed: false, reason: 'version_not_newer', incoming, active };
}

function verifyActiveManifests(incomingManifest, activeManifests = []) {
  const incoming = normalizeManifest(incomingManifest, 'incoming release');
  const manifests = Array.isArray(activeManifests) ? activeManifests.filter(Boolean) : [];
  if (manifests.length === 0) {
    return { ok: false, reason: 'active_manifest_missing', incoming };
  }
  const mismatches = manifests
    .map((manifest, index) => ({ manifest: normalizeManifest(manifest, `active release ${index + 1}`), index }))
    .filter(({ manifest }) => !sameManifest(incoming, manifest));
  return mismatches.length === 0
    ? { ok: true, incoming, count: manifests.length }
    : { ok: false, reason: 'active_manifest_mismatch', incoming, mismatches };
}

function parseArgs(argv = []) {
  const args = { active: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = String(argv[index] || '').trim();
    if (key === '--active') {
      args.active.push(String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (key === '--allow-downgrade') {
      args.allowDowngrade = true;
      continue;
    }
    if (key.startsWith('--')) {
      args[key.slice(2)] = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }
  return args;
}

function printResult(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (exitCode) process.exitCode = exitCode;
}

function main(argv = process.argv.slice(2)) {
  const [command = 'check'] = argv;
  const args = parseArgs(argv.slice(1));
  try {
    const incoming = readReleaseManifest(args.incoming);
    const active = args.active
      .filter((manifestPath) => manifestPath && fs.existsSync(manifestPath))
      .map((manifestPath) => readReleaseManifest(manifestPath));

    if (command === 'verify-active') {
      const result = verifyActiveManifests(incoming, active);
      printResult(result, result.ok ? 0 : 1);
      return;
    }

    if (command !== 'check') {
      throw new Error(`Unknown command: ${command}`);
    }
    if (active.length > 1 && active.some((manifest) => !sameManifest(manifest, active[0]))) {
      printResult({ allowed: false, reason: 'active_manifest_mismatch', incoming, active }, 1);
      return;
    }
    const decision = evaluateReleaseInstallPolicy(incoming, active[0] || null, { allowDowngrade: args.allowDowngrade });
    printResult(decision, decision.allowed ? 0 : 1);
  } catch (error) {
    printResult({ allowed: false, ok: false, reason: 'manifest_policy_error', message: error.message }, 1);
  }
}

if (require.main === module) main();

module.exports = {
  compareReleaseVersions,
  evaluateReleaseInstallPolicy,
  normalizeManifest,
  parseReleaseVersion,
  readReleaseManifest,
  sameManifest,
  verifyActiveManifests
};
