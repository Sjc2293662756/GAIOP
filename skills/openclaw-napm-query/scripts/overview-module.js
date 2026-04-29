const DEFAULT_TOP_COUNT = 5;
const DEFAULT_GRANULARITY = 3600;
const DEFAULT_OVERVIEW_WINDOW_SECONDS = 24 * 60 * 60;

const OVERVIEW_SCENE_TEMPLATES = {
  system: [
    'topDefinedAppThroughput',
    'unknownTcpConnectionTop',
    'overallTrafficTrend',
    'systemAlertSummary',
    'topIpThroughput'
  ],
  business: [
    'topBusinessRealtime',
    'topBusinessVisits',
    'businessAlertSummary'
  ],
  application: [
    'applicationAlertSummary',
    'appDistributionTop',
    'topApplicationThroughput',
    'appAccessTrend',
    'appExperienceTrend',
    'appSessionTop',
    'appFailureTop'
  ],
  network: [
    'networkAlertSummary',
    'packetLossInboundTop',
    'packetLossOutboundTop',
    'overallTrafficTrend',
    'topIpThroughput',
    'topApplicationThroughput',
    'subnetDistributionTop',
    'businessNodeDistributionTop',
    'sessionDistributionTop'
  ],
  security: [
    'activeOutboundServer',
    'securityAlertSummary',
    'unknownTcpTop',
    'unknownUdpTop',
    'unknownTcpBytesTop',
    'unknownUdpBytesTop'
  ]
};

