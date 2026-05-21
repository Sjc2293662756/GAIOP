const {
  loadResolutionSpec
} = require('./ResolutionSpecService');

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

function includesAny(text = '', patterns = []) {
  const source = normalizeLower(text);
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    const token = normalizeLower(pattern);
    return token && source.includes(token);
  });
}

function flattenAliasEntries(aliasMap = {}) {
  const entries = [];
  Object.entries(aliasMap || {}).forEach(([id, aliases]) => {
    entries.push({ id, alias: id });
    (Array.isArray(aliases) ? aliases : []).forEach((alias) => {
      entries.push({ id, alias });
    });
  });
  return entries;
}

function findAliasMatch(text = '', aliasMap = {}, options = {}) {
  const source = normalizeLower(text);
  const preferredIds = Array.isArray(options.preferredIds) ? options.preferredIds : [];
  const entries = flattenAliasEntries(aliasMap)
    .filter((entry) => normalizeText(entry.alias))
    .sort((left, right) => {
      const leftPreferred = preferredIds.includes(left.id) ? 1 : 0;
      const rightPreferred = preferredIds.includes(right.id) ? 1 : 0;
      if (leftPreferred !== rightPreferred) {
        return rightPreferred - leftPreferred;
      }
      return normalizeText(right.alias).length - normalizeText(left.alias).length;
    });

  for (const entry of entries) {
    const alias = normalizeLower(entry.alias);
    if (alias && source.includes(alias)) {
      return {
        id: entry.id,
        alias: entry.alias
      };
    }
  }

  return null;
}

function buildLast24HoursTimeRange(nowSeconds = Math.floor(Date.now() / 1000)) {
  const end = Number(nowSeconds) > 0 ? Math.floor(Number(nowSeconds)) : Math.floor(Date.now() / 1000);
  return {
    key: 'last24hours',
    start: end - 24 * 60 * 60,
    end
  };
}

