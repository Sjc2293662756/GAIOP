'use strict';

const {
  EXECUTION_OUTCOMES,
  EXECUTION_STAGES,
  isValidationReason,
  buildOutcomeFields
} = require('./ExecutionOutcomeContract');

const RUNTIME_FAILURE_REASONS = new Set([
  'RUNTIME_CAPABILITY_FAILURE',
  'RUNTIME_CAPABILITY_PROVIDER_UNAVAILABLE',
  'RUNTIME_CAPABILITY_PROVIDER_UNRESOLVED',
  'RUNTIME_CAPABILITY_RESPONSE_INVALID',
  'RUNTIME_CAPABILITY_FETCH_FAILED'
]);

function normalizeText(value = '') {
  return String(value == null ? '' : value).trim();
}

function resultRows(result = {}) {
  return Array.isArray(result?.data)
    ? result.data
    : (Array.isArray(result?.rows) ? result.rows : null);
}

function hasExecutionAttempt(result = {}, context = {}) {
  return Boolean(result?.dataRequestAttempted || context.dataRequestAttempted);
}

function hasSuccessfulResponse(result = {}, context = {}) {
  return Boolean(
    result?.dataRequestSucceeded
    || context.dataRequestSucceeded
    || (hasExecutionAttempt(result, context) && result?.ok === true && !result?.error)
  );
}

function reasonCodeOf(result = {}) {
  return normalizeText(
    result?.error?.code
    || result?.reasonCode
    || result?.error?.failureClassification?.originalCode
  ).toUpperCase();
}

function mapErrorOutcome(result = {}, context = {}) {
  const reasonCode = reasonCodeOf(result);
  const attempted = hasExecutionAttempt(result, context);
  const parseFailed = result?.responseParseSucceeded === false
    || context.responseParseSucceeded === false
    || /^RESPONSE_PARSE|^PAGE_VIEWS_RESPONSE_INVALID/.test(reasonCode);

  if (RUNTIME_FAILURE_REASONS.has(reasonCode) || result?.outcome === EXECUTION_OUTCOMES.RUNTIME_CAPABILITY_FAILURE) {
    return buildOutcomeFields({
      outcome: EXECUTION_OUTCOMES.RUNTIME_CAPABILITY_FAILURE,
      stage: EXECUTION_STAGES.RUNTIME_CAPABILITY,
      reasonCode: reasonCode || EXECUTION_OUTCOMES.RUNTIME_CAPABILITY_FAILURE,
      issues: result?.issues
    });
  }
  if (reasonCode === 'RUNTIME_METRIC_UNSUPPORTED') {
    return buildOutcomeFields({
      outcome: EXECUTION_OUTCOMES.VALIDATION_FAILURE,
      stage: EXECUTION_STAGES.RUNTIME_CAPABILITY,
      reasonCode,
      issues: result?.issues
    });
  }
  if (
    reasonCode.startsWith('SERIALIZER_')
    || reasonCode.startsWith('SERIALIZATION_')
    || reasonCode === 'SERIALIZATION_FAILURE'
  ) {
    return buildOutcomeFields({
      outcome: EXECUTION_OUTCOMES.SERIALIZATION_FAILURE,
      stage: EXECUTION_STAGES.SERIALIZATION,
      reasonCode,
      issues: result?.issues
    });
  }
  if (!attempted && isValidationReason(reasonCode)) {
    return buildOutcomeFields({
      outcome: EXECUTION_OUTCOMES.VALIDATION_FAILURE,
      stage: reasonCode.startsWith('REPAIR_') || reasonCode.startsWith('POST_REPAIR_')
        ? EXECUTION_STAGES.REPAIR
        : EXECUTION_STAGES.STATIC_VALIDATION,
      reasonCode,
      issues: result?.issues
    });
  }
  if (parseFailed) {
    return buildOutcomeFields({
      outcome: EXECUTION_OUTCOMES.EXECUTION_FAILURE,
      stage: EXECUTION_STAGES.RESPONSE_PARSE,
      reasonCode: reasonCode || 'RESPONSE_PARSE_FAILED',
      queryExecuted: attempted,
      dataRequestAttempted: attempted,
      dataRequestSucceeded: hasSuccessfulResponse(result, context),
      responseParseSucceeded: false,
      issues: result?.issues
    });
  }
  if (attempted) {
    return buildOutcomeFields({
      outcome: EXECUTION_OUTCOMES.EXECUTION_FAILURE,
      stage: EXECUTION_STAGES.EXECUTION,
      reasonCode: reasonCode || 'EXECUTION_FAILED',
      queryExecuted: true,
      dataRequestAttempted: true,
      dataRequestSucceeded: Boolean(result?.dataRequestSucceeded || context.dataRequestSucceeded),
      responseParseSucceeded: Boolean(result?.responseParseSucceeded),
      issues: result?.issues
    });
  }
  return buildOutcomeFields({
    outcome: EXECUTION_OUTCOMES.VALIDATION_FAILURE,
    stage: EXECUTION_STAGES.CONTRACT_VALIDATION,
    reasonCode: reasonCode || 'QUERY_VALIDATION_FAILED',
    issues: result?.issues
  });
}

