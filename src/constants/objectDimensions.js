const OBJECT_DIMENSIONS = [
  {
    id: 0,
    key: 'TotalTraffic',
    label: 'Total Traffic',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['总流量', '整体流量', '全局', 'overall']
  },
  {
    id: 1,
    key: 'IPAddress',
    label: 'IP Address',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['ip', 'ip地址', '主机', 'ipaddress']
  },
  {
    id: 2,
    key: 'Prefix24',
    label: 'Prefix /24',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['网段', 'prefix24', '/24', '子网']
  },
  {
    id: 3,
    key: 'ISPAS',
    label: 'ISP AS',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['运营商as', 'ispas', 'isp']
  },
  {
    id: 4,
    key: 'DestAS',
    label: 'Destination AS',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['目的as', '目标自治域', 'destas']
  },
  {
    id: 5,
    key: 'BusinessGroup',
    label: 'Business Group',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['业务组', '工作组', '业务分组', 'business group', 'businessgroup']
  },
  {
    id: 6,
    key: 'BusinessGroupLink',
    label: 'Business Group Link',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['业务组链路', 'business group link', 'businessgrouplink']
  },
  {
    id: 7,
    key: 'IPConversation',
    label: 'IP Conversation',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['ip会话', '会话', '会话对', 'conversation', 'ipconversation']
  },
  {
    id: 8,
    key: 'DefinedApp',
    label: 'Defined Application',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['应用', '已知应用', '协议应用', '服务器应用', '服务应用', 'app', 'application', 'defined app']
  },
  {
    id: 9,
    key: 'OtherApp',
    label: 'Other Application',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['其他应用', '其它应用', '未知应用', 'other app', 'otherapp']
  },
  {
    id: 10,
    key: 'VLAN',
    label: 'VLAN',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['vlan']
  },
  {
    id: 11,
    key: 'Interface',
    label: 'Interface',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['接口', 'interface']
  },
  {
    id: 12,
    key: 'WebApplication',
    label: 'Web Application',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['业务', '业务系统', 'web应用', '网站', '站点', 'web application', 'webapplication']
  },
  {
    id: 13,
    key: 'PageFamily',
    label: 'Page Family',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['页面族', '页面分类', 'page family', 'pagefamily']
  },
  {
    id: 14,
    key: 'User',
    label: 'User',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['user', '用户']
  },
  {
    id: 15,
    key: 'MonInterfaceGroup',
    label: 'Monitored Interface Group',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['监控接口组', 'moninterfacegroup']
  },
  {
    id: 16,
    key: 'ClientBusinessGroup',
    label: 'Client Business Group',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['客户端业务组', '发起组', '用户组', 'clientbusinessgroup']
  },
  {
    id: 17,
    key: 'Application',
    label: 'Application',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['application']
  },
  {
    id: 18,
    key: 'Port',
    label: 'Port',
    hasArgument: true,
    supportedByCurrentSkill: false,
    aliases: ['端口', 'port']
  },
  {
    id: 19,
    key: 'ClientIPs',
    label: 'Client IPs',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['客户端ip', 'clientips', 'client ip']
  },
  {
    id: 20,
    key: 'MemberIPs',
    label: 'Member IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['memberips', 'member ip', '成员ip']
  },
  {
    id: 21,
    key: 'InternalIPs',
    label: 'Internal IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['internalips', 'internal ip', '内部ip']
  },
  {
    id: 22,
    key: 'ExternalIPs',
    label: 'External IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['externalips', 'external ip', '外部ip']
  },
  {
    id: 23,
    key: 'ConnectedIP',
    label: 'Connected IP',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['connectedip', 'connected ip', 'peer ip', '连接ip']
  },
  {
    id: 24,
    key: 'ConnectedBusinessGroup',
    label: 'Connected Business Group',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['connected business group', 'peer business group', '对端业务组']
  },
  {
    id: 25,
    key: 'LocalTraffic',
    label: 'Local Traffic',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['local traffic', '局域网流量']
  },
  {
    id: 26,
    key: 'IPProtocol',
    label: 'IP Protocol',
    hasArgument: true,
    supportedByCurrentSkill: true,
    aliases: ['ip protocol', 'protocol', '协议']
  },
  {
    id: 27,
    key: 'ServerIPs',
    label: 'Server IPs',
    hasArgument: false,
    supportedByCurrentSkill: true,
    aliases: ['serverips', 'server ip', '服务器ip']
  },
  {
    id: 28,
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
