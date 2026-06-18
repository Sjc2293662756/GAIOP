const fs = require('fs');
const os = require('os');
const path = require('path');

const ReportGenerationService = require('../skills/openclaw-napm-report/services/ReportGenerationService');
const { normalizeReportInput, buildInspectionReportData, isInspectionSourceResult } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const { __test__: templateTest } = require('../skills/openclaw-napm-report/services/ReportTemplateService');

function makeInspection() {
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
      findings: ['正常。'],
      items: [{ name: 'CPU使用', value: '20%' }]
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
      status: 'ok',
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
          metrics: ['TPIO', 'TPI', 'TPO'],
          points: [
            { time: '2026-06-16 10:00:00', TPIO: 10, TPI: 4, TPO: 6 },
            { time: '2026-06-16 10:01:00', TPIO: 12, TPI: 5, TPO: 7 }
          ],
          stats: { max: 12, min: 10, avg: 11, missingPointCount: 0, zeroSegmentCount: 0, spikeCount: 0 }
        }
      },
      findings: [{ level: 'ok', text: '最近1小时流量曲线连续。', evidenceRefs: ['trafficAnalysis.recentHour.dataset.stats'] }]
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
    }
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

describe('inspection report template', () => {
  test('generates docx for inspection_report reportData', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-inspection-report-'));
    const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

    const result = await service.generate(makeReportData());

    expect(result.ok).toBe(true);
    expect(result.reportId).toMatch(/_巡检报告_\d{8}_\d{6}$/);
    expect(result.filePath).toMatch(/\.docx$/);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath).subarray(0, 2).toString('utf8')).toBe('PK');

    const audit = JSON.parse(fs.readFileSync(result.auditPath, 'utf8'));
    expect(audit.reportType).toBe('inspection_report');
    expect(audit.inspection.summary.overallStatus).toBe('warning');
  });

  test('normalizes direct inspection input into inspection_report', () => {
    const reportData = normalizeReportInput({
      format: 'word',
      inspection: makeInspection()
    });

    expect(reportData.reportType).toBe('inspection_report');
    expect(reportData.format).toBe('docx');
    expect(reportData.sections[0]).toMatchObject({ type: 'inspection', dataPath: 'inspection' });
    expect(isInspectionSourceResult({ inspection: makeInspection() })).toBe(true);
    expect(buildInspectionReportData({ inspection: makeInspection() }).title).toContain('北京烟草');
    expect(buildInspectionReportData({ inspection: makeInspection() }).systemName).toBe('北京烟草');
  });

  test('builds table rows from inspection traffic and business data', () => {
    const inspection = makeInspection();

    expect(templateTest.statusText('warning')).toBe('需关注');
    expect(templateTest.buildTrafficStatsRows(inspection.trafficAnalysis)[0]).toEqual([
      '最近1小时',
      '最近1小时流量分布状况',
      2,
      '12',
      '10',
      '11',
      '0',
      '0',
      '0'
    ]);
    expect(templateTest.buildBusinessSlowRows(inspection.businessPerformance)[0][1]).toBe('统一认证');
    expect(templateTest.buildEvidenceRows(inspection.businessPerformance.queryEvidence)[0][2]).toBe('topValues');
  });
});
