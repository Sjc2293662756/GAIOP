# overviewScene 与对象类型映射

版本：v0.1
日期：2026-05-28
适用范围：NAPM 主链路语义构造、功能一复杂分析、元数据清单、普通排行查询

关联文档：

- `docs/2026-05-26-功能一复杂问题分析准备材料与实施指南.md`
- `docs/功能一-复杂分析场景与问法样例.md`
- `docs/功能一-分析意图到指标组合映射表.md`
- `docs/analysisPipeline-discoveryQuery契约.md`
- `config/object-ontology.v1.json`

---

## 1. 文档目标

本文档统一回答四个问题：

- 用户说“业务、业务组、应用、自动识别应用、IP、网段”时，应该落到哪个标准对象类型。
- 标准对象类型在元数据清单、指标查询、overview 分析中分别怎么执行。
- `overviewScene` 应该如何由对象类型和问题意图确定。
- 哪些词不能混用，避免主链路再次漂移。

本文档不是兜底规则，而是 OpenClaw 构造 `resolvedQuery` 时必须遵守的语义契约。

---

## 2. 总体原则

### 2.1 对象类型优先

复杂分析和 overview 查询中，先确定对象类型，再选择 `overviewScene`。

```text
用户表达 -> canonical objectType -> workflow/service -> overviewScene
```

不能先看到“业务”两个字就猜 `BusinessGroup`，也不能因为 `applications` 接口能返回多类应用，就把 `WebApplication`、`DefinedApp`、`CompositeApplication` 合并输出。

### 2.2 inventory 与 overview 分离

```text
系统中有哪些业务？
```

是元数据清单查询，使用 `groups + metadata`。

```text
某业务整体情况怎么样？
```

是聚焦分析查询，使用 `overview`。

二者不能互相替代。

### 2.3 时间只属于执行查询

元数据清单和下钻目录通常不需要时间。

排行、趋势、平均值、overview、analysisPipeline 需要时间，并且 `start/end` 必须由 `napm-resolve-time-range` 生成。

---

## 3. 标准对象口径

| 用户表达 | canonical objectType | 含义 | 元数据 provider | provider 过滤 | 默认 overviewScene | 备注 |
|---|---|---|---|---|---|---|
| 业务、业务系统、Web 应用、网站、站点 | `WebApplication` | NAPM 业务系统 / Web 应用 | `applications` | `Type=3` | `business` | 普通“业务”默认是它，不是业务组 |
| 工作组、业务组、业务分组 | `BusinessGroup` | NAPM 业务组 / 工作组 | `businessGroups` | 无 | `business_group` | 只有显式说业务组/工作组才使用 |
| 已定义应用、已知应用、服务器应用、协议应用 | `DefinedApp` | 人工定义或已知应用 | `applications` | `Type=2` | `application` | 不等同 WebApplication |
| 自动识别应用、特征识别应用、复合协议、复合应用、多协议应用 | `CompositeApplication` | 自动识别的复合协议应用 | `applications` | `Type=4` | 通常不进 overview | 多数是元数据清单 |
| 内置协议、协议、HTTP、DNS、SSH 等 | `BuiltinApplication` / `DefinedApp` 视链路而定 | 内置协议应用 | `applications` | `Type=1` | `application` | 查询清单时需明确口径 |
| IP、IP 地址、地址、主机、客户端 IP、服务端 IP | `IPAddress` | IP 地址维度 | `groupArguments` | 对应 argumentType | `network` | 普通网络排行常用对象 |
| 网段、子网、/24、Prefix24 | `Prefix24` | /24 网段维度 | `groupArguments` | 对应 argumentType | `network` | 网络质量、流量聚合常用 |
| 会话、连接、对端连接 | `IPConversation` | IP 会话维度 | `groupArguments` | 对应 argumentType | `network` | 常用于连接和对端分析 |
| 系统、整体、全局 | `TotalTraffic` / `system` | 系统整体 | 无或聚合查询 | 无 | `system` | 通常不作为实例清单对象 |

---

## 4. 关键歧义处理

### 4.1 “业务”

普通“业务”固定为：

```json
{
  "objectType": "WebApplication",
  "metadataProvider": "applications",
  "applicationTypeFilter": [3],
  "overviewScene": "business"
}
```

