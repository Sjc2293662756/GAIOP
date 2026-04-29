const { getReferenceSignals, buildExecutionHints } = require('./reference-runtime');

const DECISION_POLICY = {
  allowedNextActions: new Set([
    'ANSWER_CONCEPTUALLY',
    'GO_DIRECT_QUERY',
    'GO_OVERVIEW_QUERY',
    'ASK_CLARIFYING_QUESTION',
    'INTERPRET_RESULT',
    'REJECT_AND_REDIRECT'
  ]),
  allowedTaskTypes: new Set([
    'term_explain',
    'direct_query',
    'performance_triage',
    'result_interpret'
  ]),
  allowedContinuationTypes: new Set([
    'subject_switch',
    'time_switch',
    'metric_switch',
    'view_switch',
    'result_follow_up',
    'query_refinement',
    'step_forward'
  ]),
  allowedInformationSufficiency: new Set([
    'DIRECT_QUERY_READY',
    'OVERVIEW_READY',
    'NEED_CLARIFICATION',
    'UNMAPPABLE',
    'not_applicable'
  ]),
  unsupportedActionFamilies: new Set([
    'restart_service',
    'deploy_service',
    'modify_config',
    'code_debug',
    'db_internal_analysis',
    'generic_ops_action',
    'non_napm_chat'
  ])
};

const TASK_TYPE_ALIASES = {
  explanation: 'term_explain',
  query: 'direct_query',
  analysis_entry: 'performance_triage',
  result_interpretation: 'result_interpret'
};

const INFORMATION_SUFFICIENCY_ALIASES = {
  S1_DIRECT_QUERY: 'DIRECT_QUERY_READY',
  S2_OVERVIEW_FIRST: 'OVERVIEW_READY',
  S3_NEED_CLARIFICATION: 'NEED_CLARIFICATION',
  S4_UNMAPPABLE: 'UNMAPPABLE'
};

const DEFAULT_CLARIFYING_QUESTION = '\u8bf7\u8865\u5145\u4f60\u60f3\u770b\u7684\u5bf9\u8c61\u8303\u56f4\uff08\u4e1a\u52a1\u7cfb\u7edf\u3001\u7f51\u7ad9\u3001\u5e94\u7528\u3001\u670d\u52a1\u7b49\uff09\u3002';

function createDefaultSessionState() {
  return {
    active_domain: 'NAPM',
    active_task_type: null,
    active_intent_type: null,
    last_subject: {
      text: null,
      kind: null
    },
    last_time_range: null,
    last_metric: null,
    last_groups: [],
    last_result_available: false,
    last_action: null,
    dialog_stage: null,
    turn_expiry: 3
  };
}

function sanitizePrompt(prompt) {
  const raw = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }

  let normalized = raw
    .replace(/^@\S+\s*/u, '')
    .replace(/^@\S+\s*/u, '')
    .trim();

  if (!/^\d{1,3}(?:\.\d{1,3}){3}(?:\b|$)/.test(normalized)) {
    normalized = normalized.replace(/^(?:v(?:ersion)?\s*)?\d{1,2}(?:\.\d{1,2}){1,2}\s+/i, '').trim();
  }

  return normalized;
}

function normalizeOptionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return fallback;
}

function normalizeTaskType(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  const mapped = TASK_TYPE_ALIASES[normalized] || normalized;
  return DECISION_POLICY.allowedTaskTypes.has(mapped) ? mapped : null;
}

function normalizeInformationSufficiency(value, fallback = 'not_applicable') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return fallback;
  }
  const mapped = INFORMATION_SUFFICIENCY_ALIASES[normalized] || normalized;
  return DECISION_POLICY.allowedInformationSufficiency.has(mapped) ? mapped : fallback;
}

function normalizeEnum(value, allowedValues, fallback = null) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return fallback;
  }
  return allowedValues.has(normalized) ? normalized : fallback;
}

function buildContinuationFlags(isContinuation, continuationType) {
  const normalizedType = isContinuation ? continuationType : null;
  return {
    inherit_subject: Boolean(isContinuation && normalizedType !== null),
    inherit_time_range: Boolean(isContinuation && normalizedType !== 'time_switch'),
    inherit_metric: Boolean(isContinuation && normalizedType !== 'metric_switch')
  };
}

