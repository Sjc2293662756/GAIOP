const fs = require('fs');
const os = require('os');
const path = require('path');

function makeReportData(overrides = {}) {
  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'quick_report',
    format: 'docx',
    defaultFormat: 'docx',
    title: '丢包 Top 10 报告',
    sourceQuestion: '最近一天丢包最高的 IP',
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
        content: '丢包最高的 IP 是 192.0.2.10。'
      },
      {
        type: 'table',
        title: '排行明细',
        columns: ['排名', '对象', '指标', '数值', '单位'],
        rows: [[1, '192.0.2.10', 'PLI', '83.37', '%']]
      }
    ],
    audit: {
      service: 'topValues'
    },
    ...overrides
  };
}

describe('napm-openclaw-plugin report export', () => {
  const originalReportExecutor = process.env.NAPM_REPORT_EXECUTOR;
  const originalReportOutputDir = process.env.NAPM_REPORT_OUTPUT_DIR;
  const originalDevResolverTools = process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;
  let outputDir;
  let plugin;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-plugin-report-'));
    process.env.NAPM_REPORT_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-report/scripts/generate_napm_report.js');
    process.env.NAPM_REPORT_OUTPUT_DIR = outputDir;
    delete process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalReportExecutor === undefined) {
      delete process.env.NAPM_REPORT_EXECUTOR;
    } else {
      process.env.NAPM_REPORT_EXECUTOR = originalReportExecutor;
    }
    if (originalReportOutputDir === undefined) {
      delete process.env.NAPM_REPORT_OUTPUT_DIR;
    } else {
      process.env.NAPM_REPORT_OUTPUT_DIR = originalReportOutputDir;
    }
    if (originalDevResolverTools === undefined) {
      delete process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;
    } else {
      process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS = originalDevResolverTools;
    }
  });

  test('should register report export tool in production', () => {
    const tools = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      registerCommand() {},
      registerHook() {}
    });

    expect(Array.from(tools.keys()).sort()).toEqual(['napm-report-export', 'napm-skill-query']);
  });

  test('should export explicitly provided reportData to docx', async () => {
    const tool = plugin.__test__.createReportExportToolDefinition();

    const result = await tool.execute('report-tool-1', {
      prompt: '将以上以 Word 形式导出',
      format: 'word',
      reportData: makeReportData()
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.format).toBe('docx');
    expect(fs.existsSync(result.details.filePath)).toBe(true);
    expect(result.content[0].text).toContain('报告已生成');
  });

  test('should export latest remembered skill reportData when args omit reportData', async () => {
    plugin.__test__.rememberSkillResult('最近一天丢包最高的 IP', {
      ok: true,
      resolvedQuery: { service: 'topValues' },
      reportData: makeReportData({ title: '上一轮报告' })
    });

    const result = await plugin.__test__.runReportExecutor({
      prompt: '将以上以 Word 形式导出',
      format: 'docx'
    });

    expect(result.ok).toBe(true);
    expect(result.title).toBe('上一轮报告');
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  test('should block export when no reportData is available', async () => {
    const result = await plugin.__test__.runReportExecutor({
      prompt: '将以上以 Word 形式导出',
      format: 'docx'
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND'
    });
  });

  test('should not silently downgrade pdf to docx', async () => {
    const result = await plugin.__test__.runReportExecutor({
      prompt: '将以上以 PDF 形式导出',
      format: 'pdf',
      reportData: makeReportData()
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPORT_PDF_EXPORT_UNAVAILABLE'
    });
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  test('should suppress duplicate media path within one conversation window', () => {
    const ctx = {
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'shijc'
    };
    const first = plugin.__test__.dedupeOutgoingMediaForConversation({
      mediaUrls: ['/home/netinside/.openclaw/media/outbound/report.docx'],
      mediaUrl: '/home/netinside/.openclaw/media/outbound/report.docx'
    }, ctx);
    const second = plugin.__test__.dedupeOutgoingMediaForConversation({
      mediaUrls: ['/home/netinside/.openclaw/media/outbound/report.docx'],
      mediaUrl: '/home/netinside/.openclaw/media/outbound/report.docx'
    }, ctx);

    expect(first.fresh).toEqual(['/home/netinside/.openclaw/media/outbound/report.docx']);
    expect(first.duplicates).toEqual([]);
    expect(second.fresh).toEqual([]);
    expect(second.duplicates).toEqual(['/home/netinside/.openclaw/media/outbound/report.docx']);
  });
});
