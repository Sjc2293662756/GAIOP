'use strict';

const { parseReferenceSelection } = require('./ReferenceSelectionParser');

const TURN_ADMISSION_ACTIONS = Object.freeze({
  ASK_CLARIFYING_QUESTION: 'ASK_CLARIFYING_QUESTION',
  EXECUTE_TOOL: 'EXECUTE_TOOL',
  MODEL_OWNED: 'MODEL_OWNED',
  REJECT: 'REJECT'
});

const TURN_ADMISSION_ROUTES = Object.freeze({
  NAPM_CANDIDATE: 'napm_candidate',
  EXPLICIT_OUT_OF_SCOPE: 'explicit_out_of_scope',
  MODEL_OWNED: 'model_owned'
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function freezeDecision(value = {}) {
  return Object.freeze({
    ...value,
    ...(value.selection ? { selection: Object.freeze({ ...value.selection }) } : {}),
    ...(value.selectedItem ? { selectedItem: Object.freeze({ ...value.selectedItem }) } : {})
  });
}

function normalizeIdentity(identity = {}) {
  return {
    conversationKey: normalizeText(identity?.conversationKey) || null,
    turnId: normalizeText(identity?.turnId) || null,
    runId: normalizeText(identity?.runId) || null,
    messageId: normalizeText(identity?.messageId) || null
  };
}

function normalizeBaseDecision(baseDecision = {}, identity = {}) {
  const route = Object.values(TURN_ADMISSION_ROUTES).includes(baseDecision?.route)
    ? baseDecision.route
    : TURN_ADMISSION_ROUTES.MODEL_OWNED;
  return freezeDecision({
    ...normalizeIdentity(identity),
    route,
    action: route === TURN_ADMISSION_ROUTES.EXPLICIT_OUT_OF_SCOPE
      ? TURN_ADMISSION_ACTIONS.REJECT
      : route === TURN_ADMISSION_ROUTES.NAPM_CANDIDATE
        ? TURN_ADMISSION_ACTIONS.EXECUTE_TOOL
        : TURN_ADMISSION_ACTIONS.MODEL_OWNED,
    expectedTool: normalizeText(baseDecision?.expectedTool) || null,
    intentType: normalizeText(baseDecision?.intentType) || null,
    handling: normalizeText(baseDecision?.handling) || null,
    classificationSchemaVersion: normalizeText(baseDecision?.classificationSchemaVersion) || null,
    classificationSource: normalizeText(baseDecision?.classificationSource) || null,
    workflow: normalizeText(baseDecision?.workflow) || null,
    reasonCode: normalizeText(baseDecision?.reasonCode) || 'BASE_TURN_POLICY',
    source: 'base_policy'
  });
}

function normalizeContextCandidate(candidate = {}) {
  const supportedActions = Array.isArray(candidate?.supportedActions)
    ? candidate.supportedActions.map(normalizeText).filter(Boolean)
    : [];
  const expectedTool = normalizeText(candidate?.expectedTool);
  const route = normalizeText(candidate?.route);
  const requiresClarification = candidate?.requiresClarification === true;
  if ((!expectedTool && !requiresClarification) || route !== TURN_ADMISSION_ROUTES.NAPM_CANDIDATE) {
    return null;
  }
  return {
    domain: normalizeText(candidate?.domain),
    artifactId: normalizeText(candidate?.artifactId),
    artifactType: normalizeText(candidate?.artifactType),
    objectType: normalizeText(candidate?.objectType),
    expectedTool,
    requiresClarification,
    clarification: normalizeText(candidate?.clarification),
    route,
    queryRoute: normalizeText(candidate?.queryRoute) || null,
    workflow: normalizeText(candidate?.workflow) || null,
    supportedActions,
    updatedAt: Number(candidate?.updatedAt) || 0,
    freshnessPriority: Number(candidate?.freshnessPriority) || 0,
    items: Array.isArray(candidate?.items)
      ? candidate.items
        .map((item, index) => ({
          ...(item && typeof item === 'object' ? item : {}),
          ordinal: Number(item?.ordinal) || index + 1
        }))
        .filter((item) => Number.isInteger(item.ordinal) && item.ordinal > 0)
      : []
  };
}

class TurnAdmissionCoordinator {
  decide({ prompt = '', baseDecision = {}, contextCandidates = [], identity = {} } = {}) {
    const normalizedBase = normalizeBaseDecision(baseDecision, identity);
    if (normalizedBase.route === TURN_ADMISSION_ROUTES.EXPLICIT_OUT_OF_SCOPE) {
      return normalizedBase;
    }

    const selection = parseReferenceSelection(prompt);
    if (!selection) return normalizedBase;

    const matches = contextCandidates
      .map(normalizeContextCandidate)
      .filter(Boolean)
      .filter((candidate) => candidate.supportedActions.includes(selection.action));
    if (matches.length === 0) {
      return freezeDecision({
        ...normalizeIdentity(identity),
        route: TURN_ADMISSION_ROUTES.MODEL_OWNED,
        action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
        expectedTool: null,
        workflow: 'context_reference_clarification',
        reasonCode: 'TURN_ADMISSION_CONTEXT_REQUIRED',
        source: 'reference_selection',
        finalContent: '当前会话没有可安全引用的排行结果。请先说明要查看哪一份结果，或重新执行对应排行。',
        selection
      });
    }
    const freshestUpdatedAt = matches.reduce(
      (latest, candidate) => Math.max(latest, candidate.updatedAt),
      0
    );
    let freshestMatches = freshestUpdatedAt > 0
      ? matches.filter((candidate) => candidate.updatedAt === freshestUpdatedAt)
      : matches;
    if (freshestMatches.length > 1) {
      const highestPriority = freshestMatches.reduce(
        (latest, candidate) => Math.max(latest, candidate.freshnessPriority),
        0
      );
      freshestMatches = freshestMatches.filter(
        (candidate) => candidate.freshnessPriority === highestPriority
      );
    }
    if (freshestMatches.length > 1) {
      return freezeDecision({
        ...normalizeIdentity(identity),
        route: TURN_ADMISSION_ROUTES.MODEL_OWNED,
        action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
        expectedTool: null,
        workflow: 'context_reference_clarification',
        reasonCode: 'TURN_ADMISSION_AMBIGUOUS',
        source: 'authoritative_context',
        finalContent: '当前会话有多份结果都可能是您说的对象。请明确要查看查询结果、告警结果还是数据包结果。',
        selection
      });
    }

    const candidate = freshestMatches[0];
    if (candidate.requiresClarification) {
      return freezeDecision({
        ...normalizeIdentity(identity),
        route: TURN_ADMISSION_ROUTES.MODEL_OWNED,
        action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
        expectedTool: null,
        workflow: candidate.workflow || 'context_reference_clarification',
        reasonCode: 'TURN_ADMISSION_CONTEXT_NOT_MIGRATED',
        source: 'authoritative_context',
        sourceDomain: candidate.domain || null,
        sourceArtifactId: candidate.artifactId || null,
        sourceArtifactType: candidate.artifactType || null,
        sourceObjectType: candidate.objectType || null,
        finalContent: candidate.clarification || '请明确您要查看的对象或重新执行对应查询。',
        selection
      });
    }
    const selectedItem = candidate.items.length > 0
      ? candidate.items.find((item) => item.ordinal === selection.ordinal) || null
      : null;
    if (candidate.items.length > 0 && !selectedItem) {
      return freezeDecision({
        ...normalizeIdentity(identity),
        route: TURN_ADMISSION_ROUTES.MODEL_OWNED,
        action: TURN_ADMISSION_ACTIONS.ASK_CLARIFYING_QUESTION,
        expectedTool: null,
        workflow: candidate.workflow || 'context_reference_clarification',
        reasonCode: 'RESULT_REFERENCE_ORDINAL_OUT_OF_RANGE',
        source: 'authoritative_context',
        sourceDomain: candidate.domain || null,
        sourceArtifactId: candidate.artifactId || null,
        sourceArtifactType: candidate.artifactType || null,
        sourceObjectType: candidate.objectType || null,
        finalContent: `上一份结果没有第 ${selection.ordinal} 条，请选择现有序号。`,
        selection
      });
    }
    return freezeDecision({
      ...normalizeIdentity(identity),
      route: candidate.route,
      queryRoute: candidate.queryRoute,
      action: TURN_ADMISSION_ACTIONS.EXECUTE_TOOL,
      expectedTool: candidate.expectedTool,
      workflow: candidate.workflow || 'context_followup',
      reasonCode: 'AUTHORITATIVE_RESULT_FOLLOWUP',
      source: 'authoritative_context',
      sourceDomain: candidate.domain || null,
      sourceArtifactId: candidate.artifactId || null,
      sourceArtifactType: candidate.artifactType || null,
      sourceObjectType: candidate.objectType || null,
      selection,
      ...(selectedItem ? { selectedItem } : {})
    });
  }
}

module.exports = {
  TURN_ADMISSION_ACTIONS,
  TURN_ADMISSION_ROUTES,
  TurnAdmissionCoordinator
};
