'use strict';

const ResolvedQueryContract = require('./ResolvedQueryContract');
const GroupBuilder = require('./GroupBuilder');
const { buildPageViewsParams } = require('../../shared/NapmPageViewsContract');

const METRIC_SERVICES = new Set(['topValues', 'averageValues', 'timeValues']);

function serializationFailure(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function assertCanonicalQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'A canonical query object is required.');
  }
  if (query.schemaVersion !== ResolvedQueryContract.RESOLVED_QUERY_SCHEMA_VERSION) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'Serializer accepts only napm-resolved-query.v1.');
  }
  if (Object.prototype.hasOwnProperty.call(query, 'metric')) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'Legacy metric is forbidden in the transport serializer.');
  }
}

function assertMetricQueryShape(query = {}) {
  if (!METRIC_SERVICES.has(query.service)) {
    throw serializationFailure(
      'SERIALIZER_SERVICE_UNSUPPORTED',
      `Metric serializer does not support service=${query.service || '(missing)'}.`
    );
  }
  if (!Array.isArray(query.groups) || query.groups.length === 0) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'Canonical metric query requires groups[].');
  }
  if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'Canonical metric query requires metrics[].');
  }
  if (!Number.isInteger(query.start) || !Number.isInteger(query.end)) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'Canonical metric query requires materialized integer start/end.');
  }
  if (query.service === 'topValues') {
    if (query.topMetric == null || !Number.isInteger(query.topCount)) {
      throw serializationFailure('SERIALIZATION_FAILURE', 'Canonical topValues query requires topMetric/topCount.');
    }
  }
  if (query.service === 'timeValues' && !Number.isInteger(query.granularity)) {
    throw serializationFailure('SERIALIZATION_FAILURE', 'Canonical timeValues query requires granularity.');
  }
}

class NapmQuerySerializer {
  constructor({ groupBuilder = GroupBuilder } = {}) {
    this.groupBuilder = groupBuilder;
  }

  serialize(query = {}) {
    assertCanonicalQuery(query);
    if (query.service === 'pageViews') {
      return {
        service: 'pageViews',
        params: buildPageViewsParams(query)
      };
    }

    assertMetricQueryShape(query);
    const params = {
      type: query.service,
      start: query.start,
      end: query.end,
      json: 'true',
      metrics: query.metrics.join(',')
    };

    if (query.service === 'topValues') {
      params.topMetric = query.topMetric;
      params.topCount = query.topCount;
    } else if (query.service === 'timeValues') {
      params.granularity = query.granularity;
    }

    Object.assign(params, this.groupBuilder.buildGroupParams(query.groups));
    return {
      service: query.service,
      params
    };
  }
}

module.exports = new NapmQuerySerializer();
module.exports.NapmQuerySerializer = NapmQuerySerializer;
module.exports.METRIC_SERVICES = METRIC_SERVICES;