const OVERVIEW_API_TEMPLATES = {
  topIpThroughput: {
    key: 'topIpThroughput',
    mode: 'primary',
    type: 'topValues',
    groupType1: 'IPAddress',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5,
    children: ['ipThroughputTrend']
  },
  ipThroughputTrend: {
    key: 'ipThroughputTrend',
    mode: 'child',
    dependsOn: 'topIpThroughput',
    argumentFrom: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    type: 'timeValues',
    groupType1: 'IPAddress',
    metrics: ['TPIO'],
    granularity: 3600
  },
  topApplicationThroughput: {
    key: 'topApplicationThroughput',
    mode: 'primary',
    type: 'topValues',
    groupType1: 'DefinedApp',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5,
    children: ['appThroughputTrend']
  },
  appThroughputTrend: {
    key: 'appThroughputTrend',
    mode: 'child',
    dependsOn: 'topApplicationThroughput',
    argumentFrom: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    type: 'timeValues',
    groupType1: 'DefinedApp',
    metrics: ['TPIO'],
    granularity: 3600
  },
  topDefinedAppThroughput: {
    key: 'topDefinedAppThroughput',
    mode: 'primary',
    type: 'topValues',
    groupType1: 'DefinedApp',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5,
    children: ['appThroughputTrend']
  },
  unknownTcpConnectionTop: {
    key: 'unknownTcpConnectionTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'TotalTraffic',
    groupType2: 'IPProtocol',
    groupArgument2: 'TCP',
    groupType3: 'OtherApps',
    groupType4: 'OtherApp',
    metrics: ['CCNI'],
    topMetric: 'CCNI',
    topCount: 10
  },
  overallTrafficTrend: {
    key: 'overallTrafficTrend',
    mode: 'standalone',
    type: 'timeValues',
    groupType1: 'TotalTraffic',
    metrics: ['TPIO', 'TPO', 'TPI'],
    granularity: 3600
  },
  systemAlertSummary: {
    key: 'systemAlertSummary',
    mode: 'standalone',
    type: 'alertsSummary'
  },
  topBusinessRealtime: {
    key: 'topBusinessRealtime',
    mode: 'primary',
    type: 'topValues',
    groupType1: 'WebApplication',
    metrics: ['PGNPGE', 'PGNSLPGE', 'PGHTTP400', 'PGHTTP500'],
    topMetric: 'PGNPGE',
    topCount: 9,
    children: ['businessRealtimeTrend']
  },
  businessRealtimeTrend: {
    key: 'businessRealtimeTrend',
    mode: 'child',
    dependsOn: 'topBusinessRealtime',
    argumentFrom: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    type: 'timeValues',
    groupType1: 'WebApplication',
    metrics: ['PGNPGE'],
    granularity: 3600
  },
  topBusinessVisits: {
    key: 'topBusinessVisits',
    mode: 'primary',
    type: 'topValues',
    groupType1: 'WebApplication',
    metrics: ['PGHTTP200'],
    topMetric: 'PGHTTP200',
    topCount: 5,
    children: ['businessVisitTrend']
  },
  businessVisitTrend: {
    key: 'businessVisitTrend',
    mode: 'child',
    dependsOn: 'topBusinessVisits',
    argumentFrom: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    type: 'timeValues',
    groupType1: 'WebApplication',
    metrics: ['PGHTTP200'],
    granularity: 3600
  },
  businessAlertSummary: {
    key: 'businessAlertSummary',
    mode: 'standalone',
    type: 'alertsSummary'
  },
  applicationAlertSummary: {
    key: 'applicationAlertSummary',
    mode: 'standalone',
    type: 'alertsSummary'
  },
  appDistributionTop: {
    key: 'appDistributionTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'DefinedApp',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 8
  },
  appAccessTrend: {
    key: 'appAccessTrend',
    mode: 'standalone',
    type: 'timeValues',
    groupType1: 'DefinedApp',
    groupArgument1: 'HTTP',
    metrics: ['CONI', 'CCNI', 'RFCI'],
    granularity: 3600
  },
  appExperienceTrend: {
    key: 'appExperienceTrend',
    mode: 'standalone',
    type: 'timeValues',
    groupType1: 'DefinedApp',
    groupArgument1: 'HTTP',
    metrics: ['UEII', 'CSTI', 'TRTI', 'PTTO', 'RDTO'],
    granularity: 3600
  },
  appSessionTop: {
    key: 'appSessionTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'DefinedApp',
    groupArgument1: 'HTTP',
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5
  },
  appFailureTop: {
    key: 'appFailureTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'DefinedApp',
    metrics: ['RFCI'],
    topMetric: 'RFCI',
    topCount: 5
  },
  networkAlertSummary: {
    key: 'networkAlertSummary',
    mode: 'standalone',
    type: 'alertsSummary'
  },
  packetLossInboundTop: {
    key: 'packetLossInboundTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'IPAddress',
    metrics: ['PLI'],
    topMetric: 'PLI',
    topCount: 5
  },
  packetLossOutboundTop: {
    key: 'packetLossOutboundTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'IPAddress',
    metrics: ['PLO'],
    topMetric: 'PLO',
    topCount: 5
  },
  subnetDistributionTop: {
    key: 'subnetDistributionTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'Prefix24',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5
  },
  businessNodeDistributionTop: {
    key: 'businessNodeDistributionTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'BusinessGroup',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5
  },
  sessionDistributionTop: {
    key: 'sessionDistributionTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'IPConversation',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5
  },
  activeOutboundServer: {
    key: 'activeOutboundServer',
    mode: 'primary',
    type: 'topValues',
    groupType1: 'BusinessGroup',
    groupArgument1: 'Default-Internet',
    groupType2: 'MemberIPs',
    groupType3: 'IPAddress',
    metrics: ['CONO', 'RFCO', 'CCNO'],
    topMetric: 'CONO',
    topCount: 5,
    children: ['ipConnectionTrend']
  },
  ipConnectionTrend: {
    key: 'ipConnectionTrend',
    mode: 'child',
    dependsOn: 'activeOutboundServer',
    argumentFrom: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    type: 'timeValues',
    groupType1: 'IPAddress',
    metrics: ['CONO', 'RFCO', 'CCNO'],
    granularity: 3600
  },
  securityAlertSummary: {
    key: 'securityAlertSummary',
    mode: 'standalone',
    type: 'alertsSummary'
  },
  unknownTcpTop: {
    key: 'unknownTcpTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'TotalTraffic',
    groupType2: 'IPProtocol',
    groupArgument2: 'TCP',
    groupType3: 'OtherApps',
    groupType4: 'OtherApp',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5
  },
  unknownUdpTop: {
    key: 'unknownUdpTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'TotalTraffic',
    groupType2: 'IPProtocol',
    groupArgument2: 'UDP',
    groupType3: 'OtherApps',
    groupType4: 'OtherApp',
    metrics: ['TPIO'],
    topMetric: 'TPIO',
    topCount: 5
  },
  unknownTcpBytesTop: {
    key: 'unknownTcpBytesTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'TotalTraffic',
    groupType2: 'IPProtocol',
    groupArgument2: 'TCP',
    groupType3: 'OtherApps',
    groupType4: 'OtherApp',
    metrics: ['BYTIO'],
    topMetric: 'BYTIO',
    topCount: 7
  },
  unknownUdpBytesTop: {
    key: 'unknownUdpBytesTop',
    mode: 'standalone',
    type: 'topValues',
    groupType1: 'TotalTraffic',
    groupType2: 'IPProtocol',
    groupArgument2: 'UDP',
    groupType3: 'OtherApps',
    groupType4: 'OtherApp',
    metrics: ['BYTIO'],
    topMetric: 'BYTIO',
    topCount: 7
  }
};

