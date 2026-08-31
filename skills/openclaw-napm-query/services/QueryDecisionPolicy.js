'use strict';

const ResolutionSpecService = require('./ResolutionSpecService');
const WorkflowClassifierService = require('./WorkflowClassifierService');

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

function isApplicationTrafficQueryPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text || /(?:总流量|全局流量|整体流量|total\s*traffic|global\s*traffic|overall\s*traffic)/i.test(text)) {
    return false;
  }
  return /(?:应用|application|app)/i.test(text)
    && /(?:流量|吞吐|带宽|throughput|bandwidth|traffic)/i.test(text)
    && /(?:趋势|走势|变化|曲线|按时间|平均|均值|哪个|哪些|谁|最多|最少|最高|最低|排行|排名|top\s*\d*|trend|timeseries|time\s*series|average|mean|ranking)/i.test(text);
}

function normalizeObjectType(value = '') {
  const normalized = String(value || '').trim();
  return normalized === 'Application' ? 'DefinedApp' : normalized;
}

function buildApplicationClarificationDraft(queryDraft = {}) {
  if (!isPlainObject(queryDraft)) return queryDraft;
  const groups = Array.isArray(queryDraft.groups) ? queryDraft.groups : [];
  const sourceGroup = groups.find((group) => String(group?.type || '').trim() === 'TotalTraffic') || {};
  const applicationGroup = { ...sourceGroup, type: 'DefinedApp' };
  delete applicationGroup.argument;
  return {
    ...queryDraft,
    groups: [applicationGroup],
    semanticConstraints: {
      ...(isPlainObject(queryDraft.semanticConstraints) ? queryDraft.semanticConstraints : {}),
      targetObjectType: 'DefinedApp'
    }
  };
}

function validateObjectInventorySemanticContract(prompt = '', queryDraft = {}) {
  const text = String(prompt || queryDraft?.userRequirement || '').trim();
  const classifiedWorkflow = WorkflowClassifierService.classifyWorkflow(prompt);
  const semanticConstraints = isPlainObject(queryDraft?.semanticConstraints)
    ? queryDraft.semanticConstraints
    : {};
  const declaredWorkflowType = String(semanticConstraints.workflowType || '').trim();
  const declaredTargetType = normalizeObjectType(semanticConstraints.targetObjectType);
  const service = String(queryDraft?.service || '').trim();
  const overviewScene = String(queryDraft?.overviewScene || '').trim();
  const promptlessAutoApps = !text && service === 'overview' && overviewScene === 'auto_apps';
  const workflowType = classifiedWorkflow.workflowType === 'object_inventory'
    ? classifiedWorkflow.workflowType
    : (promptlessAutoApps ? 'object_inventory' : declaredWorkflowType);
  const expectedType = normalizeObjectType(
    classifiedWorkflow.workflowType === 'object_inventory'
      ? classifiedWorkflow.targetObjectType
      : (promptlessAutoApps ? 'CompositeApplication' : declaredTargetType)
  );
  if (workflowType !== 'object_inventory' || !expectedType) {
    return { ok: true };
  }

  const queryModeKey = String(queryDraft?.queryModeKey || '').trim();
  const operation = String(queryDraft?.semanticConstraints?.operation || '').trim();
  const groups = Array.isArray(queryDraft?.groups) ? queryDraft.groups : [];
  const groupType = String(groups[0]?.type || '').trim();
  const groupArgument = String(groups[0]?.argument || '').trim();
  const ok = service === 'groups'
    && (!queryModeKey || queryModeKey === 'metadata')
    && (!operation || operation === 'metadata_list')
    && (!declaredWorkflowType || declaredWorkflowType === 'object_inventory')
    && (!declaredTargetType || declaredTargetType === expectedType)
    && groups.length === 1
    && groupType === expectedType
    && !groupArgument;
  if (ok) return { ok: true };

  const composite = expectedType === 'CompositeApplication';
  return {
    ok: false,
    reason: composite
      ? 'composite_application_inventory_contract_mismatch'
      : 'object_inventory_contract_mismatch',
    code: composite
      ? 'COMPOSITE_APPLICATION_INVENTORY_CONTRACT_MISMATCH'
      : 'OBJECT_INVENTORY_CONTRACT_MISMATCH',
    expectedService: 'groups',
    expectedQueryModeKey: 'metadata',
    details: {
      workflowType,
      expectedGroupType: expectedType,
      declaredTargetType: declaredTargetType || null,
      actualService: service || null,
      actualQueryModeKey: queryModeKey || null,
      actualGroupCount: groups.length,
      actualGroupType: groupType || null,
      actualGroupArgument: groupArgument || null
    },
    message: composite
      ? 'CompositeApplication object_inventory 清单必须使用 service=groups、queryModeKey=metadata、groups=[{type:"CompositeApplication"}] 且只能有一个 group；overview/auto_apps 不是清单查询，argument:"all" 等对象参数也不允许。'
      : `object_inventory 对象清单必须使用 service=groups、queryModeKey=metadata、groups=[{type:"${expectedType}"}] 且只能有一个 group，不能携带对象参数。`
  };
}

