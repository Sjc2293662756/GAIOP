'use strict';

const { validatePageViewsQuery } = require('../../shared/NapmPageViewsContract');

const RESOLVED_QUERY_SCHEMA_VERSION = 'napm-resolved-query.v1';

const SERVICE_CONTRACTS = Object.freeze({
  topValues: Object.freeze({
    queryModeKey: 'topn',
    required: Object.freeze([
      'schemaVersion',
      'service',
      'groups',
      'metrics',
      'topMetric',
      'topCount',
      'start',
      'end'
    ]),
    optional: Object.freeze([
      'queryModeKey', 'timeRange', 'filters', 'format', 'userRequirement',
      'semanticConstraints', 'pathPlanning', 'resolutionHints', 'executionOptions',
      'executionBinding', 'resultReference', 'sourceReference'
    ]),
    forbidden: Object.freeze(['metric', 'granularity', 'pageFamilyId', 'maxLimit']),
    legacy: Object.freeze(['metric'])
  }),
  averageValues: Object.freeze({
    queryModeKey: 'average',
    required: Object.freeze([
      'schemaVersion',
      'service',
      'groups',
      'metrics',
      'start',
      'end'
    ]),
    optional: Object.freeze([
      'queryModeKey', 'timeRange', 'filters', 'format', 'userRequirement',
      'semanticConstraints', 'pathPlanning', 'resolutionHints', 'executionOptions',
      'executionBinding'
    ]),
    forbidden: Object.freeze([
      'metric', 'topMetric', 'topCount', 'granularity', 'pageFamilyId', 'maxLimit'
    ]),
    legacy: Object.freeze(['metric'])
  }),
  timeValues: Object.freeze({
    queryModeKey: 'timeseries',
    required: Object.freeze([
      'schemaVersion',
      'service',
      'groups',
      'metrics',
      'granularity',
      'start',
      'end'
    ]),
    optional: Object.freeze([
      'queryModeKey', 'timeRange', 'filters', 'format', 'userRequirement',
      'semanticConstraints', 'pathPlanning', 'resolutionHints', 'executionOptions',
      'executionBinding'
    ]),
    forbidden: Object.freeze(['metric', 'topMetric', 'topCount', 'pageFamilyId', 'maxLimit']),
    legacy: Object.freeze(['metric'])
  }),
  pageViews: Object.freeze({
    queryModeKey: 'detail',
    required: Object.freeze([
      'schemaVersion',
      'service',
      'pageFamilyId',
      'start',
      'end'
    ]),
    optional: Object.freeze([
      'queryModeKey', 'maxLimit', 'resultReference', 'sourceReference', 'timeRange',
      'format', 'userRequirement', 'semanticConstraints', 'executionOptions',
      'executionBinding'
    ]),
    forbidden: Object.freeze([
      'metric',
      'metrics',
      'topMetric',
      'topCount',
      'granularity',
      'groups'
    ]),
    legacy: Object.freeze(['metric'])
  })
});

function cloneQuery(query) {
  return query && typeof query === 'object' && !Array.isArray(query)
    ? JSON.parse(JSON.stringify(query))
    : query;
}

function normalizeMetricId(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizeCanonicalShape(query = {}) {
  const normalized = cloneQuery(query);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return normalized;
  }

  normalized.schemaVersion = String(normalized.schemaVersion || '').trim();
  normalized.service = String(normalized.service || '').trim();
  const serviceContract = SERVICE_CONTRACTS[normalized.service];
  if (!normalized.queryModeKey && serviceContract?.queryModeKey) {
    normalized.queryModeKey = serviceContract.queryModeKey;
  }
  if (Array.isArray(normalized.groups)) {
    normalized.groups = normalized.groups.map((group) => ({
      ...(group || {}),
      type: String(group?.type || '').trim()
    }));
  }
  if (Array.isArray(normalized.metrics)) {
    normalized.metrics = [...new Set(normalized.metrics.map(normalizeMetricId).filter(Boolean))];
  }
  if (normalized.topMetric !== undefined) {
    normalized.topMetric = normalizeMetricId(normalized.topMetric);
  }
  ['topCount', 'start', 'end', 'granularity'].forEach((field) => {
    if (normalized[field] === undefined || normalized[field] === null || normalized[field] === '') return;
    const value = Number(normalized[field]);
    if (Number.isFinite(value)) normalized[field] = value;
  });
  return normalized;
}

function failure(reasonCode, message, query = null, details = {}) {
  return {
    ok: false,
    reasonCode,
    reason: String(reasonCode || '').toLowerCase(),
    message,
    query,
    details
  };
}

function getServiceContract(service = '') {
  return SERVICE_CONTRACTS[String(service || '').trim()] || null;
}

