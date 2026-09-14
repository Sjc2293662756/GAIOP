'use strict';

const {
  OUTPUT_TURN_AUTHORITIES,
  OUTPUT_TURN_PROVENANCE,
  OUTPUT_TURN_RESOLUTION_STATUS,
  resolveOutputTurnContext
} = require('../plugin/OutputTurnContextResolver');

function turn(turnId, route = 'MODEL_OWNED') {
  return {
    scope: 'session:test',
    turnId,
    route,
    turn: {
      conversationKey: 'session:test',
      turnId,
      route: route === 'MODEL_OWNED' ? 'MODEL_OWNED' : 'NAPM_QUERY',
      phase: route === 'MODEL_OWNED' ? 'RECEIVED' : 'EXECUTING'
    },
    expectedTool: route === 'NAPM_QUERY' ? 'napm-skill-query' : null,
    eligible: true
  };
}

describe('OutputTurnContextResolver', () => {
  test('prefers an exact run-bound binding over scope candidates', () => {
    const result = resolveOutputTurnContext({
      scope: 'session:test',
      strongBinding: {
        scope: 'session:test',
        turnId: 'turn-strong',
        route: 'NAPM_QUERY',
        expectedTool: 'napm-skill-query',
        provenance: OUTPUT_TURN_PROVENANCE.RUN_BOUND,
        turn: turn('turn-strong', 'NAPM_QUERY').turn
      },
      candidates: [turn('turn-other', 'MODEL_OWNED')]
    });

    expect(result).toMatchObject({
      ok: true,
      status: OUTPUT_TURN_RESOLUTION_STATUS.RESOLVED,
      context: {
        turnId: 'turn-strong',
        route: 'NAPM_QUERY',
        provenance: OUTPUT_TURN_PROVENANCE.RUN_BOUND,
        authority: OUTPUT_TURN_AUTHORITIES.STRONG_TURN_BINDING
      }
    });
  });

  test('resolves one non-competing scope candidate without using latest semantics', () => {
    const result = resolveOutputTurnContext({
      scope: 'session:test',
      candidates: [turn('turn-model-owned')]
    });

    expect(result).toMatchObject({
      ok: true,
      status: OUTPUT_TURN_RESOLUTION_STATUS.RESOLVED,
      context: {
        turnId: 'turn-model-owned',
        route: 'MODEL_OWNED',
        provenance: OUTPUT_TURN_PROVENANCE.UNIQUE_SCOPE_RESOLUTION,
        authority: OUTPUT_TURN_AUTHORITIES.ROUTE_IDENTITY_ONLY
      }
    });
  });

  test('returns unresolved when no candidate exists', () => {
    expect(resolveOutputTurnContext({ scope: 'session:test', candidates: [] })).toEqual({
      ok: false,
      status: OUTPUT_TURN_RESOLUTION_STATUS.UNRESOLVED,
      code: 'OUTPUT_TURN_UNRESOLVED',
      details: { candidateCount: 0 }
    });
  });

  test('returns ambiguous when overlapping candidates compete', () => {
    const result = resolveOutputTurnContext({
      scope: 'session:test',
      candidates: [turn('turn-a'), turn('turn-b')]
    });

    expect(result).toMatchObject({
      ok: false,
      status: OUTPUT_TURN_RESOLUTION_STATUS.AMBIGUOUS,
      code: 'OUTPUT_TURN_AMBIGUOUS',
      details: { candidateCount: 2 }
    });
  });

  test('does not treat the latest candidate as a fallback', () => {
    const result = resolveOutputTurnContext({
      scope: 'session:test',
      candidates: [
        { ...turn('turn-old'), eligible: false },
        { ...turn('turn-new'), eligible: false }
      ]
    });

    expect(result.status).toBe(OUTPUT_TURN_RESOLUTION_STATUS.UNRESOLVED);
  });
});
