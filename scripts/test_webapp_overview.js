// Test webApplication overview: verify alert filtering and chapter structure
const { execFileSync } = require('child_process');
const path = require('path');

const script = path.resolve(__dirname, '..', 'skills', 'openclaw-napm-summary', 'scripts', 'run_summary.js');
const payload = JSON.stringify({ scope: { type: 'webApplication', label: '业务' } });

const stdout = execFileSync('node', [script, '--queryJson', payload], {
  encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60000,
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
});

// Find the JSON — starts with { on its own after "ok" appears
const okIdx = stdout.indexOf('"ok"');
const braceBefore = stdout.lastIndexOf('{', okIdx);
const jsonStr = braceBefore >= 0 ? stdout.slice(braceBefore).trim() : '';
if (!jsonStr) { console.error('No JSON found'); process.exit(1); }

// Multi-line JSON: find matching closing brace
let depth = 0, end = 0;
for (let i = 0; i < jsonStr.length; i++) {
  if (jsonStr[i] === '{') depth++;
  if (jsonStr[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const d = JSON.parse(jsonStr.slice(0, end));
const s = d.summary || {};
const a = s.alertSummary || {};

console.log('=== WebApplication Overview ===');
console.log('ok:', d.ok);
console.log('scope:', d.scope?.type, d.scope?.label);
console.log('queries:', d.audit?.queriesPerformed?.length);
console.log('');
console.log('--- Alert Summary (filtered) ---');
console.log('total:', a.total);
console.log('critical:', a.critical, 'major:', a.major, 'minor:', a.minor);
console.log('byCategory:', a.byCategory?.map(c => c.categoryLabel + '=' + c.count).join(', '));
console.log('');
console.log('--- Traffic ---');
console.log('trend:', s.trafficSummary?.trend ? 'present' : 'none');
console.log('topIPs:', s.trafficSummary?.topIPs?.length || 0);
console.log('topApps:', s.trafficSummary?.topApps?.length || 0);
console.log('');
console.log('--- Business ---');
console.log('slowAccess:', s.businessSummary?.slowAccess?.length || 0);
console.log('httpErrors:', s.businessSummary?.httpErrors?.length || 0);
console.log('pageTraffic:', s.businessSummary?.pageTraffic?.length || 0);
console.log('pageViews:', s.businessSummary?.pageViews?.length || 0);
if (s.businessSummary?.slowAccess?.length > 0) {
  s.businessSummary.slowAccess.slice(0, 3).forEach((r, i) =>
    console.log('  slow[' + i + ']', r.businessName, 'ratio:', r.ratio)
  );
}
if (s.businessSummary?.pageTraffic?.length > 0) {
  s.businessSummary.pageTraffic.slice(0, 3).forEach((r, i) =>
    console.log('  traffic[' + i + ']', r.businessName, 'req:', r.requestBytes, 'resp:', r.responseBytes)
  );
}
if (s.businessSummary?.pageViews?.length > 0) {
  s.businessSummary.pageViews.slice(0, 3).forEach((r, i) =>
    console.log('  views[' + i + ']', r.businessName, 'views:', r.pageViews)
  );
}