function inferActionFamily(taskType, nextAction, continuationType) {
  if (nextAction === 'REJECT_AND_REDIRECT') {
    return 'generic_ops_action';
  }
  if (continuationType && continuationType !== 'result_follow_up') {
    return 'followup_refine';
  }
  return taskType || 'generic_ops_action';
}

function validateDecisionContract(decision, sessionState = createDefaultSessionState()) {
  if (!decision || typeof decision !== 'object') {
    return null;
  }

  const isContinuation = normalizeBoolean(decision.is_continuation, false);
  const continuationType = normalizeEnum(
    decision.continuation_type,
    DECISION_POLICY.allowedContinuationTypes,
    null
  );
  const flags = buildContinuationFlags(isContinuation, continuationType);

  let nextAction = normalizeEnum(decision.next_action, DECISION_POLICY.allowedNextActions, null);
  let taskType = normalizeTaskType(decision.task_type);
  let informationSufficiency = normalizeInformationSufficiency(decision.information_sufficiency);
  let actionFamily = normalizeOptionalText(decision.action_family);
  const inScope = normalizeBoolean(decision.in_scope, nextAction !== 'REJECT_AND_REDIRECT');
  const requiresWriteAction = normalizeBoolean(decision.requires_write_action, false);
  const requiresSystemControl = normalizeBoolean(decision.requires_system_control, false);
  const requiresCodeOrDbInternalAccess = normalizeBoolean(decision.requires_code_or_db_internal_access, false);

  if (!nextAction) {
    return null;
  }

  if (DECISION_POLICY.unsupportedActionFamilies.has(actionFamily)) {
    nextAction = 'REJECT_AND_REDIRECT';
    taskType = null;
    informationSufficiency = 'UNMAPPABLE';
  }

  if (requiresWriteAction || requiresSystemControl || requiresCodeOrDbInternalAccess || !inScope) {
    nextAction = 'REJECT_AND_REDIRECT';
    taskType = null;
    informationSufficiency = 'UNMAPPABLE';
  }

  if (!actionFamily) {
    actionFamily = inferActionFamily(taskType, nextAction, continuationType);
  }

  const needsClarification = normalizeBoolean(
    decision.need_clarification,
    nextAction === 'ASK_CLARIFYING_QUESTION'
  );
  const clarifyingQuestion = normalizeOptionalText(decision.clarifying_question)
    || (nextAction === 'ASK_CLARIFYING_QUESTION' ? DEFAULT_CLARIFYING_QUESTION : null);

  if (nextAction === 'ASK_CLARIFYING_QUESTION' && !clarifyingQuestion) {
    return null;
  }

  if (nextAction === 'GO_DIRECT_QUERY' && informationSufficiency === 'NEED_CLARIFICATION') {
    nextAction = 'ASK_CLARIFYING_QUESTION';
  }

  if ((nextAction === 'GO_DIRECT_QUERY' || nextAction === 'GO_OVERVIEW_QUERY') && informationSufficiency === 'UNMAPPABLE') {
    nextAction = 'REJECT_AND_REDIRECT';
    taskType = null;
  }

  return {
    is_continuation: isContinuation,
    continuation_type: continuationType,
    in_scope: nextAction !== 'REJECT_AND_REDIRECT',
    scope_reason: normalizeOptionalText(decision.scope_reason)
      || (nextAction === 'REJECT_AND_REDIRECT'
        ? 'Rejected by skill decision boundary contract'
        : 'Accepted by OpenClaw skill decision contract'),
    task_type: nextAction === 'REJECT_AND_REDIRECT' ? null : taskType,
    task_reason: normalizeOptionalText(decision.task_reason)
      || 'Validated from OpenClaw skill decision payload',
    information_sufficiency: nextAction === 'REJECT_AND_REDIRECT' ? 'UNMAPPABLE' : informationSufficiency,
    sufficiency_reason: normalizeOptionalText(decision.sufficiency_reason),
    recognized_subject_hint: normalizeOptionalText(decision.recognized_subject_hint),
    recognized_time_hint: normalizeOptionalText(decision.recognized_time_hint),
    recognized_goal_hint: normalizeOptionalText(decision.recognized_goal_hint),
    inherit_subject: normalizeBoolean(decision.inherit_subject, flags.inherit_subject),
    inherit_time_range: normalizeBoolean(decision.inherit_time_range, flags.inherit_time_range),
    inherit_metric: normalizeBoolean(decision.inherit_metric, flags.inherit_metric),
    next_action: nextAction,
    need_clarification: nextAction === 'ASK_CLARIFYING_QUESTION' ? true : needsClarification,
    clarifying_question: clarifyingQuestion,
    action_family: actionFamily,
    response_text: normalizeOptionalText(decision.response_text),
    decision_source: 'openclaw_model'
  };
}

