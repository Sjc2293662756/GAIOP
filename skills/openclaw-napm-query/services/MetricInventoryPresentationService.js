const {
  getMetricCategoriesForObjectType
} = require('../src/constants/objectMetricOwnership');
const {
  getMetricCategoriesForMetric
} = require('../src/constants/metricDomains');

const OBJECT_LABELS = {
  WebApplication: '业务',
  BusinessGroup: '工作组',
  ClientBusinessGroup: '客户端业务组',
  DefinedApp: '应用',
  IPAddress: '网络',
  PageFamily: '页面族',
  User: '用户'
};

const BUSINESS_SECTION_ORDER = [
  '业务网络',
  '业务访问',
  '业务性能',
  '响应代码',
  '页面优化'
];

const OPERATIONS_SECTION_ORDER = [
  '流量/吞吐',
  '连接/TCP',
  '时延/响应',
  '可靠性',
  '体验'
];

const CATEGORY_TO_OPERATIONS_SECTION = {
  数据包: '流量/吞吐',
  网络流量: '流量/吞吐',
  传输效率: '流量/吞吐',
  网络连接: '连接/TCP',
  应用性能: '时延/响应',
  网络性能: '可靠性',
  应用访问: '可靠性',
  用户体验: '体验'
};

function members(definitions) {
  return definitions.map(([id, role]) => ({ id, role }));
}

