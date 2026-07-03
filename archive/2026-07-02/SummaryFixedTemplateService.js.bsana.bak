'use strict';

const path = require('path');
const {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} = require('docx');
const InspectionFixedTemplateService = require('./InspectionFixedTemplateService');

const DEFAULT_SUMMARY_TEMPLATE_ID = 'napm_summary_overview_v1';
const DEFAULT_SUMMARY_TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'summary');

// Re-import shared utilities from the parent module's __test__ exports
const parentTest = InspectionFixedTemplateService.__test__ || {};
const asText = parentTest.asText || ((v) => String(v ?? ''));
const asArray = parentTest.asArray || ((v) => Array.isArray(v) ? v : []);
const getByPath = parentTest.getByPath || ((src, p) => { const parts = String(p||'').split('.').filter(Boolean); let c = src; for (const k of parts) { if (c == null) return undefined; c = c[k]; } return c; });
const interpolate = parentTest.interpolate || ((tpl, ctx) => String(tpl||'').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => asText(getByPath(ctx, p))));
const statusText = parentTest.statusText || ((s) => { const v = String(s||'').trim().toLowerCase(); if (v==='ok') return '正常'; if (v==='warning') return '需关注'; return v||'-'; });
const valueOrDash = parentTest.valueOrDash || ((v) => { const t = String(v??'').trim(); return t||'-'; });
const compactText = (v, max=500) => { const t = asText(v).replace(/\s+/g,' ').trim(); return t.length<=max ? t : t.slice(0,max-3)+'...'; };
const formatNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(3) : (v === undefined || v === null ? '-' : String(v)); };
const DEFAULT_FONT = parentTest.DEFAULT_FONT || 'Microsoft YaHei';
const DEFAULT_TEXT_COLOR = parentTest.DEFAULT_TEXT_COLOR || '000000';
const NAPM_STYLE = parentTest.NAPM_STYLE || {};
const buildEChartsOption = parentTest.buildEChartsOption || (() => ({}));
const renderChartPngBuffer = parentTest.renderChartPngBuffer || (async () => Buffer.alloc(0));
const buildDocumentHeader = parentTest.buildDocumentHeader || (() => undefined);
const buildDocumentFooter = parentTest.buildDocumentFooter || (() => undefined);
const buildPageProperties = parentTest.buildPageProperties || (() => ({}));
const buildDocumentStyles = parentTest.buildDocumentStyles || (() => ({}));

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// ── scope filtering ──────────────────────────────────────────────

/**
 * Check whether a section/chart/narrative-rule should render for the current scope.type.
 * - missing / null / undefined / ["*"] → always include
 * - otherwise include only if scopeType is in the array
 */
function scopeMatches(sectionScopes, scopeType) {
  if (!sectionScopes) return true;
  const list = Array.isArray(sectionScopes) ? sectionScopes : [];
  if (list.length === 0) return true;
  if (list.includes('*')) return true;
  const resolved = scopeType || 'global';
  return list.includes(resolved);
}

// ── narrative condition evaluation (with AND/OR support) ─────────

function existsValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function parseExpectedValue(raw) {
  const text = String(raw || '').trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text.replace(/^['"]|['"]$/g, '');
}

function compareValues(left, operator, right) {
  if (operator === '==' || operator === '!=') {
    const result = String(left) === String(right);
    return operator === '==' ? result : !result;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  if (operator === '>') return leftNumber > rightNumber;
  if (operator === '>=') return leftNumber >= rightNumber;
  if (operator === '<') return leftNumber < rightNumber;
  if (operator === '<=') return leftNumber <= rightNumber;
  return false;
}

function evalCondition(condition, context) {
  const text = String(condition || '').trim();
  if (!text || text === 'default') return true;

  const existsMatch = text.match(/^(.+?)\s+exists$/);
  if (existsMatch) return existsValue(getByPath(context, existsMatch[1].trim()));

  const emptyMatch = text.match(/^(.+?)\s+empty$/);
  if (emptyMatch) return !existsValue(getByPath(context, emptyMatch[1].trim()));

  const compareMatch = text.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compareMatch) {
    const left = getByPath(context, compareMatch[1].trim());
    return compareValues(left, compareMatch[2], parseExpectedValue(compareMatch[3]));
  }

  // AND
  const andParts = text.split(/\s+AND\s+/);
  if (andParts.length > 1) return andParts.every((p) => evalCondition(p.trim(), context));

  // OR
  const orParts = text.split(/\s+OR\s+/);
  if (orParts.length > 1) return orParts.some((p) => evalCondition(p.trim(), context));

  return existsValue(getByPath(context, text));
}

/**
 * Build narrative texts with scope-aware rule filtering.
 */
function buildNarrativeTexts(context = {}, rules = {}, groupId = '', mode = 'first', scopeType = 'global') {
  const group = asArray(rules.groups?.[groupId]);
  if (group.length === 0) return [];

  // Filter rules by scope
  const scopedRules = group.filter((rule) => scopeMatches(rule.scopes, scopeType));

  if (mode === 'all') {
    const matches = scopedRules
      .filter((rule) => String(rule.when || '').trim() !== 'default')
      .filter((rule) => evalCondition(rule.when, context))
      .map((rule) => interpolate(rule.text, context))
      .filter(Boolean);
    if (matches.length > 0) return matches;
  }

  const match = scopedRules.find((rule) => evalCondition(rule.when, context));
  return match ? [interpolate(match.text, context)] : [];
}

// ── summary-specific row builders ─────────────────────────────────

function buildSummaryDeviceRows(deviceInfo = {}) {
  if (!isPlainObject(deviceInfo)) return [];
  return Object.entries(deviceInfo)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => [key, compactText(value, 500)]);
}

function buildSummaryDeviceTableRows(deviceInfo = {}) {
  if (!isPlainObject(deviceInfo)) return [];
  return [[
    1,
    deviceInfo.systemName || deviceInfo.hostname || '-',
    deviceInfo.ip || deviceInfo.ipAddress || '-',
    deviceInfo.softwareVersion || '-',
    deviceInfo.serialNumber || '-',
    deviceInfo.uptime || '-'
  ]];
}

function buildHealthSummaryRows(summary = {}, scope = {}) {
  const rows = [];
  const scopeType = scope.type || 'global';

  const alertTotal = summary.alertSummary?.total ?? 0;
  const alertCritical = summary.alertSummary?.critical ?? 0;
  if (alertCritical > 0) {
    rows.push(['告警态势', '异常', `存在 ${alertCritical} 条紧急告警，共 ${alertTotal} 条告警`]);
  } else if (alertTotal > 0) {
    rows.push(['告警态势', '需关注', `共 ${alertTotal} 条告警，无紧急告警`]);
  } else {
    rows.push(['告警态势', '正常', '无告警']);
  }

  if (scopeType !== 'alert') {
    const missingPoints = summary.trafficSummary?.trend?.stats?.missingPointCount ?? 0;
    const spikeCount = summary.trafficSummary?.trend?.stats?.spikeCount ?? 0;
    if (missingPoints > 0 || spikeCount > 0) {
      const issues = [];
      if (missingPoints > 0) issues.push(`${missingPoints} 个缺失点`);
      if (spikeCount > 0) issues.push(`${spikeCount} 个尖峰`);
      rows.push(['流量状况', '需关注', issues.join('，')]);
    } else {
      rows.push(['流量状况', '正常', '流量趋势连续']);
    }
  }

  if (scopeType === 'global' || scopeType === 'webApplication') {
    const slowCount = asArray(summary.businessSummary?.slowAccess).length;
    const errorCount = asArray(summary.businessSummary?.httpErrors).length;
    if (slowCount > 0 || errorCount > 0) {
      const issues = [];
      if (slowCount > 0) issues.push(`${slowCount} 个慢访问`);
      if (errorCount > 0) issues.push(`${errorCount} 个 HTTP 错误`);
      rows.push(['业务性能', '需关注', issues.join('，')]);
    } else {
      rows.push(['业务性能', '正常', '未发现慢访问或 HTTP 错误']);
    }
  }

  const overallStatus = summary.overallStatus || 'ok';
  if (overallStatus === 'critical') rows.push(['综合评估', '异常', '存在紧急级别问题，需立即处理']);
  else if (overallStatus === 'warning') rows.push(['综合评估', '需关注', '部分指标需要关注']);
  else rows.push(['综合评估', '正常', '系统运行稳定']);

  return rows;
}

function buildAlertCategoryStatsRows(byCategory = []) {
  return asArray(byCategory).map((cat) => [
    cat.categoryLabel || cat.category || '-',
    cat.count ?? 0,
    cat.critical ?? 0,
    cat.major ?? 0,
    cat.minor ?? 0
  ]);
}

function buildAlertTopObjectRows(topObjects = []) {
  return asArray(topObjects).map((obj) => [
    obj.group || obj.groupLabel || '-',
    obj.groupType || '-',
    obj.count ?? 0,
    obj.critical ?? 0,
    obj.major ?? 0,
    obj.minor ?? 0
  ]);
}

function buildUnresolvedAlertRows(unresolvedAlerts = []) {
  return asArray(unresolvedAlerts).map((alert) => [
    alert.id || '-',
    alert.name || '-',
    alert.severityLabel || statusText(alert.severity) || '-',
    alert.categoryLabel || alert.category || '-',
    alert.group || '-',
    alert.start ? new Date(Number(alert.start) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-'
  ]);
}

function buildTrafficTopIPRows(topIPs = []) {
  return asArray(topIPs).map((row, index) => [
    index + 1,
    row.key || row.keyLabel || row.IPAddress || '-',
    formatNumber(row.TPIO),
    formatNumber(row.TPI),
    formatNumber(row.TPO)
  ]);
}

function buildTrafficTopAppRows(topApps = []) {
  return asArray(topApps).map((row, index) => [
    index + 1,
    row.key || row.keyLabel || row.WebApplication || '-',
    formatNumber(row.TPIO),
    formatNumber(row.TPI),
    formatNumber(row.TPO)
  ]);
}

function buildTrafficQualityRows(trend = {}) {
  const stats = trend.stats || {};
  const rows = [];

  if (stats.max !== undefined) {
    const status = stats.avg && stats.max > stats.avg * 2 ? '需关注' : '正常';
    rows.push(['流量峰值', formatNumber(stats.max), formatNumber(stats.avg), formatNumber(stats.max), status]);
  }
  if (stats.min !== undefined) {
    rows.push(['流量谷值', formatNumber(stats.min), formatNumber(stats.avg), '-', '正常']);
  }

  const missingPoints = stats.missingPointCount ?? 0;
  rows.push(['数据缺失点', String(missingPoints), '-', '-', missingPoints > 0 ? '需关注' : '正常']);

  const zeroSegments = stats.zeroSegmentCount ?? 0;
  rows.push(['零流量片段', String(zeroSegments), '-', '-', zeroSegments > 0 ? '需关注' : '正常']);

  const spikeCount = stats.spikeCount ?? 0;
  rows.push(['异常尖峰', String(spikeCount), '-', '-', spikeCount > 0 ? '需关注' : '正常']);

  return rows;
}

function buildBusinessPageTrafficRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.businessName || row.key || row.keyLabel || '-',
    formatNumber(row.requestBytes),
    formatNumber(row.responseBytes)
  ]);
}

function buildAppConnectionsRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.appName || row.key || row.keyLabel || '-',
    row.connIn != null ? String(row.connIn) : '-',
    row.connOut != null ? String(row.connOut) : '-'
  ]);
}

function buildAppQualityRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.appName || row.key || row.keyLabel || '-',
    row.lossIn != null ? row.lossIn.toFixed(2) : '-',
    row.lossOut != null ? row.lossOut.toFixed(2) : '-',
    row.rttIn != null ? row.rttIn.toFixed(2) : '-',
    row.rttOut != null ? row.rttOut.toFixed(2) : '-'
  ]);
}

function buildAppFailuresRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.appName || row.key || row.keyLabel || '-',
    row.failOut != null ? String(row.failOut) : '-',
    row.failIn != null ? String(row.failIn) : '-'
  ]);
}

function buildBusinessPageViewsRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.businessName || row.key || row.keyLabel || '-',
    row.pageViews != null ? String(row.pageViews) : '-'
  ]);
}

function buildTrafficDrillDownRows(drillDown = {}) {
  return asArray(drillDown.items).map((row, index) => [
    index + 1,
    row.key || row.keyLabel || row.IPAddress || row.WebApplication || '-',
    formatNumber(row.TPIO),
    formatNumber(row.TPI),
    formatNumber(row.TPO)
  ]);
}

// ── SummaryFixedTemplateService ───────────────────────────────────

