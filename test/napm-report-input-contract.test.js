const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const {
  normalizeReportInput,
  buildPacketReportData,
  buildInspectionReportData,
  isPacketSourceResult
} = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const ReportTemplateService = require('../skills/openclaw-napm-report/services/ReportTemplateService');
const SummaryReportDataService = require('../skills/openclaw-napm-summary/services/SummaryReportDataService');
const {
  normalizeReportInput: normalizeSummaryReportInput
} = require('../skills/openclaw-napm-summary/services/ReportInputContractService');

const LEGACY_FAULT_REPORT_PATH = path.join(
  __dirname,
  '..',
  'skills',
  'openclaw-napm-report',
  'output',
  '核心交换机G0-1端口流量突发中断_故障分析报告_20260622_143651.json'
);

function loadLegacyFaultReport() {
  return JSON.parse(fs.readFileSync(LEGACY_FAULT_REPORT_PATH, 'utf8'));
}

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
      reportType: 'quick_report',
      templateId: 'napm_generic_query_v1',
      format: 'docx',
      systemName: 'NAPM',
      dataSource: {
        sourceSkill: 'openclaw-napm-packet-analysis'
      }
    });
    expect(reportData.faultName).toBeTruthy();
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
    expect(reportData.templateId).toBe('napm_generic_query_v1');
    expect(reportData.audit.reportInputSource).toBe('reportData');
  });

  test('should migrate legacy fault diagnosis data into the fixed-template diagnosis shape', () => {
    const reportData = normalizeReportInput({ sourceResult: loadLegacyFaultReport() });

    expect(reportData).toMatchObject({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'diagnostic_report',
      templateId: 'napm_bs_fault_diagnosis_v2',
      diagnosis: {
        targetLabel: '核心交换机G0-1端口流量突发中断',
        targetType: 'WebApplication',
        stepCount: 3,
        step1: {
          http400Total: 80,
          http500Total: 235
        }
      }
    });
    expect(reportData.diagnosis.step2.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageUrl: 'web-app-01/api/data', PGHTTP400: 45, PGHTTP500: 120 }),
      expect.objectContaining({ pageUrl: 'web-app-01/login', PGHTTP400: 20, PGHTTP500: 85 })
    ]));
    expect(reportData.audit).toMatchObject({
      legacyTemplateId: 'napm_fault_diagnosis_v1',
      sourceSchema: 'openclaw_napm_fault_diagnosis_result.v1'
    });
  });

  test('should migrate a legacy explicit reportData payload', () => {
    const reportData = normalizeReportInput({ reportData: loadLegacyFaultReport() });

    expect(reportData.templateId).toBe('napm_bs_fault_diagnosis_v2');
    expect(reportData.diagnosis.step1.http500Total).toBe(235);
  });

  test('should keep explicit reportData authoritative over a legacy source result', () => {
    const reportData = normalizeReportInput({
      reportData: {
        schema: 'openclaw_napm_report_data.v1',
        reportType: 'quick_report',
        format: 'docx',
        title: 'Explicit quick report',
        sections: [{ type: 'summary', title: 'Summary', content: 'ok' }]
      },
      sourceResult: loadLegacyFaultReport()
    });

    expect(reportData).toMatchObject({
      reportType: 'quick_report',
      templateId: 'napm_generic_query_v1',
      title: 'Explicit quick report'
    });
  });

  test('should preserve an already normalized fault diagnosis reportData payload', () => {
    const reportData = normalizeReportInput({
      sourceResult: {
        reportData: {
          schema: 'openclaw_napm_report_data.v1',
          reportType: 'diagnostic_report',
          templateId: 'napm_bs_fault_diagnosis_v2',
          format: 'docx',
          title: 'Current fault report',
          diagnosis: {
            targetLabel: '239web',
            step1: { http400Total: 1, http500Total: 2 }
          }
        }
      }
    });

    expect(reportData.diagnosis).toEqual({
      targetLabel: '239web',
      step1: { http400Total: 1, http500Total: 2 }
    });
  });

  test('should render migrated legacy fault data with populated Word body', async () => {
    const reportData = normalizeReportInput({ sourceResult: loadLegacyFaultReport() });
    const buffer = await new ReportTemplateService().renderDocx(reportData);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml').async('string');

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(documentXml).toContain('核心交换机G0/1端口在14:05突发流量中断');
    expect(documentXml).toContain('HTTP 500 服务端错误（235 次）');
  }, 30000);

  test('summary report data service should migrate legacy fault results too', () => {
    const reportData = new SummaryReportDataService().buildReportData(loadLegacyFaultReport());

    expect(reportData).toMatchObject({
      reportType: 'diagnostic_report',
      templateId: 'napm_bs_fault_diagnosis_v2',
      diagnosis: {
        step1: { http400Total: 80, http500Total: 235 }
      }
    });
  });

  test('summary input contract should migrate legacy fault results too', () => {
    const reportData = normalizeSummaryReportInput({ sourceResult: loadLegacyFaultReport() });

    expect(reportData).toMatchObject({
      reportType: 'diagnostic_report',
      templateId: 'napm_bs_fault_diagnosis_v2',
      diagnosis: {
        step1: { http400Total: 80, http500Total: 235 }
      }
    });
  });

  test('should preserve inspection report windows when normalizing a direct inspection payload', () => {
    const reportData = buildInspectionReportData({
      schema: 'openclaw_napm_inspection_result.v1',
      inspection: {
        schema: 'openclaw_napm_inspection.v1',
        reportWindow: {
          key: 'last30days',
          start: 1783500960,
          end: 1786092960,
          timezone: 'Asia/Shanghai'
        }
      }
    });

    expect(reportData).toMatchObject({
      reportType: 'inspection_report',
      timeRange: { key: 'last30days', timezone: 'Asia/Shanghai' },
      reportWindow: { key: 'last30days', start: 1783500960, end: 1786092960 }
    });
  });
});
