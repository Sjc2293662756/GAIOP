#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const ReportGenerationService = require(path.join(workspaceRoot, 'skills/openclaw-napm-report/services/ReportGenerationService'));
const { normalizeReportInput } = require(path.join(workspaceRoot, 'skills/openclaw-napm-report/services/ReportInputContractService'));

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
    } else if (arg === '--format') {
      args.format = argv[index + 1];
      index += 1;
    } else if (arg === '--title') {
      args.title = argv[index + 1];
      index += 1;
    } else if (arg === '--prompt') {
      args.prompt = argv[index + 1];
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
  const reportData = normalizeReportInput(payload, {
    format: args.format,
    title: args.title,
    prompt: args.prompt,
    sourceQuestion: args.prompt
  });
  const service = new ReportGenerationService({
    outputDir: args.outputDir,
    downloadBaseUrl: args.downloadBaseUrl
  });
  const result = await service.generate(reportData);
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

/**
 * Plugin 通过 require() 同进程调用的入口。
 * params 已经是 JavaScript 对象，无需 JSON 解析/cli 参数合并。
 */
async function handleSkillCall(params = {}) {
  try {
    const reportData = normalizeReportInput(params, {
      format: params.format,
      title: params.title,
      prompt: params.prompt,
      sourceQuestion: params.prompt,
    });

    const service = new ReportGenerationService({
      outputDir: params.outputDir,
      downloadBaseUrl: params.downloadBaseUrl,
    });

    const result = await service.generate(reportData);
    return result;
  } catch (error) {
    return {
      ok: false,
      errorCode: error?.code || 'REPORT_GENERATION_FAILED',
      message: error?.message || String(error),
    };
  }
}

module.exports = {
  parseArgs,
  readInput,
  handleSkillCall,
};