class SummaryFixedTemplateService extends InspectionFixedTemplateService {
  constructor(options = {}) {
    super({
      templateRoot: options.templateRoot || DEFAULT_SUMMARY_TEMPLATE_ROOT,
      templateId: options.templateId || DEFAULT_SUMMARY_TEMPLATE_ID,
      assetRoot: options.assetRoot
    });
    this.templateRoot = options.templateRoot || DEFAULT_SUMMARY_TEMPLATE_ROOT;
    this.defaultTemplateId = options.templateId || DEFAULT_SUMMARY_TEMPLATE_ID;
    this.assetRoot = options.assetRoot || path.join(__dirname, '..');
    // narrativeRules / chartSpecs loaded lazily from templateRoot by parent
  }

  // ── context ─────────────────────────────────────────────────

  buildContext(report = {}) {
    const summary = report.summary || {};
    return {
      ...report,
      report,
      summary,
      scope: report.scope || { type: 'global', label: '全局' },
      timeRange: report.timeRange || {},
      audit: report.audit || {}
    };
  }

  getScopeType(report = {}) {
    return (report.scope || {}).type || 'global';
  }

  // ── row builders (extended) ─────────────────────────────────

  buildRowsForSection(section = {}, context = {}) {
    const summary = context.summary || {};
    const builder = section.rowBuilder;

    switch (builder) {
      case 'summaryDeviceInfo':
        return { columns: section.columns, rows: buildSummaryDeviceRows(summary.deviceInfo) };
      case 'summaryDeviceTable':
        return { columns: section.columns, rows: buildSummaryDeviceTableRows(summary.deviceInfo) };
      case 'healthSummary':
        return { columns: section.columns, rows: buildHealthSummaryRows(summary, context.scope || {}) };
      case 'alertCategoryStats':
        return { columns: section.columns, rows: buildAlertCategoryStatsRows(summary.alertSummary?.byCategory) };
      case 'alertTopObjects':
        return { columns: section.columns, rows: buildAlertTopObjectRows(summary.alertSummary?.topObjects) };
      case 'unresolvedAlerts':
        return { columns: section.columns, rows: buildUnresolvedAlertRows(summary.alertSummary?.unresolvedAlerts) };
      case 'trafficTopIPs':
        return { columns: section.columns, rows: buildTrafficTopIPRows(summary.trafficSummary?.topIPs) };
      case 'trafficTopApps':
        return { columns: section.columns, rows: buildTrafficTopAppRows(summary.trafficSummary?.topApps) };
      case 'trafficQualityMetrics':
        return { columns: section.columns, rows: buildTrafficQualityRows(summary.trafficSummary?.trend || {}) };
      case 'trafficDrillDown':
        return { columns: section.columns, rows: buildTrafficDrillDownRows(summary.trafficSummary?.drillDown || {}) };
      case 'businessPageTraffic':
        return { columns: section.columns, rows: buildBusinessPageTrafficRows(summary.businessSummary?.pageTraffic || []) };
      case 'businessPageViews':
        return { columns: section.columns, rows: buildBusinessPageViewsRows(summary.businessSummary?.pageViews || []) };
      case 'appConnections':
        return { columns: section.columns, rows: buildAppConnectionsRows(summary.trafficSummary?.appConnections || []) };
      case 'appFailures':
        return { columns: section.columns, rows: buildAppFailuresRows(summary.trafficSummary?.appFailures || []) };
      case 'appQuality':
        return { columns: section.columns, rows: buildAppQualityRows(summary.trafficSummary?.appQuality || []) };
      default:
        // Fallback to parent for shared builders (evidence, etc.)
        return super.buildRowsForSection(section, context);
    }
  }

  // ── scope-aware narrative ──────────────────────────────────

  renderNarrative(section = {}, context = {}) {
    const rules = this.loadNarrativeRules();
    const scopeType = context.scope?.type || 'global';
    const texts = buildNarrativeTexts(context, rules, section.ruleGroup, section.mode || 'first', scopeType);

    const children = [];
    if (section.title) {
      const level = Number(section.level) || 2;
      children.push(new Paragraph({
        heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        spacing: { before: level === 1 ? 240 : 160, after: 120 },
        children: [
          new TextRun({
            text: asText(section.title),
            bold: true,
            size: level === 1 ? 28 : 24,
            color: DEFAULT_TEXT_COLOR,
            font: DEFAULT_FONT
          })
        ]
      }));
    }
    for (const text of texts.length > 0 ? texts : ['-']) {
      children.push(new Paragraph({
        spacing: { after: 100 },
        children: [
          new TextRun({
            text: asText(text),
            size: 21,
            color: DEFAULT_TEXT_COLOR,
            font: DEFAULT_FONT
          })
        ]
      }));
    }
    return children;
  }

