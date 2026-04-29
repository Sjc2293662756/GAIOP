class MetricResolveService {
  clone(value) {
    return value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  }

  resolve(input = {}) {
    const metricDisambiguation = input.metricDisambiguation || null;
    const resolvedQuery = input.resolvedQuery || null;
    const metrics = Array.isArray(resolvedQuery?.metrics)
      ? resolvedQuery.metrics.slice()
      : (resolvedQuery?.metric ? [resolvedQuery.metric] : []);

    return {
      version: 'v1',
      stage: 'metric_resolve',
      status: metricDisambiguation ? 'resolved' : 'unavailable',
      selected_metric: resolvedQuery?.metric || metrics[0] || null,
      metrics,
      metric_domain: metricDisambiguation?.metricDomain || resolvedQuery?.metricDomain || null,
      primary_metrics: this.clone(metricDisambiguation?.primaryMetrics || resolvedQuery?.primaryMetrics || []),
      aux_metrics: this.clone(metricDisambiguation?.auxMetrics || resolvedQuery?.auxMetrics || []),
      metric_domain_candidates: this.clone(metricDisambiguation?.metricDomainCandidates || []),
      suggestions: this.clone(metricDisambiguation?.suggestions || []),
      corrections: this.clone(metricDisambiguation?.corrections || []),
      warnings: this.clone(metricDisambiguation?.warnings || []),
      evidence: this.clone(metricDisambiguation?.evidence || null)
    };
  }
}

module.exports = new MetricResolveService();
