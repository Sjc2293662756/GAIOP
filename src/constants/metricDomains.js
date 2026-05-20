const {
  BUSINESS_OBJECT_TYPES,
  NON_BUSINESS_OBJECT_TYPES,
  BUSINESS_METRIC_IDS,
  NON_BUSINESS_METRIC_IDS,
  METRIC_CATEGORY_TO_IDS,
  hasKnownMetricOwnership,
  isBusinessObjectType,
  isNonBusinessObjectType,
  isOwnedMetricForObjectType
} = require('./objectMetricOwnership');

const METRIC_DOMAINS = [
  {
    id: 'network_usage',
    label: 'Network Usage',
    preferredObjects: ['IPConversation', 'IPAddress', 'BusinessGroup', 'TotalTraffic', 'DefinedApp', 'Prefix24'],
    metrics: [
      'TPI', 'TPO', 'TPIO',
      'BYTI', 'BYTO', 'BYTIO',
      'PKIO', 'PKI', 'PKO',
      'PKTIO', 'PKTI', 'PKTO',
      'PKZI', 'PKZO'
    ]
  },
  {
    id: 'network_performance',
    label: 'Network Performance',
    preferredObjects: ['IPConversation', 'IPAddress', 'BusinessGroup', 'DefinedApp', 'Prefix24', 'ISPAS', 'DestAS'],
    metrics: [
      'PLI', 'PLO', 'RTXI', 'RTXO', 'RPKI', 'RPKO', 'RDTI', 'RDTO',
      'RTTI', 'RTTO', 'TRTT', 'TRTT1', 'TRTT2'
    ]
  },
  {
    id: 'connection_stability',
    label: 'Connection Stability',
    preferredObjects: ['IPAddress', 'BusinessGroup', 'IPConversation', 'DefinedApp'],
    metrics: [
      'CSTI', 'CSTO', 'CCNI', 'CCNO', 'CONI', 'CONO',
      'RFCI', 'RFCO', 'RFRI', 'RFRO', 'CDI', 'CDO', 'CRTI', 'CRTO', 'FILI', 'FILO'
    ]
  },
  {
    id: 'application_access',
    label: 'Application Access',
    preferredObjects: ['DefinedApp', 'IPConversation', 'BusinessGroup', 'IPAddress'],
    metrics: [
      'RSTSI', 'RSTSO', 'RSTI', 'RSTO',
      'TRNI', 'TRNO', 'TRRI', 'TRRO'
    ]
  },
  {
    id: 'application_performance',
    label: 'Application Performance',
    preferredObjects: ['DefinedApp', 'IPConversation', 'BusinessGroup', 'IPAddress'],
    metrics: [
      'ARTI', 'ARTO', 'TRTI', 'TRTO', 'T2FBI', 'T2FBO',
      'NRTO', 'NRTI', 'PTTI', 'PTTO', 'CSTI', 'CSTO'
    ]
  },
  {
    id: 'user_experience',
    label: 'User Experience',
    preferredObjects: ['DefinedApp', 'IPConversation', 'BusinessGroup', 'IPAddress'],
    metrics: [
      'UEII', 'UEIO'
    ]
  },
  {
    id: 'web_experience',
    label: 'Web Experience',
    preferredObjects: ['WebApplication', 'PageFamily', 'User', 'ClientBusinessGroup'],
    metrics: [
      'PGBYTI', 'PGBYTO', 'PGSIZEI', 'PGSIZEO',
      'PGNPGE', 'PGNPGC', 'PGNPGS', 'PGRT',
      'PGNSLPGE', 'PGNSLPGC', 'PGNSLPGS',
      'PGSLPCT', 'PGSLPCTC', 'PGSLPCTS',
      'PGSLRT', 'PGSLRTC', 'PGSLRTS',
      'PGTME', 'PGTMC', 'PGTMS',
      'PGNOBJE',
      'PGHTTP100', 'PGHTTP200', 'PGHTTP300', 'PGHTTP400', 'PGHTTP500',
      'PGHTTP100PCT', 'PGHTTP200PCT', 'PGHTTP300PCT', 'PGHTTP400PCT', 'PGHTTP500PCT'
    ]
  },
  {
    id: 'optimization',
    label: 'Optimization',
    preferredObjects: ['WebApplication', 'PageFamily', 'User', 'ClientBusinessGroup'],
    metrics: ['ROPT', 'POPT', 'PFOPT', 'PPOPT', 'PNOPT']
  },
  {
    id: 'transmission_efficiency',
    label: 'Transmission Efficiency',
    preferredObjects: ['IPAddress', 'BusinessGroup', 'IPConversation', 'TotalTraffic', 'DefinedApp', 'Interface', 'MonInterfaceGroup'],
    metrics: ['GPI', 'GPO', 'UTI', 'UTO', 'FSO_B', 'FSI_B', 'FSO_P', 'FSI_P']
  }
];

