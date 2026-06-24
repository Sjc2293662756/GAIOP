// Read the latest audit JSON and check traffic/business data
const fs = require('fs');
const path = require('path');
const dir = '/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output';
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
const latest = files[0].name;
const filePath = path.join(dir, latest);
console.log('Reading:', latest);

const all = fs.readFileSync(filePath, 'utf8');
const j = JSON.parse(all);
const s = j.summary || {};

console.log('\n=== Data Check ===');
console.log('overallStatus:', s.overallStatus);
console.log('reportType:', j.reportType);

console.log('\n--- alertSummary ---');
console.log('total:', s.alertSummary?.total);
console.log('critical:', s.alertSummary?.critical);
console.log('byCategory:', s.alertSummary?.byCategory?.length);
console.log('timeline:', s.alertSummary?.timeline?.length);
console.log('unresolvedAlerts:', s.alertSummary?.unresolvedAlerts?.length);

console.log('\n--- trafficSummary ---');
const ts = s.trafficSummary || {};
console.log('keys:', Object.keys(ts));
if (ts.trend) {
  const pts = ts.trend.dataset?.points;
  console.log('trend.points:', Array.isArray(pts) ? pts.length : 'NOT_ARRAY');
  if (Array.isArray(pts) && pts.length > 0) {
    console.log('trend first point keys:', Object.keys(pts[0]).join(','));
    console.log('trend first point:', JSON.stringify(pts[0]).slice(0, 100));
  }
} else {
  console.log('trend: MISSING');
}
console.log('topIPs:', Array.isArray(ts.topIPs) ? ts.topIPs.length : typeof ts.topIPs);
if (Array.isArray(ts.topIPs) && ts.topIPs.length > 0) {
  console.log('topIPs first:', JSON.stringify(ts.topIPs[0]).slice(0, 100));
}
console.log('topApps:', Array.isArray(ts.topApps) ? ts.topApps.length : typeof ts.topApps);

console.log('\n--- businessSummary ---');
const bs = s.businessSummary || {};
console.log('keys:', Object.keys(bs));
console.log('slowAccess:', Array.isArray(bs.slowAccess) ? bs.slowAccess.length : typeof bs.slowAccess);
if (Array.isArray(bs.slowAccess) && bs.slowAccess.length > 0) {
  console.log('slowAccess first:', JSON.stringify(bs.slowAccess[0]).slice(0, 100));
}
console.log('httpErrors:', Array.isArray(bs.httpErrors) ? bs.httpErrors.length : typeof bs.httpErrors);
if (Array.isArray(bs.httpErrors) && bs.httpErrors.length > 0) {
  console.log('httpErrors first:', JSON.stringify(bs.httpErrors[0]).slice(0, 100));
}

console.log('\n--- deviceInfo ---');
console.log(JSON.stringify(s.deviceInfo || {}));