const GROUP_TYPE_SCENE_MAP = {
  BusinessGroup: 'business',
  WebApplication: 'business',
  DefinedApp: 'application',
  Application: 'application',
  IPAddress: 'network',
  Prefix24: 'network',
  IPConversation: 'network',
  MemberIPs: 'security',
  TotalTraffic: 'system'
};

const SCENE_HINT_PATTERNS = [
  { scene: 'security', regex: /(安全|风险|告警|攻击|威胁|外连|security)/i },
  { scene: 'network', regex: /(网络|链路|丢包|吞吐|带宽|时延|地址|IP|network)/i },
  { scene: 'application', regex: /(应用|APP|服务|网页|网站|web|application)/i },
  { scene: 'business', regex: /(业务|业务组|业务系统|business)/i },
  { scene: 'system', regex: /(系统|整体|总览|概览|全局|overall|overview|global|system)/i }
];

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSceneKey(scene) {
  const key = normalizeText(scene);
  if (!key) return null;

  const map = {
    system: 'system',
    global: 'system',
    overall: 'system',
    business: 'business',
    app: 'application',
    application: 'application',
    network: 'network',
    security: 'security',
    '系统': 'system',
    '全局': 'system',
    '整体': 'system',
    '总览': 'system',
    '概览': 'system',
    '业务': 'business',
    '业务整体': 'business',
    '应用': 'application',
    '应用整体': 'application',
    '网络': 'network',
    '网络整体': 'network',
    '安全': 'security',
    '安全整体': 'security'
  };

  return map[key] || null;
}

function normalizeTimeRange(start, end) {
  const safeStart = toFiniteNumber(start);
  const safeEnd = toFiniteNumber(end);
  if (safeStart && safeEnd && safeEnd > safeStart) {
    return { start: safeStart, end: safeEnd };
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    start: now - DEFAULT_OVERVIEW_WINDOW_SECONDS,
    end: now
  };
}

function mapOverviewPlaybookToScene(playbook) {
  const key = normalizeText(playbook);
  if (!key) return null;
  if (key.includes('security')) return 'security';
  if (key.includes('network')) return 'network';
  if (key.includes('application')) return 'application';
  if (key.includes('business')) return 'business';
  if (key.includes('global') || key.includes('system')) return 'system';
  return null;
}

function detectSceneFromPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) {
    return null;
  }
  const hit = SCENE_HINT_PATTERNS.find((item) => item.regex.test(text));
  return hit ? hit.scene : null;
}

function mapResolvedQueryToScene(resolvedQuery) {
  const groups = Array.isArray(resolvedQuery?.groups) ? resolvedQuery.groups : [];
  for (const group of groups) {
    const type = String(group?.type || '').trim();
    if (GROUP_TYPE_SCENE_MAP[type]) {
      return GROUP_TYPE_SCENE_MAP[type];
    }
  }
  return null;
}

function resolveOverviewScene({ prompt, payload, intent, resolvedQuery }) {
  const byPayload = normalizeSceneKey(
    payload?.overviewScene
    || payload?.scene
    || payload?.semanticUnderstanding?.overviewScene
  );
  if (byPayload && OVERVIEW_SCENE_TEMPLATES[byPayload]) {
    return byPayload;
  }

  const byIntent = normalizeSceneKey(
    intent?.overviewScene
    || intent?.constraints?.overviewScene
  );
  if (byIntent && OVERVIEW_SCENE_TEMPLATES[byIntent]) {
    return byIntent;
  }

  const playbookScene = mapOverviewPlaybookToScene(
    payload?.semanticUnderstanding?.overviewPlaybook
    || payload?.overviewPlaybook
  );
  if (playbookScene) {
    return playbookScene;
  }

  const byPrompt = detectSceneFromPrompt(prompt);
  if (byPrompt) {
    return byPrompt;
  }

  const byResolvedQuery = mapResolvedQueryToScene(resolvedQuery);
  if (byResolvedQuery) {
    return byResolvedQuery;
  }

  return 'system';
}

