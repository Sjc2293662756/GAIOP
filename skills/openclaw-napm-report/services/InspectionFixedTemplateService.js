'use strict';

const fs = require('fs');
const path = require('path');
const {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} = require('docx');

const DEFAULT_TEMPLATE_ID = 'napm_traffic_health_inspection_v1';
const DEFAULT_TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'inspection');

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function compactText(value, maxLength = 1000) {
  const text = asText(value).replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function getByPath(source = {}, pathText = '') {
  const parts = String(pathText || '').split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      current = current[part];
    }
  }
  return current;
}

function valueOrDash(value) {
  const text = compactText(value);
  return text || '-';
}

function statusText(status = '') {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'ok') return '正常';
  if (value === 'warning') return '需关注';
  if (value === 'unknown') return '未确认';
  return valueOrDash(status);
}

function transformValue(value, transform = '') {
  if (transform === 'status') return statusText(value);
  return valueOrDash(value);
}

function interpolate(template = '', context = {}) {
  return String(template || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, pathText) => {
    return valueOrDash(getByPath(context, pathText));
  });
}

function buildParagraph(text = '', options = {}) {
  return new Paragraph({
    alignment: options.alignment,
    spacing: { before: options.before ?? 0, after: options.after ?? 120 },
    children: [
      new TextRun({
        text: asText(text),
        bold: Boolean(options.bold),
        size: options.size || 21,
        color: options.color || '1F2937'
      })
    ]
  });
}

function buildHeading(text = '', level = 1) {
  const normalizedLevel = Number(level) || 1;
  return new Paragraph({
    heading: normalizedLevel === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    spacing: { before: normalizedLevel === 1 ? 240 : 160, after: 120 },
    children: [
      new TextRun({
        text: asText(text),
        bold: true,
        size: normalizedLevel === 1 ? 28 : 24,
        color: normalizedLevel === 1 ? '0F766E' : '334155'
      })
    ]
  });
}

function buildCaption(text = '') {
  return buildParagraph(text, {
    bold: true,
    size: 21,
    color: '334155',
    after: 80
  });
}

function buildCell(text = '', options = {}) {
  return new TableCell({
    shading: options.header ? { fill: 'E5E7EB' } : undefined,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [
      buildParagraph(valueOrDash(text), {
        bold: Boolean(options.header),
        size: options.header ? 20 : 19,
        color: options.header ? '111827' : '374151',
        after: 0
      })
    ]
  });
}

function normalizeRows(rows = []) {
  return asArray(rows).map((row) => {
    if (Array.isArray(row)) {
      return row.map(valueOrDash);
    }
    if (isPlainObject(row)) {
      return Object.values(row).map(valueOrDash);
    }
    return [valueOrDash(row)];
  });
}

function buildTable({ columns = [], rows = [] } = {}) {
  const normalizedRows = normalizeRows(rows);
  const effectiveColumns = asArray(columns).map(valueOrDash);
  const resolvedColumns = effectiveColumns.length > 0
    ? effectiveColumns
    : (normalizedRows[0]?.map((_cell, index) => `列${index + 1}`) || ['内容']);
  const bodyRows = normalizedRows.length > 0
    ? normalizedRows
    : [resolvedColumns.map((_, index) => (index === 0 ? '暂无数据' : ''))];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: resolvedColumns.map((column) => buildCell(column, { header: true }))
      }),
      ...bodyRows.map((row) => new TableRow({
        children: resolvedColumns.map((_column, index) => buildCell(row[index] || ''))
      }))
    ]
  });
}

function buildSectionItemRows(section = {}) {
  return asArray(section.items).map((item, index) => [
    item?.index || index + 1,
    item?.name || '',
    item?.value,
    item?.remark
  ]);
}

function findingText(item = '') {
  if (typeof item === 'string') return item;
  return asText(item?.text || item?.message || item?.summary || item);
}

function evidenceText(item = {}) {
  if (typeof item === 'string') return '';
  return asArray(item?.evidenceRefs).join(', ') || asText(item?.evidenceRef);
}

function buildFindingsRows(findings = []) {
  return asArray(findings).map((item, index) => [
    index + 1,
    statusText(item?.level || item?.status || ''),
    findingText(item),
    evidenceText(item)
  ]);
}

function buildDeviceRows(devices = []) {
  return asArray(devices).map((device, index) => [
    device?.index || index + 1,
    device?.systemName,
    device?.ipAddress,
    device?.softwareVersion,
    device?.serialNumber,
    device?.applianceTime,
    device?.uptime
  ]);
}