  // ── scope filtering for sections ────────────────────────────

  buildChildren(report = {}, chartBuffers = null) {
    const { template, context } = this.buildTemplateContext(report);
    const scopeType = this.getScopeType(report);

    const filteredSections = asArray(template.sections).filter((section) =>
      scopeMatches(section.scopes, scopeType)
    );

    return filteredSections.flatMap((section) => this.renderSection(section, context, chartBuffers));
  }

  // ── pre-render charts with scope filter ─────────────────────

  async preRenderCharts(template = {}, context = {}) {
    const chartSpecs = this.loadChartSpecs();
    const scopeType = context.scope?.type || 'global';
    const chartBuffers = new Map();

    const chartSlots = asArray(template.sections)
      .filter((s) => s.type === 'chartSlot')
      .filter((s) => scopeMatches(s.scopes, scopeType));

    for (const slot of chartSlots) {
      const chart = asArray(chartSpecs.charts).find((c) => c.id === slot.chartId) || {};
      const dataset = getByPath(context, chart.datasetPath || '');
      const dataPoints = Array.isArray(dataset)
        ? dataset.length
        : (Array.isArray(dataset?.points) ? dataset.points.length : 0);
      console.error(`[SummaryFixedTemplate] chart "${slot.id}" (${chart.chartType}): datasetPath=${chart.datasetPath}, dataPoints=${dataPoints}`);

      if (dataPoints === 0) {
        console.error(`[SummaryFixedTemplate] chart "${slot.id}" has NO DATA`);
        continue;
      }

      try {
        const option = buildEChartsOption(chart, context);
        const width = Number(slot.width) || NAPM_STYLE.chartWidth || 620;
        const height = Number(slot.height) || NAPM_STYLE.chartHeight || 360;
        const buffer = await renderChartPngBuffer(option, width, height);
        chartBuffers.set(slot.id, { buffer, width, height });
      } catch (err) {
        console.error(`[SummaryFixedTemplate] Failed to render chart "${slot.id}":`, err.message);
      }
    }

    return chartBuffers;
  }

  // ── main render entry ───────────────────────────────────────

  async renderDocx(report = {}) {
    const { template, context } = this.buildTemplateContext(report);

    // Pre-render charts with scope filtering
    this._chartBuffers = await this.preRenderCharts(template, context);

    const header = buildDocumentHeader(template, context, { assetRoot: this.assetRoot });
    const footer = buildDocumentFooter(template, context, { assetRoot: this.assetRoot });

    // Filter sections by scope and render
    const scopeType = this.getScopeType(report);
    const filteredSections = asArray(template.sections).filter((section) =>
      scopeMatches(section.scopes, scopeType)
    );

    const docSection = {
      properties: buildPageProperties(template),
      children: filteredSections.flatMap((item) => this.renderSection(item, context, this._chartBuffers))
    };

    if (header) docSection.headers = { default: header };
    if (footer) docSection.footers = { default: footer };

    const doc = new Document({
      creator: 'openclaw-napm-report',
      title: asText(report.title || 'NAPM 综述报告'),
      description: 'Generated by OpenClaw NAPM report summary template',
      features: { updateFields: true },
      styles: buildDocumentStyles(),
      sections: [docSection]
    });

    return Packer.toBuffer(doc);
  }
}

module.exports = SummaryFixedTemplateService;

// Export internal helpers for testing
module.exports.__test__ = {
  scopeMatches,
  buildNarrativeTexts,
  evalCondition,
  buildSummaryDeviceRows,
  buildSummaryDeviceTableRows,
  buildHealthSummaryRows,
  buildAlertCategoryStatsRows,
  buildAlertTopObjectRows,
  buildUnresolvedAlertRows,
  buildTrafficTopIPRows,
  buildTrafficTopAppRows,
  buildTrafficQualityRows,
  buildBusinessPageTrafficRows,
  buildBusinessPageViewsRows,
  buildTrafficDrillDownRows
};
