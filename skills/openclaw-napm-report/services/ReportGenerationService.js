const ReportStorageService = require('./ReportStorageService');
const ReportTemplateService = require('./ReportTemplateService');
const PdfExportService = require('./PdfExportService');

const SUPPORTED_REPORT_TYPES = new Set([
  'quick_report',
  'diagnostic_report',
  'comparative_report',
  'operation_report',
  'inspection_report'
]);

const SUPPORTED_FORMATS = new Set(['docx']);

function makeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeFormat(format = '') {
  return String(format || '').trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

class ReportGenerationService {
  constructor(options = {}) {
    this.storage = options.storage || new ReportStorageService(options);
    this.template = options.template || new ReportTemplateService(options);
    this.pdf = options.pdf || new PdfExportService(options);
  }

  validate(report = {}) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw makeError('REPORT_DATA_INVALID', '报告生成失败：输入必须是对象。');
    }

    const reportType = String(report.reportType || '').trim();
    if (!reportType || !SUPPORTED_REPORT_TYPES.has(reportType)) {
      throw makeError('REPORT_DATA_INVALID', '报告生成失败：reportType 缺失或不受支持。', {
        supportedReportTypes: Array.from(SUPPORTED_REPORT_TYPES)
      });
    }

    const format = normalizeFormat(report.format);
    if (!format) {
      throw makeError('REPORT_DATA_INVALID', '报告生成失败：format 缺失。');
    }

    if (format === 'pdf') {
      throw makeError('REPORT_PDF_EXPORT_UNAVAILABLE', 'PDF 导出暂未启用。第一阶段只支持 docx，不能静默降级。');
    }

    if (!SUPPORTED_FORMATS.has(format)) {
      throw makeError('REPORT_FORMAT_UNSUPPORTED', `报告生成失败：暂不支持 ${format} 格式。`, {
        supportedFormats: Array.from(SUPPORTED_FORMATS)
      });
    }

    if (!Array.isArray(report.sections) || report.sections.length === 0) {
      throw makeError('REPORT_DATA_INVALID', '报告生成失败：缺少 sections 或查询结果为空。');
    }

    for (const [index, section] of report.sections.entries()) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw makeError('REPORT_DATA_INVALID', `报告生成失败：sections[${index}] 必须是对象。`);
      }
      if (!section.type) {
        throw makeError('REPORT_DATA_INVALID', `报告生成失败：sections[${index}].type 缺失。`);
      }
      if (section.type === 'table' && !Array.isArray(section.rows)) {
        throw makeError('REPORT_DATA_INVALID', `报告生成失败：sections[${index}].rows 必须是数组。`);
      }
    }

    return {
      ...report,
      reportType,
      format,
      title: String(report.title || 'NAPM 分析报告').trim() || 'NAPM 分析报告'
    };
  }

  async generate(report = {}) {
    try {
      const normalized = this.validate(report);
      const generatedAt = normalized.generatedAt || nowIso();
      const reportWithMeta = {
        ...normalized,
        generatedAt
      };
      const reportId = this.storage.createReportId(reportWithMeta);
      const paths = this.storage.buildPaths(reportId, normalized.format);

      let buffer;
      if (normalized.format === 'docx') {
        buffer = await this.template.renderDocx(reportWithMeta);
      } else if (normalized.format === 'pdf') {
        buffer = await this.pdf.export(reportWithMeta);
      }

      this.storage.writeBuffer(paths.filePath, buffer);
      this.storage.writeAuditJson(paths.auditPath, {
        ...reportWithMeta,
        reportId,
        filePath: paths.filePath,
        downloadUrl: paths.downloadUrl
      });

      return {
        ok: true,
        reportId,
        title: reportWithMeta.title,
        format: normalized.format,
        filePath: paths.filePath,
        auditPath: paths.auditPath,
        downloadUrl: paths.downloadUrl,
        generatedAt
      };
    } catch (error) {
      return {
        ok: false,
        errorCode: error?.code || 'REPORT_GENERATION_FAILED',
        message: error?.message || String(error),
        details: error?.details || undefined
      };
    }
  }
}

module.exports = ReportGenerationService;
module.exports.__test__ = {
  normalizeFormat,
  SUPPORTED_FORMATS,
  SUPPORTED_REPORT_TYPES
};