function buildSummaryRows(summary = {}) {
  return asArray(summary.devices).map((device, index) => [
    index + 1,
    device?.deviceName,
    device?.cpuUsage,
    device?.diskUsage,
    device?.packetDrops,
    device?.health,
    device?.remark
  ]);
}

function buildAbnormalItemRows(summary = {}) {
  return asArray(summary.abnormalItems).map((item, index) => [index + 1, item]);
}

function buildTrafficStatsRows(trafficAnalysis = {}) {
  const windows = [
    ['最近1小时', trafficAnalysis.recentHour],
    ['最近1天', trafficAnalysis.recentDay]
  ];
  return windows
    .filter(([, window]) => window?.dataset)
    .map(([label, window]) => {
      const stats = window.dataset.stats || {};
      return [
        label,
        window.title,
        asArray(window.dataset.points).length,
        stats.max,
        stats.min,
        stats.avg,
        stats.missingPointCount,
        stats.zeroSegmentCount,
        stats.spikeCount
      ];
    });
}

function pickDatasetPoints(points = [], limit = 12) {
  const normalized = asArray(points);
  const maxRows = Number(limit) || 12;
  if (normalized.length <= maxRows) return normalized;
  const headCount = Math.ceil(maxRows / 2);
  const tailCount = Math.floor(maxRows / 2);
  return [
    ...normalized.slice(0, headCount),
    ...normalized.slice(-tailCount)
  ];
}

function buildTrafficPointTable(window = {}, limit = 12) {
  const metrics = asArray(window?.dataset?.metrics);
  return {
    columns: ['序号', '时间', ...metrics],
    rows: pickDatasetPoints(window?.dataset?.points, limit).map((point, index) => [
      index + 1,
      point?.time || point?.timestamp,
      ...metrics.map((metric) => point?.[metric])
    ])
  };
}

function buildBusinessSlowRows(businessPerformance = {}) {
  return asArray(businessPerformance.slowAccess).map((row, index) => [
    index + 1,
    row?.businessName,
    row?.ratio,
    row?.slowCount,
    row?.avgPageDelayMs,
    row?.evidenceRef
  ]);
}

function buildBusinessErrorRows(businessPerformance = {}) {
  return asArray(businessPerformance.httpErrors).map((row, index) => [
    index + 1,
    row?.businessName,
    row?.http400,
    row?.http500,
    asArray(row?.evidenceRefs).join(', ')
  ]);
}

