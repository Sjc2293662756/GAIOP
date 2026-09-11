'use strict';

/**
 * Converts the canonical query semantic contract into the transitional
 * resolvedQuery shape. Natural-language metric and ranking semantics are
 * owned by WorkflowClassifierService and are never re-parsed here.
 */
const TimeRangeService = require('./ResolvedQueryTimeRangeService');
const WorkflowClassifierService = require('./WorkflowClassifierService');
const ResolvedQueryContract = require('./ResolvedQueryContract');
const {
  SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_STATUS
} = WorkflowClassifierService;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function alignToMinute(seconds = Math.floor(Date.now() / 1000)) {
  return TimeRangeService.alignToMinute(seconds);
}

function normalizeResolvedQueryTimeRange(resolvedQuery = {}) {
  if (!resolvedQuery || typeof resolvedQuery !== 'object' || Array.isArray(resolvedQuery)) {
    return resolvedQuery;
  }
  const next = { ...resolvedQuery };
  if (Number.isFinite(Number(next.start)) && Number(next.start) > 0) {
    next.start = alignToMinute(next.start);
  }
  if (Number.isFinite(Number(next.end)) && Number(next.end) > 0) {
    next.end = alignToMinute(next.end);
  }
  if (next.timeRange && typeof next.timeRange === 'object' && !Array.isArray(next.timeRange)) {
    next.timeRange = { ...next.timeRange };
    delete next.timeRange.start;
    delete next.timeRange.end;
  }
  return next;
}

function validateResolvedQueryTimeContract(resolvedQuery = {}) {
  const service = normalizeText(resolvedQuery?.service);
  const requiresExecutableTime = new Set([
    'topValues',
    'averageValues',
    'timeValues',
    'overview',
    'topValues_multi_protocol'
  ]).has(service);
  if (!requiresExecutableTime) return { ok: true };

  const hasRootStart = Number.isFinite(Number(resolvedQuery.start)) && Number(resolvedQuery.start) > 0;
  const hasRootEnd = Number.isFinite(Number(resolvedQuery.end)) && Number(resolvedQuery.end) > 0;
  if (hasRootStart && hasRootEnd) return { ok: true };

  const hasNestedStart = Number.isFinite(Number(resolvedQuery?.timeRange?.start))
    && Number(resolvedQuery.timeRange.start) > 0;
  const hasNestedEnd = Number.isFinite(Number(resolvedQuery?.timeRange?.end))
    && Number(resolvedQuery.timeRange.end) > 0;
  return {
    ok: false,
    reason: 'missing_root_execution_time',
    message: 'Cannot construct resolvedQuery because executable start/end must be root-level fields.',
    details: {
      service,
      hasRootStart,
      hasRootEnd,
      nestedTimeRangeProvided: hasNestedStart || hasNestedEnd
    }
  };
}

function buildDiagnostics(extra = {}) {
  return {
    resolver: 'NapmResolvedQueryResolverService',
    source: 'canonical_semantic_contract',
    ...extra
  };
}

function failure(prompt, reason, message, diagnostics = {}, reasonCode = null) {
  return {
    ok: false,
    source: 'openclaw_mainflow_resolver',
    prompt: normalizeText(prompt),
    reason,
    ...(reasonCode ? { reasonCode } : {}),
    message,
    diagnostics: buildDiagnostics(diagnostics)
  };
}

function semanticFailure(prompt, reason, message, diagnostics = {}, reasonCode = null) {
  return {
    ...failure(prompt, reason, message, diagnostics, reasonCode),
    queryDraft: null,
    resolvedQuery: null
  };
}

function success(prompt, intent, resolvedQuery, diagnostics = {}) {
  if (ResolvedQueryContract.getServiceContract(resolvedQuery?.service)) {
    const queryContract = ResolvedQueryContract.validateShape(resolvedQuery);
    if (!queryContract.ok) {
      return semanticFailure(
        prompt,
        'query_contract_invalid',
        queryContract.message,
        {
          ...diagnostics,
          phase: 'resolved_query_contract_validation',
          queryContract: queryContract.details || null
        },
        queryContract.reasonCode
      );
    }
    resolvedQuery = queryContract.query;
  }
  const timeContract = validateResolvedQueryTimeContract(resolvedQuery);
  if (!timeContract.ok) {
    return failure(prompt, timeContract.reason, timeContract.message, {
      ...diagnostics,
      phase: 'time_contract_validation',
      timeContract: timeContract.details
    });
  }
  return {
    ok: true,
    source: 'openclaw_mainflow_resolver',
    intent,
    prompt: normalizeText(prompt),
    resolvedQuery: normalizeResolvedQueryTimeRange(resolvedQuery),
    diagnostics: buildDiagnostics(diagnostics)
  };
}

