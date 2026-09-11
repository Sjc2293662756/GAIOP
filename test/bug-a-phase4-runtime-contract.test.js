'use strict';

const path = require('node:path');
const {
  inspectNapmPhase4ExecutableContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 4 executable runtime contract', () => {
  test('keeps the shared validator, ownership coverage, and static execution gates reachable', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase4ExecutableContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase4_validator_single_entry',
      'phase4_ownership_coverage_complete',
      'phase4_gateway_and_direct_static_gate',
      'phase4_unknown_capability_fails_closed_before_execution',
      'phase4_plugin_gate_precedes_skill_execution'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
