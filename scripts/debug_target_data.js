const fs=require('fs');const ep='/home/netinside/.openclaw/workspace/.env';
const lines=fs.readFileSync(ep,'utf8').split(/\r?\n/);
for(const l of lines){const t=l.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const i=t.indexOf('=');const k=t.slice(0,i).trim();const v=t.slice(i+1).trim().replace(/^['"]|['"]$/g,'');if(!process.env[k])process.env[k]=v;}
const SummaryClient=require('../skills/openclaw-napm-summary/services/SummaryClient');
const c=new SummaryClient();
const now=Math.floor(Date.now()/1000);
const start=now-86400;
const groups=[{type:'WebApplication',argument:'回溯238web'}];

(async()=>{
  // Test 1: averageValues
  const r1=await c.getAverageValues(start,now,'PGNPGE,PGNSLPGE,PGSLPCT',groups);
  console.log('avgValues type:',typeof r1,'isArray:',Array.isArray(r1));
  if(Array.isArray(r1)){console.log('len:',r1.length);if(r1.length>0)console.log('first keys:',Object.keys(r1[0]).join(','));}
  else if(typeof r1==='object')console.log('keys:',Object.keys(r1).join(','));
  else console.log('string:',r1.slice(0,300));

  // Test 2: timeValues
  const r2=await c.getTimeValues(start,now,'PGNPGE,PGNSLPGE',groups,3600);
  console.log('\ntimeValues type:',typeof r2,'isArray:',Array.isArray(r2));
  if(typeof r2==='object'&&!Array.isArray(r2)){console.log('keys:',Object.keys(r2).join(','));if(r2.metricValues)console.log('mv len:',r2.metricValues.length);}

  // Test 3: topValues
  const cg=[{type:'WebApplication',argument:'回溯238web'},{type:'ClientIPs'},{type:'IPAddress'}];
  const r3=await c.getTopValues(start,now,'PGTME','PGNPGE',5,cg);
  console.log('\ntopValues type:',typeof r3,'isArray:',Array.isArray(r3));
  if(Array.isArray(r3)){console.log('len:',r3.length);if(r3.length>0)console.log('first keys:',Object.keys(r3[0]).join(','));}

  // Check request URLs
  console.log('\nURLs:');
  c.requestHistory.slice(0,3).forEach(h=>console.log(h.type,':',h.url.slice(0,200)));
})().catch(e=>console.error(e));
