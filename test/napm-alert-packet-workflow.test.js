'use strict';

const {
  executeAlertPacketAnalysis
} = require('../skills/openclaw-napm-alert-packet-analysis/scripts/run_alert_packet_analysis');
const {
  normalizeOptions: normalizeAlertOptions
} = require('../skills/openclaw-napm-alert-query/services/AlertQueryValidator');

describe('NAPM alert packet analysis workflow', () => {
  test('preserves externally supplied alert trigger metrics for packet discovery', () => {
    expect(normalizeAlertOptions({
      alertTriggerMetrics: {
        names: ['用户体验时间（服务器）'],
        values: [3055.3701],
        units: ['毫秒'],
        condition: '用户体验时间（服务器） > 3000.0',
        severity: '紧急'
      }
    })).toMatchObject({
      alertTriggerMetrics: {
        names: ['用户体验时间（服务器）'],
        values: [3055.3701],
        units: ['毫秒'],
        severity: '紧急'
      }
    });
  });

  test('retries fixed-range alert detail and then invokes the existing packet Skill', async () => {
    const suggestedPacketQuery = {
      mode: 'preview_download_analyze',
      criteria: {
        ips: ['10.0.0.10', '10.0.0.20'],
        start: 1786327200,
        end: 1786327680
      },
      analysis: {
        hasTriggerMetrics: true,
        metrics: ['用户体验时间（服务器）'],
        instruction: '定位服务器侧用户体验时间升高的真实网络原因'
      }
    };
    const alertSkill = {
      handleSkillCall: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          mode: 'detail',
          service: 'alertsDetail',
          details: [],
          narrationInput: { packetInstruction: { callPacketAnalysis: false } }
        })
        .mockResolvedValueOnce({
          ok: true,
          mode: 'detail',
          service: 'alertsDetail',
          details: [{ id: 745278, name: '告警推送应用测试1' }],
          narrationInput: {
            packetInstruction: {
              action: 'USE_CANDIDATES',
              callPacketAnalysis: true,
              candidates: [{ rank: 1, suggestedPacketQuery }]
            }
          }
        })
    };
    const packetResult = {
      ok: true,
      summary: { title: '数据包任务完成', highlights: ['发现 TCP 重传。'] },
      analysis: { ok: true }
    };
    const packetSkill = {
      handleSkillCall: jest.fn().mockResolvedValue(packetResult)
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    const result = await executeAlertPacketAnalysis({
      prompt: [
        '分析告警数据包 eventId=745278 start=1786327320 end=1786327560',
        '触发指标值: 用户体验时间（服务器）=3055.3701毫秒',
        '告警级别: 紧急',
        '触发条件: 如果 用户体验时间（服务器） > 3000.0 则为 Critical'
      ].join('\n'),
      eventId: '745278',
      start: 1786327320,
      end: 1786327560,
      triggerMetrics: {
        names: ['用户体验时间（服务器）'],
        values: [3055.3701],
        units: ['毫秒'],
        severity: '紧急',
        condition: '用户体验时间（服务器） > 3000.0'
      }
    }, {
      alertSkill,
      packetSkill,
      sleep,
      retryDelaysMs: [0, 2000, 4000, 8000]
    });

    expect(alertSkill.handleSkillCall).toHaveBeenCalledTimes(2);
    for (const [query] of alertSkill.handleSkillCall.mock.calls) {
      expect(query).toMatchObject({
        mode: 'detail',
        criteria: {
          eventIds: ['745278'],
          start: 1786327320,
          end: 1786327560
        },
        options: {
          packetHandoff: true,
          discoveryEnabled: true,
          alertTriggerMetrics: {
            names: ['用户体验时间（服务器）'],
            values: [3055.3701]
          }
        }
      });
      expect(query.criteria).not.toHaveProperty('timeRange');
    }
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(packetSkill.handleSkillCall).toHaveBeenCalledTimes(1);
    expect(packetSkill.handleSkillCall).toHaveBeenCalledWith({
      ...suggestedPacketQuery,
      criteria: {
        ...suggestedPacketQuery.criteria,
        start: 1786327320,
        end: 1786327560
      }
    });
    expect(result).toMatchObject({
      ok: true,
      workflowType: 'alert_packet_analysis',
      workflowState: 'COMPLETED',
      detailAttempts: 2,
      alert: { details: [{ id: 745278 }] },
      packetAnalyses: [{ rank: 1, ok: true, result: packetResult }]
    });
  });

  test('stops after bounded empty-detail retries without falling back to alert summary', async () => {
    const alertSkill = {
      handleSkillCall: jest.fn().mockResolvedValue({
        ok: true,
        mode: 'detail',
        service: 'alertsDetail',
        details: [],
        narrationInput: { packetInstruction: { callPacketAnalysis: false } }
      })
    };
    const packetSkill = { handleSkillCall: jest.fn() };
    const sleep = jest.fn().mockResolvedValue(undefined);

    const result = await executeAlertPacketAnalysis({
      prompt: '分析告警数据包 eventId=745278 start=1786327320 end=1786327560',
      eventId: '745278',
      start: 1786327320,
      end: 1786327560
    }, {
      alertSkill,
      packetSkill,
      sleep,
      retryDelaysMs: [0, 2000, 4000, 8000]
    });

    expect(alertSkill.handleSkillCall).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2000, 4000, 8000]);
    expect(alertSkill.handleSkillCall.mock.calls.every(([query]) => (
      query.mode === 'detail'
      && query.criteria.start === 1786327320
      && query.criteria.end === 1786327560
      && !Object.prototype.hasOwnProperty.call(query.criteria, 'timeRange')
    ))).toBe(true);
    expect(packetSkill.handleSkillCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState: 'ALERT_DETAIL_NOT_VISIBLE',
      detailAttempts: 4,
      packetAnalyses: [],
      error: { code: 'ALERT_DETAIL_NOT_VISIBLE' }
    });
    expect(JSON.stringify(result)).not.toContain('alertsSummary');
    expect(JSON.stringify(result)).not.toContain('告警总数');
  });
});
