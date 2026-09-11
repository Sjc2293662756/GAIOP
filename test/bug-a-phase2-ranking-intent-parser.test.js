'use strict';

const RankingIntentParserService = require('../skills/openclaw-napm-query/services/RankingIntentParserService');

describe('BUG-A Phase 2 RankingIntentParserService', () => {
  test.each([
    ['前5个业务', 'rank_top', 'desc', 5, 'explicit'],
    ['前 5 个业务', 'rank_top', 'desc', 5, 'explicit'],
    ['Top5 IP', 'rank_top', 'desc', 5, 'explicit'],
    ['Top 10 IP', 'rank_top', 'desc', 10, 'explicit'],
    ['TopN IP', 'rank_top', 'desc', 10, 'default'],
    ['前 N 个 IP', 'rank_top', 'desc', 10, 'default'],
    ['最高的10个业务', 'rank_top', 'desc', 10, 'explicit'],
    ['最多的10个业务', 'rank_top', 'desc', 10, 'explicit'],
    ['最低的5个业务', 'rank_bottom', 'asc', 5, 'explicit'],
    ['最少的5个业务', 'rank_bottom', 'asc', 5, 'explicit']
  ])('parses ranking grammar from the canonical spec: %s', (
    prompt,
    operation,
    direction,
    topCount,
    countSource
  ) => {
    expect(RankingIntentParserService.parseRankingIntent(prompt)).toMatchObject({
      status: 'resolved',
      operation,
      direction,
      topCount,
      countSource,
      source: {
        type: 'resolution_spec_ranking_grammar'
      }
    });
  });

  test('uses the configured single-result count without a competing default', () => {
    expect(RankingIntentParserService.parseRankingIntent('丢包最高的是谁')).toMatchObject({
      status: 'resolved',
      operation: 'rank_top',
      direction: 'desc',
      topCount: 1,
      countSource: 'single_result'
    });
  });

  test('does not treat weak inventory wording as ranking by itself', () => {
    expect(RankingIntentParserService.parseRankingIntent('系统中有哪些业务')).toMatchObject({
      status: 'unresolved',
      operation: null,
      matchedWeakCue: '有哪些'
    });
  });
});
