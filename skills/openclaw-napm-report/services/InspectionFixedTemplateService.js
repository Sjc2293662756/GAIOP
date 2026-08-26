'use strict';

const fs = require('fs');
const path = require('path');
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  SimpleField,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType
} = require('docx');

const DEFAULT_TEMPLATE_ID = 'napm_traffic_health_inspection_v1';
const DEFAULT_TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'inspection');
const DEFAULT_FONT = 'Microsoft YaHei';
const DEFAULT_TEXT_COLOR = '000000';

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
        color: DEFAULT_TEXT_COLOR,
        font: DEFAULT_FONT
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
        color: DEFAULT_TEXT_COLOR,
        font: DEFAULT_FONT
      })
    ]
  });
}

function buildCaption(text = '') {
  return buildParagraph(text, {
    bold: true,
    size: 21,
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

const NO_BORDER = {
  style: BorderStyle.NIL,
  size: 0,
  color: 'FFFFFF'
};

const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
  insideHorizontal: NO_BORDER,
  insideVertical: NO_BORDER
};

function alignmentForSlot(slot = '') {
  if (slot === 'center') return AlignmentType.CENTER;
  if (slot === 'right') return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

function inlineValue(value) {
  return compactText(value);
}

function imageTypeFromPath(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  return 'png';
}

function resolveAssetPath(assetPath = '', assetRoot = path.join(__dirname, '..')) {
  const text = String(assetPath || '').trim();
  if (!text) return '';
  return path.isAbsolute(text)
    ? text
    : path.resolve(assetRoot, text);
}

function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  // PNG: IHDR at offset 16-23
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: scan SOF0/SOF1/SOF2 markers
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return null;
  }
  // GIF: logical screen descriptor at offset 6-9
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // BMP: DIB header at offset 18-25
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return { width: buffer.readUInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  return null;
}

function buildImageRun(image = {}, assetRoot = path.join(__dirname, '..')) {
  if (!isPlainObject(image)) return null;
  const filePath = resolveAssetPath(image.path, assetRoot);
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const imageBuffer = fs.readFileSync(filePath);
  const dims = readImageDimensions(imageBuffer);
  const configWidth = Number(image.width) || 110;

  // Maintain aspect ratio: calculate height from configured width + actual image proportions
  let width = configWidth;
  let height = Number(image.height) || 32;
  if (dims && dims.width > 0 && dims.height > 0) {
    height = Math.round(configWidth * dims.height / dims.width);
  }

  return new ImageRun({
    type: image.type || imageTypeFromPath(filePath),
    data: imageBuffer,
    transformation: { width, height },
    altText: {
      title: asText(image.alt || 'logo'),
      description: asText(image.alt || 'logo')
    }
  });
}

function buildInlineRuns(template = '', context = {}, options = {}) {
  const text = String(template || '');
  const runs = [];
  const pattern = /\{\{\s*([^}]+?)\s*\}\}/g;
  let cursor = 0;
  let match;
  const makeTextRun = (value) => new TextRun({
    text: asText(value),
    size: options.size || 18,
    color: DEFAULT_TEXT_COLOR,
    bold: Boolean(options.bold),
    font: DEFAULT_FONT
  });
  const makePageRun = (field) => new TextRun({
    children: [field],
    size: options.size || 18,
    color: DEFAULT_TEXT_COLOR,
    bold: Boolean(options.bold),
    font: DEFAULT_FONT
  });

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      runs.push(makeTextRun(text.slice(cursor, match.index)));
    }
    const key = match[1].trim();
    if (key === 'pageNumber') {
      runs.push(makePageRun(PageNumber.CURRENT));
    } else if (key === 'totalPages') {
      runs.push(makePageRun(PageNumber.TOTAL_PAGES));
    } else {
      runs.push(makeTextRun(inlineValue(getByPath(context, key))));
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    runs.push(makeTextRun(text.slice(cursor)));
  }

  return runs.length > 0 ? runs : [makeTextRun('')];
}

