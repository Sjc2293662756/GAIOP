'use strict';

const path = require('path');
const {
  Document,
  Packer
} = require('docx');
const InspectionFixedTemplateService = require('./InspectionFixedTemplateService');

const DEFAULT_DIAGNOSTIC_TEMPLATE_ID = 'napm_fault_diagnosis_v1';
const DEFAULT_DIAGNOSTIC_TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'diagnostic');

// Re-import shared utilities from the parent module's __test__ exports
const parentTest = InspectionFixedTemplateService.__test__ || {};
const asText = parentTest.asText || ((v) => String(v ?? ''));
const asArray = parentTest.asArray || ((v) => Array.isArray(v) ? v : []);
const getByPath = parentTest.getByPath || ((src, p) => {
  const parts = String(p || '').split('.').filter(Boolean);
  let c = src;
  for (const k of parts) { if (c == null) return undefined; c = c[k]; }
  return c;
});
const interpolate = parentTest.interpolate || ((tpl, ctx) =>
  String(tpl || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => asText(getByPath(ctx, p)))
);
const statusText = parentTest.statusText || ((s) => {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'ok') return '正常';
  if (v === 'warning') return '需关注';
  return v || '-';
});
const valueOrDash = (v) => { const t = String(v ?? '').trim(); return t || '-'; };
const compactText = (v, max = 500) => {
  const t = asText(v).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 3) + '...';
};
const severityLabel = (v) => {
  const n = Number(v);
  if (n === 4) return '紧急';
  if (n === 3) return '重大';
  if (n === 2) return '轻微';
  return String(v ?? '-');
};
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

// ── condition evaluation (with AND/OR support) ─────────────────────

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

  // AND/OR must be checked BEFORE simple comparison —
  // otherwise the compare regex `.+$` greedily eats the AND/OR clause.
  const andParts = text.split(/\s+AND\s+/);
  if (andParts.length > 1) return andParts.every((p) => evalCondition(p.trim(), context));

  const orParts = text.split(/\s+OR\s+/);
  if (orParts.length > 1) return orParts.some((p) => evalCondition(p.trim(), context));

  const compareMatch = text.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compareMatch) {
    const left = getByPath(context, compareMatch[1].trim());
    return compareValues(left, compareMatch[2], parseExpectedValue(compareMatch[3]));
  }

  return existsValue(getByPath(context, text));
}

// ── section condition filtering ─────────────────────────────────────

/**
 * Check whether a section should render based on its `condition` field.
 * If no condition is set, always renders. Otherwise evaluates the condition.
 */
function sectionConditionMatches(section = {}, context = {}) {
  const condition = String(section.condition || '').trim();
  if (!condition) return true;
  return evalCondition(condition, context);
}

// ── narrative (AND/OR-aware) ────────────────────────────────────────

function buildNarrativeTexts(context = {}, rules = {}, groupId = '', mode = 'first') {
  const group = asArray(rules.groups?.[groupId]);
  if (group.length === 0) return [];

  if (mode === 'all') {
    const matches = group
      .filter((rule) => String(rule.when || '').trim() !== 'default')
      .filter((rule) => evalCondition(rule.when, context))
      .map((rule) => interpolate(rule.text, context))
      .filter(Boolean);
    if (matches.length > 0) return matches;
  }

  const match = group.find((rule) => evalCondition(rule.when, context));
  return match ? [interpolate(match.text, context)] : [];
}

// ── diagnostic-specific row builders ────────────────────────────────

function buildFaultBasicInfoRows(context = {}) {
  const fault = context.fault || {};
  const timeRange = context.timeRange || {};
  const rows = [];

  rows.push(['故障名称', compactText(fault.description || context.faultName || '-')]);
  rows.push(['严重级别', severityLabel(fault.severity)]);

  if (Array.isArray(fault.affectedObjects) && fault.affectedObjects.length > 0) {
    rows.push(['受影响对象', fault.affectedObjects.join(', ')]);
  }

  rows.push(['故障时间范围', timeRange.displayText || `${valueOrDash(timeRange.start)} ~ ${valueOrDash(timeRange.end)}`]);

  if (timeRange.baselineStart || timeRange.baselineEnd) {
    rows.push(['基线时间范围', `${valueOrDash(timeRange.baselineStart)} ~ ${valueOrDash(timeRange.baselineEnd)}`]);
  }

  return rows;
}

