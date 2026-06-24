// Test: does SummaryFixedTemplateService render correctly?
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const SummaryFixedTemplateService = require('../skills/openclaw-napm-report/services/SummaryFixedTemplateService');

const rd = {
  schema: 'x', reportType: 'summary_report', templateId: 'napm_summary_overview_v1',
  format: 'docx', title: 'T', systemName: 'T',
  scope: { type: 'global', label: '全局' },
  summary: {
    overallStatus: 'ok', reportDate: '2026年06月21日', deviceInfo: {},
    alertSummary: { total: 0, critical: 0, major: 0, minor: 0, byCategory: [], timeline: [], topObjects: [], unresolvedAlerts: [] },
    trafficSummary: { trend: null, topIPs: [], topApps: [], drillDown: null },
    businessSummary: { slowAccess: [], httpErrors: [] },
    conclusion: null, recommendations: []
  },
  audit: {}
};

const n = normalizeReportInput({ sourceResult: { reportData: rd } });
const sts = new SummaryFixedTemplateService();

sts.renderDocx(n).then(b => {
  console.log('OK, buffer size:', b.length);
}).catch(e => {
  console.error('ERROR:', e.message);
  console.error(e.stack);
});