// Metric IDs and their categories remain owned by the constants modules. This table
// only describes how related returned rows should be combined for human display.
const FAMILY_DEFINITIONS = [
  {
    key: 'business_traffic',
    title: '流量',
    section: '业务网络',
    categories: ['业务网络'],
    members: members([['PGBYTI', '请求'], ['PGBYTO', '页面']])
  },
  {
    key: 'business_size',
    title: '数据大小',
    section: '业务网络',
    categories: ['业务网络'],
    members: members([['PGSIZEI', '请求'], ['PGSIZEO', '页面']])
  },
  {
    key: 'page_visits',
    title: '页面访问',
    section: '业务访问',
    categories: ['业务访问'],
    members: members([
      ['PGNPGE', '访问数'],
      ['PGNPGC', '服务器访问数'],
      ['PGNPGS', '客户端访问数'],
      ['PGRT', '访问率']
    ])
  },
  {
    key: 'slow_pages',
    title: '慢页面',
    section: '业务性能',
    categories: ['业务性能'],
    members: members([
      ['PGNSLPGE', '数量'],
      ['PGNSLPGC', '服务器数量'],
      ['PGNSLPGS', '客户端数量'],
      ['PGSLPCT', '占比'],
      ['PGSLPCTC', '服务器占比'],
      ['PGSLPCTS', '客户端占比'],
      ['PGSLRT', '速率'],
      ['PGSLRTC', '服务器速率'],
      ['PGSLRTS', '客户端速率']
    ])
  },
  {
    key: 'page_latency',
    title: '页面延时',
    section: '业务性能',
    categories: ['业务性能'],
    members: members([
      ['PGTME', '综合'],
      ['PGTMC', '服务器'],
      ['PGTMS', '客户端']
    ])
  },
  {
    key: 'http_responses',
    title: 'HTTP 响应数',
    section: '响应代码',
    categories: ['响应代码'],
    members: members([['PGNOBJE', '']])
  },
  {
    key: 'http_status_counts',
    title: 'HTTP 状态码数量',
    section: '响应代码',
    categories: ['响应代码'],
    members: members([
      ['PGHTTP100', '100'],
      ['PGHTTP200', '200'],
      ['PGHTTP300', '300'],
      ['PGHTTP400', '400'],
      ['PGHTTP500', '500']
    ])
  },
  {
    key: 'http_status_ratios',
    title: 'HTTP 状态码占比',
    section: '响应代码',
    categories: ['响应代码'],
    members: members([
      ['PGHTTP100PCT', '100'],
      ['PGHTTP200PCT', '200'],
      ['PGHTTP300PCT', '300'],
      ['PGHTTP400PCT', '400'],
      ['PGHTTP500PCT', '500']
    ])
  },
  {
    key: 'page_optimization',
    title: '页面优化比例',
    section: '页面优化',
    categories: ['页面优化'],
    members: members([
      ['POPT', '优化页面'],
      ['ROPT', '优化响应'],
      ['PNOPT', '未优化'],
      ['PPOPT', '部分优化'],
      ['PFOPT', '完全优化']
    ])
  },
  {
    key: 'byte_traffic',
    title: '流量',
    section: '流量/吞吐',
    categories: ['网络流量'],
    members: members([['BYTI', '流入'], ['BYTO', '流出'], ['BYTIO', '双向']])
  },
  {
    key: 'throughput',
    title: '吞吐量',
    section: '流量/吞吐',
    categories: ['网络流量'],
    members: members([['TPI', '流入'], ['TPO', '流出'], ['TPIO', '双向']])
  },
  {
    key: 'goodput',
    title: '有效吞吐',
    section: '流量/吞吐',
    categories: ['传输效率'],
    members: members([['GPI', '流入'], ['GPO', '流出']])
  },
  {
    key: 'utilization',
    title: '利用率',
    section: '流量/吞吐',
    categories: ['传输效率'],
    members: members([['UTI', '流入'], ['UTO', '流出']])
  },
  {
    key: 'packet_volume',
    title: '包流量',
    section: '流量/吞吐',
    categories: ['数据包'],
    members: members([['PKI', '流入'], ['PKO', '流出'], ['PKIO', '双向']])
  },
  {
    key: 'packet_throughput',
    title: '包吞吐量',
    section: '流量/吞吐',
    categories: ['数据包'],
    members: members([['PKTI', '流入'], ['PKTO', '流出'], ['PKTIO', '双向']])
  },
  {
    key: 'packet_size',
    title: '数据包大小',
    section: '流量/吞吐',
    categories: ['数据包'],
    members: members([['PKZI', '流入'], ['PKZO', '流出']])
  },
  {
    key: 'payload_bytes',
    title: '净荷数据量',
    section: '流量/吞吐',
    categories: ['传输效率'],
    members: members([['FSI_B', '客户端'], ['FSO_B', '服务器']])
  },
  {
    key: 'payload_packets',
    title: '净荷包数量',
    section: '流量/吞吐',
    categories: ['传输效率'],
    members: members([['FSI_P', '客户端'], ['FSO_P', '服务器']])
  },
  {
    key: 'connection_requests',
    title: '连接请求数',
    section: '连接/TCP',
    categories: ['网络连接'],
    members: members([['CONI', '服务器'], ['CONO', '客户端']])
  },
  {
    key: 'connections',
    title: '连接数',
    section: '连接/TCP',
    categories: ['网络连接'],
    members: members([['CCNI', '服务器'], ['CCNO', '客户端']])
  },
  {
    key: 'connection_rate',
    title: '连接率',
    section: '连接/TCP',
    categories: ['网络连接'],
    members: members([['CRTI', '服务器'], ['CRTO', '客户端']])
  },
  {
    key: 'connection_request_rate',
    title: '连接请求率',
    section: '连接/TCP',
    categories: ['网络连接'],
    members: members([['FILI', '服务器'], ['FILO', '客户端']])
  },
  {
    key: 'connection_setup_time',
    title: '连接建立时间',
    section: '连接/TCP',
    categories: ['应用性能'],
    members: members([['CSTI', '服务器'], ['CSTO', '客户端']])
  },
  {
    key: 'connection_duration',
    title: '连接时长',
    section: '连接/TCP',
    categories: ['网络连接'],
    members: members([['CDI', '服务器'], ['CDO', '客户端']])
  },
  {
    key: 'connection_failures',
    title: '连接失败',
    section: '连接/TCP',
    categories: ['网络连接'],
    members: members([
      ['RFCI', '服务器数量'],
      ['RFCO', '客户端数量'],
      ['RFRI', '服务器失败率'],
      ['RFRO', '客户端失败率']
    ])
  },
  {
    key: 'round_trip_time',
    title: '往返时间 RTT',
    section: '时延/响应',
    categories: ['网络性能'],
    members: members([['RTTI', '流入'], ['RTTO', '流出']])
  },
  {
    key: 'server_response_time',
    title: '服务器响应时间',
    section: '时延/响应',
    categories: ['应用性能'],
    members: members([['TRTI', '服务器'], ['TRTO', '客户端']])
  },
  {
    key: 'initial_application_response',
    title: '初始应用响应时间',
    section: '时延/响应',
    categories: ['应用性能'],
    members: members([['ARTO', '服务器'], ['ARTI', '客户端']])
  },
  {
    key: 'time_to_first_byte',
    title: '第一字节时间',
    section: '时延/响应',
    categories: ['应用性能'],
    members: members([['T2FBO', '服务器'], ['T2FBI', '客户端']])
  },
  {
    key: 'retransmission_delay',
    title: '重传时延',
    section: '时延/响应',
    categories: ['网络性能'],
    members: members([['RDTI', '流入'], ['RDTO', '流出']])
  },
  {
    key: 'data_transfer_time',
    title: '数据传输时间',
    section: '时延/响应',
    categories: ['应用性能'],
    members: members([['NRTO', '服务器'], ['NRTI', '客户端']])
  },
  {
    key: 'payload_transfer_time',
    title: '净荷传输时间',
    section: '时延/响应',
    categories: ['应用性能'],
    members: members([['PTTO', '服务器'], ['PTTI', '客户端']])
  },
  {
    key: 'application_interactions',
    title: '交互',
    section: '时延/响应',
    categories: ['应用访问'],
    members: members([
      ['TRNI', '服务器数量'],
      ['TRNO', '客户端数量'],
      ['TRRI', '服务器交互率'],
      ['TRRO', '客户端交互率']
    ])
  },
  {
    key: 'packet_loss',
    title: '丢包情况',
    section: '可靠性',
    categories: ['网络性能'],
    members: members([['PLI', '流入'], ['PLO', '流出']])
  },
  {
    key: 'retransmission_rate',
    title: '重传',
    section: '可靠性',
    categories: ['网络性能'],
    members: members([
      ['RTXI', '流入重传率'],
      ['RTXO', '流出重传率'],
      ['RPKI', '流入包重传率'],
      ['RPKO', '流出包重传率']
    ])
  },
  {
    key: 'resets',
    title: '重置率',
    section: '可靠性',
    categories: ['应用访问'],
    members: members([
      ['RSTI', '客户端流入'],
      ['RSTO', '客户端流出'],
      ['RSTSI', '服务器流入'],
      ['RSTSO', '服务器流出']
    ])
  },
  {
    key: 'traceroute',
    title: '路由往返时间',
    section: '时延/响应',
    categories: ['网络性能'],
    members: members([
      ['TRTT', '路径'],
      ['TRTT1', 'ISP 网络'],
      ['TRTT2', 'ISP 对等点']
    ])
  },
  {
    key: 'user_experience',
    title: '用户体验时间',
    section: '体验',
    categories: ['用户体验'],
    members: members([['UEII', '服务器'], ['UEIO', '客户端']])
  }
];

