'use strict';

const OUTPUT_TURN_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED',
  AMBIGUOUS: 'AMBIGUOUS'
});

const OUTPUT_TURN_PROVENANCE = Object.freeze({
  RUN_BOUND: 'RUN_BOUND',
  MESSAGE_BOUND: 'MESSAGE_BOUND',
  TURN_TOKEN: 'TURN_TOKEN',
  UNIQUE_SCOPE_RESOLUTION: 'UNIQUE_SCOPE_RESOLUTION'
});

const OUTPUT_TURN_AUTHORITIES = Object.freeze({
  STRONG_TURN_BINDING: 'STRONG_TURN_BINDING',
  ROUTE_IDENTITY_ONLY: 'ROUTE_IDENTITY_ONLY'
});

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function unresolved(code = 'OUTPUT_TURN_UNRESOLVED', details = {}) {
  return {
    ok: false,
    status: OUTPUT_TURN_RESOLUTION_STATUS.UNRESOLVED,
    code,
    details: clone(details) || {}
  };
}

function resolveOutputTurnContext({
  scope = '',
  strongBinding = null,
  candidates = []
} = {}) {
  const normalizedScope = normalize(scope);
  if (!normalizedScope) {
    return unresolved('OUTPUT_TURN_SCOPE_REQUIRED');
  }

  const strong = strongBinding && typeof strongBinding === 'object'
    ? strongBinding
    : null;
  if (
    normalize(strong?.scope) === normalizedScope
    && normalize(strong?.turnId)
    && strong?.turn
    && normalize(strong?.route)
  ) {
    return {
      ok: true,
      status: OUTPUT_TURN_RESOLUTION_STATUS.RESOLVED,
      context: {
        scope: normalizedScope,
        turnId: normalize(strong.turnId),
        turn: clone(strong.turn),
        route: normalize(strong.route),
        expectedTool: normalize(strong.expectedTool) || null,
        sourceRunId: normalize(strong.sourceRunId) || null,
        sourceMessageId: normalize(strong.sourceMessageId) || null,
        provenance: normalize(strong.provenance) || OUTPUT_TURN_PROVENANCE.TURN_TOKEN,
        authority: OUTPUT_TURN_AUTHORITIES.STRONG_TURN_BINDING
      }
    };
  }

  const uniqueCandidates = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || candidate.eligible === false) continue;
    const candidateScope = normalize(candidate.scope || normalizedScope);
    const turnId = normalize(candidate.turnId);
    const route = normalize(candidate.route);
    if (candidateScope !== normalizedScope || !turnId || !route) continue;
    const key = `${candidateScope}::${turnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(candidate);
  }

  if (uniqueCandidates.length === 0) {
    return unresolved('OUTPUT_TURN_UNRESOLVED', { candidateCount: 0 });
  }
  if (uniqueCandidates.length > 1) {
    return {
      ok: false,
      status: OUTPUT_TURN_RESOLUTION_STATUS.AMBIGUOUS,
      code: 'OUTPUT_TURN_AMBIGUOUS',
      details: {
        candidateCount: uniqueCandidates.length,
        turnIds: uniqueCandidates.map((candidate) => normalize(candidate.turnId))
      }
    };
  }

  const candidate = uniqueCandidates[0];
  return {
    ok: true,
    status: OUTPUT_TURN_RESOLUTION_STATUS.RESOLVED,
    context: {
      scope: normalizedScope,
      turnId: normalize(candidate.turnId),
      turn: clone(candidate.turn),
      route: normalize(candidate.route),
      expectedTool: normalize(candidate.expectedTool) || null,
      sourceRunId: normalize(candidate.sourceRunId) || null,
      sourceMessageId: normalize(candidate.sourceMessageId) || null,
      provenance: OUTPUT_TURN_PROVENANCE.UNIQUE_SCOPE_RESOLUTION,
      authority: OUTPUT_TURN_AUTHORITIES.ROUTE_IDENTITY_ONLY
    }
  };
}

module.exports = {
  OUTPUT_TURN_AUTHORITIES,
  OUTPUT_TURN_PROVENANCE,
  OUTPUT_TURN_RESOLUTION_STATUS,
  resolveOutputTurnContext
};
