'use strict';

const path = require('node:path');
const {
  inspectNapmPhase41VerificationContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 4.1 verification runtime contract', () => {
  test('locks proof identity, time order, validator purity, and child-query reachability', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase41VerificationContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase41_prepared_proof_identity_and_single_use',
      'phase41_plugin_time_materialization_before_execution_validation',
      'phase41_metric_existence_precedes_ownership',
      'phase41_validator_is_pure',
      'phase41_overview_child_queries_use_gateway_gate',
      'phase41_policy_does_not_reimplement_ownership'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
