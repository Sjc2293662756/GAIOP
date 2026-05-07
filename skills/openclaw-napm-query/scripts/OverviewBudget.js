const DEPTH_LEVELS = {
  fast: 1,
  standard: 2,
  deep: 3
};

const OVERVIEW_BUDGETS = {
  fast: {
    depth: 'fast',
    maxQueries: 3,
    maxChildren: 0,
    timeoutMs: 8000,
    maxRetriesPerQuery: 0
  },
  standard: {
    depth: 'standard',
    maxQueries: 5,
    maxChildren: 2,
    timeoutMs: 15000,
    maxRetriesPerQuery: 0
  },
  deep: {
    depth: 'deep',
    maxQueries: 8,
    maxChildren: 4,
    timeoutMs: 30000,
    maxRetriesPerQuery: 1
  }
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDepthKey(value) {
  const key = normalizeText(value);
  if (!key) {
    return null;
  }

  const map = {
    fast: 'fast',
    quick: 'fast',
    brief: 'fast',
    standard: 'standard',
    normal: 'standard',
    default: 'standard',
    deep: 'deep',
    detailed: 'deep',
    detail: 'deep',
    full: 'deep',
    comprehensive: 'deep',
    快速: 'fast',
    简要: 'fast',
    速览: 'fast',
    标准: 'standard',
    默认: 'standard',
    深入: 'deep',
    详细: 'deep',
    全面: 'deep'
  };

  return map[key] || null;
}

function resolveOverviewDepth({ prompt, payload, intent, resolvedQuery } = {}) {
  const fromPayload = normalizeDepthKey(
    payload?.overviewDepth
    || payload?.depth
    || payload?.semanticUnderstanding?.overviewDepth
  );
  if (fromPayload) {
    return fromPayload;
  }

  const fromIntent = normalizeDepthKey(
    intent?.overviewDepth
    || intent?.constraints?.overviewDepth
  );
  if (fromIntent) {
    return fromIntent;
  }

  const fromQuery = normalizeDepthKey(
    resolvedQuery?.overviewDepth
    || resolvedQuery?.semanticConstraints?.overviewDepth
  );
  if (fromQuery) {
    return fromQuery;
  }

  const text = String(prompt || '').trim();
  if (/(快速|简要|速览|quick|brief|fast)/i.test(text)) {
    return 'fast';
  }
  if (/(深入|详细|全面|deep|detailed|full|comprehensive)/i.test(text)) {
    return 'deep';
  }
  return 'standard';
}

function getOverviewBudget(depth = 'standard') {
  const normalizedDepth = normalizeDepthKey(depth) || 'standard';
  return {
    ...OVERVIEW_BUDGETS[normalizedDepth]
  };
}

module.exports = {
  DEPTH_LEVELS,
  OVERVIEW_BUDGETS,
  resolveOverviewDepth,
  getOverviewBudget
};