function evaluateHighRiskSemanticConsistency(prompt = '', queryDraft = {}) {
  if (!isPlainObject(queryDraft)) return { ok: true };

  const groups = Array.isArray(queryDraft.groups) ? queryDraft.groups : [];
  const service = String(queryDraft.service || '').trim();
  const semanticTargetType = normalizeObjectType(queryDraft?.semanticConstraints?.targetObjectType);
  const hasTotalTraffic = groups.some((group) => String(group?.type || '').trim() === 'TotalTraffic');
  if (
    ['timeValues', 'averageValues', 'topValues'].includes(service)
    && hasTotalTraffic
    && (
      isApplicationTrafficQueryPrompt(prompt || queryDraft.userRequirement)
      || semanticTargetType === 'DefinedApp'
    )
  ) {
    return {
      ok: false,
      reason: 'application_scope_mismatch',
      code: 'APPLICATION_SCOPE_MISMATCH',
      expectedGroupType: 'DefinedApp',
      actualGroupType: 'TotalTraffic',
      details: {
        groupType: 'DefinedApp',
        service,
        expectedGroupType: 'DefinedApp',
        actualGroupType: 'TotalTraffic'
      },
      message: service === 'topValues'
        ? '应用流量排行不能使用 TotalTraffic 范围；必须改用 DefinedApp 对象排行。'
        : '应用流量趋势或平均值不能使用 TotalTraffic 范围；缺少应用名称时必须先澄清。'
    };
  }

  return validateObjectInventorySemanticContract(prompt || queryDraft.userRequirement, queryDraft);
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
  const semanticValidation = evaluateHighRiskSemanticConsistency(prompt, queryDraft);
  if (!semanticValidation.ok) {
    if (semanticValidation.code === 'APPLICATION_SCOPE_MISMATCH') {
      if (String(queryDraft?.service || '').trim() === 'topValues') {
        return validationFailureDecision(semanticValidation, queryDraft);
      }
      return clarificationDecision({
        reasonCode: semanticValidation.code,
        details: semanticValidation.details,
        queryDraft: buildApplicationClarificationDraft(queryDraft)
      });
    }
    return validationFailureDecision(semanticValidation, queryDraft);
  }

  const validationReason = String(basicValidation?.reason || '').trim();
  const argumentPolicyFailure = [
    'group_argument_required',
    'group_argument_forbidden'
  ].includes(validationReason);

  if (!basicValidation?.ok && !argumentPolicyFailure) {
    return validationFailureDecision(basicValidation, queryDraft);
  }

  if (isPlainObject(queryDraft)) {
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
  evaluateHighRiskSemanticConsistency,
  evaluateQueryDecision,
  isApplicationTrafficQueryPrompt,
  isApplicationTrafficTrendPrompt
};
