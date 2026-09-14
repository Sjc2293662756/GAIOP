'use strict';

const crypto = require('node:crypto');

const SAFE_REPAIR_CODES = Object.freeze(new Set([
  'NORMALIZE_METRIC_ID_CASE',
  'REMOVE_DUPLICATE_METRIC',
  'NORMALIZE_GROUP_ARGUMENT',
  'DERIVE_QUERY_MODE_KEY',
  'NORMALIZE_TIME_BOUND_FORMAT'
]));

const QUERY_MODE_BY_SERVICE = Object.freeze({
  topValues: 'topn',
  averageValues: 'average',
  timeValues: 'timeseries',
  pageViews: 'detail'
});

const CANONICAL_QUERY_SCHEMA_VERSION = 'napm-resolved-query.v1';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value = '') {
  return String(value == null ? '' : value).trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((output, key) => {
      output[key] = stableValue(value[key]);
      return output;
    }, {});
  }
  return value;
}

function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function getAtPath(target, path) {
  return path.split('.').reduce((current, segment) => {
    const match = segment.match(/^([^[]+)(?:\[(\d+)\])?$/);
    if (!match || current == null) return undefined;
    const value = current[match[1]];
    return match[2] == null ? value : value?.[Number(match[2])];
  }, target);
}

function isCanonicalQuery(query = {}) {
  return Boolean(
    query
    && typeof query === 'object'
    && !Array.isArray(query)
    && query.schemaVersion === CANONICAL_QUERY_SCHEMA_VERSION
    && Object.prototype.hasOwnProperty.call(QUERY_MODE_BY_SERVICE, query.service)
  );
}

function setAtPath(target, path, value) {
  const segments = path.split('.');
  const last = segments.pop();
  let current = target;
  segments.forEach((segment) => {
    const match = segment.match(/^([^[]+)(?:\[(\d+)\])?$/);
    if (!match) throw new Error(`Invalid repair path: ${path}`);
    if (!current[match[1]]) current[match[1]] = match[2] == null ? {} : [];
    current = match[2] == null ? current[match[1]] : current[match[1]][Number(match[2])];
  });
  const match = last.match(/^([^[]+)(?:\[(\d+)\])?$/);
  if (!match) throw new Error(`Invalid repair path: ${path}`);
  if (match[2] == null) current[match[1]] = clone(value);
  else current[match[1]][Number(match[2])] = clone(value);
}

function change(path, before, after, reasonCode, source = 'AtomicQueryRepairService') {
  return {
    path,
    before: clone(before),
    after: clone(after),
    reasonCode,
    source,
    semanticImpact: 'NONE'
  };
}

function plan(query = {}, context = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: 'CANONICAL_QUERY_REQUIRED',
      changes: []
    };
  }
  if (Object.prototype.hasOwnProperty.call(query, 'metric')) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: 'LEGACY_INPUT_REQUIRES_ADAPTER',
      changes: []
    };
  }
  if (!isCanonicalQuery(query)) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: 'CANONICAL_QUERY_REQUIRED',
      changes: []
    };
  }

  const suggestions = Array.isArray(context.suggestions) ? context.suggestions : [];
  const changes = [];
  for (const suggestion of suggestions) {
    if (
      normalizeText(suggestion?.semanticImpact).toUpperCase() !== 'NONE'
      || !SAFE_REPAIR_CODES.has(normalizeText(suggestion?.reasonCode))
    ) {
      return {
        status: 'REPAIR_REJECTED',
        reasonCode: 'UNSAFE_REPAIR_SUGGESTION',
        changes: []
      };
    }
    changes.push({
      path: suggestion.path,
      before: suggestion.before,
      after: suggestion.after,
      reasonCode: suggestion.reasonCode,
      source: suggestion.source || 'metadata'
    });
  }

  const metrics = Array.isArray(query.metrics) ? query.metrics : null;
  if (metrics && metrics.length > 0) {
    const normalizedMetrics = metrics.map((metricId) => normalizeText(metricId).toUpperCase());
    const dedupedMetrics = [...new Set(normalizedMetrics)];
    if (JSON.stringify(normalizedMetrics) !== JSON.stringify(dedupedMetrics)) {
      changes.push(change('metrics', metrics, dedupedMetrics, 'REMOVE_DUPLICATE_METRIC'));
    } else if (JSON.stringify(metrics) !== JSON.stringify(normalizedMetrics)) {
      changes.push(change('metrics', metrics, normalizedMetrics, 'NORMALIZE_METRIC_ID_CASE'));
    }
  }

  if (query.service === 'topValues' && query.topMetric != null) {
    const normalizedTopMetric = normalizeText(query.topMetric).toUpperCase();
    if (normalizedTopMetric !== query.topMetric) {
      changes.push(change('topMetric', query.topMetric, normalizedTopMetric, 'NORMALIZE_METRIC_ID_CASE'));
    }
  }

  if (Array.isArray(query.groups)) {
    query.groups.forEach((group, index) => {
      if (!Object.prototype.hasOwnProperty.call(group || {}, 'argument')) return;
      if (group.argument == null) return;
      const normalizedArgument = normalizeText(group.argument);
      if (normalizedArgument !== group.argument) {
        changes.push(change(`groups[${index}].argument`, group.argument, normalizedArgument, 'NORMALIZE_GROUP_ARGUMENT'));
      }
    });
  }

  ['start', 'end', 'granularity'].forEach((field) => {
    if (query[field] == null || typeof query[field] !== 'string') return;
    const raw = query[field].trim();
    if (!/^\d+$/.test(raw)) return;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) return;
    changes.push(change(field, query[field], numeric, 'NORMALIZE_TIME_BOUND_FORMAT'));
  });

  if (!normalizeText(query.queryModeKey) && QUERY_MODE_BY_SERVICE[query.service]) {
    changes.push(change(
      'queryModeKey',
      query.queryModeKey,
      QUERY_MODE_BY_SERVICE[query.service],
      'DERIVE_QUERY_MODE_KEY'
    ));
  } else if (
    normalizeText(query.queryModeKey)
    && QUERY_MODE_BY_SERVICE[query.service]
    && normalizeText(query.queryModeKey) !== QUERY_MODE_BY_SERVICE[query.service]
  ) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: 'QUERY_MODE_CONFLICT',
      changes: []
    };
  }

  const planResult = buildPlan(query, changes);
  return planResult;
}

