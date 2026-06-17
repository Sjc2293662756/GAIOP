const InspectionRuleService = require('../skills/openclaw-napm-inspection/services/InspectionRuleService');
const { __test__ } = require('../skills/openclaw-napm-inspection/services/InspectionRuleService');

describe('InspectionRuleService', () => {
  test('marks performance and configuration warnings from mapped inspection values', () => {
    const service = new InspectionRuleService({
      thresholds: {
        packetDropsWarningGreaterThan: 0,
        cpuUsageWarningPercent: 85,
        diskUsageWarningPercent: 85,
        defaultBusinessGroupCount: 4
      }
    });
    const inspection = service.evaluate({
      devices: [{ systemName: 'NAPM-01', applianceTime: '2026-06-16 10:00:00' }],
      performance: {
        items: [
          { name: '丢包数', value: '3' },
          { name: '数据包重复率', value: '0%' },
          { name: '磁盘使用', value: '90/100MB' },
          { name: 'CPU使用', value: '91%' }
        ]
      },
      dataRetention: {
        latestDataTime: '2026-06-16 09:50:00',
        items: [{ name: '1分钟数据', value: '10/30天' }]
      },
      configuration: {
        items: [{ name: '业务组数量', value: '4' }]
      },
      packetStorage: {
        durationText: '2天',
        findings: []
      },
      trafficAnalysis: { status: 'ok', findings: [] },
      businessPerformance: { status: 'ok', findings: [] }
    });

    expect(inspection.performance.status).toBe('warning');
    expect(inspection.configuration.status).toBe('warning');
    expect(inspection.summary.overallStatus).toBe('warning');
    expect(inspection.summary.devices[0]).toMatchObject({
      deviceName: 'NAPM-01',
      health: '需关注',
      cpuUsage: '91%',
      packetDrops: '3'
    });
    expect(inspection.summary.abnormalItems.join('\n')).toContain('丢包数为3');
    expect(inspection.summary.abnormalItems.join('\n')).toContain('业务组数量为4');
  });

  test('keeps ok status when no rule is triggered', () => {
    const service = new InspectionRuleService();
    const result = service.evaluate({
      devices: [{ systemName: 'NAPM-02' }],
      performance: {
        items: [
          { name: '丢包数', value: '0' },
          { name: '磁盘使用', value: '10/100MB' },
          { name: 'CPU使用', value: '20%' }
        ]
      },
      dataRetention: {
        items: [{ name: '1分钟数据', value: '10/30天' }]
      },
      configuration: {
        items: [{ name: '业务组数量', value: '8' }]
      },
      packetStorage: { findings: [] },
      trafficAnalysis: { status: 'ok', findings: [] },
      businessPerformance: { status: 'ok', findings: [] }
    });

    expect(result.summary.overallStatus).toBe('ok');
    expect(result.performance.findings).toEqual(['正常。']);
  });

  test('parses helper values used by rules', () => {
    expect(__test__.toNumber('90/100MB')).toBe(90);
    expect(__test__.parseDiskUsagePercent('90/100MB')).toBe(90);
    expect(__test__.findItem({ items: [{ name: 'CPU使用', value: '90%' }] }, 'CPU').value).toBe('90%');
  });
});