const FAMILY_BY_METRIC_ID = new Map();
FAMILY_DEFINITIONS.forEach((family) => {
  family.members.forEach((member, memberIndex) => {
    FAMILY_BY_METRIC_ID.set(member.id, { family, member, memberIndex });
  });
});

function normalizeUnit(unit) {
  if (Array.isArray(unit)) {
    return unit.map((item) => String(item || '').trim()).filter(Boolean).join('/');
  }
  return String(unit || '').trim();
}

function normalizeRows(rows = []) {
  const seenIds = new Set();
  return (Array.isArray(rows) ? rows : []).reduce((result, row, index) => {
    const sourceId = String(row?.id || row?.metric || '').trim();
    const normalizedId = sourceId.toUpperCase();
    const dedupeKey = normalizedId || `__row_${index}`;
    if (seenIds.has(dedupeKey)) {
      return result;
    }
    seenIds.add(dedupeKey);
    result.push({
      source: row,
      id: sourceId,
      normalizedId,
      label: String(row?.label || row?.name || row?.description || sourceId || '').trim(),
      unit: normalizeUnit(row?.unit),
      sourceIndex: index,
      categories: getMetricCategoriesForMetric(normalizedId)
    });
    return result;
  }, []);
}

function resolveObjectType(payload = {}, explicitObjectType = '') {
  return String(
    explicitObjectType
    || payload?.metadata?.effectiveObjectType
    || payload?.metadata?.requestedObjectType
    || payload?.resolvedQuery?.groups?.[0]?.type
    || ''
  ).trim();
}

function resolveProfile(objectType, rows) {
  const objectCategories = getMetricCategoriesForObjectType(objectType);
  const rowCategories = rows.flatMap((row) => row.categories);
  const categories = new Set([...objectCategories, ...rowCategories]);
  const isBusiness = Array.from(categories).some((category) => (
    BUSINESS_SECTION_ORDER.includes(category)
  ));
  return isBusiness ? 'business' : 'operations';
}

function isFamilyCompatible(row, family) {
  if (row.categories.length === 0) {
    return false;
  }
  return family.categories.some((category) => row.categories.includes(category));
}

function resolveFallbackSection(row, profile) {
  if (profile === 'business') {
    return row.categories.find((category) => BUSINESS_SECTION_ORDER.includes(category)) || '其他指标';
  }
  for (const category of row.categories) {
    if (CATEGORY_TO_OPERATIONS_SECTION[category]) {
      return CATEGORY_TO_OPERATIONS_SECTION[category];
    }
  }
  return '其他指标';
}

function formatMember(memberRow, role, includeUnit) {
  const identity = [role, memberRow.id].filter(Boolean).join(' ');
  return includeUnit && memberRow.unit ? `${identity}，${memberRow.unit}` : identity;
}