示例：

```text
系统中有哪些业务？
```

应构造：

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "WebApplication"
  },
  "groups": [
    { "type": "WebApplication" }
  ],
  "format": "json"
}
```

禁止：

- 改查 `BusinessGroup`。
- 合并 `Type=2` 和 `Type=3`。
- 按中文字符过滤。
- 按近期是否有流量过滤。
- 用 `overview` 或 `drilldownCatalog` 替代清单查询。

### 4.2 “业务组 / 工作组”

显式出现以下表达时才是 `BusinessGroup`：

```text
业务组、工作组、业务分组、BusinessGroup、business group
```

示例：

```text
系统中有哪些工作组？
```

应构造：

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "BusinessGroup"
  },
  "groups": [
    { "type": "BusinessGroup" }
  ],
  "format": "json"
}
```

### 4.3 “应用”

单独说“应用”是歧义词，不能直接默认到 `applications` 全量。

需要区分：

| 用户说法 | objectType | provider 过滤 |
|---|---|---|
| 已定义应用 / 已知应用 / 服务器应用 / 协议应用 | `DefinedApp` | `Type=2` |
| 自动识别应用 / 复合应用 / 复合协议 | `CompositeApplication` | `Type=4` |
| 业务应用 / Web 应用 / 业务系统 | `WebApplication` | `Type=3` |
| 内置协议 / 系统协议 | `BuiltinApplication` | `Type=1` |

如果用户只问：

```text
系统中有哪些应用？
```

应澄清口径，而不是返回 `applications` 全量，也不是混合四类应用。

### 4.4 “自动识别的应用”

固定为 `CompositeApplication` 清单查询。

应构造：

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "CompositeApplication"
  },
  "groups": [
    { "type": "CompositeApplication" }
  ],
  "format": "json"
}
```

禁止携带：

```json
{
  "argument": "all"
}
```

全量清单用省略 `argument` 表示，不能把 `all` 当关键词过滤。

---

## 5. overviewScene 映射

### 5.1 默认映射表

| objectType | 默认 overviewScene | 适用问题 |
|---|---|---|
| `WebApplication` | `business` | 业务慢、业务异常、HTTP 错误、访问体验 |
| `BusinessGroup` | `business_group` | 工作组整体情况、业务组连接失败、业务组网络质量 |
| `DefinedApp` | `application` | 已定义应用吞吐、协议应用异常、应用连接失败 |
| `CompositeApplication` | `application` | 仅在后续支持复合应用分析时使用；当前主要是 metadata |
| `BuiltinApplication` | `application` | 协议应用流量、协议失败排行 |
| `IPAddress` | `network` | IP 丢包、连接失败、吞吐、时延 |
| `Prefix24` | `network` | 网段流量、网段丢包、网络质量 |
| `IPConversation` | `network` | 会话质量、对端连接、会话吞吐 |
| `TotalTraffic` | `system` | 系统整体风险、全局健康、整体概览 |

### 5.2 意图覆盖规则

对象类型和意图可能共同影响 `overviewScene`。

| 用户问题 | objectType | overviewScene | 说明 |
|---|---|---|---|
| 可观测239web 为什么慢？ | `WebApplication` | `business` | 业务体验分析 |
| Default-Internet 工作组整体情况怎么样？ | `BusinessGroup` | `business_group` | 工作组综合分析 |
| 回溯238 这个已定义应用流量异常吗？ | `DefinedApp` | `application` | 应用维度分析 |
| 丢包最严重的 IP 是谁，为什么？ | `IPAddress` | `network` | 网络质量分析 |
| 最近哪个网段网络质量最差？ | `Prefix24` | `network` | 网络维度分析 |
| 现在系统整体有没有风险？ | `TotalTraffic` | `system` | 全局概览 |

---

## 6. service 选择规则

| 问题类型 | service | 是否需要 start/end | 示例 |
|---|---|---|---|
| 对象清单 | `groups` + `metadata` | 否 | 系统中有哪些业务？ |
| 指标清单 | `metrics` | 否 | 业务都可以查哪些指标？ |
| 下钻路径 | `drilldownCatalog` | 否 | 业务组可以往下钻到哪里？ |
| TopN 排行 | `topValues` | 是 | 最近一小时丢包最高的前 10 个 IP |
| 平均值 | `averageValues` | 是 | 某业务平均响应时间是多少？ |
| 趋势 | `timeValues` | 是 | 某 IP 最近一小时流量趋势 |
| 综合分析 | `overview` | 是 | 某业务为什么慢？ |
| 先发现再分析 | `overview` + `analysisPipeline.discoveryQuery` | 是 | 找连接失败最多的地址并分析 |

---

## 7. 标准 resolvedQuery 示例

### 7.1 业务清单

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "WebApplication"
  },
  "groups": [
    { "type": "WebApplication" }
  ],
  "format": "json"
}
```