const DOMAIN_TO_OBJECTS = {
  network_usage: NON_BUSINESS_OBJECT_TYPES.slice(),
  network_performance: NON_BUSINESS_OBJECT_TYPES.slice(),
  connection_stability: [
    'TotalTraffic',
    'IPAddress',
    'Prefix24',
    'BusinessGroup',
    'BusinessGroupLink',
    'IPConversation',
    'DefinedApp',
    'OtherApp',
    'VLAN',
    'Interface',
    'MonInterfaceGroup',
    'ISPAS',
    'DestAS'
  ],
  application_access: [
    'TotalTraffic',
    'IPAddress',
    'Prefix24',
    'BusinessGroup',
    'BusinessGroupLink',
    'IPConversation',
    'DefinedApp',
    'OtherApp',
    'VLAN'
  ],
  application_performance: [
    'TotalTraffic',
    'IPAddress',
    'Prefix24',
    'BusinessGroup',
    'BusinessGroupLink',
    'IPConversation',
    'DefinedApp',
    'OtherApp',
    'VLAN'
  ],
  user_experience: [
    'TotalTraffic',
    'IPAddress',
    'Prefix24',
    'BusinessGroup',
    'BusinessGroupLink',
    'IPConversation',
    'DefinedApp',
    'OtherApp'
  ],
  web_experience: BUSINESS_OBJECT_TYPES.slice(),
  optimization: BUSINESS_OBJECT_TYPES.slice(),
  transmission_efficiency: [
    'TotalTraffic',
    'IPAddress',
    'Prefix24',
    'BusinessGroup',
    'BusinessGroupLink',
    'IPConversation',
    'DefinedApp',
    'OtherApp',
    'VLAN',
    'Interface',
    'MonInterfaceGroup'
  ]
};

