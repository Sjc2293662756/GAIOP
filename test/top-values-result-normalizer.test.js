'use strict';

const {
  normalizeTopValuesRows
} = require('../skills/openclaw-napm-query/services/TopValuesResultNormalizerService');

describe('TopValuesResultNormalizerService', () => {
  test('orders rows by topMetric descending and replaces untrusted ranks', () => {
    const rows = normalizeTopValuesRows([
      {
        rank: 1,
        group: { argument: 'low' },
        metricValues: [{ metric: { id: 'PGNPGE' }, value: 19 }]
      },
      {
        rank: 9,
        group: { argument: 'high' },
        metricValues: [{ metric: { id: 'PGNPGE' }, value: 838 }]
      }
    ], {
      topMetric: 'PGNPGE'
    });

    expect(rows.map((row) => [row.rank, row.group.argument])).toEqual([
      [1, 'high'],
      [2, 'low']
    ]);
  });

  test('does not locally reorder returned TopN rows to fake BottomN', () => {
    const rows = normalizeTopValuesRows([
      { group: { argument: 'missing' } },
      {
        group: { argument: 'blank' },
        metricValues: [{ metric: { id: 'TPIO' }, value: '   ' }]
      },
      { group: { argument: 'high' }, values: { TPIO: 200 } },
      { group: { argument: 'low' }, values: { TPIO: 20 } }
    ], {
      topMetric: 'TPIO',
      semanticConstraints: { direction: 'asc' }
    });

    expect(rows.map((row) => row.group.argument)).toEqual([
      'missing',
      'blank',
      'high',
      'low'
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
  });
});
