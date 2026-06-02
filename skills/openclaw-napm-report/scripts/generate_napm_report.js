#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const ReportGenerationService = require(path.join(workspaceRoot, 'skills/openclaw-napm-report/services/ReportGenerationService'));

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      args.input = argv[index + 1];
      index += 1;
    } else if (arg === '--outputDir') {
      args.outputDir = argv[index + 1];
      index += 1;
    } else if (arg === '--downloadBaseUrl') {
      args.downloadBaseUrl = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let content = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      content += chunk;
    });
    process.stdin.on('end', () => resolve(content));
    process.stdin.on('error', reject);
  });
}

async function readInput(args = {}) {
  if (args.input) {
    return fs.readFileSync(path.resolve(args.input), 'utf8');
  }
  return readStdin();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readInput(args);
  const payload = JSON.parse(String(raw || '{}').replace(/^\uFEFF/, ''));
  const service = new ReportGenerationService({
    outputDir: args.outputDir,
    downloadBaseUrl: args.downloadBaseUrl
  });
  const result = await service.generate(payload);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    const result = {
      ok: false,
      errorCode: error?.code || 'REPORT_GENERATION_FAILED',
      message: error?.message || String(error)
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  readInput
};
