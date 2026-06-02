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

class ReportTemplateService {
  async renderDocx(report = {}) {
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
}

module.exports = ReportTemplateService;
module.exports.__test__ = {
  asText,
  normalizeRows
};
