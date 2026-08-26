'use strict';

const {
  buildAnalysisContext,
  resolveProfile,
} = require('../skills/openclaw-napm-alert-packet-analysis/services/AlertMetricProfileService');

describe('AlertMetricProfileService', () => {
  test('maps server user experience time to a focused profile', () => {
    const context = buildAnalysisContext({
      names: ['用户体验时间（服务器）'],
      values: [2311.6599],
      units: ['毫秒'],
      condition: '用户体验时间（服务器） > 2000',
      severity: '轻微',
    });
    expect(context).toMatchObject({
      hasTriggerMetrics: true,
      profileId: 'server_user_experience_time',
      supported: true,
      values: [2311.6599],
    });
    expect(context.evidenceChecks).toEqual(expect.arrayContaining(['server_response_wait', 'tcp_rtt']));
    expect(context.instruction).toContain('服务端响应');
  });

  test('does not pretend an unknown metric has a supported profile', () => {
    expect(resolveProfile({ names: ['未知自定义指标'] })).toBeNull();
    expect(buildAnalysisContext({ names: ['未知自定义指标'], values: [1] })).toMatchObject({
      hasTriggerMetrics: true,
      profileId: 'unknown_alert_metric',
      supported: false,
    });
  });
});
