'use strict';

const QueryValidator = require('../skills/openclaw-napm-query/services/QueryValidator');

describe('BUG-A Phase 3 QueryValidator canonical contract', () => {
  test('accepts canonical topValues without legacy metric and with independent topMetric', () => {
    expect(QueryValidator.validateGatewayRequest({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPI', 'TPO'],
      topMetric: 'TPIO',
      topCount: 10,
      start: 1788937200,
      end: 1788940800
    })).toMatchObject({
      schemaVersion: 'napm-resolved-query.v1',
      queryModeKey: 'topn',
      metrics: ['TPI', 'TPO'],
      topMetric: 'TPIO'
    });
  });

  test.each([
    ['averageValues', 'average', {}],
    ['timeValues', 'timeseries', { granularity: 300 }]
  ])('accepts canonical multi-metric %s', (service, queryModeKey, extra) => {
    expect(QueryValidator.validateGatewayRequest({
      schemaVersion: 'napm-resolved-query.v1',
      service,
      queryModeKey,
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNPGE', 'PGTME', 'PGHTTP500'],
      start: 1788937200,
      end: 1788940800,
      ...extra
    })).toMatchObject({
      service,
      metrics: ['PGNPGE', 'PGTME', 'PGHTTP500']
    });
  });

  test('reports the shared canonical reasonCode for a forbidden legacy metric', () => {
    expect(() => QueryValidator.validateGatewayRequest({
      schemaVersion: 'napm-resolved-query.v1',
      service: 'topValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      metric: 'TPIO',
      topCount: 10,
      start: 1788937200,
      end: 1788940800
    })).toThrow(expect.objectContaining({
      code: 'QUERY_SHAPE_INVALID',
      details: expect.objectContaining({ reasonCodes: ['METRIC_FORBIDDEN'] })
    }));
  });
});
