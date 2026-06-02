const fs = require('fs');
const path = require('path');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestampForId(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('')
    + '-'
    + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join('');
}

function sanitizeFileSegment(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

class ReportStorageService {
  constructor(options = {}) {
    const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
    this.outputDir = path.resolve(
      options.outputDir
      || process.env.NAPM_REPORT_OUTPUT_DIR
      || path.join(workspaceRoot, 'skills/openclaw-napm-report/output')
    );
    this.downloadBaseUrl = String(
      options.downloadBaseUrl
      || process.env.NAPM_REPORT_DOWNLOAD_BASE_URL
      || '/reports'
    ).replace(/\/+$/g, '');
  }

  ensureOutputDir() {
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  createReportId(report = {}, date = new Date()) {
    const timestamp = formatTimestampForId(date);
    const suffix = Math.random().toString(36).slice(2, 8);
    const type = sanitizeFileSegment(report.reportType || 'report') || 'report';
    return `napm-${type}-${timestamp}-${suffix}`;
  }

  buildPaths(reportId, format) {
    const normalizedFormat = String(format || '').trim().toLowerCase();
    const fileName = `${reportId}.${normalizedFormat}`;
    return {
      fileName,
      filePath: path.join(this.outputDir, fileName),
      auditPath: path.join(this.outputDir, `${reportId}.json`),
      downloadUrl: `${this.downloadBaseUrl}/${encodeURIComponent(fileName)}`
    };
  }

  writeBuffer(filePath, buffer) {
    this.ensureOutputDir();
    fs.writeFileSync(filePath, buffer);
  }

  writeAuditJson(filePath, payload) {
    this.ensureOutputDir();
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

module.exports = ReportStorageService;
module.exports.__test__ = {
  formatTimestampForId,
  sanitizeFileSegment
};
