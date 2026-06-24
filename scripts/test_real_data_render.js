// Test: render summary docx with real NAPM data (via the full ReportGenerationService chain)
const fs = require('fs');
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const ReportGenerationService = require('../skills/openclaw-napm-report/services/ReportGenerationService');

const d = JSON.parse(fs.readFileSync('/tmp/summary_v4.json', 'utf8'));
const rd = d.reportData;

console.log('=== Input Data ===');
console.log('reportType:', rd.reportType);
console.log('alertSummary.total:', rd.summary?.alertSummary?.total);
console.log('trafficSummary.trend:', rd.summary?.trafficSummary?.trend ? 'present ('+(rd.summary.trafficSummary.trend.dataset?.points?.length||0)+' pts)' : 'MISSING');
console.log('trafficSummary.topIPs:', rd.summary?.trafficSummary?.topIPs?.length || 0);
console.log('trafficSummary.topApps:', rd.summary?.trafficSummary?.topApps?.length || 0);
console.log('businessSummary.slowAccess:', rd.summary?.businessSummary?.slowAccess?.length || 0);
console.log('businessSummary.httpErrors:', rd.summary?.businessSummary?.httpErrors?.length || 0);

const outputDir = '/tmp/summary_real_test';
fs.mkdirSync(outputDir, { recursive: true });

const normalized = normalizeReportInput({ sourceResult: d });
console.log('\n=== After normalizeReportInput ===');
console.log('reportType:', normalized.reportType);
console.log('templateId:', normalized.templateId);
console.log('has summary:', !!normalized.summary);

const service = new ReportGenerationService({ outputDir, downloadBaseUrl: '/reports' });

service.generate(normalized).then(r => {
  console.log('\n=== Generate Result ===');
  console.log('ok:', r.ok);
  console.log('reportId:', r.reportId);
  console.log('errorCode:', r.errorCode);
  console.log('message:', r.message);
  if (r.filePath) {
    console.log('fileSize:', fs.statSync(r.filePath).size, 'bytes');
  }
}).catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
});
