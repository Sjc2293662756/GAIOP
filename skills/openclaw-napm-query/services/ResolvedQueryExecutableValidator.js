'use strict';

const ResolvedQueryContract = require('./ResolvedQueryContract');
const ResolutionSpecService = require('./ResolutionSpecService');
const {
  OBJECT_METRIC_COMPATIBILITY,
  classifyObjectMetricCompatibility,
  normalizeGroupPathSignature
} = require('../src/constants/objectMetricOwnership');

const EXECUTABLE_VALIDATION_STATUS = Object.freeze({
  VALID: 'VALID',
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  METRIC_UNKNOWN: 'METRIC_UNKNOWN',
  KNOWN_INCOMPATIBLE: 'KNOWN_INCOMPATIBLE',
  UNKNOWN: 'UNKNOWN',
  CONFIGURATION_FAILURE: 'CONFIGURATION_FAILURE'
});

const METRIC_SERVICES = new Set(['topValues', 'averageValues', 'timeValues']);

function result(status, reasonCode, issues = [], requiredRuntimeChecks = []) {
  const message = {
    VALID: 'Executable query passed static validation.',
    CONTRACT_INVALID: 'Canonical ResolvedQuery contract validation failed.',
    METRIC_UNKNOWN: 'One or more metric IDs are absent from the canonical Metric Catalog.',
    KNOWN_INCOMPATIBLE: 'One or more metrics are statically incompatible with the exact object path.',
    UNKNOWN: 'Runtime capability confirmation is required before execution.',
    CONFIGURATION_FAILURE: 'Static executable validation configuration is unavailable.'
  }[status] || 'Executable query validation failed.';
  return {
    ok: status === EXECUTABLE_VALIDATION_STATUS.VALID,
    status,
    reasonCode,
    message,
    issues,
    requiredRuntimeChecks
  };
}

function collectMetricRoles(query = {}) {
  const roles = (Array.isArray(query.metrics) ? query.metrics : []).map((metricId, index) => ({
    field: `metrics[${index}]`,
    metricId: String(metricId || '').trim().toUpperCase(),
    role: 'RETURN_METRIC'
  }));
  if (query.service === 'topValues') {
    roles.push({
      field: 'topMetric',
      metricId: String(query.topMetric || '').trim().toUpperCase(),
      role: 'RANKING_METRIC'
    });
  }
  return roles;
}

function validate(query = {}, options = {}) {
  const shape = ResolvedQueryContract.validateShape(query, options);
  if (!shape.ok) {
    return {
      ...result(EXECUTABLE_VALIDATION_STATUS.CONTRACT_INVALID, shape.reasonCode, [{
      code: shape.reasonCode,
      field: shape.details?.field || null,
      service: query?.service || null
      }]),
      message: shape.message
    };
  }
  const canonicalQuery = shape.query;
  const argumentPolicy = ResolutionSpecService.evaluateQueryArgumentPolicy(canonicalQuery);
  if (!argumentPolicy.ok) {
    return {
      ...result(EXECUTABLE_VALIDATION_STATUS.CONTRACT_INVALID, argumentPolicy.code, [{
      code: argumentPolicy.code,
      field: 'groups.argument',
      service: canonicalQuery.service,
      groupPathSignature: normalizeGroupPathSignature(canonicalQuery.groups)
      }]),
      message: argumentPolicy.message
    };
  }
  if (!METRIC_SERVICES.has(canonicalQuery.service)) {
    return result(EXECUTABLE_VALIDATION_STATUS.VALID, 'EXECUTABLE_QUERY_VALID');
  }

  let MetricMappingService;
  try {
    MetricMappingService = require('./MetricMappingService');
  } catch (error) {
    return result(EXECUTABLE_VALIDATION_STATUS.CONFIGURATION_FAILURE, 'CATALOG_UNAVAILABLE', [{
      code: error?.code || 'METRIC_CATALOG_UNAVAILABLE',
      field: 'metrics',
      service: canonicalQuery.service
    }]);
  }

  const metricRoles = collectMetricRoles(canonicalQuery);
  const groupPathSignature = normalizeGroupPathSignature(canonicalQuery.groups);
  const baseIssue = (item, code) => ({
    code,
    field: item.field,
    metricId: item.metricId,
    service: canonicalQuery.service,
    groupPathSignature,
    role: item.role
  });
  const unknownMetrics = metricRoles.filter((item) => (
    !MetricMappingService.isValidMetricCode(item.metricId)
  ));
  if (unknownMetrics.length > 0) {
    return result(
      EXECUTABLE_VALIDATION_STATUS.METRIC_UNKNOWN,
      'METRIC_UNKNOWN',
      unknownMetrics.map((item) => baseIssue(item, 'METRIC_UNKNOWN'))
    );
  }

  const classified = metricRoles.map((item) => ({
    item,
    compatibility: classifyObjectMetricCompatibility({
      service: canonicalQuery.service,
      groupPath: canonicalQuery.groups,
      metricId: item.metricId,
      productBaseline: options.productBaseline || ''
    })
  }));
  const incompatible = classified.filter(({ compatibility }) => (
    compatibility === OBJECT_METRIC_COMPATIBILITY.KNOWN_INCOMPATIBLE
  ));
  if (incompatible.length > 0) {
    return result(
      EXECUTABLE_VALIDATION_STATUS.KNOWN_INCOMPATIBLE,
      'OBJECT_METRIC_INCOMPATIBLE',
      incompatible.map(({ item }) => baseIssue(item, 'OBJECT_METRIC_INCOMPATIBLE'))
    );
  }

  const runtimeChecks = new Map();
  classified
    .filter(({ compatibility }) => compatibility === OBJECT_METRIC_COMPATIBILITY.UNKNOWN)
    .forEach(({ item }) => {
      const key = `${canonicalQuery.service}|${groupPathSignature}|${item.metricId}`;
      const existing = runtimeChecks.get(key) || {
        type: 'METRIC_CAPABILITY',
        provider: 'METRICS_FOR_GROUP',
        service: canonicalQuery.service,
        groupPathSignature,
        metricId: item.metricId,
        roles: []
      };
      if (!existing.roles.includes(item.role)) existing.roles.push(item.role);
      runtimeChecks.set(key, existing);
    });
  if (runtimeChecks.size > 0) {
    return result(
      EXECUTABLE_VALIDATION_STATUS.UNKNOWN,
      'RUNTIME_CAPABILITY_REQUIRED',
      [],
      [...runtimeChecks.values()]
    );
  }

  return result(EXECUTABLE_VALIDATION_STATUS.VALID, 'EXECUTABLE_QUERY_VALID');
}

module.exports = {
  EXECUTABLE_VALIDATION_STATUS,
  collectMetricRoles,
  validate
};
