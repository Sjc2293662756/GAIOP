'use strict';

function isEmptyValue(value) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

function normalizeError(error) {
  const message = String(error?.message || error || 'Unknown query failure').trim();
  return {
    code: String(error?.code || 'UPSTREAM_QUERY_FAILED').trim() || 'UPSTREAM_QUERY_FAILED',
    message
  };
}

function evaluateSettledPlan(plan = [], settled = []) {
  const data = {};
  const outcomes = plan.map((entry, index) => {
    const label = String(entry?.label || `query_${index + 1}`).trim();
    const required = entry?.required !== false;
    const settledResult = settled[index];

    if (settledResult?.status === 'fulfilled') {
      data[label] = settledResult.value;
      return {
        label,
        required,
        status: isEmptyValue(settledResult.value) ? 'empty' : 'success'
      };
    }

    data[label] = null;
    return {
      label,
      required,
      status: 'failed',
      error: normalizeError(settledResult?.reason)
    };
  });

  const requiredOutcomes = outcomes.filter((outcome) => outcome.required);
  const successfulOutcomes = outcomes.filter((outcome) => outcome.status === 'success');
  const emptyOutcomes = outcomes.filter((outcome) => outcome.status === 'empty');
  const requiredUsableCount = requiredOutcomes.filter(
    (outcome) => outcome.status === 'success' || outcome.status === 'empty'
  ).length;
  const emptyRequiredCount = requiredOutcomes.filter((outcome) => outcome.status === 'empty').length;
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  const requiredFailures = failures.filter((outcome) => outcome.required);
  const status = requiredOutcomes.length > 0 && requiredUsableCount === 0
    ? 'failed'
    : failures.length > 0
      ? 'partial'
      : 'success';

  return {
    data,
    outcomes,
    completeness: {
      status,
      partial: status === 'partial',
      requiredCount: requiredOutcomes.length,
      requiredUsableCount,
      successCount: successfulOutcomes.length,
      emptyCount: emptyOutcomes.length,
      emptyRequiredCount,
      allRequiredEmpty: requiredOutcomes.length > 0 && emptyRequiredCount === requiredOutcomes.length,
      failedCount: failures.length,
      failedRequiredCount: requiredFailures.length,
      failures: failures.map((outcome) => ({
        label: outcome.label,
        required: outcome.required,
        error: outcome.error
      }))
    }
  };
}

module.exports = {
  evaluateSettledPlan,
  isEmptyValue
};
