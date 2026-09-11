'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TagNormalizer = require('../skills/openclaw-napm-query/services/TagNormalizer');

const SERVICE_ROOT = path.resolve(__dirname, '../skills/openclaw-napm-query/services');

describe('BUG-A Phase 2 production semantic reachability', () => {
  test('TagNormalizer compatibility facade cannot construct a resolvedQuery', () => {
    const result = TagNormalizer.mapTagsToResolvedQuery({
      metricIntent: '页面响应时间',
      objectScope: '业务',
      queryShape: '排行'
    }, '页面响应时间最高的前5个业务');

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'TAG_MAPPER_DEPRECATED',
      needsConstruction: true
    });
    expect(result.resolvedQuery).toBeUndefined();
  });

  test('resolver and classifier sources contain no private production ranking or metric inference', () => {
    const resolverSource = fs.readFileSync(
      path.join(SERVICE_ROOT, 'NapmResolvedQueryResolverService.js'),
      'utf8'
    );
    const workflowSource = fs.readFileSync(
      path.join(SERVICE_ROOT, 'WorkflowClassifierService.js'),
      'utf8'
    );

    expect(resolverSource).not.toMatch(/function\s+(?:inferMetric|isRankingPrompt|inferTopCount|inferDirection)\b/);
    expect(workflowSource).not.toMatch(/function\s+hasRankingIntent\b/);
  });
});
