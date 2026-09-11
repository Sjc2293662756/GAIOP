'use strict';

const ContextBoundaryResolver = require('../plugin/context-resolvers/ContextBoundaryResolver');

describe('ContextBoundaryResolver', () => {
  const resolver = new ContextBoundaryResolver();

  test('exposes a clarification boundary for the latest not-yet-migrated skill result', () => {
    expect(resolver.getAdmissionCandidates({
      record: {
        sourceTool: 'napm-packet-analysis',
        turnId: 'turn-packet',
        updatedAt: 200,
        result: { ok: true }
      },
      handled: false
    })).toEqual([expect.objectContaining({
      domain: 'PACKET',
      artifactId: 'skill-result:turn-packet',
      requiresClarification: true,
      supportedActions: ['DETAIL'],
      updatedAt: 200
    })]);
  });

  test('does not shadow a result already handled by a domain resolver', () => {
    expect(resolver.getAdmissionCandidates({
      record: {
        sourceTool: 'napm-alert-query',
        updatedAt: 200,
        result: { ok: true }
      },
      handled: true
    })).toEqual([]);
  });
});
