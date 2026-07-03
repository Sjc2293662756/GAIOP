# openclaw-napm-alert-query 完整说明文档

> 版本：v2.0 | 日期：2026-06-30 | 状态：已验证通过

---

## 1. Skill 概述

`openclaw-napm-alert-query` 是 NAPM 告警事件查询 Skill，负责告警摘要、时间线、详情、触发指标时序、通知字段解释，以及**间接数据包发现**——对业务/应用/工作组告警自动查找嫌疑 IP 会话并生成数据包下载候选。

### 核心能力

| 能力 | 说明 |
|------|------|
| 告警查询 | 摘要(summary)、时间线(timeline)、详情(detail)、指标时序(detail_with_timeseries) |
| 通知解释 | Email/SNMP/SysLog/快照字段说明 |
| **间接数据包发现** | 业务/应用/工作组告警 → 自动 topValues 查询 → 嫌疑 IP 会话 → packetHandoff |
| 数据包转交 | packetHandoff 含 suggestedPacketQuery，直接交给 packet-analysis |
| 报告数据 | 生成 reportData 供 openclaw-napm-report 消费 |

---

## 2. 文件结构

```
skills/openclaw-napm-alert-query/
├── SKILL.md                              # Skill 定义入口（AI 路由时读取）
├── agents/
│   └── openai.yaml                       # Agent 边界定义 + 路由规则
├── references/
│   ├── alert-api-contract.md             # NAPM 告警 API 契约
│   ├── alert-workflow-contract.md        # 工作流契约（模式、时间、跨 Skill）
│   └── alert-notification-fields.md      # 告警通知字段说明
├── services/
│   ├── AlertApiService.js                # 南向 API 调用层（axios → NetInside）
│   ├── AlertConstants.js                 # 常量（类别/严重级别/categoryType→groupType 映射）
│   ├── AlertQueryValidator.js            # 输入验证 + 规范化
│   ├── AlertNormalizerService.js         # 数据归一化（summary/detail/timeline/metricSeries）
│   ├── AlertAnalyzerService.js           # 告警事件聚合分析
│   ├── AlertNarrationContractService.js  # 输出契约（narrationInput/reportData/packetHandoff/packetInstruction）
│   ├── AlertNotificationExplainerService.js  # 告警通知字段解释
│   └── AlertIndirectPacketDiscoveryService.js  # ★ 间接数据包发现核心服务
└── scripts/
    └── run_alert_query.js                # CLI 入口 + 主编排逻辑
```

### 关键新增文件

| 文件 | 职责 |
|------|------|
| `AlertIndirectPacketDiscoveryService.js` | 判断触发条件、构造 topValues 查询、解析 3 种 API 返回格式、生成 candidates、400 fallback |
| `AlertNarrationContractService.js` | `resolveAlertTimeWindow`(endtime=0 兜底)、`buildPacketInstruction`(AI 指令生成)、`buildTriggerInfo`(触发条件提取) |

---

## 3. 完整流程图

### 3.1 总流程：用户请求 → 最终响应

