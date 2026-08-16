'use strict';

const {
  buildDeterministicFinalReply,
  prepareModelFinalContent
} = require('../plugin/AlertPacketFinalReplyService');

describe('AlertPacketFinalReplyService', () => {
  const result = {
    workflowType: 'alert_packet_analysis',
    workflowState: 'COMPLETED',
    eventId: '745506',
    timeRange: { start: 1786341600, end: 1786341840 },
    triggerMetrics: {
      names: ['用户体验时间（服务器）'],
      values: [12289],
      units: ['毫秒'],
      severity: '紧急'
    }
  };

  test('accepts a current-turn final report and masks credentials', () => {
    const content = [
      '告警事件 745506 数据包分析结论：服务器响应等待升高。',
      'Debug API: https://example.test/query?UserName=GAIOP&Password=secret&token=abc123'
    ].join('\n');

    const prepared = prepareModelFinalContent(content, result);

    expect(prepared).toContain('告警事件 745506');
    expect(prepared).toContain('Password=***');
    expect(prepared).toContain('token=***');
    expect(prepared).not.toContain('secret');
    expect(prepared).not.toContain('abc123');
  });

  test('rejects internal narration payloads as user-facing final content', () => {
    const internalPayload = [
      '告警详情与数据包分析已完成。请仅依据下面的结构化证据解释告警触发原因。',
      '{"schema":"openclaw_napm_alert_packet_analysis.v1","renderPolicy":{"target":"final_user_reply"}}'
    ].join('\n');

    expect(prepareModelFinalContent(internalPayload, result)).toBe('');
  });

  test('renders safe deterministic evidence without raw rows, local files, or URLs', () => {
    const reply = buildDeterministicFinalReply({
      ...result,
      packetAnalyses: [{
        rank: 1,
        ok: true,
        candidate: { ipPair: '10.0.0.10 -> 10.0.0.20' },
        result: {
          summary: {
            highlights: [
              '发现 TCP 重传率升高。',
              '预览 URL 已生成：https://example.test/query?Password=secret'
            ]
          },
          analysis: {
            filePath: '/tmp/private/capture.pcap',
            httpRows: ['raw tshark row with private payload']
          }
        }
      }]
    });

    expect(reply).toContain('10.0.0.10 -> 10.0.0.20');
    expect(reply).toContain('发现 TCP 重传率升高');
    expect(reply).not.toContain('https://');
    expect(reply).not.toContain('secret');
    expect(reply).not.toContain('/tmp/private');
    expect(reply).not.toContain('raw tshark row');
  });
});