function buildHeaderFooterTable(config = {}, context = {}, options = {}) {
  const slots = ['left', 'center', 'right'];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: slots.map((slot) => {
          const imageRun = buildImageRun(config[`${slot}Image`], options.assetRoot);
          return new TableCell({
            width: { size: 33, type: WidthType.PERCENTAGE },
            borders: NO_BORDERS,
            margins: { top: 0, bottom: 0, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: alignmentForSlot(slot),
                spacing: { after: 0 },
                children: imageRun
                  ? [imageRun]
                  : buildInlineRuns(config[slot] || '', context, options)
              })
            ]
          });
        })
      })
    ]
  });
}

function buildPageProperties(template = {}) {
  const margin = template.page?.margin;
  if (!isPlainObject(margin)) {
    return {};
  }
  return {
    page: {
      margin
    }
  };
}

function buildDocumentStyles() {
  const baseRun = {
    font: DEFAULT_FONT,
    color: DEFAULT_TEXT_COLOR
  };
  return {
    default: {
      document: {
        run: {
          ...baseRun,
          size: 21
        },
        paragraph: {
          spacing: { after: 120 }
        }
      },
      title: {
        run: {
          ...baseRun,
          bold: true,
          size: 34
        },
        paragraph: {
          spacing: { after: 260 }
        }
      },
      heading1: {
        run: {
          ...baseRun,
          bold: true,
          size: 28
        },
        paragraph: {
          spacing: { before: 240, after: 120 },
          outlineLevel: 0   // OOXML 0-based: 0=TOC Level 1
        },
        link: 'Heading1Char'
      },
      heading2: {
        run: {
          ...baseRun,
          bold: true,
          size: 24
        },
        paragraph: {
          spacing: { before: 160, after: 120 },
          outlineLevel: 1   // OOXML 0-based: 1=TOC Level 2
        },
        link: 'Heading2Char'
      },
      hyperlink: {
        run: {
          ...baseRun
        }
      }
    },
    paragraphStyles: [
      {
        id: 'TOC1',
        name: 'TOC 1',
        basedOn: 'Normal',
        next: 'Normal',
        run: {
          ...baseRun,
          size: 21
        },
        paragraph: {
          spacing: { after: 80 }
        }
      },
      {
        id: 'TOC2',
        name: 'TOC 2',
        basedOn: 'Normal',
        next: 'Normal',
        run: {
          ...baseRun,
          size: 20
        },
        paragraph: {
          indent: { left: 360 },
          spacing: { after: 60 }
        }
      },
      {
        id: 'TOC3',
        name: 'TOC 3',
        basedOn: 'Normal',
        next: 'Normal',
        run: {
          ...baseRun,
          size: 19
        },
        paragraph: {
          indent: { left: 720 },
          spacing: { after: 60 }
        }
      }
    ]
  };
}

function buildDocumentHeader(template = {}, context = {}, options = {}) {
  const config = template.page?.header;
  if (!isPlainObject(config)) {
    return undefined;
  }
  return new Header({
    children: [
      buildHeaderFooterTable(config, context, { size: 18, assetRoot: options.assetRoot })
    ]
  });
}

