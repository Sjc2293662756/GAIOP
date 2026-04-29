const METRIC_DOMAINS = [
  {
    id: 'network_usage',
    label: 'Network Usage',
    preferredObjects: ['IPConversation', 'IPAddress', 'BusinessGroup', 'TotalTraffic', 'DefinedApp', 'WebApplication', 'Application'],
    metrics: [
      'TPI', 'TPO', 'TPIO', 'GPI', 'GPO',
      'BYTI', 'BYTO', 'BYTIO', 'PGBYTI', 'PGBYTO',
      'PKI', 'PKO', 'PKIO', 'PKTI', 'PKTO', 'PKTIO', 'PKZI', 'PKZO'
    ]
  },
  {
    id: 'network_performance',
    label: 'Network Performance',
    preferredObjects: ['IPConversation', 'IPAddress', 'DefinedApp', 'Prefix24'],
    metrics: [
      'PLI', 'PLO', 'RTXI', 'RTXO', 'RPKI', 'RPKO', 'RDTI', 'RDTO',
      'RTTI', 'RTTO', 'TRTT', 'TRTT1', 'TRTT2'
    ]
  },
  {
    id: 'connection_stability',
    label: 'Connection Stability',
    preferredObjects: ['IPAddress', 'BusinessGroup'],
    metrics: [
      'CSTI', 'CSTO', 'CCNI', 'CCNO', 'CONI', 'CONO',
      'RFCI', 'RFCO', 'RFRI', 'RFRO', 'RSTI', 'RSTO', 'RSTSI', 'RSTSO'
    ]
  },
  {
    id: 'application_performance',
    label: 'Application Performance',
    preferredObjects: ['BusinessGroup', 'IPAddress', 'IPConversation', 'DefinedApp', 'Application'],
    metrics: [
      'ARTI', 'ARTO', 'TRTI', 'TRTO', 'T2FBI', 'T2FBO',
      'UEII', 'UEIO', 'CDI', 'CDO', 'NRTO', 'NRTI', 'PTTI', 'PTTO'
    ]
  },
  {
    id: 'web_experience',
    label: 'Web Experience',
    preferredObjects: ['WebApplication', 'BusinessGroup', 'ClientIPs'],
    metrics: [
      'PGTMS', 'PGTMC', 'PGTME', 'PGSLRT', 'PGSLRTC', 'PGSLRTS',
      'PGSLPCT', 'PGSLPCTC', 'PGSLPCTS',
      'PGHTTP200', 'PGHTTP300', 'PGHTTP400', 'PGHTTP500',
      'PGHTTP200PCT', 'PGHTTP300PCT', 'PGHTTP400PCT', 'PGHTTP500PCT',
      'PGNPGE', 'PGNPGC', 'PGNPGS', 'PGRT', 'PGNOBJE'
    ]
  },
  {
    id: 'optimization',
    label: 'Optimization',
    preferredObjects: ['WebApplication', 'BusinessGroup'],
    metrics: ['ROPT', 'POPT', 'PFOPT', 'PPOPT', 'PNOPT']
  }
];

const DOMAIN_TO_OBJECTS = {
  network_usage: ['IPConversation', 'IPAddress', 'Prefix24', 'VLAN', 'BusinessGroup', 'TotalTraffic', 'ClientIPs', 'DefinedApp', 'Application', 'WebApplication'],
  network_performance: ['IPAddress', 'IPConversation', 'DefinedApp', 'Prefix24', 'VLAN', 'InterSubnetConnection', 'MonitoredPort'],
  connection_stability: ['Port', 'DefinedApp', 'Application', 'IPAddress', 'IPConversation', 'BusinessGroup'],
  application_performance: ['DefinedApp', 'Application', 'IPAddress', 'IPConversation', 'Port', 'BusinessGroup'],
  web_experience: ['WebApplication', 'Page', 'User', 'CustomSubnet', 'BusinessGroup', 'ClientIPs'],
  optimization: ['WebApplication', 'Page', 'BusinessGroup']
};

const METRIC_META = {
  TPI: { label: 'Throughput In', unit: 'Kbps' },
  TPO: { label: 'Throughput Out', unit: 'Kbps' },
  TPIO: { label: 'Throughput Total', unit: 'Kbps' },
  BYTI: { label: 'Traffic In', unit: 'data' },
  BYTO: { label: 'Traffic Out', unit: 'data' },
  BYTIO: { label: 'Traffic Total', unit: 'data' },
  RTTI: { label: 'RTT In', unit: 'ms' },
  RTTO: { label: 'RTT Out', unit: 'ms' },
  PLI: { label: 'Packet Loss In', unit: '%' },
  PLO: { label: 'Packet Loss Out', unit: '%' },
  RDTI: { label: 'Retransmission Delay In', unit: 'ms' },
  RDTO: { label: 'Retransmission Delay Out', unit: 'ms' },
  TRTI: { label: 'Server Response Time', unit: 'ms' },
  TRTO: { label: 'Client Response Time', unit: 'ms' },
  PGTME: { label: 'Page Delay', unit: 'ms' },
  PGNPGE: { label: 'Page Visits', unit: '#' },
  PGHTTP500PCT: { label: 'HTTP 500 Ratio', unit: '%' },
  PGHTTP500: { label: 'HTTP 500 Count', unit: '#' }
};

const SUPPORTED_GRANULARITIES = [60, 300, 3600, 86400];

module.exports = {
  METRIC_DOMAINS,
  DOMAIN_TO_OBJECTS,
  METRIC_META,
  SUPPORTED_GRANULARITIES
};
