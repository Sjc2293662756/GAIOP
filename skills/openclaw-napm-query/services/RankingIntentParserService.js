'use strict';

const { getRankingGrammar } = require('./ResolutionSpecService');
const { parseDurationAmount } = require('./ResolvedQueryTimeRangeService');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function compilePattern(pattern = '', flags = '') {
  const source = normalizeText(pattern);
  if (!source) return null;
  return new RegExp(source, flags || 'i');
}

function findPhrase(text = '', phrases = []) {
  const source = text.toLowerCase();
  return (Array.isArray(phrases) ? phrases : []).find((phrase) => (
    normalizeText(phrase) && source.includes(normalizeText(phrase).toLowerCase())
  )) || null;
}

function matchOperation(text, grammar) {
  const matches = (Array.isArray(grammar?.operationRules) ? grammar.operationRules : [])
    .filter((rule) => {
      if (findPhrase(text, rule.phrases)) return true;
      return (Array.isArray(rule.patterns) ? rule.patterns : []).some((pattern) => {
        const compiled = compilePattern(pattern, 'i');
        return compiled ? compiled.test(text) : false;
      });
    })
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  return matches[0] || null;
}

function matchExplicitCount(text, grammar) {
  for (const rule of Array.isArray(grammar?.countPatterns) ? grammar.countPatterns : []) {
    const pattern = compilePattern(rule.pattern, rule.flags || 'i');
    const match = pattern ? text.match(pattern) : null;
    const rawCount = match?.groups?.count || match?.[1];
    const parsed = parseDurationAmount(rawCount);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { topCount: parsed, ruleId: rule.id || null };
    }
  }
  return null;
}

function matchRankingMetricClause(text, grammar) {
  for (const rule of Array.isArray(grammar?.rankingMetricClausePatterns)
    ? grammar.rankingMetricClausePatterns
    : []) {
    const pattern = compilePattern(rule.pattern, rule.flags || 'i');
    const match = pattern ? text.match(pattern) : null;
    const metricText = normalizeText(match?.groups?.metricText || '');
    if (metricText) {
      const metricOffset = match[0].indexOf(metricText);
      const metricStart = Number(match.index) + Math.max(metricOffset, 0);
      return {
        ruleId: rule.id || null,
        metricText,
        matchedText: match[0],
        index: match.index,
        metricRange: {
          start: metricStart,
          end: metricStart + metricText.length
        }
      };
    }
  }
  return null;
}

function parseRankingIntent(prompt = '', options = {}) {
  const text = normalizeText(prompt);
  const grammar = options.grammar || getRankingGrammar();
  const source = {
    type: 'resolution_spec_ranking_grammar',
    schemaVersion: grammar?.schemaVersion || null
  };
  if (!text) {
    return { status: 'unresolved', operation: null, direction: null, topCount: null, source };
  }

  const operationRule = matchOperation(text, grammar);
  const explicitCount = matchExplicitCount(text, grammar);
  const weakCue = findPhrase(text, grammar?.weakCues);
  if (!operationRule && !explicitCount) {
    return {
      status: 'unresolved',
      operation: null,
      direction: null,
      topCount: null,
      matchedWeakCue: weakCue,
      source
    };
  }

  const singleCue = findPhrase(text, grammar?.singleResultCues);
  const defaultCount = Number(grammar?.defaults?.topCount);
  const topCount = explicitCount?.topCount
    || (singleCue ? 1 : (Number.isFinite(defaultCount) && defaultCount > 0 ? defaultCount : null));
  const operation = operationRule?.operation || 'rank_top';
  const direction = operationRule?.direction || 'desc';
  const matchedRuleIds = [operationRule?.id, explicitCount?.ruleId].filter(Boolean);

  return {
    status: 'resolved',
    operation,
    direction,
    topCount,
    countSource: explicitCount ? 'explicit' : (singleCue ? 'single_result' : 'default'),
    matchedRuleIds,
    rankingMetricClause: matchRankingMetricClause(text, grammar),
    source
  };
}

module.exports = {
  parseRankingIntent
};