function buildPlan(query = {}, changes = []) {
  const byPath = new Map();
  for (const candidate of changes) {
    const path = normalizeText(candidate?.path);
    if (!path || !SAFE_REPAIR_CODES.has(normalizeText(candidate?.reasonCode))) {
      return { status: 'REPAIR_REJECTED', reasonCode: 'UNSAFE_REPAIR_SUGGESTION', changes: [] };
    }
    const existing = byPath.get(path);
    if (existing && JSON.stringify(existing.after) !== JSON.stringify(candidate.after)) {
      return { status: 'REPAIR_REJECTED', reasonCode: 'REPAIR_CONFLICT', changes: [] };
    }
    const reasonCode = normalizeText(candidate.reasonCode);
    const before = getAtPath(query, path);
    const after = candidate.after;
    const safeTransform = (
      reasonCode === 'NORMALIZE_METRIC_ID_CASE'
      && (path === 'topMetric' || path === 'metrics')
      && JSON.stringify(after) === JSON.stringify(
        Array.isArray(before)
          ? before.map((metricId) => normalizeText(metricId).toUpperCase())
          : normalizeText(before).toUpperCase()
      )
    ) || (
      reasonCode === 'REMOVE_DUPLICATE_METRIC'
      && path === 'metrics'
      && JSON.stringify(after) === JSON.stringify([
        ...new Set((Array.isArray(before) ? before : [])
          .map((metricId) => normalizeText(metricId).toUpperCase()))
      ])
    ) || (
      reasonCode === 'NORMALIZE_GROUP_ARGUMENT'
      && /^groups\[\d+\]\.argument$/.test(path)
      && JSON.stringify(after) === JSON.stringify(normalizeText(before))
    ) || (
      reasonCode === 'DERIVE_QUERY_MODE_KEY'
      && path === 'queryModeKey'
      && after === QUERY_MODE_BY_SERVICE[query.service]
    ) || (
      reasonCode === 'NORMALIZE_TIME_BOUND_FORMAT'
      && /^(?:start|end|granularity)$/.test(path)
      && typeof before === 'string'
      && /^\d+$/.test(before.trim())
      && after === Number(before.trim())
    );
    if (!safeTransform || JSON.stringify(before) !== JSON.stringify(candidate.before)) {
      return { status: 'REPAIR_REJECTED', reasonCode: 'UNSAFE_REPAIR_SUGGESTION', changes: [] };
    }
    if (byPath.has(path)) {
      continue;
    }
    byPath.set(path, {
      path,
      before: clone(candidate.before),
      after: clone(candidate.after),
      reasonCode: normalizeText(candidate.reasonCode),
      source: normalizeText(candidate.source) || 'AtomicQueryRepairService',
      semanticImpact: 'NONE'
    });
  }
  const normalizedChanges = [...byPath.values()];
  return {
    status: normalizedChanges.length > 0 ? 'REPAIR_APPLICABLE' : 'NO_REPAIR_NEEDED',
    reasonCode: normalizedChanges.length > 0 ? 'SAFE_REPAIR_AVAILABLE' : 'NO_REPAIR_NEEDED',
    changes: normalizedChanges,
    beforeFingerprint: fingerprint(query)
  };
}

