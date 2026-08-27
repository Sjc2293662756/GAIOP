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

  test('hides internal event and Unix window fields for reference-based replies', () => {
    const prepared = prepareModelFinalContent([
      '告警引用 GJ-ABC234 数据包分析结论。',
      'eventId=745506 start=1786341600 end=1786341840',
      '告警事件 745506 的服务端响应等待证据已核对。'
    ].join('\n'), {
      ...result,
      referenceId: 'GJ-ABC234'
    });

    expect(prepared).toContain('告警引用 GJ-ABC234');
    expect(prepared).not.toMatch(/eventId\s*[=:]?/i);
    expect(prepared).not.toMatch(/\bstart\s*=\s*\d{10,13}/i);
    expect(prepared).not.toMatch(/\bend\s*=\s*\d{10,13}/i);
    expect(prepared).not.toContain('告警事件 745506');
  });

  test('rejects internal narration payloads as user-facing final content', () => {
    const internalPayload = [
      '告警详情与数据包分析已完成。请仅依据下面的结构化证据解释告警触发原因。',
      '{"schema":"openclaw_napm_alert_packet_analysis.v1","renderPolicy":{"target":"final_user_reply"}}'
    ].join('\n');

    expect(prepareModelFinalContent(internalPayload, result)).toBe('');
  });

  test('rejects model final content for failed packet workflows', () => {
    const failedResult = {
      ...result,
      ok: false,
      workflowState: 'PACKET_ANALYSIS_FAILED',
      referenceId: 'GJ-ABC234'
    };
    const modelFailureSummary = [
      'The packet analysis for this alert reference returned no successful results. Let me check if there is additional context I can gather about this alert.',
      'The result indicates that the packet candidate analysis for alert GJ-ABC234 did not succeed. Let me provide the summary to the user based on what the tool returned.'
    ].join('\n\n');

    expect(prepareModelFinalContent(modelFailureSummary, failedResult)).toBe('');
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

  test('uses the reference in deterministic fallback replies without exposing hidden fields', () => {
    const reply = buildDeterministicFinalReply({
      ...result,
      referenceId: 'GJ-ABC234',
      packetAnalyses: [{ rank: 1, ok: true, result: { summary: { highlights: ['服务端响应等待偏高。'] } } }]
    });

    expect(reply).toContain('告警引用 GJ-ABC234');
    expect(reply).not.toContain('745506');
    expect(reply).not.toMatch(/\bstart\s*=\s*\d+/i);
    expect(reply).not.toMatch(/\bend\s*=\s*\d+/i);
  });
});
