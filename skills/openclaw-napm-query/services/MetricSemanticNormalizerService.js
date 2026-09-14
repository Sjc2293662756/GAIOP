'use strict';

const {
  getMetricSemanticRules,
  getMetricSpec
} = require('./ResolutionSpecService');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSource(ruleSet = {}) {
  return {
    type: 'resolution_spec_metric_semantic_rules',
    schemaVersion: ruleSet?.schemaVersion || null
  };
}

function getCatalog(options = {}) {
  return options.metricCatalog || getMetricSpec()?.catalog || {};
}

function getRuleSet(options = {}) {
  return options.metricSemanticRules || getMetricSemanticRules() || {};
}

function objectConstraintMatched(rule = {}, targetObjectType = '') {
  const constraints = Array.isArray(rule.objectConstraints) ? rule.objectConstraints : [];
  const target = normalizeText(targetObjectType);
  return Boolean(target && constraints.includes(target));
}

function collectPhraseMatches(text, rule, targetObjectType) {
  const source = text.toLowerCase();
  const matches = [];
  for (const phraseValue of Array.isArray(rule.phrases) ? rule.phrases : []) {
    const phrase = normalizeText(phraseValue);
    if (!phrase) continue;
    const needle = phrase.toLowerCase();
    let index = source.indexOf(needle);
    while (index >= 0) {
      matches.push({
        metricId: normalizeText(rule.metricId).toUpperCase(),
        ruleId: rule.id || null,
        matchedText: text.slice(index, index + phrase.length),
        index,
        length: phrase.length,
        explicit: false,
        specificity: Number(rule.specificity || phrase.length),
        objectConstraintMatched: objectConstraintMatched(rule, targetObjectType),
        priority: Number(rule.priority || 0),
        semanticDomain: normalizeText(rule.semanticDomain) || null
      });
      index = source.indexOf(needle, index + Math.max(needle.length, 1));
    }
  }
  return matches;
}

function collectPatternMatches(text, rule, targetObjectType) {
  const matches = [];
  for (const patternValue of Array.isArray(rule.patterns) ? rule.patterns : []) {
    const pattern = new RegExp(patternValue, 'gi');
    let match = pattern.exec(text);
    while (match) {
      matches.push({
        metricId: normalizeText(rule.metricId).toUpperCase(),
        ruleId: rule.id || null,
        matchedText: match[0],
        index: match.index,
        length: match[0].length,
        explicit: false,
        specificity: Number(rule.specificity || match[0].length),
        objectConstraintMatched: objectConstraintMatched(rule, targetObjectType),
        priority: Number(rule.priority || 0),
        semanticDomain: normalizeText(rule.semanticDomain) || null
      });
      match = pattern.exec(text);
    }
  }
  return matches;
}

function collectExplicitMetricMatches(text, catalog, enabled) {
  if (!enabled) return [];
  const matches = [];
  Object.keys(catalog || {}).forEach((metricId) => {
    const pattern = new RegExp(`\\b${escapeRegExp(metricId)}\\b`, 'gi');
    let match = pattern.exec(text);
    while (match) {
      matches.push({
        metricId,
        ruleId: 'explicit-metric-id',
        matchedText: match[0],
        index: match.index,
        length: match[0].length,
        explicit: true,
        specificity: Number.MAX_SAFE_INTEGER,
        objectConstraintMatched: false,
        priority: Number.MAX_SAFE_INTEGER
      });
      match = pattern.exec(text);
    }
  });
  return matches;
}

function overlaps(left, right) {
  return left.index < right.index + right.length && right.index < left.index + left.length;
}

function compareCandidate(left, right) {
  const dimensions = [
    Number(Boolean(left.explicit)) - Number(Boolean(right.explicit)),
    Number(left.specificity || left.length) - Number(right.specificity || right.length),
    Number(Boolean(left.objectConstraintMatched)) - Number(Boolean(right.objectConstraintMatched)),
    Number(left.priority || 0) - Number(right.priority || 0),
    Number(left.length || 0) - Number(right.length || 0)
  ];
  return dimensions.find((value) => value !== 0) || 0;
}

function selectCandidates(candidates = []) {
  const selected = [];
  const ambiguousGroups = [];
  const ordered = candidates.slice().sort((left, right) => (
    left.index - right.index || compareCandidate(right, left)
  ));

  for (const candidate of ordered) {
    const conflicting = selected.filter((item) => overlaps(item, candidate));
    if (conflicting.length === 0) {
      selected.push(candidate);
      continue;
    }
    const best = conflicting.slice().sort((left, right) => compareCandidate(right, left))[0];
    const comparison = compareCandidate(candidate, best);
    if (comparison > 0) {
      conflicting.forEach((item) => selected.splice(selected.indexOf(item), 1));
      selected.push(candidate);
    } else if (comparison === 0 && candidate.metricId !== best.metricId) {
      ambiguousGroups.push([best, candidate]);
    }
  }

  return { selected: selected.sort((left, right) => left.index - right.index), ambiguousGroups };
}

