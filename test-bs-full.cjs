// Full B/S fault diagnosis E2E test — simulates FaultDiagnosisService.run() output
const FaultDiagnosisService = require('./skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');
const ReportGenerationService = require('./skills/openclaw-napm-report/services/ReportGenerationService');
const fs = require('fs'); const os = require('os'); const path = require('path');

async function main() {
  // Simulate session with all 3 steps completed (matching real NAPM data format)
  const session = {
    flowType: 'bs_app_slow',
    flowLabel: 'B/S 架构业务慢',
    description: '回溯238web HTTP 400/500 报错分析',
    target: { groupType: 'WebApplication', groupArgument: '回溯238web', groupLabel: '回溯238web' },
    faultInput: {
      description: '238web HTTP 400/500 报错分析',
      severity: 'major',
      recommendations: ['排查400错误集中的页面路径','检查请求参数合法性','WAF层过滤非业务扫描流量'],
      prevention: ['定期检查HTTP状态码分布','对异常页面设置告警阈值','修复后在相同时间窗口复验']
    },
    timeRange: { start: 1782800000, end: 1782886400, displayText: '2026-06-30 ~ 2026-07-01' },
    context: { faultStart: 1782800000, faultEnd: 1782886400, target: { groupType: 'WebApplication', groupArgument: '回溯238web', groupLabel: '回溯238web' } },
    completedSteps: [
      // Step 1: 4xx/5xx overview — format A (array of items with metricValues)
      {
        stepId: 'step1_4xx_5xx_overview',
        rawData: {
          httpErrorsTop: [
            { key: '1006/119/0/回溯238web', keyLabel: '回溯238web', metricValues: [
              { metric: { id: 'PGHTTP400' }, value: 566 },
              { metric: { id: 'PGHTTP400PCT' }, value: 8.77 },
              { metric: { id: 'PGHTTP500' }, value: 0 },
              { metric: { id: 'PGHTTP500PCT' }, value: 0 }
            ]},
            { key: '1006/126/0/可观测239web', keyLabel: '可观测239web', metricValues: [
              { metric: { id: 'PGHTTP400' }, value: 1203 },
              { metric: { id: 'PGHTTP400PCT' }, value: 96.5 },
              { metric: { id: 'PGHTTP500' }, value: 0 },
              { metric: { id: 'PGHTTP500PCT' }, value: 0 }
            ]},
            { key: '1006/125/0/回溯_237_web', keyLabel: '回溯_237_web', metricValues: [
              { metric: { id: 'PGHTTP400' }, value: 45 },
              { metric: { id: 'PGHTTP400PCT' }, value: 12.3 },
              { metric: { id: 'PGHTTP500' }, value: 2 },
              { metric: { id: 'PGHTTP500PCT' }, value: 0.5 }
            ]}
          ]
        },
        hints: [
          { type: 'judgment', text: 'HTTP 400 数量/比例升高，需定位到具体页面路径' },
          { type: 'judgment', text: 'HTTP 500 为零，服务端运行正常' }
        ]
      },
      // Step 2: page error analysis — format B (3-group drill-down, raw array)
      {
        stepId: 'step2_page_error_analysis',
        rawData: {
          pageErrorAnalysis: [
            { group: { type: 'PageFamily', argument: '8573230' },
              groupPath: 'webApplication>pages>page 8573230/https://101.254.114.238/webservice/NetInside',
              metricValues: [
                { metric: { id: 'PGNPGE' }, value: 1036 },
                { metric: { id: 'PGNOBJE' }, value: 1000 },
                { metric: { id: 'PGHTTP200' }, value: 900 },
                { metric: { id: 'PGHTTP300' }, value: 59 },
                { metric: { id: 'PGHTTP400' }, value: 77 },
                { metric: { id: 'PGHTTP500' }, value: 0 }
              ]},
            { group: { type: 'PageFamily', argument: '8573228' },
              groupPath: 'webApplication>pages>page 8573228/http://101.254.114.238/',
              metricValues: [
                { metric: { id: 'PGNPGE' }, value: 30 },
                { metric: { id: 'PGNOBJE' }, value: 30 },
                { metric: { id: 'PGHTTP200' }, value: 18 },
                { metric: { id: 'PGHTTP300' }, value: 0 },
                { metric: { id: 'PGHTTP400' }, value: 12 },
                { metric: { id: 'PGHTTP500' }, value: 0 }
              ]},
            { group: { type: 'PageFamily', argument: '8573229' },
              groupPath: 'webApplication>pages>page 8573229/http://101.254.114.238/upl.php',
              metricValues: [
                { metric: { id: 'PGNPGE' }, value: 15 },
                { metric: { id: 'PGNOBJE' }, value: 15 },
                { metric: { id: 'PGHTTP200' }, value: 13 },
                { metric: { id: 'PGHTTP300' }, value: 0 },
                { metric: { id: 'PGHTTP400' }, value: 2 },
                { metric: { id: 'PGHTTP500' }, value: 0 }
              ]},
            { group: { type: 'PageFamily', argument: '8615060' },
              groupPath: 'webApplication>pages>page 8615060/http://101.254.114.238/v1/models',
              metricValues: [
                { metric: { id: 'PGNPGE' }, value: 8 },
                { metric: { id: 'PGNOBJE' }, value: 8 },
                { metric: { id: 'PGHTTP200' }, value: 3 },
                { metric: { id: 'PGHTTP300' }, value: 0 },
                { metric: { id: 'PGHTTP400' }, value: 3 },
                { metric: { id: 'PGHTTP500' }, value: 2 }
              ]}
          ]
        },
        hints: [
          { type: 'judgment', text: '某页面 500 错误突出，服务端或后端依赖问题概率高' },
          { type: 'judgment', text: '访问数最高的页面同时出现大量错误，影响面广' }
        ]
      },
      // Step 3: pageViews per-page details
      {
        stepId: 'step3_page_status_detail',
        rawData: {
          pageDetail_8573230: { rows: [
            { statusCode: '200', count: 900 }, { statusCode: '301', count: 59 }, { statusCode: '400', count: 77 }
          ]},
          pageDetail_8573228: { rows: [
            { statusCode: '200', count: 18 }, { statusCode: '400', count: 12 }
          ]},
          pageDetail_8573229: { rows: [
            { statusCode: '200', count: 13 }, { statusCode: '400', count: 2 }
          ]},
          pageDetail_8615060: { rows: [
            { statusCode: '200', count: 3 }, { statusCode: '400', count: 3 }, { statusCode: '500', count: 2 }
          ]}
        },
        hints: [
          { type: 'judgment', text: '多个页面同时500，可能是公共组件故障' },
          { type: 'judgment', text: 'v1/models 页面同时存在400+500，需重点排查' }
        ]
      }
    ]
  };

  // Step A: Test _buildBsTemplateData
  const svc = new FaultDiagnosisService();
  const reportData = svc._buildBsTemplateData(session);
  console.log('=== Template Data ===');
  console.log('  templateId:', reportData.templateId);
  console.log('  diagnosis.targetLabel:', reportData.diagnosis.targetLabel);
  console.log('  step1.topApps:', reportData.diagnosis.step1.topApps.length);
  console.log('  step1.http400Total:', reportData.diagnosis.step1.http400Total);
  console.log('  step2.pages:', reportData.diagnosis.step2.pages.length);
  console.log('  step3.pageDetails:', reportData.diagnosis.step3.pageDetails.length);

  // Step B: Generate report
  const outDir = path.join(os.tmpdir(), 'bs-full-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const genSvc = new ReportGenerationService({ outputDir: outDir });
  const result = await genSvc.generate(reportData);

  if (!result.ok) { console.log('FAILED:', result.message); process.exit(1); }

  console.log('\n=== Generated Report ===');
  console.log('  file:', result.fileName, '(' + fs.statSync(result.filePath).size + ' bytes)');

  // Step C: Verify content
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const xml = await zip.file('word/document.xml').async('string');
  const t = xml.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n');

  const checks = [
    // Structure
    ['封面', '业务故障分析报告'],
    ['目录', 'TOC'],
    ['1 基本信息', '1 基本信息'],
    ['2 分析过程', '2 分析过程'],
    ['2.1 Step1', '2.1 第一步'],
    ['2.2 Step2', '2.2 第二步'],
    ['2.3 Step3', '2.3 第三步'],
    ['3 证据项', '3 证据项'],
    ['4 根因判断', '4 根因判断'],
    ['5 处置建议', '5 处置建议'],
    ['6 验证方式', '6 验证方式'],
    // Step1 data
    ['Step1 回溯238web label', '回溯238web'],
    ['Step1 HTTP400 count', '566'],
    ['Step1 可观测239web', '可观测239web'],
    // Step2 data — page URLs from groupPath
    ['Step2 page 1', 'webservice'],
    ['Step2 page 2', '101.254.114.238'],
    ['Step2 PGNPGE 1036', '1036'],
    ['Step2 PGHTTP400 77', '77'],
    // Step3 data
    ['Step3 page detail count', '4 个页面详情'],
    // Narrative
    ['Root cause narrative', '400 错误'],
    // NO generic fallback
    ['NO 报告基础信息', '报告基础信息'],
  ];

  let passed = 0, failed = 0;
  for (const [label, needle] of checks) {
    const expectFound = !label.startsWith('NO ');
    const found = t.includes(needle);
    const ok = found === expectFound;
    if (ok) { passed++; console.log('  ✅', label); }
    else { failed++; console.log('  ❌', label, found ? '(unexpected)' : '(not found)'); }
  }

  console.log(`\n${passed}/${passed+failed} checks passed`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