function buildFaultTimelineRows(timeline = []) {
  const typeLabels = { trigger: '触发', alert: '告警', impact: '影响', recovery: '恢复' };
  return asArray(timeline).map((item) => [
    item?.time || '-',
    item?.event || '-',
    (typeLabels[item?.type] || item?.type || '-')
  ]);
}

function buildHealthSummaryRows(context = {}) {
  const alertAnalysis = context.alertAnalysis || {};
  const trafficAnalysis = context.trafficAnalysis || {};
  const businessAnalysis = context.businessAnalysis || {};
  const rows = [];

  // Alert dimension
  const alertCritical = alertAnalysis.summary?.critical ?? 0;
  const alertTotal = alertAnalysis.summary?.total ?? 0;
  if (alertCritical > 0) {
    rows.push(['告警态势', '异常', `存在 ${alertCritical} 条紧急告警，共 ${alertTotal} 条告警`]);
  } else if (alertTotal > 0) {
    rows.push(['告警态势', '需关注', `共 ${alertTotal} 条告警，无紧急告警`]);
  } else {
    rows.push(['告警态势', '正常', '故障时段无告警产生']);
  }

  // Traffic dimension
  const anomalies = asArray(trafficAnalysis.anomalies);
  const missingPoints = trafficAnalysis.trend?.dataset?.stats?.missingPointCount ?? 0;
  const zeroSegments = trafficAnalysis.trend?.dataset?.stats?.zeroSegmentCount ?? 0;
  const spikes = trafficAnalysis.trend?.dataset?.stats?.spikeCount ?? 0;
  const trafficIssues = [];
  if (anomalies.length > 0) trafficIssues.push(`${anomalies.length} 个流量异常`);
  if (missingPoints > 0) trafficIssues.push(`${missingPoints} 个缺失点`);
  if (zeroSegments > 0) trafficIssues.push(`${zeroSegments} 个零流量段`);
  if (spikes > 0) trafficIssues.push(`${spikes} 个尖峰`);
  if (trafficIssues.length > 0) {
    rows.push(['流量状况', '异常', trafficIssues.join('，')]);
  } else {
    rows.push(['流量状况', '正常', '流量趋势未发现明显异常']);
  }

  // Business dimension
  const slowCount = asArray(businessAnalysis.slowAccess).length;
  const errorCount = asArray(businessAnalysis.httpErrors).length;
  if (slowCount > 0 || errorCount > 0) {
    const issues = [];
    if (slowCount > 0) issues.push(`${slowCount} 个慢访问业务`);
    if (errorCount > 0) issues.push(`${errorCount} 个 HTTP 错误业务`);
    rows.push(['业务性能', '需关注', issues.join('，')]);
  } else {
    rows.push(['业务性能', '正常', '未发现慢访问或 HTTP 错误']);
  }

  // Packet dimension (if available)
  if (isPlainObject(context.packetAnalysis)) {
    const highlights = asArray(context.packetAnalysis.highlights);
    if (highlights.length > 0) {
      rows.push(['数据包分析', '异常', highlights.length > 1 ? `${highlights.length} 个关键发现` : highlights[0]]);
    } else {
      rows.push(['数据包分析', '正常', '未发现明显协议异常']);
    }
  }

  // Overall status
  const overallStatus = alertAnalysis.overallStatus || 'ok';
  if (overallStatus === 'critical') rows.push(['综合评估', '异常', '存在紧急级别问题，需立即处理']);
  else if (overallStatus === 'warning') rows.push(['综合评估', '需关注', '部分指标需要关注']);
  else rows.push(['综合评估', '正常', '各维度指标基本正常']);

  return rows;
}

function buildAlertCategoryStatsRows(summary = {}) {
  return asArray(summary.byCategory).map((cat) => [
    cat?.categoryLabel || cat?.category || '-',
    cat?.total ?? 0,
    cat?.critical ?? 0,
    cat?.major ?? 0,
    cat?.minor ?? 0
  ]);
}