function buildFamilyItem(family, memberRows) {
  const orderedRows = memberRows.slice().sort((left, right) => (
    left.memberIndex - right.memberIndex || left.row.sourceIndex - right.row.sourceIndex
  ));
  const units = Array.from(new Set(orderedRows.map(({ row }) => row.unit).filter(Boolean)));
  const canShareUnit = units.length === 1 && orderedRows.every(({ row }) => row.unit);
  const detail = orderedRows.map(({ row, member }) => (
    formatMember(row, member.role, !canShareUnit)
  )).join(canShareUnit ? ' / ' : '；');
  const unitText = canShareUnit ? `，${units[0]}` : '';
  return {
    key: family.key,
    title: family.title,
    metricIds: orderedRows.map(({ row }) => row.id),
    text: `${family.title}（${detail}${unitText}）`
  };
}

function buildStandaloneItem(row) {
  const detail = [row.id, row.unit].filter(Boolean).join('，');
  return {
    key: `standalone_${row.sourceIndex}`,
    title: row.label || row.id || '未命名指标',
    metricIds: row.id ? [row.id] : [],
    text: `${row.label || row.id || '未命名指标'}${detail ? `（${detail}）` : ''}`
  };
}

function buildSections(rows, profile) {
  const order = profile === 'business' ? BUSINESS_SECTION_ORDER : OPERATIONS_SECTION_ORDER;
  const familyGroups = new Map();
  const standaloneRows = [];

  rows.forEach((row) => {
    const familyMatch = FAMILY_BY_METRIC_ID.get(row.normalizedId);
    if (!familyMatch || !isFamilyCompatible(row, familyMatch.family)) {
      standaloneRows.push({ row, section: resolveFallbackSection(row, profile) });
      return;
    }
    const current = familyGroups.get(familyMatch.family.key) || {
      family: familyMatch.family,
      rows: []
    };
    current.rows.push({
      row,
      member: familyMatch.member,
      memberIndex: familyMatch.memberIndex
    });
    familyGroups.set(familyMatch.family.key, current);
  });

  const sectionItems = new Map();
  const addItem = (section, item) => {
    const current = sectionItems.get(section) || [];
    current.push(item);
    sectionItems.set(section, current);
  };

  FAMILY_DEFINITIONS.forEach((family) => {
    const group = familyGroups.get(family.key);
    if (group) {
      const section = order.includes(family.section) ? family.section : '其他指标';
      addItem(section, buildFamilyItem(family, group.rows));
    }
  });
  standaloneRows.forEach(({ row, section }) => {
    addItem(section, buildStandaloneItem(row));
  });

  const orderedTitles = [...order, '其他指标'];
  return orderedTitles
    .filter((title) => sectionItems.has(title))
    .map((title) => ({ title, items: sectionItems.get(title) }));
}

function buildDisplayText({ objectType, objectLabel, rows, sections }) {
  const scopeText = objectType ? `${objectLabel}（${objectType}）` : objectLabel;
  if (rows.length === 0) {
    return `当前没有返回${scopeText}可查指标。`;
  }

  const lines = [`${scopeText}共返回 ${rows.length} 个指标，按类别整理如下：`];
  sections.forEach((section) => {
    lines.push('', section.title);
    section.items.forEach((item) => lines.push(`• ${item.text}`));
  });

  const coveredSections = sections
    .map((section) => section.title)
    .filter((title) => title !== '其他指标');
  const coverage = coveredSections.length > 0 ? coveredSections.join('、') : '本次返回项';
  lines.push(
    '',
    `小结：${scopeText}本次返回的 ${rows.length} 个可查指标覆盖${coverage}。以上内容仅基于本轮 NAPM 返回结果。需要按某个具体${objectLabel}查询指标的实时数据、趋势或排行，直接说即可。`
  );
  return lines.join('\n');
}

function buildMetricInventoryPresentation({ payload = {}, rows = [], objectType = '' } = {}) {
  const resolvedObjectType = resolveObjectType(payload, objectType);
  const objectLabel = OBJECT_LABELS[resolvedObjectType] || resolvedObjectType || '当前对象';
  const normalizedRows = normalizeRows(rows);
  const profile = resolveProfile(resolvedObjectType, normalizedRows);
  const sections = buildSections(normalizedRows, profile);
  const displayText = buildDisplayText({
    objectType: resolvedObjectType,
    objectLabel,
    rows: normalizedRows,
    sections
  });

  return {
    objectType: resolvedObjectType || null,
    objectLabel,
    metricCount: normalizedRows.length,
    metricIds: normalizedRows.map((row) => row.id).filter(Boolean),
    sections,
    displayText
  };
}

module.exports = {
  buildMetricInventoryPresentation
};
