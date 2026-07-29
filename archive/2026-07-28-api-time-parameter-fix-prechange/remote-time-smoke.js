'use strict';

const resolver = require('/home/netinside/.openclaw/extensions/napm-openclaw-plugin/skills/openclaw-napm-query/src/shared/timeResolver');
const nowSeconds = 1779986457;
const expectedDurations = {
  last2hours: 7200,
  last8hours: 28800,
  last14days: 1209600
};

const ranges = Object.entries(expectedDurations).map(([key, duration]) => {
  const range = resolver.resolveExecutionTime({ timeRangeKey: key, nowSeconds });
  if (!range.ok || range.start % 60 !== 0 || range.end % 60 !== 0 || range.end - range.start !== duration) {
    throw new Error(`Invalid ${key} range: ${JSON.stringify(range)}`);
  }
  return range;
});

for (const key of ['today', 'yesterday']) {
  const range = resolver.resolveExecutionTime({ timeRangeKey: key, nowSeconds });
  if (!range.ok || range.start % 60 !== 0 || range.end % 60 !== 0) {
    throw new Error(`Invalid ${key} range: ${JSON.stringify(range)}`);
  }
  ranges.push(range);
}

const query = {
  service: 'topValues',
  start: 1779000001,
  end: 1779000301,
  timeRange: { key: 'last2hours' }
};
resolver.applyTimeOverride(query, nowSeconds * 1000);
if (query.start % 60 !== 0 || query.end % 60 !== 0 || query.end - query.start !== 7200) {
  throw new Error(`Query normalization failed: ${JSON.stringify(query)}`);
}

console.log(JSON.stringify({ ranges, query }));
