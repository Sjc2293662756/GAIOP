'use strict';

const LEGACY_FAULT_TEMPLATE_ID = 'napm_fault_diagnosis_v1';
const LEGACY_FAULT_RESULT_SCHEMA = 'openclaw_napm_fault_diagnosis_result.v1';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFormat(format = '') {
  const value = String(format || '').trim().toLowerCase();
  if (value === 'word' || value === 'doc') return 'docx';
  return value || 'docx';
}

function firstValue(...values) {
  return values.find((value) => (
    value !== undefined && value !== null && String(value).trim() !== ''
  ));
}

function firstObject(...values) {
  return values.find(isPlainObject) || {};
}

function numericValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumKnown(items, keys) {
  let total = 0;
  let known = false;
  for (const item of asArray(items)) {
    if (!isPlainObject(item)) continue;
    const value = numericValue(firstValue(...keys.map((key) => item[key])));
    if (value === null) continue;
    total += value;
    known = true;
  }
  return known ? total : null;
}

function setIfPresent(target, key, value) {
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    target[key] = value;
  }
}

function mergeEmbeddedReportData(result = {}) {
  if (!isPlainObject(result)) return null;
  return isPlainObject(result.reportData)
    ? { ...result, ...result.reportData }
    : result;
}

function isLegacyFaultDiagnosisResult(result = {}) {
  const source = mergeEmbeddedReportData(result);
  if (!source) return false;

  const templateId = String(
    firstValue(result.templateId, result.reportData?.templateId, source.templateId) || ''
  ).trim();
  if (templateId === LEGACY_FAULT_TEMPLATE_ID) return true;
  if (isPlainObject(source.diagnosis)) return false;

  const schema = String(firstValue(source.schema, result.reportData?.schema) || '').trim();
  if (schema === LEGACY_FAULT_RESULT_SCHEMA) return true;

  return source.reportType === 'diagnostic_report'
    && isPlainObject(source.fault)
    && isPlainObject(source.alertAnalysis)
    && isPlainObject(source.trafficAnalysis)
    && isPlainObject(source.businessAnalysis);
}

function normalizeTimeRange(timeRange = {}) {
  const source = isPlainObject(timeRange) ? timeRange : {};
  const faultWindow = isPlainObject(source.faultWindow) ? source.faultWindow : {};
  const baselineWindow = isPlainObject(source.baselineWindow) ? source.baselineWindow : {};
  return {
    start: firstValue(faultWindow.start, source.start),
    end: firstValue(faultWindow.end, source.end),
    displayText: firstValue(source.displayText, '') || '',
    baselineStart: firstValue(baselineWindow.start, source.baselineStart),
    baselineEnd: firstValue(baselineWindow.end, source.baselineEnd)
  };
}

function buildLegacyStep1(source, businessAnalysis) {
  const overview = firstObject(
    source.businessOverview,
    businessAnalysis.businessOverview,
    businessAnalysis.overview
  );
  const httpErrors = asArray(businessAnalysis.httpErrors);
  const http400Total = firstValue(
    overview.PGHTTP400,
    source.http400Total,
    sumKnown(httpErrors, ['PGHTTP400', 'http400'])
  );
  const http500Total = firstValue(
    overview.PGHTTP500,
    source.http500Total,
    sumKnown(httpErrors, ['PGHTTP500', 'http500'])
  );
  const topApp = { ...overview };
  setIfPresent(topApp, 'PGHTTP400', http400Total);
  setIfPresent(topApp, 'PGHTTP500', http500Total);

  const http400Pct = firstValue(
    overview.PGHTTP400PCT,
    source.http400Pct,
    businessAnalysis.http400Pct
  );

  return {
    topApps: Object.keys(topApp).length > 0 ? [topApp] : [],
    http400Total: numericValue(http400Total),
    http500Total: numericValue(http500Total),
    http400Pct: http400Pct === undefined ? null : http400Pct
  };
}