function buildGroupsFromTemplate(template) {
  if (Array.isArray(template?.groups) && template.groups.length > 0) {
    return template.groups
      .filter((item) => item && item.type)
      .map((item) => (
        item.argument !== undefined && item.argument !== null
          ? { type: item.type, argument: item.argument }
          : { type: item.type }
      ));
  }

  const groups = [];
  for (let index = 1; index <= 6; index += 1) {
    const type = template?.[`groupType${index}`];
    if (!type) {
      continue;
    }
    const argument = template?.[`groupArgument${index}`];
    groups.push(
      argument !== undefined && argument !== null && String(argument).trim()
        ? { type, argument: String(argument).trim() }
        : { type }
    );
  }
  return groups;
}

function pickAnchorGroup(seedGroups = []) {
  return seedGroups.find((group) => group && group.type && group.argument) || null;
}

function applySeedAnchorIfNeeded(query, seedGroups = []) {
  const next = deepClone(query);
  const groups = Array.isArray(next?.groups) ? next.groups : [];
  if (groups.length === 0) {
    return next;
  }

  const anchorGroup = pickAnchorGroup(seedGroups);
  if (!anchorGroup) {
    return next;
  }

  const sameType = groups.find((group) => group?.type === anchorGroup.type);
  if (sameType && !sameType.argument) {
    sameType.argument = anchorGroup.argument;
  }
  return next;
}

function buildBaseQueryFromTemplate(template, range, seedGroups = []) {
  const type = String(template?.type || '').trim();
  const metrics = Array.isArray(template?.metrics)
    ? template.metrics.filter(Boolean)
    : (template?.metric ? [template.metric] : []);
  const metric = template?.metric || metrics[0] || null;

  const query = {
    service: type,
    start: range.start,
    end: range.end,
    format: 'json'
  };

  if (metrics.length > 0) {
    query.metrics = metrics;
  }
  if (metric) {
    query.metric = metric;
  }

  const groups = buildGroupsFromTemplate(template);
  if (groups.length > 0) {
    query.groups = groups;
  }

  if (type === 'topValues') {
    query.topMetric = template?.topMetric || metric;
    query.topCount = Number(template?.topCount) || DEFAULT_TOP_COUNT;
  }
  if (type === 'timeValues') {
    query.granularity = Number(template?.granularity) || DEFAULT_GRANULARITY;
  }

  return applySeedAnchorIfNeeded(query, seedGroups);
}

function applyArgumentByTargetParam(groups = [], targetParam, argumentValue) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return groups;
  }
  const value = String(argumentValue || '').trim();
  if (!value) {
    return groups;
  }

  const normalizedTarget = String(targetParam || '').trim();
  const match = normalizedTarget.match(/^groupArgument(\d+)$/i);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < groups.length) {
      groups[index].argument = value;
      return groups;
    }
  }

  groups[0].argument = value;
  return groups;
}

function isLikelyMetricKey(key, metricHints = []) {
  const normalized = String(key || '').trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (metricHints.map((item) => String(item || '').toUpperCase()).includes(normalized)) {
    return true;
  }
  return /^(TPIO|TPO|TPI|PLI|PLO|RTTI|TRTI|PGTME|PGNPGE|PGNSLPGE|PGHTTP\d+|CONI|CONO|CCNI|CCNO|RFCI|RFCO|BYTIO|UEII|CSTI|PTTO|RDTO)$/.test(normalized);
}

function looksLikeIp(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function pickBestGroupValue(row, targetGroupType, metricHints = []) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  if (row.object && String(row.object).trim()) {
    return String(row.object).trim();
  }
  if (row.group && String(row.group).trim()) {
    return String(row.group).trim();
  }

  const aliases = {
    IPAddress: ['ipaddress', 'ip', 'address', 'clientip', 'serverip', 'dstip', 'srcip', 'group'],
    DefinedApp: ['definedapp', 'application', 'app', 'name', 'group'],
    Application: ['application', 'app', 'name', 'group'],
    WebApplication: ['webapplication', 'website', 'webapp', 'application', 'name', 'group'],
    BusinessGroup: ['businessgroup', 'business', 'group', 'name'],
    IPConversation: ['ipconversation', 'conversation', 'session', 'group']
  };
  const targetAliases = aliases[targetGroupType] || ['group', 'name', 'object', 'label'];

  for (const key of Object.keys(row)) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!targetAliases.includes(normalizedKey)) {
      continue;
    }
    const value = String(row[key] || '').trim();
    if (value) {
      return value;
    }
  }

  if (targetGroupType === 'IPAddress') {
    for (const key of Object.keys(row)) {
      const value = String(row[key] || '').trim();
      if (looksLikeIp(value)) {
        return value;
      }
    }
  }

  for (const key of Object.keys(row)) {
    if (isLikelyMetricKey(key, metricHints)) {
      continue;
    }
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractTopGroupValues(rows, targetGroupType, metricHints = [], limit = DEFAULT_TOP_COUNT) {
  const values = [];
  const seen = new Set();
  const safeLimit = Number(limit) > 0 ? Number(limit) : DEFAULT_TOP_COUNT;
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = pickBestGroupValue(row, targetGroupType, metricHints);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
    if (values.length >= safeLimit) {
      break;
    }
  }
  return values;
}

