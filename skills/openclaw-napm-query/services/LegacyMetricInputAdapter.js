'use strict';

const ResolvedQueryContract = require('./ResolvedQueryContract');

const METRIC_QUERY_SERVICES = new Set(['topValues', 'averageValues', 'timeValues']);

function cloneQuery(query) {
  return query && typeof query === 'object' && !Array.isArray(query)
    ? JSON.parse(JSON.stringify(query))
    : query;
}

function normalizeMetricId(value = '') {
  return String(value || '').trim().toUpperCase();
}

function warning(kind = 'adapted') {
  return {
    code: 'LEGACY_METRIC_DEPRECATED',
    kind,
    message: 'The legacy metric field was migrated and removed; use canonical metrics[]/topMetric.'
  };
}

function failure(reasonCode, message, details = {}) {
  return {
    ok: false,
    adapted: false,
    reasonCode,
    reason: String(reasonCode || '').toLowerCase(),
    message,
    warnings: [],
    query: null,
    details
  };
}

function adapt(input = {}, options = {}) {
  const candidate = cloneQuery(input);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return failure('QUERY_CONTRACT_INVALID', 'Legacy query input must be an object.');
  }
  if (!Object.prototype.hasOwnProperty.call(candidate, 'metric')) {
    return {
      ok: true,
      adapted: false,
      warnings: [],
      query: candidate
    };
  }

  const service = String(candidate.service || '').trim();
  const metric = normalizeMetricId(candidate.metric);
  if (!METRIC_QUERY_SERVICES.has(service)) {
    return failure(
      'LEGACY_METRIC_NOT_ALLOWED_FOR_SERVICE',
      `Legacy metric is not allowed for service=${service || '(missing)'}.`,
      { service: service || null }
    );
  }
  if (!metric) {
    return failure('LEGACY_METRIC_INVALID', 'Legacy metric must be a non-empty string.');
  }

  candidate.schemaVersion = candidate.schemaVersion
    || ResolvedQueryContract.RESOLVED_QUERY_SCHEMA_VERSION;
  const canonicalMetrics = Array.isArray(candidate.metrics)
    ? [...new Set(candidate.metrics.map(normalizeMetricId).filter(Boolean))]
    : [];
  const canonicalTopMetric = normalizeMetricId(candidate.topMetric);
  const hasCanonicalMetrics = canonicalMetrics.length > 0;
  const hasCanonicalTopMetric = Boolean(canonicalTopMetric);
  let warningKind = 'adapted';
  delete candidate.metric;
  if (service === 'topValues') {
    if (hasCanonicalMetrics && hasCanonicalTopMetric) {
      if (!canonicalMetrics.includes(metric) && canonicalTopMetric !== metric) {
        return failure(
          'LEGACY_METRIC_CONFLICT',
          'Legacy metric conflicts with both canonical metrics[] and topMetric.',
          { metric, metrics: canonicalMetrics, topMetric: canonicalTopMetric }
        );
      }
      candidate.metrics = canonicalMetrics;
      candidate.topMetric = canonicalTopMetric;
      warningKind = 'redundant';
    } else if (hasCanonicalMetrics) {
      candidate.metrics = canonicalMetrics;
      candidate.topMetric = metric;
    } else if (hasCanonicalTopMetric) {
      if (canonicalTopMetric !== metric) {
        return failure(
          'LEGACY_METRIC_PARTIAL_CONFLICT',
          'Legacy metric cannot determine metrics[] when it conflicts with canonical topMetric.',
          { metric, topMetric: canonicalTopMetric }
        );
      }
      candidate.metrics = [metric];
      candidate.topMetric = canonicalTopMetric;
    } else {
      candidate.metrics = [metric];
      candidate.topMetric = metric;
    }
  } else {
    if (hasCanonicalMetrics && !canonicalMetrics.includes(metric)) {
      return failure(
        'LEGACY_METRIC_CONFLICT',
        'Legacy metric conflicts with canonical metrics[].',
        { metric, metrics: canonicalMetrics }
      );
    }
    candidate.metrics = hasCanonicalMetrics ? canonicalMetrics : [metric];
    warningKind = hasCanonicalMetrics ? 'redundant' : 'adapted';
  }

  const validation = ResolvedQueryContract.validateShape(candidate, options);
  if (!validation.ok) {
    return failure(validation.reasonCode, validation.message, validation.details);
  }
  return {
    ok: true,
    adapted: true,
    warnings: [warning(warningKind)],
    query: validation.query
  };
}

module.exports = {
  adapt
};