function legacyPageName(item = {}) {
  return firstValue(
    item.pageUrl,
    item.businessName,
    item.keyLabel,
    item.key,
    item.page,
    item.group?.argument
  );
}

function buildLegacyStep2(source, businessAnalysis) {
  const pages = new Map();
  const addPage = (item) => {
    if (!isPlainObject(item)) return;
    const name = legacyPageName(item);
    if (!name) return;
    const page = pages.get(String(name)) || { pageUrl: name };
    setIfPresent(page, 'key', item.key);
    setIfPresent(page, 'PGNPGE', firstValue(item.PGNPGE, item.visits));
    setIfPresent(page, 'PGNOBJE', firstValue(item.PGNOBJE, item.responses));
    setIfPresent(page, 'PGHTTP200', firstValue(item.PGHTTP200, item.http200));
    setIfPresent(page, 'PGHTTP300', firstValue(item.PGHTTP300, item.http300));
    setIfPresent(page, 'PGHTTP400', firstValue(item.PGHTTP400, item.http400));
    setIfPresent(page, 'PGHTTP500', firstValue(item.PGHTTP500, item.http500));
    setIfPresent(page, 'PGNSLPGE', firstValue(item.PGNSLPGE, item.slowCount));
    setIfPresent(page, 'PGSLPCT', firstValue(item.PGSLPCT, item.ratio));
    pages.set(String(name), page);
  };

  asArray(source.pageErrors).forEach(addPage);
  asArray(businessAnalysis.httpErrors).forEach(addPage);
  asArray(businessAnalysis.slowAccess).forEach(addPage);
  return { pages: Array.from(pages.values()).slice(0, 20) };
}

function buildLegacyStep3(source, businessAnalysis) {
  const candidates = [
    source.pageDetails,
    source.pageViews,
    businessAnalysis.pageDetails,
    businessAnalysis.pageViews
  ];
  const pageDetails = candidates.flatMap((items) => asArray(items))
    .filter(isPlainObject)
    .map((item) => ({
      startTime: firstValue(item.startTime, item.time),
      page: firstValue(item.page, item.pageUrl, item.businessName),
      clientIp: firstValue(item.clientIp, item.clientIP, item.ip),
      httpStatus: firstValue(item.httpStatus, item.statusCode, item.status),
      http200S: firstValue(item.http200S, item.http200),
      http400S: firstValue(item.http400S, item.http400),
      http500S: firstValue(item.http500S, item.http500),
      httpResponses: firstValue(item.httpResponses, item.responses)
    }));
  return { pageDetails: pageDetails.slice(0, 200) };
}

