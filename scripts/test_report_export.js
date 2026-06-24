// Quick test: can ReportTemplateService render a summary report?
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const ReportGenerationService = require('../skills/openclaw-napm-report/services/ReportGenerationService');

const fs = require('fs');
const outputDir = '/tmp/summary_report_test';
fs.mkdirSync(outputDir, { recursive: true });

const rd = {
  schema: 'openclaw_napm_report_data.v1',
  reportType: 'summary_report',
  templateId: 'napm_summary_overview_v1',
  format: 'docx',
  title: 'Test Summary',
  systemName: 'Test',
  scope: { type: 'global', label: '全局' },
  summary: {
    overallStatus: 'ok',
    reportDate: '2026年06月21日',
    deviceInfo: {},
    alertSummary: { total: 0, critical: 0, major: 0, minor: 0, byCategory: [], timeline: [], topObjects: [], unresolvedAlerts: [] },
    trafficSummary: { trend: null, topIPs: [], topApps: [], drillDown: null },
    businessSummary: { slowAccess: [], httpErrors: [] },
    conclusion: null,
    recommendations: []
  },
  audit: { sourceSkill: 'test' }
};

const n = normalizeReportInput({ sourceResult: { reportData: rd } });
console.log('normalized:', n.reportType, n.templateId);

const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });
service.generate(n).then(r => {
  console.log('Full result:', JSON.stringify(r, null, 2));
}).catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
});
