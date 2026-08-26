'use strict';

jest.mock('axios', () => ({ post: jest.fn() }));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const AlertReferenceStore = require('../plugin/AlertReferenceStore');
const WeComPushService = require('../skills/openclaw-napm-syslog-watcher/services/WeComPushService');

describe('WeCom alert reference push', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-wecom-reference-'));
    process.env.NAPM_ALERT_REFERENCE_DIR = baseDir;
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { errcode: 0 } });
  });

  afterEach(() => {
    delete process.env.NAPM_ALERT_REFERENCE_DIR;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('hides internal event/window fields and publishes a cross-session reference', async () => {
    const service = new WeComPushService({
      wecom: { webhookUrl: 'https://example.invalid/webhook' },
      alertReference: { baseDir }
    });
    const alert = {
      alertName: '告警推送应用测试1',
      alertSeverity: '轻微',
      category: 'appAlerts',
      timestamp: '2026-08-25T16:46:16.000+08:00',
      extra: {
        elogid: '795097',
        starttime: '1787647440',
        endtime: '0',
        condition: '用户体验时间（服务器） > 2000.0'
      },
      metrics: [{ name: '用户体验时间（服务器）', value: 2311.6599, unit: '毫秒' }]
    };

    await expect(service.pushAlert(alert)).resolves.toBe(true);
    const content = axios.post.mock.calls[0][1].markdown_v2.content;
    expect(content).toContain('GJ-');
    expect(content).toContain('请回复：**分析告警 GJ-');
    expect(content).not.toMatch(/eventId\s*[=:]\s*\d+/i);
    expect(content).not.toMatch(/\bstart\s*=\s*\d+/i);
    expect(content).not.toMatch(/\bend\s*=\s*\d+/i);
    expect(content).not.toMatch(/Event ID/i);

    const stored = new AlertReferenceStore({ baseDir }).findByEventId('795097');
    expect(stored).toMatchObject({ ok: true, alert: { eventId: '795097' } });
    expect(stored.analysis.profileId).toBe('server_user_experience_time');
  });

  test('explains that automatic packet locating is unavailable when event id is missing', async () => {
    const service = new WeComPushService({
      wecom: { webhookUrl: 'https://example.invalid/webhook' },
      alertReference: { baseDir }
    });
    await expect(service.pushAlert({
      alertName: '缺少事件编号的告警',
      alertSeverity: '轻微',
      extra: { starttime: '1787647440' }
    })).resolves.toBe(true);

    const content = axios.post.mock.calls[0][1].markdown_v2.content;
    expect(content).toContain('暂无法自动定位数据包');
    expect(content).not.toContain('请回复：**分析告警 GJ-');
  });
});
