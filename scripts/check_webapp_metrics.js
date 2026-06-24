// Query available metrics for WebApplication, DefinedApp, and BusinessGroup
const path = require('path');
const fs = require('fs');
const envPath = path.resolve('/home/netinside/.openclaw/workspace', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0,i).trim();
    const v = t.slice(i+1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

const NapmMetadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');

(async () => {
  const groupTypes = ['WebApplication', 'DefinedApp', 'BusinessGroup', 'IPAddress', 'TotalTraffic', 'Application'];

  for (const gt of groupTypes) {
    try {
      const metrics = await NapmMetadataService.getMetricsForGroupPath([{ type: gt }]);
      const ids = Array.isArray(metrics) ? metrics.map(m => m.id || m) : [];
      console.log(gt + ' (' + ids.length + ' metrics):');
      if (ids.length > 0) {
        // Show id + label
        const details = Array.isArray(metrics)
          ? metrics.slice(0, 15).map(m => (m.id || m) + (m.label ? '(' + m.label + ')' : '')).join(', ')
          : ids.slice(0, 15).join(', ');
        console.log('  ' + details);
        if (ids.length > 15) console.log('  ... and ' + (ids.length - 15) + ' more');
      } else {
        console.log('  (none)');
      }
      console.log('');
    } catch(e) {
      console.log(gt + ': ERROR - ' + e.message + '\n');
    }
  }
})().catch(e => console.error(e));
