const fs = require('fs');
const path = require('path');
const dir = '/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const latest = files.reduce((a, b) => {
  return fs.statSync(path.join(dir, a)).mtimeMs > fs.statSync(path.join(dir, b)).mtimeMs ? a : b;
});
const filePath = path.join(dir, latest);
console.log('File:', latest);

// JSONL format: read ALL entries, show the last one
const all = fs.readFileSync(filePath, 'utf8').trim();
// Split on newline followed by {
const parts = all.split(/\n(?=\{)/).filter(p => p.trim());
console.log('Total entries in file:', parts.length);
const lastPart = parts[parts.length - 1].trim();
const j = JSON.parse(lastPart);
console.log('Last entry reportId:', j.reportId);
console.log('Last entry generatedAt:', j.generatedAt);
const s = j.summary || {};

console.log('reportType:', j.reportType);
console.log('scope:', j.scope?.type, j.scope?.label);
console.log('scope.target:', JSON.stringify(j.scope?.target));
console.log('timeRange:', JSON.stringify(j.timeRange));
console.log('');
console.log('=== alertSummary ===');
console.log('total:', s.alertSummary?.total);
console.log('byCategory:', s.alertSummary?.byCategory?.map(c => c.categoryLabel + '=' + c.count).join(', '));
console.log('');
console.log('=== trafficSummary ===');
console.log('trend:', s.trafficSummary?.trend ? 'present' : 'none');
console.log('topIPs:', s.trafficSummary?.topIPs?.length || 0);
console.log('topApps:', s.trafficSummary?.topApps?.length || 0);
console.log('drillDown:', s.trafficSummary?.drillDown ? 'present' : 'none');
console.log('appConnections:', s.trafficSummary?.appConnections?.length || 0);
console.log('appFailures:', s.trafficSummary?.appFailures?.length || 0);
console.log('');
console.log('=== businessSummary ===');
console.log('slowAccess:', s.businessSummary?.slowAccess?.length || 0);
console.log('httpErrors:', s.businessSummary?.httpErrors?.length || 0);
console.log('pageTraffic:', s.businessSummary?.pageTraffic?.length || 0);
console.log('pageViews:', s.businessSummary?.pageViews?.length || 0);