function inferMetricDirection(referenceSignals) {
  return normalizeOptionalText(referenceSignals?.strongestMetricHint);
}

function inferGoalHint(executionHints, referenceSignals, sessionState = createDefaultSessionState()) {
  const queryShape = normalizeOptionalText(executionHints?.queryShape);
  if (queryShape === 'inventory') return 'inventory';
  if (queryShape === 'trend') return 'trend';
  if (queryShape === 'ranking') return 'ranking';
  if (queryShape === 'overview') return 'overview';

  if (normalizeOptionalText(referenceSignals?.strongestMetricHint)) {
    return 'query';
  }
  if (referenceSignals?.hasReferenceObjectSignal || referenceSignals?.hasReferenceCapabilitySignal) {
    return 'query';
  }
  if (normalizeOptionalText(sessionState?.last_action) === 'GO_OVERVIEW_QUERY') {
    return 'overview';
  }
  return null;
}

function detectHints(prompt, sessionState = createDefaultSessionState()) {
  const text = sanitizePrompt(prompt);
  const referenceSignals = getReferenceSignals(text);
  const executionHints = buildExecutionHints(text, null);

  const explicitSubject = null;
  const broadObjectType = normalizeOptionalText(referenceSignals?.strongestObjectHint)
    || normalizeOptionalText(sessionState?.last_subject?.kind)
    || null;
  const inheritedSubject = normalizeOptionalText(sessionState?.last_subject?.text);
  const referenceObjectHint = normalizeOptionalText(referenceSignals?.strongestObjectHint);
  const referenceMetricHint = normalizeOptionalText(referenceSignals?.strongestMetricHint);
  const recognizedSubject = explicitSubject || broadObjectType || referenceObjectHint || inheritedSubject || null;
  const metricDirection = inferMetricDirection(referenceSignals)
    || referenceMetricHint
    || normalizeOptionalText(sessionState?.last_metric);
  const goalHint = inferGoalHint(executionHints, referenceSignals, sessionState);

  return {
    explicitSubject,
    broadObjectType,
    metricDirection,
    goalHint,
    executionHints,
    referenceSignals,
    recognized_subject_hint: recognizedSubject,
    recognized_time_hint: normalizeOptionalText(sessionState?.last_time_range),
    recognized_goal_hint: goalHint
      || metricDirection
      || referenceMetricHint
      || referenceObjectHint
      || normalizeOptionalText(executionHints?.queryShape)
      || null
  };
}

function buildIntent(prompt, decision, sessionState, overrideIntent) {
  if (overrideIntent && typeof overrideIntent === 'object') {
    return overrideIntent;
  }

  const safeSessionState = sessionState && typeof sessionState === 'object'
    ? sessionState
    : createDefaultSessionState();
  const hints = detectHints(prompt, safeSessionState);
  const subjectFromState = normalizeOptionalText(safeSessionState?.last_subject?.text);
  const executionHints = buildExecutionHints(prompt, decision);

  return {
    intent_type: decision?.task_type || null,
    goal: decision?.next_action === 'GO_OVERVIEW_QUERY'
      ? 'overview'
      : (decision?.recognized_goal_hint || hints.recognized_goal_hint || 'query'),
    subject_hint: decision?.recognized_subject_hint || hints.recognized_subject_hint || subjectFromState,
    time_hint: decision?.recognized_time_hint || hints.recognized_time_hint || null,
    metric_hint: hints.metricDirection || hints.referenceSignals?.strongestMetricHint || normalizeOptionalText(safeSessionState?.last_metric),
    view_hint: decision?.continuation_type || null,
    constraints: {
      object_scope_type: hints.broadObjectType || hints.referenceSignals?.strongestObjectHint || null
    },
    use_context_inheritance: Boolean(decision?.is_continuation),
    execution_hint: executionHints
  };
}

module.exports = {
  createDefaultSessionState,
  validateDecisionContract,
  buildIntent
};
