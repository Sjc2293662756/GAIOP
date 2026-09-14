'use strict';

const path = require('node:path');
const {
  inspectNapmPhase8OutcomeContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 8 outcome runtime contract', () => {
  test('locks unified execution outcomes and no-data proof', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase8OutcomeContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase8_single_execution_outcome_contract',
      'phase8_mapper_is_single_cross_layer_boundary',
      'phase8_no_data_requires_successful_data_execution',
      'phase8_failure_outcomes_are_not_no_data',
      'phase8_plugin_preserves_structured_outcome'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
