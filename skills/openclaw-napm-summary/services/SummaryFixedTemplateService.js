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

function hasScopeTarget(scope = {}) {
  return Boolean(scope?.target?.groupType && scope?.target?.groupArgument);
}

function targetModeMatches(targetModes, scope = {}) {
  if (!targetModes) return true;
  const list = Array.isArray(targetModes) ? targetModes : [];
  if (list.length === 0) return true;
  const hasTarget = hasScopeTarget(scope);
  if (list.includes('*')) return true;
  if (list.includes('withTarget') && hasTarget) return true;
  if (list.includes('withoutTarget') && !hasTarget) return true;
  return false;
}

function sectionMatches(section = {}, context = {}) {
  return scopeMatches(section.scopes, context.scope?.type || 'global')
    && targetModeMatches(section.targetModes, context.scope || {});
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
  const scopedRules = group.filter((rule) =>
    scopeMatches(rule.scopes, scopeType)
    && targetModeMatches(rule.targetModes, context.scope || {})
  );

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
  const scopedTarget = hasScopeTarget(scope);
  const singleBusiness = summary.singleBusinessAnalysis || {};

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

  if (scopeType === 'webApplication' && scopedTarget) {
    const slowVisitCount = singleBusiness.overview?.slowVisitCount ?? 0;
    const slowVisitPct = Number(singleBusiness.overview?.slowVisitPct ?? 0);
    const http400 = singleBusiness.httpCodeSummary?.http400 ?? 0;
    const http500 = singleBusiness.httpCodeSummary?.http500 ?? 0;
    if (slowVisitCount > 0 || http400 > 0 || http500 > 0) {
      const issues = [];
      if (slowVisitCount > 0) issues.push(`慢访问 ${slowVisitCount} 次（${slowVisitPct.toFixed(2)}%）`);
      if (http400 > 0) issues.push(`HTTP 400 ${http400} 次`);
      if (http500 > 0) issues.push(`HTTP 500 ${http500} 次`);
      rows.push(['业务性能', '需关注', issues.join('，')]);
    } else {
      rows.push(['业务性能', '正常', '未发现明显慢访问或 HTTP 错误']);
    }
  } else if (scopeType === 'global' || scopeType === 'webApplication') {
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

// ── AppPro: single application row builders ────────────────────

function buildAppTargetOverview(data = {}) {
  if (!data || !Object.keys(data).length) return [['暂无数据', '-']];
  const labels = { UEII: '用户体感指数', CSTI: '连接建立时间(ms)', TRTI: '服务器响应时间(ms)', PTTO: '传输时间(ms)', RDTO: '重传时延(ms)' };
  return Object.entries(data).map(([k, v]) => [labels[k] || k, formatNumber(v)]);
}

function buildAppTargetSlowClients(data = []) {
  return asArray(data).map((row, i) => [i + 1, row.clientIp || '-', formatNumber(row.csti), formatNumber(row.trti), formatNumber(row.ptto), formatNumber(row.rdto)]);
}

function buildAppTargetExternalTraffic(data = []) {
  return asArray(data).map((row, i) => [i + 1, row.addr || '-', formatNumber(row.byti), formatNumber(row.byto)]);
}

function buildAppTargetConversations(data = []) {
  return asArray(data).map((row, i) => [i + 1, row.conv || '-', formatNumber(row.byti), formatNumber(row.byto)]);
}

function buildAppTargetInternalTraffic(data = []) {
  return asArray(data).map((row, i) => [i + 1, row.addr || '-', formatNumber(row.byti), formatNumber(row.byto)]);
}

function buildAppConnectionsRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.appName || row.key || row.keyLabel || '-',
    row.connIn != null ? String(row.connIn) : '-',
    row.connOut != null ? String(row.connOut) : '-'
  ]);
}

// ── Targeted business analysis row builders ────────────────────

function buildBusinessTargetOverview(data = {}) {
  if (!data || !Object.keys(data).length) return [['暂无数据', '-']];
  const labelMap = { PGNPGE: '访问数(个)', PGNSLPGE: '慢访问数(个)', PGSLPCT: '慢访问百分比(%)', PGSLRT: '慢访问率(个/分钟)', PGTME: '响应时间(秒)' };
  return Object.entries(data).map(([key, value]) => [labelMap[key] || key, formatNumber(value)]);
}

function buildBusinessTargetNodeDist(data = []) {
  return asArray(data).map((row, index) => [index + 1, row.nodeName || '-', row.pageViews != null ? String(row.pageViews) : '-', row.slowViews != null ? String(row.slowViews) : '-']);
}

