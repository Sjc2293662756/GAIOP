const QueryValidator = require('../skills/openclaw-napm-query/services/QueryValidator');

function makeQuery(start, end) {
  return {
    service: 'topValues',
    metric: 'BYTIO',
    topCount: 5,
    start,
    end
  };
}

describe('QueryValidator execution-time contract', () => {
  test.each([
    ['non-numeric strings', 'abc', 'xyz'],
    ['equal timestamps', 1785310980, 1785310980],
    ['negative timestamps', -120, -60],
    ['zero timestamp', 0, 60],
    ['fractional seconds', 1785310980.5, 1785314580],
    ['reverse range', 1785314580, 1785310980],
    ['non-minute-aligned range', 1785310981, 1785314580]
  ])('rejects %s', (_label, start, end) => {
    expect(() => QueryValidator.validate(makeQuery(start, end))).toThrow();
  });

  test('accepts positive minute-aligned Unix seconds with end greater than start', () => {
    expect(QueryValidator.validate(makeQuery(1785310980, 1785314580))).toMatchObject({
      start: 1785310980,
      end: 1785314580
    });
  });

  test('returns stable structured error details', () => {
    try {
      QueryValidator.validate(makeQuery('abc', 'xyz'));
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'QUERY_SHAPE_INVALID',
        details: {
          mode: 'query',
          service: 'topValues'
        }
      });
      expect(error.details.errors).toContain('Start and end timestamps must be positive integer Unix seconds');
    }
  });
});
