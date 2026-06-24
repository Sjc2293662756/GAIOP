// Check raw NAPM topValues response format for IPAddress
const path = require('path');
const fs = require('fs');

// Load .env
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

const SummaryClient = require('../skills/openclaw-napm-summary/services/SummaryClient');
const c = new SummaryClient();
const now = Math.floor(Date.now()/1000);
const start = now - 86400;

(async () => {
  const raw = await c.getTopValues(start, now, 'TPIO,TPI,TPO', 'TPIO', 5, [{type:'IPAddress'}]);
  console.log('raw type:', typeof raw, 'isArray:', Array.isArray(raw));

  if (Array.isArray(raw)) {
    raw.slice(0,3).forEach((item, i) => {
      console.log('\nItem', i, 'keys:', Object.keys(item).join(','));
      console.log('  key:', item.key, 'keyLabel:', item.keyLabel);
      if (item.metricValues) {
        console.log('  metricValues count:', item.metricValues.length);
        item.metricValues.forEach(mv => console.log('    metric.id:', mv.metric?.id, 'value:', mv.value));
      } else {
        console.log('  NO metricValues');
        // Check for flat metrics
        const metrics = ['TPIO','TPI','TPO','BYTIO','BYTI','BYTO','PKIO'];
        metrics.forEach(m => { if (item[m] !== undefined) console.log('  flat', m, ':', item[m]); });
      }
      console.log('  full:', JSON.stringify(item).slice(0,200));
    });
  }

  if (!Array.isArray(raw) && typeof raw === 'object') {
    console.log('object keys:', Object.keys(raw).join(','));
    if (raw.topValues) {
      raw.topValues.slice(0,3).forEach((item, i) => {
        console.log('\ntopValues['+i+'] keys:', Object.keys(item).join(','));
        console.log('  key:', item.key);
        if (item.metricValues) {
          item.metricValues.forEach(mv => console.log('  mv:', mv.metric?.id, mv.value));
        }
      });
    }
  }
})().catch(e => console.error(e));
