'use strict';

/**
 * NAPM Fault Diagnosis CLI entry point.
 *
 * Runs the diagnostic flow only. Report generation is handled separately
 * by napm-report-export in the plugin pipeline.
 *
 * Usage:
 *   node run_fault_diagnosis.js --queryFile <path-to-json>
 *
 * Output: JSON to stdout with { ok, reportReady, reportData, steps }
 */

const fs = require('fs');
const FaultDiagnosisService = require('../services/FaultDiagnosisService');

async function main() {
  const args = process.argv.slice(2);

  let payload = null;
  const queryFileIdx = args.indexOf('--queryFile');
  if (queryFileIdx >= 0 && args[queryFileIdx + 1]) {
    const filePath = args[queryFileIdx + 1];
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`[fault-diagnosis] File not found: ${filePath}\n`);
      process.exit(1);
    }
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  if (!payload) {
    payload = { description: '未命名故障', flowType: 'bs_app_slow' };
  }

  try {
    const service = new FaultDiagnosisService();
    const result = await service.run(payload);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`[fault-diagnosis] Error: ${error.message}\n`);
    process.stdout.write(JSON.stringify({
      ok: false,
      error: { code: 'FAULT_DIAGNOSIS_CRASH', message: error.message }
    }));
  }
}

/**
 * Plugin 通过 require() 同进程调用的入口。
 * params 已经是 JavaScript 对象，无需 JSON 解析。
 */
async function handleSkillCall(params = {}) {
  const payload = {
    description: params.description || params.prompt || '',
    flowType: params.flowType || undefined,
    timeRange: params.timeRange || undefined,
    target: params.target || undefined,
    fault: params.fault || { description: params.description || params.prompt || '' },
    traceId: params.traceId || undefined,
  };

  try {
    const service = new FaultDiagnosisService();
    const result = await service.run(payload);
    return result;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || 'FAULT_DIAGNOSIS_ERROR',
        message: error.message || String(error),
      },
    };
  }
}

// 保留 CLI 入口（本地测试用）
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[fault-diagnosis] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { handleSkillCall };
