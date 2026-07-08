// CS Application Fault Diagnosis end-to-end test
const FaultDiagnosisService = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');

async function main() {
  const service = new FaultDiagnosisService();

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    description: '某C/S架构桌面应用访问慢，客户端操作响应延迟大',
    flowType: 'cs_app_slow',
    timeRange: {
      faultWindow: { start: now - 7200, end: now },
      baselineWindow: { start: now - 86400, end: now - 7200 }
    },
    target: {
      groupType: 'DefinedApp',
      groupArgument: '',
      groupLabel: '测试应用'
    },
    fault: {
      description: 'C/S应用访问慢',
      severity: 'major'
    }
  };

  console.log('=== CS Application Fault Diagnosis Flow Test ===');
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('');

  try {
    const result = await service.run(payload);

    console.log('--- Result ---');
    console.log('ok:', result.ok);
    console.log('flowType:', result.flowType);
    console.log('flowLabel:', result.flowLabel);
    console.log('steps count:', result.steps ? result.steps.length : 0);

    if (result.steps) {
      result.steps.forEach((s, i) => {
        console.log(`\n  Step ${i + 1}: ${s.stepId}`);
        console.log('    description:', s.description);
        console.log('    hints:', s.hints ? s.hints.length : 0);
        console.log('    analysisFlags keys:', s.analysisFlags ? Object.keys(s.analysisFlags).filter(k => !k.startsWith('_')).join(', ') : 'none');
      });
    }

    if (result.reportData) {
      console.log('\n--- Report Data ---');
      console.log('templateId:', result.reportData.templateId);
      console.log('reportType:', result.reportData.reportType);
      console.log('diagnosis.flowType:', result.reportData.diagnosis?.flowType);
      console.log('diagnosis.stepCount:', result.reportData.diagnosis?.stepCount);
      console.log('diagnosis.step1 keys:', Object.keys(result.reportData.diagnosis?.step1 || {}));
      console.log('diagnosis.step2 keys:', Object.keys(result.reportData.diagnosis?.step2 || {}));
      console.log('diagnosis.step3.peaks count:', (result.reportData.diagnosis?.step3?.peaks || []).length);
      console.log('diagnosis.step3.overallClients count:', (result.reportData.diagnosis?.step3?.overallClients || []).length);

      // Verify CS-specific fields
      const checks = [];
      checks.push({ name: 'templateId is CS v1', pass: result.reportData.templateId === 'napm_cs_fault_diagnosis_v1' });
      checks.push({ name: 'reportType is diagnostic_report', pass: result.reportData.reportType === 'diagnostic_report' });
      checks.push({ name: 'diagnosis exists', pass: !!result.reportData.diagnosis });
      checks.push({ name: 'diagnosis.step1 exists', pass: !!result.reportData.diagnosis?.step1 });
      checks.push({ name: 'diagnosis.step2 exists', pass: !!result.reportData.diagnosis?.step2 });
      checks.push({ name: 'diagnosis.step3 exists', pass: !!result.reportData.diagnosis?.step3 });
      checks.push({ name: '3 steps completed', pass: result.steps?.length === 3 });

      console.log('\n--- Checks ---');
      let allPass = true;
      for (const c of checks) {
        console.log(`  ${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`);
        if (!c.pass) allPass = false;
      }

      if (allPass) {
        console.log('\nAll checks passed!');
      } else {
        console.log('\nSome checks FAILED.');
        process.exit(1);
      }
    }

    // Test template rendering
    console.log('\n--- Template Rendering Test ---');
    try {
      const ReportTemplateService = require('../skills/openclaw-napm-report/services/ReportTemplateService');
      const templateSvc = new ReportTemplateService();
      const docxBuffer = await templateSvc.renderDocx(result.reportData);
      console.log('Docx generated:', docxBuffer ? `Buffer(${docxBuffer.length} bytes)` : 'NULL');
      console.log('Template rendering PASS');
    } catch (err) {
      console.log('Template rendering FAIL:', err.message);
      process.exit(1);
    }
  } catch (error) {
    console.error('Test FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main };
