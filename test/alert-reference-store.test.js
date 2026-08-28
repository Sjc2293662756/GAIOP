'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AlertReferenceStore = require('../plugin/AlertReferenceStore');

describe('AlertReferenceStore', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-alert-reference-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('persists a reference across store instances and expires it by TTL', () => {
    let now = 1000;
    const record = {
      referenceId: 'GJ-ABC234',
      alert: { eventId: '795097', name: '告警推送应用测试1' },
      triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2311.6599, unit: '毫秒' }],
      createdAt: now,
      expiresAt: now + 100,
    };
    const first = new AlertReferenceStore({ baseDir, now: () => now, ttlMs: 100 });
    expect(first.put(record)).toMatchObject({ ok: true, referenceId: 'GJ-ABC234' });

    const second = new AlertReferenceStore({ baseDir, now: () => now, ttlMs: 100 });
    expect(second.get('GJ-ABC234')).toMatchObject({ ok: true, alert: { eventId: '795097' } });

    now = 1101;
    expect(second.get('GJ-ABC234')).toMatchObject({ ok: false, errorCode: 'ALERT_REFERENCE_EXPIRED' });
  });

  test('finds the latest fresh reference for an event', () => {
    let now = 1000;
    const store = new AlertReferenceStore({ baseDir, now: () => now, ttlMs: 1000 });
    store.put({ referenceId: 'GJ-ABC234', alert: { eventId: '1' }, createdAt: 1, expiresAt: 2000 });
    now = 1100;
    store.put({ referenceId: 'GJ-DEF567', alert: { eventId: '1' }, createdAt: 2, expiresAt: 2100 });
    expect(store.findByEventId('1')).toMatchObject({ ok: true, referenceId: 'GJ-DEF567' });
  });

  test('redacts sensitive fields before writing a record', () => {
    const store = new AlertReferenceStore({ baseDir, now: () => 1000 });
    store.put({
      referenceId: 'GJ-ABC234',
      alert: { eventId: '1' },
      packet: { url: 'https://user:secret@example.test?a=1&Password=secret' },
      credentials: 'secret',
    });
    const raw = fs.readFileSync(path.join(baseDir, 'GJ-ABC234.json'), 'utf8');
    expect(raw).toContain('Password=***');
    expect(raw).toContain('https://***:***@example.test');
    expect(raw).not.toContain('secret');
  });

  test('preserves shared candidate IP arrays when cloning a reference', () => {
    const store = new AlertReferenceStore({ baseDir, now: () => 1000 });
    const ips = ['101.254.114.235', '39.34.186.250'];
    store.put({
      referenceId: 'GJ-SHARED2',
      alert: { eventId: '802358' },
      packet: {
        candidates: [{
          candidateId: 'GJ-SHARED2-P1',
          ips,
          packetQuery: { criteria: { ips } }
        }]
      }
    });

    expect(store.get('GJ-SHARED2').packet.candidates[0].packetQuery.criteria.ips)
      .toEqual(ips);
  });
});
