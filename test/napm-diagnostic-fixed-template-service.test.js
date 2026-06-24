const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const DiagnosticFixedTemplateService = require('../skills/openclaw-napm-report/services/DiagnosticFixedTemplateService');
const { __test__ } = require('../skills/openclaw-napm-report/services/DiagnosticFixedTemplateService');

// ── helpers ─────────────────────────────────────────────────────────

function makeFaultReport(overrides = {}) {
  return {
    reportType: 'diagnostic_report',
    templateId: 'napm_fault_diagnosis_v1',
    format: 'docx',
    title: '测试故障_故障分析报告',
    systemName: 'Netlnside测试系统',
    faultName: '核心交换机端口故障',
    timeRange: {
      start: 1780000000,
      end: 1780007200,
      displayText: '2026-06-20 14:00 ~ 16:00'
    },
    fault: {
      description: '核心交换机G0/1端口突发流量中断，降幅71%',
      affectedObjects: ['10.1.1.0/24', 'web-app-01'],
      severity: 'critical',
      timeline: [
        { time: '14:05', event: '流量开始下降', type: 'trigger' },
        { time: '14:08', event: '告警触发', type: 'alert' },
        { time: '14:15', event: '业务慢访问激增', type: 'impact' }
      ],
      recommendations: ['更换故障光模块', '加强监控'],
      prevention: ['定期巡检光模块']
    },
    alertAnalysis: {
      overallStatus: 'critical',
      summary: {
        total: 12,
        critical: 3,
        major: 5,
        minor: 4,
        byCategory: [
          { category: 'networkIssueAlerts', categoryLabel: '网络异常告警', total: 7, critical: 3, major: 3, minor: 1 },
          { category: 'appAlerts', categoryLabel: '应用性能告警', total: 3, critical: 0, major: 1, minor: 2 }
        ],
        topObjects: [
          { group: '10.1.1.1', groupType: 'IPAddress', total: 5, critical: 2, major: 2, minor: 1 }
        ],
        unresolvedAlerts: [
          { id: 'evt-001', name: '端口流量突降>50%', severity: 4, categoryLabel: '网络异常告警', group: '10.1.1.1', start: 1780000400 },
          { id: 'evt-002', name: '应用响应时间>3s', severity: 2, categoryLabel: '应用性能告警', group: 'web-app-01', start: 1780001100 }
        ]
      },
      timeline: [
        { bucketStart: 1780000000, critical_total: 0, major_total: 1, minor_total: 1 },
        { bucketStart: 1780000300, critical_total: 1, major_total: 2, minor_total: 0 },
        { bucketStart: 1780000600, critical_total: 1, major_total: 1, minor_total: 0 },
        { bucketStart: 1780000900, critical_total: 1, major_total: 0, minor_total: 1 }
      ]
    },
    trafficAnalysis: {
      trend: {
        dataset: {
          unit: 'kb/s',
          metrics: ['TPIO', 'TPI', 'TPO'],
          points: [
            { time: '14:00', TPIO: 1200000, TPI: 750000, TPO: 450000 },
            { time: '14:05', TPIO: 350000, TPI: 200000, TPO: 150000 },
            { time: '14:10', TPIO: 320000, TPI: 180000, TPO: 140000 },
            { time: '15:30', TPIO: 1150000, TPI: 720000, TPO: 430000 }
          ],
          stats: { max: 1200000, min: 320000, avg: 700000, missingPointCount: 2, zeroSegmentCount: 0, spikeCount: 1 }
        }
      },
      topIPs: [
        { key: '10.1.1.100', TPIO: 450000, TPI: 280000, TPO: 170000 },
        { key: '10.1.1.101', TPIO: 320000, TPI: 200000, TPO: 120000 }
      ],
      anomalies: [
        { time: '14:05', metric: 'TPIO', description: '流量骤降71%', severity: 'critical' },
        { time: '14:05-15:30', metric: 'TPIO', description: '持续85分钟低流量', severity: 'major' }
      ]
    },
    businessAnalysis: {
      slowAccess: [
        { businessName: 'web-app-01/login', slowCount: 230, ratio: '15.3%', avgPageDelayMs: 3200 }
      ],
      httpErrors: [
        { businessName: 'web-app-01/api', http400: 45, http500: 120 }
      ]
    },
    packetAnalysis: {
      protocolHierarchy: [
        { protocol: 'TCP', frames: 45000, bytes: 38000000 }
      ],
      endpoints: [
        { address: '10.1.1.100', packets: 25000, bytes: 22000000 }
      ],
      conversations: [
        { source: '10.1.1.100', destination: '10.1.2.50', packets: 15000, bytes: 12000000 }
      ],
      highlights: ['TCP重传率高达23%', 'TLS握手失败率8%']
    },
    audit: { sourceSkill: 'openclaw-napm-fault-diagnosis' },
    ...overrides
  };
}