function buildDocumentFooter(template = {}, context = {}, options = {}) {
  const config = template.page?.footer;
  if (!isPlainObject(config)) {
    return undefined;
  }
  return new Footer({
    children: [
      buildHeaderFooterTable(config, context, { size: 18, assetRoot: options.assetRoot })
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

function buildBasicDeviceRows(devices = []) {
  return asArray(devices).map((device, index) => [
    device?.index || index + 1,
    device?.systemName,
    device?.ipAddress,
    device?.softwareVersion,
    device?.serialNumber,
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

function buildSummaryTemplateRows(summary = {}) {
  return asArray(summary.devices).map((device) => [
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

/**
 * NAPM 全局色板 — 高饱和度霓虹色，绿→黄→青→蓝→紫→红循环
 * 来源: shine/NI_NAPM 主题
 */
const NAPM_COLOR_PALETTE = [
  '#2fe74e', '#fdf756', '#2ec8e5', '#2e8ae6', '#a830e5', '#e74d2e',
  '#cda819', '#40fdff', '#2ee7a8', '#2d2fe6', '#e6e72d', '#6c2fe7'
];

/** NAPM 样式常量 — 来自 chart_styles.md */
const NAPM_STYLE = {
  backgroundColor: '#ffffff',
  tooltipBg: '#196347',
  // 字体族：优先 WenQuanYi (Linux 服务端)，回退到系统中文字体
  fontFamily: 'WenQuanYi Micro Hei, Microsoft YaHei, SimHei, Noto Sans CJK SC, sans-serif',
  grid: { top: '12%', bottom: '10%', left: '5%', right: '5%', containLabel: true },
  title: { fontWeight: 'bold', fontSize: 14, color: '#333333' },
  legend: { textStyle: { color: '#333333', fontSize: 11 } },
  axisLine: { lineStyle: { color: '#cccccc' } },
  axisLabel: { color: '#666666', fontSize: 10 },
  splitLine: { lineStyle: { color: '#e8e8e8' } },
  line: { smooth: true, symbolSize: 0, showSymbol: false, lineStyle: { width: 2.5 } },
  bar: { barBorderWidth: 0, barBorderColor: '#ccc' },
  // A4 纸可用宽度约 178mm ≈ 620px (96dpi渲染, docx中ImageRun按像素缩放)
  chartWidth: 620,
  chartHeight: 360
};

/**
 * Build a full ECharts option object from a chart spec + inspection context.
 * Applies NAPM color palette and chart style conventions.
 * Supports line charts (dataset.points) and bar charts (dataset array).
 */
function buildEChartsOption(chartSpec = {}, context = {}) {
  const chartType = String(chartSpec.chartType || 'line').trim().toLowerCase();
  const dataset = getByPath(context, chartSpec.datasetPath || '');
  const unit = chartSpec.unitPath ? getByPath(context, chartSpec.unitPath) : '';
  const xField = chartSpec.xField || 'time';
  const seriesDefs = asArray(chartSpec.series);
  const timezone = context.timezone || dataset?.timezone || 'Asia/Shanghai';

  function toChartValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  let xData = [];
  let seriesData = [];

  if (chartType === 'bar' && Array.isArray(dataset)) {
    // Bar chart: dataset is an array of objects (e.g. slowAccess, httpErrors)
    xData = dataset.map((item) => item?.[xField] ?? '');
    seriesData = seriesDefs.map((s, seriesIndex) => {
      const color = NAPM_COLOR_PALETTE[seriesIndex % NAPM_COLOR_PALETTE.length];
      return {
        name: s.name || s.field,
        type: 'bar',
        barWidth: '45%',
        barGap: '15%',
        barBorderWidth: NAPM_STYLE.bar.barBorderWidth,
        barBorderColor: NAPM_STYLE.bar.barBorderColor,
        itemStyle: {
          color,
          borderRadius: [3, 3, 0, 0]
        },
        label: {
          show: true,
          position: 'top',
          color: '#333333',
          fontSize: 10,
          fontFamily: NAPM_STYLE.fontFamily
        },
        data: dataset.map((item) => toChartValue(item?.[s.field]))
      };
    });
  } else {
    // Line chart: dataset has a .points array (e.g. traffic time-series)
    const points = asArray(dataset?.points || dataset);
    xData = points.map((p) => p?.[xField] ?? '');
    seriesData = seriesDefs.map((s, seriesIndex) => {
      const color = NAPM_COLOR_PALETTE[seriesIndex % NAPM_COLOR_PALETTE.length];
      return {
        name: s.name || s.field,
        type: 'line',
        smooth: NAPM_STYLE.line.smooth,
        connectNulls: false,
        symbolSize: NAPM_STYLE.line.symbolSize,
        showSymbol: NAPM_STYLE.line.showSymbol,
        lineStyle: { width: NAPM_STYLE.line.lineStyle.width, color },
        itemStyle: { color },
        data: points.map((p) => toChartValue(p?.[s.field]))
      };
    });
  }

  // Format Unix timestamps to readable HH:mm
  function formatTimeLabel(value) {
    const ts = Number(value);
    if (Number.isFinite(ts) && ts > 1000000000) {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(new Date(ts * 1000)).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
      }, {});
      return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    }
    return String(value);
  }

  const xAxisConfig = {
    type: 'category',
    data: xData,
    axisLine: NAPM_STYLE.axisLine,
    axisLabel: chartType === 'bar'
      ? { ...NAPM_STYLE.axisLabel, rotate: 30, overflow: 'truncate', width: 120, formatter: formatTimeLabel }
      : { ...NAPM_STYLE.axisLabel, formatter: formatTimeLabel },
    splitLine: { show: false }
  };

  const yAxisConfig = {
    type: 'value',
    axisLine: NAPM_STYLE.axisLine,
    axisLabel: NAPM_STYLE.axisLabel,
    splitLine: { show: true, lineStyle: NAPM_STYLE.splitLine.lineStyle }
  };
  if (unit) yAxisConfig.name = asText(unit);

  return {
    backgroundColor: NAPM_STYLE.backgroundColor,
    title: {
      text: chartSpec.title || '',
      left: 'center',
      top: '3%',
      textStyle: { ...NAPM_STYLE.title, fontFamily: NAPM_STYLE.fontFamily }
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: NAPM_STYLE.tooltipBg,
      textStyle: { color: '#ffffff', fontFamily: NAPM_STYLE.fontFamily }
    },
    legend: {
      data: seriesData.map((s) => s.name),
      bottom: 0,
      type: 'scroll',
      textStyle: { ...NAPM_STYLE.legend.textStyle, fontFamily: NAPM_STYLE.fontFamily }
    },
    xAxis: {
      ...xAxisConfig,
      axisLabel: { ...xAxisConfig.axisLabel, fontFamily: NAPM_STYLE.fontFamily },
      nameTextStyle: { fontFamily: NAPM_STYLE.fontFamily }
    },
    yAxis: {
      ...yAxisConfig,
      axisLabel: { ...yAxisConfig.axisLabel, fontFamily: NAPM_STYLE.fontFamily },
      nameTextStyle: { fontFamily: NAPM_STYLE.fontFamily }
    },
    series: seriesData,
    grid: NAPM_STYLE.grid
  };
}

/**
 * Render an ECharts option to a PNG buffer using SSR + sharp.
 * Uses system-installed CJK fonts via fontconfig (ensure fonts-wqy-microhei is installed).
 */
async function renderChartPngBuffer(option, width = 960, height = 540) {
  const echarts = require('echarts');
  const sharp = require('sharp');
  const chart = echarts.init(null, undefined, {
    renderer: 'svg',
    ssr: true,
    width,
    height
  });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function alignmentFromText(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'center') return AlignmentType.CENTER;
  if (text === 'right') return AlignmentType.RIGHT;
  return undefined;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

class InspectionFixedTemplateService {
  constructor(options = {}) {
    this.templateRoot = options.templateRoot || DEFAULT_TEMPLATE_ROOT;
    this.assetRoot = options.assetRoot || path.join(__dirname, '..');
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
    if (builder === 'basicDevices') {
      return { columns: section.columns, rows: buildBasicDeviceRows(inspection.devices) };
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
    if (builder === 'summaryDevicesTemplate') {
      return { columns: section.columns, rows: buildSummaryTemplateRows(inspection.summary || {}) };
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
      // 空段落占位，将封面标题推到页面垂直居中
      new Paragraph({
        spacing: { before: 5500, after: 0 },
        children: []
      }),
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 260 },
        children: [
          new TextRun({
            text: interpolate(section.title || '{{title}}', context),
            bold: true,
            size: 34,
            color: DEFAULT_TEXT_COLOR,
            font: DEFAULT_FONT
          })
        ]
      }),
      buildParagraph(interpolate(section.subtitle || '', context), {
        alignment: AlignmentType.CENTER,
        size: 24,
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

  renderParagraphs(section = {}, context = {}) {
    const children = [];
    if (section.title) {
      children.push(buildHeading(section.title, section.level || 2));
    }
    for (const text of asArray(section.paragraphs)) {
      children.push(buildParagraph(interpolate(text, context), {
        bold: Boolean(section.bold),
        size: section.size || 21,
        alignment: alignmentFromText(section.alignment),
        after: section.after ?? 100
      }));
    }
    return children;
  }

  renderToc(section = {}, context = {}) {
    return [
      buildParagraph(section.title || '目录', {
        bold: true,
        size: 28,
        alignment: AlignmentType.CENTER,
        after: 180
      }),
      new TableOfContents(section.alias || 'Inspection Report TOC', {
        hyperlink: section.hyperlink !== false,
        headingStyleRange: section.headingStyleRange || '1-2',
        hideTabAndPageNumbersInWebView: false
      }),
      buildParagraph('', { after: 120 })
    ];
  }

  renderStaticTable(section = {}, context = {}) {
    const rows = asArray(section.rows).map((row) => asArray(row).map((cell) => interpolate(cell, context)));
    const children = [];
    if (section.title) {
      children.push(buildHeading(section.title, section.level || 2));
    }
    if (section.caption) {
      children.push(buildCaption(section.caption));
    }
    children.push(buildTable({
      columns: section.columns || [],
      rows
    }));
    children.push(buildParagraph('', { after: 80 }));
    return children;
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

  renderDataParagraphs(section = {}, context = {}) {
    const children = [];
    if (section.title) {
      children.push(buildHeading(section.title, section.level || 2));
    }
    if (section.label) {
      children.push(buildParagraph(section.label, { bold: true, after: 80 }));
    }
    const values = asArray(getByPath(context, section.dataPath))
      .map((item) => {
        if (typeof item === 'string') return item;
        return item?.text || item?.message || item?.summary || '';
      })
      .filter((text) => String(text || '').trim());
    for (const text of values.length > 0 ? values : [section.emptyText || '正常。']) {
      children.push(buildParagraph(interpolate(text, context), { size: 21, after: 80 }));
    }
    return children;
  }

  /**
   * Pre-render all chartSlot sections to PNG buffers.
   * Returns Map<sectionId, Buffer>.
   */
  async preRenderCharts(template = {}, context = {}) {
    const chartSpecs = this.loadChartSpecs();
    const chartBuffers = new Map();
    const chartSlots = asArray(template.sections).filter((s) => s.type === 'chartSlot');

    for (const slot of chartSlots) {
      const chart = asArray(chartSpecs.charts).find((c) => c.id === slot.chartId) || {};
      const dataset = getByPath(context, chart.datasetPath || '');
      const dataPoints = Array.isArray(dataset)
        ? dataset.length
        : (Array.isArray(dataset?.points) ? dataset.points.length : 0);
      console.log(`[InspectionFixedTemplate] chart "${slot.id}" (${chart.chartType}): datasetPath=${chart.datasetPath}, dataPoints=${dataPoints}, hasData=${dataPoints > 0}`);
      if (dataPoints === 0) {
        console.warn(`[InspectionFixedTemplate] chart "${slot.id}" has NO DATA — check if inspection data contains "${chart.datasetPath}"`);
        continue;
      }
      const option = buildEChartsOption(chart, context);
      // Verify series data isn't all empty — log first few values
      const totalValues = (option.series || []).reduce((sum, s) => sum + (Array.isArray(s.data) ? s.data.length : 0), 0);
      const sampleValues = (option.series || []).map((s) => {
        const first3 = (Array.isArray(s.data) ? s.data.slice(0, 3) : []).join(',');
        return `${s.name}=[${first3}]`;
      }).join('; ');
      console.log(`[InspectionFixedTemplate] chart "${slot.id}": ${option.series.length} series, ${totalValues} total values — ${sampleValues}`);
      try {
        const width = Number(slot.width) || NAPM_STYLE.chartWidth;
        const height = Number(slot.height) || NAPM_STYLE.chartHeight;
        const buffer = await renderChartPngBuffer(option, width, height);
        chartBuffers.set(slot.id, { buffer, width, height });
      } catch (err) {
        console.error(`[InspectionFixedTemplate] Failed to render chart "${slot.id}":`, err.message);
      }
    }
    return chartBuffers;
  }

  renderChartSlot(section = {}, context = {}, chartBuffers = null) {
    const buffers = chartBuffers || this._chartBuffers || new Map();
    const cached = buffers.get(section.id);
    const children = [];
    if (section.title) {
      children.push(buildCaption(section.title));
    }
    if (cached && cached.buffer) {
      // Embed real chart PNG image
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [
          new ImageRun({
            type: 'png',
            data: cached.buffer,
            transformation: { width: cached.width || NAPM_STYLE.chartWidth, height: cached.height || NAPM_STYLE.chartHeight },
            altText: {
              title: section.title || 'chart',
              description: section.title || 'chart'
            }
          })
        ]
      }));
    } else {
      // Fallback: placeholder table when chart rendering failed / no data
      const chartSpecs = this.loadChartSpecs();
      const chart = asArray(chartSpecs.charts).find((item) => item.id === section.chartId) || {};
      children.push(buildTable({
        columns: ['图表槽位', '绑定内容'],
        rows: buildChartSlotRows(context, chart)
      }));
    }
    children.push(buildParagraph('', { after: 80 }));
    return children;
  }

  renderSection(section = {}, context = {}, chartBuffers = null) {
    // TOC pages are disabled for every report type. Ignore both the field and
    // its legacy page-break companion so stale templates cannot reintroduce it.
    if (section.type === 'toc' || section.id === 'toc_break') return [];
    if (section.type === 'cover') return this.renderCover(section, context);
    if (section.type === 'pageBreak') return [new Paragraph({ children: [new PageBreak()] })];
    if (section.type === 'heading') return [buildHeading(section.title, section.level || 1)];
    if (section.type === 'paragraphs') return this.renderParagraphs(section, context);
    if (section.type === 'staticTable') return this.renderStaticTable(section, context);
    if (section.type === 'keyValueTable') return this.renderKeyValueTable(section, context);
    if (section.type === 'table') return this.renderTableSection(section, context);
    if (section.type === 'dataParagraphs') return this.renderDataParagraphs(section, context);
    if (section.type === 'narrative') return this.renderNarrative(section, context);
    if (section.type === 'chartSlot') return this.renderChartSlot(section, context, chartBuffers);
    return [];
  }

  buildTemplateContext(report = {}) {
    const template = this.loadTemplate(report.templateId || this.defaultTemplateId);
    const context = this.buildContext({
      ...report,
      title: report.title || 'NAPM 巡检报告',
      templateId: report.templateId || template.templateId
    });
    return { template, context };
  }

  buildChildren(report = {}, chartBuffers = null) {
    const { template, context } = this.buildTemplateContext(report);
    return asArray(template.sections).flatMap((section) => this.renderSection(section, context, chartBuffers));
  }

  async renderDocx(report = {}) {
    const { template, context } = this.buildTemplateContext(report);
    // Pre-render all chartSlot PNGs before building document children
    this._chartBuffers = await this.preRenderCharts(template, context);
    const header = buildDocumentHeader(template, context, { assetRoot: this.assetRoot });
    const footer = buildDocumentFooter(template, context, { assetRoot: this.assetRoot });
    const section = {
      properties: buildPageProperties(template),
      children: asArray(template.sections).flatMap((item) => this.renderSection(item, context, this._chartBuffers))
    };
    if (header) section.headers = { default: header };
    if (footer) section.footers = { default: footer };

    const doc = new Document({
      creator: 'openclaw-napm-report',
      title: asText(report.title || 'NAPM 巡检报告'),
      description: 'Generated by OpenClaw NAPM report fixed inspection template',
      features: {
        updateFields: true
      },
      styles: buildDocumentStyles(),
      sections: [section]
    });

    const buffer = await Packer.toBuffer(doc);

    // Post-process: ensure linked character styles exist for heading styles.
    // The docx library generates w:link via the `link` style property, but
    // does NOT auto-generate the corresponding character styles (Heading1Char,
    // Heading2Char). Word requires both ends of the w:link pair to exist.
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
      const output = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
      return output;
    } catch (_) {
      return buffer;
    }
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
  buildEChartsOption,
  renderChartPngBuffer,
  NAPM_COLOR_PALETTE,
  NAPM_STYLE,
  buildDocumentFooter,
  buildDocumentHeader,
  readImageDimensions,
  buildImageRun,
  buildInlineRuns,
  buildPageProperties,
  resolveAssetPath,
  DEFAULT_FONT,
  DEFAULT_TEXT_COLOR,
  statusText
};
