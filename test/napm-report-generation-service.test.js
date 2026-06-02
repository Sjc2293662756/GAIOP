const fs = require('fs');
const os = require('os');
const path = require('path');

const ReportGenerationService = require('../skills/openclaw-napm-report/services/ReportGenerationService');
const { __test__: storageTest } = require('../skills/openclaw-napm-report/services/ReportStorageService');
const { __test__: templateTest } = require('../skills/openclaw-napm-report/services/ReportTemplateService');

function makeReportPayload(overrides = {}) {
  return {
    reportType: 'diagnostic_report',
    format: 'docx',
    title: '最近一天丢包严重 IP 分析报告',
    sourceQuestion: '生成最近一天丢包最严重 IP 的分析报告',
    timeRange: {
      displayText: '最近一天',
      start: 1779925800,
      end: 1780012200
    },
    dataSource: {
      system: 'NAPM',
      queryService: 'topValues',
      objectType: 'IPAddress',
      metrics: ['PLI', 'PLO']
    },
    sections: [
      {
        type: 'summary',
        title: '核心结论',
        content: '最近一天丢包最严重的 IP 为 192.0.2.10。'
      },
      {
        type: 'table',
        title: '丢包 Top 10',
        columns: ['排名', 'IP', '流入丢包率', '流出丢包率'],
        rows: [
          [1, '192.0.2.10', '83.37%', '12.10%']
        ]
      },
      {
        type: 'recommendation',
        title: '处置建议',
        items: ['检查链路质量。', '确认是否存在拥塞或设备丢包。']
      }
    ],
    audit: {
      resolvedQueryId: 'rq-test',
      skillRunId: 'skill-test',
      apiCalls: []
    },
    ...overrides
  };
}

describe('openclaw-napm-report generation service', () => {
  let outputDir;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-'));
  });

  test('should generate docx report and audit json from structured report data', async () => {
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    const result = await service.generate(makeReportPayload());

    expect(result.ok).toBe(true);
    expect(result.reportId).toMatch(/^napm-diagnostic_report-\d{8}-\d{6}-[a-z0-9]{6}$/);
    expect(result.format).toBe('docx');
    expect(result.filePath).toMatch(/\.docx$/);
    expect(result.downloadUrl).toMatch(/^\/reports\/napm-diagnostic_report-/);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.existsSync(result.auditPath)).toBe(true);

    const header = fs.readFileSync(result.filePath).subarray(0, 2).toString('utf8');
    expect(header).toBe('PK');

    const audit = JSON.parse(fs.readFileSync(result.auditPath, 'utf8'));
    expect(audit.title).toBe('最近一天丢包严重 IP 分析报告');
    expect(audit.timeRange.start).toBe(1779925800);
    expect(audit.reportId).toBe(result.reportId);
  });

  test('should reject missing sections instead of generating empty report', async () => {
    const service = new ReportGenerationService({ outputDir });

    const result = await service.generate(makeReportPayload({ sections: [] }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPORT_DATA_INVALID'
    });
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  test('should reject pdf without silently falling back to docx', async () => {
    const service = new ReportGenerationService({ outputDir });

    const result = await service.generate(makeReportPayload({ format: 'pdf' }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPORT_PDF_EXPORT_UNAVAILABLE'
    });
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  test('should normalize object rows for table rendering', () => {
    expect(templateTest.normalizeRows([{ a: 1, b: 'x' }])).toEqual([['1', 'x']]);
  });

  test('should sanitize file segments for report id parts', () => {
    expect(storageTest.sanitizeFileSegment('diag/report:*?')).toBe('diag-report');
  });
});