const METRIC_META = {
  TPI: { label: 'Throughput In', unit: 'Kbps' },
  TPO: { label: 'Throughput Out', unit: 'Kbps' },
  TPIO: { label: 'Throughput Total', unit: 'Kbps' },
  BYTI: { label: 'Traffic In', unit: 'data' },
  BYTO: { label: 'Traffic Out', unit: 'data' },
  BYTIO: { label: 'Traffic Total', unit: 'data' },
  PKIO: { label: 'Packet Count Total', unit: '#' },
  PKI: { label: 'Packet Count In', unit: '#' },
  PKO: { label: 'Packet Count Out', unit: '#' },
  PKTIO: { label: 'Packet Rate Total', unit: 'pkt/s' },
  PKTI: { label: 'Packet Rate In', unit: 'pkt/s' },
  PKTO: { label: 'Packet Rate Out', unit: 'pkt/s' },
  PKZI: { label: 'Packet Size In', unit: 'data' },
  PKZO: { label: 'Packet Size Out', unit: 'data' },
  RTTI: { label: 'RTT In', unit: 'ms' },
  RTTO: { label: 'RTT Out', unit: 'ms' },
  PLI: { label: 'Packet Loss In', unit: '%' },
  PLO: { label: 'Packet Loss Out', unit: '%' },
  RDTI: { label: 'Retransmission Delay In', unit: 'ms' },
  RDTO: { label: 'Retransmission Delay Out', unit: 'ms' },
  RTXI: { label: 'Retransmission Rate In', unit: 'Kbps' },
  RTXO: { label: 'Retransmission Rate Out', unit: 'Kbps' },
  RPKI: { label: 'Packet Retransmission In', unit: 'pkt/s' },
  RPKO: { label: 'Packet Retransmission Out', unit: 'pkt/s' },
  TRTT: { label: 'Traceroute RTT', unit: 'ms' },
  TRTT1: { label: 'Traceroute ISP RTT', unit: 'ms' },
  TRTT2: { label: 'Traceroute Peer RTT', unit: 'ms' },
  CONI: { label: 'Connection Requests In', unit: '#' },
  CONO: { label: 'Connection Requests Out', unit: '#' },
  CCNI: { label: 'Concurrent Connections In', unit: '#' },
  CCNO: { label: 'Concurrent Connections Out', unit: '#' },
  RFCI: { label: 'Failed Requests In', unit: '#' },
  RFCO: { label: 'Failed Requests Out', unit: '#' },
  CDI: { label: 'Connection Duration In', unit: 's' },
  CDO: { label: 'Connection Duration Out', unit: 's' },
  CRTI: { label: 'Connection Rate In', unit: 'conn/s' },
  CRTO: { label: 'Connection Rate Out', unit: 'conn/s' },
  FILI: { label: 'Request Rate In', unit: 'req/s' },
  FILO: { label: 'Request Rate Out', unit: 'req/s' },
  RFRI: { label: 'Failure Rate In', unit: 'fail/s' },
  RFRO: { label: 'Failure Rate Out', unit: 'fail/s' },
  RSTSI: { label: 'Server Reset Rate In', unit: 'rst/s' },
  RSTSO: { label: 'Server Reset Rate Out', unit: 'rst/s' },
  RSTI: { label: 'Client Reset Rate In', unit: 'rst/s' },
  RSTO: { label: 'Client Reset Rate Out', unit: 'rst/s' },
  TRNI: { label: 'Transactions In', unit: '#' },
  TRNO: { label: 'Transactions Out', unit: '#' },
  TRRI: { label: 'Transaction Rate In', unit: 'txn/s' },
  TRRO: { label: 'Transaction Rate Out', unit: 'txn/s' },
  CSTI: { label: 'Connection Setup Time In', unit: 'ms' },
  CSTO: { label: 'Connection Setup Time Out', unit: 'ms' },
  TRTI: { label: 'Server Response Time', unit: 'ms' },
  TRTO: { label: 'Client Observed Response Time', unit: 'ms' },
  NRTO: { label: 'Transfer Time Server', unit: 'ms' },
  NRTI: { label: 'Transfer Time Client', unit: 'ms' },
  PTTI: { label: 'Payload Transfer Time Client', unit: 'ms' },
  PTTO: { label: 'Payload Transfer Time Server', unit: 'ms' },
  T2FBI: { label: 'Time To First Byte Client', unit: 'ms' },
  T2FBO: { label: 'Time To First Byte Server', unit: 'ms' },
  ARTI: { label: 'Initial App Response Client', unit: 'ms' },
  ARTO: { label: 'Initial App Response Server', unit: 'ms' },
  UEII: { label: 'User Experience In', unit: 'ms' },
  UEIO: { label: 'User Experience Out', unit: 'ms' },
  PGBYTI: { label: 'Request Traffic', unit: 'data' },
  PGBYTO: { label: 'Page Traffic', unit: 'data' },
  PGSIZEI: { label: 'Request Size', unit: 'data' },
  PGSIZEO: { label: 'Page Size', unit: 'data' },
  PGNPGE: { label: 'Page Visits', unit: '#' },
  PGNPGC: { label: 'Page Visits Server', unit: '#' },
  PGNPGS: { label: 'Page Visits Client', unit: '#' },
  PGRT: { label: 'Page Visit Rate', unit: 'count/min' },
  PGNSLPGE: { label: 'Slow Page Count', unit: '#' },
  PGNSLPGC: { label: 'Slow Page Count Server', unit: '#' },
  PGNSLPGS: { label: 'Slow Page Count Client', unit: '#' },
  PGSLPCT: { label: 'Slow Page Percentage', unit: '%' },
  PGSLPCTC: { label: 'Slow Page Percentage Server', unit: '%' },
  PGSLPCTS: { label: 'Slow Page Percentage Client', unit: '%' },
  PGSLRT: { label: 'Slow Page Rate', unit: 'count/min' },
  PGSLRTC: { label: 'Slow Page Rate Server', unit: 'count/min' },
  PGSLRTS: { label: 'Slow Page Rate Client', unit: 'count/min' },
  PGTME: { label: 'Page Delay', unit: 'ms' },
  PGTMC: { label: 'Page Delay Server', unit: 'ms' },
  PGTMS: { label: 'Page Delay Client', unit: 'ms' },
  PGNOBJE: { label: 'HTTP Response Count', unit: '#' },
  PGHTTP100: { label: 'HTTP 100 Count', unit: '#' },
  PGHTTP200: { label: 'HTTP 200 Count', unit: '#' },
  PGHTTP300: { label: 'HTTP 300 Count', unit: '#' },
  PGHTTP400: { label: 'HTTP 400 Count', unit: '#' },
  PGHTTP500: { label: 'HTTP 500 Count', unit: '#' },
  PGHTTP100PCT: { label: 'HTTP 100 Ratio', unit: '%' },
  PGHTTP200PCT: { label: 'HTTP 200 Ratio', unit: '%' },
  PGHTTP300PCT: { label: 'HTTP 300 Ratio', unit: '%' },
  PGHTTP400PCT: { label: 'HTTP 400 Ratio', unit: '%' },
  PGHTTP500PCT: { label: 'HTTP 500 Ratio', unit: '%' },
  ROPT: { label: 'Optimized Response Ratio', unit: '%' },
  POPT: { label: 'Optimized Page Ratio', unit: '%' },
  PFOPT: { label: 'Fully Optimized Page Ratio', unit: '%' },
  PPOPT: { label: 'Partially Optimized Page Ratio', unit: '%' },
  PNOPT: { label: 'Unoptimized Page Ratio', unit: '%' },
  GPI: { label: 'Goodput In', unit: 'Kbps' },
  GPO: { label: 'Goodput Out', unit: 'Kbps' },
  UTI: { label: 'Utilization In', unit: '%' },
  UTO: { label: 'Utilization Out', unit: '%' },
  FSO_B: { label: 'Payload Bytes Server', unit: 'data' },
  FSI_B: { label: 'Payload Bytes Client', unit: 'data' },
  FSO_P: { label: 'Payload Packets Server', unit: '#' },
  FSI_P: { label: 'Payload Packets Client', unit: '#' }
};