```
用户: "分析这个告警数据包 <eventId> <start> <end>"
  │
  ├─ Layer 0: napm-openclaw-plugin.remote.js
  │     │
  │     ├─ 检测: isPacketCapturePrompt(prompt) && isAlertEventPrompt(prompt)
  │     │        → activeAlertPacketPrompt = true
  │     │
  │     ├─ 放行: napm-alert-query（原拦截逻辑对告警+数据包做例外）
  │     │
  │     └─ 默认 mode: criteria.eventIds 存在 → mode='detail'（触发 discovery）
  │
  ├─ Layer 1: openclaw-napm-alert-query
  │     │
  │     ├─ [1] validateAlertQuery() → AlertQueryValidator.js
  │     │       └─ normalizeCriteria/Options: start/end, eventIds, discoveryTopCount=5
  │     │
  │     ├─ [2] alertsDetail API → 获取告警原始数据
  │     │       └─ 返回: { id, group, categoryType, linkType, metrics, start, end, period }
  │     │
  │     ├─ [3] normalizeEvent() → AlertNormalizerService.js
  │     │       └─ categoryType → groupType (CATEGORY_TYPE_TO_GROUP_TYPE 映射表)
  │     │
  │     ├─ [4] buildPacketHandoff() → AlertNarrationContractService.js
  │     │       │
  │     │       └─ buildEventPacketHandoff(event, criteria):
  │     │             ├─ linkType=2        → 直接: 按事件 ID
  │     │             ├─ linkType=1 + IP   → 直接: 按 IP
  │     │             └─ shouldDiscover()  → 间接: PENDING 标记 ──┐
  │     │                                                          │
  │     ├─ [5] extractIndirectDiscoveryEvents() ←──────────────────┘
  │     │       └─ 提取 needsDiscovery=true 的事件
  │     │
  │     ├─ [6] discoverForEvents() → AlertIndirectPacketDiscoveryService.js
  │     │       │
  │     │       ├─ shouldDiscover(event)
  │     │       │     └─ categoryType ∈ {14,25,27,29,51,56,63,68}? → true
  │     │       │
  │     │       ├─ buildDiscoveryParams(event, options)
  │     │       │     ├─ groupType1 = event.groupType (从映射表取)
  │     │       │     ├─ groupArgument1 = event.group
  │     │       │     ├─ groupType2/3 = 下钻路径 (DISCOVERY_GROUP_CHAIN_MAP)
  │     │       │     ├─ topMetric = event.metrics[0] 或 defaultTopMetric
  │     │       │     ├─ topCount = discoveryTopCount (默认 5)
  │     │       │     └─ start/end = criteriaStart/criteriaEnd (用户提供)
  │     │       │
  │     │       ├─ api.getJsonByParams('topValues', params)
  │     │       │     └─ NAPM API: type=topValues&numGroups=3&groupType1=...&start=...&end=...
  │     │       │
  │     │       ├─ parseTopValuesResult(rawData, categoryType)
  │     │       │     ├─ 格式1: { topValues: [{key, metricValues}] }
  │     │       │     ├─ 格式2: { "IP": value }
  │     │       │     └─ 格式3: [{ group: {argument, key}, groupPath }]
  │     │       │     └─ 解析出 IP 列表 (ip 或 ipPair 格式)
  │     │       │
  │     │       └─ 400 fallback:
  │     │             ├─ 去掉 groupArgument1 重试
  │     │             ├─ 直接提取对象名列表
  │     │             └─ → ALERT_INDIRECT_DISCOVERY_OBJECT_NOT_FOUND + hint
  │     │
  │     ├─ [7] mergeIndirectDiscoveryResult()
  │     │       └─ PENDING 标记 → 替换为实际 discovery 结果
  │     │
  │     ├─ [8] buildNarrationInput(result)
  │     │       ├─ packetHandoff
  │     │       ├─ packetInstruction = buildPacketInstruction(packetHandoff, triggerInfo)
  │     │       │     ├─ USE_CANDIDATES:   callPacketAnalysis=true, candidates[...]
  │     │       │     ├─ STOP_*:          callPacketAnalysis=false, 禁止调 packet-analysis
  │     │       │     └─ USE_DIRECT_QUERY: callPacketAnalysis=true, 直接使用 suggestedPacketQuery
  │     │       └─ triggerInfo: 触发指标/条件/实际值/基线
  │     │
  │     └─ [9] buildReportData(result)
  │
  ├─ Layer 2: Plugin 输出格式化 (napm-openclaw-plugin.remote.js)
  │     │
  │     ├─ buildAlertQueryReply(result) → 生成 AI 可见文本
  │     │     ├─ USE_CANDIDATES → 短指令: "发现 N 个嫌疑 IP，必须逐条调用 napm-packet-analysis"
  │     │     │                   含每个候选的完整 suggestedPacketQuery 参数
  │     │     └─ STOP → 短指令: "无法数据包分析: <原因>"
  │     │
  │     └─ execute() 返回:
  │           ├─ text: 指令文本
  │           ├─ details: 完整原始 JSON
  │           └─ metadata: { candidates, packetInstruction, candidateCount }
  │
  └─ Layer 3: openclaw-napm-packet-analysis
        │
        ├─ 对每个 candidate.suggestedPacketQuery:
        │     mode: preview_download_analyze
        │     criteria: { ips, start: alert.start±120s, end: alert.end±120s }
        │
        ├─ packetsPreview → 预览包大小/风险
        ├─ packetsDown → 下载 .pcap
        └─ tshark → 协议/会话/DNS/HTTP/TLS 分析
```

### 3.2 discoverForEvents 详细流程

