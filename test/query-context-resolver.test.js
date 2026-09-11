'use strict';

const QueryContextResolver = require('../plugin/context-resolvers/QueryContextResolver');

function decision(sourceObjectType, selection = { action: 'DETAIL', ordinal: 1 }) {
  return {
    reasonCode: 'AUTHORITATIVE_RESULT_FOLLOWUP',
    sourceDomain: 'QUERY',
    sourceArtifactId: 'result-set-1',
    sourceObjectType,
    selection
  };
}

describe('QueryContextResolver', () => {
  const resolver = new QueryContextResolver({
    resolvedQuerySchemaVersion: 'napm-resolved-query.v1'
  });

  test.each(['WebApplication', 'PageFamily']) (
    'exposes a Query admission candidate for a %s ranking',
    (objectType) => {
      expect(resolver.getAdmissionCandidates({
        resultSet: { resultSetId: 'result-set-1', objectType }
      })).toEqual([expect.objectContaining({
        domain: 'QUERY',
        artifactId: 'result-set-1',
        objectType,
        supportedActions: ['DETAIL'],
        expectedTool: 'napm-skill-query'
      })]);
    }
  );

  test('exposes an authoritative timeValues context for time-range follow-ups', () => {
    expect(resolver.getQueryContextAdmissionCandidates({
      queryContext: {
        sourceTool: 'napm-skill-query',
        turnId: 'turn-trend-1',
        updatedAt: 123,
        resolvedQuery: {
          service: 'timeValues',
          queryModeKey: 'timeseries',
          groups: [{ type: 'TotalTraffic' }],
          metrics: ['TPIO']
        }
      }
    })).toEqual([expect.objectContaining({
      domain: 'QUERY',
      artifactId: 'query-context:turn-trend-1',
      artifactType: 'authoritative_query_context',
      supportedActions: ['MODIFY_TIME'],
      expectedTool: 'napm-skill-query',
      workflow: 'time_values_followup',
      updatedAt: 123
    })]);
  });

  test('does not expose non-timeseries query context as a time follow-up source', () => {
    expect(resolver.getQueryContextAdmissionCandidates({
      queryContext: {
        sourceTool: 'napm-skill-query',
        resolvedQuery: { service: 'topValues', queryModeKey: 'topn' }
      }
    })).toEqual([]);
  });

  test('maps a selected business to an authoritative PageFamily drilldown draft', () => {
    expect(resolver.buildContinuationQueryDraft(decision('WebApplication'))).toEqual({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      queryModeKey: 'topn',
      groups: [{ type: 'PageFamily' }],
      metrics: ['PGNPGE'],
      topMetric: 'PGNPGE',
      topCount: 10,
      resultReference: {
        resultSetId: 'result-set-1',
        objectType: 'WebApplication',
        ordinal: 1
      },
      semanticConstraints: {
        workflowType: 'metric_topn',
        operation: 'drilldown',
        drilldownRequested: true,
        targetObjectType: 'PageFamily'
      }
    });
  });

  test('maps a selected page family to pageViews and preserves the requested limit', () => {
    expect(resolver.buildContinuationQueryDraft(decision('PageFamily', {
      action: 'DETAIL',
      ordinal: 2,
      limit: 20
    }))).toMatchObject({
      service: 'pageViews',
      queryModeKey: 'detail',
      maxLimit: 20,
      resultReference: {
        resultSetId: 'result-set-1',
        objectType: 'PageFamily',
        ordinal: 2
      }
    });
  });

  test('defaults pageViews to 20 rows and rejects untrusted decisions', () => {
    expect(resolver.buildContinuationQueryDraft(decision('PageFamily'))).toMatchObject({
      service: 'pageViews',
      maxLimit: 20
    });
    expect(resolver.buildContinuationQueryDraft({
      ...decision('PageFamily'),
      reasonCode: 'BASE_TURN_POLICY'
    })).toBeNull();
  });
});
