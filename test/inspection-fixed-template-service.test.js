const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const InspectionFixedTemplateService = require('../skills/openclaw-napm-report/services/InspectionFixedTemplateService');
const { __test__ } = require('../skills/openclaw-napm-report/services/InspectionFixedTemplateService');

function makeInspection(overrides = {}) {
  return {
    schema: 'openclaw_napm_inspection.v1',
    customerName: '北京烟草',
    projectName: '基于AI的全流量性能分析平台',
    reportDate: '2026-06-16',
    devices: [
      {
        systemName: 'NAPM-01',
        ipAddress: '192.0.2.10',
        softwareVersion: 'NetInside 4.0.9',
        serialNumber: 'SN-1',
        applianceTime: '2026-06-16 10:00:00',
        uptime: '2天'
      }
    ],
    performance: {
      status: 'ok',
      items: [{ name: 'CPU使用', value: '20%', remark: '正常' }],
      findings: [{ level: 'ok', text: 'CPU 使用正常。', evidenceRefs: ['performance.items[0]'] }]
    },
    dataRetention: {
      items: [{ name: '1分钟数据', value: '10/30天' }]
    },
    configuration: {
      items: [{ name: '业务组数量', value: '6' }]
    },
    packetStorage: {
      items: [{ name: '共计时长', value: '1小时' }]
    },
    trafficAnalysis: {
      status: 'warning',
      recentHour: {
        title: '最近1小时流量分布状况',
        queryEvidence: {
          id: 'traffic-last-hour',
          service: 'timeValues',
          groups: [{ type: 'TotalTraffic' }],
          metrics: ['TPIO', 'TPI', 'TPO'],
          granularity: 60,
          start: 100,
          end: 200,
          requestUrlRedacted: 'https://napm.test/NetInside?Password=***&type=timeValues'
        },
        dataset: {
          unit: 'Kbps',
          metrics: ['TPIO', 'TPI', 'TPO'],
          points: [
            { time: '2026-06-16 10:00:00', TPIO: 10, TPI: 4, TPO: 6 },
            { time: '2026-06-16 10:01:00', TPIO: 120, TPI: 50, TPO: 70 }
          ],
          stats: { max: 120, min: 10, avg: 65, missingPointCount: 0, zeroSegmentCount: 0, spikeCount: 1 }
        }
      },
      recentDay: {
        title: '最近1天流量分布状况',
        dataset: {
          unit: 'Kbps',
          metrics: ['TPIO', 'TPI', 'TPO'],
          points: [{ time: '2026-06-16 10:00:00', TPIO: 10, TPI: 4, TPO: 6 }],
          stats: { max: 10, min: 10, avg: 10, missingPointCount: 0, zeroSegmentCount: 0, spikeCount: 0 }
        }
      },
      findings: [{ level: 'warning', text: '最近1小时存在1个疑似尖峰。', evidenceRefs: ['trafficAnalysis.recentHour.dataset.stats'] }]
    },
    businessPerformance: {
      status: 'warning',
      queryEvidence: [
        {
          id: 'business-slow-access-top',
          service: 'topValues',
          groups: [{ type: 'WebApplication' }],
          metrics: ['PGSLPCT', 'PGNSLPGE', 'PGTME'],
          topMetric: 'PGSLPCT',
          start: 100,
          end: 200,
          requestUrlRedacted: 'https://napm.test/NetInside?Password=***&type=topValues'
        }
      ],
      slowAccess: [{ businessName: '统一认证', ratio: '12%', slowCount: 1, avgPageDelayMs: 1000, evidenceRef: 'business-slow-access-top.rows[0]' }],
      httpErrors: [{ businessName: '订单平台', http400: 3, http500: 1, evidenceRefs: ['business-http400-top.rows[0]'] }],
      findings: [{ level: 'warning', text: '统一认证出现12%慢访问。', evidenceRefs: ['business-slow-access-top.rows[0]'] }]
    },
    summary: {
      overallStatus: 'warning',
      devices: [{ deviceName: 'NAPM-01', cpuUsage: '20%', diskUsage: '100/500MB', packetDrops: '0', health: '需关注' }],
      abnormalItems: ['统一认证出现12%慢访问。'],
      conclusion: '本次巡检发现部分指标需要关注。'
    },
    ...overrides
  };
}

