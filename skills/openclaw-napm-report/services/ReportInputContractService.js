function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeFormat(format = '') {
  const value = String(format || '').trim().toLowerCase();
  if (value === 'word' || value === 'doc') {
    return 'docx';
  }
  return value || 'docx';
}

function compactJson(value, maxLength = 1600) {
  if (value == null) {
    return '';
  }
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (_error) {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function normalizeScalarRows(source = {}) {
  if (!isPlainObject(source)) {
    return [];
  }
  return Object.entries(source)
    .filter(([, value]) => value !== undefined && value !== null && !isPlainObject(value) && !Array.isArray(value))
    .map(([key, value]) => [key, compactJson(value, 500)]);
}

function rowsFromObjectList(items = [], preferredKeys = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, 30).map((item, index) => {
    if (!isPlainObject(item)) {
      return [index + 1, compactJson(item, 500)];
    }
    if (preferredKeys.length > 0) {
      return preferredKeys.map((key, keyIndex) => (
        keyIndex === 0 && key === '#'
          ? index + 1
          : compactJson(item[key], 500)
      ));
    }
    return [index + 1, compactJson(item, 800)];
  });
}

function makeCriteriaSummary(criteria = {}) {
  if (!isPlainObject(criteria)) {
    return '';
  }
  const parts = [];
  if (Array.isArray(criteria.ips) && criteria.ips.length > 0) {
    parts.push(`IPs: ${criteria.ips.filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(criteria.ipRanges) && criteria.ipRanges.length > 0) {
    parts.push(`IP ranges: ${criteria.ipRanges.filter(Boolean).join(', ')}`);
  }
  if (criteria.id) {
    parts.push(`id: ${criteria.id}`);
  }
  if (criteria.instanceId) {
    parts.push(`instanceId: ${criteria.instanceId}`);
  }
  if (criteria.start || criteria.end) {
    parts.push(`time: ${criteria.start || '-'} ~ ${criteria.end || '-'}`);
  }
  return parts.join('; ');
}

function isSummarySourceResult(result = {}) {
  if (!isPlainObject(result)) {
    return false;
  }
  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  return String(result?.reportData?.reportType || '').trim() === 'summary_report'
    || String(result.schema || '').trim() === 'openclaw_napm_summary_result.v1'
    || String(narrationInput.schema || '').trim() === 'openclaw_napm_summary.v1'
    || (isPlainObject(result.summary) && String(result.summary?.overallStatus || ''));
}

function isPacketSourceResult(result = {}) {
  if (!isPlainObject(result)) {
    return false;
  }
  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  return String(narrationInput.schema || result.schema || '').trim() === 'openclaw_napm_packet_analysis.v1'
    || Boolean(result.urls && (result.urls.preview || result.urls.download))
    || Boolean(result.preview || result.download || result.analysis);
}

function isFaultDiagnosisSourceResult(result = {}) {
  if (!isPlainObject(result)) {
    return false;
  }
  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  const templateId = String(result?.reportData?.templateId || '').trim();
  return String(result?.reportData?.reportType || '').trim() === 'diagnostic_report'
    && (templateId === 'napm_bs_fault_diagnosis_v2' || templateId === 'napm_cs_fault_diagnosis_v1')
    || String(result.schema || '').trim() === 'openclaw_napm_fault_diagnosis_result.v1'
    || String(narrationInput.schema || '').trim() === 'openclaw_napm_fault_diagnosis.v1'
    || (isPlainObject(result.alertAnalysis) && isPlainObject(result.trafficAnalysis));
}

function isInspectionSourceResult(result = {}) {
  if (!isPlainObject(result)) {
    return false;
  }
  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  return String(result?.reportData?.reportType || '').trim() === 'inspection_report'
    || String(result.schema || '').trim() === 'openclaw_napm_inspection_result.v1'
    || String(narrationInput.schema || '').trim() === 'openclaw_napm_inspection.v1'
    || isPlainObject(result.inspection);
}

function buildFaultDiagnosisReportData(result = {}, options = {}) {
  if (!isFaultDiagnosisSourceResult(result)) {
    return null;
  }
  if (isPlainObject(result.reportData)) {
    return {
      ...result.reportData,
      format: normalizeFormat(options.format || result.reportData.format || result.reportData.defaultFormat)
    };
  }

  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  const fault = isPlainObject(result.fault)
    ? result.fault
    : (isPlainObject(narrationInput.fault) ? narrationInput.fault : {});
  const alertAnalysis = isPlainObject(result.alertAnalysis)
    ? result.alertAnalysis
    : (isPlainObject(narrationInput.alertAnalysis) ? narrationInput.alertAnalysis : {});
  const trafficAnalysis = isPlainObject(result.trafficAnalysis)
    ? result.trafficAnalysis
    : (isPlainObject(narrationInput.trafficAnalysis) ? narrationInput.trafficAnalysis : {});
  const businessAnalysis = isPlainObject(result.businessAnalysis)
    ? result.businessAnalysis
    : (isPlainObject(narrationInput.businessAnalysis) ? narrationInput.businessAnalysis : {});
  const packetAnalysis = isPlainObject(result.packetAnalysis)
    ? result.packetAnalysis
    : (isPlainObject(narrationInput.packetAnalysis) ? narrationInput.packetAnalysis : null);

  const timeRange = isPlainObject(result.timeRange) ? result.timeRange : {};
  const flatTimeRange = {
    start: timeRange.faultWindow?.start || timeRange.start,
    end: timeRange.faultWindow?.end || timeRange.end,
    displayText: timeRange.displayText || '',
    baselineStart: timeRange.baselineWindow?.start || undefined,
    baselineEnd: timeRange.baselineWindow?.end || undefined
  };

  const faultName = String(
    options.faultName
    || result.faultName
    || fault.description
    || '未命名故障'
  ).trim() || '未命名故障';

  const systemName = String(
    options.systemName
    || result.systemName
    || result.deviceInfo?.systemName
    || 'Netlnside基于AI的全流量性能分析平台'
  ).trim() || 'Netlnside基于AI的全流量性能分析平台';

  const title = String(
    options.title || result.title || `${faultName}_故障分析报告`
  ).trim() || `${faultName}_故障分析报告`;

  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'diagnostic_report',
    templateId: 'napm_bs_fault_diagnosis_v2',
    format: normalizeFormat(options.format || result.format || 'docx'),
    defaultFormat: 'docx',
    title,
    systemName,
    faultName,
    sourceQuestion: String(options.sourceQuestion || options.prompt || result.sourceQuestion || '').trim() || undefined,
    timeRange: flatTimeRange,
    dataSource: {
      system: systemName,
      sourceSkill: result.audit?.sourceSkill || result.dataSource?.sourceSkill || 'openclaw-napm-summary',
      queryService: 'faultDiagnosis'
    },
    fault,
    alertAnalysis,
    trafficAnalysis,
    businessAnalysis,
    packetAnalysis,
    audit: {
      sourceSkill: result.audit?.sourceSkill || 'openclaw-napm-summary',
      sourceSchema: String(result.schema || narrationInput.schema || '').trim() || undefined,
      requestHistory: result.audit?.requestHistory || [],
      queriesPerformed: result.audit?.queriesPerformed || []
    }
  };
}

function buildInspectionReportData(result = {}, options = {}) {
  if (!isInspectionSourceResult(result)) {
    return null;
  }
  if (isPlainObject(result.reportData)) {
    return {
      ...result.reportData,
      format: normalizeFormat(options.format || result.reportData.format || result.reportData.defaultFormat)
    };
  }

  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  const inspection = isPlainObject(result.inspection)
    ? result.inspection
    : (isPlainObject(narrationInput.inspection) ? narrationInput.inspection : result);
  const title = String(
    options.title
    || result.title
    || result.summary?.title
    || `${inspection.customerName ? `${inspection.customerName}` : ''}NAPM 巡检报告`
  ).trim() || 'NAPM 巡检报告';

  const systemName = String(
    options.systemName
    || result.systemName
    || inspection.customerName
    || 'Netlnside基于AI的全流量性能分析平台'
  ).trim() || 'Netlnside基于AI的全流量性能分析平台';

  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'inspection_report',
    templateId: 'napm_traffic_health_inspection_v1',
    format: normalizeFormat(options.format || result.format || 'docx'),
    defaultFormat: 'docx',
    title,
    systemName,
    sourceQuestion: String(options.sourceQuestion || options.prompt || result.sourceQuestion || '').trim() || undefined,
    dataSource: {
      system: systemName,
      sourceSkill: 'openclaw-napm-inspection',
      queryService: 'inspectionSnapshot'
    },
    inspection,
    sections: [
      {
        type: 'inspection',
        title: '巡检报告',
        dataPath: 'inspection'
      }
    ],
    audit: {
      sourceSkill: 'openclaw-napm-inspection',
      sourceSchema: String(result.schema || narrationInput.schema || inspection.schema || '').trim() || undefined,
      reportInputSource: isPlainObject(result.inspection) ? 'sourceResult.inspection' : 'inspection'
    }
  };
}

function buildPacketReportData(result = {}, options = {}) {
  if (!isPacketSourceResult(result)) {
    return null;
  }

  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  const summary = isPlainObject(result.summary) ? result.summary : {};
  const criteria = isPlainObject(result.criteria)
    ? result.criteria
    : (isPlainObject(narrationInput.criteria) ? narrationInput.criteria : {});
  const urls = isPlainObject(result.urls)
    ? result.urls
    : (isPlainObject(narrationInput.urls) ? narrationInput.urls : {});
  const preview = isPlainObject(result.preview)
    ? result.preview
    : (isPlainObject(narrationInput.preview) ? narrationInput.preview : null);
  const download = isPlainObject(result.download)
    ? result.download
    : (isPlainObject(narrationInput.download) ? narrationInput.download : null);
  const analysis = isPlainObject(result.analysis)
    ? result.analysis
    : (isPlainObject(narrationInput.analysis) ? narrationInput.analysis : null);
  const highlights = Array.isArray(summary.highlights)
    ? summary.highlights.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const sections = [];

  sections.push({
    type: 'summary',
    title: '数据包分析摘要',
    content: highlights.length > 0
      ? highlights.join('\n')
      : compactJson(summary || result.error || result.decision || result, 1800)
  });

  const criteriaSummary = makeCriteriaSummary(criteria);
  if (criteriaSummary) {
    sections.push({
      type: 'summary',
      title: '分析范围',
      content: criteriaSummary
    });
  }

  const urlRows = [];
  if (urls.preview) urlRows.push(['preview', urls.preview]);
  if (urls.download) urlRows.push(['download', urls.download]);
  if (urls.input) urlRows.push(['input', urls.input]);
  if (urlRows.length > 0) {
    sections.push({
      type: 'table',
      title: '数据包接口链接',
      columns: ['类型', '链接'],
      rows: urlRows
    });
  }

  if (preview) {
    sections.push({
      type: 'table',
      title: '预览结果',
      columns: ['字段', '值'],
      rows: normalizeScalarRows(preview)
    });
  }

  if (download) {
    sections.push({
      type: 'table',
      title: '下载结果',
      columns: ['字段', '值'],
      rows: normalizeScalarRows(download)
    });
  }

  if (analysis) {
    if (isPlainObject(analysis.capinfos)) {
      sections.push({
        type: 'table',
        title: '抓包文件元信息',
        columns: ['字段', '值'],
        rows: Object.entries(analysis.capinfos).slice(0, 40).map(([key, value]) => [key, compactJson(value, 500)])
      });
    }
    if (Array.isArray(analysis.protocolHierarchy) && analysis.protocolHierarchy.length > 0) {
      sections.push({
        type: 'table',
        title: '协议分布',
        columns: ['#', 'protocol', 'frames', 'bytes', 'raw'],
        rows: rowsFromObjectList(analysis.protocolHierarchy, ['#', 'protocol', 'frames', 'bytes', 'raw'])
      });
    }
    if (Array.isArray(analysis.endpoints) && analysis.endpoints.length > 0) {
      sections.push({
        type: 'table',
        title: 'Top 对端',
        columns: ['#', 'address', 'packets', 'bytes', 'raw'],
        rows: rowsFromObjectList(analysis.endpoints, ['#', 'address', 'packets', 'bytes', 'raw'])
      });
    }
    if (Array.isArray(analysis.conversations) && analysis.conversations.length > 0) {
      sections.push({
        type: 'table',
        title: 'Top 会话',
        columns: ['#', 'source', 'destination', 'packets', 'bytes', 'raw'],
        rows: rowsFromObjectList(analysis.conversations, ['#', 'source', 'destination', 'packets', 'bytes', 'raw'])
      });
    }
    if (Array.isArray(analysis.dnsQueries) && analysis.dnsQueries.length > 0) {
      sections.push({
        type: 'table',
        title: 'DNS 查询样本',
        columns: ['#', 'query', 'count', 'raw'],
        rows: rowsFromObjectList(analysis.dnsQueries, ['#', 'query', 'count', 'raw'])
      });
    }
  }

  const systemName = String(
    options.systemName
    || result.systemName
    || 'NAPM'
  ).trim() || 'NAPM';

  const title = String(options.title || summary.title || 'NAPM 数据包分析报告').trim() || 'NAPM 数据包分析报告';

  const faultName = String(
    options.faultName
    || result.faultName
    || summary.faultName
    || criteria.faultDescription
    || title
  ).trim() || '未命名故障';

  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'diagnostic_report',
    format: normalizeFormat(options.format || 'docx'),
    defaultFormat: 'docx',
    title,
    systemName,
    faultName,
    sourceQuestion: String(options.sourceQuestion || options.prompt || '').trim() || undefined,
    timeRange: {
      start: Number(criteria.start) || undefined,
      end: Number(criteria.end) || undefined,
      displayText: criteria.start || criteria.end ? `${criteria.start || '-'} ~ ${criteria.end || '-'}` : undefined
    },
    dataSource: {
      system: systemName,
      sourceSkill: 'openclaw-napm-packet-analysis',
      queryService: 'packet-analysis',
      mode: String(result.mode || narrationInput.mode || '').trim() || undefined,
      downloadType: String(result.downloadType || '').trim() || undefined
    },
    sections,
    audit: {
      sourceSkill: 'openclaw-napm-packet-analysis',
      sourceSchema: String(narrationInput.schema || result.schema || '').trim() || undefined,
      ok: Boolean(result.ok),
      mode: String(result.mode || narrationInput.mode || '').trim() || undefined
    }
  };
}

function buildSummaryReportData(result = {}, options = {}) {
  if (!isSummarySourceResult(result)) {
    return null;
  }
  if (isPlainObject(result.reportData)) {
    return {
      ...result.reportData,
      format: normalizeFormat(options.format || result.reportData.format || result.reportData.defaultFormat)
    };
  }

  const narrationInput = isPlainObject(result.narrationInput) ? result.narrationInput : {};
  const summary = isPlainObject(result.summary)
    ? result.summary
    : (isPlainObject(narrationInput.summary) ? narrationInput.summary : result);
  const scope = isPlainObject(result.scope)
    ? result.scope
    : (isPlainObject(narrationInput.scope) ? narrationInput.scope : { type: 'global', label: '全局' });

  const scopeLabel = scope.label || '全局';
  const scopeTarget = isPlainObject(scope.target) ? scope.target : null;
  const scopeTargetLabel = scopeTarget?.groupLabel || '';

  // Title: scope-aware
  const defaultTitle = scope.type === 'global'
    ? 'Netlnside基于AI的全流量性能分析平台_全局综述报告'
    : `${scopeTargetLabel}_${scopeLabel}综述报告`;
  const title = String(
    options.title || result.title || defaultTitle
  ).trim() || defaultTitle;

  const systemName = String(
    options.systemName
    || result.systemName
    || summary.deviceInfo?.systemName
    || 'Netlnside基于AI的全流量性能分析平台'
  ).trim() || 'Netlnside基于AI的全流量性能分析平台';

  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'summary_report',
    templateId: 'napm_summary_overview_v1',
    format: normalizeFormat(options.format || result.format || 'docx'),
    defaultFormat: 'docx',
    title,
    systemName,
    sourceQuestion: String(options.sourceQuestion || options.prompt || result.sourceQuestion || '').trim() || undefined,
    timeRange: {
      start: Number(result.timeRange?.start || summary.timeRange?.start || 0) || undefined,
      end: Number(result.timeRange?.end || summary.timeRange?.end || 0) || undefined,
      displayText: result.timeRange?.displayText || summary.timeRange?.displayText || ''
    },
    scope: {
      type: scope.type || 'global',
      label: scopeLabel,
      target: scopeTarget
    },
    dataSource: {
      system: systemName,
      sourceSkill: result.dataSource?.sourceSkill || 'openclaw-napm-summary',
      queryService: result.dataSource?.queryService || 'summaryAggregation'
    },
    summary,
    audit: {
      sourceSkill: 'openclaw-napm-summary',
      sourceSchema: String(result.schema || narrationInput.schema || '').trim() || undefined,
      reportInputSource: isPlainObject(result.summary) ? 'sourceResult.summary' : 'summary'
    }
  };
}

function extractSourceResult(input = {}) {
  if (isPlainObject(input.sourceResult)) {
    return input.sourceResult;
  }
  if (isPlainObject(input.packetResult)) {
    return input.packetResult;
  }
  if (isPlainObject(input.queryResult)) {
    return input.queryResult;
  }
  if (isPlainObject(input.result)) {
    return input.result;
  }
  return null;
}

function normalizeReportInput(input = {}, options = {}) {
  const payload = isPlainObject(input) ? input : {};
  const sourceResult = extractSourceResult(payload);
  const explicitReportData = isPlainObject(payload.reportData)
    ? payload.reportData
    : (payload.reportType && Array.isArray(payload.sections) ? payload : null);
  const sourceReportData = explicitReportData
    || (isPlainObject(sourceResult?.reportData) ? sourceResult.reportData : null)
    || buildInspectionReportData(
      sourceResult || (isPlainObject(payload.inspection) ? payload : null),
      {
        ...options,
        prompt: payload.prompt || payload.exportPrompt,
        format: payload.format || options.format,
        title: payload.title || options.title,
        sourceQuestion: payload.sourceQuestion || options.sourceQuestion
      }
    )
    || buildSummaryReportData(
      sourceResult || (isPlainObject(payload.summary) ? payload : null),
      {
        ...options,
        prompt: payload.prompt || payload.exportPrompt,
        format: payload.format || options.format,
        title: payload.title || options.title,
        sourceQuestion: payload.sourceQuestion || options.sourceQuestion
      }
    )
    || buildFaultDiagnosisReportData(sourceResult, {
      ...options,
      prompt: payload.prompt || payload.exportPrompt,
      format: payload.format || options.format,
      title: payload.title || options.title,
      sourceQuestion: payload.sourceQuestion || options.sourceQuestion
    })
    || buildPacketReportData(sourceResult, {
      ...options,
      prompt: payload.prompt || payload.exportPrompt,
      format: payload.format || options.format,
      title: payload.title || options.title,
      sourceQuestion: payload.sourceQuestion || options.sourceQuestion
    });

  if (!sourceReportData) {
    return {
      ...payload,
      reportType: payload.reportType || 'diagnostic_report',
      format: normalizeFormat(payload.format || options.format),
      systemName: String(payload.systemName || options.systemName || '').trim() || undefined,
      faultName: String(payload.faultName || options.faultName || '').trim() || undefined,
      sections: Array.isArray(payload.sections) ? payload.sections : []
    };
  }

  const format = normalizeFormat(payload.format || options.format || sourceReportData.format || sourceReportData.defaultFormat);
  const defaultSystemName = sourceReportData.reportType === 'inspection_report'
    ? 'Netlnside基于AI的全流量性能分析平台'
    : undefined;
  const systemName = String(
    payload.systemName || options.systemName || sourceReportData.systemName || defaultSystemName || ''
  ).trim() || undefined;
  const faultName = String(
    payload.faultName || options.faultName || sourceReportData.faultName || ''
  ).trim() || undefined;
  return {
    ...sourceReportData,
    format,
    systemName: systemName || sourceReportData.systemName,
    faultName: faultName || sourceReportData.faultName,
    title: String(payload.title || options.title || sourceReportData.title || '').trim() || sourceReportData.title,
    sourceQuestion: String(
      payload.sourceQuestion
      || options.sourceQuestion
      || payload.prompt
      || payload.exportPrompt
      || sourceReportData.sourceQuestion
      || ''
    ).trim() || sourceReportData.sourceQuestion,
    audit: {
      ...(isPlainObject(sourceReportData.audit) ? sourceReportData.audit : {}),
      exportPrompt: String(payload.prompt || payload.exportPrompt || options.prompt || '').trim() || undefined,
      reportInputSource: explicitReportData
        ? 'reportData'
        : (isPlainObject(sourceResult?.reportData) ? 'sourceResult.reportData' : 'sourceResult.packetAnalysis')
    }
  };
}

module.exports = {
  normalizeReportInput,
  buildPacketReportData,
  buildInspectionReportData,
  buildSummaryReportData,
  buildFaultDiagnosisReportData,
  isPacketSourceResult,
  isInspectionSourceResult,
  isSummarySourceResult,
  isFaultDiagnosisSourceResult,
  normalizeFormat,
  __test__: {
    compactJson,
    makeCriteriaSummary,
    rowsFromObjectList
  }
};
