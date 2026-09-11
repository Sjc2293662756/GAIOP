'use strict';

const PROVIDER = 'METRICS_FOR_GROUP';
const RUNTIME_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  UNSUPPORTED: 'UNSUPPORTED',
  INDETERMINATE: 'INDETERMINATE'
});

function normalizeText(value = '') {
  return String(value == null ? '' : value).trim();
}

function normalizeMetricId(value = '') {
  return normalizeText(value).toUpperCase();
}

function normalizeGroupPathSignature(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => normalizeText(typeof group === 'string' ? group : group?.type))
    .filter(Boolean)
    .join('>');
}

function buildCapabilityScope(query = {}, check = {}) {
  const groups = Array.isArray(query?.groups) ? query.groups : [];
  return {
    service: normalizeText(check.service || query.service),
    groupPathSignature: normalizeText(check.groupPathSignature) || normalizeGroupPathSignature(groups),
    groups: groups.map((group) => ({
      type: normalizeText(group?.type),
      ...(normalizeText(group?.argument) ? { argument: normalizeText(group.argument) } : {})
    }))
  };
}

function checkKey(scope = {}) {
  return JSON.stringify({
    service: scope.service,
    groupPathSignature: scope.groupPathSignature,
    groups: scope.groups
  });
}

function normalizeChecks(staticValidation = {}) {
  const checks = Array.isArray(staticValidation?.requiredRuntimeChecks)
    ? staticValidation.requiredRuntimeChecks
    : [];
  const byMetric = new Map();
  checks.forEach((check) => {
    const metricId = normalizeMetricId(check?.metricId);
    const provider = normalizeText(check?.provider).toUpperCase();
    if (!metricId) return;
    const key = `${provider}|${normalizeText(check?.service)}|${normalizeText(check?.groupPathSignature)}|${metricId}`;
    const existing = byMetric.get(key) || {
      type: normalizeText(check?.type || 'METRIC_CAPABILITY').toUpperCase(),
      provider,
      service: normalizeText(check?.service),
      groupPathSignature: normalizeText(check?.groupPathSignature),
      metricId,
      roles: []
    };
    (Array.isArray(check?.roles) ? check.roles : []).forEach((role) => {
      const normalizedRole = normalizeText(role).toUpperCase();
      if (normalizedRole && !existing.roles.includes(normalizedRole)) existing.roles.push(normalizedRole);
    });
    byMetric.set(key, existing);
  });
  return [...byMetric.values()];
}

function normalizeProviderResult(result = {}) {
  if (result?.ok === false || result?.status === RUNTIME_STATUS.INDETERMINATE) {
    return {
      status: RUNTIME_STATUS.INDETERMINATE,
      reasonCode: normalizeText(result?.reasonCode) || 'RUNTIME_CAPABILITY_FETCH_FAILED',
      supportedMetricIds: [],
      providerResult: result
    };
  }
  if (!Array.isArray(result?.supportedMetricIds)) {
    return {
      status: RUNTIME_STATUS.INDETERMINATE,
      reasonCode: 'RUNTIME_CAPABILITY_RESPONSE_INVALID',
      supportedMetricIds: [],
      providerResult: result
    };
  }
  return {
    status: 'SUPPORTED_LIST',
    reasonCode: 'RUNTIME_CAPABILITY_RESPONSE_OK',
    supportedMetricIds: new Set(result.supportedMetricIds.map(normalizeMetricId).filter(Boolean)),
    providerResult: result
  };
}

class RuntimeMetricCapabilityService {
  constructor({ metadataService = null, provider = PROVIDER } = {}) {
    this.metadataService = metadataService;
    this.provider = normalizeText(provider).toUpperCase() || PROVIDER;
  }

