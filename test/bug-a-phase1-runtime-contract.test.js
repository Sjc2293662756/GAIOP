'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectNapmTruthSourceContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

const temporaryRoots = [];

function writeFixtureFile(root, relativePath, contents) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function createTruthSourceFixture() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-phase1-contract-'));
  temporaryRoots.push(workspaceRoot);
  const skillsRoot = path.join(workspaceRoot, 'skills');
  const skillPrefix = 'skills/openclaw-napm-query';
  const deprecation = {
    status: 'deprecated',
    canonicalRuntimeSource: 'src/constants/objectMetricOwnership.js',
    forbiddenForNewExecutionAdmission: true,
    legacyFields: [
      'ownershipRules',
      'ownershipMatrix',
      'catalog.*.compatibleObjectTypes',
      'catalog.*.preferredObjectTypes',
      'catalog.*.ownershipClass'
    ]
  };

  writeFixtureFile(workspaceRoot, `${skillPrefix}/config/napm-resolution-spec.v1.json`, JSON.stringify({
    metrics: { executionOwnershipDeprecation: deprecation }
  }));
  writeFixtureFile(workspaceRoot, `${skillPrefix}/config/object-ontology.v1.json`, '{"objects":[]}');
  writeFixtureFile(workspaceRoot, `${skillPrefix}/config/metrics-config.yml`, 'metrics: []');
  writeFixtureFile(workspaceRoot, `${skillPrefix}/src/constants/objectMetricOwnership.js`, 'module.exports = {};');
  writeFixtureFile(
    workspaceRoot,
    'src/constants/objectMetricOwnership.js',
    "module.exports = require('../../skills/openclaw-napm-query/src/constants/objectMetricOwnership');"
  );
  writeFixtureFile(
    workspaceRoot,
    `${skillPrefix}/services/MetricMappingService.js`,
    "const catalogPath = '../config/metrics-config.yml'; module.exports = { catalogPath };"
  );

  return { workspaceRoot, skillsRoot };
}

describe('BUG-A Phase 1 runtime truth-source contract', () => {
  afterEach(() => {
    temporaryRoots.splice(0).forEach((root) => {
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  test('enforces all six truth-source protections in the current workspace', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmTruthSourceContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'resolution_spec_uniqueness',
      'object_ontology_uniqueness',
      'ownership_uniqueness',
      'metric_catalog_uniqueness',
      'no_runtime_metric_fallback',
      'resolution_spec_execution_ownership_deprecated'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });

  test.each([
    ['resolution_spec_uniqueness', 'config/napm-resolution-spec.v1.json', '{}'],
    ['object_ontology_uniqueness', 'config/object-ontology.v1.json', '{}'],
    ['metric_catalog_uniqueness', 'config/metrics-config.yml', 'metrics: []']
  ])('%s fails when a root duplicate reappears', (contract, relativePath, contents) => {
    const roots = createTruthSourceFixture();
    writeFixtureFile(roots.workspaceRoot, relativePath, contents);

    const result = inspectNapmTruthSourceContracts(roots)
      .find((item) => item.contract === contract);

    expect(result).toMatchObject({
      ok: false,
      reason: 'DUPLICATE_SOURCE_FOUND'
    });
  });

  test('ownership uniqueness fails when the root entry becomes an independent rule table', () => {
    const roots = createTruthSourceFixture();
    writeFixtureFile(
      roots.workspaceRoot,
      'src/constants/objectMetricOwnership.js',
      "const BUSINESS_OBJECT_TYPES = ['WebApplication']; module.exports = { BUSINESS_OBJECT_TYPES };"
    );

    const result = inspectNapmTruthSourceContracts(roots)
      .find((item) => item.contract === 'ownership_uniqueness');

    expect(result).toMatchObject({
      ok: false,
      reason: 'ROOT_OWNERSHIP_IS_INDEPENDENT_SOURCE'
    });
  });

  test('runtime fallback contract fails when a built-in default loader reappears', () => {
    const roots = createTruthSourceFixture();
    writeFixtureFile(
      roots.workspaceRoot,
      'skills/openclaw-napm-query/services/MetricMappingService.js',
      'module.exports = { loadDefaultMetrics() {} };'
    );

    const result = inspectNapmTruthSourceContracts(roots)
      .find((item) => item.contract === 'no_runtime_metric_fallback');

    expect(result).toMatchObject({
      ok: false,
      reason: 'RUNTIME_METRIC_FALLBACK_FOUND'
    });
  });

  test('deprecated ownership contract fails when a new execution consumer reads legacy fields', () => {
    const roots = createTruthSourceFixture();
    writeFixtureFile(
      roots.workspaceRoot,
      'skills/openclaw-napm-query/services/FutureQueryValidator.js',
      'module.exports = (metricSpec) => metricSpec.ownershipMatrix;'
    );

    const result = inspectNapmTruthSourceContracts(roots)
      .find((item) => item.contract === 'resolution_spec_execution_ownership_deprecated');

    expect(result).toMatchObject({
      ok: false,
      reason: 'NEW_EXECUTION_OWNERSHIP_CONSUMER_FOUND'
    });
    expect(result.forbiddenConsumers).toEqual([
      expect.objectContaining({ fields: ['ownershipMatrix'] })
    ]);
  });

  test('deprecated ownership contract also covers plugin-side execution components', () => {
    const roots = createTruthSourceFixture();
    writeFixtureFile(
      roots.workspaceRoot,
      'plugin/FutureAdmissionPolicy.js',
      'module.exports = (metric) => metric.compatibleObjectTypes;'
    );

    const result = inspectNapmTruthSourceContracts(roots)
      .find((item) => item.contract === 'resolution_spec_execution_ownership_deprecated');

    expect(result).toMatchObject({
      ok: false,
      reason: 'NEW_EXECUTION_OWNERSHIP_CONSUMER_FOUND'
    });
    expect(result.forbiddenConsumers).toEqual([
      expect.objectContaining({ fields: ['compatibleObjectTypes'] })
    ]);
  });
});