### 7.2 工作组清单

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "BusinessGroup"
  },
  "groups": [
    { "type": "BusinessGroup" }
  ],
  "format": "json"
}
```

### 7.3 已定义应用清单

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "DefinedApp"
  },
  "groups": [
    { "type": "DefinedApp" }
  ],
  "format": "json"
}
```

### 7.4 自动识别应用清单

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "targetObjectType": "CompositeApplication"
  },
  "groups": [
    { "type": "CompositeApplication" }
  ],
  "format": "json"
}
```

### 7.5 业务慢分析

```json
{
  "service": "overview",
  "queryModeKey": "overview",
  "overviewScene": "business",
  "groups": [
    { "type": "WebApplication", "argument": "可观测239web" }
  ],
  "start": "<from napm-resolve-time-range>",
  "end": "<from napm-resolve-time-range>",
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "format": "json"
}
```

### 7.6 IP 丢包 TopN

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "groups": [
    { "type": "IPAddress" }
  ],
  "metrics": ["PLI", "PLO"],
  "topMetric": "PLI",
  "topCount": 10,
  "start": "<from napm-resolve-time-range>",
  "end": "<from napm-resolve-time-range>",
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "format": "json"
}
```

---

## 8. 禁止漂移清单

以下行为必须禁止：

- “系统中有哪些业务”漂移到 `BusinessGroup`。
- “系统中有哪些业务”输出 `Type=2 + Type=3` 混合结果。
- “系统中有哪些应用”不澄清，直接返回 `applications` 全量。
- “自动识别应用”走 `overview.auto_apps` 返回吞吐排行。
- “自动识别应用”查询中携带 `argument:"all"` 并被当成关键词过滤。
- 元数据清单问题为了拿数据改走临时脚本、curl、Python 过滤。
- overview 问题缺少对象时编造对象。
- 普通 TopN 问题被误改成 overview。
- 复杂分析问题只返回 TopN，不执行 focused overview。
- 模型手算 Unix 时间戳。

---

## 9. 验收用例

| 编号 | 用户问题 | 期望 objectType | 期望 service | 期望 overviewScene |
|---|---|---|---|---|
| OT001 | 系统中有哪些业务？ | `WebApplication` | `groups` | 无 |
| OT002 | 系统中有哪些业务组？ | `BusinessGroup` | `groups` | 无 |
| OT003 | 系统中有哪些工作组？ | `BusinessGroup` | `groups` | 无 |
| OT004 | 系统中有哪些已定义应用？ | `DefinedApp` | `groups` | 无 |
| OT005 | 系统中有哪些自动识别的应用？ | `CompositeApplication` | `groups` | 无 |
| OT006 | 可观测239web 为什么慢？ | `WebApplication` | `overview` | `business` |
| OT007 | Default-Internet 工作组整体情况怎么样？ | `BusinessGroup` | `overview` | `business_group` |
| OT008 | 最近一小时丢包最高的前 10 个 IP | `IPAddress` | `topValues` | 无 |
| OT009 | 丢包最严重的 IP 是谁，为什么？ | `IPAddress` | `overview + discoveryQuery` | `network` |
| OT010 | 哪个业务 HTTP 500 最严重，并分析原因？ | `WebApplication` | `overview + discoveryQuery` | `business` |

每条用例都需要断言：

- 对象类型不漂移。
- service 不漂移。
- 元数据清单不携带时间。
- 执行查询必须使用 `napm-resolve-time-range` 生成 `start/end`。
- `overviewScene` 与对象类型一致。

