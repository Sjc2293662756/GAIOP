const SummaryService=require('../skills/openclaw-napm-summary/services/SummaryService');
const fs=require('fs');
const ep='/home/netinside/.openclaw/workspace/.env';
const lines=fs.readFileSync(ep,'utf8').split(/\r?\n/);
for(const l of lines){const t=l.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const i=t.indexOf('=');const k=t.slice(0,i).trim();const v=t.slice(i+1).trim().replace(/^['"]|['"]$/g,'');if(!process.env[k])process.env[k]=v;}
const svc=new SummaryService();
svc.run({scope:{type:'webApplication',label:'业务',target:{groupType:'WebApplication',groupArgument:'回溯238web',groupLabel:'回溯238web'}}}).then(r=>{
  const bs=r.summary.businessSummary;
  console.log('overview:',JSON.stringify(bs.overview).slice(0,200));
  console.log('accessTrend:',!!bs.accessTrend);
  console.log('nodeDist:',bs.nodeDist?.length);
  console.log('resource:',JSON.stringify(bs.resource).slice(0,150));
  console.log('trafficTrend:',!!bs.trafficTrend);
  console.log('slowClients:',bs.slowClients?.length);
  console.log('httpCodes:',JSON.stringify(bs.httpCodes).slice(0,150));
  console.log('error400:',bs.error400Clients?.length);
  console.log('error500:',bs.error500Clients?.length);
}).catch(e=>console.error(e));