// ── condition evaluation ────────────────────────────────────────────

describe('evalCondition (AND/OR support)', () => {
  test('default / empty string', () => {
    expect(__test__.evalCondition('', {})).toBe(true);
    expect(__test__.evalCondition('default', {})).toBe(true);
  });

  test('exists', () => {
    expect(__test__.evalCondition('packetAnalysis exists', { packetAnalysis: { highlights: [] } })).toBe(true);
    expect(__test__.evalCondition('packetAnalysis exists', { packetAnalysis: null })).toBe(false);
    expect(__test__.evalCondition('packetAnalysis exists', {})).toBe(false);
  });

  test('empty', () => {
    expect(__test__.evalCondition('emptyArr empty', { emptyArr: [] })).toBe(true);
    expect(__test__.evalCondition('nonEmpty empty', { nonEmpty: [1] })).toBe(false);
  });

  test('comparison operators', () => {
    const ctx = { count: 5, status: 'critical', flag: true };
    expect(__test__.evalCondition('count > 3', ctx)).toBe(true);
    expect(__test__.evalCondition('count >= 5', ctx)).toBe(true);
    expect(__test__.evalCondition('count < 3', ctx)).toBe(false);
    expect(__test__.evalCondition('count == 5', ctx)).toBe(true);
    expect(__test__.evalCondition('count != 3', ctx)).toBe(true);
    expect(__test__.evalCondition('status == critical', ctx)).toBe(true);
    expect(__test__.evalCondition('flag == true', ctx)).toBe(true);
  });

  test('AND', () => {
    const ctx = { a: 5, b: [1, 2] };
    expect(__test__.evalCondition('a > 3 AND b.length > 0', ctx)).toBe(true);
    expect(__test__.evalCondition('a > 3 AND b.length > 10', ctx)).toBe(false);
  });

  test('OR', () => {
    const ctx = { a: 1, b: [1, 2] };
    expect(__test__.evalCondition('a > 3 OR b.length > 0', ctx)).toBe(true);
    expect(__test__.evalCondition('a > 3 OR b.length > 10', ctx)).toBe(false);
  });

  test('plain path (truthy)', () => {
    expect(__test__.evalCondition('fault.severity', { fault: { severity: 'critical' } })).toBe(true);
    expect(__test__.evalCondition('nope', {})).toBe(false);
  });
});

// ── section condition matching ──────────────────────────────────────

describe('sectionConditionMatches', () => {
  test('no condition → always visible', () => {
    expect(__test__.sectionConditionMatches({}, {})).toBe(true);
    expect(__test__.sectionConditionMatches({ condition: '' }, {})).toBe(true);
  });

  test('exists condition', () => {
    expect(__test__.sectionConditionMatches(
      { condition: 'packetAnalysis exists' },
      { packetAnalysis: { highlights: ['a'] } }
    )).toBe(true);

    expect(__test__.sectionConditionMatches(
      { condition: 'packetAnalysis exists' },
      {}
    )).toBe(false);
  });

  test('length condition', () => {
    expect(__test__.sectionConditionMatches(
      { condition: 'fault.timeline.length > 0' },
      { fault: { timeline: [{ event: 'x' }] } }
    )).toBe(true);

    expect(__test__.sectionConditionMatches(
      { condition: 'fault.timeline.length > 0' },
      { fault: { timeline: [] } }
    )).toBe(false);
  });
});

// ── row builders ────────────────────────────────────────────────────