function apply(query = {}, repairPlan = {}) {
  if (!repairPlan || !['REPAIR_APPLICABLE', 'NO_REPAIR_NEEDED'].includes(repairPlan.status)) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: repairPlan?.reasonCode || 'REPAIR_PLAN_INVALID',
      changes: []
    };
  }
  if (
    repairPlan.beforeFingerprint
    && repairPlan.beforeFingerprint !== fingerprint(query)
  ) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: 'REPAIR_PLAN_STALE',
      changes: [],
      beforeFingerprint: repairPlan.beforeFingerprint,
      actualFingerprint: fingerprint(query)
    };
  }
  const verifiedPlan = buildPlan(query, repairPlan.changes || []);
  if (
    verifiedPlan.status === 'REPAIR_REJECTED'
    || verifiedPlan.status !== repairPlan.status
    || JSON.stringify(stableValue(verifiedPlan.changes))
      !== JSON.stringify(stableValue(repairPlan.changes || []))
  ) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: verifiedPlan.reasonCode || 'REPAIR_PLAN_INVALID',
      changes: []
    };
  }
  const candidate = clone(query);
  try {
    (repairPlan.changes || []).forEach((item) => {
      if (item.semanticImpact !== 'NONE' || !SAFE_REPAIR_CODES.has(item.reasonCode)) {
        throw Object.assign(new Error('Unsafe repair change.'), { code: 'UNSAFE_REPAIR_SUGGESTION' });
      }
      if (JSON.stringify(getAtPath(candidate, item.path)) !== JSON.stringify(item.before)) {
        throw Object.assign(new Error('Repair plan was created for a different query snapshot.'), { code: 'REPAIR_PLAN_STALE' });
      }
      setAtPath(candidate, item.path, item.after);
    });
  } catch (error) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: error.code || 'REPAIR_APPLY_FAILED',
      changes: []
    };
  }
  const beforeFingerprint = repairPlan.beforeFingerprint || fingerprint(query);
  const afterFingerprint = fingerprint(candidate);
  return {
    status: repairPlan.changes?.length ? 'REPAIR_APPLIED' : 'NO_REPAIR_NEEDED',
    reasonCode: repairPlan.changes?.length ? 'SAFE_REPAIR_APPLIED' : 'NO_REPAIR_NEEDED',
    query: candidate,
    changes: clone(repairPlan.changes || []),
    beforeFingerprint,
    afterFingerprint,
    repairApplied: Boolean(repairPlan.changes?.length)
  };
}

function repair(query = {}, context = {}) {
  const repairPlan = plan(query, context);
  if (repairPlan.status === 'REPAIR_REJECTED') return repairPlan;
  return {
    ...apply(query, repairPlan),
    plan: repairPlan
  };
}

function repairCandidate(query = {}, candidate = {}, context = {}) {
  const planned = repair(query, context);
  if (planned.status === 'REPAIR_REJECTED') return planned;
  const expected = planned.query || query;
  if (JSON.stringify(stableValue(candidate)) !== JSON.stringify(stableValue(expected))) {
    return {
      status: 'REPAIR_REJECTED',
      reasonCode: 'UNSAFE_REPAIR_SUGGESTION',
      changes: []
    };
  }
  return planned;
}

module.exports = {
  SAFE_REPAIR_CODES,
  QUERY_MODE_BY_SERVICE,
  fingerprint,
  isCanonicalQuery,
  plan,
  buildPlan,
  apply,
  repair,
  repairCandidate
};
