/**
 * MetricSemanticNormalizerService.js
 *
 * Centralizes natural-language metric semantics before resolvedQuery construction.
 * This keeps wording variants such as "400错误", "400报错", "HTTP400异常",
 * and "4xx" from becoming scattered regex patches in workflow or resolver code.
 */

function normalizeText(value = '') {
  return String(value || '').trim();
}

const METRIC_PATTERNS = [
  {
    metric: 'PGHTTP400',
    domain: 'http_status',
    canonicalIntent: 'http_400_count',
    patterns: [
      /(?:HTTP\s*)?400/i,
      /\b4xx\b/i,
      /400\s*(?:错误|报错|异常|失败|状态码|响应码)/i,
      /(?:错误|报错|异常|失败|状态码|响应码)[^，。！？\n]{0,12}400/i
    ]
  },
  {
    metric: 'PGHTTP500',
    domain: 'http_status',
    canonicalIntent: 'http_500_count',
    patterns: [
      /(?:HTTP\s*)?500/i,
      /\b5xx\b/i,
      /500\s*(?:错误|报错|异常|失败|状态码|响应码)/i,
      /(?:错误|报错|异常|失败|状态码|响应码)[^，。！？\n]{0,12}500/i
    ]
  },
  {
    metric: 'PLI',
    domain: 'packet_loss',
    canonicalIntent: 'packet_loss_in',
    patterns: [
      /丢包|丢包率|packet\s*loss|loss/i
    ]
  },
  {
    metric: 'TPIO',
    domain: 'throughput',
    canonicalIntent: 'throughput_total',
    patterns: [
      /吞吐|吞吐量|throughput|带宽/i
    ]
  },
  {
    metric: 'BYTIO',
    domain: 'traffic',
    canonicalIntent: 'traffic_total',
    patterns: [
      /流量|traffic|bytes?/i
    ]
  }
];

function resolveMetricSemantic(prompt = '', options = {}) {
  const text = normalizeText(prompt);
  if (!text) {
    return null;
  }

  const specMetricAliases = options.specMetricAliases || {};
  const aliasResult = resolveFromSpecAliases(text, specMetricAliases);
  if (aliasResult) {
    return aliasResult;
  }

  for (const entry of METRIC_PATTERNS) {
    const matchedPattern = entry.patterns.find((pattern) => pattern.test(text));
    if (matchedPattern) {
      return {
        metric: entry.metric,
        metrics: [entry.metric],
        domain: entry.domain,
        canonicalIntent: entry.canonicalIntent,
        matchedAlias: entry.canonicalIntent,
        source: 'metric_semantic_normalizer',
        confidence: 0.95
      };
    }
  }

  return null;
}

function hasMetricSemantic(prompt = '', options = {}) {
  return Boolean(resolveMetricSemantic(prompt, options));
}

function resolveFromSpecAliases(text = '', aliases = {}) {
  const source = normalizeText(text).toLowerCase();
  const entries = [];
  Object.entries(aliases || {}).forEach(([metric, aliasList]) => {
    entries.push({ metric, alias: metric });
    (Array.isArray(aliasList) ? aliasList : []).forEach((alias) => {
      entries.push({ metric, alias });
    });
  });

  entries.sort((left, right) => normalizeText(right.alias).length - normalizeText(left.alias).length);

  for (const entry of entries) {
    const alias = normalizeText(entry.alias);
    if (alias && source.includes(alias.toLowerCase())) {
      return {
        metric: entry.metric,
        metrics: [entry.metric],
        domain: inferDomain(entry.metric),
        canonicalIntent: entry.metric,
        matchedAlias: entry.alias,
        source: 'resolution_spec_alias',
        confidence: 0.9
      };
    }
  }

  return null;
}

function inferDomain(metric = '') {
  const id = normalizeText(metric).toUpperCase();
  if (id.startsWith('PGHTTP')) return 'http_status';
  if (['PLI', 'PLO'].includes(id)) return 'packet_loss';
  if (['TPIO', 'TPI', 'TPO'].includes(id)) return 'throughput';
  if (['BYTIO', 'BYTI', 'BYTO'].includes(id)) return 'traffic';
  return 'unknown';
}

module.exports = {
  resolveMetricSemantic,
  hasMetricSemantic,
  inferDomain
};