  async confirm({ query = {}, staticValidation = {}, metadataService = null } = {}) {
    if (staticValidation?.status !== 'UNKNOWN') {
      return {
        status: RUNTIME_STATUS.INDETERMINATE,
        reasonCode: 'RUNTIME_CHECK_REQUIRES_STATIC_UNKNOWN',
        provider: this.provider,
        evidence: [],
        metadataCalls: 0
      };
    }

    const checks = normalizeChecks(staticValidation);
    if (checks.length === 0 || checks.some((check) => (
      check.type !== 'METRIC_CAPABILITY' || check.provider !== PROVIDER
    ))) {
      return {
        status: RUNTIME_STATUS.INDETERMINATE,
        reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNRESOLVED',
        provider: this.provider,
        evidence: [],
        metadataCalls: 0
      };
    }

    const service = metadataService || this.metadataService;
    const providerMethod = service?.getMetricsForGroupPathEvidence;
    if (typeof providerMethod !== 'function') {
      return {
        status: RUNTIME_STATUS.INDETERMINATE,
        reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNAVAILABLE',
        provider: this.provider,
        evidence: [],
        metadataCalls: 0
      };
    }

    const pathResults = new Map();
    let metadataCalls = 0;
    for (const check of checks) {
      const scope = buildCapabilityScope(query, check);
      const expectedSignature = normalizeText(check.groupPathSignature);
      if (
        !scope.service
        || scope.service !== normalizeText(query?.service)
        || !scope.groupPathSignature
        || (expectedSignature && expectedSignature !== scope.groupPathSignature)
      ) {
        pathResults.set(checkKey(scope), {
          status: RUNTIME_STATUS.INDETERMINATE,
          reasonCode: 'RUNTIME_CAPABILITY_SCOPE_MISMATCH',
          supportedMetricIds: new Set(),
          providerResult: null
        });
        continue;
      }
      const key = checkKey(scope);
      if (!pathResults.has(key)) {
        metadataCalls += 1;
        let providerResult;
        try {
          providerResult = await providerMethod.call(service, scope.groups);
        } catch (error) {
          providerResult = {
            ok: false,
            status: RUNTIME_STATUS.INDETERMINATE,
            reasonCode: 'RUNTIME_CAPABILITY_FETCH_FAILED',
            error: error?.message || String(error)
          };
        }
        pathResults.set(key, normalizeProviderResult(providerResult));
      }
    }

    const evidence = checks.map((check) => {
      const scope = buildCapabilityScope(query, check);
      const pathResult = pathResults.get(checkKey(scope)) || {
        status: RUNTIME_STATUS.INDETERMINATE,
        reasonCode: 'RUNTIME_CAPABILITY_SCOPE_MISMATCH',
        supportedMetricIds: new Set(),
        providerResult: null
      };
      const status = pathResult.status === 'SUPPORTED_LIST'
        ? (pathResult.supportedMetricIds.has(check.metricId)
          ? RUNTIME_STATUS.SUPPORTED
          : RUNTIME_STATUS.UNSUPPORTED)
        : RUNTIME_STATUS.INDETERMINATE;
      return {
        type: check.type,
        provider: check.provider,
        service: scope.service,
        groupPathSignature: scope.groupPathSignature,
        metricId: check.metricId,
        roles: check.roles.slice(),
        status,
        reasonCode: status === RUNTIME_STATUS.SUPPORTED
          ? 'RUNTIME_METRIC_SUPPORTED'
          : (status === RUNTIME_STATUS.UNSUPPORTED
            ? 'RUNTIME_METRIC_UNSUPPORTED'
            : pathResult.reasonCode)
      };
    });

    const status = evidence.some((item) => item.status === RUNTIME_STATUS.INDETERMINATE)
      ? RUNTIME_STATUS.INDETERMINATE
      : (evidence.some((item) => item.status === RUNTIME_STATUS.UNSUPPORTED)
        ? RUNTIME_STATUS.UNSUPPORTED
        : RUNTIME_STATUS.SUPPORTED);
    return {
      status,
      provider: this.provider,
      evidence,
      metadataCalls,
      reasonCode: status === RUNTIME_STATUS.SUPPORTED
        ? 'RUNTIME_CAPABILITY_SUPPORTED'
        : (status === RUNTIME_STATUS.UNSUPPORTED
          ? 'RUNTIME_METRIC_UNSUPPORTED'
          : 'RUNTIME_CAPABILITY_FAILURE')
    };
  }
}

module.exports = RuntimeMetricCapabilityService;
module.exports.PROVIDER = PROVIDER;
module.exports.RUNTIME_STATUS = RUNTIME_STATUS;
module.exports.normalizeChecks = normalizeChecks;