function reportDate(source) {
  const value = firstValue(source.reportDate, source.diagnosis?.reportDate);
  if (value) return value;
  const generatedAt = firstValue(source.generatedAt);
  if (generatedAt) {
    const date = new Date(generatedAt);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function buildLegacyFaultDiagnosisReportData(result = {}, options = {}) {
  if (!isLegacyFaultDiagnosisResult(result)) return null;
  const source = mergeEmbeddedReportData(result);
  const narrationInput = isPlainObject(source.narrationInput) ? source.narrationInput : {};
  const fault = firstObject(source.fault, narrationInput.fault);
  const alertAnalysis = firstObject(source.alertAnalysis, narrationInput.alertAnalysis);
  const trafficAnalysis = firstObject(source.trafficAnalysis, narrationInput.trafficAnalysis);
  const businessAnalysis = firstObject(source.businessAnalysis, narrationInput.businessAnalysis);
  const packetAnalysis = firstObject(source.packetAnalysis, narrationInput.packetAnalysis);
  const timeRange = normalizeTimeRange(firstObject(source.timeRange, narrationInput.timeRange));
  const faultName = String(firstValue(
    options.faultName,
    source.faultName,
    fault.description,
    '未命名故障'
  )).trim() || '未命名故障';
  const systemName = String(firstValue(
    options.systemName,
    source.systemName,
    source.deviceInfo?.systemName,
    'Netlnside基于AI的全流量性能分析平台'
  )).trim() || 'Netlnside基于AI的全流量性能分析平台';
  const target = firstObject(source.target, source.scope?.target);
  const targetLabel = String(firstValue(
    options.targetLabel,
    source.targetLabel,
    target.groupLabel,
    target.groupArgument,
    faultName,
    '未命名故障'
  )).trim() || '未命名故障';
  const severity = String(firstValue(source.severity, fault.severity, 'major')).trim() || 'major';
  const severityLabel = { critical: '紧急', major: '重大', minor: '轻微' }[severity] || severity;
  const step1 = buildLegacyStep1(source, businessAnalysis);
  const diagnosis = {
    flowType: firstValue(source.flowType, 'bs_app_slow'),
    flowLabel: firstValue(source.flowLabel, 'B/S 架构业务慢'),
    description: firstValue(source.description, fault.description, faultName),
    targetLabel,
    targetType: firstValue(target.groupType, 'WebApplication'),
    severity,
    severityLabel,
    stepCount: Array.isArray(source.completedSteps) && source.completedSteps.length > 0
      ? source.completedSteps.length
      : 3,
    reportDate: reportDate(source),
    recommendations: asArray(fault.recommendations),
    prevention: asArray(fault.prevention),
    step1Hints: asArray(source.step1Hints),
    step2Hints: asArray(source.step2Hints),
    step3Hints: asArray(source.step3Hints),
    step1,
    step2: buildLegacyStep2(source, businessAnalysis),
    step3: buildLegacyStep3(source, businessAnalysis)
  };
  const sourceAudit = isPlainObject(source.audit) ? source.audit : {};
  const sourceSchema = firstValue(
    source.schema,
    narrationInput.schema,
    sourceAudit.sourceSchema,
    'openclaw_napm_fault_diagnosis_result.v1'
  );
  const legacyTemplateId = firstValue(source.templateId, source.reportData?.templateId);

  return {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'diagnostic_report',
    templateId: 'napm_bs_fault_diagnosis_v2',
    format: normalizeFormat(options.format || source.format || 'docx'),
    defaultFormat: 'docx',
    title: String(firstValue(options.title, source.title, `${faultName}_故障分析报告`)).trim(),
    systemName,
    faultName,
    sourceQuestion: firstValue(options.sourceQuestion, options.prompt, source.sourceQuestion),
    timeRange,
    dataSource: {
      ...firstObject(source.dataSource),
      system: systemName,
      sourceSkill: firstValue(sourceAudit.sourceSkill, source.dataSource?.sourceSkill, 'openclaw-napm-fault-diagnosis'),
      queryService: firstValue(source.dataSource?.queryService, 'faultDiagnosis')
    },
    fault,
    alertAnalysis,
    trafficAnalysis,
    businessAnalysis,
    packetAnalysis: Object.keys(packetAnalysis).length > 0 ? packetAnalysis : null,
    diagnosis,
    audit: {
      ...sourceAudit,
      sourceSkill: firstValue(sourceAudit.sourceSkill, source.dataSource?.sourceSkill, 'openclaw-napm-fault-diagnosis'),
      sourceSchema,
      legacyTemplateId,
      reportInputSource: 'legacy_fault_diagnosis',
      requestHistory: sourceAudit.requestHistory || [],
      queriesPerformed: sourceAudit.queriesPerformed || sourceAudit.queryEvidence || []
    }
  };
}

module.exports = {
  LEGACY_FAULT_TEMPLATE_ID,
  LEGACY_FAULT_RESULT_SCHEMA,
  isLegacyFaultDiagnosisResult,
  buildLegacyFaultDiagnosisReportData,
  __test__: {
    buildLegacyStep1,
    buildLegacyStep2,
    buildLegacyStep3,
    normalizeTimeRange,
    normalizeFormat
  }
};
