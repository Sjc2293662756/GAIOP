const {
  normalizeReportInput,
  buildPacketReportData,
  isPacketSourceResult
} = require('../skills/openclaw-napm-report/services/ReportInputContractService');

function makePacketResult() {
  return {
    ok: true,
    mode: 'preview_download_analyze',
    downloadType: 'packetsDown',
    criteria: {
      ips: ['101.254.114.238'],
      start: 1780880000,
      end: 1780883600
    },
    urls: {
      preview: 'https://example.test/NetInside?UserName=GAIOP&Password=***&type=packetsPreview',
      download: 'https://example.test/NetInside?UserName=GAIOP&Password=***&type=packetsDown'
    },
    summary: {
      title: 'Packet analysis completed',
      highlights: ['8,280 packets found', '170 peer IPs observed']
    },
    narrationInput: {
      schema: 'openclaw_napm_packet_analysis.v1'
    },
    analysis: {
      ok: true,
      protocolHierarchy: [
        { protocol: 'tcp', frames: 8000, bytes: 1200000 }
      ],
      endpoints: [
        { address: '203.0.113.10', packets: 100, bytes: 2048 }
      ],
      conversations: [
        { source: '101.254.114.238', destination: '203.0.113.10', packets: 100, bytes: 2048 }
      ]
    }
  };
}

describe('openclaw-napm-report input contract', () => {
  test('should recognize packet analysis result as report source', () => {
    expect(isPacketSourceResult(makePacketResult())).toBe(true);
  });

  test('should convert packet analysis result into reportData sections inside report skill', () => {
    const reportData = buildPacketReportData(makePacketResult(), {
      prompt: '将以上总结为报告以word的形式给我',
      format: 'word'
    });

    expect(reportData).toMatchObject({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'diagnostic_report',
      format: 'docx',
      dataSource: {
        sourceSkill: 'openclaw-napm-packet-analysis'
      }
    });
    expect(reportData.sections.some((section) => section.title === 'Top 对端')).toBe(true);
    expect(reportData.sections.some((section) => section.title === 'Top 会话')).toBe(true);
  });

  test('should prefer explicit reportData over sourceResult', () => {
    const reportData = normalizeReportInput({
      format: 'word',
      reportData: {
        schema: 'openclaw_napm_report_data.v1',
        reportType: 'quick_report',
        format: 'docx',
        title: 'Explicit report',
        sections: [{ type: 'summary', title: 'Summary', content: 'ok' }]
      },
      sourceResult: makePacketResult()
    });

    expect(reportData.title).toBe('Explicit report');
    expect(reportData.reportType).toBe('quick_report');
    expect(reportData.audit.reportInputSource).toBe('reportData');
  });
});
