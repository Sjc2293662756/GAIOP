const InspectionReportDataService = require('../skills/openclaw-napm-inspection/services/InspectionReportDataService');
const { __test__ } = require('../skills/openclaw-napm-inspection/services/InspectionReportDataService');

function makeSource() {
  return {
    applianceInfo: {
      properties: [
        { key: 'hostname', value: 'NAPM-01' },
        { key: 'ipAddress', value: '192.0.2.10' },
        { key: 'SerialNumber', value: 'ARXVXA-123456' },
        { key: 'appliance_time', value: 1710003600 },
        { key: 'uptime', value: '2 days' },
        { key: 'packetPerSecond', value: '1000' },
        { key: 'connPerSecond', value: '80' },
        { key: 'ipsPerMinute', value: '33' },
        { key: 'packetDrops', value: '2' },
        { key: 'packetDupRate', value: '0' },
        { key: 'diskusage', value: '100/500' },
        { key: 'cpuUsage', value: '20' },
        { key: 'datainfo', value: 1710003600 },
        { key: '1minDataRetention', value: '10' },
        { key: '1minMaxRetention', value: '30' },
        { key: '5minDataRetention', value: '20' },
        { key: '5minMaxRetention', value: '60' },
        { key: '1hourDataRetention', value: '90' },
        { key: '1hourMaxRetention', value: '180' },
        { key: '1dayDataRetention', value: '365' },
        { key: '1dayMaxRetention', value: '365' },
        { key: 'applicationCnt', value: '12' },
        { key: 'applStandardCnt', value: '4' },
        { key: 'applServerCnt', value: '3' },
        { key: 'applWebCnt', value: '5' },
        { key: 'applUrlCnt', value: '88' },
        { key: 'busGroupCnt', value: '6' }
      ]
    },
    packetsInfo: {
      rbRange: [1710000000, 1710003600]
    },
    aboutHtml: '<span id="sysVersion">NetInside 4.0.9</span>',
    trafficAnalysis: {
      status: 'ok',
      recentHour: {
        queryEvidence: { service: 'timeValues', metrics: ['TPIO'], requestUrlRedacted: 'https://napm.test/?Password=***' },
        dataset: { points: [{ TPIO: 1 }], stats: { avg: 1 } }
      },
      findings: [{ level: 'ok', text: '最近1小时流量曲线连续。', evidenceRefs: ['trafficAnalysis.recentHour.dataset.stats'] }]
    },
    businessPerformance: {
      status: 'warning',
      queryEvidence: [
        { id: 'business-slow-access-top', service: 'topValues', metrics: ['PGSLPCT'], requestUrlRedacted: 'https://napm.test/?Password=***' }
      ],
      slowAccess: [{ businessName: '统一认证', ratio: '12%', slowCount: 1, avgPageDelayMs: 1000, evidenceRef: 'business-slow-access-top.rows[0]' }],
      httpErrors: [],
      findings: [{ level: 'warning', text: '统一认证出现12%慢访问。', evidenceRefs: ['business-slow-access-top.rows[0]'] }]
    },
    requestHistory: [
      { type: 'applianceInfo', urlRedacted: 'https://napm.test/NetInside?Password=***' }
    ]
  };
}

describe('InspectionReportDataService', () => {
  test('builds inspection result and reportData from fixture source', async () => {
    const service = new InspectionReportDataService();

    const result = await service.run({
      customerName: '北京烟草',
      reportDate: '2026-06-16',
      source: makeSource()
    });

    expect(result.ok).toBe(true);
    expect(result.schema).toBe('openclaw_napm_inspection_result.v1');
    expect(result.inspection.customerName).toBe('北京烟草');
    expect(result.inspection.summary.overallStatus).toBe('warning');
    expect(result.reportData).toMatchObject({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'inspection_report',
      templateId: 'napm_traffic_health_inspection_v1',
      dataSource: {
        sourceSkill: 'openclaw-napm-inspection',
        queryService: 'inspectionSnapshot'
      }
    });
    expect(result.reportData.sections).toEqual([
      { type: 'inspection', title: '巡检报告', dataPath: 'inspection' }
    ]);
    expect(result.reportData.audit.authMode).toBe('query_params');
    expect(result.reportData.audit.queryEvidence).toHaveLength(2);
    expect(JSON.stringify(result.reportData.audit)).toContain('Password=***');
  });

  test('collects query evidence from traffic and business sections', () => {
    const evidence = __test__.collectQueryEvidence({
      trafficAnalysis: {
        recentHour: { queryEvidence: { service: 'timeValues', id: 'hour' } },
        recentDay: { queryEvidence: { service: 'timeValues', id: 'day' } }
      },
      businessPerformance: {
        queryEvidence: [{ service: 'topValues', id: 'slow' }]
      }
    });

    expect(evidence.map((item) => item.id)).toEqual(['hour', 'day', 'slow']);
  });
});
