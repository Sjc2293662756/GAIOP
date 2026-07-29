#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const SummaryService = require('../services/SummaryService');
const SummaryReportDataService = require('../services/SummaryReportDataService');

// ── env loading ─────────────────────────────────────────────────

function loadDotEnvCandidates(candidates = []) {
  for (const candidate of candidates) {
    try {
      const filePath = path.resolve(workspaceRoot, candidate);
      if (!fs.existsSync(filePath)) continue;
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        const raw = trimmed.slice(idx + 1).trim();
        const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
        if (!process.env[key]) process.env[key] = value;
      }
    } catch (_err) {
      // skip missing files
    }
  }
}

// ── CLI args ────────────────────────────────────────────────────

function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--queryFile' && i + 1 < argv.length) {
      args.queryFile = argv[++i];
    } else if (arg === '--queryJson' && i + 1 < argv.length) {
      args.queryJson = argv[++i];
    } else if (arg === '--payload' && i + 1 < argv.length) {
      args.payload = argv[++i];
    }
  }
  return args;
}

function loadPayload(args = {}) {
  if (args.queryFile) {
    return JSON.parse(fs.readFileSync(path.resolve(args.queryFile), 'utf8'));
  }
  if (args.queryJson) {
    return JSON.parse(args.queryJson);
  }
  if (args.payload) {
    return JSON.parse(args.payload);
  }
  // Try reading from stdin
  try {
    const stdin = fs.readFileSync(process.stdin.fd, 'utf8').trim();
    if (stdin) return JSON.parse(stdin);
  } catch (_err) {
    // no stdin
  }
  return {};
}

// ── output ──────────────────────────────────────────────────────

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ── main ────────────────────────────────────────────────────────

async function executeSummaryQuery(payload = {}) {
  const service = new SummaryService();
  const reportDataService = new SummaryReportDataService();

  const result = await service.run(payload);
  const reportData = reportDataService.buildReportData(result, {
    format: payload.format,
    title: payload.title,
    systemName: payload.systemName,
    sourceQuestion: payload.sourceQuestion || payload.prompt
  });

  return {
    ...result,
    reportData
  };
}

async function main() {
  loadDotEnvCandidates([
    '.env',
    '.env.local',
    'skills/openclaw-napm-query/.env'
  ]);

  const args = parseArgs(process.argv.slice(2));
  const payload = loadPayload(args);

  const result = await executeSummaryQuery(payload);
  writeJson(result);
}

if (require.main === module) {
  main().catch((error) => {
    writeJson({
      ok: false,
      error: {
        code: 'SUMMARY_EXECUTION_FAILED',
        message: error.message
      }
    });
    process.exitCode = 1;
  });
}

/**
 * Plugin 通过 require() 同进程调用的入口。
 * params 已经是 JavaScript 对象，无需 JSON 解析。
 */
async function handleSkillCall(params = {}) {
  try {
    loadDotEnvCandidates([
      '.env',
      '.env.local',
      'skills/openclaw-napm-query/.env',
    ]);

    const payload = {
      ...params,
      sourceQuestion: params.sourceQuestion || params.prompt,
    };

    return await executeSummaryQuery(payload);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || 'SUMMARY_SKILL_ERROR',
        message: error.message || String(error),
      },
    };
  }
}

module.exports = { executeSummaryQuery, handleSkillCall };