describe('row builders', () => {
  test('faultBasicInfo', () => {
    const report = makeFaultReport();
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rows = __test__.buildFaultBasicInfoRows(ctx);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0][0]).toBe('故障名称');
    expect(rows[0][1]).toContain('核心交换机');
  });

  test('faultTimeline', () => {
    const rows = __test__.buildFaultTimelineRows([
      { time: '14:05', event: '流量下降', type: 'trigger' }
    ]);
    expect(rows[0]).toEqual(['14:05', '流量下降', '触发']);
  });

  test('healthSummary — critical status', () => {
    const report = makeFaultReport();
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rows = __test__.buildHealthSummaryRows(ctx);
    // Should have at least: alert, traffic, business, packet, overall
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const overallRow = rows.find(r => r[0] === '综合评估');
    expect(overallRow[1]).toBe('异常');
  });

  test('healthSummary — ok status', () => {
    const report = makeFaultReport();
    report.alertAnalysis.overallStatus = 'ok';
    report.alertAnalysis.summary.critical = 0;
    report.alertAnalysis.summary.total = 0;
    report.trafficAnalysis.anomalies = [];
    report.trafficAnalysis.trend.dataset.stats = { max: 0, min: 0, avg: 0, missingPointCount: 0, zeroSegmentCount: 0, spikeCount: 0 };
    report.businessAnalysis.slowAccess = [];
    report.businessAnalysis.httpErrors = [];
    report.packetAnalysis = null;

    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rows = __test__.buildHealthSummaryRows(ctx);
    expect(rows.every(r => r[1] === '正常')).toBe(true);
  });

  test('alertCategoryStats', () => {
    const summary = makeFaultReport().alertAnalysis.summary;
    const rows = __test__.buildAlertCategoryStatsRows(summary);
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe('网络异常告警');
    expect(rows[0][2]).toBe(3); // critical
  });

  test('alertDetails', () => {
    const summary = makeFaultReport().alertAnalysis.summary;
    const rows = __test__.buildAlertDetailsRows(summary);
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe('evt-001');
  });

  test('trafficAnomalies', () => {
    const rows = __test__.buildTrafficAnomaliesRows(makeFaultReport().trafficAnalysis.anomalies);
    expect(rows.length).toBe(2);
    expect(rows[0][3]).toBe('critical');
  });

  test('trafficTopIPs', () => {
    const rows = __test__.buildTrafficTopIPsRows(makeFaultReport().trafficAnalysis.topIPs);
    expect(rows.length).toBe(2);
    expect(rows[0][1]).toBe('10.1.1.100');
  });

  test('businessSlowTable', () => {
    const rows = __test__.buildBusinessSlowTableRows(makeFaultReport().businessAnalysis.slowAccess);
    expect(rows.length).toBe(1);
    expect(rows[0][1]).toBe('web-app-01/login');
  });

  test('businessErrorTable', () => {
    const rows = __test__.buildBusinessErrorTableRows(makeFaultReport().businessAnalysis.httpErrors);
    expect(rows.length).toBe(1);
    expect(rows[0][2]).toBe(45);
    expect(rows[0][3]).toBe(120);
  });

  test('packetProtocol', () => {
    const rows = __test__.buildPacketProtocolRows(makeFaultReport().packetAnalysis.protocolHierarchy);
    expect(rows.length).toBe(1);
  });

  test('packetEndpoints', () => {
    const rows = __test__.buildPacketEndpointsRows(makeFaultReport().packetAnalysis.endpoints);
    expect(rows.length).toBe(1);
  });

  test('packetConversations', () => {
    const rows = __test__.buildPacketConversationsRows(makeFaultReport().packetAnalysis.conversations);
    expect(rows.length).toBe(1);
  });
});

// ── narrative rules ─────────────────────────────────────────────────

