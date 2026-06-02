class PdfExportService {
  async export() {
    const error = new Error('PDF 导出暂未启用。第一阶段只支持 docx，不能静默降级。');
    error.code = 'REPORT_PDF_EXPORT_UNAVAILABLE';
    throw error;
  }
}

module.exports = PdfExportService;
