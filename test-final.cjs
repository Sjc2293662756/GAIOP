const FaultDiagnosisService = require('./skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');
const ReportGenerationService = require('./skills/openclaw-napm-report/services/ReportGenerationService');
const fs=require('fs');const os=require('os');const p=require('path');

async function main(){
const session={flowType:'bs_app_slow',flowLabel:'B/S 架构业务慢',description:'回溯238web HTTP 400/500 报错分析',target:{groupType:'WebApplication',groupArgument:'回溯238web',groupLabel:'回溯238web'},faultInput:{description:'238web HTTP 400/500 报错分析',severity:'major',recommendations:['排查400错误集中的页面路径','检查请求参数合法性','WAF层过滤非业务扫描流量'],prevention:['定期检查HTTP状态码分布','修复后复验']},timeRange:{displayText:'2026-06-30 ~ 2026-07-01'},context:{faultStart:1,faultEnd:2,target:{groupType:'WebApplication',groupArgument:'回溯238web',groupLabel:'回溯238web'}},completedSteps:[
{stepId:'step1_4xx_5xx_overview',rawData:{httpErrorsTop:[{keyLabel:'回溯238web',metricValues:[{metric:{id:'PGHTTP400'},value:566},{metric:{id:'PGHTTP400PCT'},value:8.77},{metric:{id:'PGHTTP500'},value:0},{metric:{id:'PGHTTP500PCT'},value:0}]},{keyLabel:'可观测239web',metricValues:[{metric:{id:'PGHTTP400'},value:1203},{metric:{id:'PGHTTP400PCT'},value:96.5},{metric:{id:'PGHTTP500'},value:0}]}]},hints:[{type:'judgment',text:'HTTP 400 升高'},{type:'judgment',text:'HTTP 500 为零，服务端正常'}]},
{stepId:'step2_page_error_analysis',rawData:{pageErrorAnalysis:[{group:{argument:'8573230'},groupPath:'web>pages>page 8573230/https://x.com/webservice',metricValues:[{metric:{id:'PGNPGE'},value:1036},{metric:{id:'PGNOBJE'},value:1000},{metric:{id:'PGHTTP200'},value:900},{metric:{id:'PGHTTP300'},value:59},{metric:{id:'PGHTTP400'},value:77},{metric:{id:'PGHTTP500'},value:0}]},{group:{argument:'8573228'},groupPath:'web>pages>page 8573228/http://x.com/',metricValues:[{metric:{id:'PGNPGE'},value:30},{metric:{id:'PGHTTP200'},value:18},{metric:{id:'PGHTTP400'},value:12},{metric:{id:'PGHTTP500'},value:0}]},{group:{argument:'8615060'},groupPath:'web>pages>page 8615060/http://x.com/v1/models',metricValues:[{metric:{id:'PGNPGE'},value:8},{metric:{id:'PGHTTP200'},value:3},{metric:{id:'PGHTTP400'},value:3},{metric:{id:'PGHTTP500'},value:2}]}]},hints:[{type:'judgment',text:'某页面 500 错误突出'},{type:'judgment',text:'访问最高页错误多，影响面广'}]},
{stepId:'step3_page_status_detail',rawData:{pageDetail_8573230:{rows:[{statusCode:'200',count:900},{statusCode:'301',count:59},{statusCode:'400',count:77}]},pageDetail_8615060:{rows:[{statusCode:'200',count:3},{statusCode:'400',count:3},{statusCode:'500',count:2}]}},hints:[{type:'judgment',text:'v1/models 同时存在400+500'}]}
]};

const svc=new FaultDiagnosisService();
const rd=svc._buildBsTemplateData(session);
console.log('templateId:',rd.templateId,'| step1:',rd.diagnosis.step1.http400Total,'| step2:',rd.diagnosis.step2.pages.length,'| step3:',rd.diagnosis.step3.pageDetails.length);

const d=p.join(os.tmpdir(),'vf-'+Date.now());fs.mkdirSync(d);
const g=new ReportGenerationService({outputDir:d});
const r=await g.generate(rd);
if(!r.ok){console.log('FAIL:',r.message);process.exit(1);}

const JSZip=require('jszip');const z=await JSZip.loadAsync(fs.readFileSync(r.filePath));const x=await z.file('word/document.xml').async('string');const t=x.replace(/<[^>]+>/g,'\n').replace(/\n{3,}/g,'\n');
console.log('Report:',r.fileName,'('+fs.statSync(r.filePath).size+' bytes)\n');

const cks=[
  ['封面','业务故障分析报告'],['目录','TOC'],
  ['1 基本信息','回溯238web','B/S 架构业务慢'],
  ['2.1 Step1','566','可观测239web'],
  ['2.2 Step2','webservice','1036','77'],
  ['2.3 Step3','v1/models','400+500 异常'],
  ['3 证据','3 证据项','3 个页面详情'],
  ['4 根因','566 次 HTTP 400','8.77%'],
  ['5 建议','排查400错误'],
  ['6 验证','修复后复验'],
  ['NO generic','报告基础信息'],
];
let ok=0,total=0;
for(const ck of cks){
  for(let i=1;i<ck.length;i++){
    total++;
    const found=ck[0].startsWith('NO')?!t.includes(ck[i]):t.includes(ck[i]);
    if(!found)console.log('  ❌',ck[0],'/',ck[i].slice(0,40));
    else ok++;
  }
}
console.log(ok+'/'+total+' ALL PASSED');
fs.rmSync(d,{recursive:true,force:true});
process.exit(ok===total?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
