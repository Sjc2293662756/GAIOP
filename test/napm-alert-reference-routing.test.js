'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AlertReferenceStore = require('../plugin/AlertReferenceStore');

describe('NAPM cross-session alert reference routing', () => {
  let baseDir;
  let plugin;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-alert-reference-plugin-'));
    process.env.NAPM_ALERT_REFERENCE_DIR = baseDir;
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(baseDir, 'trusted-contexts');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote');
  });

  afterEach(() => {
    delete process.env.NAPM_ALERT_REFERENCE_DIR;
    delete process.env.NAPM_TRUSTED_CONTEXT_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('recognizes a reference without an event id and restores trusted fields', () => {
    const store = new AlertReferenceStore({ baseDir });
    store.put({
      referenceId: 'GJ-ABC234',
      alert: { eventId: '795097', start: 1787647440 },
      packet: {
        window: { start: 1787647320, end: 1787647680 },
        candidates: [],
      },
      triggerMetrics: [{
        code: 'USER_EXPERIENCE_SERVER',
        label: '用户体验时间（服务器）',
        value: 2311.6599,
        unit: '毫秒',
        condition: '用户体验时间（服务器） > 2000',
        severity: '轻微',
      }],
      analysis: { profileId: 'server_user_experience_time', profileVersion: 1 },
    });

    expect(plugin.__test__.isAlertPacketAnalysisPrompt('分析告警 GJ-ABC234')).toBe(true);
    expect(plugin.__test__.isAlertPacketAnalysisPrompt('分析 GJ-ABC234')).toBe(true);
    expect(plugin.__test__.extractAlertReference('分析告警 GJ-ABC234')).toEqual({
      referenceId: 'GJ-ABC234',
      candidateId: null,
    });
    expect(plugin.__test__.buildCanonicalAlertPacketToolParams('分析告警 GJ-ABC234', {})).toMatchObject({
      eventId: '795097',
      start: 1787647320,
      end: 1787647680,
      referenceId: 'GJ-ABC234',
      triggerMetrics: {
        names: ['用户体验时间（服务器）'],
        values: [2311.6599],
        profileId: 'server_user_experience_time',
      },
    });
  });

  test('restores only the selected packet candidate', () => {
    const store = new AlertReferenceStore({ baseDir });
    store.put({
      referenceId: 'GJ-DEF567',
      alert: { eventId: '795098', start: 1787647440 },
      packet: {
        window: { start: 1787647320, end: 1787647680 },
        candidates: [{
          candidateId: 'GJ-DEF567-P2',
          rank: 2,
          ips: ['10.0.0.2', '10.0.0.20'],
          packetWindow: { start: 1787647300, end: 1787647700 },
          packetQuery: {
            mode: 'preview_download_analyze',
            criteria: { ips: ['10.0.0.2', '10.0.0.20'], start: 1787647300, end: 1787647700 },
            analysis: { profileId: 'server_user_experience_time', hasTriggerMetrics: true },
          },
        }],
      },
      triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2311.6599, unit: '毫秒' }],
      analysis: { profileId: 'server_user_experience_time', profileVersion: 1 },
    });

    expect(plugin.__test__.buildCanonicalAlertPacketToolParams('分析 GJ-DEF567-P2', {})).toMatchObject({
      referenceId: 'GJ-DEF567',
      candidateId: 'GJ-DEF567-P2',
      packetCandidate: {
        criteria: { ips: ['10.0.0.2', '10.0.0.20'] },
      },
      start: 1787647300,
      end: 1787647700,
    });
  });

  test('returns a reference-specific error instead of asking for hidden eventId fields', () => {
    const missing = plugin.__test__.buildCanonicalAlertPacketToolParams('分析告警 GJ-MISSING', {});
    expect(missing).toMatchObject({
      referenceId: 'GJ-MISSING',
      referenceErrorCode: 'ALERT_REFERENCE_NOT_FOUND',
      eventId: ''
    });

    const workflow = require('../skills/openclaw-napm-alert-packet-analysis/services/AlertPacketWorkflowService');
    const validation = workflow.normalizeAndValidateInput(missing);
    expect(validation).toMatchObject({
      ok: false,
      errorCode: 'ALERT_REFERENCE_NOT_FOUND',
      message: expect.stringContaining('未找到该告警引用')
    });
  });

  test('returns a separate error when a selected candidate does not exist', () => {
    const store = new AlertReferenceStore({ baseDir });
    store.put({
      referenceId: 'GJ-NOCAND2',
      alert: { eventId: '795099', start: 1787647440 },
      packet: { window: { start: 1787647320, end: 1787647680 }, candidates: [] },
      triggerMetrics: []
    });

    const canonical = plugin.__test__.buildCanonicalAlertPacketToolParams('分析 GJ-NOCAND2-P1', {});
    expect(canonical).toMatchObject({
      referenceId: 'GJ-NOCAND2',
      candidateId: 'GJ-NOCAND2-P1',
      referenceErrorCode: 'ALERT_PACKET_CANDIDATE_NOT_FOUND'
    });
  });

  test('preserves the expired-reference error for a stale cross-session request', () => {
    const writer = new AlertReferenceStore({ baseDir, now: () => 0, ttlMs: 100 });
    writer.put({
      referenceId: 'GJ-EXPIRE2',
      alert: { eventId: '795100', start: 1787647440 },
      expiresAt: 100,
      triggerMetrics: []
    });

    expect(plugin.__test__.buildCanonicalAlertPacketToolParams('分析告警 GJ-EXPIRE2', {})).toMatchObject({
      referenceId: 'GJ-EXPIRE2',
      referenceErrorCode: 'ALERT_REFERENCE_EXPIRED'
    });
  });
});
