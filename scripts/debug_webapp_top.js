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

const SummaryClient = require('../skills/openclaw-napm-summary/services/SummaryClient');
const c = new SummaryClient();
const now = Math.floor(Date.now()/1000);
const start = now - 86400;

(async () => {
  // Try WebApplication with TPIO
  const r1 = await c.getTopValues(start, now, 'TPIO,TPI,TPO', 'TPIO', 5, [{type:'WebApplication'}]);
  console.log('TPIO raw type:', typeof r1, 'isArray:', Array.isArray(r1));
  if (Array.isArray(r1)) console.log('TPIO len:', r1.length);
  if (Array.isArray(r1) && r1.length>0) {
    console.log('first keys:', Object.keys(r1[0]).join(','));
    console.log('first:', JSON.stringify(r1[0]).slice(0,200));
  }

  // Try WebApplication with PGSLPCT (known to work from slowAccess)
  const r2 = await c.getTopValues(start, now, 'PGSLPCT,PGNSLPGE,PGTME', 'PGSLPCT', 5, [{type:'WebApplication'}]);
  console.log('\nPGSLPCT raw type:', typeof r2, 'isArray:', Array.isArray(r2));
  if (Array.isArray(r2)) console.log('PGSLPCT len:', r2.length);
  if (Array.isArray(r2) && r2.length>0) {
    console.log('first keys:', Object.keys(r2[0]).join(','));
    console.log('first:', JSON.stringify(r2[0]).slice(0,200));
  }
})().catch(e => console.error(e));
