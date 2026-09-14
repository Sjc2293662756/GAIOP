'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function absolute(relativePath) {
  return path.join(REPO_ROOT, ...relativePath.split('/'));
}

function loadMetricMappingWithFsOverride({ exists = true, read }) {
  const actualFs = jest.requireActual('fs');
  const configSuffix = path.join(
    'skills',
    'openclaw-napm-query',
    'config',
    'metrics-config.yml'
  );

  jest.resetModules();
  jest.doMock('fs', () => ({
    ...actualFs,
    existsSync(filePath) {
      if (String(filePath).endsWith(configSuffix)) {
        return exists;
      }
      return actualFs.existsSync(filePath);
    },
    readFileSync(filePath, encoding) {
      if (String(filePath).endsWith(configSuffix)) {
        if (read instanceof Error) {
          throw read;
        }
        return read;
      }
      return actualFs.readFileSync(filePath, encoding);
    }
  }));

  try {
    return require('../skills/openclaw-napm-query/services/MetricMappingService');
  } finally {
    jest.dontMock('fs');
  }
}

function captureMetricCatalogFailure(fsBehavior) {
  try {
    loadMetricMappingWithFsOverride(fsBehavior);
    return null;
  } catch (error) {
    return error;
  }
}

describe('BUG-A Phase 1 truth-source contract migrated from Phase 0 characterization', () => {
  afterEach(() => {
    jest.dontMock('fs');
    jest.resetModules();
  });

  test.each([
    [
      'Resolution Spec',
      'config/napm-resolution-spec.v1.json',
      'skills/openclaw-napm-query/config/napm-resolution-spec.v1.json'
    ],
    [
      'Object Ontology',
      'config/object-ontology.v1.json',
      'skills/openclaw-napm-query/config/object-ontology.v1.json'
    ],
    [
      'Metric Catalog',
      'config/metrics-config.yml',
      'skills/openclaw-napm-query/config/metrics-config.yml'
    ]
  ])('%s has one Skill-local canonical file and no root duplicate', (_label, root, canonical) => {
    expect(fs.existsSync(absolute(canonical))).toBe(true);
    expect(fs.existsSync(absolute(root))).toBe(false);
  });

  test('runtime reads the Skill-local Resolution Spec canonical source', () => {
    const ResolutionSpecService = require('../skills/openclaw-napm-query/services/ResolutionSpecService');
    const expectedPath = absolute(
      'skills/openclaw-napm-query/config/napm-resolution-spec.v1.json'
    );

    expect(path.normalize(ResolutionSpecService.specPath)).toBe(path.normalize(expectedPath));
    expect(ResolutionSpecService.getServiceNames()).toContain('pageViews');
  });

  test('runtime reads the Skill-local Object Ontology canonical source', () => {
    const ObjectOntologyService = require('../skills/openclaw-napm-query/services/ObjectOntologyService');
    const expectedPath = absolute(
      'skills/openclaw-napm-query/config/object-ontology.v1.json'
    );

    expect(path.normalize(ObjectOntologyService.ONTOLOGY_PATH)).toBe(path.normalize(expectedPath));
    expect(ObjectOntologyService.listObjectDefinitions()).toHaveLength(11);
  });

  test('root ownership compatibility entry is a thin re-export of the canonical module', () => {
    const rootOwnership = require('../src/constants/objectMetricOwnership');
    const canonicalOwnership = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');

    expect(rootOwnership).toBe(canonicalOwnership);
  });

  test('valid Metric Catalog loads only IDs declared by the supplied config', () => {
    const service = loadMetricMappingWithFsOverride({
      read: [
        'metrics:',
        '  - code: TPIO',
        '    description: 吞吐量（总）',
        "    unit: 'kb/sec'"
      ].join('\n')
    });

    expect(service.getAllMetricCodes()).toEqual(['TPIO']);
    expect(service.getMetricCode('吞吐量（总）')).toBe('TPIO');
    expect(service.isValidMetricCode('PKIO')).toBe(false);
  });

  test.each([
    [
      'missing file',
      { exists: false, read: undefined },
      'METRIC_CATALOG_NOT_FOUND'
    ],
    [
      'invalid YAML',
      { read: 'metrics: [unterminated' },
      'METRIC_CATALOG_PARSE_FAILED'
    ],
    [
      'read failure',
      { read: new Error('phase1 simulated read failure') },
      'METRIC_CATALOG_READ_FAILED'
    ],
    [
      'invalid structure',
      { read: 'metrics:\n  TPIO: 吞吐量' },
      'METRIC_CATALOG_INVALID'
    ]
  ])('Metric Catalog fails closed for %s', (_label, fsBehavior, expectedCode) => {
    const error = captureMetricCatalogFailure(fsBehavior);

    expect(error).toMatchObject({ code: expectedCode });
    expect(error?.message).not.toMatch(/default metrics|默认指标/i);
  });

  test('unknown metric is not created by a runtime fallback', () => {
    const service = loadMetricMappingWithFsOverride({
      read: 'metrics:\n  - code: PGTME\n    description: 页面响应时间\n    unit: t'
    });

    expect(service.isValidMetricCode('PGTME')).toBe(true);
    expect(service.isValidMetricCode('PGSUPERFAST')).toBe(false);
  });

  test('alert metric labels read the same Skill-local canonical Metric Catalog', () => {
    const AlertIndirectPacketDiscoveryService = require(
      '../skills/openclaw-napm-alert-query/services/AlertIndirectPacketDiscoveryService'
    );

    const result = AlertIndirectPacketDiscoveryService.buildFocusAnalysis({
      metrics: ['PGTME'],
      value: [120],
      unit: ['ms']
    });

    expect(result.metricLabels).toEqual(['页面延时']);
  });

  test('Phase 3 adds the dedicated legacy metric adapter without changing Phase 1 truth sources', () => {
    expect(fs.existsSync(absolute(
      'skills/openclaw-napm-query/services/LegacyMetricInputAdapter.js'
    ))).toBe(true);
    expect(require('../skills/openclaw-napm-query/services/LegacyMetricInputAdapter')).toEqual(
      expect.objectContaining({ adapt: expect.any(Function) })
    );
  });
});
