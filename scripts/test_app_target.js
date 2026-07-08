// Test single application (DefinedApp) targeted analysis end-to-end
const { execFileSync } = require('child_process');
const path = require('path');

const script = path.resolve(__dirname, '..', 'skills', 'openclaw-napm-summary', 'scripts', 'run_summary.js');
const payload = JSON.stringify({
  scope: { type: 'application', label: '应用', target: { groupType: 'DefinedApp', groupArgument: '回溯238', groupLabel: '回溯238' } }
});

console.log('=== Querying NAPM for 回溯238 (DefinedApp) ===');
const stdout = execFileSync('node', [script, '--queryJson', payload], {
  encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120000,
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
});

// Parse JSON
const okIdx = stdout.indexOf('"ok"');
const brace = stdout.lastIndexOf('{', okIdx);
let depth = 0, end = 0;
for (let i = brace; i < stdout.length; i++) {
  if (stdout[i] === '{') depth++;
  if (stdout[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const result = JSON.parse(stdout.slice(brace, end));
const s = result.summary || {};
const ts = s.trafficSummary || {};
const alerts = s.alertSummary || {};

console.log('ok:', result.ok);
console.log('queries:', result.audit?.queriesPerformed?.length);
console.log('');
console.log('=== Alert ===');
console.log('total:', alerts.total, 'critical:', alerts.critical);
console.log('byCategory:', alerts.byCategory?.map(c => c.categoryLabel + '=' + c.count).join(', '));
console.log('');
console.log('=== AppPro Data ===');
console.log('appOverview:', Object.keys(ts.appOverview || {}).length > 0 ? JSON.stringify(ts.appOverview).slice(0, 120) : 'EMPTY');
console.log('userExpTrend:', ts.userExpTrend ? 'present(' + (ts.userExpTrend.dataset?.points?.length || 0) + ' pts)' : 'MISSING');
console.log('slowClients:', ts.slowClients?.length || 0);
console.log('trafficTrend:', ts.trend ? 'present(' + (ts.trend.dataset?.points?.length || 0) + ' pts)' : 'MISSING');
console.log('externalTraffic:', ts.externalTraffic?.length || 0);
console.log('conversations:', ts.conversations?.length || 0);
console.log('internalTraffic:', ts.internalTraffic?.length || 0);
