'use strict';

const EXECUTION_OUTCOMES = Object.freeze({
  SUCCESS: 'SUCCESS',
  NO_DATA: 'NO_DATA',
  VALIDATION_FAILURE: 'VALIDATION_FAILURE',
  RUNTIME_CAPABILITY_FAILURE: 'RUNTIME_CAPABILITY_FAILURE',
  SERIALIZATION_FAILURE: 'SERIALIZATION_FAILURE',
  EXECUTION_FAILURE: 'EXECUTION_FAILURE'
});

const EXECUTION_STAGES = Object.freeze({
  SEMANTIC: 'semantic',
  CANONICALIZATION: 'canonicalization',
  REPAIR: 'repair',
  CONTRACT_VALIDATION: 'contract_validation',
  STATIC_VALIDATION: 'static_validation',
  RUNTIME_CAPABILITY: 'runtime_capability',
  SERIALIZATION: 'serialization',
  EXECUTION: 'execution',
  RESPONSE_PARSE: 'response_parse'
});

const VALIDATION_REASON_PREFIXES = Object.freeze([
  'QUERY_',
  'GROUP_',
  'OBJECT_',
  'METRIC_',
  'TOP_',
  'GRANULARITY_',
  'PAGE_FAMILY_',
  'PAGE_VIEWS_',
  'RESULT_REFERENCE_',
  'LEGACY_',
  'REPAIR_',
  'POST_REPAIR_',
  'SEMANTIC_',
  'COMPOSITE_APPLICATION_',
  'MULTI_GROUP_',
  'INVALID_'
]);

function isExecutionOutcome(value) {
  return Object.values(EXECUTION_OUTCOMES).includes(String(value || '').trim());
}

function isValidationReason(reasonCode = '') {
  const normalized = String(reasonCode || '').trim().toUpperCase();
  return VALIDATION_REASON_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function buildOutcomeFields({
  outcome,
  stage,
  reasonCode = null,
  queryExecuted = false,
  dataRequestAttempted = false,
  dataRequestSucceeded = false,
  responseParseSucceeded = false,
  rowCount = null,
  issues = []
} = {}) {
  return {
    outcome,
    stage,
    reasonCode: reasonCode || null,
    queryExecuted: Boolean(queryExecuted),
    dataRequestAttempted: Boolean(dataRequestAttempted),
    dataRequestSucceeded: Boolean(dataRequestSucceeded),
    responseParseSucceeded: Boolean(responseParseSucceeded),
    rowCount: Number.isInteger(rowCount) && rowCount >= 0 ? rowCount : null,
    issues: Array.isArray(issues) ? issues.slice() : []
  };
}

module.exports = {
  EXECUTION_OUTCOMES,
  EXECUTION_STAGES,
  VALIDATION_REASON_PREFIXES,
  isExecutionOutcome,
  isValidationReason,
  buildOutcomeFields
};