function buildBusinessTargetResource(data = {}) {
  if (!data || !Object.keys(data).length) return [['暂无数据', '-']];
  const labelMap = { PGBYTI: '请求流量(MB)', PGSIZEI: '请求大小(KB)', PGSIZEO: '页面大小(KB)', PGBYTO: '页面流量(MB)', PGNOBJE: 'HTTP响应数(个)' };
  return Object.entries(data).map(([key, value]) => [labelMap[key] || key, formatNumber(value)]);
}

function buildBusinessTargetSlowClients(data = []) {
  return asArray(data).map((row, index) => [index + 1, row.clientIp || '-', formatNumber(row.avgDelayMs)]);
}

function buildBusinessTargetHttpCodes(data = {}) {
  if (!data || !Object.keys(data).length) return [['暂无数据', '-']];
  const labelMap = { PGHTTP100: 'HTTP 100', PGHTTP200: 'HTTP 200', PGHTTP300: 'HTTP 300', PGHTTP400: 'HTTP 400', PGHTTP500: 'HTTP 500' };
  let total = Object.values(data).reduce((s, v) => s + (Number(v) || 0), 0);
  return Object.entries(data).map(([key, value]) => {
    const pct = total > 0 ? ((Number(value) || 0) / total * 100).toFixed(1) + '%' : '-';
    return [labelMap[key] || key, value != null ? String(value) : '-', pct];
  });
}

function buildBusinessTargetHttp400(data = []) {
  return asArray(data).map((row, index) => [index + 1, row.clientIp || '-', row.errorCount != null ? String(row.errorCount) : '-']);
}

function buildBusinessTargetHttp500(data = []) {
  return asArray(data).map((row, index) => [index + 1, row.clientIp || '-', row.errorCount != null ? String(row.errorCount) : '-']);
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

function buildBusinessTargetOverviewRows(overview = {}) {
  return [
    ['访问数(个)', overview.visitCount != null ? String(overview.visitCount) : '-'],
    ['慢访问数量(个)', overview.slowVisitCount != null ? String(overview.slowVisitCount) : '-'],
    ['慢访问百分比(%)', overview.slowVisitPct != null ? Number(overview.slowVisitPct).toFixed(2) : '-'],
    ['慢访问率(个/分钟)', overview.slowVisitRate != null ? Number(overview.slowVisitRate).toFixed(2) : '-'],
    ['响应时间(秒)', overview.avgResponseTimeSec != null ? Number(overview.avgResponseTimeSec).toFixed(2) : '-']
  ];
}

function buildBusinessTargetNodeRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.nodeName || '-',
    row.visitCount != null ? String(row.visitCount) : '-',
    row.slowVisitCount != null ? String(row.slowVisitCount) : '-'
  ]);
}

function buildBusinessTargetResourceRows(resource = {}) {
  return [
    ['请求流量(MB)', resource.requestTrafficMb != null ? Number(resource.requestTrafficMb).toFixed(2) : '-'],
    ['请求大小(KB)', resource.requestSizeKb != null ? Number(resource.requestSizeKb).toFixed(2) : '-'],
    ['页面大小(KB)', resource.pageSizeKb != null ? Number(resource.pageSizeKb).toFixed(2) : '-'],
    ['页面流量(MB)', resource.responseTrafficMb != null ? Number(resource.responseTrafficMb).toFixed(2) : '-'],
    ['HTTP 响应数(个)', resource.httpResponseCount != null ? String(resource.httpResponseCount) : '-']
  ];
}

function buildBusinessTargetSlowClientRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.clientIp || '-',
    row.avgResponseTimeSec != null ? Number(row.avgResponseTimeSec).toFixed(2) : '-'
  ]);
}

function buildBusinessTargetHttpCodeRows(summary = {}) {
  return [
    ['HTTP 100', summary.http100 != null ? String(summary.http100) : '-'],
    ['HTTP 200', summary.http200 != null ? String(summary.http200) : '-'],
    ['HTTP 300', summary.http300 != null ? String(summary.http300) : '-'],
    ['HTTP 400', summary.http400 != null ? String(summary.http400) : '-'],
    ['HTTP 500', summary.http500 != null ? String(summary.http500) : '-']
  ];
}

