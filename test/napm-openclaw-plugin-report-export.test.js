const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');

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
  const originalReportSourceDir = process.env.NAPM_REPORT_SOURCE_DIR;
  const originalTrustedContextDir = process.env.NAPM_TRUSTED_CONTEXT_DIR;
  const originalAuditLogPath = process.env.NAPM_AUDIT_LOG_PATH;
  let outputDir;
  let stateDir;
  let plugin;

  function bindToolArgs(toolName, args, suffix) {
    const ctx = {
      channelId: 'wecom',
      accountId: `report-${suffix}`,
      conversationId: `report-${suffix}`
    };
    plugin.__test__.bindTrustedToolContext({
      toolName,
      toolCallId: suffix,
      params: args
    }, ctx);
    return {
      args,
      conversationKey: plugin.__test__.getConversationKey(ctx)
    };
  }

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-plugin-report-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-plugin-state-'));
    process.env.NAPM_REPORT_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-report/scripts/generate_napm_report.js');
    process.env.NAPM_REPORT_OUTPUT_DIR = outputDir;
    process.env.NAPM_REPORT_SOURCE_DIR = path.join(stateDir, 'report-sources');
    process.env.NAPM_TRUSTED_CONTEXT_DIR = path.join(stateDir, 'trusted-contexts');
    process.env.NAPM_AUDIT_LOG_PATH = path.join(stateDir, 'audit.log');
    delete process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
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
    restoreEnv('NAPM_REPORT_SOURCE_DIR', originalReportSourceDir);
    restoreEnv('NAPM_TRUSTED_CONTEXT_DIR', originalTrustedContextDir);
    restoreEnv('NAPM_AUDIT_LOG_PATH', originalAuditLogPath);
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

    expect(Array.from(tools.keys()).sort()).toEqual([
      'napm-alert-packet-analysis',
      'napm-alert-query',
      'napm-fault-diagnosis',
      'napm-inspection-snapshot',
      'napm-packet-analysis',
      'napm-report-export',
      'napm-skill-query',
      'napm-summary'
    ]);
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
    const exportArgs = {
      prompt: '将以上以 Word 形式导出',
      format: 'docx'
    };
    const bound = bindToolArgs('napm-report-export', exportArgs, 'remembered-query');
    plugin.__test__.rememberSkillResult('最近一天丢包最高的 IP', {
      ok: true,
      resolvedQuery: { service: 'topValues' },
      reportData: makeReportData({ title: '上一轮报告' })
    }, bound.conversationKey);

    const result = await plugin.__test__.createReportExportToolDefinition()
      .execute('report-tool-remembered-query', bound.args);

    expect(result.details.ok).toBe(true);
    expect(result.details.title).toBe('上一轮报告');
    expect(fs.existsSync(result.details.filePath)).toBe(true);
  });

  test('should export latest remembered packet analysis result as reportData', async () => {
    const exportArgs = {
      prompt: '将以上总结为报告以word的形式给我',
      format: 'docx'
    };
    const bound = bindToolArgs('napm-report-export', exportArgs, 'remembered-packet');
    plugin.__test__.rememberSkillResult('分析 101.254.114.238 最近一天的数据包 数据情况', {
      ok: true,
      mode: 'preview_download_analyze',
      downloadType: 'packetsDown',
      criteria: {
        ips: ['101.254.114.238'],
        start: 1780880000,
        end: 1780883600
      },
      urls: {
        preview: 'https://101.254.114.238/webservice/NetInside?UserName=GAIOP&Password=***&type=packetsPreview',
        download: 'https://101.254.114.238/webservice/NetInside?UserName=GAIOP&Password=***&type=packetsDown'
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
        endpoints: [
          { address: '203.0.113.10', packets: 100, bytes: 2048 }
        ]
      }
    }, bound.conversationKey);

    const built = normalizeReportInput({
      prompt: '将以上总结为报告以word的形式给我',
      format: 'word',
      sourceResult: {
        ok: true,
        mode: 'preview_download_analyze',
        criteria: {
          ips: ['101.254.114.238'],
          start: 1780880000,
          end: 1780883600
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
          endpoints: [
            { address: '203.0.113.10', packets: 100, bytes: 2048 }
          ]
        }
      }
    });

    expect(built.reportType).toBe('quick_report');
    expect(built.dataSource.sourceSkill).toBe('openclaw-napm-packet-analysis');
    expect(built.sections.some((section) => section.title === 'Top 对端')).toBe(true);

    const result = await plugin.__test__.createReportExportToolDefinition()
      .execute('report-tool-remembered-packet', bound.args);

    expect(result.details.ok).toBe(true);
    expect(fs.existsSync(result.details.filePath)).toBe(true);
  });

  test('should block export when no reportData is available', async () => {
    const result = await plugin.__test__.createReportExportToolDefinition().execute('report-tool-empty', {
      prompt: '将以上以 Word 形式导出',
      format: 'docx'
    });

    expect(result.details).toMatchObject({
      ok: false,
      errorCode: 'REPORT_DATA_NOT_FOUND'
    });
    expect(result.content[0].text).toContain('未找到可导出');
  });

  test('should not silently downgrade pdf to docx', async () => {
    const result = await plugin.__test__.createReportExportToolDefinition().execute('report-tool-pdf', {
      prompt: '将以上以 PDF 形式导出',
      format: 'pdf',
      reportData: makeReportData()
    });

    expect(result.details).toMatchObject({
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

  test('should block direct docx media for report prompt without report export result', async () => {
    const hooks = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        hooks.set(name, handler);
      }
    });

    const prompt = '将以上以 Word 形式导出';
    const ctx = {
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'report-direct',
      runId: 'run-report-direct'
    };
    hooks.get('message_received')({ content: prompt }, ctx);
    const messageSending = hooks.get('message_sending');
    const result = await messageSending({
      content: '报告已生成，现在发送给您。',
      mediaUrls: ['/home/netinside/.openclaw/media/outbound/manual-report.docx']
    }, ctx);

    expect(result.content).toContain('napm-report-export');
  });
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
