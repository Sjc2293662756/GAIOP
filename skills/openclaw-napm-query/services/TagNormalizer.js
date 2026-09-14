'use strict';

/**
 * Deprecated compatibility facade for legacy LLM tags.
 *
 * Phase 2 deliberately removes this module's authority to choose a metric or
 * construct resolvedQuery. Production callers must use WorkflowClassifierService
 * and NapmResolvedQueryResolverService instead.
 */

const METRIC_NORMALIZE = [
  ['丢包', 'packet_loss'], ['掉包', 'packet_loss'],
  ['报错', 'http_error'], ['错误', 'http_error'],
  ['流量', 'traffic'], ['吞吐', 'traffic'],
  ['延迟', 'latency'], ['响应时间', 'latency'],
  ['页面延时', 'page_latency'], ['页面响应', 'page_latency'],
  ['页面访问', 'page_visits'], ['访问量', 'page_visits'],
  ['慢页面', 'slow_page']
];

const OBJECT_NORMALIZE = [
  ['IP地址', 'IPAddress'], ['IP', 'IPAddress'],
  ['业务系统', 'WebApplication'], ['业务', 'WebApplication'],
  ['业务组', 'BusinessGroup'], ['工作组', 'BusinessGroup'],
  ['已定义应用', 'DefinedApp'], ['应用', 'DefinedApp']
];

const SHAPE_NORMALIZE = [
  ['排行', 'ranking'], ['排名', 'ranking'],
  ['均值', 'average'], ['平均', 'average'],
  ['趋势', 'trend'], ['走势', 'trend'],
  ['清单', 'inventory'], ['列表', 'inventory']
];

function fuzzyMatch(text, table) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return null;
  for (const [key, value] of table) {
    if (normalized === key.toLowerCase()) return value;
  }
  for (const [key, value] of table) {
    if (normalized.includes(key.toLowerCase())) return value;
  }
  return null;
}

function normalizeTags(tags = {}) {
  return {
    metricKey: fuzzyMatch(tags.metricIntent, METRIC_NORMALIZE),
    objectType: fuzzyMatch(tags.objectScope, OBJECT_NORMALIZE),
    shape: fuzzyMatch(tags.queryShape, SHAPE_NORMALIZE),
    timeKey: null,
    size: null,
    authority: 'compatibility_labels_only'
  };
}

function mapTagsToResolvedQuery(tags = {}) {
  return {
    ok: false,
    reason: 'TagNormalizer no longer constructs production queries.',
    reasonCode: 'TAG_MAPPER_DEPRECATED',
    needsConstruction: true,
    semanticCandidates: normalizeTags(tags)
  };
}

module.exports = {
  normalizeTags,
  mapTagsToResolvedQuery,
  fuzzyMatch
};