const SUPPORTED_GRANULARITIES = [60, 300, 3600, 86400];

const SEMANTIC_METRIC_DOMAIN_ALIASES = {
  NetworkQuality: ['network', 'loss', 'experience'],
  TcpStability: ['session', 'error'],
  ApplicationPerformance: ['application', 'experience'],
  WebExperience: ['business', 'experience', 'error'],
  Composite: ['traffic', 'network', 'application', 'business']
};

function normalizeMetricId(metricId = '') {
  return String(metricId || '').trim().toUpperCase();
}

function normalizeObjectType(objectType = '') {
  return String(objectType || '').trim();
}

const METRIC_TO_DOMAIN = new Map();
METRIC_DOMAINS.forEach((domain) => {
  domain.metrics.forEach((metricId) => {
    const normalizedMetricId = normalizeMetricId(metricId);
    if (normalizedMetricId && !METRIC_TO_DOMAIN.has(normalizedMetricId)) {
      METRIC_TO_DOMAIN.set(normalizedMetricId, domain.id);
    }
  });
});

function getDomainForMetric(metricId = '') {
  const normalized = normalizeMetricId(metricId);
  if (!normalized) {
    return null;
  }
  const domainId = METRIC_TO_DOMAIN.get(normalized);
  return domainId ? METRIC_DOMAINS.find((domain) => domain.id === domainId) || null : null;
}