function buildLast1HourTimeRange(nowSeconds = Math.floor(Date.now() / 1000)) {
  return TimeRangeService.buildLast1HourTimeRange(nowSeconds);
}

function buildLast24HoursTimeRange(nowSeconds = Math.floor(Date.now() / 1000)) {
  return TimeRangeService.buildLast24HoursTimeRange(nowSeconds);
}

function inferTimeRange(prompt = '', nowSeconds = Math.floor(Date.now() / 1000)) {
  return TimeRangeService.resolveTimeRange(prompt, { nowSeconds });
}

function resolveContractTimeRange(semanticContract, context = {}) {
  return TimeRangeService.resolveTimeRange({
    timeRangeKey: semanticContract?.timeIntent?.key || 'last1hour'
  }, {
    nowSeconds: context.nowSeconds || Math.floor(Date.now() / 1000)
  });
}

function buildMetadataResolvedQuery(prompt, service, groupType, workflowType) {
  return {
    service,
    queryModeKey: 'metadata',
    groups: [{ type: groupType }],
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation: workflowType === 'drilldown_catalog' ? 'drilldown_catalog' : 'metadata_list',
      workflowType,
      targetObjectType: groupType
    },
    resolutionHints: {
      constructedBy: 'canonical_semantic_contract'
    }
  };
}

function resolveMetadataContract(semanticContract, context) {
  const prompt = context.prompt || '';
  const groupType = normalizeText(semanticContract.targetObjectType);
  const workflowType = normalizeText(context.workflowType);
  if (!groupType) {
    return failure(prompt, 'missing_object', 'Cannot construct metadata query without targetObjectType.', {
      phase: 'semantic_contract_validation'
    }, 'SEMANTIC_TARGET_OBJECT_REQUIRED');
  }
  const service = {
    object_inventory: 'groups',
    metric_inventory: 'metrics',
    drilldown_catalog: 'drilldownCatalog'
  }[workflowType];
  if (!service) {
    return failure(prompt, 'missing_metadata_kind', 'Metadata semantic contract requires a supported workflow type.', {
      phase: 'semantic_contract_validation',
      workflowType: workflowType || null
    }, 'METADATA_KIND_REQUIRED');
  }
  return success(prompt, {
    category: 'metadata_query',
    workflowType,
    service,
    operation: 'metadata_list',
    groupType
  }, buildMetadataResolvedQuery(prompt, service, groupType, workflowType));
}

function resolveRankTopContract(semanticContract, context) {
  const prompt = context.prompt || '';
  const groupType = normalizeText(semanticContract.targetObjectType);
  const rankingMetric = normalizeText(semanticContract.rankingMetric);
  const requestedMetrics = Array.isArray(semanticContract.requestedMetrics)
    ? [...new Set(semanticContract.requestedMetrics.map(normalizeText).filter(Boolean))]
    : [];
  const topCount = Number(semanticContract.topCount);
  if (!rankingMetric) {
    return failure(prompt, 'missing_metric', 'Cannot construct resolvedQuery because rankingMetric is missing.', {
      phase: 'semantic_contract_validation'
    }, 'RANKING_METRIC_REQUIRED');
  }
  if (!groupType) {
    return failure(prompt, 'missing_group', 'Cannot construct resolvedQuery because targetObjectType is missing.', {
      phase: 'semantic_contract_validation'
    }, 'SEMANTIC_TARGET_OBJECT_REQUIRED');
  }
  if (!Number.isInteger(topCount) || topCount <= 0) {
    return failure(prompt, 'missing_top_count', 'Cannot construct resolvedQuery because topCount is invalid.', {
      phase: 'semantic_contract_validation'
    }, 'TOP_COUNT_REQUIRED');
  }
  if (semanticContract.direction !== 'desc') {
    return failure(prompt, 'ranking_direction_mismatch', 'rank_top only supports descending direction.', {
      phase: 'semantic_contract_validation'
    }, 'RANK_TOP_DIRECTION_INVALID');
  }

  const timeRange = resolveContractTimeRange(semanticContract, context);
  const metrics = requestedMetrics.length > 0 ? requestedMetrics : [rankingMetric];
  const resolvedQuery = {
    schemaVersion: ResolvedQueryContract.RESOLVED_QUERY_SCHEMA_VERSION,
    service: 'topValues',
    queryModeKey: 'topn',
    metrics,
    topMetric: rankingMetric,
    groups: [{ type: groupType }],
    topCount,
    start: timeRange.start,
    end: timeRange.end,
    timeRange: {
      key: timeRange.key,
      displayText: timeRange.displayText
    },
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation: 'rank_top',
      direction: 'desc',
      targetObjectType: groupType
    },
    resolutionHints: {
      constructedBy: 'canonical_semantic_contract',
      time: {
        source: timeRange.source || 'time_range_resolver',
        key: timeRange.key,
        displayText: timeRange.displayText,
        alignment: timeRange.alignment || 'minute_floor'
      }
    }
  };
  return success(prompt, {
    category: 'data_query',
    service: 'topValues',
    operation: 'rank_top',
    primaryMetric: semanticContract.primaryMetric || null,
    metrics,
    rankingMetric,
    groupType,
    topCount
  }, resolvedQuery, {
    semanticSchemaVersion: semanticContract.schemaVersion,
    timeRange
  });
}

