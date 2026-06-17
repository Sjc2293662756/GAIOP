const {
  AlignmentType,
  BorderStyle,
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
const InspectionFixedTemplateService = require('./InspectionFixedTemplateService');

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

function normalizeRows(rows = []) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => {
    if (Array.isArray(row)) {
      return row.map(asText);
    }
    if (row && typeof row === 'object') {
      return Object.values(row).map(asText);
    }
    return [asText(row)];
  });
}

function buildParagraph(text = '', options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 160 },
    alignment: options.alignment,
    children: [
      new TextRun({
        text: asText(text),
        bold: Boolean(options.bold),
        size: options.size || 22,
        color: options.color || '1F2937'
      })
    ]
  });
}

function buildKeyValue(label, value) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}：`, bold: true, size: 20, color: '374151' }),
      new TextRun({ text: asText(value) || '-', size: 20, color: '374151' })
    ]
  });
}

function buildTable(section = {}) {
  const columns = Array.isArray(section.columns) ? section.columns.map(asText) : [];
  const rows = normalizeRows(section.rows);
  const effectiveColumns = columns.length > 0
    ? columns
    : rows[0]?.map((_, index) => `列${index + 1}`) || ['内容'];

  const tableRows = [
    new TableRow({
      tableHeader: true,
      children: effectiveColumns.map((column) => new TableCell({
        shading: { fill: 'E5E7EB' },
        margins: { top: 120, bottom: 120, left: 120, right: 120 },
        children: [buildParagraph(column, { bold: true, after: 0, size: 20 })]
      }))
    }),
    ...rows.map((row) => new TableRow({
      children: effectiveColumns.map((_, index) => new TableCell({
        margins: { top: 100, bottom: 100, left: 120, right: 120 },
        children: [buildParagraph(row[index] || '', { after: 0, size: 19 })]
      }))
    }))
  ];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tableRows
  });
}

function buildList(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return [buildParagraph('暂无。')];
  }
  return items.map((item) => new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 100 },
    children: [new TextRun({ text: asText(item), size: 21, color: '1F2937' })]
  }));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getByPath(source = {}, path = '') {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function valueOrDash(value) {
  const text = asText(value).trim();
  return text || '-';
}

function statusText(status = '') {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'ok') return '正常';
  if (value === 'warning') return '需关注';
  if (value === 'unknown') return '未确认';
  return valueOrDash(status);
}

function findingText(item = '') {
  if (typeof item === 'string') return item;
  return asText(item?.text || item?.message || item?.summary || item);
}

function evidenceText(item = {}) {
  if (typeof item === 'string') return item;
  return asArray(item?.evidenceRefs).join(', ') || asText(item?.evidenceRef);
}

function buildHeading(text = '', level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: 180, after: 120 },
    children: [
      new TextRun({
        text: asText(text),
        bold: true,
        size: level === HeadingLevel.HEADING_1 ? 27 : 23,
        color: level === HeadingLevel.HEADING_1 ? '0F766E' : '334155'
      })
    ]
  });
}

function buildTableBlock(title, columns, rows = []) {
  const children = [buildHeading(title, HeadingLevel.HEADING_2)];
  children.push(buildTable({
    columns,
    rows: Array.isArray(rows) && rows.length > 0 ? rows : []
  }));
  children.push(buildParagraph('', { after: 100 }));
  return children;
}

function buildSectionItemRows(section = {}) {
  return asArray(section.items).map((item, index) => [
    item?.index || index + 1,
    item?.name || '',
    valueOrDash(item?.value),
    valueOrDash(item?.remark)
  ]);
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
    valueOrDash(device?.systemName),
    valueOrDash(device?.ipAddress),
    valueOrDash(device?.softwareVersion),
    valueOrDash(device?.serialNumber),
    valueOrDash(device?.applianceTime),
    valueOrDash(device?.uptime)
  ]);
}

function buildSummaryRows(summary = {}) {
  return asArray(summary.devices).map((device, index) => [
    index + 1,
    valueOrDash(device?.deviceName),
    valueOrDash(device?.cpuUsage),
    valueOrDash(device?.diskUsage),
    valueOrDash(device?.packetDrops),
    valueOrDash(device?.health),
    valueOrDash(device?.remark)
  ]);
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
        valueOrDash(window.title),
        asArray(window.dataset.points).length,
        valueOrDash(stats.max),
        valueOrDash(stats.min),
        valueOrDash(stats.avg),
        valueOrDash(stats.missingPointCount),
        valueOrDash(stats.zeroSegmentCount),
        valueOrDash(stats.spikeCount)
      ];
    });
}

function pickDatasetPoints(points = [], limit = 12) {
  const normalized = asArray(points);
  if (normalized.length <= limit) return normalized;
  const headCount = Math.ceil(limit / 2);
  const tailCount = Math.floor(limit / 2);
  return [
    ...normalized.slice(0, headCount),
    ...normalized.slice(-tailCount)
  ];
}

function buildTrafficPointRows(window = {}) {
  const metrics = asArray(window?.dataset?.metrics);
  return pickDatasetPoints(window?.dataset?.points).map((point, index) => [
    index + 1,
    valueOrDash(point?.time || point?.timestamp),
    ...metrics.map((metric) => valueOrDash(point?.[metric]))
  ]);
}

function buildBusinessSlowRows(businessPerformance = {}) {
  return asArray(businessPerformance.slowAccess).map((row, index) => [
    index + 1,
    valueOrDash(row?.businessName),
    valueOrDash(row?.ratio),
    valueOrDash(row?.slowCount),
    valueOrDash(row?.avgPageDelayMs),
    valueOrDash(row?.evidenceRef)
  ]);
}

function buildBusinessErrorRows(businessPerformance = {}) {
  return asArray(businessPerformance.httpErrors).map((row, index) => [
    index + 1,
    valueOrDash(row?.businessName),
    valueOrDash(row?.http400),
    valueOrDash(row?.http500),
    asArray(row?.evidenceRefs).join(', ')
  ]);
}

function collectInspectionEvidence(inspection = {}, audit = {}) {
  const evidence = [];
  const append = (item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) evidence.push(item);
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
    valueOrDash(item?.id || item?.service),
    valueOrDash(item?.service),
    asArray(item?.groups).map((group) => group?.type || group).join(' > '),
    asArray(item?.metrics).join(', '),
    valueOrDash(item?.topMetric || item?.granularity),
    item?.start || item?.end ? `${valueOrDash(item?.start)} ~ ${valueOrDash(item?.end)}` : '-',
    valueOrDash(item?.requestUrlRedacted)
  ]);
}

function buildInspectionChildren(report = {}) {
  const section = asArray(report.sections).find((item) => item?.type === 'inspection') || {};
  const inspection = report.inspection || getByPath(report, section.dataPath || 'inspection') || {};
  const trafficAnalysis = inspection.trafficAnalysis || {};
  const businessPerformance = inspection.businessPerformance || {};
  const summary = inspection.summary || {};
  const evidence = collectInspectionEvidence(inspection, report.audit || {});
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 },
      children: [
        new TextRun({
          text: asText(report.title || 'NAPM 巡检报告'),
          bold: true,
          size: 34,
          color: '111827'
        })
      ]
    }),
    buildParagraph('报告基础信息', { bold: true, size: 26, color: '0F766E' }),
    buildTable({
      columns: ['项目', '内容'],
      rows: [
        ['客户名称', valueOrDash(inspection.customerName)],
        ['项目名称', valueOrDash(inspection.projectName)],
        ['巡检日期', valueOrDash(inspection.reportDate)],
        ['报告类型', valueOrDash(report.reportType)],
        ['模板', valueOrDash(report.templateId)],
        ['数据来源', valueOrDash(report?.dataSource?.sourceSkill || report?.dataSource?.system)],
        ['总体状态', statusText(summary.overallStatus)]
      ]
    }),
    buildParagraph('', { after: 160 }),
    buildHeading('一、设备基本信息')
  ];

  children.push(...buildTableBlock(
    '设备清单',
    ['序号', '系统名称', 'IP地址', '软件版本', '序列号', '设备时间', '运行时长'],
    buildDeviceRows(inspection.devices)
  ));

  children.push(buildHeading('二、设备状态巡检'));
  children.push(...buildTableBlock(
    '性能状况',
    ['序号', '检查项', '检查值', '备注'],
    buildSectionItemRows(inspection.performance)
  ));
  children.push(...buildTableBlock(
    '性能结论',
    ['序号', '级别', '结论', '证据'],
    buildFindingsRows(inspection.performance?.findings)
  ));
  children.push(...buildTableBlock(
    '数据信息',
    ['序号', '检查项', '检查值', '备注'],
    buildSectionItemRows(inspection.dataRetention)
  ));
  children.push(...buildTableBlock(
    '配置信息',
    ['序号', '检查项', '检查值', '备注'],
    buildSectionItemRows(inspection.configuration)
  ));
  children.push(...buildTableBlock(
    '原始数据包存储',
    ['序号', '检查项', '检查值', '备注'],
    buildSectionItemRows(inspection.packetStorage)
  ));

  children.push(buildHeading('三、流量分析状况'));
  children.push(...buildTableBlock(
    '流量趋势统计',
    ['窗口', '名称', '数据点', '最大值', '最小值', '平均值', '缺失点', '零流量点', '尖峰点'],
    buildTrafficStatsRows(trafficAnalysis)
  ));
  for (const [title, window] of [
    ['最近1小时趋势样本', trafficAnalysis.recentHour],
    ['最近1天趋势样本', trafficAnalysis.recentDay]
  ]) {
    if (window?.dataset) {
      children.push(...buildTableBlock(
        title,
        ['序号', '时间', ...asArray(window.dataset.metrics)],
        buildTrafficPointRows(window)
      ));
    }
  }
  children.push(...buildTableBlock(
    '流量分析结论',
    ['序号', '级别', '结论', '证据'],
    buildFindingsRows(trafficAnalysis.findings)
  ));

  children.push(buildHeading('四、业务性能状况'));
  children.push(...buildTableBlock(
    '慢访问业务',
    ['序号', '业务', '慢访问占比', '慢访问次数', '平均页面时延(ms)', '证据'],
    buildBusinessSlowRows(businessPerformance)
  ));
  children.push(...buildTableBlock(
    'HTTP 400/500 业务',
    ['序号', '业务', 'HTTP 400', 'HTTP 500', '证据'],
    buildBusinessErrorRows(businessPerformance)
  ));
  children.push(...buildTableBlock(
    '业务性能结论',
    ['序号', '级别', '结论', '证据'],
    buildFindingsRows(businessPerformance.findings)
  ));

  children.push(buildHeading('五、巡检总结'));
  children.push(...buildTableBlock(
    '设备健康汇总',
    ['序号', '设备', 'CPU使用', '磁盘使用', '丢包数', '健康状态', '备注'],
    buildSummaryRows(summary)
  ));
  children.push(buildParagraph(valueOrDash(summary.conclusion), { size: 22 }));
  if (asArray(summary.abnormalItems).length > 0) {
    children.push(...buildTableBlock(
      '需关注事项',
      ['序号', '事项'],
      asArray(summary.abnormalItems).map((item, index) => [index + 1, item])
    ));
  }
  children.push(...buildTableBlock(
    '查询证据',
    ['序号', 'ID', '服务', '分组', '指标', '排序/粒度', '时间范围', '请求URL(已打码)'],
    buildEvidenceRows(evidence)
  ));

  return children;
}

class ReportTemplateService {
  constructor(options = {}) {
    this.inspectionFixedTemplate = options.inspectionFixedTemplate || new InspectionFixedTemplateService(options);
  }

  async renderDocx(report = {}) {
    if (report.reportType === 'inspection_report' || report.templateId === 'napm_traffic_health_inspection_v1') {
      return this.renderInspectionDocx(report);
    }

    const children = [
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 260 },
        children: [
          new TextRun({
            text: asText(report.title || 'NAPM 分析报告'),
            bold: true,
            size: 34,
            color: '111827'
          })
        ]
      }),
      buildParagraph('报告基础信息', { bold: true, size: 26, color: '0F766E' }),
      buildKeyValue('报告类型', report.reportType),
      buildKeyValue('生成格式', report.format),
      buildKeyValue('原始问题', report.sourceQuestion),
      buildKeyValue('时间范围', report?.timeRange?.displayText),
      buildKeyValue('开始时间戳', report?.timeRange?.start),
      buildKeyValue('结束时间戳', report?.timeRange?.end),
      buildKeyValue('数据来源', report?.dataSource?.system || 'NAPM'),
      buildKeyValue('查询服务', report?.dataSource?.queryService),
      buildKeyValue('对象类型', report?.dataSource?.objectType),
      buildKeyValue('指标', Array.isArray(report?.dataSource?.metrics) ? report.dataSource.metrics.join(', ') : report?.dataSource?.metrics),
      new Paragraph({
        border: {
          bottom: {
            color: 'CBD5E1',
            style: BorderStyle.SINGLE,
            size: 6
          }
        },
        spacing: { after: 240 }
      })
    ];

    for (const section of report.sections || []) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 120, after: 160 },
        children: [
          new TextRun({
            text: asText(section.title || section.type || '报告章节'),
            bold: true,
            size: 27,
            color: '0F766E'
          })
        ]
      }));

      if (section.type === 'table') {
        children.push(buildTable(section));
        children.push(buildParagraph('', { after: 120 }));
      } else if (Array.isArray(section.items)) {
        children.push(...buildList(section.items));
      } else {
        children.push(buildParagraph(section.content || '暂无内容。'));
      }
    }

    if (report.audit && Object.keys(report.audit).length > 0) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 180, after: 120 },
        children: [new TextRun({ text: '审计信息', bold: true, size: 27, color: '0F766E' })]
      }));
      children.push(buildParagraph(JSON.stringify(report.audit, null, 2), { size: 18 }));
    }

    const doc = new Document({
      creator: 'openclaw-napm-report',
      title: asText(report.title || 'NAPM 分析报告'),
      description: 'Generated by OpenClaw NAPM report skill',
      sections: [
        {
          properties: {},
          children
        }
      ]
    });

    return Packer.toBuffer(doc);
  }

  async renderInspectionDocx(report = {}) {
    return this.inspectionFixedTemplate.renderDocx(report);
  }
}

module.exports = ReportTemplateService;
module.exports.__test__ = {
  asText,
  normalizeRows,
  buildInspectionChildren,
  buildTrafficStatsRows,
  buildBusinessSlowRows,
  buildEvidenceRows,
  statusText
};
