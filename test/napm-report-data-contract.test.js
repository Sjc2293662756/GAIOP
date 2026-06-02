const { buildOpenClawReplyContract } = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');
const { buildReportData } = require('../skills/openclaw-napm-query/services/ReportDataContractService');

describe('NAPM reportData contract', () => {
  test('should build quick report data from TopN narration structure', () => {
    const output = buildOpenClawReplyContract({
      ok: true,
      prompt: '生成最近一天丢包最严重 IP 的分析报告',
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        queryModeKey: 'topn',
        start: 1779925800,
        end: 1780012200,
        groups: [{ type: 'IPAddress' }],
        metrics: ['PLI', 'PLO'],
        topMetric: 'PLI',
        topCount: 10
      },
      data: [
        {
          group: '192.0.2.10',
          object: '192.0.2.10',
          rank: 1,
          metrics: {
            PLI: {
              value: 83.37,
              unit: '%',
              label: '流入丢包率'
            }
          }
        }
      ],
      summary: {
        title: '丢包 Top 10',
        rowCount: 1
      },
      requestUrl: 'https://example.invalid/topValues'
    });

    expect(output.reportData).toMatchObject({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'quick_report',
      format: 'docx',
      defaultFormat: 'docx',
      title: '丢包 Top 10',
      sourceQuestion: '生成最近一天丢包最严重 IP 的分析报告',
      dataSource: {
        system: 'NAPM',
        queryService: 'topValues',
        objectType: 'IPAddress',
        metrics: ['PLI', 'PLO']
      }
    });
    expect(output.reportData.timeRange.start).toBe(1779925800);
    expect(output.reportData.sections.some((section) => section.type === 'table')).toBe(true);
    expect(output.reportData.sections.find((section) => section.type === 'table').rows[0][1]).toBe('192.0.2.10');
    expect(output.reportData.audit.resolvedQuery.service).toBe('topValues');
  });

  test('should build diagnostic report data from comprehensive analysis result', () => {
    const output = buildOpenClawReplyContract({
      ok: true,
      prompt: '分析今天应用整体情况并生成报告',
      service: 'overview',
      responseType: 'comprehensive_analysis',
      resolvedQuery: {
        service: 'overview',
        analysisType: 'comprehensive_analysis',
        analysisMode: 'system_analysis',
        overviewScene: 'application',
        start: 1779925800,
        end: 1780012200,
        metrics: ['TPIO', 'PGHTTP500']
      },
      overview: {
        scene: 'application',
        modules: []
      },
      summary: {
        title: '应用综合分析',
        highlights: ['今天应用侧告警较多。', '失败量靠前的应用需要关注。']
      },
      narrationStructure: {
        responseType: 'comprehensive_analysis',
        title: '应用综合分析',
        scene: 'application',
        summary: ['今天应用侧告警较多。'],
        modules: [
          {
            key: 'applicationAlertSummary',
            title: '应用告警概况',
            summary: '检测到 10 条告警',
            status: 'warning'
          }
        ]
      }
    }, {
      forwardDisplayText: true
    });

    expect(output.reportData.reportType).toBe('diagnostic_report');
    expect(output.reportData.title).toBe('应用综合分析');
    expect(output.reportData.dataSource.queryService).toBe('overview');
    expect(output.reportData.sections.some((section) => section.title === '分析模块结果')).toBe(true);
    expect(output.reportData.sections.find((section) => section.title === '分析模块结果').rows[0]).toEqual([
      '应用告警概况',
      '检测到 10 条告警',
      'warning'
    ]);
  });

  test('should not build report data for unsupported decision response type', () => {
    const reportData = buildReportData({
      service: 'security_refusal',
      responseType: 'decision_result',
      summary: {
        title: '敏感信息保护',
        displayText: '不能回答。'
      }
    });

    expect(reportData).toBeNull();
  });
});
