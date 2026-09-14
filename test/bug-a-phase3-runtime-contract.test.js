'use strict';

const path = require('node:path');
const {
  inspectNapmResolvedQueryContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 3 ResolvedQuery runtime contract', () => {
  test('enforces one canonical Query Contract and one legacy metric boundary', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmResolvedQueryContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'single_resolved_query_contract_source',
      'canonical_query_forbids_metric',
      'top_metric_independent_from_metrics',
      'query_validator_uses_shared_contract',
      'plugin_uses_shared_contract',
      'resolver_emits_canonical_query',
      'semantic_path_skips_legacy_adapter',
      'legacy_adapter_canonical_output',
      'metadata_constraint_no_metric_derivation'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
