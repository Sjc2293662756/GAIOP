const BUSINESS_OBJECT_TYPES = [
  'WebApplication',
  'PageFamily',
  'User',
  'ClientBusinessGroup'
];

const NON_BUSINESS_OBJECT_TYPES = [
  'TotalTraffic',
  'IPAddress',
  'Prefix24',
  'ISPAS',
  'DestAS',
  'BusinessGroup',
  'BusinessGroupLink',
  'IPConversation',
  'DefinedApp',
  'OtherApp',
  'VLAN',
  'Interface',
  'MonInterfaceGroup'
];

const BUSINESS_METRIC_CATEGORIES = [
  '业务网络',
  '业务访问',
  '业务性能',
  '响应代码'
];

const NON_BUSINESS_METRIC_CATEGORIES = [
  '数据包',
  '网络流量',
  '传输效率',
  '网络性能',
  '网络连接',
  '应用访问',
  '应用性能',
  '用户体验',
  '安全分析'
];

const METRIC_CATEGORY_TO_IDS = {
  业务网络: [
    'PGBYTI',
    'PGBYTO',
    'PGSIZEI',
    'PGSIZEO'
  ],
  业务访问: [
    'PGNPGE',
    'PGNPGC',
    'PGNPGS',
    'PGRT'
  ],
  业务性能: [
    'PGNSLPGE',
    'PGNSLPGC',
    'PGNSLPGS',
    'PGSLPCT',
    'PGSLPCTC',
    'PGSLPCTS',
    'PGSLRT',
    'PGSLRTC',
    'PGSLRTS',
    'PGTME',
    'PGTMC',
    'PGTMS'
  ],
  响应代码: [
    'PGNOBJE',
    'PGHTTP100',
    'PGHTTP200',
    'PGHTTP300',
    'PGHTTP400',
    'PGHTTP500',
    'PGHTTP100PCT',
    'PGHTTP200PCT',
    'PGHTTP300PCT',
    'PGHTTP400PCT',
    'PGHTTP500PCT'
  ],
  页面优化: [
    'POPT',
    'ROPT',
    'PNOPT',
    'PPOPT',
    'PFOPT'
  ],
  数据包: [
    'PKIO',
    'PKI',
    'PKO',
    'PKTIO',
    'PKTI',
    'PKTO',
    'PKZI',
    'PKZO'
  ],
  网络流量: [
    'TPIO',
    'TPI',
    'TPO',
    'BYTIO',
    'BYTI',
    'BYTO'
  ],
  传输效率: [
    'GPI',
    'GPO',
    'UTI',
    'UTO',
    'FSO_B',
    'FSI_B',
    'FSO_P',
    'FSI_P'
  ],
  网络性能: [
    'RTTI',
    'RTTO',
    'PLI',
    'PLO',
    'RDTI',
    'RDTO',
    'RTXI',
    'RTXO',
    'RPKI',
    'RPKO',
    'TRTT',
    'TRTT1',
    'TRTT2'
  ],
  网络连接: [
    'CONI',
    'CONO',
    'CCNI',
    'CCNO',
    'RFCI',
    'RFCO',
    'CDI',
    'CDO',
    'CRTI',
    'CRTO',
    'FILI',
    'FILO',
    'RFRI',
    'RFRO'
  ],
  应用访问: [
    'RSTSI',
    'RSTSO',
    'RSTI',
    'RSTO',
    'TRNI',
    'TRNO',
    'TRRI',
    'TRRO'
  ],
  应用性能: [
    'CSTI',
    'CSTO',
    'TRTI',
    'TRTO',
    'NRTO',
    'NRTI',
    'PTTO',
    'PTTI',
    'T2FBO',
    'T2FBI',
    'ARTO',
    'ARTI'
  ],
  用户体验: [
    'UEII',
    'UEIO'
  ],
  安全分析: []
};

const BUSINESS_METRIC_IDS = Array.from(new Set([
  ...BUSINESS_METRIC_CATEGORIES.flatMap((category) => METRIC_CATEGORY_TO_IDS[category] || []),
  ...(METRIC_CATEGORY_TO_IDS.页面优化 || [])
]));

const NON_BUSINESS_METRIC_IDS = Array.from(new Set(
  NON_BUSINESS_METRIC_CATEGORIES.flatMap((category) => METRIC_CATEGORY_TO_IDS[category] || [])
));

