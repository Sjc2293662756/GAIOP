const fs=require('fs');
const t=fs.readFileSync('/tmp/summary_app_v2.json','utf8');
const ok=t.indexOf('"ok"');const b=t.lastIndexOf('{',ok);let d=0,e=0;
for(let i=b;i<t.length;i++){if(t[i]==='{')d++;if(t[i]==='}'){d--;if(d===0){e=i+1;break;}}}
const j=JSON.parse(t.slice(b,e));
const {normalizeReportInput}=require('../skills/openclaw-napm-report/services/ReportInputContractService');
const ReportGenerationService=require('../skills/openclaw-napm-report/services/ReportGenerationService');
const out='/tmp/app_render_test';fs.mkdirSync(out,{recursive:true});
const tsRaw=j.summary?.trafficSummary||{};
console.log('RAW summary userExpTrend:',!!tsRaw.userExpTrend,'trend:',!!tsRaw.trend);
console.log('RAW trafficSummary keys:',Object.keys(tsRaw).join(','));
const tsReport=j.reportData?.summary?.trafficSummary||{};
console.log('reportData summary userExpTrend:',!!tsReport.userExpTrend);
const n=normalizeReportInput({sourceResult:j});
const tsNorm=n.summary?.trafficSummary||{};
console.log('normalized userExpTrend:',!!tsNorm.userExpTrend,'trend:',!!tsNorm.trend);
console.log('normalized trafficSummary keys:',Object.keys(tsNorm).join(','));
const svc=new ReportGenerationService({outputDir:out,downloadBaseUrl:'/reports'});
svc.generate(n).then(r=>{
  console.log('render ok:',r.ok,'size:',r.filePath?fs.statSync(r.filePath).size:0);
}).catch(e=>console.error(e));