describe('narrative rules', () => {
  test('fault.overview — critical severity', () => {
    const report = makeFaultReport();
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rules = service.loadNarrativeRules();
    const texts = __test__.buildNarrativeTexts(ctx, rules, 'fault.overview', 'first');
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain('严重故障');
    expect(texts[0]).toContain('核心交换机');
  });

  test('fault.overview — minor severity', () => {
    const report = makeFaultReport({ fault: { ...makeFaultReport().fault, severity: 'minor' } });
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rules = service.loadNarrativeRules();
    const texts = __test__.buildNarrativeTexts(ctx, rules, 'fault.overview', 'first');
    expect(texts[0]).toContain('轻微故障');
  });

  test('alert.conclusion — critical > 0', () => {
    const report = makeFaultReport();
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rules = service.loadNarrativeRules();
    const texts = __test__.buildNarrativeTexts(ctx, rules, 'alert.conclusion', 'first');
    expect(texts[0]).toContain('紧急告警');
  });

  test('traffic.conclusion — anomalies + critical', () => {
    const report = makeFaultReport();
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rules = service.loadNarrativeRules();
    const texts = __test__.buildNarrativeTexts(ctx, rules, 'traffic.conclusion', 'first');
    expect(texts[0]).toContain('14:05');
  });

  test('root_cause — critical > 3 AND anomalies exist', () => {
    const report = makeFaultReport();
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rules = service.loadNarrativeRules();
    const texts = __test__.buildNarrativeTexts(ctx, rules, 'root_cause', 'first');
    expect(texts[0]).toContain('综合判断');
  });

  test('packet.conclusion — no packet data → default', () => {
    const report = makeFaultReport();
    report.packetAnalysis = null;
    const service = new DiagnosticFixedTemplateService();
    const ctx = service.buildContext(report);
    const rules = service.loadNarrativeRules();
    const texts = __test__.buildNarrativeTexts(ctx, rules, 'packet.conclusion', 'first');
    expect(texts[0]).toContain('未包含数据包');
  });

  test('narrative variable interpolation', () => {
    // Direct test of interpolate via __test__
    const texts = __test__.buildNarrativeTexts(
      { fault: { description: '端口故障', severity: 'critical', affectedObjects: ['A'] } },
      { groups: { 'fault.overview': [{ when: 'fault.severity == critical', text: '故障：{{fault.description}}，对象：{{fault.affectedObjects}}' }] } },
      'fault.overview',
      'first'
    );
    expect(texts[0]).toBe('故障：端口故障，对象：["A"]');
  });
});

// ── docx generation (integration) ───────────────────────────────────

describe('DiagnosticFixedTemplateService renderDocx', () => {
  let outputDir;
  let service;

  beforeEach(() => {
    outputDir = path.join(os.tmpdir(), `napm-diagnostic-test-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });
    const DiagnosticFixedTemplateService = require('../skills/openclaw-napm-report/services/DiagnosticFixedTemplateService');
    service = new DiagnosticFixedTemplateService();
  });

  afterEach(() => {
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('renders full report with packet analysis → all 6 chapters', async () => {
    const report = makeFaultReport();
    const buffer = await service.renderDocx(report);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(10000);

    // Verify it's a valid zip (docx)
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('word/document.xml')).toBeTruthy();

    const docXml = await zip.file('word/document.xml').async('string');

    // Chapter headings
    expect(docXml).toContain('1 故障概述');
    expect(docXml).toContain('2 告警关联分析');
    expect(docXml).toContain('3 流量异常分析');
    expect(docXml).toContain('4 业务性能影响');
    expect(docXml).toContain('5 数据包深度分析');
    expect(docXml).toContain('6 根因分析与建议');

    // Key tables present
    expect(docXml).toContain('TCP重传率高达23%');  // packet highlights
    expect(docXml).toContain('紧急告警');           // narrative text
  });

  test('renders report WITHOUT packet analysis → chapter 5 hidden', async () => {
    const report = makeFaultReport();
    report.packetAnalysis = null;

    const buffer = await service.renderDocx(report);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml').async('string');

    expect(docXml).not.toContain('5 数据包深度分析');
    // Chapter 5 should be the conclusion now
    expect(docXml).toContain('6 根因分析与建议');
  });

  test('renders report without timeline → 1.2 hidden', async () => {
    const report = makeFaultReport();
    report.fault.timeline = [];

    const buffer = await service.renderDocx(report);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml').async('string');

    expect(docXml).not.toContain('1.2 故障时间线');
  });

  test('renders with minimal data (no anomalies, no topIPs)', async () => {
    const report = makeFaultReport();
    report.trafficAnalysis.anomalies = [];
    report.trafficAnalysis.topIPs = [];
    report.businessAnalysis.slowAccess = [];
    report.businessAnalysis.httpErrors = [];
    report.packetAnalysis = null;

    const buffer = await service.renderDocx(report);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(5000);
  });
});

// ── severityLabel ───────────────────────────────────────────────────

describe('severityLabel', () => {
  test('maps numeric severity', () => {
    expect(__test__.severityLabel(4)).toBe('紧急');
    expect(__test__.severityLabel(3)).toBe('重大');
    expect(__test__.severityLabel(2)).toBe('轻微');
    expect(__test__.severityLabel(99)).toBe('99');
  });
});