```
discoverForEvents(api, events, options)
  │
  ├─ 过滤: events.filter(shouldDiscover)
  │
  ├─ 去重: categoryType::group 相同的只查一次
  │
  └─ 对每个唯一 event:
        │
        └─ discover(api, event, options)
              │
              ├─ buildDiscoveryParams(event, options)
              │     │
              │     ├─ chainConfig = DISCOVERY_GROUP_CHAIN_MAP[categoryType]
              │     ├─ groupType1 = event.groupType (从 CATEGORY_TYPE_TO_GROUP_TYPE 映射表)
              │     ├─ metrics = event.metrics 或 chainConfig.defaultTopMetric
              │     ├─ topMetric = metrics[0]
              │     └─ start/end = event.criteriaStart/criteriaEnd (用户提供)
              │
              ├─ api.getJsonByParams('topValues', queryParams)
              │     │
              │     ├─ 成功 → parseTopValuesResult(rawData, categoryType)
              │     │          ├─ candidates.length > 0 → USE_CANDIDATES
              │     │          └─ candidates.length = 0 → ALERT_INDIRECT_DISCOVERY_EMPTY
              │     │
              │     └─ 失败(400) → fallback:
              │           ├─ 去掉 groupArgument1, numGroups=1
              │           ├─ 直接提取树形格式中的对象名
              │           ├─ 模糊匹配 → OBJECT_NOT_FOUND + hint
              │           └─ fallback 也失败 → ALERT_INDIRECT_DISCOVERY_FAILED
              │
              └─ 生成 candidates + suggestedPacketQuery
                    └─ mode: preview_download_analyze
                       criteria: { ips, start: alert±120s, end: alert±120s }
```

### 3.3 categoryType 映射链

```
alertsDetail API 返回 categoryType (数字)
         │
         ▼
CATEGORY_TYPE_TO_GROUP_TYPE (AlertConstants.js)
  ├─ 14 → 'BusinessGroup'
  ├─ 25 → 'DefinedApp'
  ├─ 27 → 'ConnectedBusinessGroup'
  ├─ 29 → 'BusinessGroupLink'
  ├─ 51 → 'DefinedApp'      (原 OtherApp，修正)
  ├─ 56 → 'OtherApp'
  ├─ 63 → 'PageFamily'
  └─ 68 → 'WebApplication'
         │
         ▼
DISCOVERY_GROUP_CHAIN_MAP (AlertIndirectPacketDiscoveryService.js)
  ├─ 14: IPConversations→IPConversation (TPIO)
  ├─ 25: IPConversations→IPConversation (TPIO)
  ├─ 27: IPConversations→IPConversation (TPIO)
  ├─ 29: IPConversations→IPConversation (TPIO)
  ├─ 51: IPConversations→IPConversation (TPIO)
  ├─ 56: IPConversations→IPConversation (TPIO)
  ├─ 63: ClientIPs→IPAddress (PGNPGE)
  └─ 68: ClientIPs→IPAddress (PGNPGE)
         │
         ▼
buildDiscoveryParams():
  groupType1 = event.groupType (动态，不写死)
  groupArgument1 = event.group (告警对象名)
```

---

## 4. 配置项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `options.packetHandoff` | `true` | 总开关 |
| `options.discoveryEnabled` | `true` | 间接发现子开关 |
| `options.discoveryTopCount` | `5` | 返回的 TopN 候选 IP 数量 |
| `options.packetBufferSeconds` | `120` | 数据包下载前后扩展秒数 |

---

## 5. packetHandoff 结果类型

| reason | available | 含义 |
|--------|-----------|------|
| `ALERT_LINK_TYPE_EVENT_ID` | true | linkType=2，直接按事件 ID 下载 |
| `ALERT_LINK_TYPE_OBJECT_IP` | true | linkType=1 且 group 是 IP |
| `ALERT_INDIRECT_PACKET_VIA_DISCOVERY` | true | 间接发现成功，有候选 IP |
| `ALERT_INDIRECT_DISCOVERY_EMPTY` | false | 间接发现结果为空 |
| `ALERT_INDIRECT_DISCOVERY_FAILED` | false | 间接发现执行出错 |
| `ALERT_INDIRECT_DISCOVERY_OBJECT_NOT_FOUND` | false | 告警对象在 NAPM 不存在（含 fallback hint） |
| `MULTIPLE_ALERT_PACKET_CANDIDATES` | true | 多个告警事件，各有候选 |

---

## 6. packetInstruction 动作

