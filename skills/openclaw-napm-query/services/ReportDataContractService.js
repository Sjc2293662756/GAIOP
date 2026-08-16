/**
 * ReportDataContractService
 *
 * 将 skill 的真实执行结果收口为报告生成 skill 可消费的 reportData。
 * 这里不查询 NAPM、不生成 Word/PDF，只把 narration contract 中已经存在的
 * summary / narrationStructure / rows / overview 等同源数据整理成报告素材。
 */

const REPORTABLE_RESPONSE_TYPES = new Set([
  'topn',
  'comprehensive_analysis',
  'comprehensive_analysis_with_discovery',
  'overview'
]);
const { GENERIC_QUERY_TEMPLATE_ID, REPORT_SCHEMA } = require('../../openclaw-napm-report/services/ReportTemplateRegistry');

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

function compact(values = []) {
  return values
    .map((value) => asText(value).trim())
    .filter(Boolean);
}

function normalizeReportType(_responseType = '') {
  return 'quick_report';
}

function buildTitle(context = {}) {
  const narrationTitle = asText(context?.narrationStructure?.title).trim();
  const summaryTitle = asText(context?.summary?.title).trim();
  const service = asText(context?.service).trim();
  return narrationTitle || summaryTitle || (service ? `NAPM ${service} 查询报告` : 'NAPM 查询报告');
}

function normalizeMetrics(context = {}) {
  const resolvedQuery = context.resolvedQuery || {};
  return compact([
    ...(Array.isArray(resolvedQuery.metrics) ? resolvedQuery.metrics : []),
    resolvedQuery.metric,
    resolvedQuery.topMetric,
    context?.narrationStructure?.metric
  ]).filter((value, index, array) => array.indexOf(value) === index);
}

function getObjectType(context = {}) {
  const resolvedQuery = context.resolvedQuery || {};
  const groups = Array.isArray(resolvedQuery.groups) ? resolvedQuery.groups : [];
  return asText(
    context?.narrationStructure?.objectType
    || groups[0]?.type
    || resolvedQuery.targetObjectType
  ).trim() || null;
}

function normalizeTimeRange(context = {}) {
  const range = context.timeRange || context?.summary?.timeRange || context?.narrationStructure?.timeRange || null;
  if (!range || typeof range !== 'object') {
    return null;
  }
  return {
    displayText: asText(range.displayText).trim() || null,
    start: Number.isFinite(Number(range.start)) ? Number(range.start) : null,
    end: Number.isFinite(Number(range.end)) ? Number(range.end) : null,
    startText: asText(range.startText).trim() || null,
    endText: asText(range.endText).trim() || null,
    timezone: asText(range.timezone).trim() || 'Asia/Shanghai',
    key: asText(range.key).trim() || null
  };
}

function buildDataSource(context = {}) {
  return {
    system: 'NAPM',
    queryService: asText(context.service).trim() || null,
    responseType: asText(context.responseType).trim() || null,
    objectType: getObjectType(context),
    metrics: normalizeMetrics(context),
    requestUrl: asText(context.requestUrl).trim() || null
  };
}

function buildAudit(context = {}) {
  const resolvedQuery = context.resolvedQuery || null;
  return {
    traceId: asText(context.traceId).trim() || null,
    resolvedQueryId: asText(resolvedQuery?.id || resolvedQuery?.queryId).trim() || null,
    skillRunId: asText(context.skillRunId).trim() || null,
    service: asText(context.service).trim() || null,
    responseType: asText(context.responseType).trim() || null,
    requestUrl: asText(context.requestUrl).trim() || null,
    resolvedQuery
  };
}

function buildSummarySection(context = {}) {
  const summary = context.summary || {};
  const narration = context.narrationStructure || {};
  const highlights = Array.isArray(summary.highlights) ? summary.highlights : [];
  const narrationSummary = Array.isArray(narration.summary) ? narration.summary : [];
  const content = compact([
    summary.displayText,
    narration.explanation,
    ...highlights,
    ...narrationSummary
  ]).join('\n');

  return content
    ? {
        type: 'summary',
        title: '核心结论',
        content
      }
    : null;
}

function buildTopnTableSection(context = {}) {
  const items = Array.isArray(context?.narrationStructure?.items)
    ? context.narrationStructure.items
    : [];
  if (items.length === 0) {
    return null;
  }

  return {
    type: 'table',
    title: '排行明细',
    columns: ['排名', '对象', '指标', '数值', '单位'],
    rows: items.map((item, index) => [
      item.rank || index + 1,
      item.object || '',
      item.metricLabel || item.metric || '',
      item.formattedValue || item.value || '',
      item.unit || ''
    ])
  };
}

function buildOverviewModuleSection(context = {}) {
  const modules = Array.isArray(context?.narrationStructure?.modules)
    ? context.narrationStructure.modules
    : [];
  if (modules.length === 0) {
    return null;
  }

  return {
    type: 'table',
    title: '分析模块结果',
    columns: ['模块', '摘要', '状态'],
    rows: modules.map((module) => [
      module.title || module.key || '',
      module.summary || '',
      module.status || module.state || ''
    ])
  };
}

function buildFindingSection(context = {}) {
  const findings = Array.isArray(context?.narrationStructure?.keyFindings)
    ? context.narrationStructure.keyFindings
    : (Array.isArray(context?.narrationStructure?.summary) ? context.narrationStructure.summary : []);
  const items = compact(findings);
  if (items.length === 0) {
    return null;
  }
  return {
    type: 'finding',
    title: '关键发现',
    items
  };
}

function buildRecommendationSection(context = {}) {
  const prompts = Array.isArray(context.followUpPrompts) ? context.followUpPrompts : [];
  const actions = Array.isArray(context.followUpActions) ? context.followUpActions : [];
  const items = compact([
    ...actions.map((item) => item?.label || item?.title || item?.text || item),
    ...prompts
  ]);
  if (items.length === 0) {
    return null;
  }
  return {
    type: 'recommendation',
    title: '后续建议',
    items
  };
}

function buildSections(context = {}) {
  return [
    buildSummarySection(context),
    buildTopnTableSection(context),
    buildOverviewModuleSection(context),
    buildFindingSection(context),
    buildRecommendationSection(context)
  ].filter(Boolean);
}

function buildReportData(context = {}) {
  const responseType = asText(context.responseType || context?.narrationStructure?.responseType).trim();
  if (!responseType || !REPORTABLE_RESPONSE_TYPES.has(responseType)) {
    return null;
  }

  const sections = buildSections({ ...context, responseType });
  if (sections.length === 0) {
    return null;
  }

  return {
    schema: REPORT_SCHEMA,
    reportType: normalizeReportType(responseType),
    templateId: GENERIC_QUERY_TEMPLATE_ID,
    format: 'docx',
    defaultFormat: 'docx',
    title: buildTitle(context),
    sourceQuestion: asText(context.prompt).trim() || null,
    timeRange: normalizeTimeRange(context),
    dataSource: buildDataSource({ ...context, responseType }),
    sections,
    audit: buildAudit({ ...context, responseType })
  };
}

module.exports = {
  buildReportData,
  __test__: {
    asText,
    normalizeReportType,
    normalizeMetrics,
    buildSections
  }
};
