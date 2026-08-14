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
    + '_'
    + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join('');
}

/**
 * 报告类型 → 中文名称映射。
 * 新增报告类型时在此追加映射即可。
 */
const REPORT_TYPE_CN = {
  quick_report: '快速报告',
  diagnostic_report: '故障分析报告',
  comparative_report: '对比报告',
  operation_report: '运维报告',
  inspection_report: '巡检报告',
  summary_report: '综述报告'
};

function sanitizeFileSegment(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

function resolveSystemName(report = {}) {
  return sanitizeFileSegment(
    report.systemName
    || (report.dataSource && report.dataSource.system)
    || 'NAPM'
  ) || 'NAPM';
}

function resolveFaultName(report = {}) {
  return sanitizeFileSegment(
    report.faultName
    || report.title
    || '未命名故障'
  ) || '未命名故障';
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

  /**
   * 生成人可读的报告文件名（不含扩展名）。
   *
   * 常规报告： {SystemName}_{类型中文}_{YYYYMMDD}_{HHmmss}
   *   示例： Netlnside基于AI的全流量性能分析平台_巡检报告_20260618_143052
   *
   * 故障分析报告： {FaultName}_故障分析报告_{YYYYMMDD}_{HHmmss}
   *   示例： 核心交换机端口故障_故障分析报告_20260618_143052
   *
   * 综述报告：
   *   全局： {SystemName}_全局综述报告_{YYYYMMDD}_{HHmmss}
   *   分类： {TargetLabel}_{ScopeLabel}综述报告_{YYYYMMDD}_{HHmmss}
   */
  createReportId(report = {}, date = new Date()) {
    const timestamp = formatTimestampForId(date);
    const reportType = String(report.reportType || 'report').trim();
    const typeCN = REPORT_TYPE_CN[reportType] || '报告';

    if (reportType === 'diagnostic_report') {
      const faultName = resolveFaultName(report);
      return `${faultName}_${typeCN}_${timestamp}`;
    }

    if (reportType === 'summary_report') {
      const scope = report.scope || {};
      const scopeType = scope.type || 'global';
      const scopeLabel = scope.label || '全局';
      const hasTarget = scope.target && (scope.target.groupArgument || scope.target.groupLabel);
      if (scopeType === 'global' || !hasTarget) {
        const systemName = resolveSystemName(report);
        return `${systemName}_${scopeLabel}综述报告_${timestamp}`;
      }
      const targetLabel = sanitizeFileSegment(scope.target.groupLabel || scope.target.groupArgument || '未知对象');
      return `${targetLabel}_${scopeLabel}综述报告_${timestamp}`;
    }

    const systemName = resolveSystemName(report);
    return `${systemName}_${typeCN}_${timestamp}`;
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
  sanitizeFileSegment,
  REPORT_TYPE_CN,
  resolveSystemName,
  resolveFaultName
};
