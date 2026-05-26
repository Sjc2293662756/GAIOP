const {
  classifyApplicationCatalogPrompt
} = require('./ApplicationCatalogSemanticRules');

/**
 * PromptRoutingService.js
 *
 * 负责在完整语义解析前，对明显可识别的问句做快速路由。
 * 主要覆盖概览问句、指标清单、业务对象清单和层级目录等场景，
 * 让系统可以直接生成 resolvedQuery 雏形或专用路由结果。
 */
function normalizePromptText(prompt = '') {
  return typeof prompt === 'string' ? prompt.trim() : '';
}

// 深拷贝简单 JSON 对象，避免路由物化时修改原始 route 定义。
function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function isOverviewPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return false;
  }

  const hasOverviewIntent = /(整体|总体|概览|总览|overall|overview|global|怎么样|情况|状态)/i.test(text);
  const hasNapmDomain = /(napm|netinside|系统|网络|应用|业务|web应用|网站|页面|流量|吞吐|时延|响应|异常|告警|丢包|重传|性能|监控)/i.test(text);
  return hasOverviewIntent && hasNapmDomain;
}

  // 从“对象层级/路径”类问句中提取目标对象类型。
function normalizeHierarchyQuestionTarget(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return null;
  }

  const aliasMap = [
    { pattern: /\bBusinessGroup\b|业务组|工作组|业务分组/i, value: 'BusinessGroup' },
    { pattern: /\bIPAddress\b|IP地址|客户端IP|服务端IP|\bIP\b/i, value: 'IPAddress' },
    { pattern: /\bPrefix24\b|\/24|24位前缀|子网|网段/i, value: 'Prefix24' },
    { pattern: /\bWebApplication\b|Web应用|web应用|网站|站点|业务系统/i, value: 'WebApplication' },
    { pattern: /\bCompositeApplication\b|复合协议|复合应用|多协议应用|组合应用/i, value: 'CompositeApplication' },
    { pattern: /\bDefinedApp\b|\bApplication\b|已知应用|协议应用|应用/i, value: 'DefinedApp' },
    { pattern: /\bOtherApp\b|其他应用/i, value: 'OtherApp' },
    { pattern: /\bBusinessGroupLink\b|业务组链路/i, value: 'BusinessGroupLink' },
    { pattern: /\bIPConversation\b|IP会话|会话/i, value: 'IPConversation' },
    { pattern: /\bInterface\b|接口/i, value: 'Interface' },
    { pattern: /\bVLAN\b/i, value: 'VLAN' },
    { pattern: /\bUser\b|用户/i, value: 'User' },
    { pattern: /\bPageFamily\b|页面族|页面分类/i, value: 'PageFamily' },
    { pattern: /\bISPAS\b|运营商AS/i, value: 'ISPAS' },
    { pattern: /\bDestAS\b|目的AS/i, value: 'DestAS' },
    { pattern: /\bMonInterfaceGroup\b|监控接口组/i, value: 'MonInterfaceGroup' },
    { pattern: /\bClientBusinessGroup\b|客户端业务组|初始组/i, value: 'ClientBusinessGroup' },
    { pattern: /\bTotalTraffic\b|整体流量|总流量/i, value: 'TotalTraffic' }
  ];

  const matched = aliasMap.find((item) => item.pattern.test(text));
  return matched ? matched.value : null;
}

// 判断是否是在询问对象下钻目录、层级结构或可达路径。
function isHierarchyCatalogPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return false;
  }

  const hierarchyIntent = /(下钻|钻取|层级|路径|往下钻到哪里|支持哪些|可达|目录|结构)/i.test(text);
  const topLevelCatalogIntent = /(顶层|全部对象|所有对象|有哪些对象|哪些对象|各自支持哪些|全量)/i.test(text);
  return hierarchyIntent && (topLevelCatalogIntent || Boolean(normalizeHierarchyQuestionTarget(text)));
}

function isMetricInventoryPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return false;
  }

  return /(?:(?:哪些|有什么|有哪[^，。！？\n]{0,8}|都有哪些)[^，。！？\n]{0,12}指标|指标[^，。！？\n]{0,12}(?:哪些|有什么|有哪[^，。！？\n]{0,8}|可查|能查|支持)|(?:可查|能查|支持)[^，。！？\n]{0,12}(?:哪些|有什么|有哪)[^，。！？\n]{0,6}指标)/i.test(text);
}

// 从“有哪些指标”类问句中推断指标清单应挂在哪个对象类型之下。
function inferMetricInventoryGroup(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text || !isMetricInventoryPrompt(text)) {
    return '';
  }

  if (/(ClientBusinessGroup|客户端业务组|初始组)/i.test(text)) return 'ClientBusinessGroup';
  if (/(BusinessGroup|业务组|工作组|业务分组)/i.test(text)) return 'BusinessGroup';
  if (/(PageFamily|页面族|页面分类)/i.test(text)) return 'PageFamily';
  if (/(^|[^A-Za-z])User([^A-Za-z]|$)|用户/.test(text)) return 'User';
  const classification = classifyApplicationCatalogPrompt(text);
  if (classification.objectType && classification.objectType !== 'BusinessGroup') {
    return classification.objectType;
  }
  if (/(DefinedApp|Application|已知应用|协议应用)/i.test(text)) return 'DefinedApp';
  if (/(WebApplication|Web应用|web应用|网站|站点|业务系统)/i.test(text)) return 'WebApplication';
  if (/业务/.test(text)) return 'WebApplication';
  return '';
}

// 判断是否是在查询业务对象清单，而不是指标清单或系统概览。
function isBusinessObjectInventoryPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return false;
  }

  if (/(BusinessGroup|业务组|工作组|业务分组)/i.test(text)) {
    return false;
  }

  const hasInventoryIntent = /(?:(?:系统中|现在|当前)?[^，。！？\n]{0,8}(?:有哪些|有什么|有哪几个|都有哪些|包含哪些)|列出[^，。！？\n]{0,8}|查看[^，。！？\n]{0,8})(?:业务|业务系统|Web应用|web应用|网站|站点)/i.test(text);
  if (!hasInventoryIntent) {
    return false;
  }

  if (isMetricInventoryPrompt(text) || isHierarchyCatalogPrompt(text) || isOverviewPrompt(text)) {
    return false;
  }

  return /(业务|业务系统|Web应用|web应用|网站|站点)/i.test(text);
}

function isPlainApplicationInventoryPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return false;
  }
  const hasInventoryIntent = /(?:(?:系统中|现在|当前)?[^，。！？\n]{0,8}(?:有哪些|有什么|有哪几个|都有哪些|包含哪些)|列出[^，。！？\n]{0,8}|查看[^，。！？\n]{0,8})(?:应用|Application)/i.test(text);
  if (!hasInventoryIntent) {
    return false;
  }
  return classifyApplicationCatalogPrompt(text).ambiguous === true;
}

// 推断概览类问句更偏向哪个业务场景。
function inferOverviewScene(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return 'system';
  }

  if (/(业务组|工作组|业务分组|business\s*group|businessgroup)/i.test(text)) {
    return 'business_group';
  }
  if (/(安全|风险|攻击|告警|security|attack|threat)/i.test(text)) {
    return 'security';
  }
  if (/(网络|链路|丢包|吞吐|带宽|时延|延迟|ip|network)/i.test(text)) {
    return 'network';
  }
  if (/(应用|app|服务|页面|站点|application)/i.test(text)) {
    return 'application';
  }
  if (/(业务|business|web应用|web\s*application|网站)/i.test(text)) {
    return 'business';
  }
  return 'system';
}