function buildBusinessTargetHttpClientRows(data = []) {
  return asArray(data).map((row, index) => [
    index + 1,
    row.clientIp || '-',
    row.count != null ? String(row.count) : '-'
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
      case 'appTargetOverview':
        return { columns: section.columns, rows: buildAppTargetOverview(summary.trafficSummary?.appOverview || {}) };
      case 'appTargetSlowClients':
        return { columns: section.columns, rows: buildAppTargetSlowClients(summary.trafficSummary?.slowClients || []) };
      case 'appTargetExternalTraffic':
        return { columns: section.columns, rows: buildAppTargetExternalTraffic(summary.trafficSummary?.externalTraffic || []) };
      case 'appTargetConversations':
        return { columns: section.columns, rows: buildAppTargetConversations(summary.trafficSummary?.conversations || []) };
      case 'appTargetInternalTraffic':
        return { columns: section.columns, rows: buildAppTargetInternalTraffic(summary.trafficSummary?.internalTraffic || []) };
      case 'appFailures':
        return { columns: section.columns, rows: buildAppFailuresRows(summary.trafficSummary?.appFailures || []) };
      case 'appQuality':
        return { columns: section.columns, rows: buildAppQualityRows(summary.trafficSummary?.appQuality || []) };
      // ── Targeted business analysis ──────────────────────────
      case 'businessTargetOverview':
        return { columns: section.columns, rows: buildBusinessTargetOverview(summary.businessSummary?.overview || {}) };
      case 'businessTargetNodeDistribution':
        return { columns: section.columns, rows: buildBusinessTargetNodeDist(summary.businessSummary?.nodeDist || []) };
      case 'businessTargetResourceSummary':
        return { columns: section.columns, rows: buildBusinessTargetResource(summary.businessSummary?.resource || {}) };
      case 'businessTargetSlowClients':
        return { columns: section.columns, rows: buildBusinessTargetSlowClients(summary.businessSummary?.slowClients || []) };
      case 'businessTargetHttpCodeSummary':
        return { columns: section.columns, rows: buildBusinessTargetHttpCodes(summary.businessSummary?.httpCodes || {}) };
      case 'businessTargetHttp400Clients':
        return { columns: section.columns, rows: buildBusinessTargetHttp400(summary.businessSummary?.error400Clients || []) };
      case 'businessTargetHttp500Clients':
        return { columns: section.columns, rows: buildBusinessTargetHttp500(summary.businessSummary?.error500Clients || []) };
      case 'businessTargetOverview':
        return { columns: section.columns, rows: buildBusinessTargetOverviewRows(summary.singleBusinessAnalysis?.overview || {}) };
      case 'businessTargetNodeDistribution':
        return { columns: section.columns, rows: buildBusinessTargetNodeRows(summary.singleBusinessAnalysis?.nodeDistribution || []) };
      case 'businessTargetResourceSummary':
        return { columns: section.columns, rows: buildBusinessTargetResourceRows(summary.singleBusinessAnalysis?.resourceSummary || {}) };
      case 'businessTargetSlowClients':
        return { columns: section.columns, rows: buildBusinessTargetSlowClientRows(summary.singleBusinessAnalysis?.slowClients || []) };
      case 'businessTargetHttpCodeSummary':
        return { columns: section.columns, rows: buildBusinessTargetHttpCodeRows(summary.singleBusinessAnalysis?.httpCodeSummary || {}) };
      case 'businessTargetHttp400Clients':
        return { columns: section.columns, rows: buildBusinessTargetHttpClientRows(summary.singleBusinessAnalysis?.http400Clients || []) };
      case 'businessTargetHttp500Clients':
        return { columns: section.columns, rows: buildBusinessTargetHttpClientRows(summary.singleBusinessAnalysis?.http500Clients || []) };
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

  _filteredSections(template = {}, context = {}) {
    return asArray(template.sections).filter((section) => sectionMatches(section, context));
  }

  buildChildren(report = {}, chartBuffers = null) {
    const { template, context } = this.buildTemplateContext(report);
    return this._filteredSections(template, context)
      .flatMap((section) => this.renderSection(section, context, chartBuffers));
  }

  // ── pre-render charts with scope filter ─────────────────────

  async preRenderCharts(template = {}, context = {}) {
    const chartSpecs = this.loadChartSpecs();
    const chartBuffers = new Map();

    const chartSlots = asArray(template.sections)
      .filter((s) => s.type === 'chartSlot')
      .filter((s) => sectionMatches(s, context));

    for (const slot of chartSlots) {
      const chart = asArray(chartSpecs.charts).find((c) => c.id === slot.chartId) || {};
      const dataset = getByPath(context, chart.datasetPath || '');
      const dataPoints = Array.isArray(dataset)
        ? dataset.length
        : (Array.isArray(dataset?.points) ? dataset.points.length : 0);
      console.log(`[SummaryFixedTemplate] chart "${slot.id}" (${chart.chartType}): datasetPath=${chart.datasetPath}, dataPoints=${dataPoints}`);

      if (dataPoints === 0) {
        console.log(`[SummaryFixedTemplate] chart "${slot.id}" has NO DATA`);
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

    const docSection = {
      properties: buildPageProperties(template),
      children: this._filteredSections(template, context)
        .flatMap((item) => this.renderSection(item, context, this._chartBuffers))
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
  targetModeMatches,
  sectionMatches,
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
