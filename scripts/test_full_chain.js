// Test the full chain: normalizeReportInput → ReportTemplateService.renderDocx
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const ReportTemplateService = require('../skills/openclaw-napm-report/services/ReportTemplateService');

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
console.log('normalized reportType:', n.reportType);

const rts = new ReportTemplateService();
rts.renderDocx(n).then(b => {
  console.log('OK via ReportTemplateService, buffer size:', b.length);
}).catch(e => {
  console.error('ERROR via ReportTemplateService:', e.message);
  console.error(e.stack);
});
