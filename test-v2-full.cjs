const FaultDiagnosisReportBuilder = require('./skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisReportBuilder');
const ReportGenerationService = require('./skills/openclaw-napm-report/services/ReportGenerationService');
const fs = require('fs'); const os = require('os'); const path = require('path');

async function main() {
  // Simulate a B/S session with NAPM data in the SAME format the remote produces
  const session = {
    flowType: 'bs_app_slow', flowLabel: 'B/S 架构业务慢',
    description: '回溯238web 业务故障分析',
    faultInput: { description: '238web HTTP 400/500 报错', severity: 'major',
      recommendations: ['定位错误页面：深入查看各页面 HTTP 400 分布','检查客户端请求参数','检查 NAPM 时间分布'],
      prevention: ['排查修复后重新查看 HTTP 400 是否下降','确认异常指标恢复后关闭'] },
    timeRange: { start: 1782805440, end: 1782891840, displayText: '2026-06-30 12:44 ~ 2026-07-01 12:45' },
    context: { faultStart: 1782805440, faultEnd: 1782891840, target: { groupType: 'WebApplication', groupArgument: '回溯238web', groupLabel: '回溯238web' } },
    completedSteps: [
      {
        stepId: 'step1_4xx_5xx_overview',
        rawData: {
          httpErrorsTop: [
            { key: '1006/119/0/回溯238web', keyLabel: '回溯238web', metricValues: [
              {metric:{id:'PGHTTP400'},value:312},{metric:{id:'PGHTTP400PCT'},value:13.03},
              {metric:{id:'PGHTTP500'},value:0},{metric:{id:'PGHTTP500PCT'},value:0}
            ]},
            { key: '1006/126/0/可观测239web', keyLabel: '可观测239web', metricValues: [
              {metric:{id:'PGHTTP400'},value:603},{metric:{id:'PGHTTP400PCT'},value:96.95},
              {metric:{id:'PGHTTP500'},value:0},{metric:{id:'PGHTTP500PCT'},value:0}
            ]}
          ]
        },
        hints: [{type:'judgment',text:'HTTP 400数量/比例升高，分析请求、参数、权限、URL问题'}]
      },
      {
        stepId: 'step2_page_error_analysis',
        rawData: {
          pageErrorAnalysis: [
            { group: {type:'PageFamily',argument:'8573230'}, groupPath: 'webApplication 1006/119/0/回溯238web>pages>page 8573230/http://101.254.114.238/geoip/', metricValues: [
              {metric:{id:'PGNPGE'},value:1250},{metric:{id:'PGNOBJE'},value:1200},
              {metric:{id:'PGHTTP200'},value:1050},{metric:{id:'PGHTTP300'},value:30},
              {metric:{id:'PGHTTP400'},value:165},{metric:{id:'PGHTTP500'},value:5}
            ]},
            { group: {type:'PageFamily',argument:'8573228'}, groupPath: 'webApplication 1006/119/0/回溯238web>pages>page 8573228/http://101.254.114.238/form.html', metricValues: [
              {metric:{id:'PGNPGE'},value:890},{metric:{id:'PGNOBJE'},value:850},
              {metric:{id:'PGHTTP200'},value:800},{metric:{id:'PGHTTP300'},value:15},
              {metric:{id:'PGHTTP400'},value:32},{metric:{id:'PGHTTP500'},value:3}
            ]},
            { group: {type:'PageFamily',argument:'8615060'}, groupPath: 'webApplication 1006/119/0/回溯238web>pages>page 8615060/http://101.254.114.238/v1/models', metricValues: [
              {metric:{id:'PGNPGE'},value:213},{metric:{id:'PGNOBJE'},value:200},
              {metric:{id:'PGHTTP200'},value:100},{metric:{id:'PGHTTP300'},value:0},
              {metric:{id:'PGHTTP400'},value:95},{metric:{id:'PGHTTP500'},value:5}
            ]}
          ]
        },
        hints: [{type:'judgment',text:'某页面400错误突出，建议对该页面进行状态码详情分析'},
                {type:'judgment',text:'访问数最高的页面同时出现大量错误，影响面广'}]
      }
    ]
  };

  const builder = new FaultDiagnosisReportBuilder();
  const reportData = builder.build(session, { format: 'docx' });
  console.log('Sections:', reportData.sections.length);

  const outDir = path.join(os.tmpdir(), 'v2-final-' + Date.now());
  fs.mkdirSync(outDir, {recursive:true});
  const svc = new ReportGenerationService({ outputDir: outDir });
  const result = await svc.generate(reportData);

  if (result.ok) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(result.filePath));
    const xml = await zip.file('word/document.xml').async('string');

    console.log('File:', result.fileName, '(' + fs.statSync(result.filePath).size + ' bytes)\n');

    // Full structure check
    const checks = [
      ['1 基本信息', '1 基本信息'],
      ['2 分析过程', '2 分析过程'],
      ['2.1 Step1', '第一步：查询业务 4xx/5xx'],
      ['httpErrorsTop table', '回溯238web'],
      ['PGHTTP400 value', '312'],
      ['2.2 Step2', '第二步：页面错误分析'],
      ['pageErrorAnalysis table', '/geoip/'],
      ['pageErrorAnalysis table', '/form.html'],
      ['pageErrorAnalysis table', '/v1/models'],
      ['PGNPGE column', '1250'],
      ['PGHTTP400 column', '165'],
      ['3 证据项', '3 证据项'],
      ['4 根因判断', '4 根因判断'],
      ['5 处置建议', '5 处置建议'],
      ['6 验证方式', '6 验证方式'],
      ['NO [object Object]', '[object Object]'],
    ];

    let passed = 0, failed = 0;
    for (const [label, needle] of checks) {
      const found = xml.includes(needle);
      if (label.startsWith('NO ') ? !found : found) {
        if (!label.startsWith('NO ')) console.log('  ✅', label);
        else console.log('  ✅', label.replace('NO ',''));
        passed++;
      } else {
        console.log('  ❌', label);
        failed++;
      }
    }
    console.log(`\n${passed}/${passed+failed} checks passed`);
    fs.rmSync(outDir, {recursive:true,force:true});
    process.exit(failed > 0 ? 1 : 0);
  } else {
    console.log('FAILED:', result.message);
    process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