| action | callPacketAnalysis | AI 行为 |
|--------|-------------------|---------|
| `USE_CANDIDATES` | true | 逐条展示候选 IP，用 suggestedPacketQuery 调 packet-analysis |
| `STOP_NO_PACKET` | false | 告知用户"无可关联数据包" |
| `STOP_DISCOVERY_EMPTY` | false | 告知用户"间接发现为空" |
| `STOP_DISCOVERY_FAILED` | false | 告知用户"发现过程出错" |
| `STOP_DISCOVERY_OBJECT_NOT_FOUND` | false | 告知用户"对象在 NAPM 中不存在" + 相似对象列表 |
| `USE_DIRECT_QUERY` | true | 直接使用 suggestedPacketQuery |

---

## 7. 时间窗口策略

| 用途 | 时间来源 | 说明 |
|------|---------|------|
| alertsDetail 查询 | 用户提供的 start/end | 宽窗口确保查到告警 |
| discovery topValues | 用户提供的 start/end | NAPM API 需要足够窗口 |
| packet download | 告警自身 start/end ± 120s | 精确抓取异常时刻 |
| endtime=0 兜底 | start + period 或 start + 300s | resolveAlertTimeWindow |

---

## 8. parseTopValuesResult 支持的格式

```js
// 格式 1: 标准 topValues
{ topValues: [{ key: "10.1.1.5", metricValues: [{ metric: { id: "TPIO" }, value: 892 }] }] }

// 格式 2: 简化键值对
{ "10.1.1.5": 156, "10.2.2.100": 89 }

// 格式 3: 树形 drill-down (IPConversation→IPConversation)
[{ group: { argument: "101.254.114.237|45.79.207.111", key: "IPConversation" }, groupPath: "..." }]
```

---

## 9. 错误处理

| 场景 | 行为 |
|------|------|
| categoryType 不在映射表 | shouldDiscover false → packetHandoff null |
| 告警 metrics 为空 | 使用 defaultTopMetric |
| endtime=0 | resolveAlertTimeWindow: period 或默认 300s |
| topValues 返回空 | ALERT_INDIRECT_DISCOVERY_EMPTY |
| topValues 返回 400 | fallback: 去掉 groupArgument1 → OBJECT_NOT_FOUND + hint |
| fallback 也失败 | ALERT_INDIRECT_DISCOVERY_FAILED |
| API 网络错误 | ALERT_INDIRECT_DISCOVERY_FAILED，不阻断主流程 |

---

## 10. 跨 Skill 路由规则

```
"告警数据包 <eventId>" 请求:
  │
  ├─ Step 1: napm-alert-query (自动，必须)
  │     → mode=detail
  │     → indirect discovery 自动执行
  │     → 返回 packetHandoff + packetInstruction
  │
  └─ Step 2: napm-packet-analysis (按需)
        → 使用 candidate.suggestedPacketQuery
        → mode=preview_download_analyze
        → 预览 → 下载 → tshark 分析

禁止:
  ✗ 直接 napm-packet-analysis with criteria.id (仅 linkType=2 有效)
  ✗ 绕过 alert-query 手动构造 packetQuery
  ✗ packetHandoff=null 时回退到 packet-analysis
```

---

## 11. 部署文件清单

部署到远端 `/home/netinside/.openclaw/workspace/` 时，保证以下文件一致：

| 本地路径 | 远端路径 |
|---------|---------|
| `skills/openclaw-napm-alert-query/services/AlertIndirectPacketDiscoveryService.js` | 同 |
| `skills/openclaw-napm-alert-query/services/AlertNarrationContractService.js` | 同 |
| `skills/openclaw-napm-alert-query/services/AlertConstants.js` | 同 |
| `skills/openclaw-napm-alert-query/services/AlertQueryValidator.js` | 同 |
| `skills/openclaw-napm-alert-query/scripts/run_alert_query.js` | 同 |
| `skills/openclaw-napm-alert-query/SKILL.md` | 同 |
| `skills/openclaw-napm-alert-query/agents/openai.yaml` | 同 |
| `skills/openclaw-napm-alert-query/references/alert-workflow-contract.md` | 同 |
| `skills/openclaw-napm-packet-analysis/SKILL.md` | 同 |
| `skills/openclaw-napm-packet-analysis/agents/openai.yaml` | 同 |
| `napm-openclaw-plugin.remote.js` | `/home/netinside/.openclaw/workspace/` |
