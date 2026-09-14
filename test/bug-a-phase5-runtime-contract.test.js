'use strict';

const path = require('node:path');
const {
  inspectNapmPhase5RuntimeCapabilityContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 5 runtime capability contract', () => {
  test('locks one provider, one admission gate, and static precedence', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase5RuntimeCapabilityContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase5_runtime_service_single_entry',
      'phase5_runtime_status_and_provider_guard',
      'phase5_shared_execution_admission',
      'phase5_gateway_and_direct_runtime_gate',
      'phase5_canonical_metrics_for_group_provider',
      'phase5_plugin_skill_only_runtime_confirmation',
      'phase5_static_gate_precedence_preserved'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