function resolveCanonicalGranularity(start, end) {
  const span = Number(end) - Number(start);
  if (span <= 6 * 3600) return 60;
  if (span <= 3 * 24 * 3600) return 300;
  if (span <= 30 * 24 * 3600) return 3600;
  return 86400;
}

function resolveMetricSeriesContract(semanticContract, context, service) {
  const prompt = context.prompt || '';
  const groupType = normalizeText(semanticContract.targetObjectType);
  const metrics = Array.isArray(semanticContract.requestedMetrics)
    ? [...new Set(semanticContract.requestedMetrics.map(normalizeText).filter(Boolean))]
    : [];
  if (!groupType) {
    return semanticFailure(
      prompt,
      'missing_group',
      'Cannot construct ResolvedQuery because targetObjectType is missing.',
      { phase: 'semantic_contract_validation' },
      'SEMANTIC_TARGET_OBJECT_REQUIRED'
    );
  }
  if (metrics.length === 0) {
    return semanticFailure(
      prompt,
      'missing_metrics',
      'Cannot construct ResolvedQuery because requestedMetrics[] is empty.',
      { phase: 'semantic_contract_validation' },
      'METRICS_REQUIRED'
    );
  }

  const timeRange = resolveContractTimeRange(semanticContract, context);
  const operation = service === 'timeValues' ? 'timeseries' : 'average';
  const resolvedQuery = {
    schemaVersion: ResolvedQueryContract.RESOLVED_QUERY_SCHEMA_VERSION,
    service,
    queryModeKey: service === 'timeValues' ? 'timeseries' : 'average',
    groups: [{ type: groupType }],
    metrics,
    ...(service === 'timeValues'
      ? { granularity: resolveCanonicalGranularity(timeRange.start, timeRange.end) }
      : {}),
    start: timeRange.start,
    end: timeRange.end,
    timeRange: {
      key: timeRange.key,
      displayText: timeRange.displayText
    },
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation,
      targetObjectType: groupType
    },
    resolutionHints: {
      constructedBy: 'canonical_semantic_contract',
      time: {
        source: timeRange.source || 'time_range_resolver',
        key: timeRange.key,
        displayText: timeRange.displayText,
        alignment: timeRange.alignment || 'minute_floor'
      }
    }
  };
  return success(prompt, {
    category: 'data_query',
    service,
    operation,
    metrics,
    groupType
  }, resolvedQuery, {
    semanticSchemaVersion: semanticContract.schemaVersion,
    timeRange
  });
}