function resolveText(text, options, ruleSet, catalog) {
  const candidates = [
    ...collectExplicitMetricMatches(text, catalog, ruleSet.explicitMetricIdsFromCatalog !== false)
  ];
  for (const rule of Array.isArray(ruleSet.rules) ? ruleSet.rules : []) {
    candidates.push(...collectPhraseMatches(text, rule, options.targetObjectType));
    candidates.push(...collectPatternMatches(text, rule, options.targetObjectType));
  }
  return selectCandidates(candidates);
}

function uniqueMetrics(candidates = []) {
  return [...new Set(candidates.map((candidate) => candidate.metricId).filter(Boolean))];
}

function resolveMetricSemantic(prompt = '', options = {}) {
  const text = normalizeText(prompt);
  const ruleSet = getRuleSet(options);
  const catalog = getCatalog(options);
  const source = buildSource(ruleSet);
  if (!text) {
    return {
      status: 'unresolved',
      primaryMetric: null,
      requestedMetrics: [],
      rankingMetric: null,
      candidates: [],
      source
    };
  }

  const rankingMetricText = normalizeText(options.rankingMetricText);
  const rankingResolution = rankingMetricText
    ? resolveText(rankingMetricText, options, ruleSet, catalog)
    : { selected: [], ambiguousGroups: [] };
  const rankingMetricRange = options.rankingMetricRange;
  const hasValidRankingRange = rankingMetricText
    && Number.isInteger(rankingMetricRange?.start)
    && Number.isInteger(rankingMetricRange?.end)
    && rankingMetricRange.start >= 0
    && rankingMetricRange.end > rankingMetricRange.start
    && rankingMetricRange.end <= text.length;
  const requestedText = hasValidRankingRange
    ? `${text.slice(0, rankingMetricRange.start)}${' '.repeat(
      rankingMetricRange.end - rankingMetricRange.start
    )}${text.slice(rankingMetricRange.end)}`
    : (rankingMetricText ? text.replace(rankingMetricText, '') : text);
  const requestedResolution = resolveText(requestedText, options, ruleSet, catalog);
  const allAmbiguities = [
    ...requestedResolution.ambiguousGroups,
    ...rankingResolution.ambiguousGroups
  ];
  if (allAmbiguities.length > 0) {
    return {
      status: 'ambiguous',
      primaryMetric: null,
      requestedMetrics: [],
      rankingMetric: null,
      candidates: uniqueMetrics(allAmbiguities.flat()),
      source
    };
  }

  let requestedMetrics = uniqueMetrics(requestedResolution.selected);
  const rankingMetrics = uniqueMetrics(rankingResolution.selected);
  const rankingMetric = rankingMetrics.length === 1 ? rankingMetrics[0] : null;
  if (requestedMetrics.length === 0 && rankingMetric) {
    requestedMetrics = [rankingMetric];
  }
  if (requestedMetrics.length === 0) {
    return {
      status: 'unresolved',
      primaryMetric: null,
      requestedMetrics: [],
      rankingMetric,
      candidates: [],
      source
    };
  }

  const primaryMetric = requestedMetrics.length === 1 ? requestedMetrics[0] : null;
  const matchedCandidates = [...requestedResolution.selected, ...rankingResolution.selected];
  const primaryCatalogEntry = primaryMetric ? catalog[primaryMetric] : null;
  return {
    status: 'resolved',
    primaryMetric,
    requestedMetrics,
    rankingMetric,
    candidates: requestedMetrics.slice(),
    matchedRuleIds: [...new Set(matchedCandidates.map((item) => item.ruleId).filter(Boolean))],
    matches: matchedCandidates,
    source,
    confidence: 0.95,
    metric: primaryMetric,
    metrics: requestedMetrics.slice(),
    domain: matchedCandidates.find((item) => item.metricId === primaryMetric)?.semanticDomain
      || primaryCatalogEntry?.domain
      || null,
    canonicalIntent: primaryMetric,
    matchedAlias: matchedCandidates[0]?.matchedText || null
  };
}

function hasMetricSemantic(prompt = '', options = {}) {
  return resolveMetricSemantic(prompt, options).status !== 'unresolved';
}

function inferDomain(metric = '', options = {}) {
  return getCatalog(options)?.[normalizeText(metric).toUpperCase()]?.domain || 'unknown';
}

module.exports = {
  resolveMetricSemantic,
  hasMetricSemantic,
  inferDomain
};
