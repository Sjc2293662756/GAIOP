'use strict';

const {
  compareReleaseVersions,
  evaluateReleaseInstallPolicy,
  verifyActiveManifests
} = require('../scripts/release-manifest-policy');

describe('release manifest install policy', () => {
  test('orders release candidates numerically', () => {
    expect(compareReleaseVersions('1.1.0-rc.34', '1.1.0-rc.35')).toBe(-1);
    expect(compareReleaseVersions('1.1.0-rc.35', '1.1.0-rc.34')).toBe(1);
    expect(compareReleaseVersions('1.1.0-rc.35', '1.1.0-rc.35')).toBe(0);
    expect(compareReleaseVersions('1.1.0', '1.1.0-rc.35')).toBe(1);
  });

  test('allows a newer version', () => {
    expect(evaluateReleaseInstallPolicy(
      { version: '1.1.0-rc.36', commit: 'a'.repeat(40) },
      { version: '1.1.0-rc.35', commit: 'b'.repeat(40) }
    )).toMatchObject({ allowed: true, reason: 'newer_version' });
  });

  test('rejects a downgrade unless explicitly allowed', () => {
    expect(evaluateReleaseInstallPolicy(
      { version: '1.1.0-rc.34', commit: 'a'.repeat(40) },
      { version: '1.1.0-rc.35', commit: 'b'.repeat(40) }
    )).toMatchObject({ allowed: false, reason: 'version_downgrade' });
    expect(evaluateReleaseInstallPolicy(
      { version: '1.1.0-rc.34', commit: 'a'.repeat(40) },
      { version: '1.1.0-rc.35', commit: 'b'.repeat(40) },
      { allowDowngrade: true }
    )).toMatchObject({ allowed: true, reason: 'explicit_downgrade' });
  });

  test('rejects reuse of a version with a different commit', () => {
    expect(evaluateReleaseInstallPolicy(
      { version: '1.1.0-rc.34', commit: 'a'.repeat(40) },
      { version: '1.1.0-rc.34', commit: 'b'.repeat(40) }
    )).toMatchObject({ allowed: false, reason: 'version_commit_mismatch' });
  });

  test('requires all active manifests to match the incoming release', () => {
    const incoming = { version: '1.1.0-rc.36', commit: 'a'.repeat(40) };
    expect(verifyActiveManifests(incoming, [
      { version: '1.1.0-rc.36', commit: 'a'.repeat(40) },
      { version: '1.1.0-rc.36', commit: 'a'.repeat(40) }
    ])).toMatchObject({ ok: true });
    expect(verifyActiveManifests(incoming, [
      { version: '1.1.0-rc.36', commit: 'a'.repeat(40) },
      { version: '1.1.0-rc.36', commit: 'b'.repeat(40) }
    ])).toMatchObject({ ok: false, reason: 'active_manifest_mismatch' });
  });
});