// 统一概览场景 key，兼容中英文和别名写法。
function normalizeOverviewSceneKey(scene = '') {
  const normalized = String(scene || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (
    normalized === 'business_group'
    || normalized === 'businessgroup'
    || normalized === '业务组'
    || normalized === '工作组'
    || normalized === '业务分组'
  ) {
    return 'business_group';
  }
  if (normalized === 'application' || normalized === 'app' || normalized === '应用') {
    return 'application';
  }
  if (normalized === 'business' || normalized === '业务') {
    return 'business';
  }
  if (normalized === 'network' || normalized === '网络') {
    return 'network';
  }
  if (normalized === 'security' || normalized === '安全') {
    return 'security';
  }
  if (normalized === 'system' || normalized === 'overall' || normalized === 'global' || normalized === '系统') {
    return 'system';
  }
  return normalized;
}

// 从问句中推断概览类路由所需的时间范围 key。
function inferOverviewTimeRangeKey(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return 'last24hours';
  }

  if (/(今天|今日)/.test(text)) return 'today';
  if (/(昨天|昨日)/.test(text)) return 'yesterday';
  if (/(最近\s*7天|近\s*7天|过去7天|最近七天|近七天|过去七天|last\s*7\s*days?)/i.test(text)) return 'last7days';
  if (/(最近\s*30天|近\s*30天|过去30天|最近三十天|近三十天|过去三十天|last\s*30\s*days?)/i.test(text)) return 'last30days';
  if (/(最近\s*1小时|近\s*1小时|过去1小时|最近一小时|近一小时|过去一小时|last\s*1\s*hour)/i.test(text)) return 'last1hour';
  if (/(最近\s*24小时|近\s*24小时|过去24小时|最近一天|近一天|过去一天|last\s*24\s*hours?)/i.test(text)) return 'last24hours';
  return 'last24hours';
}

// 构造“指标清单”快捷路由。
function buildMetricInventoryRoute(prompt = '') {
  const text = normalizePromptText(prompt);
  const groupType = inferMetricInventoryGroup(text);
  if (!groupType) {
    return null;
  }

  return {
    routeType: 'metric_inventory',
    prompt: text,
    timeRangeKey: inferOverviewTimeRangeKey(text),
    query: {
      service: 'metrics',
      queryModeKey: 'metadata',
      semanticConstraints: {
        operation: 'metadata_list',
        targetObjectType: groupType
      },
      groups: [{ type: groupType }],
      format: 'json',
      userRequirement: text
    }
  };
}

// 构造“业务对象清单”快捷路由。
function buildBusinessObjectInventoryRoute(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!isBusinessObjectInventoryPrompt(text)) {
    return null;
  }

  return {
    routeType: 'business_object_inventory',
    prompt: text,
    timeRangeKey: inferOverviewTimeRangeKey(text),
    query: {
      service: 'groups',
      queryModeKey: 'metadata',
      semanticConstraints: {
        operation: 'metadata_list',
        targetObjectType: 'WebApplication'
      },
      groups: [{ type: 'WebApplication' }],
      format: 'json',
      userRequirement: text
    }
  };
}

// 构造“系统/业务/网络概览”快捷路由。
function buildOverviewRoute(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!isOverviewPrompt(text)) {
    return null;
  }

  const scene = inferOverviewScene(text);
  return {
    routeType: 'overview',
    prompt: text,
    timeRangeKey: inferOverviewTimeRangeKey(text),
    query: {
      service: 'overview',
      queryModeKey: 'overview',
      overviewScene: scene,
      semanticConstraints: {
        operation: 'overview',
        overviewScene: scene
      },
      groups: [],
      format: 'json',
      userRequirement: text
    }
  };
}

/**
 * 主入口：根据问句特征挑选最合适的快捷路由。
 * 会按“指标清单 -> 业务对象清单 -> unknown port -> 层级目录 -> 概览”的顺序依次匹配。
 */
