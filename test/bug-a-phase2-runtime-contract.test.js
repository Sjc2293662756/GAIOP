'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectNapmSemanticContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 2 semantic runtime contract', () => {
  test('enforces the unified metric and ranking semantic sources', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmSemanticContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'single_metric_semantic_source',
      'semantic_rule_metric_ids_valid',
      'single_ranking_grammar_source',
      'resolver_no_private_semantic_inference',
      'workflow_classifier_no_private_ranking_parser',
      'tag_normalizer_no_query_construction',
      'semantic_lifecycle_enum',
      'semantic_contract_lifecycle_fields',
      'resolver_semantic_status_guard',
      'non_resolved_semantic_no_query_draft'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });

  test('fails when a semantic rule references a metric outside the canonical catalog', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-phase2-contract-'));
    const skillsRoot = path.join(workspaceRoot, 'skills');
    const queryRoot = path.join(skillsRoot, 'openclaw-napm-query');
    const configRoot = path.join(queryRoot, 'config');
    const servicesRoot = path.join(queryRoot, 'services');

    try {
      fs.mkdirSync(configRoot, { recursive: true });
      fs.mkdirSync(servicesRoot, { recursive: true });
      fs.writeFileSync(path.join(configRoot, 'napm-resolution-spec.v1.json'), JSON.stringify({
        metrics: {
          semanticAliasesDeprecation: {
            status: 'deprecated',
            canonicalMachineSource: 'metricSemanticRules',
            forbiddenForProductionMatching: true
          }
        },
        metricSemanticRules: {
          rules: [{ id: 'invalid-rule', metricId: 'NOT_IN_CATALOG', phrases: ['invalid'] }]
        },
        rankingGrammar: { defaults: { topCount: 10 } }
      }));
      fs.writeFileSync(path.join(configRoot, 'metrics-config.yml'), 'metrics:\n  - code: PLI\n');
      fs.writeFileSync(
        path.join(servicesRoot, 'MetricSemanticNormalizerService.js'),
        'getMetricSemanticRules();\n'
      );
      fs.writeFileSync(
        path.join(servicesRoot, 'RankingIntentParserService.js'),
        'getRankingGrammar();\n'
      );
      fs.writeFileSync(path.join(servicesRoot, 'NapmResolvedQueryResolverService.js'), 'module.exports = {};\n');
      fs.writeFileSync(
        path.join(servicesRoot, 'WorkflowClassifierService.js'),
        "require('./RankingIntentParserService');\n"
      );
      fs.writeFileSync(path.join(servicesRoot, 'TagNormalizer.js'), 'module.exports = {};\n');

      const result = inspectNapmSemanticContracts({ workspaceRoot, skillsRoot })
        .find((item) => item.contract === 'semantic_rule_metric_ids_valid');

      expect(result).toMatchObject({
        ok: false,
        invalidRuleMetricIds: ['NOT_IN_CATALOG'],
        reason: 'SEMANTIC_RULE_METRIC_NOT_IN_CATALOG'
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
