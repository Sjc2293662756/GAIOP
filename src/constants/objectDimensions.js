const OBJECT_DIMENSIONS = [
  {
    id: 1,
    key: 'IPAddress',
    label: 'IP Address',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['ip', 'ip地址', '主机', 'ipaddress']
  },
  {
    id: 2,
    key: 'IPConversation',
    label: 'IP Conversation',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['ip会话', '会话', '会话对']
  },
  {
    id: 3,
    key: 'VLAN',
    label: 'VLAN',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['vlan']
  },
  {
    id: 4,
    key: 'Port',
    label: 'Port',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['端口', 'port']
  },
  {
    id: 5,
    key: 'Application',
    label: 'Application',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['应用', '业务应用', '服务器应用', '服务应用', 'app', 'application']
  },
  {
    id: 25,
    key: 'DefinedApp',
    label: 'Defined Application',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['应用', '业务应用', '服务器应用', '服务应用', 'app', 'application', 'defined app']
  },
  {
    id: 6,
    key: 'WebApplication',
    label: 'Web Application',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['业务', '业务系统', 'web应用', '网站', '站点', 'web application']
  },
  {
    id: 7,
    key: 'Page',
    label: 'Page',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['page', '页面']
  },
  {
    id: 8,
    key: 'User',
    label: 'User',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['user', '用户']
  },
  {
    id: 9,
    key: 'Prefix24',
    label: 'Prefix /24',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['网段', 'prefix24', '/24']
  },
  {
    id: 10,
    key: 'CustomSubnet',
    label: 'Custom Subnet',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['自定义网段']
  },
  {
    id: 11,
    key: 'InterSubnetConnection',
    label: 'Inter Subnet Connection',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['网段间连接']
  },
  {
    id: 12,
    key: 'MonitoredPort',
    label: 'Monitored Port',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['监控口']
  },
  {
    id: 13,
    key: 'BusinessGroup',
    label: 'Business Group',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['业务组', '工作组', '业务分组', '分组', 'business group']
  },
  {
    id: 14,
    key: 'TotalTraffic',
    label: 'Total Traffic',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['总流量', '全局', 'overall']
  },
  {
    id: 15,
    key: 'ClientIPs',
    label: 'Client IPs',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['客户端IP', '客户端ip', 'clientips', 'client ip']
  },
  {
    id: 16,
    key: 'MemberIPs',
    label: 'Member IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['memberips', 'member ip', 'member ips']
  },
  {
    id: 17,
    key: 'InternalIPs',
    label: 'Internal IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['internalips', 'internal ip', 'internal ips']
  },
  {
    id: 18,
    key: 'ExternalIPs',
    label: 'External IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['externalips', 'external ip', 'external ips']
  },
  {
    id: 19,
    key: 'ConnectedIP',
    label: 'Connected IP',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['connectedip', 'connected ip', 'peer ip']
  },
  {
    id: 20,
    key: 'ConnectedBusinessGroup',
    label: 'Connected Business Group',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['connected business group', 'peer business group']
  },
  {
    id: 21,
    key: 'LocalTraffic',
    label: 'Local Traffic',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['local traffic']
  },
  {
    id: 22,
    key: 'IPProtocol',
    label: 'IP Protocol',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['ip protocol', 'protocol']
  },
  {
    id: 23,
    key: 'ServerIPs',
    label: 'Server IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['serverips', 'server ip', 'server ips']
  },
  {
    id: 24,
    key: 'Non-TCPUDPIPProtocol',
    label: 'Non TCPUDP IP Protocol',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['non-tcpudp ip protocol']
  }
];

module.exports = {
  OBJECT_DIMENSIONS
};
