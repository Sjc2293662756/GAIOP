'use strict';

const ResolutionSpecService = require('./ResolutionSpecService');

const QUERY_ACTIONS = Object.freeze({
  ASK_CLARIFYING_QUESTION: 'ASK_CLARIFYING_QUESTION',
  EXECUTE_QUERY: 'EXECUTE_QUERY',
  REJECT_QUERY: 'REJECT_QUERY'
});

const QUERY_OUTCOMES = Object.freeze({
  CLARIFICATION: 'CLARIFICATION',
  RESULT: 'RESULT',
  NO_DATA: 'NO_DATA',
  REJECTION: 'REJECTION',
  VALIDATION_FAILURE: 'VALIDATION_FAILURE',
  EXECUTION_FAILURE: 'EXECUTION_FAILURE'
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toReasonCode(reason = '', fallback = 'QUERY_VALIDATION_FAILED') {
  const normalized = String(reason || '').trim();
  return normalized
    ? normalized.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
    : fallback;
}

function isApplicationTrafficTrendPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  return Boolean(text)
    && /(?:应用|application|app)/i.test(text)
    && /(?:流量|吞吐|带宽|throughput|bandwidth|traffic)/i.test(text)
    && /(?:趋势|走势|变化|曲线|按时间|平均|均值|trend|timeseries|time\s*series|average|mean)/i.test(text);
}

function buildClarifyingQuestion(reasonCode = '', details = {}) {
  if (reasonCode === 'APPLICATION_SCOPE_MISMATCH') {
    return '应用流量趋势需要指定具体应用名称。请告诉我要查询哪个应用；如果您想看全局流量，请改问“总流量趋势”。';
  }

  const groupType = String(details?.groupType || '').trim();
  if (groupType === 'DefinedApp') {
    return '查询应用的趋势或平均值需要指定具体应用名称，请告诉我要查询哪个应用。';
  }
  if (groupType === 'WebApplication') {
    return '查询业务/Web 应用的趋势或平均值需要指定具体业务名称，请告诉我要查询哪个业务。';
  }
  return '该查询需要指定具体对象名称，请补充要查询的对象。';
}

function buildBasicValidation(queryDraft = {}) {
  if (!isPlainObject(queryDraft)) {
    return {
      ok: false,
      reason: 'missing_query_draft',
      message: 'A structured queryDraft is required.'
    };
  }

  const service = String(queryDraft.service || '').trim();
  if (!service) {
    return { ok: false, reason: 'missing_service', message: 'queryDraft.service is required.' };
  }

  const serviceSpec = ResolutionSpecService.getServiceSpec(service);
  if (!serviceSpec) {
    return {
      ok: false,
      reason: 'unknown_service',
      message: `queryDraft.service=${service} is not declared in the resolution spec.`
    };
  }

  const queryModeKey = String(queryDraft.queryModeKey || '').trim();
  const allowedQueryModes = Array.isArray(serviceSpec.queryModes) ? serviceSpec.queryModes : [];
  if (queryModeKey && allowedQueryModes.length > 0 && !allowedQueryModes.includes(queryModeKey)) {
    return {
      ok: false,
      reason: 'invalid_query_mode',
      message: `queryDraft.service=${service} does not accept queryModeKey=${queryModeKey}.`
    };
  }

  const hasDeclarativeTime = Boolean(String(queryDraft?.timeRange?.key || '').trim());
  const missingFields = [];
  for (const field of (Array.isArray(serviceSpec.required) ? serviceSpec.required : [])) {
    if ((field === 'start' || field === 'end') && hasDeclarativeTime) continue;
    const value = queryDraft[field];
    if (['groups', 'metrics', 'protocolQueries'].includes(field)) {
      if (!Array.isArray(value) || value.length === 0) missingFields.push(field);
    } else if (value == null || (typeof value === 'string' && !value.trim())) {
      missingFields.push(field);
    }
  }
  if (missingFields.length > 0) {
    return {
      ok: false,
      reason: 'incomplete_query_draft',
      message: `queryDraft is missing required fields for service=${service}: ${missingFields.join(', ')}.`,
      details: { service, missingFields }
    };
  }

  return { ok: true };
}

function clarificationDecision({ reasonCode, details = {}, queryDraft = null }) {
  return {
    ok: true,
    action: QUERY_ACTIONS.ASK_CLARIFYING_QUESTION,
    outcome: QUERY_OUTCOMES.CLARIFICATION,
    reasonCode,
    reason: reasonCode.toLowerCase(),
    missingFields: ['groups[0].argument'],
    clarifyingQuestion: buildClarifyingQuestion(reasonCode, details),
    southboundAllowed: false,
    queryDraft
  };
}

function validationFailureDecision(validation = {}, queryDraft = null) {
  return {
    ok: false,
    action: QUERY_ACTIONS.REJECT_QUERY,
    outcome: QUERY_OUTCOMES.VALIDATION_FAILURE,
    reasonCode: toReasonCode(validation?.reason),
    reason: String(validation?.reason || 'query_validation_failed'),
    validation,
    southboundAllowed: false,
    queryDraft
  };
}

function evaluateQueryDecision({ prompt = '', queryDraft = null, validation = undefined } = {}) {
  const basicValidation = validation === undefined
    ? buildBasicValidation(queryDraft)
    : validation;
  const validationReason = String(basicValidation?.reason || '').trim();
  const argumentPolicyFailure = [
    'group_argument_required',
    'group_argument_forbidden'
  ].includes(validationReason);

  if (!basicValidation?.ok && !argumentPolicyFailure) {
    return validationFailureDecision(basicValidation, queryDraft);
  }

  if (isPlainObject(queryDraft)) {
    const groups = Array.isArray(queryDraft.groups) ? queryDraft.groups : [];
    const service = String(queryDraft.service || '').trim();
    const hasTotalTraffic = groups.some((group) => String(group?.type || '').trim() === 'TotalTraffic');
    if (
      ['timeValues', 'averageValues'].includes(service)
      && hasTotalTraffic
      && isApplicationTrafficTrendPrompt(prompt || queryDraft.userRequirement)
    ) {
      return clarificationDecision({
        reasonCode: 'APPLICATION_SCOPE_MISMATCH',
        details: { groupType: 'DefinedApp' },
        queryDraft
      });
    }

    const argumentPolicy = ResolutionSpecService.evaluateQueryArgumentPolicy(queryDraft);
    if (!argumentPolicy.ok && argumentPolicy.code === 'GROUP_ARGUMENT_REQUIRED') {
      return clarificationDecision({
        reasonCode: argumentPolicy.code,
        details: argumentPolicy.details,
        queryDraft
      });
    }
    if (!argumentPolicy.ok && argumentPolicy.code === 'GROUP_ARGUMENT_FORBIDDEN') {
      return {
        ok: true,
        action: QUERY_ACTIONS.REJECT_QUERY,
        outcome: QUERY_OUTCOMES.REJECTION,
        reasonCode: argumentPolicy.code,
        reason: argumentPolicy.reason,
        rejectionMessage: '当前查询对象不接受名称参数，请移除该参数后重新查询。',
        southboundAllowed: false,
        queryDraft
      };
    }
  }

  if (!basicValidation?.ok) return validationFailureDecision(basicValidation, queryDraft);

  return {
    ok: true,
    action: QUERY_ACTIONS.EXECUTE_QUERY,
    outcome: null,
    reasonCode: 'QUERY_READY',
    reason: 'query_ready',
    southboundAllowed: true,
    queryDraft,
    resolvedQuery: queryDraft
  };
}

module.exports = {
  QUERY_ACTIONS,
  QUERY_OUTCOMES,
  buildClarifyingQuestion,
  evaluateQueryDecision,
  isApplicationTrafficTrendPrompt
};
