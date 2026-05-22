const TRUTH_DOMAINS = Object.freeze({
  HIERARCHY: 'hierarchy',
  OBJECT_INSTANCES: 'object_instances',
  METRIC_COMPATIBILITY: 'metric_compatibility',
  SEMANTIC_POLICY: 'semantic_policy'
});

const SOURCES = Object.freeze({
  STATIC_GROUPS_TREE: 'groups_tree_static',
  LIVE_GROUPS_TREE: 'groups_tree_live',
  SOUTHBOUND_LIVE_API: 'southbound_live_api',
  LOCAL_SEMANTIC_CONFIG: 'local_semantic_config'
});

const DOMAIN_SOURCE_POLICY = Object.freeze({
  [TRUTH_DOMAINS.HIERARCHY]: Object.freeze([
    SOURCES.STATIC_GROUPS_TREE,
    SOURCES.LIVE_GROUPS_TREE
  ]),
  [TRUTH_DOMAINS.OBJECT_INSTANCES]: Object.freeze([
    SOURCES.SOUTHBOUND_LIVE_API
  ]),
  [TRUTH_DOMAINS.METRIC_COMPATIBILITY]: Object.freeze([
    SOURCES.SOUTHBOUND_LIVE_API
  ]),
  [TRUTH_DOMAINS.SEMANTIC_POLICY]: Object.freeze([
    SOURCES.LOCAL_SEMANTIC_CONFIG
  ])
});

function getAllowedSources(domain = '') {
  return DOMAIN_SOURCE_POLICY[domain] || Object.freeze([]);
}

function assertSourceAllowed(domain = '', source = '') {
  const allowedSources = getAllowedSources(domain);
  if (!allowedSources.includes(source)) {
    throw new Error(`Metadata source ${source || '<empty>'} is not allowed for truth domain ${domain || '<empty>'}`);
  }
  return true;
}

function buildTruthMetadata(domain = '', source = '', extra = {}) {
  assertSourceAllowed(domain, source);
  return {
    metadataTruthDomain: domain,
    source,
    fallbackUsed: false,
    ...extra
  };
}

module.exports = {
  TRUTH_DOMAINS,
  SOURCES,
  DOMAIN_SOURCE_POLICY,
  getAllowedSources,
  assertSourceAllowed,
  buildTruthMetadata
};
