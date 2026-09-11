'use strict';

const path = require('node:path');
const {
  inspectNapmPhase6AtomicRepairContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 6 atomic repair runtime contract', () => {
  test('locks the single repair source and post-repair revalidation order', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase6AtomicRepairContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase6_atomic_repair_single_source',
      'phase6_repair_allowlist_and_semantic_guard',
      'phase6_repair_clone_and_audit_fingerprint',
      'phase6_post_repair_contract_before_static_gate',
      'phase6_post_repair_runtime_uses_candidate',
      'phase6_prepared_proof_fingerprint_invalidation',
      'phase6_metadata_mutation_is_revalidated'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