function makeReportData() {
  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'inspection_report',
    templateId: 'napm_traffic_health_inspection_v1',
    format: 'docx',
    title: '北京烟草基于AI的全流量性能分析平台健康检查报告',
    dataSource: {
      system: 'NAPM',
      sourceSkill: 'openclaw-napm-inspection',
      queryService: 'inspectionSnapshot'
    },
    inspection: makeInspection(),
    sections: [{ type: 'inspection', title: '巡检报告', dataPath: 'inspection' }]
  };
}

describe('InspectionFixedTemplateService', () => {
  test('loads fixed inspection template and keeps expected section ids', () => {
    const service = new InspectionFixedTemplateService();
    const template = service.loadTemplate('napm_traffic_health_inspection_v1');

    expect(template.templateId).toBe('napm_traffic_health_inspection_v1');
    expect(template.page.header.leftImage.path).toBe('templates/inspection/company-logo.png');
    expect(template.page.header.left).toBe('网深科技基于AI的全流量性能分析平台');
    expect(template.page.footer.center).toContain('{{pageNumber}}');
    expect(template.sections.find((section) => section.id === 'toc')).toBeUndefined();
    expect(template.sections.find((section) => section.id === 'toc_break')).toBeUndefined();
    expect(service.renderSection({ type: 'toc' })).toEqual([]);
    expect(service.renderSection({ id: 'toc_break', type: 'pageBreak' })).toEqual([]);
    expect(template.sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      'document_description_heading',
      'check_items_table',
      'basic_info_heading',
      'inspection_summary_heading',
      'performance_requirement',
      'traffic_narrative',
      'traffic_chart_recent_hour',
      'business_narrative',
      'business_slow_chart'
    ]));
    expect(template.sections.map((section) => section.id)).not.toContain('query_evidence');
    expect(template.sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      '1 文档说明',
      '1.1 基于AI的全流量性能分析平台检查项说明',
      '2 基本信息',
      '3 巡检信息汇总',
      '3.1 性能状况',
      '3.6 业务性能状况',
      '4 巡检总结'
    ]));
    expect(template.sections.map((section) => section.title)).not.toContain('六、巡检结果');
  });

  test('builds rule-based narration from inspection data', () => {
    const service = new InspectionFixedTemplateService();
    const context = service.buildContext(makeReportData());
    const rules = service.loadNarrativeRules();

    expect(__test__.buildNarrativeTexts(context, rules, 'traffic.summary', 'all')).toContain(
      '最近1小时总流量趋势存在 1 个疑似尖峰，建议关注对应时间点的业务突增或异常流量。'
    );
    expect(__test__.buildNarrativeTexts(context, rules, 'business.summary', 'all')[0]).toContain('统一认证');
    expect(__test__.buildNarrativeTexts(context, rules, 'summary.conclusion', 'first')).toEqual([
      '本次巡检发现部分指标需要关注。'
    ]);
  });

  test('builds fixed rows and chart slot bindings from inspection payload', () => {
    const report = makeReportData();
    const service = new InspectionFixedTemplateService();
    const context = service.buildContext(report);
    const chart = service.loadChartSpecs().charts.find((item) => item.id === 'traffic.recentHour.total');

    expect(__test__.buildTrafficStatsRows(report.inspection.trafficAnalysis)[0]).toEqual([
      '最近1小时',
      '最近1小时流量分布状况',
      2,
      120,
      10,
      65,
      0,
      0,
      1
    ]);
    expect(__test__.buildBusinessSlowRows(report.inspection.businessPerformance)[0][1]).toBe('统一认证');
    expect(__test__.buildEvidenceRows(report.inspection.businessPerformance.queryEvidence)[0][2]).toBe('topValues');
    expect(__test__.buildChartSlotRows(context, chart)).toEqual(expect.arrayContaining([
      ['数据绑定', 'inspection.trafficAnalysis.recentHour.dataset'],
      ['数据点数量', 2],
      ['单位', 'Kbps']
    ]));
  });

  test('renders docx from fixed inspection template', async () => {
    const service = new InspectionFixedTemplateService();
    const buffer = await service.renderDocx(makeReportData());

    expect(buffer.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  test('renders configured charts to PNG buffers', async () => {
    const service = new InspectionFixedTemplateService();
    const report = makeReportData();
    const template = service.loadTemplate();
    const context = service.buildContext(report);
    const chartBuffers = await service.preRenderCharts(template, context);

    expect(chartBuffers.size).toBeGreaterThan(0);
    for (const { buffer, width, height } of chartBuffers.values()) {
      expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
  });

  test('keeps missing chart values null and formats numeric timestamps in Asia/Shanghai', () => {
    const option = __test__.buildEChartsOption({
      chartType: 'line',
      datasetPath: 'traffic',
      xField: 'timestamp',
      series: [{ field: 'TPIO', name: '总流量' }]
    }, {
      timezone: 'Asia/Shanghai',
      traffic: {
        points: [
          { timestamp: 1700000000, TPIO: null },
          { timestamp: 1700000060, TPIO: 0 }
        ]
      }
    });

    expect(option.series[0].data).toEqual([null, 0]);
    expect(option.xAxis.axisLabel.formatter(1700000000)).toBe('11/15 06:13');
  });

  test('uses the chart-slot fallback when an inspection dataset is empty', async () => {
    const service = new InspectionFixedTemplateService();
    const template = service.loadTemplate();
    const context = service.buildContext({
      inspection: {
        trafficAnalysis: {
          recentHour: { dataset: { points: [] } },
          recentDay: { dataset: { points: [] } }
        },
        businessPerformance: { slowAccess: [], httpErrors: [] }
      }
    });

    const chartBuffers = await service.preRenderCharts(template, context);
    expect(chartBuffers.size).toBe(0);
  });

  test('renders configured header and footer into docx package', async () => {
    const service = new InspectionFixedTemplateService();
    const buffer = await service.renderDocx(makeReportData());
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml').async('string');
    const headerXml = await zip.file('word/header1.xml').async('string');
    const footerXml = await zip.file('word/footer1.xml').async('string');
    const settingsXml = await zip.file('word/settings.xml').async('string');
    const stylesXml = await zip.file('word/styles.xml').async('string');
    const reportXml = [documentXml, headerXml, footerXml, stylesXml].join('\n');

    expect(headerXml).toContain('网深科技基于AI的全流量性能分析平台');
    expect(headerXml).toContain('北京烟草');
    expect(footerXml).toContain('2026-06-16');
    expect(footerXml).toContain('PAGE');
    expect(footerXml).toContain('NUMPAGES');
    expect(documentXml).not.toContain('TOC \\h \\o');
    expect(settingsXml).toContain('w:updateFields');
    expect(reportXml).toContain('Microsoft YaHei');
    expect(reportXml).toContain('w:val="000000"');
    expect(reportXml).toContain('1 文档说明');
    expect(reportXml).toContain('2 基本信息');
    expect(reportXml).toContain('3.1 性能状况');
    expect(reportXml).toContain('4 巡检总结');
    expect(reportXml).not.toContain('六、巡检结果');
    for (const oldColor of ['0F766E', '334155', '111827', '374151', '64748B', '1F2937']) {
      expect(reportXml).not.toContain(`w:val="${oldColor}"`);
    }
  });

  test('embeds configured header logo when asset exists', async () => {
    const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-assets-'));
    const logoDir = path.join(assetRoot, 'templates', 'inspection');
    fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(
      path.join(logoDir, 'company-logo.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3mD2QAAAABJRU5ErkJggg==', 'base64')
    );
    const service = new InspectionFixedTemplateService({ assetRoot });
    const buffer = await service.renderDocx(makeReportData());
    const zip = await JSZip.loadAsync(buffer);
    const mediaFiles = Object.keys(zip.files).filter((fileName) => fileName.startsWith('word/media/'));
    const headerXml = await zip.file('word/header1.xml').async('string');

    expect(mediaFiles.some((fileName) => fileName.endsWith('.png'))).toBe(true);
    expect(headerXml).toContain('a:blip');
    expect(headerXml).not.toContain('<w:t xml:space="preserve">网深科技基于AI的全流量性能分析平台</w:t>');
  });

  test('template json files are valid', () => {
    const root = path.join(__dirname, '..', 'skills', 'openclaw-napm-report', 'templates', 'inspection');
    for (const fileName of [
      'napm_traffic_health_inspection_v1.json',
      'narrative-rules.v1.json',
      'chart-specs.v1.json'
    ]) {
      expect(() => JSON.parse(fs.readFileSync(path.join(root, fileName), 'utf8'))).not.toThrow();
    }
  });
});
