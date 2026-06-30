'use strict';

/**
 * NAPM Fault Diagnosis CLI entry point.
 *
 * Usage:
 *   node run_fault_diagnosis.js --queryFile <path-to-json>
 *   node run_fault_diagnosis.js --queryJson '<json-string>'
 *
 * Input JSON shape:
 *   { description, flowType, timeRange, target, fault }
 *
 * Output: JSON to stdout with { ok, reportReady, reportData, steps }
 */

const fs = require('fs');
const FaultDiagnosisService = require('../services/FaultDiagnosisService');

async function main() {
  const args = process.argv.slice(2);

  // Parse input
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

  const queryJsonIdx = args.indexOf('--queryJson');
  if (queryJsonIdx >= 0 && args[queryJsonIdx + 1]) {
    payload = JSON.parse(args[queryJsonIdx + 1]);
  }

  if (!payload) {
    payload = { description: '未命名故障', flowType: 'network_slow' };
  }

  // Read from stdin if piped
  if (process.stdin && !process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const stdinStr = Buffer.concat(chunks).toString('utf8').trim();
      if (stdinStr) {
        payload = JSON.parse(stdinStr);
      }
    } catch (_) {
      // Keep payload as-is
    }
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

main().catch((err) => {
  process.stderr.write(`[fault-diagnosis] Fatal: ${err.message}\n`);
  process.exit(1);
});
