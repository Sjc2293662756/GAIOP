#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AlertPacketWorkflowService = require('../services/AlertPacketWorkflowService');

function loadRuntimeDependencies() {
  return {
    alertSkill: require('../../openclaw-napm-alert-query/scripts/run_alert_query'),
    packetSkill: require('../../openclaw-napm-packet-analysis/scripts/run_packet_analysis')
  };
}

async function executeAlertPacketAnalysis(params = {}, options = {}) {
  const dependencies = {
    ...loadRuntimeDependencies(),
    ...options,
    retryDelaysMs: options.retryDelaysMs || parseRetryDelays(process.env.NAPM_ALERT_PACKET_RETRY_DELAYS_MS),
    maxWindowSeconds: options.maxWindowSeconds || process.env.NAPM_ALERT_PACKET_MAX_WINDOW_SECONDS,
    maxCandidates: options.maxCandidates || process.env.NAPM_ALERT_PACKET_MAX_CANDIDATES
  };
  return new AlertPacketWorkflowService(dependencies).execute(params);
}

async function handleSkillCall(params = {}) {
  try {
    return await executeAlertPacketAnalysis(params);
  } catch (error) {
    return {
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState: 'WORKFLOW_RUNTIME_FAILED',
      error: {
        code: error?.code || 'WORKFLOW_RUNTIME_FAILED',
        message: error?.message || String(error)
      }
    };
  }
}

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--queryFile') args.queryFile = argv[++index];
    else if (item === '--queryJson') args.queryJson = argv[++index];
  }
  return args;
}

function loadQuery(args = {}) {
  if (args.queryFile) {
    return JSON.parse(fs.readFileSync(path.resolve(args.queryFile), 'utf8'));
  }
  if (args.queryJson) {
    return JSON.parse(args.queryJson);
  }
  return {};
}

function parseRetryDelays(value) {
  if (!value) return undefined;
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  return parsed.every(Number.isFinite) ? parsed : undefined;
}

async function main() {
  const result = await handleSkillCall(loadQuery(parseArgs(process.argv.slice(2))));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState: 'WORKFLOW_RUNTIME_FAILED',
      error: { code: error?.code || 'WORKFLOW_RUNTIME_FAILED', message: error?.message || String(error) }
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  handleSkillCall,
  executeAlertPacketAnalysis,
  loadQuery,
  parseArgs,
  __test__: { parseRetryDelays }
};
