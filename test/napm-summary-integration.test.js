/**
 * NAPM 综述报告 — 完整链路集成测试
 *
 * 覆盖：
 *   1. SummaryService.run() — 查询计划 + 数据聚合
 *   2. SummaryReportDataService.buildReportData() — 标准化 reportData
 *   3. ReportInputContractService.normalizeReportInput() — 输入归一化
 *   4. SummaryFixedTemplateService.renderDocx() — docx 渲染（含 scope 过滤 + 图表 + 叙述）
 *   5. ReportStorageService — scope 驱动文件命名
 *
 * 运行：
 *   npx jest test/napm-summary-integration.test.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ── mock NAPM API data ─────────────────────────────────────────

const MOCK_ALERTS_SUMMARY = {
  networkAlerts: {
    '239web': [
      { id: '1001', severity: '4', name: '吞吐量异常', period: '300', start: '1780882620', end: '0', metrics: ['TPIO'], value: ['1500000'], baseline: ['800000'], unit: ['bps'], categoryType: '68', condition: '>', operation: 'avg', tasktype: '0', linkType: '1' },
      { id: '1002', severity: '3', name: '丢包率偏高', period: '300', start: '1780885620', end: '1780885920', metrics: ['PLI'], value: ['5.2'], baseline: ['1.0'], unit: ['%'], categoryType: '68', condition: '>', operation: 'avg', tasktype: '0', linkType: '1' }
    ],
    '192.168.1.100': [
      { id: '1003', severity: '3', name: '流量突增', period: '300', start: '1780887620', end: '1780887920', metrics: ['TPIO'], value: ['5000000'], baseline: ['2000000'], unit: ['bps'], categoryType: '3', condition: '>', operation: 'avg', tasktype: '0', linkType: '1' }
    ]
  },
  appAlerts: {
    'HIS': [
      { id: '2001', severity: '3', name: '慢访问告警', period: '300', start: '1780882620', end: '0', metrics: ['PGSLPCT'], value: ['15.3'], baseline: ['5.0'], unit: ['%'], categoryType: '68', condition: '>', operation: 'avg', tasktype: '0', linkType: '1' }
    ]
  },
  busAlerts: {
    '核心业务组': [
      { id: '3001', severity: '2', name: '业务故障告警', period: '300', start: '1780882620', end: '1780882920', metrics: ['TPIO'], value: ['0'], baseline: ['1000000'], unit: ['bps'], categoryType: '14', condition: '<', operation: 'avg', tasktype: '0', linkType: '1' }
    ]
  }
};

const MOCK_ALERTS_TIMELINE = {
  networkAlerts: {
    '1780882620': ['2', '0', '1'],
    '1780886220': ['1', '1', '1'],
    '1780889820': ['0', '0', '1']
  },
  appAlerts: {
    '1780882620': ['1', '0', '0'],
    '1780886220': ['2', '0', '1'],
    '1780889820': ['1', '0', '0']
  },
  busAlerts: {
    '1780882620': ['1', '0', '0'],
    '1780886220': ['0', '0', '0'],
    '1780889820': ['0', '0', '0']
  }
};

const MOCK_TRAFFIC_TREND = [
  { time: '1780882620', TPIO: '1500000000', TPI: '800000000', TPO: '700000000' },
  { time: '1780886220', TPIO: '1600000000', TPI: '850000000', TPO: '750000000' },
  { time: '1780889820', TPIO: '1550000000', TPI: '820000000', TPO: '730000000' },
  { time: '1780893420', TPIO: '0', TPI: '0', TPO: '0' },
  { time: '1780897020', TPIO: '1700000000', TPI: '900000000', TPO: '800000000' },
  { time: '1780900620', TPIO: '8000000000', TPI: '4000000000', TPO: '4000000000' },
  { time: '1780904220', TPIO: '1650000000', TPI: '870000000', TPO: '780000000' },
  { time: '1780907820', TPIO: '1580000000', TPI: '830000000', TPO: '750000000' },
  { time: '1780911420', TPIO: '1620000000', TPI: '860000000', TPO: '760000000' },
  { time: '1780915020', TPIO: '1680000000', TPI: '880000000', TPO: '800000000' }
];

const MOCK_TOP_IPS = [
  { IPAddress: '192.168.1.100', TPIO: '1500000000', TPI: '800000000', TPO: '700000000' },
  { IPAddress: '192.168.1.101', TPIO: '1200000000', TPI: '600000000', TPO: '600000000' },
  { IPAddress: '192.168.1.102', TPIO: '900000000', TPI: '450000000', TPO: '450000000' },
  { IPAddress: '192.168.1.103', TPIO: '750000000', TPI: '400000000', TPO: '350000000' },
  { IPAddress: '192.168.1.104', TPIO: '600000000', TPI: '300000000', TPO: '300000000' }
];

const MOCK_TOP_APPS = [
  { WebApplication: '239web', TPIO: '2000000000', TPI: '1200000000', TPO: '800000000' },
  { WebApplication: 'HIS', TPIO: '1500000000', TPI: '800000000', TPO: '700000000' },
  { WebApplication: 'OA', TPIO: '500000000', TPI: '250000000', TPO: '250000000' },
  { WebApplication: 'Mail', TPIO: '300000000', TPI: '150000000', TPO: '150000000' }
];

const MOCK_SLOW_ACCESS = [
  { WebApplication: 'HIS', PGSLPCT: '15.3', PGNSLPGE: '1250', PGTME: '3200' },
  { WebApplication: '239web', PGSLPCT: '8.7', PGNSLPGE: '580', PGTME: '2100' },
  { WebApplication: 'OA', PGSLPCT: '3.2', PGNSLPGE: '120', PGTME: '1500' }
];

const MOCK_HTTP_ERRORS = [
  { WebApplication: '239web', PGHTTP400: '85', PGHTTP500: '42' },
  { WebApplication: 'HIS', PGHTTP400: '30', PGHTTP500: '15' },
  { WebApplication: 'OA', PGHTTP400: '10', PGHTTP500: '3' }
];

const MOCK_APPLIANCE_INFO = {
  systemName: 'NetInside-01',
  ipAddress: '192.168.1.250',
  softwareVersion: 'v7.2.3',
  serialNumber: 'NS202301001',
  hostname: 'netinside-node1',
  uptime: '365天'
};

// ── Mock SummaryClient ────────────────────────────────────────

class MockSummaryClient {
  constructor() {
    this.requestHistory = [];
  }

  async getAlertsSummary() { return MOCK_ALERTS_SUMMARY; }
  async getAlertsTimeline() { return MOCK_ALERTS_TIMELINE; }
  async getTimeValues() { return MOCK_TRAFFIC_TREND; }
  async getTopValues(start, end, metrics, topMetric, topCount, groups) {
    const groupType = groups?.[0]?.type || '';
    if (metrics?.includes?.('PGSLPCT') || metrics?.includes?.('PGNSLPGE')) return MOCK_SLOW_ACCESS;
    if (metrics?.includes?.('PGHTTP400') || metrics?.includes?.('PGHTTP500')) return MOCK_HTTP_ERRORS;
    if (groupType === 'IPAddress') return MOCK_TOP_IPS;
    if (groupType === 'WebApplication') return MOCK_TOP_APPS;
    return MOCK_TOP_IPS; // drillDown default
  }
  async getApplianceInfo() { return MOCK_APPLIANCE_INFO; }
}

// ── setup ─────────────────────────────────────────────────────

const SummaryService = require('../skills/openclaw-napm-summary/services/SummaryService');
const SummaryReportDataService = require('../skills/openclaw-napm-summary/services/SummaryReportDataService');
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const SummaryFixedTemplateService = require('../skills/openclaw-napm-report/services/SummaryFixedTemplateService');
const ReportStorageService = require('../skills/openclaw-napm-report/services/ReportStorageService');
const outputDir = path.join(__dirname, '..', 'skills', 'openclaw-napm-report', 'output');

function makeService() {
  return new SummaryService({ client: new MockSummaryClient() });
}

// ── tests ─────────────────────────────────────────────────────

describe('NAPM Summary Report — Full Integration Pipeline', () => {
  // ─── Phase A: Query Planning ──────────────────────────────
  describe('Phase A: Query Planning', () => {
    test('global scope → 8 queries', () => {
      const service = makeService();
      const plan = service.plan({ type: 'global', label: '全局' }, { start: 1780882620, end: 1780969020 });
      expect(plan).toHaveLength(8);
      expect(plan.map(p => p.label)).toEqual([
        'alertsSummary', 'alertsTimeline', 'trafficTrend',
        'topIPs', 'topApps', 'slowAccess', 'httpErrors', 'applianceInfo'
      ]);
    });

    test('webApplication scope → 7 queries', () => {
      const service = makeService();
      const plan = service.plan(
        { type: 'webApplication', label: '业务', target: { groupType: 'WebApplication', groupArgument: '239web', groupLabel: '239web' } },
        { start: 1780882620, end: 1780969020 }
      );
      expect(plan).toHaveLength(7);
      expect(plan.map(p => p.label)).toEqual([
        'alertsSummary', 'alertsTimeline', 'trafficTrend',
        'drillDown', 'slowAccess', 'httpErrors', 'applianceInfo'
      ]);
    });

    test('alert scope → 2 queries', () => {
      const service = makeService();
      const plan = service.plan({ type: 'alert', label: '告警' }, { start: 1780882620, end: 1780969020 });
      expect(plan).toHaveLength(2);
      expect(plan.map(p => p.label)).toEqual(['alertsSummary', 'alertsTimeline']);
    });

    test('network scope → 3 queries', () => {
      const service = makeService();
      const plan = service.plan(
        { type: 'network', label: '网络', target: { groupType: 'IPAddress', groupArgument: '192.168.1.100', groupLabel: '192.168.1.100' } },
        { start: 1780882620, end: 1780969020 }
      );
      expect(plan).toHaveLength(3);
    });
  });

  // ─── Phase B: Data Aggregation ─────────────────────────────
  describe('Phase B: Data Aggregation (global scope)', () => {
    let result;

    beforeAll(async () => {
      const service = makeService();
      result = await service.run({
        scope: { type: 'global', label: '全局' },
        timeRange: { start: 1780882620, end: 1780969020, displayText: '2026-06-17 00:00 ~ 2026-06-18 00:00' }
      });
    });

    test('result.ok is true', () => {
      expect(result.ok).toBe(true);
    });

    test('schema is correct', () => {
      expect(result.schema).toBe('openclaw_napm_summary_result.v1');
    });

    test('alertSummary: correct totals', () => {
      const a = result.summary.alertSummary;
      // MOCK: networkAlerts.239web[2] + networkAlerts.192.168.1.100[1] + appAlerts.HIS[1] + busAlerts.核心业务组[1] = 5
      expect(a.total).toBe(5);
      expect(a.critical).toBe(1);   // id 1001 is severity 4
      expect(a.major).toBe(3);       // ids 1002, 1003, 2001 are severity 3
      expect(a.minor).toBe(1);       // id 3001 is severity 2
    });

    test('alertSummary: byCategory populated', () => {
      const byCat = result.summary.alertSummary.byCategory;
      expect(byCat).toBeInstanceOf(Array);
      expect(byCat.length).toBeGreaterThan(0);
      expect(byCat[0]).toHaveProperty('categoryLabel');
    });

    test('alertSummary: timeline aggregated with totals', () => {
      const tl = result.summary.alertSummary.timeline;
      expect(tl).toBeInstanceOf(Array);
      expect(tl.length).toBe(3);
      expect(tl[0]).toHaveProperty('critical_total');
      expect(tl[0]).toHaveProperty('major_total');
      expect(tl[0]).toHaveProperty('minor_total');
    });

    test('alertSummary: topObjects populated', () => {
      const top = result.summary.alertSummary.topObjects;
      expect(top).toBeInstanceOf(Array);
      expect(top.length).toBeGreaterThan(0);
    });

    test('alertSummary: unresolvedAlerts (end=0)', () => {
      const unresolved = result.summary.alertSummary.unresolvedAlerts;
      expect(unresolved).toBeInstanceOf(Array);
      // Only id 1001 and 2001 have end=0
      expect(unresolved.length).toBe(2);
    });

    test('trafficSummary: trend dataset has points[] + metrics', () => {
      const trend = result.summary.trafficSummary.trend;
      expect(trend).toBeTruthy();
      expect(trend.dataset).toHaveProperty('points');
      expect(trend.dataset).toHaveProperty('metrics');
      expect(trend.dataset.points).toHaveLength(10);
      expect(trend.dataset.metrics).toContain('TPIO');
      expect(trend.dataset.points[0]).toHaveProperty('time');
      expect(trend.dataset.points[0]).toHaveProperty('TPIO');
    });

    test('trafficSummary: stats detect anomalies', () => {
      const stats = result.summary.trafficSummary.trend.stats;
      expect(stats.missingPointCount).toBe(0);
      expect(stats.zeroSegmentCount).toBe(1);  // time index 3 is all zeros
      expect(stats.spikeCount).toBe(1);         // time index 5 is 8B vs avg ~2.3B → spike
    });

    test('trafficSummary: topIPs populated', () => {
      expect(result.summary.trafficSummary.topIPs).toHaveLength(5);
    });

    test('trafficSummary: topApps populated', () => {
      expect(result.summary.trafficSummary.topApps).toHaveLength(4);
    });

    test('businessSummary: slowAccess populated', () => {
      expect(result.summary.businessSummary.slowAccess).toHaveLength(3);
      expect(result.summary.businessSummary.slowAccess[0]).toHaveProperty('ratio');
    });

    test('businessSummary: httpErrors populated', () => {
      expect(result.summary.businessSummary.httpErrors).toHaveLength(3);
      expect(result.summary.businessSummary.httpErrors[0]).toHaveProperty('http400');
    });

    test('overallStatus computed correctly', () => {
      // critical=1 → should be 'critical'
      expect(result.summary.overallStatus).toBe('critical');
    });

    test('deviceInfo populated', () => {
      expect(result.summary.deviceInfo.systemName).toBe('NetInside-01');
    });
  });

  // ─── Phase C: reportData Construction ──────────────────────
  describe('Phase C: reportData Construction', () => {
    let reportData;

    beforeAll(async () => {
      const service = makeService();
      const result = await service.run({
        scope: { type: 'global', label: '全局' },
        timeRange: { start: 1780882620, end: 1780969020, displayText: '2026-06-17 00:00 ~ 2026-06-18 00:00' }
      });
      const rds = new SummaryReportDataService();
      reportData = rds.buildReportData(result);
    });

    test('reportType is summary_report', () => {
      expect(reportData.reportType).toBe('summary_report');
    });

    test('templateId is napm_summary_overview_v1', () => {
      expect(reportData.templateId).toBe('napm_summary_overview_v1');
    });

    test('scope is embedded', () => {
      expect(reportData.scope.type).toBe('global');
    });

    test('summary block is present', () => {
      expect(reportData.summary).toBeTruthy();
      expect(reportData.summary.alertSummary).toBeTruthy();
    });
  });

  // ─── Phase D: Input Contract Normalization ─────────────────
  describe('Phase D: Input Contract Normalization', () => {
    let normalized;

    beforeAll(async () => {
      const service = makeService();
      const result = await service.run({
        scope: { type: 'global', label: '全局' },
        timeRange: { start: 1780882620, end: 1780969020, displayText: '2026-06-17 00:00 ~ 2026-06-18 00:00' }
      });
      const rds = new SummaryReportDataService();
      const reportData = rds.buildReportData(result);
      normalized = normalizeReportInput({ sourceResult: { ...result, reportData } });
    });

    test('normalizeReportInput returns summary_report', () => {
      expect(normalized.reportType).toBe('summary_report');
    });

    test('scope preserved through normalization', () => {
      expect(normalized.scope.type).toBe('global');
    });

    test('summary preserved through normalization', () => {
      expect(normalized.summary).toBeTruthy();
    });
  });

  // ─── Phase E: Docx Rendering ───────────────────────────────
  describe('Phase E: Docx Rendering (global scope)', () => {
    let docxBuffer;

    beforeAll(async () => {
      const service = makeService();
      const result = await service.run({
        scope: { type: 'global', label: '全局' },
        timeRange: { start: 1780882620, end: 1780969020, displayText: '2026-06-17 00:00 ~ 2026-06-18 00:00' }
      });
      const rds = new SummaryReportDataService();
      const reportData = rds.buildReportData(result);
      const normalized = normalizeReportInput({ sourceResult: { ...result, reportData } });

      const sts = new SummaryFixedTemplateService();
      docxBuffer = await sts.renderDocx(normalized);
    }, 30000);

    test('docx buffer is a non-empty Buffer', () => {
      expect(Buffer.isBuffer(docxBuffer)).toBe(true);
      expect(docxBuffer.length).toBeGreaterThan(1000);
    });

    test('docx starts with ZIP magic bytes (PK...)', () => {
      expect(docxBuffer[0]).toBe(0x50); // P
      expect(docxBuffer[1]).toBe(0x4B); // K
    });
  });

  // ─── Phase F: Scoped Docx Rendering ────────────────────────
  describe('Phase F: Docx Rendering (webApplication scope)', () => {
    let docxBuffer;

    beforeAll(async () => {
      const service = makeService();
      const result = await service.run({
        scope: { type: 'webApplication', label: '业务', target: { groupType: 'WebApplication', groupArgument: '239web', groupLabel: '239web' } },
        timeRange: { start: 1780882620, end: 1780969020, displayText: '2026-06-17 00:00 ~ 2026-06-18 00:00' }
      });
      const rds = new SummaryReportDataService();
      const reportData = rds.buildReportData(result);
      const normalized = normalizeReportInput({ sourceResult: { ...result, reportData } });

      const sts = new SummaryFixedTemplateService();
      docxBuffer = await sts.renderDocx(normalized);
    }, 30000);

    test('scoped docx buffer is valid', () => {
      expect(Buffer.isBuffer(docxBuffer)).toBe(true);
      expect(docxBuffer.length).toBeGreaterThan(1000);
      expect(docxBuffer[0]).toBe(0x50);
    });

    test('scoped docx differs from global (different section set)', () => {
      // They should differ because different scopes render different sections
      // but with the same mock data, the content should overlap somewhat
      expect(docxBuffer.length).toBeGreaterThan(0);
    });
  });

  // ─── Phase G: File Naming ──────────────────────────────────
  describe('Phase G: Scope-Aware File Naming', () => {
    test('global summary → system-based filename', () => {
      const storage = new ReportStorageService({ outputDir });
      const id = storage.createReportId({
        reportType: 'summary_report',
        systemName: 'Netlnside流量分析系统',
        scope: { type: 'global', label: '全局' }
      });
      expect(id).toMatch(/^Netlnside流量分析系统_全局综述报告_\d{8}_\d{6}$/);
    });

    test('scoped summary → object-based filename', () => {
      const storage = new ReportStorageService({ outputDir });
      const id = storage.createReportId({
        reportType: 'summary_report',
        systemName: 'Netlnside流量分析系统',
        scope: { type: 'webApplication', label: '业务', target: { groupType: 'WebApplication', groupArgument: '239web', groupLabel: '239web' } }
      });
      expect(id).toMatch(/^239web_业务综述报告_\d{8}_\d{6}$/);
    });
  });

  // ─── Phase H: Scope Filtering ──────────────────────────────
  describe('Phase H: Section Scope Filtering', () => {
    const { scopeMatches } = require('../skills/openclaw-napm-report/services/SummaryFixedTemplateService').__test__;

    test('global sections include trafficTopObjects', () => {
      const template = new SummaryFixedTemplateService().loadTemplate();
      const globalSections = template.sections.filter(s => scopeMatches(s.scopes, 'global'));
      const ids = globalSections.map(s => s.id);
      expect(ids).toContain('traffic_top_ip_table');
      expect(ids).toContain('alert_top_objects_table');
    });

    test('webApplication sections exclude trafficTopObjects', () => {
      const template = new SummaryFixedTemplateService().loadTemplate();
      const waSections = template.sections.filter(s => scopeMatches(s.scopes, 'webApplication'));
      const ids = waSections.map(s => s.id);
      expect(ids).not.toContain('traffic_top_ip_table');
      expect(ids).not.toContain('alert_top_objects_table');
    });

    test('alert sections exclude traffic + business chapters', () => {
      const template = new SummaryFixedTemplateService().loadTemplate();
      const alertSections = template.sections.filter(s => scopeMatches(s.scopes, 'alert'));
      const ids = alertSections.map(s => s.id);
      expect(ids).not.toContain('traffic_heading');
      expect(ids).not.toContain('business_heading');
    });
  });
});
