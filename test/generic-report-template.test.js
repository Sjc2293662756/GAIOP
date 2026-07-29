const fs = require('fs');
const os = require('os');
const path = require('path');
const ReportGenerationService = require('../skills/openclaw-napm-report/services/ReportGenerationService');

describe('generic query report template', () => {
  test('renders a registered query report to a Word document', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-generic-report-'));
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    const result = await service.generate({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'quick_report',
      templateId: 'napm_generic_query_v1',
      format: 'docx',
      title: 'TopN query report',
      dataSource: { system: 'NAPM', queryService: 'topValues' },
      sections: [
        { type: 'summary', title: 'Summary', content: 'One result was returned.' },
        { type: 'table', title: 'Results', columns: ['Object', 'Value'], rows: [['192.0.2.10', '83.37']] }
      ]
    });

    expect(result).toMatchObject({ ok: true, format: 'docx', title: 'TopN query report' });
    expect(fs.readFileSync(result.filePath).subarray(0, 2).toString('utf8')).toBe('PK');
  });

  test('rejects generic sections without a renderer', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-generic-report-'));
    const service = new ReportGenerationService({ outputDir });

    await expect(service.generate({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'quick_report',
      templateId: 'napm_generic_query_v1',
      format: 'docx',
      sections: [{ type: 'chart', chartId: 'unsupported-chart' }]
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'REPORT_DATA_INVALID'
    });
  });
});
