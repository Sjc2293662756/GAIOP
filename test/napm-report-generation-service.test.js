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
    // 诊断报告： {faultName}_故障分析报告_{YYYYMMDD}_{HHmmss}
    expect(result.reportId).toMatch(/_故障分析报告_\d{8}_\d{6}$/);
    expect(result.format).toBe('docx');
    expect(result.filePath).toMatch(/\.docx$/);
    expect(result.downloadUrl).toMatch(/^\/reports\//);
    expect(result.fileName).toMatch(/_故障分析报告_\d{8}_\d{6}\.docx$/);
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
    expect(storageTest.sanitizeFileSegment('diag/report:*?')).toBe('diag_report');
  });

  test('should generate human-readable filename: {SystemName}_{TypeCN}_{timestamp} for regular reports', async () => {
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    // inspection_report with explicit systemName
    const inspResult = await service.generate(makeReportPayload({
      reportType: 'inspection_report',
      systemName: 'Netlnside流量分析系统',
      title: 'Netlnside流量分析系统巡检报告',
      sections: [{ type: 'summary', title: '测试', content: '内容' }]
    }));
    expect(inspResult.ok).toBe(true);
    expect(inspResult.reportId).toMatch(/^Netlnside流量分析系统_巡检报告_\d{8}_\d{6}$/);

    // quick_report with systemName from dataSource
    const quickResult = await service.generate(makeReportPayload({
      reportType: 'quick_report',
      systemName: 'NAPM',
      title: '快速报告',
      sections: [{ type: 'summary', title: '摘要', content: '内容' }]
    }));
    expect(quickResult.ok).toBe(true);
    expect(quickResult.reportId).toMatch(/^NAPM_快速报告_\d{8}_\d{6}$/);
  });

  test('should generate human-readable filename: {FaultName}_故障分析报告_{timestamp} for diagnostic reports', async () => {
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    // diagnostic_report with explicit faultName
    const diagResult = await service.generate(makeReportPayload({
      reportType: 'diagnostic_report',
      faultName: '核心交换机端口故障',
      title: '核心交换机端口故障分析报告',
      sections: [{ type: 'summary', title: '核心结论', content: '端口异常。' }]
    }));
    expect(diagResult.ok).toBe(true);
    expect(diagResult.reportId).toMatch(/^核心交换机端口故障_故障分析报告_\d{8}_\d{6}$/);
    expect(diagResult.faultName).toBe('核心交换机端口故障');
  });

  test('should derive faultName from title when not explicitly set', async () => {
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    const result = await service.generate(makeReportPayload({
      reportType: 'diagnostic_report',
      title: '192.168.1.1丢包严重分析',
      sections: [{ type: 'summary', title: '结论', content: '丢包严重。' }]
    }));
    expect(result.ok).toBe(true);
    // faultName derived from title: sanitize('192.168.1.1丢包严重分析')
    expect(result.reportId).toContain('_故障分析报告_');
    expect(result.reportId).toMatch(/^192\.168\.1\.1丢包严重分析_故障分析报告_\d{8}_\d{6}$/);
  });

  test('should include systemName in return value', async () => {
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    const result = await service.generate(makeReportPayload({
      reportType: 'inspection_report',
      systemName: '网深科技流量分析系统',
      sections: [{ type: 'summary', title: '摘要', content: '内容' }]
    }));
    expect(result.ok).toBe(true);
    expect(result.systemName).toBe('网深科技流量分析系统');
    expect(result.fileName).toContain('网深科技流量分析系统_巡检报告_');
  });

  test('should handle future report types via fallback CN name', async () => {
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    const result = await service.generate(makeReportPayload({
      reportType: 'summary_report',
      systemName: 'Netlnside流量分析系统',
      title: '综述报告',
      sections: [{ type: 'summary', title: '摘要', content: '内容' }]
    }));
    expect(result.ok).toBe(true);
    expect(result.reportId).toMatch(/^Netlnside流量分析系统_综述报告_\d{8}_\d{6}$/);
  });
});