function deriveSceneDefaultKey(scene) {
  if (!OVERVIEW_SCENE_TEMPLATES[scene] || OVERVIEW_SCENE_TEMPLATES[scene].length === 0) {
    return 'system';
  }
  return scene;
}

function buildOverviewQueries(scene, start, end) {
  const normalizedScene = deriveSceneDefaultKey(scene);
  const keys = OVERVIEW_SCENE_TEMPLATES[normalizedScene] || OVERVIEW_SCENE_TEMPLATES.system;
  return keys
    .map((key) => OVERVIEW_API_TEMPLATES[key])
    .filter(Boolean)
    .map((template) => ({
      key: template.key,
      mode: template.mode || 'standalone',
      params: {
        ...template,
        start,
        end
      },
      children: Array.isArray(template.children) ? template.children.slice() : []
    }));
}

function buildOverviewDisplayText(overview, stats = {}) {
  const lines = [
    '[OpenClaw overview execution completed]',
    `scene=${overview.scene}, time=${overview.start}~${overview.end}`,
    `queries: total=${stats.totalQueries || 0}, primary=${stats.primaryQueries || 0}, child=${stats.childQueries || 0}, standalone=${stats.standaloneQueries || 0}, success=${stats.successQueries || 0}, failed=${stats.failedQueries || 0}`
  ];

  const parentRows = Array.isArray(overview.queries) ? overview.queries : [];
  parentRows.forEach((item, index) => {
    const okText = item.ok ? 'ok' : 'failed';
    const rowCount = Number(item.rowCount || 0);
    lines.push(`${index + 1}. ${item.key} [${item.mode}/${item.service}] ${okText}, rows=${rowCount}`);

    if (Array.isArray(item.children) && item.children.length > 0) {
      const childExamples = item.children
        .slice(0, 3)
        .map((child) => `${child.key}(${child.argumentValue || '-'})`)
        .join(', ');
      lines.push(`   children=${item.children.length}${childExamples ? `, sample=${childExamples}` : ''}`);
    }
  });

  return lines.join('\n');
}

function buildOverviewSummary(overview, stats = {}) {
  return {
    mode: 'GO_OVERVIEW_QUERY',
    title: `Overview scene ${overview.scene} executed`,
    highlights: [
      `scene=${overview.scene}`,
      `queries=${stats.totalQueries || 0}`,
      `success=${stats.successQueries || 0}`,
      `failed=${stats.failedQueries || 0}`,
      `primary=${stats.primaryQueries || 0}`,
      `child=${stats.childQueries || 0}`,
      `standalone=${stats.standaloneQueries || 0}`
    ],
    overview,
    displayText: buildOverviewDisplayText(overview, stats)
  };
}

function buildChildArgumentTargetType(childTemplate, childQuery) {
  const targetParam = String(childTemplate?.argumentFrom?.targetParam || '').trim();
  const match = targetParam.match(/^groupArgument(\d+)$/i);
  if (match) {
    const index = Number(match[1]) - 1;
    const group = Array.isArray(childQuery?.groups) ? childQuery.groups[index] : null;
    return group?.type || null;
  }
  const firstGroup = Array.isArray(childQuery?.groups) ? childQuery.groups[0] : null;
  return firstGroup?.type || null;
}

