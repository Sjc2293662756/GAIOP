'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AlertReferenceStore = require('../plugin/AlertReferenceStore');
const AlertPacketWorkflowService = require('../skills/openclaw-napm-alert-packet-analysis/services/AlertPacketWorkflowService');
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

  test('preserves confirmation-required packet errors and persists resumable state', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-alert-confirmation-'));
    try {
      const referenceStore = new AlertReferenceStore({ baseDir });
      referenceStore.put({
        referenceId: 'GJ-CONFIRM2',
        alert: { eventId: '800183', start: 1787835240, end: 1787835480 },
        packet: { window: { start: 1787835240, end: 1787835480 }, candidates: [] },
        triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2926.1699, unit: '毫秒' }],
        analysis: { profileId: 'server_user_experience_time', profileVersion: 1 }
      });
      const packetQuery = {
        mode: 'preview_download_analyze',
        criteria: { ips: ['10.0.0.1', '10.0.0.2'], start: 1787835240, end: 1787835480 }
      };
      const packetSkill = {
        handleSkillCall: jest.fn().mockResolvedValue({
          ok: false,
          error: { code: 'PACKET_PREVIEW_REQUIRES_CONFIRMATION', message: '预览结果需要用户确认。' },
          decision: { next_action: 'CONFIRM_DOWNLOAD' },
          preview: { risk: { recommendation: 'CONFIRM_DOWNLOAD', level: 'unknown' } }
        })
      };
      const service = new AlertPacketWorkflowService({
        alertSkill: {
          handleSkillCall: jest.fn().mockResolvedValue({
            ok: true,
            details: [{ id: '800183', name: '告警推送应用测试1' }],
            narrationInput: {
              packetInstruction: { callPacketAnalysis: true, candidates: [{ rank: 1, suggestedPacketQuery: packetQuery }] }
            }
          })
        },
        packetSkill,
        referenceStore,
        retryDelaysMs: [0]
      });

      const result = await service.execute({
        prompt: '分析告警 GJ-CONFIRM2',
        referenceId: 'GJ-CONFIRM2',
        eventId: '800183',
        start: 1787835240,
        end: 1787835480,
        triggerMetrics: { names: ['用户体验时间（服务器）'], values: [2926.1699], units: ['毫秒'] }
      });

      expect(result).toMatchObject({
        ok: false,
        workflowState: 'DOWNLOAD_CONFIRMATION_REQUIRED',
        error: { code: 'DOWNLOAD_CONFIRMATION_REQUIRED' },
        decision: { next_action: 'CONFIRM_DOWNLOAD' }
      });
      expect(result.narrationInput.decision).toMatchObject({ next_action: 'CONFIRM_DOWNLOAD' });
      expect(packetSkill.handleSkillCall).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'preview_download_analyze'
      }));
      expect(referenceStore.get('GJ-CONFIRM2')).toMatchObject({
        status: 'AWAITING_DOWNLOAD_CONFIRMATION',
        packet: {
          workflowState: 'DOWNLOAD_CONFIRMATION_REQUIRED',
          pendingAction: 'CONFIRM_DOWNLOAD',
          pendingCandidateIds: ['GJ-CONFIRM2-P1']
        }
      });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('returns a persisted candidate selection and does not analyze the first candidate automatically', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-alert-candidates-'));
    try {
      const referenceStore = new AlertReferenceStore({ baseDir });
      referenceStore.put({
        referenceId: 'GJ-MULTI23',
        alert: { eventId: '795097', start: 1787647440 },
        packet: { window: { start: 1787647320, end: 1787647680 }, candidates: [] },
        triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2311.6599, unit: '毫秒' }],
        analysis: { profileId: 'server_user_experience_time', profileVersion: 1 }
      });
      const candidateQuery = (ips) => ({
        mode: 'preview_download_analyze',
        criteria: { ips, start: 1787647320, end: 1787647680 }
      });
      const alertSkill = {
        handleSkillCall: jest.fn().mockResolvedValue({
          ok: true,
          details: [{ id: '795097', name: '告警推送应用测试1' }],
          narrationInput: {
            packetInstruction: {
              callPacketAnalysis: true,
              candidates: [
                { rank: 1, ipPair: '10.0.0.1 -> 10.0.0.2', suggestedPacketQuery: candidateQuery(['10.0.0.1', '10.0.0.2']) },
                { rank: 2, ipPair: '10.0.0.3 -> 10.0.0.4', suggestedPacketQuery: candidateQuery(['10.0.0.3', '10.0.0.4']) }
              ]
            }
          }
        })
      };
      const packetSkill = { handleSkillCall: jest.fn() };
      const service = new AlertPacketWorkflowService({
        alertSkill,
        packetSkill,
        referenceStore,
        retryDelaysMs: [0]
      });

      const result = await service.execute({
        prompt: '分析告警 GJ-MULTI23',
        referenceId: 'GJ-MULTI23',
        eventId: '795097',
        start: 1787647320,
        end: 1787647680,
        triggerMetrics: { names: ['用户体验时间（服务器）'], values: [2311.6599], units: ['毫秒'] }
      });

      expect(result).toMatchObject({
        ok: true,
        workflowState: 'CANDIDATE_SELECTION_REQUIRED',
        referenceId: 'GJ-MULTI23',
        candidateOptions: [
          { candidateId: 'GJ-MULTI23-P1' },
          { candidateId: 'GJ-MULTI23-P2' }
        ]
      });
      expect(packetSkill.handleSkillCall).not.toHaveBeenCalled();
      expect(referenceStore.get('GJ-MULTI23').packet.candidates.map((item) => item.candidateId))
        .toEqual(['GJ-MULTI23-P1', 'GJ-MULTI23-P2']);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('analyzes only the explicitly selected candidate from a cross-session reference', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-alert-selected-'));
    try {
      const referenceStore = new AlertReferenceStore({ baseDir });
      const p1 = {
        candidateId: 'GJ-SELECT2-P1',
        rank: 1,
        ips: ['10.0.0.1', '10.0.0.2'],
        packetWindow: { start: 100, end: 200 },
        packetQuery: { mode: 'preview_download_analyze', criteria: { ips: ['10.0.0.1', '10.0.0.2'], start: 100, end: 200 } }
      };
      const p2 = {
        candidateId: 'GJ-SELECT2-P2',
        rank: 2,
        ips: ['10.0.0.3', '10.0.0.4'],
        packetWindow: { start: 300, end: 400 },
        packetQuery: { mode: 'preview_download_analyze', criteria: { ips: ['10.0.0.3', '10.0.0.4'], start: 300, end: 400 } }
      };
      referenceStore.put({
        referenceId: 'GJ-SELECT2',
        alert: { eventId: '795098', start: 120 },
        packet: { window: { start: 100, end: 200 }, candidates: [p1, p2] },
        triggerMetrics: [{ label: '用户体验时间（服务器）', value: 2311.6599, unit: '毫秒' }],
        analysis: { profileId: 'server_user_experience_time', profileVersion: 1 }
      });
      const packetResult = { ok: true, summary: { highlights: ['P1 证据'] } };
      const packetSkill = { handleSkillCall: jest.fn().mockResolvedValue(packetResult) };
      const alertSkill = { handleSkillCall: jest.fn() };
      const service = new AlertPacketWorkflowService({ alertSkill, packetSkill, referenceStore });

      const result = await service.execute({
        prompt: '分析告警 GJ-SELECT2-P1',
        referenceId: 'GJ-SELECT2',
        candidateId: 'GJ-SELECT2-P1',
        eventId: '795098',
        start: 100,
        end: 200,
        triggerMetrics: { names: ['用户体验时间（服务器）'], values: [2311.6599], units: ['毫秒'] },
        packetCandidate: p1.packetQuery
      });

      expect(alertSkill.handleSkillCall).not.toHaveBeenCalled();
      expect(packetSkill.handleSkillCall).toHaveBeenCalledTimes(1);
      expect(packetSkill.handleSkillCall.mock.calls[0][0].criteria.ips).toEqual(['10.0.0.1', '10.0.0.2']);
      expect(result).toMatchObject({
        ok: true,
        workflowState: 'COMPLETED',
        referenceId: 'GJ-SELECT2',
        candidateId: 'GJ-SELECT2-P1'
      });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