function buildAlertDetailsRows(summary = {}) {
  return asArray(summary.unresolvedAlerts).slice(0, 50).map((alert) => [
    alert?.id || '-',
    alert?.name || '-',
    severityLabel(alert?.severity),
    alert?.categoryLabel || '-',
    alert?.group || '-',
    typeof alert?.start === 'number' ? new Date(alert.start * 1000).toISOString() : (alert?.start || '-')
  ]);
}

function buildTrafficAnomaliesRows(anomalies = []) {
  return asArray(anomalies).map((item) => [
    item?.time || '-',
    item?.metric || '-',
    item?.description || '-',
    severityLabel(item?.severity)
  ]);
}

function buildTrafficTopIPsRows(topIPs = []) {
  return asArray(topIPs).map((item, index) => [
    index + 1,
    item?.key || item?.IPAddress || '-',
    formatNumber(item?.TPIO),
    formatNumber(item?.TPI),
    formatNumber(item?.TPO)
  ]);
}

function buildBusinessSlowTableRows(slowAccess = []) {
  return asArray(slowAccess).map((item, index) => [
    index + 1,
    item?.businessName || '-',
    item?.ratio || '-',
    item?.slowCount ?? 0,
    item?.avgPageDelayMs ?? 0
  ]);
}

function buildBusinessErrorTableRows(httpErrors = []) {
  return asArray(httpErrors).map((item, index) => [
    index + 1,
    item?.businessName || '-',
    item?.http400 ?? 0,
    item?.http500 ?? 0
  ]);
}

function buildPacketProtocolRows(protocolHierarchy = []) {
  return asArray(protocolHierarchy).slice(0, 40).map((item, index) => [
    index + 1,
    item?.protocol || item?.['#'] || '-',
    item?.frames ?? 0,
    item?.bytes ?? 0
  ]);
}

function buildPacketEndpointsRows(endpoints = []) {
  return asArray(endpoints).slice(0, 30).map((item, index) => [
    index + 1,
    item?.address || item?.['#'] || '-',
    item?.packets ?? 0,
    item?.bytes ?? 0
  ]);
}

function buildPacketConversationsRows(conversations = []) {
  return asArray(conversations).slice(0, 30).map((item, index) => [
    index + 1,
    item?.source || '-',
    item?.destination || '-',
    item?.packets ?? 0,
    item?.bytes ?? 0
  ]);
}

function formatNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(3) : (v === undefined || v === null ? '-' : String(v));
}

// ── DiagnosticFixedTemplateService ──────────────────────────────────

class DiagnosticFixedTemplateService extends InspectionFixedTemplateService {
  constructor(options = {}) {
    super({
      templateRoot: options.templateRoot || DEFAULT_DIAGNOSTIC_TEMPLATE_ROOT,
      assetRoot: options.assetRoot || path.join(__dirname, '..'),
      templateId: options.templateId || DEFAULT_DIAGNOSTIC_TEMPLATE_ID,
      narrativeRules: options.narrativeRules || null,
      chartSpecs: options.chartSpecs || null
    });
  }

  buildContext(report = {}) {
    const fault = report.fault || {};
    const alertAnalysis = report.alertAnalysis || {};
    const trafficAnalysis = report.trafficAnalysis || {};
    const businessAnalysis = report.businessAnalysis || {};
    const packetAnalysis = report.packetAnalysis || null;

    return {
      ...report,
      report,
      fault,
      faultName: report.faultName || fault.description || '未命名故障',
      alertAnalysis,
      trafficAnalysis,
      businessAnalysis,
      packetAnalysis,
      timeRange: report.timeRange || {},
      generatedAt: report.generatedAt || new Date().toISOString(),
      audit: report.audit || {}
    };
  }