function inferTopCount(prompt = '') {
  const text = normalizeText(prompt);
  const topMatch = text.match(/(?:top|前)\s*(\d{1,2})/i);
  if (topMatch) {
    const parsed = Number(topMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (/(谁|哪一个|哪个|最大|最高|最小|最低|最多|最少)/.test(text)) {
    return 1;
  }

  return 10;
}

function inferDirection(prompt = '') {
  if (includesAny(prompt, ['最小', '最低', '最少', '最低的', '最小的'])) {
    return 'asc';
  }
  return 'desc';
}

function inferMetric(prompt = '', spec = {}) {
  const match = findAliasMatch(prompt, spec?.metrics?.aliases || {});
  if (match) {
    return {
      metric: match.id,
      matchedAlias: match.alias
    };
  }

  return null;
}

function inferGroup(prompt = '', spec = {}, options = {}) {
  const text = normalizeText(prompt);
  const objectAliases = spec?.objects?.aliases || {};
  const preferredIds = [];

  if (/客户端\s*IP|client\s*ip/i.test(text)) {
    preferredIds.push('ClientIPs', 'IPAddress');
  }
  if (/IP地址|ip地址|\bip\b/i.test(text)) {
    preferredIds.push('IPAddress', 'ClientIPs');
  }
  if (/工作组|业务组|BusinessGroup/i.test(text)) {
    preferredIds.push('BusinessGroup');
  }
  if (/业务系统|Web应用|网站|站点|WebApplication/i.test(text)) {
    preferredIds.push('WebApplication');
  }

  const match = findAliasMatch(text, objectAliases, { preferredIds });
  if (match) {
    const mappedId = match.id === 'ClientIPs' && options.collapseClientIpToIpAddress !== false
      ? 'IPAddress'
      : match.id;
    return {
      group: mappedId,
      matchedAlias: match.alias,
      originalGroup: match.id
    };
  }

  if (options.defaultGroup) {
    return {
      group: options.defaultGroup,
      matchedAlias: null,
      originalGroup: options.defaultGroup
    };
  }

  return null;
}

function isMetadataListPrompt(prompt = '') {
  return includesAny(prompt, ['有哪些', '有什么', '列表', '清单', '对象列表', '都有哪些']);
}

function isMetricInventoryPrompt(prompt = '') {
  return includesAny(prompt, ['哪些指标', '什么指标', '可查哪些指标', '可以查哪些指标', '支持哪些指标', '指标列表']);
}

function isDrilldownCatalogPrompt(prompt = '') {
  return includesAny(prompt, ['下钻', '往下钻', '钻取', '层级', '路径', '结构', '目录', '可以到哪里']);
}

function isRankingPrompt(prompt = '') {
  return includesAny(prompt, [
    '最大',
    '最高',
    '最多',
    '最小',
    '最低',
    '最少',
    'top',
    'TopN',
    '排行',
    '排名',
    '是谁',
    '哪个',
    '哪一个'
  ]);
}

function buildDiagnostics(extra = {}) {
  return {
    resolver: 'NapmResolvedQueryResolverService',
    source: 'openclaw_mainflow_resolver',
    ...extra
  };
}

function success(prompt, intent, resolvedQuery, diagnostics = {}) {
  return {
    ok: true,
    source: 'openclaw_mainflow_resolver',
    intent,
    prompt: normalizeText(prompt),
    resolvedQuery,
    diagnostics: buildDiagnostics(diagnostics)
  };
}

function failure(prompt, reason, message, diagnostics = {}) {
  return {
    ok: false,
    source: 'openclaw_mainflow_resolver',
    prompt: normalizeText(prompt),
    reason,
    message,
    diagnostics: buildDiagnostics(diagnostics)
  };
}

function buildMetadataResolvedQuery(prompt, service, groupType, operation) {
  return {
    service,
    queryModeKey: 'metadata',
    groups: [{ type: groupType }],
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation
    },
    resolutionHints: {
      constructedBy: 'openclaw_mainflow_resolver'
    }
  };
}

function resolveMetadataPrompt(prompt = '', spec = {}) {
  const groupMatch = inferGroup(prompt, spec, { defaultGroup: 'WebApplication' });
  const groupType = groupMatch?.group || 'WebApplication';

  if (isDrilldownCatalogPrompt(prompt)) {
    return success(
      prompt,
      {
        category: 'metadata_query',
        service: 'drilldownCatalog',
        operation: 'metadata_list',
        groupType
      },
      {
        service: 'drilldownCatalog',
        queryModeKey: 'metadata',
        groups: [{ type: groupType }],
        format: 'json',
        userRequirement: normalizeText(prompt),
        semanticConstraints: {
          operation: 'drilldown_catalog'
        },
        resolutionHints: {
          constructedBy: 'openclaw_mainflow_resolver',
          matchedGroupAlias: groupMatch?.matchedAlias || null
        }
      },
      {
        matchedGroup: groupMatch || null
      }
    );
  }

  if (isMetricInventoryPrompt(prompt)) {
    return success(
      prompt,
      {
        category: 'metadata_query',
        service: 'metrics',
        operation: 'metadata_list',
        groupType
      },
      buildMetadataResolvedQuery(prompt, 'metrics', groupType, 'metadata_list'),
      {
        matchedGroup: groupMatch || null
      }
    );
  }

  if (isMetadataListPrompt(prompt)) {
    const explicitBusinessGroup = /工作组|业务组|BusinessGroup/i.test(prompt);
    const resolvedGroupType = explicitBusinessGroup ? 'BusinessGroup' : groupType;
    return success(
      prompt,
      {
        category: 'metadata_query',
        service: 'groups',
        operation: 'metadata_list',
        groupType: resolvedGroupType
      },
      buildMetadataResolvedQuery(prompt, 'groups', resolvedGroupType, 'metadata_list'),
      {
        matchedGroup: groupMatch || null
      }
    );
  }

  return null;
}

function resolveTopValuesPrompt(prompt = '', spec = {}, options = {}) {
  if (!isRankingPrompt(prompt)) {
    return null;
  }

  const metricMatch = inferMetric(prompt, spec);
  if (!metricMatch) {
    return failure(
      prompt,
      'missing_metric',
      'Cannot construct resolvedQuery because no NAPM metric was identified.',
      { phase: 'metric_resolution' }
    );
  }

  const groupMatch = inferGroup(prompt, spec, { defaultGroup: 'IPAddress' });
  const groupType = groupMatch?.group || 'IPAddress';
  const nowSeconds = options.nowSeconds || Math.floor(Date.now() / 1000);
  const timeRange = buildLast24HoursTimeRange(nowSeconds);
  const direction = inferDirection(prompt);
  const topCount = inferTopCount(prompt);

  const resolvedQuery = {
    service: 'topValues',
    queryModeKey: 'topn',
    metric: metricMatch.metric,
    metrics: [metricMatch.metric],
    topMetric: metricMatch.metric,
    groups: [{ type: groupType }],
    topCount,
    start: timeRange.start,
    end: timeRange.end,
    timeRange: {
      key: timeRange.key
    },
    format: 'json',
    userRequirement: normalizeText(prompt),
    semanticConstraints: {
      operation: direction === 'asc' ? 'rank_bottom' : 'rank_top',
      direction
    },
    resolutionHints: {
      constructedBy: 'openclaw_mainflow_resolver',
      matchedMetricAlias: metricMatch.matchedAlias || null,
      matchedGroupAlias: groupMatch?.matchedAlias || null
    }
  };

  return success(
    prompt,
    {
      category: 'data_query',
      service: 'topValues',
      operation: resolvedQuery.semanticConstraints.operation,
      metric: metricMatch.metric,
      groupType,
      topCount
    },
    resolvedQuery,
    {
      matchedMetric: metricMatch,
      matchedGroup: groupMatch || null,
      timeRange
    }
  );
}

function resolvePrompt(prompt = '', options = {}) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return failure('', 'missing_prompt', 'Cannot construct resolvedQuery because prompt is empty.');
  }

  const spec = options.spec ? cloneJson(options.spec) : loadResolutionSpec();
  const metadataResult = resolveMetadataPrompt(normalizedPrompt, spec);
  if (metadataResult) {
    return metadataResult;
  }

  const topValuesResult = resolveTopValuesPrompt(normalizedPrompt, spec, options);
  if (topValuesResult) {
    return topValuesResult;
  }

  return failure(
    normalizedPrompt,
    'unsupported_prompt',
    'Cannot construct resolvedQuery for this prompt with the current spec-driven resolver.',
    {
      phase: 'intent_resolution',
      supportedServices: Object.keys(spec?.services || {})
    }
  );
}

module.exports = {
  resolvePrompt,
  resolveMetadataPrompt,
  resolveTopValuesPrompt,
  inferMetric,
  inferGroup,
  inferTopCount,
  inferDirection,
  buildLast24HoursTimeRange
};
