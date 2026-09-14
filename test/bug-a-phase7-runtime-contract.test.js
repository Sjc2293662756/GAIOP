'use strict';

const path = require('node:path');
const {
  inspectNapmPhase7SerializerContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

describe('BUG-A Phase 7 serializer runtime contract', () => {
  test('locks canonical serialization and Kernel boundary', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const results = inspectNapmPhase7SerializerContracts({
      workspaceRoot,
      skillsRoot: path.join(workspaceRoot, 'skills')
    });

    expect(results.map((item) => item.contract)).toEqual([
      'phase7_single_canonical_serializer',
      'phase7_serializer_explicit_allowlist_and_no_legacy_metric',
      'phase7_kernel_uses_serializer_without_business_fallback',
      'phase7_pageviews_keeps_independent_serializer_contract',
      'phase7_parser_does_not_encode_metric_transport',
      'phase7_napm_client_has_no_query_semantics',
      'phase7_golden_serializer_transport_shape'
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
  });
});
