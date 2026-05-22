/**
 * OverviewCandidateRegistry.js
 *
 * 维护 overview 模式下可供选择的候选模块注册表。
 * 文件主体是静态配置数据，描述每个候选模块的场景、优先级、请求模板、依赖关系和能力标签；
 * 文件尾部提供少量只读访问函数，供 planner 和调试逻辑查询。
 */
const OVERVIEW_CANDIDATES = [
  {
    id: 'topDefinedAppThroughput',
    label: '应用吞吐排行',
    scenes: ['system'],
    role: 'primary',
    priority: 100,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['traffic', 'application'],
      objectTypes: ['DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'unknownTcpConnectionTop',
    label: '未知 TCP 连接排行',
    scenes: ['system'],
    role: 'standalone',
    priority: 82,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [
        { type: 'TotalTraffic' },
        { type: 'IPProtocol', argument: 'TCP' },
        { type: 'OtherApps' },
        { type: 'OtherApp' }
      ],
      metrics: ['CCNI'],
      topMetric: 'CCNI',
      topCount: 10
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['session', 'security'],
      objectTypes: ['OtherApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'overallTrafficTrend',
    label: '总体流量趋势',
    scenes: ['system', 'network'],
    role: 'standalone',
    priority: 98,
    minDepth: 'fast',
    request: {
      service: 'timeValues',
      groups: [{ type: 'TotalTraffic' }],
      metrics: ['TPIO', 'TPO', 'TPI'],
      granularity: 3600
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['traffic', 'network'],
      objectTypes: ['TotalTraffic']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'systemAlertSummary',
    label: '系统告警概况',
    scenes: ['system'],
    role: 'standalone',
    priority: 92,
    minDepth: 'fast',
    request: { service: 'alertsSummary' },
    capability: {
      questionTypes: ['overview', 'error'],
      metricDomains: ['error'],
      objectTypes: []
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topIpThroughput',
    label: 'IP 吞吐排行',
    scenes: ['network'],
    role: 'primary',
    priority: 94,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    childCandidateIds: ['ipThroughputTrend'],
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['traffic', 'network'],
      objectTypes: ['IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topIpConnectionFailures',
    label: 'IP 连接失败排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 95,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['RFCI'],
      topMetric: 'RFCI',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['network', 'session', 'error'],
      objectTypes: ['IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topBusinessRealtime',
    label: '业务实时访问排行',
    scenes: ['business'],
    role: 'primary',
    priority: 100,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNPGE', 'PGNSLPGE', 'PGHTTP400', 'PGHTTP500'],
      topMetric: 'PGNPGE',
      topCount: 9
    },
    childCandidateIds: ['businessRealtimeTrend'],
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['business', 'session', 'error'],
      objectTypes: ['WebApplication']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topBusinessGroupThroughput',
    label: '业务组吞吐排行',
    scenes: ['business_group'],
    role: 'primary',
    priority: 100,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'BusinessGroup' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 8
    },
    childCandidateIds: ['businessGroupThroughputTrend'],
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['business', 'traffic'],
      objectTypes: ['BusinessGroup']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topBusinessGroupConnections',
    label: '业务组连接请求排行',
    scenes: ['business_group'],
    role: 'standalone',
    priority: 94,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'BusinessGroup' }],
      metrics: ['CONI'],
      topMetric: 'CONI',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['business', 'session'],
      objectTypes: ['BusinessGroup']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'businessGroupAlertSummary',
    label: '业务组告警概况',
    scenes: ['business_group'],
    role: 'standalone',
    priority: 90,
    minDepth: 'fast',
    request: { service: 'alertsSummary' },
    capability: {
      questionTypes: ['overview', 'error'],
      metricDomains: ['error', 'business'],
      objectTypes: []
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topBusinessVisits',
    label: '业务访问排行',
    scenes: ['business'],
    role: 'primary',
    priority: 96,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGHTTP200'],
      topMetric: 'PGHTTP200',
      topCount: 5
    },
    childCandidateIds: ['businessVisitTrend'],
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['business', 'session'],
      objectTypes: ['WebApplication']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'businessAlertSummary',
    label: '业务告警概况',
    scenes: ['business'],
    role: 'standalone',
    priority: 90,
    minDepth: 'fast',
    request: { service: 'alertsSummary' },
    capability: {
      questionTypes: ['overview', 'error'],
      metricDomains: ['error', 'business'],
      objectTypes: []
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topWebApplicationResponseTime',
    label: 'Web 应用响应时间排行',
    scenes: ['business'],
    role: 'standalone',
    priority: 82,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGTME'],
      topMetric: 'PGTME',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'slow'],
      metricDomains: ['business', 'experience'],
      objectTypes: ['WebApplication']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topWebApplicationSlowPages',
    label: 'Web 应用慢页面排行',
    scenes: ['business'],
    role: 'standalone',
    priority: 80,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNSLPGE'],
      topMetric: 'PGNSLPGE',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'slow', 'error'],
      metricDomains: ['business', 'experience', 'error'],
      objectTypes: ['WebApplication']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topWebApplicationHttp500',
    label: 'Web 应用 HTTP 500 排行',
    scenes: ['business'],
    role: 'standalone',
    priority: 78,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGHTTP500'],
      topMetric: 'PGHTTP500',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['business', 'error'],
      objectTypes: ['WebApplication']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topWebApplicationHttp400',
    label: 'Web 应用 HTTP 400 排行',
    scenes: ['business'],
    role: 'standalone',
    priority: 76,
    minDepth: 'deep',
    request: {
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGHTTP400'],
      topMetric: 'PGHTTP400',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['business', 'error'],
      objectTypes: ['WebApplication']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'applicationAlertSummary',
    label: '应用告警概况',
    scenes: ['application'],
    role: 'standalone',
    priority: 96,
    minDepth: 'fast',
    request: { service: 'alertsSummary' },
    capability: {
      questionTypes: ['overview', 'error'],
      metricDomains: ['application', 'error'],
      objectTypes: []
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'appDistributionTop',
    label: '应用分布排行',
    scenes: ['application'],
    role: 'standalone',
    priority: 94,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 8
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['application', 'traffic'],
      objectTypes: ['DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'topApplicationThroughput',
    label: '应用吞吐排行',
    scenes: ['network'],
    role: 'primary',
    priority: 92,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['application', 'traffic'],
      objectTypes: ['DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'appTrafficAnalysisTop',
    label: '\u5e94\u7528\u6d41\u91cf\u5206\u6790',
    scenes: ['application'],
    role: 'child',
    priority: 82,
    minDepth: 'standard',
    dependsOnCandidateIds: ['appDistributionTop'],
    recommendedMaxChildren: 1,
    request: {
      service: 'topValues',
      groups: [
        { type: 'DefinedApp' },
        { type: 'ExternalIPs' },
        { type: 'IPAddress' }
      ],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['application', 'traffic', 'network'],
      objectTypes: ['DefinedApp', 'IPAddress']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'appAccessTrendByTopApp',
    label: '\u5e94\u7528\u8bbf\u95ee\u8d8b\u52bf',
    scenes: ['application'],
    role: 'child',
    priority: 80,
    minDepth: 'deep',
    dependsOnCandidateIds: ['appDistributionTop'],
    recommendedMaxChildren: 1,
    request: {
      service: 'timeValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['CONI', 'CCNI', 'RFCI'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['application', 'session', 'error'],
      objectTypes: ['DefinedApp']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'appExperienceTrendByTopApp',
    label: '\u5e94\u7528\u4f53\u9a8c\u8d8b\u52bf',
    scenes: ['application'],
    role: 'child',
    priority: 78,
    minDepth: 'deep',
    dependsOnCandidateIds: ['appDistributionTop'],
    recommendedMaxChildren: 1,
    request: {
      service: 'timeValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['UEII', 'CSTI', 'TRTI', 'PTTO', 'RDTO'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend', 'slow'],
      metricDomains: ['application', 'experience'],
      objectTypes: ['DefinedApp']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'appSessionTopByTopApp',
    label: '\u5e94\u7528\u4f1a\u8bdd\u5206\u6790',
    scenes: ['application'],
    role: 'child',
    priority: 76,
    minDepth: 'deep',
    dependsOnCandidateIds: ['appDistributionTop'],
    recommendedMaxChildren: 1,
    request: {
      service: 'topValues',
      groups: [
        { type: 'DefinedApp' },
        { type: 'IPConversations' },
        { type: 'IPConversation' }
      ],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['application', 'traffic', 'session'],
      objectTypes: ['DefinedApp', 'IPConversation']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'appAccessTrend',
    label: '应用访问趋势',
    scenes: ['application'],
    role: 'standalone',
    priority: 78,
    minDepth: 'deep',
    slotRequirements: ['focusDefinedApp'],
    request: {
      service: 'timeValues',
      groups: [{ type: 'DefinedApp', argumentFromSlot: 'focusDefinedApp' }],
      metrics: ['CONI', 'CCNI', 'RFCI'],
      granularity: 3600
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['application', 'session', 'error'],
      objectTypes: ['DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'appExperienceTrend',
    label: '应用体验趋势',
    scenes: ['application'],
    role: 'standalone',
    priority: 76,
    minDepth: 'deep',
    slotRequirements: ['focusDefinedApp'],
    request: {
      service: 'timeValues',
      groups: [{ type: 'DefinedApp', argumentFromSlot: 'focusDefinedApp' }],
      metrics: ['UEII', 'CSTI', 'TRTI', 'PTTO', 'RDTO'],
      granularity: 3600
    },
    capability: {
      questionTypes: ['overview', 'trend', 'slow'],
      metricDomains: ['application', 'experience'],
      objectTypes: ['DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'appSessionTop',
    label: '应用会话排行',
    scenes: ['application'],
    role: 'standalone',
    priority: 74,
    minDepth: 'deep',
    slotRequirements: ['focusDefinedApp'],
    request: {
      service: 'topValues',
      groups: [
        { type: 'DefinedApp', argumentFromSlot: 'focusDefinedApp' },
        { type: 'IPConversations' },
        { type: 'IPConversation' }
      ],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['application', 'traffic', 'session'],
      objectTypes: ['DefinedApp', 'IPConversation']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'appFailureTop',
    label: '应用失败排行',
    scenes: ['application'],
    role: 'standalone',
    priority: 90,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['RFCI'],
      topMetric: 'RFCI',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['application', 'error'],
      objectTypes: ['DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'networkAlertSummary',
    label: '网络告警概况',
    scenes: ['network'],
    role: 'standalone',
    priority: 96,
    minDepth: 'fast',
    request: { service: 'alertsSummary' },
    capability: {
      questionTypes: ['overview', 'error'],
      metricDomains: ['network', 'error'],
      objectTypes: []
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'packetLossInboundTop',
    label: '入向丢包排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 92,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'TotalTraffic' }],
      metrics: ['PLI'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'loss'],
      metricDomains: ['network', 'loss'],
      objectTypes: ['IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'packetLossOutboundTop',
    label: '出向丢包排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 90,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [{ type: 'TotalTraffic' }],
      metrics: ['PLO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'loss'],
      metricDomains: ['network', 'loss'],
      objectTypes: ['IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'subnetDistributionTop',
    label: '网段分布排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 76,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [{ type: 'Prefix24' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['network', 'traffic'],
      objectTypes: ['Prefix24']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'businessNodeDistributionTop',
    label: '业务节点分布排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 72,
    minDepth: 'deep',
    request: {
      service: 'topValues',
      groups: [{ type: 'BusinessGroup' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['network', 'business', 'traffic'],
      objectTypes: ['BusinessGroup']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'sessionDistributionTop',
    label: '会话分布排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 70,
    minDepth: 'deep',
    request: {
      service: 'topValues',
      groups: [{ type: 'IPConversation' }],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn'],
      metricDomains: ['network', 'traffic', 'session'],
      objectTypes: ['IPConversation']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'focusedIpConnectionSnapshot',
    label: '目标 IP 连接概览',
    scenes: ['network'],
    role: 'standalone',
    priority: 99,
    minDepth: 'standard',
    slotRequirements: ['focusIpAddress'],
    request: {
      service: 'averageValues',
      groups: [{ type: 'IPAddress', argumentFromSlot: 'focusIpAddress' }],
      metrics: ['CONI', 'CCNI', 'RFCI']
    },
    capability: {
      questionTypes: ['overview', 'error', 'topn'],
      metricDomains: ['network', 'session', 'error'],
      objectTypes: ['IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'focusedIpConnectionTrend',
    label: '目标 IP 连接趋势',
    scenes: ['network'],
    role: 'standalone',
    priority: 94,
    minDepth: 'standard',
    slotRequirements: ['focusIpAddress'],
    request: {
      service: 'timeValues',
      groups: [{ type: 'IPAddress', argumentFromSlot: 'focusIpAddress' }],
      metrics: ['CONI', 'CCNI', 'RFCI'],
      granularity: 3600
    },
    capability: {
      questionTypes: ['overview', 'trend', 'error'],
      metricDomains: ['network', 'session', 'error'],
      objectTypes: ['IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'focusedIpApplicationTop',
    label: '目标 IP 关联应用排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 88,
    minDepth: 'deep',
    slotRequirements: ['focusIpAddress'],
    request: {
      service: 'topValues',
      groups: [
        { type: 'IPAddress', argumentFromSlot: 'focusIpAddress' },
        { type: 'Applications' },
        { type: 'DefinedApp' }
      ],
      metrics: ['CONI'],
      topMetric: 'CONI',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['network', 'session', 'application'],
      objectTypes: ['IPAddress', 'DefinedApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'focusedIpConversationTop',
    label: '目标 IP 对端会话排行',
    scenes: ['network'],
    role: 'standalone',
    priority: 86,
    minDepth: 'deep',
    slotRequirements: ['focusIpAddress'],
    request: {
      service: 'topValues',
      groups: [
        { type: 'IPAddress', argumentFromSlot: 'focusIpAddress' },
        { type: 'IPConversations' },
        { type: 'IPConversation' }
      ],
      metrics: ['RFCI'],
      topMetric: 'RFCI',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'error'],
      metricDomains: ['network', 'session', 'error'],
      objectTypes: ['IPAddress', 'IPConversation']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'activeOutboundServer',
    label: '活跃外联主机',
    scenes: ['security'],
    role: 'primary',
    priority: 92,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [
        { type: 'BusinessGroup', argument: 'Default-Internet' },
        { type: 'MemberIPs' },
        { type: 'IPAddress' }
      ],
      metrics: ['CONO', 'RFCO', 'CCNO'],
      topMetric: 'CONO',
      topCount: 5
    },
    childCandidateIds: ['ipConnectionTrend'],
    capability: {
      questionTypes: ['overview', 'topn', 'security'],
      metricDomains: ['security', 'network', 'session'],
      objectTypes: ['BusinessGroup', 'IPAddress']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'securityAlertSummary',
    label: '安全告警概况',
    scenes: ['security'],
    role: 'standalone',
    priority: 96,
    minDepth: 'fast',
    request: { service: 'alertsSummary' },
    capability: {
      questionTypes: ['overview', 'error', 'security'],
      metricDomains: ['security', 'error'],
      objectTypes: []
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'unknownTcpTop',
    label: '未知 TCP 应用排行',
    scenes: ['security'],
    role: 'standalone',
    priority: 90,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [
        { type: 'TotalTraffic' },
        { type: 'IPProtocol', argument: 'TCP' },
        { type: 'OtherApps' },
        { type: 'OtherApp' }
      ],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'security'],
      metricDomains: ['security', 'traffic'],
      objectTypes: ['OtherApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'unknownUdpTop',
    label: '未知 UDP 应用排行',
    scenes: ['security'],
    role: 'standalone',
    priority: 88,
    minDepth: 'fast',
    request: {
      service: 'topValues',
      groups: [
        { type: 'TotalTraffic' },
        { type: 'IPProtocol', argument: 'UDP' },
        { type: 'OtherApps' },
        { type: 'OtherApp' }
      ],
      metrics: ['TPIO'],
      topMetric: 'TPIO',
      topCount: 5
    },
    capability: {
      questionTypes: ['overview', 'topn', 'security'],
      metricDomains: ['security', 'traffic'],
      objectTypes: ['OtherApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'unknownTcpBytesTop',
    label: '未知 TCP 流量排行',
    scenes: ['security'],
    role: 'standalone',
    priority: 86,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [
        { type: 'TotalTraffic' },
        { type: 'IPProtocol', argument: 'TCP' },
        { type: 'OtherApps' },
        { type: 'OtherApp' }
      ],
      metrics: ['BYTIO'],
      topMetric: 'BYTIO',
      topCount: 7
    },
    capability: {
      questionTypes: ['overview', 'topn', 'security'],
      metricDomains: ['security', 'traffic'],
      objectTypes: ['OtherApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'unknownUdpBytesTop',
    label: '未知 UDP 流量排行',
    scenes: ['security'],
    role: 'standalone',
    priority: 84,
    minDepth: 'standard',
    request: {
      service: 'topValues',
      groups: [
        { type: 'TotalTraffic' },
        { type: 'IPProtocol', argument: 'UDP' },
        { type: 'OtherApps' },
        { type: 'OtherApp' }
      ],
      metrics: ['BYTIO'],
      topMetric: 'BYTIO',
      topCount: 7
    },
    capability: {
      questionTypes: ['overview', 'topn', 'security'],
      metricDomains: ['security', 'traffic'],
      objectTypes: ['OtherApp']
    },
    cost: { rootQueries: 1 }
  },
  {
    id: 'ipThroughputTrend',
    label: 'IP 吞吐趋势',
    scenes: ['network'],
    role: 'child',
    priority: 72,
    minDepth: 'standard',
    dependsOnCandidateIds: ['topIpThroughput'],
    recommendedMaxChildren: 5,
    request: {
      service: 'timeValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['TPIO'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['network', 'traffic'],
      objectTypes: ['IPAddress']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'appThroughputTrend',
    label: '应用吞吐趋势',
    scenes: ['network'],
    role: 'child',
    priority: 70,
    minDepth: 'standard',
    dependsOnCandidateIds: ['topApplicationThroughput'],
    recommendedMaxChildren: 5,
    request: {
      service: 'timeValues',
      groups: [{ type: 'DefinedApp' }],
      metrics: ['TPIO'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['application', 'traffic'],
      objectTypes: ['DefinedApp']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'businessRealtimeTrend',
    label: '业务实时访问趋势',
    scenes: ['business'],
    role: 'child',
    priority: 68,
    minDepth: 'standard',
    dependsOnCandidateIds: ['topBusinessRealtime'],
    recommendedMaxChildren: 5,
    request: {
      service: 'timeValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGNPGE'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['business', 'session'],
      objectTypes: ['WebApplication']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'businessGroupThroughputTrend',
    label: '业务组吞吐趋势',
    scenes: ['business_group'],
    role: 'child',
    priority: 68,
    minDepth: 'standard',
    dependsOnCandidateIds: ['topBusinessGroupThroughput'],
    recommendedMaxChildren: 5,
    request: {
      service: 'timeValues',
      groups: [{ type: 'BusinessGroup' }],
      metrics: ['TPIO'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['business', 'traffic'],
      objectTypes: ['BusinessGroup']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'businessVisitTrend',
    label: '业务访问趋势',
    scenes: ['business'],
    role: 'child',
    priority: 66,
    minDepth: 'standard',
    dependsOnCandidateIds: ['topBusinessVisits'],
    recommendedMaxChildren: 5,
    request: {
      service: 'timeValues',
      groups: [{ type: 'WebApplication' }],
      metrics: ['PGHTTP200'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend'],
      metricDomains: ['business', 'session'],
      objectTypes: ['WebApplication']
    },
    cost: { childQueries: 1 }
  },
  {
    id: 'ipConnectionTrend',
    label: '外联主机连接趋势',
    scenes: ['security'],
    role: 'child',
    priority: 68,
    minDepth: 'standard',
    dependsOnCandidateIds: ['activeOutboundServer'],
    recommendedMaxChildren: 5,
    request: {
      service: 'timeValues',
      groups: [{ type: 'IPAddress' }],
      metrics: ['CONO', 'RFCO', 'CCNO'],
      granularity: 3600
    },
    deriveArgument: {
      source: 'group',
      targetParam: 'groupArgument1'
    },
    capability: {
      questionTypes: ['overview', 'trend', 'security'],
      metricDomains: ['security', 'network', 'session'],
      objectTypes: ['IPAddress']
    },
    cost: { childQueries: 1 }
  }
];

const OVERVIEW_SCENE_PROFILES = {
  system: {
    depthRoots: {
      fast: ['topDefinedAppThroughput', 'overallTrafficTrend', 'systemAlertSummary'],
      standard: ['topDefinedAppThroughput', 'unknownTcpConnectionTop', 'overallTrafficTrend', 'systemAlertSummary'],
      deep: ['topDefinedAppThroughput', 'unknownTcpConnectionTop', 'overallTrafficTrend', 'systemAlertSummary']
    },
    depthChildren: {
      fast: [],
      standard: [],
      deep: []
    }
  },
  business: {
    depthRoots: {
      fast: ['topBusinessRealtime', 'topBusinessVisits'],
      standard: ['topBusinessRealtime', 'topBusinessVisits'],
      deep: [
        'topBusinessRealtime',
        'topBusinessVisits',
        'topWebApplicationResponseTime',
        'topWebApplicationSlowPages',
        'topWebApplicationHttp500',
        'topWebApplicationHttp400'
      ]
    },
    depthChildren: {
      fast: [],
      standard: ['businessRealtimeTrend', 'businessVisitTrend'],
      deep: ['businessRealtimeTrend', 'businessVisitTrend']
    }
  },
  business_group: {
    depthRoots: {
      fast: ['topBusinessGroupThroughput', 'topBusinessGroupConnections'],
      standard: ['topBusinessGroupThroughput', 'topBusinessGroupConnections'],
      deep: ['topBusinessGroupThroughput', 'topBusinessGroupConnections']
    },
    depthChildren: {
      fast: [],
      standard: ['businessGroupThroughputTrend'],
      deep: ['businessGroupThroughputTrend']
    }
  },
  application: {
    depthRoots: {
      fast: ['applicationAlertSummary', 'appDistributionTop', 'appFailureTop'],
      standard: ['applicationAlertSummary', 'appDistributionTop', 'appFailureTop'],
      deep: ['applicationAlertSummary', 'appDistributionTop', 'appFailureTop']
    },
    depthChildren: {
      fast: [],
      standard: ['appTrafficAnalysisTop'],
      deep: ['appTrafficAnalysisTop', 'appAccessTrendByTopApp', 'appExperienceTrendByTopApp', 'appSessionTopByTopApp']
    }
  },
  network: {
    depthRoots: {
      fast: ['networkAlertSummary', 'packetLossInboundTop', 'packetLossOutboundTop'],
      standard: ['networkAlertSummary', 'packetLossInboundTop', 'packetLossOutboundTop', 'overallTrafficTrend', 'topIpThroughput', 'topIpConnectionFailures', 'focusedIpConnectionSnapshot', 'focusedIpConnectionTrend'],
      deep: [
        'networkAlertSummary',
        'packetLossInboundTop',
        'packetLossOutboundTop',
        'overallTrafficTrend',
        'topIpThroughput',
        'topIpConnectionFailures',
        'focusedIpConnectionSnapshot',
        'focusedIpConnectionTrend',
        'focusedIpApplicationTop',
        'focusedIpConversationTop',
        'topApplicationThroughput',
        'subnetDistributionTop',
        'businessNodeDistributionTop',
        'sessionDistributionTop'
      ]
    },
    depthChildren: {
      fast: [],
      standard: ['ipThroughputTrend'],
      deep: ['ipThroughputTrend', 'appThroughputTrend']
    }
  },
  security: {
    depthRoots: {
      fast: ['activeOutboundServer', 'securityAlertSummary', 'unknownTcpTop'],
      standard: ['activeOutboundServer', 'securityAlertSummary', 'unknownTcpTop', 'unknownUdpTop', 'unknownTcpBytesTop'],
      deep: ['activeOutboundServer', 'securityAlertSummary', 'unknownTcpTop', 'unknownUdpTop', 'unknownTcpBytesTop', 'unknownUdpBytesTop']
    },
    depthChildren: {
      fast: [],
      standard: ['ipConnectionTrend'],
      deep: ['ipConnectionTrend']
    }
  }
};

// 为 candidateId 提供 O(1) 访问能力，避免外部每次都线性扫描整个注册表。
const CANDIDATE_MAP = new Map(OVERVIEW_CANDIDATES.map((candidate) => [candidate.id, candidate]));

// 返回 candidate 的深拷贝，确保注册表数据始终保持只读。
function cloneCandidate(candidate) {
  return candidate ? JSON.parse(JSON.stringify(candidate)) : null;
}

function cloneSceneProfile(profile) {
  return profile ? JSON.parse(JSON.stringify(profile)) : null;
}

// 按 scene 过滤候选模块；scene 为空时返回全部候选。
function listOverviewCandidates(scene = null) {
  const normalizedScene = String(scene || '').trim();
  return OVERVIEW_CANDIDATES
    .filter((candidate) => !normalizedScene || candidate.scenes.includes(normalizedScene))
    .map(cloneCandidate);
}

function getOverviewCandidate(candidateId) {
  return cloneCandidate(CANDIDATE_MAP.get(candidateId));
}

// 读取指定 scene 的概览场景画像配置。
function getOverviewSceneProfile(scene = null) {
  const normalizedScene = String(scene || '').trim();
  return cloneSceneProfile(OVERVIEW_SCENE_PROFILES[normalizedScene]);
}

module.exports = {
  OVERVIEW_CANDIDATES,
  OVERVIEW_SCENE_PROFILES,
  listOverviewCandidates,
  getOverviewCandidate,
  getOverviewSceneProfile
};