function validateShape(query = {}, options = {}) {
  const normalized = normalizeCanonicalShape(query);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return failure('QUERY_CONTRACT_INVALID', 'ResolvedQuery must be an object.');
  }
  if (!normalized.schemaVersion) {
    return failure(
      'RESOLVED_QUERY_SCHEMA_REQUIRED',
      'Canonical ResolvedQuery requires schemaVersion.',
      normalized
    );
  }
  if (normalized.schemaVersion !== RESOLVED_QUERY_SCHEMA_VERSION) {
    return failure(
      'RESOLVED_QUERY_SCHEMA_UNSUPPORTED',
      `Unsupported ResolvedQuery schemaVersion: ${normalized.schemaVersion}.`,
      normalized,
      { expected: RESOLVED_QUERY_SCHEMA_VERSION, actual: normalized.schemaVersion }
    );
  }
  const serviceContract = getServiceContract(normalized.service);
  if (!serviceContract) {
    return failure(
      'SERVICE_UNSUPPORTED',
      `Unsupported canonical ResolvedQuery service: ${normalized.service || '(missing)'}.`,
      normalized
    );
  }
  if (normalized.queryModeKey !== serviceContract.queryModeKey) {
    return failure(
      'QUERY_MODE_CONFLICT',
      `service=${normalized.service} requires queryModeKey=${serviceContract.queryModeKey}.`,
      normalized,
      { expected: serviceContract.queryModeKey, actual: normalized.queryModeKey || null }
    );
  }
  const forbiddenField = serviceContract.forbidden.find((field) => (
    Object.prototype.hasOwnProperty.call(normalized, field)
  ));
  if (forbiddenField) {
    const reasonCode = forbiddenField === 'metric'
      ? 'METRIC_FORBIDDEN'
      : `${forbiddenField.replace(/([A-Z])/g, '_$1').toUpperCase()}_FORBIDDEN`;
    return failure(
      reasonCode,
      `${forbiddenField} is forbidden for service=${normalized.service}.`,
      normalized,
      { field: forbiddenField, service: normalized.service }
    );
  }
  if (normalized.service === 'pageViews') {
    const detailValidation = validatePageViewsQuery(normalized, { phase: options.phase });
    if (!detailValidation.ok) {
      return failure(
        detailValidation.code || 'QUERY_CONTRACT_INVALID',
        detailValidation.message || 'Invalid pageViews query.',
        normalized,
        detailValidation.details || {}
      );
    }
    return { ok: true, query: detailValidation.query, serviceContract };
  }
  if (!Array.isArray(normalized.groups) || normalized.groups.length === 0) {
    return failure('GROUPS_REQUIRED', 'groups[] is required.', normalized);
  }
  if (!Array.isArray(normalized.metrics) || normalized.metrics.length === 0) {
    return failure('METRICS_REQUIRED', 'metrics[] is required.', normalized);
  }
  if (normalized.service === 'topValues') {
    if (!normalized.topMetric) {
      return failure('TOP_METRIC_REQUIRED', 'topMetric is required.', normalized);
    }
    if (!Number.isInteger(normalized.topCount) || normalized.topCount <= 0) {
      return failure('TOP_COUNT_INVALID', 'topCount must be a positive integer.', normalized);
    }
  }
  if (
    normalized.service === 'timeValues'
    && (!Number.isInteger(normalized.granularity) || normalized.granularity <= 0)
  ) {
    return failure('GRANULARITY_REQUIRED', 'granularity must be a positive integer.', normalized);
  }
  const allowDeclarativeTime = options.phase === 'construction'
    && Boolean(String(normalized?.timeRange?.key || '').trim())
    && normalized.start === undefined
    && normalized.end === undefined;
  if (!allowDeclarativeTime) {
    const hasNestedExecutableTime = normalized?.timeRange
      && typeof normalized.timeRange === 'object'
      && (normalized.timeRange.start !== undefined || normalized.timeRange.end !== undefined);
    if (hasNestedExecutableTime && (normalized.start === undefined || normalized.end === undefined)) {
      return failure(
        'INVALID_TIME_FIELD_LOCATION',
        `service=${normalized.service} must put executable timestamps at root-level start/end; timeRange.start/timeRange.end are declarative only.`,
        normalized
      );
    }
    if (!Number.isInteger(normalized.start) || normalized.start <= 0) {
      return failure('START_REQUIRED', 'start must be a positive Unix-second integer.', normalized);
    }
    if (!Number.isInteger(normalized.end) || normalized.end <= normalized.start) {
      return failure('END_REQUIRED', 'end must be an integer greater than start.', normalized);
    }
    if (normalized.start % 60 !== 0 || normalized.end % 60 !== 0) {
      return failure(
        'TIME_ALIGNMENT_INVALID',
        'start/end must be aligned to minute boundaries.',
        normalized
      );
    }
  }
  return { ok: true, query: normalized, serviceContract };
}

module.exports = {
  RESOLVED_QUERY_SCHEMA_VERSION,
  getServiceContract,
  normalizeCanonicalShape,
  validateShape
};
