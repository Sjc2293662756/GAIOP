'use strict';

const { REFERENCE_ACTIONS } = require('../ReferenceSelectionParser');

const QUERY_RESULT_OBJECT_TYPES = new Set(['WebApplication', 'PageFamily']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class QueryContextResolver {
  getAdmissionCandidates({ resultSet = null } = {}) {
    if (!isPlainObject(resultSet) || !QUERY_RESULT_OBJECT_TYPES.has(resultSet.objectType)) {
      return [];
    }
    const artifactId = normalizeText(resultSet.resultSetId);
    if (!artifactId) return [];
    return [{
      domain: 'QUERY',
      artifactId,
      sourceTurnId: normalizeText(resultSet.sourceTurnId) || null,
      artifactType: 'authoritative_ranking_result',
      objectType: resultSet.objectType,
      supportedActions: [REFERENCE_ACTIONS.DETAIL],
      route: 'napm_candidate',
      queryRoute: 'NAPM_QUERY',
      expectedTool: 'napm-skill-query',
      updatedAt: Number(resultSet.updatedAt) || 0,
      workflow: resultSet.objectType === 'WebApplication'
        ? 'business_page_drilldown'
        : 'page_view_detail'
    }];
  }

  getQueryContextAdmissionCandidates({ queryContext = null } = {}) {
    const resolvedQuery = isPlainObject(queryContext?.resolvedQuery)
      ? queryContext.resolvedQuery
      : null;
    if (
      queryContext?.sourceTool !== 'napm-skill-query'
      || resolvedQuery?.service !== 'timeValues'
      || resolvedQuery?.queryModeKey !== 'timeseries'
    ) {
      return [];
    }
    return [{
      domain: 'QUERY',
      artifactId: `query-context:${normalizeText(queryContext.turnId) || 'unknown'}`,
      sourceTurnId: normalizeText(queryContext.turnId) || null,
      artifactType: 'authoritative_query_context',
      objectType: normalizeText(resolvedQuery.groups?.[resolvedQuery.groups.length - 1]?.type) || null,
      supportedActions: [REFERENCE_ACTIONS.MODIFY_TIME],
      route: 'napm_candidate',
      queryRoute: 'NAPM_QUERY',
      expectedTool: 'napm-skill-query',
      workflow: 'time_values_followup',
      updatedAt: Number(queryContext.updatedAt) || 0
    }];
  }

  buildContinuationQueryDraft(decision = {}) {
    if (
      decision?.reasonCode !== 'AUTHORITATIVE_RESULT_FOLLOWUP'
      || decision?.sourceDomain !== 'QUERY'
      || decision?.selection?.action !== REFERENCE_ACTIONS.DETAIL
    ) {
      return null;
    }

    const resultReference = {
      resultSetId: normalizeText(decision.sourceArtifactId),
      objectType: normalizeText(decision.sourceObjectType),
      ordinal: Number(decision.selection.ordinal)
    };
    if (
      !resultReference.resultSetId
      || !QUERY_RESULT_OBJECT_TYPES.has(resultReference.objectType)
      || !Number.isInteger(resultReference.ordinal)
      || resultReference.ordinal <= 0
    ) {
      return null;
    }

    if (resultReference.objectType === 'WebApplication') {
      return {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'PageFamily' }],
        metrics: ['PGNPGE'],
        metric: 'PGNPGE',
        topMetric: 'PGNPGE',
        topCount: 10,
        resultReference,
        semanticConstraints: {
          workflowType: 'metric_topn',
          operation: 'drilldown',
          drilldownRequested: true,
          targetObjectType: 'PageFamily'
        }
      };
    }

    const requestedLimit = Number(decision.selection.limit);
    return {
      service: 'pageViews',
      queryModeKey: 'detail',
      resultReference,
      maxLimit: Number.isInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : 20,
      semanticConstraints: {
        workflowType: 'page_view_detail',
        operation: 'detail_list',
        targetObjectType: 'PageView'
      }
    };
  }
}

module.exports = QueryContextResolver;