async function executeOverviewModule(options = {}) {
  const executeGatewayRequest = options.executeGatewayRequest;
  if (typeof executeGatewayRequest !== 'function') {
    throw new Error('executeOverviewModule requires executeGatewayRequest function');
  }

  const prompt = options.prompt || '';
  const payload = options.payload || {};
  const intent = options.intent || {};
  const resolvedQuery = options.resolvedQuery || {};
  const seedGroups = Array.isArray(resolvedQuery?.groups) ? deepClone(resolvedQuery.groups) : [];
  const range = normalizeTimeRange(resolvedQuery?.start, resolvedQuery?.end);
  const scene = resolveOverviewScene({ prompt, payload, intent, resolvedQuery });
  const plannedQueries = buildOverviewQueries(scene, range.start, range.end);

  const overviewResult = {
    intent: 'overview',
    scene,
    start: range.start,
    end: range.end,
    queries: []
  };
  const warnings = [];
  const stats = {
    totalQueries: 0,
    primaryQueries: 0,
    childQueries: 0,
    standaloneQueries: 0,
    successQueries: 0,
    failedQueries: 0
  };

  for (const planItem of plannedQueries) {
    const template = OVERVIEW_API_TEMPLATES[planItem.key];
    if (!template) {
      continue;
    }

    const parentQuery = buildBaseQueryFromTemplate(template, range, seedGroups);
    stats.totalQueries += 1;
    if (planItem.mode === 'standalone') {
      stats.standaloneQueries += 1;
    } else if (planItem.mode === 'primary') {
      stats.primaryQueries += 1;
    }

    const parentResult = await executeGatewayRequest(parentQuery);
    const parentItem = {
      key: template.key,
      mode: planItem.mode,
      params: parentQuery,
      ok: Boolean(parentResult?.ok),
      service: parentResult?.service || parentQuery.service,
      requestUrl: parentResult?.requestUrl || null,
      rowCount: Array.isArray(parentResult?.data) ? parentResult.data.length : 0,
      error: parentResult?.error || null,
      children: []
    };

    if (parentItem.ok) {
      stats.successQueries += 1;
    } else {
      stats.failedQueries += 1;
      if (parentItem.error) {
        warnings.push(`overview query failed: ${template.key} (${parentItem.error.code || parentItem.error.message || 'unknown_error'})`);
      }
    }

    const children = Array.isArray(planItem.children) ? planItem.children : [];
    if (parentItem.ok && children.length > 0) {
      for (const childKey of children) {
        const childTemplate = OVERVIEW_API_TEMPLATES[childKey];
        if (!childTemplate) {
          continue;
        }

        const childQuerySeed = buildBaseQueryFromTemplate(childTemplate, range, seedGroups);
        const targetType = buildChildArgumentTargetType(childTemplate, childQuerySeed);
        const groupValues = extractTopGroupValues(
          parentResult?.data,
          targetType,
          parentQuery.metrics || [parentQuery.metric],
          parentQuery.topCount || DEFAULT_TOP_COUNT
        );

        if (groupValues.length === 0) {
          warnings.push(`overview child skipped: ${childTemplate.key} has no derived group values from ${template.key}`);
        }

        for (const groupValue of groupValues) {
          const childQuery = deepClone(childQuerySeed);
          applyArgumentByTargetParam(
            childQuery.groups,
            childTemplate?.argumentFrom?.targetParam || 'groupArgument1',
            groupValue
          );

          stats.totalQueries += 1;
          stats.childQueries += 1;
          const childResult = await executeGatewayRequest(childQuery);
          const childItem = {
            key: childTemplate.key,
            mode: 'child',
            parentKey: template.key,
            argumentValue: groupValue,
            params: childQuery,
            ok: Boolean(childResult?.ok),
            service: childResult?.service || childQuery.service,
            requestUrl: childResult?.requestUrl || null,
            rowCount: Array.isArray(childResult?.data) ? childResult.data.length : 0,
            error: childResult?.error || null
          };

          if (childItem.ok) {
            stats.successQueries += 1;
          } else {
            stats.failedQueries += 1;
            if (childItem.error) {
              warnings.push(`overview child query failed: ${childTemplate.key}(${groupValue})`);
            }
          }
          parentItem.children.push(childItem);
        }
      }
    }

    overviewResult.queries.push(parentItem);
  }

  const summary = buildOverviewSummary(overviewResult, stats);
  const ok = stats.successQueries > 0;
  return {
    ok,
    service: 'overview',
    data: overviewResult.queries,
    overview: overviewResult,
    summary,
    warnings,
    error: ok
      ? null
      : {
          code: 'OVERVIEW_ALL_QUERIES_FAILED',
          message: `Overview scene ${scene} failed: all planned queries failed`
        }
  };
}

module.exports = {
  OVERVIEW_SCENE_TEMPLATES,
  OVERVIEW_API_TEMPLATES,
  resolveOverviewScene,
  buildOverviewQueries,
  executeOverviewModule,
  __test__: {
    buildGroupsFromTemplate,
    buildBaseQueryFromTemplate,
    extractTopGroupValues,
    applyArgumentByTargetParam,
    normalizeTimeRange
  }
};
