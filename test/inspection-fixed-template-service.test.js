const fs = require('fs');
const path = require('path');

const InspectionFixedTemplateService = require('../skills/openclaw-napm-report/services/InspectionFixedTemplateService');
const { __test__ } = require('../skills/openclaw-napm-report/services/InspectionFixedTemplateService');

function makeInspection(overrides = {}) {
  return {
    schema: 'openclaw_napm_inspection.v1',
    customerName: '北京烟草',
    projectName: '流量分析系统',
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
    title: '北京烟草流量分析系统健康检查报告',
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
    expect(template.sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      'traffic_narrative',
      'traffic_chart_recent_hour',
      'business_narrative',
      'business_slow_chart',
      'query_evidence'
    ]));
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