function collectInspectionEvidence(inspection = {}, audit = {}) {
  const evidence = [];
  const append = (item) => {
    if (isPlainObject(item)) evidence.push(item);
  };
  append(inspection.trafficAnalysis?.recentHour?.queryEvidence);
  append(inspection.trafficAnalysis?.recentDay?.queryEvidence);
  asArray(inspection.businessPerformance?.queryEvidence).forEach(append);
  asArray(audit.queryEvidence).forEach(append);

  const seen = new Set();
  return evidence.filter((item) => {
    const key = JSON.stringify([
      item.id,
      item.service,
      item.start,
      item.end,
      item.topMetric,
      item.granularity,
      item.requestUrlRedacted
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildEvidenceRows(evidence = []) {
  return asArray(evidence).map((item, index) => [
    index + 1,
    item?.id || item?.service,
    item?.service,
    asArray(item?.groups).map((group) => group?.type || group).join(' > '),
    asArray(item?.metrics).join(', '),
    item?.topMetric || item?.granularity,
    item?.start || item?.end ? `${valueOrDash(item?.start)} ~ ${valueOrDash(item?.end)}` : '',
    item?.requestUrlRedacted
  ]);
}

function parseExpectedValue(raw = '') {
  const text = String(raw || '').trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text.replace(/^['"]|['"]$/g, '');
}

function existsValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
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

function evaluateCondition(condition = '', context = {}) {
  const text = String(condition || '').trim();
  if (!text || text === 'default') return true;

  const existsMatch = text.match(/^(.+?)\s+exists$/);
  if (existsMatch) {
    return existsValue(getByPath(context, existsMatch[1].trim()));
  }

  const emptyMatch = text.match(/^(.+?)\s+empty$/);
  if (emptyMatch) {
    return !existsValue(getByPath(context, emptyMatch[1].trim()));
  }

  const compareMatch = text.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compareMatch) {
    const left = getByPath(context, compareMatch[1].trim());
    const operator = compareMatch[2];
    const right = parseExpectedValue(compareMatch[3]);
    return compareValues(left, operator, right);
  }

  return existsValue(getByPath(context, text));
}

function buildNarrativeTexts(context = {}, rules = {}, groupId = '', mode = 'first') {
  const group = asArray(rules.groups?.[groupId]);
  if (group.length === 0) return [];
  if (mode === 'all') {
    const matches = group
      .filter((rule) => String(rule.when || '').trim() !== 'default')
      .filter((rule) => evaluateCondition(rule.when, context))
      .map((rule) => interpolate(rule.text, context))
      .filter(Boolean);
    if (matches.length > 0) return matches;
  }

  const match = group.find((rule) => evaluateCondition(rule.when, context));
  return match ? [interpolate(match.text, context)] : [];
}

function chartTypeText(chartType = '') {
  const value = String(chartType || '').trim().toLowerCase();
  if (value === 'line') return '折线图';
  if (value === 'bar') return '柱状图';
  if (value === 'pie') return '饼图';
  return valueOrDash(chartType);
}

function countDatasetRows(dataset) {
  if (Array.isArray(dataset)) return dataset.length;
  if (Array.isArray(dataset?.points)) return dataset.points.length;
  if (Array.isArray(dataset?.rows)) return dataset.rows.length;
  return 0;
}

function buildChartSlotRows(context = {}, chart = {}) {
  const dataset = getByPath(context, chart.datasetPath || '');
  const unit = chart.unitPath ? getByPath(context, chart.unitPath) : '';
  return [
    ['图表名称', chart.title],
    ['图表类型', chartTypeText(chart.chartType)],
    ['数据绑定', chart.datasetPath],
    ['数据点数量', countDatasetRows(dataset)],
    ['指标', asArray(chart.series).map((item) => item.name || item.field).join(', ')],
    ['单位', unit]
  ];
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

class InspectionFixedTemplateService {
  constructor(options = {}) {
    this.templateRoot = options.templateRoot || DEFAULT_TEMPLATE_ROOT;
    this.defaultTemplateId = options.templateId || DEFAULT_TEMPLATE_ID;
    this.templateCache = new Map();
    this.narrativeRules = options.narrativeRules || null;
    this.chartSpecs = options.chartSpecs || null;
  }

  loadTemplate(templateId = this.defaultTemplateId) {
    const resolvedId = String(templateId || this.defaultTemplateId).trim() || DEFAULT_TEMPLATE_ID;
    if (!this.templateCache.has(resolvedId)) {
      this.templateCache.set(
        resolvedId,
        loadJson(path.join(this.templateRoot, `${resolvedId}.json`))
      );
    }
    return this.templateCache.get(resolvedId);
  }

  loadNarrativeRules() {
    if (!this.narrativeRules) {
      this.narrativeRules = loadJson(path.join(this.templateRoot, 'narrative-rules.v1.json'));
    }
    return this.narrativeRules;
  }

  loadChartSpecs() {
    if (!this.chartSpecs) {
      this.chartSpecs = loadJson(path.join(this.templateRoot, 'chart-specs.v1.json'));
    }
    return this.chartSpecs;
  }

  buildContext(report = {}) {
    const inspectionSection = asArray(report.sections).find((section) => section?.type === 'inspection') || {};
    const inspection = report.inspection || getByPath(report, inspectionSection.dataPath || 'inspection') || {};
    return {
      ...report,
      report,
      inspection,
      audit: report.audit || {}
    };
  }

  buildRowsForSection(section = {}, context = {}) {
    const inspection = context.inspection || {};
    const builder = section.rowBuilder;
    if (builder === 'devices') {
      return { columns: section.columns, rows: buildDeviceRows(inspection.devices) };
    }
    if (builder === 'sectionItems') {
      return { columns: section.columns, rows: buildSectionItemRows(getByPath(context, section.dataPath)) };
    }
    if (builder === 'findings') {
      return { columns: section.columns, rows: buildFindingsRows(getByPath(context, section.dataPath)) };
    }
    if (builder === 'trafficStats') {
      return { columns: section.columns, rows: buildTrafficStatsRows(inspection.trafficAnalysis || {}) };
    }
    if (builder === 'trafficSamples') {
      return buildTrafficPointTable(getByPath(context, section.dataPath), section.maxRows);
    }
    if (builder === 'businessSlow') {
      return { columns: section.columns, rows: buildBusinessSlowRows(inspection.businessPerformance || {}) };
    }
    if (builder === 'businessErrors') {
      return { columns: section.columns, rows: buildBusinessErrorRows(inspection.businessPerformance || {}) };
    }
    if (builder === 'summaryDevices') {
      return { columns: section.columns, rows: buildSummaryRows(inspection.summary || {}) };
    }
    if (builder === 'abnormalItems') {
      return { columns: section.columns, rows: buildAbnormalItemRows(inspection.summary || {}) };
    }
    if (builder === 'evidence') {
      return {
        columns: section.columns,
        rows: buildEvidenceRows(collectInspectionEvidence(inspection, context.audit || {}))
      };
    }
    return { columns: section.columns, rows: section.rows || [] };
  }

  renderCover(section = {}, context = {}) {
    return [
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 260 },
        children: [
          new TextRun({
            text: interpolate(section.title || '{{title}}', context),
            bold: true,
            size: 34,
            color: '111827'
          })
        ]
      }),
      buildParagraph(interpolate(section.subtitle || '', context), {
        alignment: AlignmentType.CENTER,
        size: 24,
        color: '334155',
        after: 260
      })
    ];
  }

  renderKeyValueTable(section = {}, context = {}) {
    const rows = asArray(section.rows).map((row) => [
      row.label,
      transformValue(getByPath(context, row.valuePath), row.transform)
    ]);
    return [
      buildHeading(section.title, 2),
      buildTable({ columns: section.columns || ['项目', '内容'], rows }),
      buildParagraph('', { after: 80 })
    ];
  }

  renderTableSection(section = {}, context = {}) {
    const children = [];
    if (section.title) {
      children.push(buildHeading(section.title, section.level || 2));
    }
    if (section.caption) {
      children.push(buildCaption(section.caption));
    }
    children.push(buildTable(this.buildRowsForSection(section, context)));
    children.push(buildParagraph('', { after: 80 }));
    return children;
  }

  renderNarrative(section = {}, context = {}) {
    const rules = this.loadNarrativeRules();
    const texts = buildNarrativeTexts(context, rules, section.ruleGroup, section.mode || 'first');
    const children = [];
    if (section.title) {
      children.push(buildHeading(section.title, section.level || 2));
    }
    for (const text of texts.length > 0 ? texts : ['-']) {
      children.push(buildParagraph(text, { size: 21, after: 100 }));
    }
    return children;
  }

  renderChartSlot(section = {}, context = {}) {
    const chartSpecs = this.loadChartSpecs();
    const chart = asArray(chartSpecs.charts).find((item) => item.id === section.chartId) || {};
    const children = [];
    if (section.title) {
      children.push(buildCaption(section.title));
    }
    children.push(buildTable({
      columns: ['图表槽位', '绑定内容'],
      rows: buildChartSlotRows(context, chart)
    }));
    children.push(buildParagraph('', { after: 80 }));
    return children;
  }

  renderSection(section = {}, context = {}) {
    if (section.type === 'cover') return this.renderCover(section, context);
    if (section.type === 'heading') return [buildHeading(section.title, section.level || 1)];
    if (section.type === 'keyValueTable') return this.renderKeyValueTable(section, context);
    if (section.type === 'table') return this.renderTableSection(section, context);
    if (section.type === 'narrative') return this.renderNarrative(section, context);
    if (section.type === 'chartSlot') return this.renderChartSlot(section, context);
    return [];
  }

  buildChildren(report = {}) {
    const template = this.loadTemplate(report.templateId || this.defaultTemplateId);
    const context = this.buildContext({
      ...report,
      title: report.title || 'NAPM 巡检报告',
      templateId: report.templateId || template.templateId
    });
    return asArray(template.sections).flatMap((section) => this.renderSection(section, context));
  }

  async renderDocx(report = {}) {
    const doc = new Document({
      creator: 'openclaw-napm-report',
      title: asText(report.title || 'NAPM 巡检报告'),
      description: 'Generated by OpenClaw NAPM report fixed inspection template',
      sections: [
        {
          properties: {},
          children: this.buildChildren(report)
        }
      ]
    });

    return Packer.toBuffer(doc);
  }
}

module.exports = InspectionFixedTemplateService;
module.exports.__test__ = {
  asText,
  asArray,
  getByPath,
  interpolate,
  normalizeRows,
  buildTrafficStatsRows,
  buildBusinessSlowRows,
  buildBusinessErrorRows,
  buildEvidenceRows,
  collectInspectionEvidence,
  buildNarrativeTexts,
  evaluateCondition,
  buildChartSlotRows,
  statusText
};
