const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const specPath = path.join(workspaceRoot, 'config', 'napm-resolution-spec.v1.json');

let cachedSpec = null;

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function loadResolutionSpec() {
  if (cachedSpec) {
    return cloneJson(cachedSpec);
  }

  const raw = fs.readFileSync(specPath, 'utf8');
  cachedSpec = JSON.parse(raw);
  return cloneJson(cachedSpec);
}

function getServiceSpec(serviceName = '') {
  const spec = loadResolutionSpec();
  const normalized = String(serviceName || '').trim();
  return cloneJson(spec?.services?.[normalized] || null);
}

function getBoundaryMode(defaultMode = 'compat') {
  const raw = String(process.env.NAPM_RESOLUTION_BOUNDARY_MODE || defaultMode || 'compat').trim().toLowerCase();
  if (raw === 'strict') {
    return 'strict';
  }
  return 'compat';
}

function isStrictBoundaryMode(defaultMode = 'compat') {
  return getBoundaryMode(defaultMode) === 'strict';
}

function resetCache() {
  cachedSpec = null;
}

module.exports = {
  loadResolutionSpec,
  getServiceSpec,
  getBoundaryMode,
  isStrictBoundaryMode,
  resetCache,
  specPath
};
