#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

function loadDotenv() {
  const candidates = [
    path.join(workspaceRoot, 'node_modules', 'dotenv'),
    'dotenv'
  ];

  for (const candidate of candidates) {
    try {
      require(candidate).config({
        path: path.join(workspaceRoot, '.env')
      });
      return;
    } catch (_error) {
      // try next candidate
    }
  }
}

loadDotenv();

const InspectionReportDataService = require(path.join(
  workspaceRoot,
  'skills/openclaw-napm-inspection/services/InspectionReportDataService'
));

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--payload') {
      args.payload = argv[index + 1];
      index += 1;
    } else if (arg === '--input') {
      args.input = argv[index + 1];
      index += 1;
    } else if (arg === '--format') {
      args.format = argv[index + 1];
      index += 1;
    } else if (arg === '--title') {
      args.title = argv[index + 1];
      index += 1;
    } else if (arg === '--customerName') {
      args.customerName = argv[index + 1];
      index += 1;
    } else if (arg === '--projectName') {
      args.projectName = argv[index + 1];
      index += 1;
    } else if (arg === '--reportDate') {
      args.reportDate = argv[index + 1];
      index += 1;
    } else if (arg === '--nowSeconds') {
      args.nowSeconds = argv[index + 1];
      index += 1;
    } else if (arg === '--host') {
      args.host = argv[index + 1];
      index += 1;
    } else if (arg === '--username') {
      args.username = argv[index + 1];
      index += 1;
    } else if (arg === '--password') {
      args.password = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function parseJsonText(name, text = '') {
  try {
    return JSON.parse(String(text || '{}').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid JSON for ${name}: ${error.message}`);
  }
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

async function readPayload(args = {}) {
  if (args.payload) {
    return parseJsonText('--payload', args.payload);
  }
  if (args.input) {
    const inputPath = path.resolve(args.input);
    return parseJsonText('--input', fs.readFileSync(inputPath, 'utf8'));
  }
  const raw = await readStdin();
  return parseJsonText('stdin', raw);
}

function applyCliOverrides(payload = {}, args = {}) {
  return {
    ...payload,
    format: args.format || payload.format,
    title: args.title || payload.title,
    customerName: args.customerName || payload.customerName,
    projectName: args.projectName || payload.projectName,
    reportDate: args.reportDate || payload.reportDate,
    nowSeconds: args.nowSeconds ? Number(args.nowSeconds) : payload.nowSeconds,
    host: args.host || payload.host,
    username: args.username || payload.username,
    password: args.password || payload.password
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = applyCliOverrides(await readPayload(args), args);
  const service = new InspectionReportDataService({
    host: payload.host,
    username: payload.username,
    password: payload.password,
    tlsInsecure: payload.tlsInsecure,
    timeoutMs: payload.timeoutMs
  });
  const result = await service.run(payload);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    const result = {
      ok: false,
      errorCode: error?.code || 'NAPM_INSPECTION_FAILED',
      message: error?.message || String(error),
      details: error?.details || undefined
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
    const service = new InspectionReportDataService({
      host: params.host,
      username: params.username,
      password: params.password,
      tlsInsecure: params.tlsInsecure,
      timeoutMs: params.timeoutMs,
    });

    const result = await service.run(params);
    return result;
  } catch (error) {
    return {
      ok: false,
      errorCode: error?.code || 'NAPM_INSPECTION_FAILED',
      message: error?.message || String(error),
      details: error?.details || undefined,
    };
  }
}

module.exports = {
  parseArgs,
  parseJsonText,
  applyCliOverrides,
  readPayload,
  handleSkillCall,
};