function mapResult(result = {}, context = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      ok: false,
      ...buildOutcomeFields({
        outcome: EXECUTION_OUTCOMES.EXECUTION_FAILURE,
        stage: EXECUTION_STAGES.EXECUTION,
        reasonCode: 'EXECUTION_RESULT_INVALID',
        queryExecuted: true,
        dataRequestAttempted: true
      })
    };
  }

  const rows = resultRows(result);
  const attempted = hasExecutionAttempt(result, context);
  const succeeded = hasSuccessfulResponse(result, context);
  const explicitOutcome = normalizeText(result.outcome);
  const explicitReasonCode = reasonCodeOf(result);
  const knownExplicitOutcome = new Set(Object.values(EXECUTION_OUTCOMES));
  if (
    knownExplicitOutcome.has(explicitOutcome)
    && ![EXECUTION_OUTCOMES.SUCCESS, EXECUTION_OUTCOMES.NO_DATA].includes(explicitOutcome)
    && result.stage
  ) {
    return {
      ...result,
      ok: false,
      ...buildOutcomeFields({
        outcome: explicitOutcome,
        stage: result.stage,
        reasonCode: explicitReasonCode || explicitOutcome,
        queryExecuted: Boolean(result.queryExecuted),
        dataRequestAttempted: Boolean(result.dataRequestAttempted),
        dataRequestSucceeded: Boolean(result.dataRequestSucceeded),
        responseParseSucceeded: Boolean(result.responseParseSucceeded),
        rowCount: result.rowCount,
        issues: result.issues
      })
    };
  }
  if (explicitOutcome === 'RESULT') {
    return mapResult({
      ...result,
      outcome: null,
      ok: result.ok !== false
    }, {
      ...context,
      assumeSuccessfulExecution: true,
      dataRequestAttempted: true,
      dataRequestSucceeded: true
    });
  }
  if (result.error || result.ok === false || (explicitOutcome && ![EXECUTION_OUTCOMES.SUCCESS, EXECUTION_OUTCOMES.NO_DATA].includes(explicitOutcome))) {
    return {
      ...result,
      ok: false,
      ...mapErrorOutcome(result, context)
    };
  }
  if (rows && attempted && succeeded) {
    const empty = rows.length === 0;
    return {
      ...result,
      ok: true,
      ...buildOutcomeFields({
        outcome: empty ? EXECUTION_OUTCOMES.NO_DATA : EXECUTION_OUTCOMES.SUCCESS,
        stage: EXECUTION_STAGES.EXECUTION,
        reasonCode: empty ? 'NO_DATA' : null,
        queryExecuted: true,
        dataRequestAttempted: true,
        dataRequestSucceeded: true,
        responseParseSucceeded: true,
        rowCount: rows.length
      })
    };
  }
  if (result.ok === true && !result.error && (rows || context.assumeSuccessfulExecution)) {
    const rowCount = rows ? rows.length : null;
    return {
      ...result,
      ok: true,
      ...buildOutcomeFields({
        outcome: rowCount === 0 ? EXECUTION_OUTCOMES.NO_DATA : EXECUTION_OUTCOMES.SUCCESS,
        stage: EXECUTION_STAGES.EXECUTION,
        reasonCode: rowCount === 0 ? 'NO_DATA' : null,
        queryExecuted: Boolean(attempted || context.assumeSuccessfulExecution),
        dataRequestAttempted: attempted || Boolean(context.assumeSuccessfulExecution),
        dataRequestSucceeded: succeeded || Boolean(context.assumeSuccessfulExecution),
        responseParseSucceeded: true,
        rowCount
      })
    };
  }
  return {
    ...result,
    ok: false,
    ...mapErrorOutcome(result, context)
  };
}

module.exports = {
  mapResult,
  mapErrorOutcome,
  reasonCodeOf
};
