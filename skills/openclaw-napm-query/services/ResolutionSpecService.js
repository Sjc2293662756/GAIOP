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

function getQueryContract() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.queryContract || null);
}

function getObjectAliases() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.objects?.aliases || {});
}

function getRoutingRules() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.routingRules || {});
}

function getMetadataRules() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.metadataRules || {});
}

function getServiceProfiles() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.serviceProfiles || {});
}

function getObjectCatalog() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.objects?.catalog || {});
}

function getObjectNormalizationRules() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.objects?.normalizationRules || {});
}

function getGroupSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.groups || {});
}

function getMetricSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.metrics || {});
}

function getClarificationSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.clarification || {});
}

function getTimeSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.time || {});
}

function getTemplateSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.templates || {});
}

function getRuntimeMetadataContracts() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.runtimeMetadataContracts || {});
}

function getQueryConstructionPolicy() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.queryConstructionPolicy || {});
}

function getBoundaryMode(defaultMode = 'strict') {
  const raw = String(process.env.NAPM_RESOLUTION_BOUNDARY_MODE || defaultMode || 'strict').trim().toLowerCase();
  if (raw === 'strict') {
    return 'strict';
  }
  return 'compat';
}

function isStrictBoundaryMode(defaultMode = 'strict') {
  return getBoundaryMode(defaultMode) === 'strict';
}

function resetCache() {
  cachedSpec = null;
}

module.exports = {
  loadResolutionSpec,
  getServiceSpec,
  getQueryContract,
  getObjectAliases,
  getRoutingRules,
  getMetadataRules,
  getServiceProfiles,
  getObjectCatalog,
  getObjectNormalizationRules,
  getGroupSpec,
  getMetricSpec,
  getClarificationSpec,
  getTimeSpec,
  getTemplateSpec,
  getRuntimeMetadataContracts,
  getQueryConstructionPolicy,
  getBoundaryMode,
  isStrictBoundaryMode,
  resetCache,
  specPath
};
