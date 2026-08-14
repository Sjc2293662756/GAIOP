'use strict';

const REPORT_SCHEMA = 'openclaw_napm_report_data.v1';
const GENERIC_QUERY_TEMPLATE_ID = 'napm_generic_query_v1';

const REGISTRATIONS = Object.freeze([
  Object.freeze({ schema: REPORT_SCHEMA, reportType: 'quick_report', templateId: GENERIC_QUERY_TEMPLATE_ID, renderer: 'generic', sectionPolicy: 'required' }),
  Object.freeze({ schema: REPORT_SCHEMA, reportType: 'inspection_report', templateId: 'napm_traffic_health_inspection_v1', renderer: 'inspection', sectionPolicy: 'fixed' }),
  Object.freeze({ schema: REPORT_SCHEMA, reportType: 'summary_report', templateId: 'napm_summary_overview_v1', renderer: 'summary', sectionPolicy: 'fixed' }),
  Object.freeze({ schema: REPORT_SCHEMA, reportType: 'diagnostic_report', templateId: 'napm_bs_fault_diagnosis_v2', renderer: 'bsFault', sectionPolicy: 'fixed' }),
  Object.freeze({ schema: REPORT_SCHEMA, reportType: 'diagnostic_report', templateId: 'napm_bs_page_perf_v1', renderer: 'bsPerf', sectionPolicy: 'fixed' }),
  Object.freeze({ schema: REPORT_SCHEMA, reportType: 'diagnostic_report', templateId: 'napm_cs_fault_diagnosis_v1', renderer: 'csFault', sectionPolicy: 'fixed' })
]);

const DEFAULT_TEMPLATE_BY_REPORT_TYPE = Object.freeze({
  quick_report: GENERIC_QUERY_TEMPLATE_ID
});
const GENERIC_SECTION_TYPES = new Set(['summary', 'table', 'finding', 'recommendation', 'items']);

function normalizeValue(value) {
  return String(value || '').trim();
}

function getDefaultTemplateId(reportType) {
  return DEFAULT_TEMPLATE_BY_REPORT_TYPE[normalizeValue(reportType)] || null;
}

function findRegistration(report = {}) {
  const schema = normalizeValue(report.schema);
  const reportType = normalizeValue(report.reportType);
  const templateId = normalizeValue(report.templateId);
  return REGISTRATIONS.find((item) => (
    item.schema === schema && item.reportType === reportType && item.templateId === templateId
  )) || null;
}

function normalizeRegistration(report = {}) {
  const reportType = normalizeValue(report.reportType);
  const templateId = normalizeValue(report.templateId) || getDefaultTemplateId(reportType);
  return {
    ...report,
    schema: normalizeValue(report.schema) || REPORT_SCHEMA,
    reportType,
    templateId: templateId || undefined
  };
}

function listSupportedRegistrations() {
  return REGISTRATIONS.map(({ schema, reportType, templateId }) => ({ schema, reportType, templateId }));
}

module.exports = {
  REPORT_SCHEMA,
  GENERIC_QUERY_TEMPLATE_ID,
  REGISTRATIONS,
  GENERIC_SECTION_TYPES,
  getDefaultTemplateId,
  findRegistration,
  normalizeRegistration,
  listSupportedRegistrations
};