  buildRowsForSection(section = {}, context = {}) {
    const builder = section.rowBuilder;

    // Fault overview
    if (builder === 'faultBasicInfo') {
      return { columns: section.columns, rows: buildFaultBasicInfoRows(context) };
    }
    if (builder === 'faultTimeline') {
      return { columns: section.columns, rows: buildFaultTimelineRows(context.fault?.timeline) };
    }
    if (builder === 'healthSummary') {
      return { columns: section.columns, rows: buildHealthSummaryRows(context) };
    }

    // Alert analysis
    if (builder === 'alertCategoryStats') {
      return { columns: section.columns, rows: buildAlertCategoryStatsRows(context.alertAnalysis?.summary) };
    }
    if (builder === 'alertDetails') {
      return { columns: section.columns, rows: buildAlertDetailsRows(context.alertAnalysis?.summary) };
    }

    // Traffic analysis
    if (builder === 'trafficAnomalies') {
      return { columns: section.columns, rows: buildTrafficAnomaliesRows(context.trafficAnalysis?.anomalies) };
    }
    if (builder === 'trafficTopIPs') {
      return { columns: section.columns, rows: buildTrafficTopIPsRows(context.trafficAnalysis?.topIPs) };
    }

    // Business analysis
    if (builder === 'businessSlowTable') {
      return { columns: section.columns, rows: buildBusinessSlowTableRows(context.businessAnalysis?.slowAccess) };
    }
    if (builder === 'businessErrorTable') {
      return { columns: section.columns, rows: buildBusinessErrorTableRows(context.businessAnalysis?.httpErrors) };
    }

    // Packet analysis
    if (builder === 'packetProtocol') {
      return { columns: section.columns, rows: buildPacketProtocolRows(context.packetAnalysis?.protocolHierarchy) };
    }
    if (builder === 'packetEndpoints') {
      return { columns: section.columns, rows: buildPacketEndpointsRows(context.packetAnalysis?.endpoints) };
    }
    if (builder === 'packetConversations') {
      return { columns: section.columns, rows: buildPacketConversationsRows(context.packetAnalysis?.conversations) };
    }

    // Fall back to parent for any unrecognized builders
    return super.buildRowsForSection(section, context);
  }

  renderNarrative(section = {}, context = {}) {
    // Use the local AND/OR-aware buildNarrativeTexts instead of the parent's
    const rules = this.loadNarrativeRules();
    const texts = buildNarrativeTexts(context, rules, section.ruleGroup, section.mode || 'first');
    const {
      AlignmentType,
      Paragraph,
      TextRun
    } = require('docx');
    const children = [];
    if (section.title) {
      // buildHeading inline
      const level = Number(section.level) || 2;
      children.push(new Paragraph({
        heading: level === 1 ? require('docx').HeadingLevel.HEADING_1 : require('docx').HeadingLevel.HEADING_2,
        spacing: { before: level === 1 ? 240 : 160, after: 120 },
        children: [
          new TextRun({
            text: interpolate(section.title, context),
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
            text,
            size: 21,
            color: DEFAULT_TEXT_COLOR,
            font: DEFAULT_FONT
          })
        ]
      }));
    }
    return children;
  }

  /**
   * Pre-render all chartSlot sections to PNG buffers.
   * Filters out chart slots whose chartId has no data.
   */
  async preRenderCharts(template = {}, context = {}) {
    const chartSpecs = this.loadChartSpecs();
    const chartBuffers = new Map();
    const chartSlots = asArray(template.sections).filter((s) =>
      s.type === 'chartSlot' && sectionConditionMatches(s, context)
    );

    for (const slot of chartSlots) {
      const chart = asArray(chartSpecs.charts).find((c) => c.id === slot.chartId) || {};
      const dataset = getByPath(context, chart.datasetPath || '');
      const dataPoints = Array.isArray(dataset)
        ? dataset.length
        : (Array.isArray(dataset?.points) ? dataset.points.length : 0);
      console.log(`[DiagnosticFixedTemplate] chart "${slot.id}" (${chart.chartType}): datasetPath=${chart.datasetPath}, dataPoints=${dataPoints}`);

      if (dataPoints === 0) {
        console.warn(`[DiagnosticFixedTemplate] chart "${slot.id}" has NO DATA — skipping render`);
        continue;
      }

      try {
        const option = buildEChartsOption(chart, context);
        const width = Number(slot.width) || NAPM_STYLE.chartWidth;
        const height = Number(slot.height) || NAPM_STYLE.chartHeight;
        const buffer = await renderChartPngBuffer(option, width, height);
        chartBuffers.set(slot.id, { buffer, width, height });
      } catch (err) {
        console.error(`[DiagnosticFixedTemplate] Failed to render chart "${slot.id}":`, err.message);
      }
    }
    return chartBuffers;
  }

