const InspectionFieldMapperService = require('../skills/openclaw-napm-inspection/services/InspectionFieldMapperService');
const { __test__ } = require('../skills/openclaw-napm-inspection/services/InspectionFieldMapperService');

function makeApplianceInfo() {
  return {
    address: '192.0.2.10',
    boxName: 'NAPM-01',
    mktVersion: '4.0',
    properties: [
      { key: 'hostname', value: 'NAPM-01' },
      { key: 'ipAddress', value: '192.0.2.10' },
      { key: 'SerialNumber', value: 'ARXVXA-123456' },
      { key: 'appliance_time', value: 1710000000 },
      { key: 'uptime', value: '3 days 2 hrs 1 mins' },
      { key: 'packetPerSecond', value: '1200' },
      { key: 'connPerSecond', value: '80' },
      { key: 'ipsPerMinute', value: '45' },
      { key: 'packetDrops', value: '0' },
      { key: 'packetDupRate', value: '0.1' },
      { key: 'diskusage', value: '120/500' },
      { key: 'cpuUsage', value: '22' },
      { key: 'datainfo', value: 1710000000 },
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
  };
}

describe('InspectionFieldMapperService', () => {
  test('maps appliance and packet sources into inspection sections', () => {
    const mapper = new InspectionFieldMapperService({ timezone: 'Asia/Shanghai' });
    const inspection = mapper.mapInspection({
      applianceInfo: makeApplianceInfo(),
      packetsInfo: { rbRange: [1710000000, 1710003600] },
      aboutHtml: '<span id="sysVersion">NetInside 4.0.9</span>',
      customerName: '北京烟草'
    }, {
      reportDate: '2026-06-16'
    });

    expect(inspection.customerName).toBe('北京烟草');
    expect(inspection.projectName).toBe('流量分析系统');
    expect(inspection.devices[0]).toMatchObject({
      systemName: 'NAPM-01',
      ipAddress: '192.0.2.10',
      softwareVersion: 'NetInside 4.0.9',
      serialNumber: 'NetInside NAPM 4.0-123456'
    });
    expect(inspection.performance.items.map((item) => item.name)).toContain('丢包数');
    expect(inspection.dataRetention.items.find((item) => item.name === '1分钟数据').value).toBe('10/30天');
    expect(inspection.packetStorage.durationText).toBe('1小时');
  });

  test('exposes stable formatting helpers', () => {
    expect(__test__.propertiesToMap(makeApplianceInfo()).hostname).toBe('NAPM-01');
    expect(__test__.parseSysVersion('<b id="sysVersion">v1</b>')).toBe('v1');
    expect(__test__.formatDuration(90061)).toBe('1天1小时1分钟1秒');
    expect(__test__.formatUptime('1 days 2 hrs 3 mins 4 secs')).toBe('1天2小时3分钟4秒');
  });
});
