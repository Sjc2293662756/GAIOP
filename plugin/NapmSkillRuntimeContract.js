'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NAPM_SKILL_RUNTIME_ENTRIES = Object.freeze([
  { toolName: 'napm-skill-query', skillDir: 'openclaw-napm-query', scriptName: 'run_napm_query.js' },
  { toolName: 'napm-report-export', skillDir: 'openclaw-napm-report', scriptName: 'generate_napm_report.js' },
  { toolName: 'napm-packet-analysis', skillDir: 'openclaw-napm-packet-analysis', scriptName: 'run_packet_analysis.js' },
  { toolName: 'napm-alert-query', skillDir: 'openclaw-napm-alert-query', scriptName: 'run_alert_query.js' },
  { toolName: 'napm-alert-packet-analysis', skillDir: 'openclaw-napm-alert-packet-analysis', scriptName: 'run_alert_packet_analysis.js' },
  { toolName: 'napm-inspection-snapshot', skillDir: 'openclaw-napm-inspection', scriptName: 'run_inspection_snapshot.js' },
  { toolName: 'napm-summary', skillDir: 'openclaw-napm-summary', scriptName: 'run_summary.js' },
  { toolName: 'napm-fault-diagnosis', skillDir: 'openclaw-napm-fault-diagnosis', scriptName: 'run_fault_diagnosis.js' }
]);

function resolveRuntimePath(skillsRoot, entry) {
  return path.resolve(skillsRoot, entry.skillDir, 'scripts', entry.scriptName);
}

function inspectNapmSkillRuntimeContracts(skillsRoot, options = {}) {
  const root = path.resolve(skillsRoot);
  const reload = Boolean(options.reload);

  return NAPM_SKILL_RUNTIME_ENTRIES.map((entry) => {
    const runtimePath = resolveRuntimePath(root, entry);
    if (!fs.existsSync(runtimePath)) {
      return {
        ...entry,
        runtimePath,
        ok: false,
        reason: 'RUNTIME_FILE_MISSING'
      };
    }

    try {
      const resolvedPath = require.resolve(runtimePath);
      if (reload) delete require.cache[resolvedPath];
      const runtime = require(runtimePath);
      if (typeof runtime?.handleSkillCall !== 'function') {
        return {
          ...entry,
          runtimePath,
          ok: false,
          reason: 'HANDLE_SKILL_CALL_MISSING'
        };
      }

      return {
        ...entry,
        runtimePath,
        ok: true,
        reason: null
      };
    } catch (error) {
      return {
        ...entry,
        runtimePath,
        ok: false,
        reason: 'RUNTIME_LOAD_FAILED',
        message: error?.message || String(error)
      };
    }
  });
}

function assertNapmSkillRuntimeContracts(skillsRoot, options = {}) {
  const results = inspectNapmSkillRuntimeContracts(skillsRoot, options);
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return results;

  const error = new Error(
    `NAPM Skill runtime contract failed: ${failures.map((item) => `${item.toolName}=${item.reason}`).join(', ')}`
  );
  error.code = 'NAPM_SKILL_RUNTIME_CONTRACT_FAILED';
  error.results = results;
  throw error;
}

module.exports = {
  NAPM_SKILL_RUNTIME_ENTRIES,
  resolveRuntimePath,
  inspectNapmSkillRuntimeContracts,
  assertNapmSkillRuntimeContracts
};