function getDomainMeta(domainId = '') {
  const normalized = String(domainId || '').trim();
  if (!normalized) {
    return null;
  }
  return METRIC_DOMAINS.find((domain) => domain.id === normalized) || null;
}

function getObjectsForDomain(domainId = '') {
  const normalized = String(domainId || '').trim();
  if (!normalized) {
    return [];
  }
  return Array.isArray(DOMAIN_TO_OBJECTS[normalized]) ? DOMAIN_TO_OBJECTS[normalized].slice() : [];
}

function getObjectsForMetric(metricId = '') {
  const normalizedMetricId = normalizeMetricId(metricId);
  const domain = getDomainForMetric(normalizedMetricId);
  if (!domain) {
    return [];
  }

  return getObjectsForDomain(domain.id).filter((objectType) => (
    !hasKnownMetricOwnership(objectType)
    || isOwnedMetricForObjectType(objectType, normalizedMetricId)
  ));
}

function getPreferredObjectsForMetric(metricId = '') {
  const domain = getDomainForMetric(metricId);
  if (!domain) {
    return [];
  }

  const compatibleObjects = new Set(getObjectsForMetric(metricId));
  return (domain.preferredObjects || []).filter((objectType) => compatibleObjects.has(objectType));
}

function isMetricCompatibleWithObjectType(metricId = '', objectType = '') {
  const normalizedObjectType = normalizeObjectType(objectType);
  if (!normalizedObjectType) {
    return false;
  }
  return getObjectsForMetric(metricId).includes(normalizedObjectType);
}

function getMetricCategoriesForMetric(metricId = '') {
  const normalized = normalizeMetricId(metricId);
  if (!normalized) {
    return [];
  }
  return Object.entries(METRIC_CATEGORY_TO_IDS)
    .filter(([, ids]) => ids.includes(normalized))
    .map(([category]) => category);
}

function getSemanticMetricDomainAliases(domainName = '') {
  const normalized = String(domainName || '').trim();
  if (!normalized) {
    return [];
  }
  return Array.isArray(SEMANTIC_METRIC_DOMAIN_ALIASES[normalized])
    ? SEMANTIC_METRIC_DOMAIN_ALIASES[normalized].slice()
    : [];
}

function normalizeSemanticMetricDomainToken(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const directAlias = getSemanticMetricDomainAliases(raw);
  if (directAlias.length > 0) {
    return directAlias[0];
  }

  const normalized = raw.toLowerCase();
  if (/(alert|alarm|error|fail|异常|失败|告警|http4|http5)/.test(normalized)) return 'error';
  if (/(security|attack|risk|threat|安全|攻击|风险)/.test(normalized)) return 'security';
  if (/(loss|drop|packet|丢包)/.test(normalized)) return 'loss';
  if (/(latency|delay|slow|response|experience|rtt|时延|响应)/.test(normalized)) return 'experience';
  if (/(session|conversation|connect|request|visit|会话|访问|连接)/.test(normalized)) return 'session';
  if (/(traffic|throughput|flow|byte|bandwidth|流量|吞吐)/.test(normalized)) return 'traffic';
  if (/(business|web|page|业务|页面)/.test(normalized)) return 'business';
  if (/(application|app|service|应用)/.test(normalized)) return 'application';
  if (/(network|ip|subnet|prefix|网络|地址|网段)/.test(normalized)) return 'network';

  return normalized;
}

module.exports = {
  METRIC_DOMAINS,
  DOMAIN_TO_OBJECTS,
  METRIC_META,
  SUPPORTED_GRANULARITIES,
  BUSINESS_METRIC_IDS,
  NON_BUSINESS_METRIC_IDS,
  getDomainForMetric,
  getDomainMeta,
  getObjectsForDomain,
  getObjectsForMetric,
  getPreferredObjectsForMetric,
  isMetricCompatibleWithObjectType,
  getMetricCategoriesForMetric,
  SEMANTIC_METRIC_DOMAIN_ALIASES,
  getSemanticMetricDomainAliases,
  normalizeSemanticMetricDomainToken,
  isBusinessObjectType,
  isNonBusinessObjectType,
  isOwnedMetricForObjectType
};