function resolveSemanticContract(semanticContract = {}, context = {}) {
  const prompt = context.prompt || '';
  if (!semanticContract || typeof semanticContract !== 'object' || Array.isArray(semanticContract)) {
    return semanticFailure(prompt, 'invalid_semantic_contract', 'Semantic contract must be an object.', {
      phase: 'semantic_contract_validation'
    }, 'SEMANTIC_CONTRACT_INVALID');
  }
  if (semanticContract.schemaVersion !== SEMANTIC_SCHEMA_VERSION) {
    return semanticFailure(prompt, 'unsupported_semantic_schema', 'Semantic contract schemaVersion is unsupported.', {
      phase: 'semantic_contract_validation',
      actualSchemaVersion: semanticContract.schemaVersion || null,
      expectedSchemaVersion: SEMANTIC_SCHEMA_VERSION
    }, 'SEMANTIC_SCHEMA_UNSUPPORTED');
  }
  if (!Object.values(SEMANTIC_STATUS).includes(semanticContract.status)) {
    return semanticFailure(prompt, 'invalid_semantic_status', 'Semantic contract status is missing or invalid.', {
      phase: 'semantic_lifecycle_validation',
      status: semanticContract.status || null
    }, 'SEMANTIC_STATUS_INVALID');
  }
  if (semanticContract.status === SEMANTIC_STATUS.AMBIGUOUS) {
    return semanticFailure(prompt, 'semantic_ambiguous', 'Required query semantics are ambiguous.', {
      phase: 'semantic_lifecycle_validation',
      ambiguities: Array.isArray(semanticContract.ambiguities)
        ? semanticContract.ambiguities
        : []
    }, semanticContract.reasonCode || 'SEMANTIC_AMBIGUOUS');
  }
  if (semanticContract.status === SEMANTIC_STATUS.UNRESOLVED) {
    return semanticFailure(prompt, 'semantic_unresolved', 'Required query semantics are unresolved.', {
      phase: 'semantic_lifecycle_validation',
      unresolvedSlots: Array.isArray(semanticContract.unresolvedSlots)
        ? semanticContract.unresolvedSlots
        : []
    }, semanticContract.reasonCode || 'SEMANTIC_UNRESOLVED');
  }
  if (semanticContract.status === SEMANTIC_STATUS.UNSUPPORTED) {
    return semanticFailure(prompt, 'semantic_unsupported', 'The fully understood query semantics are unsupported.', {
      phase: 'semantic_lifecycle_validation',
      operation: semanticContract.operation || null
    }, semanticContract.reasonCode || 'SEMANTIC_UNSUPPORTED');
  }
  if (semanticContract.operation === 'rank_top') {
    return resolveRankTopContract(semanticContract, context);
  }
  if (semanticContract.operation === 'average') {
    return resolveMetricSeriesContract(semanticContract, context, 'averageValues');
  }
  if (semanticContract.operation === 'timeseries') {
    return resolveMetricSeriesContract(semanticContract, context, 'timeValues');
  }
  if (semanticContract.operation === 'metadata_list') {
    return resolveMetadataContract(semanticContract, context);
  }
  return failure(prompt, 'unsupported_prompt', 'Cannot construct resolvedQuery for this semantic operation.', {
    phase: 'semantic_operation_resolution',
    operation: semanticContract.operation || null
  }, 'SEMANTIC_OPERATION_UNSUPPORTED');
}

function resolvePrompt(prompt = '', options = {}) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return failure('', 'missing_prompt', 'Cannot construct resolvedQuery because prompt is empty.');
  }
  const workflow = WorkflowClassifierService.classifyWorkflow(normalizedPrompt);
  return resolveSemanticContract(workflow.semanticContract, {
    prompt: normalizedPrompt,
    nowSeconds: options.nowSeconds,
    workflowType: workflow.workflowType
  });
}

function resolveTopValuesPrompt(prompt = '', _spec = {}, options = {}) {
  const workflow = WorkflowClassifierService.classifyWorkflow(prompt);
  if (!['rank_top', 'rank_bottom'].includes(workflow.semanticContract?.operation)) return null;
  return resolveSemanticContract(workflow.semanticContract, {
    prompt,
    nowSeconds: options.nowSeconds,
    workflowType: workflow.workflowType
  });
}

function resolveMetadataPrompt(prompt = '') {
  const workflow = WorkflowClassifierService.classifyWorkflow(prompt);
  if (workflow.semanticContract?.operation !== 'metadata_list') return null;
  return resolveSemanticContract(workflow.semanticContract, {
    prompt,
    workflowType: workflow.workflowType
  });
}

module.exports = {
  SEMANTIC_SCHEMA_VERSION,
  resolveSemanticContract,
  resolvePrompt,
  resolveMetadataPrompt,
  resolveTopValuesPrompt,
  inferTimeRange,
  buildLast1HourTimeRange,
  buildLast24HoursTimeRange,
  resolveTimeRange: TimeRangeService.resolveTimeRange,
  alignToMinute,
  normalizeResolvedQueryTimeRange,
  validateResolvedQueryTimeContract
};