const DEFAULT_BUSINESS_METRIC_PRIORITY = [
  'PGNPGE',
  'PGRT',
  'PGTME',
  'PGNSLPGE',
  'PGSLPCT',
  'PGHTTP500',
  'PGHTTP400',
  'PGNOBJE',
  'POPT',
  'PFOPT',
  'PNOPT',
  'PGBYTI',
  'PGBYTO',
  'PGSIZEI',
  'PGSIZEO'
];

const DEFAULT_NON_BUSINESS_METRIC_PRIORITY = [
  'TPIO',
  'BYTIO',
  'PKIO',
  'PLI',
  'RTTI',
  'CONI',
  'CCNI',
  'RFCI',
  'CSTI',
  'TRTI',
  'UEII',
  'GPI',
  'UTI',
  'TRTT'
];

const OBJECT_TYPE_DEFAULT_METRIC_PRIORITY = {
  WebApplication: DEFAULT_BUSINESS_METRIC_PRIORITY,
  PageFamily: DEFAULT_BUSINESS_METRIC_PRIORITY,
  User: DEFAULT_BUSINESS_METRIC_PRIORITY,
  ClientBusinessGroup: DEFAULT_BUSINESS_METRIC_PRIORITY,
  TotalTraffic: DEFAULT_NON_BUSINESS_METRIC_PRIORITY,
  IPAddress: DEFAULT_NON_BUSINESS_METRIC_PRIORITY,
  Prefix24: DEFAULT_NON_BUSINESS_METRIC_PRIORITY,
  BusinessGroup: DEFAULT_NON_BUSINESS_METRIC_PRIORITY,
  BusinessGroupLink: DEFAULT_NON_BUSINESS_METRIC_PRIORITY,
  IPConversation: DEFAULT_NON_BUSINESS_METRIC_PRIORITY,
  DefinedApp: [
    'TPIO',
    'BYTIO',
    'CONI',
    'CCNI',
    'RFCI',
    'TRTI',
    'TRNI',
    'RSTSI',
    'UEII',
    'CSTI'
  ],
  OtherApp: [
    'TPIO',
    'BYTIO',
    'CONI',
    'CCNI',
    'RFCI',
    'TRTI',
    'TRNI',
    'RSTSI',
    'UEII',
    'CSTI'
  ],
  VLAN: [
    'TPIO',
    'BYTIO',
    'PKIO',
    'PLI',
    'RTTI',
    'RTXI',
    'GPI',
    'UTI'
  ],
  Interface: [
    'TPIO',
    'BYTIO',
    'PKIO',
    'PLI',
    'RTTI',
    'RTXI',
    'GPI',
    'UTI'
  ],
  MonInterfaceGroup: [
    'TPIO',
    'BYTIO',
    'PKIO',
    'PLI',
    'RTTI',
    'RTXI',
    'GPI',
    'UTI'
  ],
  ISPAS: [
    'TPIO',
    'RTTI',
    'TRTT',
    'TRTT1',
    'TRTT2',
    'PLI'
  ],
  DestAS: [
    'TPIO',
    'RTTI',
    'TRTT',
    'TRTT1',
    'TRTT2',
    'PLI'
  ]
};

function normalizeMetricId(metricId = '') {
  return String(metricId || '').trim().toUpperCase();
}

function normalizeObjectType(objectType = '') {
  return String(objectType || '').trim();
}

function isBusinessObjectType(objectType = '') {
  return BUSINESS_OBJECT_TYPES.includes(normalizeObjectType(objectType));
}

function isNonBusinessObjectType(objectType = '') {
  return NON_BUSINESS_OBJECT_TYPES.includes(normalizeObjectType(objectType));
}

function hasKnownMetricOwnership(objectType = '') {
  return isBusinessObjectType(objectType) || isNonBusinessObjectType(objectType);
}

function getOwnedMetricIdsForObjectType(objectType = '') {
  if (isBusinessObjectType(objectType)) {
    return BUSINESS_METRIC_IDS.slice();
  }
  if (isNonBusinessObjectType(objectType)) {
    return NON_BUSINESS_METRIC_IDS.slice();
  }
  return [];
}

function isOwnedMetricForObjectType(objectType = '', metricId = '') {
  const normalizedMetric = normalizeMetricId(metricId);
  if (!normalizedMetric) {
    return false;
  }
  return getOwnedMetricIdsForObjectType(objectType).includes(normalizedMetric);
}

function filterMetricsForObjectType(objectType = '', metrics = []) {
  const items = Array.isArray(metrics) ? metrics : [];
  const ownedMetricIds = new Set(getOwnedMetricIdsForObjectType(objectType));
  if (ownedMetricIds.size === 0) {
    return items;
  }

  return items.filter((item) => {
    const metricId = normalizeMetricId(item?.id || item?.metric || item);
    return metricId && ownedMetricIds.has(metricId);
  });
}

