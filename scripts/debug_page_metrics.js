// Debug: check if PGBYTI/PGBYTO and PGNPGE return data for WebApplication
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
  // Test 1: PGBYTI + PGBYTO
  console.log('=== PGBYTI + PGBYTO ===');
  try {
    const r1 = await c.getTopValues(start, now, 'PGBYTI,PGBYTO', 'PGBYTI', 5, [{type:'WebApplication'}]);
    console.log('type:', typeof r1, 'isArray:', Array.isArray(r1));
    if (Array.isArray(r1)) {
      console.log('len:', r1.length);
      if (r1.length > 0) {
        console.log('first keys:', Object.keys(r1[0]).join(','));
        console.log('first:', JSON.stringify(r1[0]).slice(0,300));
      } else {
        console.log('EMPTY ARRAY - no data');
      }
    }
  } catch(e) { console.log('ERROR:', e.message); }

  // Test 2: PGNPGE
  console.log('\n=== PGNPGE ===');
  try {
    const r2 = await c.getTopValues(start, now, 'PGNPGE', 'PGNPGE', 5, [{type:'WebApplication'}]);
    console.log('type:', typeof r2, 'isArray:', Array.isArray(r2));
    if (Array.isArray(r2)) {
      console.log('len:', r2.length);
      if (r2.length > 0) {
        console.log('first keys:', Object.keys(r2[0]).join(','));
        console.log('first:', JSON.stringify(r2[0]).slice(0,300));
      } else {
        console.log('EMPTY ARRAY - no data');
      }
    }
  } catch(e) { console.log('ERROR:', e.message); }

  // Test 3: Try with CSV to get raw format
  console.log('\n=== PGBYTI (via request) ===');
  const url = c.requestHistory[c.requestHistory.length-1]?.url || 'N/A';
  console.log('last URL:', url.slice(0,200));
})().catch(e => console.error(e));
