const fs=require('fs');const ep='/home/netinside/.openclaw/workspace/.env';
const lines=fs.readFileSync(ep,'utf8').split(/\r?\n/);
for(const l of lines){const t=l.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const i=t.indexOf('=');const k=t.slice(0,i).trim();const v=t.slice(i+1).trim().replace(/^['"]|['"]$/g,'');if(!process.env[k])process.env[k]=v;}
const SummaryClient=require('../skills/openclaw-napm-summary/services/SummaryClient');
const c=new SummaryClient();
const now=Math.floor(Date.now()/1000);
const start=now-86400;
c.getAverageValues(start,now,'PGNPGE,PGNSLPGE,PGSLPCT',[{type:'WebApplication',argument:'回溯238web'}]).then(r=>{
  console.log('type:',typeof r,'isArray:',Array.isArray(r));
  if(!Array.isArray(r)&&typeof r==='object') console.log('keys:',Object.keys(r).join(','));
  if(Array.isArray(r)&&r.length>0) console.log('first:',JSON.stringify(r[0]).slice(0,300));
  else if(typeof r==='string') console.log('string first 300:',r.slice(0,300));
  else console.log('sample:',JSON.stringify(r).slice(0,400));
}).catch(e=>console.error(e));