function getMetricCategoriesForObjectType(objectType = '') {
  if (isBusinessObjectType(objectType)) {
    return BUSINESS_METRIC_CATEGORIES.slice();
  }
  if (isNonBusinessObjectType(objectType)) {
    return NON_BUSINESS_METRIC_CATEGORIES.slice();
  }
  return [];
}

function getDefaultMetricCandidatesForObjectType(objectType = '') {
  const normalizedObjectType = normalizeObjectType(objectType);
  if (!hasKnownMetricOwnership(normalizedObjectType)) {
    return [];
  }

  const ownedMetricIds = new Set(getOwnedMetricIdsForObjectType(normalizedObjectType));
  const configuredPriority = OBJECT_TYPE_DEFAULT_METRIC_PRIORITY[normalizedObjectType]
    || (isBusinessObjectType(normalizedObjectType)
      ? DEFAULT_BUSINESS_METRIC_PRIORITY
      : DEFAULT_NON_BUSINESS_METRIC_PRIORITY);

  return Array.from(new Set(
    configuredPriority
      .map((metricId) => normalizeMetricId(metricId))
      .filter((metricId) => ownedMetricIds.has(metricId))
  ));
}

function rankMetricIdsForObjectType(objectType = '', metricIds = []) {
  const normalizedMetricIds = Array.from(new Set(
    (Array.isArray(metricIds) ? metricIds : [])
      .map((metricId) => normalizeMetricId(metricId))
      .filter(Boolean)
  ));
  const normalizedObjectType = normalizeObjectType(objectType);
  if (!hasKnownMetricOwnership(normalizedObjectType)) {
    return normalizedMetricIds;
  }

  const ownedMetricIds = new Set(getOwnedMetricIdsForObjectType(normalizedObjectType));
  const compatibleMetricIds = normalizedMetricIds.filter((metricId) => ownedMetricIds.has(metricId));
  const defaultPriority = getDefaultMetricCandidatesForObjectType(normalizedObjectType);
  const compatibleMetricSet = new Set(compatibleMetricIds);
  const ranked = [];
  const seen = new Set();

  defaultPriority.forEach((metricId) => {
    if (compatibleMetricSet.has(metricId) && !seen.has(metricId)) {
      seen.add(metricId);
      ranked.push(metricId);
    }
  });

  compatibleMetricIds.forEach((metricId) => {
    if (!seen.has(metricId)) {
      seen.add(metricId);
      ranked.push(metricId);
    }
  });

  return ranked;
}

function resolveMetricOwnershipObjectType(groups = [], fallbackObjectType = '') {
  const groupTypes = (Array.isArray(groups) ? groups : [])
    .map((item) => (
      typeof item === 'string'
        ? item
        : item?.type
    ))
    .map((item) => normalizeObjectType(item))
    .filter(Boolean);

  for (let index = groupTypes.length - 1; index >= 0; index -= 1) {
    if (hasKnownMetricOwnership(groupTypes[index])) {
      return groupTypes[index];
    }
  }

  const normalizedFallback = normalizeObjectType(fallbackObjectType);
  return hasKnownMetricOwnership(normalizedFallback) ? normalizedFallback : '';
}

function isMetricCompatibleWithGroupPath(groupPath = [], metricId = '', fallbackObjectType = '') {
  const objectType = resolveMetricOwnershipObjectType(groupPath, fallbackObjectType);
  if (!objectType) {
    return true;
  }
  return isOwnedMetricForObjectType(objectType, metricId);
}

module.exports = {
  BUSINESS_OBJECT_TYPES,
  NON_BUSINESS_OBJECT_TYPES,
  BUSINESS_METRIC_CATEGORIES,
  NON_BUSINESS_METRIC_CATEGORIES,
  METRIC_CATEGORY_TO_IDS,
  BUSINESS_METRIC_IDS,
  NON_BUSINESS_METRIC_IDS,
  isBusinessObjectType,
  isNonBusinessObjectType,
  hasKnownMetricOwnership,
  getOwnedMetricIdsForObjectType,
  isOwnedMetricForObjectType,
  filterMetricsForObjectType,
  getMetricCategoriesForObjectType,
  getDefaultMetricCandidatesForObjectType,
  rankMetricIdsForObjectType,
  resolveMetricOwnershipObjectType,
  isMetricCompatibleWithGroupPath
};