function resolvePromptRoute(prompt = '', options = {}) {
  const text = normalizePromptText(prompt);
  if (!text) {
    return null;
  }

  const includeHierarchy = Boolean(options.includeHierarchyCatalog);
  const includeUnknownPort = Boolean(options.includeUnknownPortTraffic);
  const unknownPortRouteBuilder = typeof options.buildUnknownPortRoute === 'function'
    ? options.buildUnknownPortRoute
    : null;
  const unknownPortDualProtocolRouteBuilder = typeof options.buildUnknownPortDualProtocolRoute === 'function'
    ? options.buildUnknownPortDualProtocolRoute
    : null;

  const metricInventoryRoute = buildMetricInventoryRoute(text);
  if (metricInventoryRoute) {
    return metricInventoryRoute;
  }

  const businessObjectInventoryRoute = buildBusinessObjectInventoryRoute(text);
  if (businessObjectInventoryRoute) {
    return businessObjectInventoryRoute;
  }

  if (isPlainApplicationInventoryPrompt(text)) {
    return {
      routeType: 'ambiguous_application_inventory',
      prompt: text,
      clarification: {
        reason: 'plain_application_inventory_is_ambiguous',
        candidates: ['WebApplication', 'DefinedApp', 'BuiltinApplication', 'CompositeApplication', 'OtherApp']
      }
    };
  }

  if (includeUnknownPort && unknownPortRouteBuilder) {
    const unknownPortRoute = unknownPortRouteBuilder(text);
    if (unknownPortRoute) {
      return unknownPortRoute;
    }
  }

  if (includeUnknownPort && unknownPortDualProtocolRouteBuilder) {
    const unknownPortDualProtocolRoute = unknownPortDualProtocolRouteBuilder(text);
    if (unknownPortDualProtocolRoute) {
      return unknownPortDualProtocolRoute;
    }
  }

  if (includeHierarchy && isHierarchyCatalogPrompt(text)) {
    return {
      routeType: 'hierarchy_catalog',
      prompt: text,
      timeRangeKey: null,
      query: {
        service: 'drilldownCatalog',
        userRequirement: text,
        groups: normalizeHierarchyQuestionTarget(text)
          ? [{ type: normalizeHierarchyQuestionTarget(text), argument: null }]
          : []
      }
    };
  }

  return buildOverviewRoute(text);
}

/**
 * 把快捷路由结果物化成可执行的 resolvedQuery 形态。
 * 这里会补时间范围，并允许外部继续做统一 shape 规范化。
 */
function materializePromptRouteResolvedQuery(route = null, options = {}) {
  if (!route || typeof route !== 'object' || !route.query) {
    return null;
  }

  const query = cloneJson(route.query) || {};
  const prompt = normalizePromptText(route.prompt || query.userRequirement || '');
  const resolveTimeRange = typeof options.resolveTimeRange === 'function'
    ? options.resolveTimeRange
    : null;
  const roundTimeValue = typeof options.roundTimeValue === 'function'
    ? options.roundTimeValue
    : ((value) => value);

  if (resolveTimeRange) {
    const range = resolveTimeRange(route.timeRangeKey || 'last24hours', prompt) || {};
    const start = Number(range.start);
    const end = Number(range.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      query.start = roundTimeValue(start);
      query.end = roundTimeValue(end);
    }
  }

  if (route.routeType === 'overview' && options.pluginStructuredOverview) {
    query.pluginStructuredOverview = true;
  }

  query.userRequirement = prompt;

  if (typeof options.normalizeResolvedQueryShape === 'function') {
    return options.normalizeResolvedQueryShape(query, prompt);
  }

  return query;
}

module.exports = {
  buildBusinessObjectInventoryRoute,
  buildMetricInventoryRoute,
  buildOverviewRoute,
  inferMetricInventoryGroup,
  inferOverviewScene,
  inferOverviewTimeRangeKey,
  isBusinessObjectInventoryPrompt,
  isPlainApplicationInventoryPrompt,
  isHierarchyCatalogPrompt,
  isMetricInventoryPrompt,
  isOverviewPrompt,
  resolvePromptRoute,
  materializePromptRouteResolvedQuery,
  normalizeHierarchyQuestionTarget,
  normalizeOverviewSceneKey,
  normalizePromptText
};
