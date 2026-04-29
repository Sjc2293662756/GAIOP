const fs = require('fs');
const path = require('path');

const DimensionMappingService = require('./DimensionMappingService');

class MetricSemanticDisambiguationService {
  constructor() {
    const configPath = path.join(__dirname, '../../../config/metric-semantic-disambiguation.v1.json');
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const domainConfigPath = path.join(__dirname, '../../../config/metric-domains.v1.json');
    try {
      this.metricDomainsConfig = JSON.parse(fs.readFileSync(domainConfigPath, 'utf8'));
    } catch (error) {
      this.metricDomainsConfig = {};
    }
  }

  async disambiguate(query, originalText = '') {
    const resolvedQuery = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];
    const text = this.buildTextContext(originalText);
    const currentMetric = resolvedQuery?.metric || (Array.isArray(resolvedQuery?.metrics) ? resolvedQuery.metrics[0] : null);
    const currentGroupType = resolvedQuery?.groups?.[0]?.type || null;

    const candidates = this.config.metrics
      .map(item => this.scoreMetric(item, text, resolvedQuery, currentMetric, currentGroupType))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0] || null;
    const current = candidates.find(item => item.metric === currentMetric) || null;
    const lead = best && current ? Number((best.score - current.score).toFixed(2)) : null;
    const defaultMetricOverride = Boolean(
      best &&
      currentMetric === 'TPIO' &&
      best.metric !== currentMetric &&
      best.aliasHits > 0 &&
      best.score >= this.config.thresholds.suggest &&
      (current ? best.score - current.score >= this.config.thresholds.minimumLead : true)
    );
    const shouldApply = Boolean(
      best &&
      (best.score >= this.config.thresholds.autoApply || defaultMetricOverride) &&
      best.metric !== currentMetric &&
      (current ? best.score - current.score >= this.config.thresholds.minimumLead : true)
    );

    if (shouldApply) {
      const beforeMetric = currentMetric;
      resolvedQuery.metric = best.metric;
      resolvedQuery.metrics = [best.metric];
      corrections.push({
        field: 'metric',
        action: 'disambiguate_metric_semantics',
        from: beforeMetric,
        to: best.metric,
        evidence: defaultMetricOverride
          ? best.reasons.concat('default_metric_override')
          : best.reasons
      });
    } else if (!resolvedQuery.metric && best) {
      resolvedQuery.metric = best.metric;
      resolvedQuery.metrics = [best.metric];
      corrections.push({
        field: 'metric',
        action: 'fill_metric_from_semantic_disambiguation',
        to: best.metric,
        evidence: best.reasons
      });
    }

    const metricPackCorrection = this.applyWebHttpMetricPack(resolvedQuery, text, currentGroupType);
    if (metricPackCorrection) {
      corrections.push(metricPackCorrection);
    }

    const trafficNormalization = this.applyTrafficThroughputNormalization(resolvedQuery, text);
    if (trafficNormalization) {
      corrections.push(trafficNormalization);
    }

    const finalMetric = resolvedQuery?.metric || (Array.isArray(resolvedQuery?.metrics) ? resolvedQuery.metrics[0] : null);
    const metricDomainCandidates = this.buildMetricDomainCandidates(candidates, finalMetric);
    const selectedMetricDomain = metricDomainCandidates[0]?.domain || null;
    const metricBundle = this.buildMetricBundle({
      resolvedQuery,
      selectedMetricDomain,
      candidates
    });
    resolvedQuery.metricDomain = selectedMetricDomain;
    resolvedQuery.primaryMetrics = metricBundle.primaryMetrics;
    resolvedQuery.auxMetrics = metricBundle.auxMetrics;

    return {
      query: resolvedQuery,
      warnings,
      corrections,
      shouldApply,
      candidates,
      metricDomain: selectedMetricDomain,
      primaryMetrics: metricBundle.primaryMetrics,
      auxMetrics: metricBundle.auxMetrics,
      metricDomainCandidates,
      suggestions: candidates
        .filter(item => item !== best && item.score >= this.config.thresholds.suggest)
        .slice(0, this.config.maxSuggestions),
      evidence: {
        currentMetric,
        currentGroupType,
        selectedCandidate: best,
        lead,
        metricDomain: selectedMetricDomain
      }
    };
  }

  applyWebHttpMetricPack(query, text, currentGroupType) {
    const webScopedGroups = new Set(['WebApplication', 'BusinessGroup', 'ClientIPs']);
    const hasWebHint = /web|网站|站点|web应用/i.test(text.raw);
    if (!webScopedGroups.has(currentGroupType) && !hasWebHint) {
      return null;
    }

    const hasHttp = /http/i.test(text.raw);
    const genericErrorRate = /(?:http\s*)?错误率|error rate/i.test(text.raw);
    const specificHttpClass = /(400|500|4xx|5xx|200|300|100)/i.test(text.raw);

    if (hasHttp && genericErrorRate && !specificHttpClass) {
      const before = {
        metric: query.metric,
        metrics: query.metrics
      };
      query.metric = 'PGHTTP500PCT';
      query.metrics = ['PGHTTP400PCT', 'PGHTTP500PCT'];
      return {
        field: 'metrics',
        action: 'expand_generic_http_error_rate_to_metric_pack',
        from: before,
        to: {
          metric: query.metric,
          metrics: query.metrics
        },
        evidence: ['http_term', 'generic_error_rate_term', `group:${currentGroupType}`]
      };
    }

    return null;
  }

  applyTrafficThroughputNormalization(query, text) {
    const currentMetric = query?.metric || (Array.isArray(query?.metrics) ? query.metrics[0] : null);
    const networkUsageMetrics = new Set(['BYTIO', 'BYTI', 'BYTO', 'TPIO', 'TPI', 'TPO']);
    if (!networkUsageMetrics.has(currentMetric)) {
      return null;
    }

    if (!/流量|总流量|traffic/i.test(text.raw)) {
      return null;
    }

    if (/字节|byte|bytes|byte traffic/i.test(text.raw)) {
      return null;
    }

    let targetMetric = 'TPIO';
    if (/流入|入站|入方向|上行/i.test(text.raw)) {
      targetMetric = 'TPI';
    } else if (/流出|出站|出方向|下行/i.test(text.raw)) {
      targetMetric = 'TPO';
    }

    if (currentMetric === targetMetric) {
      return null;
    }

    const before = {
      metric: query.metric,
      metrics: query.metrics
    };
    query.metric = targetMetric;
    query.metrics = [targetMetric];
    return {
      field: 'metric',
      action: 'normalize_generic_traffic_to_throughput',
      from: before,
      to: {
        metric: query.metric,
        metrics: query.metrics
      },
      evidence: ['generic_traffic_term', 'default_to_throughput']
    };
  }

  scoreMetric(metricConfig, text, query, currentMetric, currentGroupType) {
    const reasons = [];
    let score = 0;
    const genericTrafficThroughput = this.isGenericTrafficThroughputIntent(text);

    const aliasHits = this.countAliasHits(metricConfig.aliases, text);
    if (aliasHits > 0) {
      score += aliasHits * metricConfig.weights.aliasHit;
      reasons.push(`alias_hits:${aliasHits}`);
    }

    if (currentMetric === metricConfig.id) {
      score += metricConfig.weights.currentBias || 0;
      reasons.push('current_metric_bias');
    }

    const serviceBonus = this.config.serviceBonuses[query?.service] || 0;
    if (serviceBonus > 0) {
      score += serviceBonus * (metricConfig.weights.serviceFit || 1);
      reasons.push(`service_fit:${query?.service}`);
    }

    if (currentGroupType && metricConfig.preferredObjects.includes(currentGroupType)) {
      score += 0.16;
      reasons.push(`preferred_for_group:${currentGroupType}`);
    }

    const compatibleObjects = DimensionMappingService.getObjectsForMetric(metricConfig.id, {
      onlySupportedByCurrentSkill: true
    });
    if (currentGroupType && compatibleObjects.includes(currentGroupType)) {
      score += 0.08;
      reasons.push(`compatible_with_group:${currentGroupType}`);
    }

    const objectHintHits = this.countObjectHintHits(metricConfig.preferredObjects, text);
    if (objectHintHits > 0) {
      score += Math.min(objectHintHits * 0.08, 0.16);
      reasons.push(`object_hint_hits:${objectHintHits}`);
    }

    if (genericTrafficThroughput && metricConfig.id === 'TPIO') {
      score += 0.2;
      reasons.push('generic_traffic_prefers_throughput');
    }

    if (genericTrafficThroughput && metricConfig.id === 'BYTIO') {
      score -= 0.18;
      reasons.push('generic_traffic_penalizes_bytes');
    }

    return {
      metric: metricConfig.id,
      score: Number(Math.min(score, 0.99).toFixed(2)),
      aliasHits,
      reasons,
      domain: metricConfig.domain,
      preferredObjects: metricConfig.preferredObjects
    };
  }

  countAliasHits(aliases = [], text) {
    return aliases.reduce((count, alias) => (
      text.lower.includes(String(alias).toLowerCase()) ? count + 1 : count
    ), 0);
  }

  countObjectHintHits(objects = [], text) {
    let hits = 0;
    for (const objectType of objects) {
      const hints = this.config.objectHints[objectType] || [];
      if (hints.some(hint => text.lower.includes(String(hint).toLowerCase()))) {
        hits += 1;
      }
    }
    return hits;
  }

  buildTextContext(originalText) {
    const raw = String(originalText || '').trim();
    const normalized = raw.replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    return { raw, normalized, lower };
  }

  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }

  isGenericTrafficThroughputIntent(text) {
    const raw = String(text?.raw || '');
    if (!/流量|总流量|traffic/i.test(raw)) {
      return false;
    }

    if (/字节|byte|bytes|byte traffic/i.test(raw)) {
      return false;
    }

    return true;
  }

  buildMetricDomainCandidates(candidates = [], selectedMetric = null) {
    const domainMap = new Map();

    candidates.forEach((candidate) => {
      const key = candidate.domain || 'generic_metric';
      const existing = domainMap.get(key) || {
        domain: key,
        score: 0,
        primaryMetrics: [],
        supportingMetrics: []
      };
      existing.score = Number((existing.score + candidate.score).toFixed(2));
      if (!existing.supportingMetrics.includes(candidate.metric)) {
        existing.supportingMetrics.push(candidate.metric);
      }
      if (candidate.metric === selectedMetric && !existing.primaryMetrics.includes(candidate.metric)) {
        existing.primaryMetrics.unshift(candidate.metric);
      } else if (!existing.primaryMetrics.includes(candidate.metric) && candidate.score >= this.config.thresholds.suggest) {
        existing.primaryMetrics.push(candidate.metric);
      }
      domainMap.set(key, existing);
    });

    if (selectedMetric) {
      const selectedDomain = (candidates.find(item => item.metric === selectedMetric)?.domain) || 'generic_metric';
      const current = domainMap.get(selectedDomain) || {
        domain: selectedDomain,
        score: 0.6,
        primaryMetrics: [],
        supportingMetrics: []
      };
      if (!current.primaryMetrics.includes(selectedMetric)) {
        current.primaryMetrics.unshift(selectedMetric);
      }
      if (!current.supportingMetrics.includes(selectedMetric)) {
        current.supportingMetrics.unshift(selectedMetric);
      }
      current.score = Math.max(current.score, 0.6);
      domainMap.set(selectedDomain, current);
    }

    return Array.from(domainMap.values())
      .map(item => ({
        ...item,
        primaryMetrics: item.primaryMetrics.slice(0, 3),
        supportingMetrics: item.supportingMetrics.slice(0, 6)
      }))
      .sort((a, b) => b.score - a.score);
  }

  buildMetricBundle({ resolvedQuery, selectedMetricDomain, candidates = [] }) {
    const configuredDomain = this.metricDomainsConfig?.[selectedMetricDomain || ''] || null;
    if (configuredDomain) {
      return {
        primaryMetrics: Array.isArray(configuredDomain.primaryMetrics) ? configuredDomain.primaryMetrics : [],
        auxMetrics: Array.isArray(configuredDomain.auxMetrics) ? configuredDomain.auxMetrics : []
      };
    }

    const explicitMetrics = Array.isArray(resolvedQuery?.metrics) ? resolvedQuery.metrics.filter(Boolean) : [];
    const primaryMetric = resolvedQuery?.metric || explicitMetrics[0] || null;
    const sameDomainCandidates = candidates
      .filter(item => (item.domain || 'generic_metric') === (selectedMetricDomain || 'generic_metric'))
      .sort((a, b) => b.score - a.score);

    const primaryMetrics = Array.from(new Set([
      ...explicitMetrics,
      primaryMetric
    ].filter(Boolean)));

    if (primaryMetrics.length === 0 && sameDomainCandidates[0]?.metric) {
      primaryMetrics.push(sameDomainCandidates[0].metric);
    }

    const auxMetrics = sameDomainCandidates
      .map(item => item.metric)
      .filter(metric => metric && !primaryMetrics.includes(metric))
      .slice(0, 5);

    return {
      primaryMetrics,
      auxMetrics
    };
  }
}

module.exports = new MetricSemanticDisambiguationService();