  buildChildren(report = {}, chartBuffers = null) {
    const { template, context } = this.buildTemplateContext(report);
    // Filter sections: always render ones without condition, and check conditions
    const visibleSections = asArray(template.sections).filter((section) =>
      sectionConditionMatches(section, context)
    );
    return visibleSections.flatMap((section) => this.renderSection(section, context, chartBuffers));
  }

  async renderDocx(report = {}) {
    const resolvedTitle = report.title || asText(report.faultName || 'NAPM 故障分析报告');
    const { template, context } = this.buildTemplateContext({
      ...report,
      title: resolvedTitle,
      templateId: report.templateId || this.defaultTemplateId
    });

    // Pre-render all chartSlot PNGs before building document children
    this._chartBuffers = await this.preRenderCharts(template, context);

    const header = buildDocumentHeader(template, context, { assetRoot: this.assetRoot });
    const footer = buildDocumentFooter(template, context, { assetRoot: this.assetRoot });

    // Filter sections by condition
    const visibleSections = asArray(template.sections).filter((section) =>
      sectionConditionMatches(section, context)
    );

    const section = {
      properties: buildPageProperties(template),
      children: visibleSections.flatMap((item) => this.renderSection(item, context, this._chartBuffers))
    };
    if (header) section.headers = { default: header };
    if (footer) section.footers = { default: footer };

    const doc = new Document({
      creator: 'openclaw-napm-report',
      title: resolvedTitle,
      description: 'Generated by OpenClaw NAPM diagnostic report fixed template',
      features: {
        updateFields: true
      },
      styles: buildDocumentStyles(),
      sections: [section]
    });

    const buffer = await Packer.toBuffer(doc);

    // Post-process: ensure Heading1Char / Heading2Char character styles
    try {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(buffer);
      let stylesXml = await zip.file('word/styles.xml').async('string');

      if (!stylesXml.includes('w:styleId="Heading1Char"')) {
        stylesXml = stylesXml.replace(
          '</w:styles>',
          '<w:style w:type="character" w:styleId="Heading1Char">' +
          '<w:name w:val="Heading 1 Char"/><w:link w:val="Heading1"/>' +
          '<w:uiPriority w:val="9"/><w:rPr>' +
          '<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:cs="Microsoft YaHei"/>' +
          '<w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'
        );
      }
      if (!stylesXml.includes('w:styleId="Heading2Char"')) {
        stylesXml = stylesXml.replace(
          '</w:styles>',
          '<w:style w:type="character" w:styleId="Heading2Char">' +
          '<w:name w:val="Heading 2 Char"/><w:link w:val="Heading2"/>' +
          '<w:uiPriority w:val="9"/><w:rPr>' +
          '<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:cs="Microsoft YaHei"/>' +
          '<w:b/><w:color w:val="000000"/><w:sz w:val="24"/></w:rPr></w:style></w:styles>'
        );
      }

      zip.file('word/styles.xml', stylesXml);
      return await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
    } catch (_) {
      return buffer;
    }
  }
}

module.exports = DiagnosticFixedTemplateService;
module.exports.__test__ = {
  evalCondition,
  existsValue,
  sectionConditionMatches,
  buildNarrativeTexts,
  buildFaultBasicInfoRows,
  buildFaultTimelineRows,
  buildHealthSummaryRows,
  buildAlertCategoryStatsRows,
  buildAlertDetailsRows,
  buildTrafficAnomaliesRows,
  buildTrafficTopIPsRows,
  buildBusinessSlowTableRows,
  buildBusinessErrorTableRows,
  buildPacketProtocolRows,
  buildPacketEndpointsRows,
  buildPacketConversationsRows,
  severityLabel
};
