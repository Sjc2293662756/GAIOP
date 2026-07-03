'use strict';

/**
 * Build the standardized reportData object consumed by openclaw-napm-report.
 *
 * This service takes the raw summary result (from SummaryService.run())
 * and produces the reportData contract defined in:
 *   docs/2026-06-18-综述报告设计方案.md §5
 */

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function sanitizeFileSegment(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

class SummaryReportDataService {
  /**
   * @param {object} result — the output from SummaryService.run()
   * @param {object} options — overrides: format, title, systemName, sourceQuestion
   */
  buildReportData(result = {}, options = {}) {
    const scope = isPlainObject(result.scope) ? result.scope : { type: 'global', label: '全局' };

    // ── Fault diagnosis: output diagnostic_report shape ──
    if (scope.type === 'fault') {
      return this.buildFaultDiagnosisReportData(result, options);
    }

    const summary = isPlainObject(result.summary) ? result.summary : {};
    const timeRange = isPlainObject(result.timeRange) ? result.timeRange : {};

    const scopeType = scope.type || 'global';
    const scopeLabel = scope.label || '全局';
    const scopeTarget = isPlainObject(scope.target) ? scope.target : null;
    const scopeTargetLabel = scopeTarget?.groupLabel || '';

    // Title
    const defaultTitle = scopeType === 'global'
      ? 'Netlnside流量分析系统_全局综述报告'
      : `${scopeTargetLabel}_${scopeLabel}综述报告`;
    const title = String(options.title || defaultTitle).trim() || defaultTitle;

    // System name
    const systemName = sanitizeFileSegment(
      options.systemName
      || summary.deviceInfo?.systemName
      || 'Netlnside流量分析系统'
    ) || 'Netlnside流量分析系统';

    return {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'summary_report',
      templateId: 'napm_summary_overview_v1',
      format: this._normalizeFormat(options.format || 'docx'),
      defaultFormat: 'docx',
      title,
      systemName,
      sourceQuestion: String(options.sourceQuestion || options.prompt || '').trim() || undefined,
      timeRange: {
        start: Number(timeRange.start) || undefined,
        end: Number(timeRange.end) || undefined,
        displayText: timeRange.displayText || ''
      },
      scope: {
        type: scopeType,
        label: scopeLabel,
        target: scopeTarget
      },
      dataSource: {
        system: systemName,
        sourceSkill: 'openclaw-napm-summary',
        queryService: `summaryAggregation:${scopeType}`
      },
      summary,
      audit: {
        sourceSkill: 'openclaw-napm-summary',
        sourceSchema: String(result.schema || '').trim() || undefined,
        requestHistory: result.audit?.requestHistory || [],
        queriesPerformed: result.audit?.queriesPerformed || []
      }
    };
  }

  /**
   * Build diagnostic_report shaped reportData for the fault analysis template.
   */
  buildFaultDiagnosisReportData(result = {}, options = {}) {
    const scope = isPlainObject(result.scope) ? result.scope : { type: 'fault', label: '故障分析' };
    const timeRange = isPlainObject(result.timeRange) ? result.timeRange : {};
    const fault = isPlainObject(result.fault) ? result.fault : {};
    const alertAnalysis = isPlainObject(result.alertAnalysis) ? result.alertAnalysis : {};
    const trafficAnalysis = isPlainObject(result.trafficAnalysis) ? result.trafficAnalysis : {};
    const businessAnalysis = isPlainObject(result.businessAnalysis) ? result.businessAnalysis : {};

    // Collapse timeRange for the template — the template uses flat start/end
    const flatTimeRange = {
      start: timeRange.faultWindow?.start || timeRange.start,
      end: timeRange.faultWindow?.end || timeRange.end,
      displayText: timeRange.displayText || '',
      baselineStart: timeRange.baselineWindow?.start || undefined,
      baselineEnd: timeRange.baselineWindow?.end || undefined
    };

    const faultName = sanitizeFileSegment(
      (isPlainObject(scope.fault) ? scope.fault.description : '')
      || fault.description
      || options.faultName
      || '未命名故障'
    ) || '未命名故障';

    const title = String(
      options.title || `${faultName}_故障分析报告`
    ).trim() || `${faultName}_故障分析报告`;

    const systemName = sanitizeFileSegment(
      options.systemName
      || result.deviceInfo?.systemName
      || 'Netlnside流量分析系统'
    ) || 'Netlnside流量分析系统';

    // Packet analysis results (may be injected by upstream)
    const packetAnalysis = isPlainObject(result.packetAnalysis)
      ? result.packetAnalysis
      : (isPlainObject(options.packetAnalysis) ? options.packetAnalysis : null);

    return {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'diagnostic_report',
      templateId: 'napm_bs_fault_diagnosis_v2',
      format: this._normalizeFormat(options.format || result.format || 'docx'),
      defaultFormat: 'docx',
      title,
      systemName,
      faultName,
      sourceQuestion: String(options.sourceQuestion || options.prompt || '').trim() || undefined,
      timeRange: flatTimeRange,
      dataSource: {
        system: systemName,
        sourceSkill: 'openclaw-napm-summary',
        queryService: 'faultDiagnosis'
      },
      fault,
      alertAnalysis,
      trafficAnalysis,
      businessAnalysis,
      packetAnalysis,
      audit: {
        sourceSkill: 'openclaw-napm-summary',
        sourceSchema: String(result.schema || '').trim() || undefined,
        requestHistory: result.audit?.requestHistory || [],
        queriesPerformed: result.audit?.queriesPerformed || []
      }
    };
  }

  _normalizeFormat(format = '') {
    const value = String(format || '').trim().toLowerCase();
    if (value === 'word' || value === 'doc') return 'docx';
    return value || 'docx';
  }
}

module.exports = SummaryReportDataService;
