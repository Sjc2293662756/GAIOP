// Full pipeline test for single application (AppPro) - bypasses PLINK encoding issues
const fs=require('fs');
const {execFileSync}=require('child_process');
const path=require('path');

// Write payload to temp file (preserves UTF-8)
const payload={scope:{type:'application',label:'应用',target:{groupType:'DefinedApp',groupArgument:'回溯238',groupLabel:'回溯238'}}};
const tmp=require('os').tmpdir();
const qf=path.join(tmp,'app_query_'+Date.now()+'.json');
fs.writeFileSync(qf,JSON.stringify(payload),'utf8');

// Verify we wrote correct Chinese
const check=JSON.parse(fs.readFileSync(qf,'utf8'));
console.log('target:',check.scope.target.groupArgument);

// Run summary
const script=path.resolve(__dirname,'..','skills','openclaw-napm-summary','scripts','run_summary.js');
const stdout=execFileSync('node',[script,'--queryFile',qf],{encoding:'utf8',maxBuffer:10*1024*1024,timeout:120000,env:{...process.env,FORCE_COLOR:'0',NO_COLOR:'1'}});

// Parse JSON
const okIdx=stdout.indexOf('"ok"');
const brace=stdout.lastIndexOf('{',okIdx);
let depth=0,end=0;
for(let i=brace;i<stdout.length;i++){if(stdout[i]==='{')depth++;if(stdout[i]==='}'){depth--;if(depth===0){end=i+1;break;}}}
const j=JSON.parse(stdout.slice(brace,end));
const ts=j.summary?.trafficSummary||{};

console.log('queries:',j.audit?.queriesPerformed?.length);
console.log('alerts:',j.summary?.alertSummary?.total);
console.log('appOverview:',Object.keys(ts.appOverview||{}).length>0?'Y':'N');
console.log('userExpTrend:',ts.userExpTrend?'Y':'N');
console.log('trafficTrend:',ts.trend?'Y':'N');
console.log('slowClients:',ts.slowClients?.length);
console.log('externalTraffic:',ts.externalTraffic?.length);
console.log('conversations:',ts.conversations?.length);
console.log('internalTraffic:',ts.internalTraffic?.length);

// Full render test
const {normalizeReportInput}=require('../skills/openclaw-napm-report/services/ReportInputContractService');
const ReportGenerationService=require('../skills/openclaw-napm-report/services/ReportGenerationService');
const out=path.join(tmp,'app_render_'+Date.now());
fs.mkdirSync(out,{recursive:true});
const n=normalizeReportInput({sourceResult:j});
console.log('normalized userExpTrend:',!!n.summary?.trafficSummary?.userExpTrend);
const svc=new ReportGenerationService({outputDir:out,downloadBaseUrl:'/reports'});
svc.generate(n).then(r=>{
  console.log('render ok:',r.ok,'size:',r.filePath?fs.statSync(r.filePath).size:0);
  fs.rmSync(qf);
  console.log('DONE');
}).catch(e=>{console.error(e);fs.rmSync(qf);});
