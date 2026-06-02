# analysisPipeline.discoveryQuery 契约

版本：v0.1
日期：2026-05-28
适用范围：功能一“先发现对象，再聚焦分析”链路
关联文档：

- `docs/2026-05-26-功能一复杂问题分析准备材料与实施指南.md`
- `docs/功能一-复杂分析场景与问法样例.md`
- `docs/功能一-分析意图到指标组合映射表.md`

---

## 1. 目标

`analysisPipeline.discoveryQuery` 用于表达这类复杂问题：

```text
先找出某类对象中最异常/最多/最慢/最差的对象，然后对该对象做综合分析。
```

典型问题：

```text
找到连接失败最多的地址，然后分析它。
哪个业务 HTTP 500 最严重，并分析原因？
丢包最严重的 IP 是谁，为什么？
最近哪个业务系统最异常？
```

该契约的核心目标：

- discovery 负责找对象。
- focused overview 负责分析对象。
- 两步共享同一时间范围。
- discovery 结果必须显式绑定到 focused overview。
- discovery 查不到对象时不能编造对象。

---

## 2. 链路位置

功能一主链：

```text
OpenClaw 理解用户问题
  -> 调用 napm-resolve-time-range 生成 start/end
  -> 构造 overview resolvedQuery + analysisPipeline.discoveryQuery
  -> 调用 napm-skill-query
  -> skill 先执行 discoveryQuery
  -> 从 discovery 结果提取目标对象
  -> 绑定到 focused overview groups
  -> 执行 overview
  -> 归并 discovery + overview
  -> narration contract 输出中文分析
```

---

## 3. 适用范围

### 3.1 适用问题

适用：

```text
找到连接失败最多的地址，然后分析它。
先找出最慢的业务，再看为什么慢。
哪个业务 HTTP 500 最严重？分析原因。
最近丢包最严重的 IP 是谁，为什么？
哪些业务系统异常，挑最严重的分析一下。
```

不适用：

```text
最近一小时丢包最高的前 10 个 IP。
某 IP 的吞吐是多少？
系统中有哪些业务？
业务有哪些下钻路径？
```

这些是普通 TopN、average、metadata 或 drilldown 查询，不需要 discovery + focused overview。

### 3.2 触发条件

满足任意一类即可触发：

- 用户明确说“先找……再分析……”。
- 用户问“哪个/谁/哪一个最……，为什么/分析原因”。
- 用户问“最异常/最严重/最差对象”，且期望输出不是单纯排行，而是原因分析。
- 用户没有给对象，但要求对具体对象做综合分析。

---

## 4. 顶层 resolvedQuery 结构

`analysisPipeline.discoveryQuery` 必须挂在 `service=overview` 的顶层 resolvedQuery 中。

```json
{
  "service": "overview",
  "queryModeKey": "overview",
  "overviewScene": "network",
  "analysisPipeline": {
    "targetObjectType": "IPAddress",
    "selection": {
      "rank": 1
    },
    "discoveryQuery": {
      "service": "topValues",
      "queryModeKey": "topn",
      "groups": [
        { "type": "IPAddress" }
      ],
      "metrics": ["RFCI"],
      "topMetric": "RFCI",
      "topCount": 1
    }
  },
  "start": 1779948420,
  "end": 1779952020,
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "resolutionHints": {
    "time": {
      "source": "time_range_resolver",
      "key": "last1hour",
      "alignment": "minute_floor"
    }
  },
  "format": "json"
}
```

---

## 5. 字段契约

### 5.1 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `service` | 是 | 必须为 `overview` |
| `queryModeKey` | 是 | 建议为 `overview` |
| `overviewScene` | 是 | `system` / `business` / `business_group` / `application` / `network` / `security` |
| `start` | 是 | 根层级 Unix 秒，由 `napm-resolve-time-range` 生成 |
| `end` | 是 | 根层级 Unix 秒，由 `napm-resolve-time-range` 生成 |
| `timeRange` | 是 | 声明性元数据，只放 `key/displayText` |
| `analysisPipeline` | 是 | 复合分析计划 |
| `format` | 是 | 建议 `json` |

### 5.2 analysisPipeline 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `targetObjectType` | 是 | discovery 要找出的最终对象类型 |
| `selection.rank` | 是 | 默认 `1`，表示选 Top1 |
| `discoveryQuery` | 是 | 找对象的 TopN 查询 |
| `bindDiscoveryResultTo` | 否 | 后续可扩展，默认绑定到 overview `groups[0].argument` |
| `failurePolicy` | 否 | 后续可扩展，默认 `return_no_target` |

### 5.3 discoveryQuery 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `service` | 是 | 首版只支持 `topValues` |
| `queryModeKey` | 是 | 建议 `topn` |
| `groups` | 是 | 必须只有一个主对象维度，且与 `targetObjectType` 一致 |
| `metrics` | 是 | discovery 指标数组 |
| `topMetric` | 是 | 排序指标，必须来自 `metrics` |
| `topCount` | 是 | 首版建议为 `1` |

### 5.4 禁止字段

`discoveryQuery` 中禁止放：

```json
{
  "start": 1779948420,
  "end": 1779952020,
  "timeRange": {
    "key": "last1hour"
  }
}
```

原因：

- discovery 和 overview 必须复用顶层时间。
- 时间只允许由顶层 resolvedQuery 管理，避免两步时间不一致。

---

## 6. 时间规则

### 6.1 构造规则

OpenClaw 必须先调用：

```text
napm-resolve-time-range
```

拿到：

```json
{
  "start": 1779948420,
  "end": 1779952020,
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "resolutionHints": {
    "time": {
      "source": "time_range_resolver"
    }
  }
}
```

再把这些字段写入 overview 顶层。

### 6.2 执行规则

skill 执行时：

```text
discoveryQuery.start = top-level start
discoveryQuery.end   = top-level end
focused overview start/end = top-level start/end
```

### 6.3 禁止规则

- 不允许模型手算 Unix 时间戳。
- 不允许 discoveryQuery 自带不同时间。
- 不允许 `timeRange.start/end` 替代根级 `start/end`。
- 不允许复用历史轮次的 start/end，除非用户明确要求沿用上轮时间。

---

## 7. 对象绑定规则

### 7.1 discovery 结果提取

discovery 执行后，从 TopN 第一条中提取对象参数。

候选字段优先级：

```text
row.group.argument
row.group.value
row.group.label
row.groupPath 最末级可执行 argument
```

### 7.2 focused overview 绑定

绑定后的 focused overview 等价于：

```json
{
  "service": "overview",
  "overviewScene": "network",
  "groups": [
    {
      "type": "IPAddress",
      "argument": "101.254.114.237"
    }
  ],
  "start": 1779948420,
  "end": 1779952020
}
```

### 7.3 一致性规则

- `analysisPipeline.targetObjectType` 必须等于 `discoveryQuery.groups[0].type`。
- 绑定后的 `groups[0].type` 必须等于 `targetObjectType`。
- 如果 discovery 结果不能提取 argument，必须返回“未锁定明确对象”。
- 不能把 `WebApplication` discovery 结果绑定成 `BusinessGroup`。

---

## 8. overviewScene 映射规则

| targetObjectType | 默认 overviewScene | 说明 |
|---|---|---|
| `WebApplication` | `business` | 业务系统、Web 应用、站点 |
| `BusinessGroup` | `business_group` | 工作组、业务组 |
| `DefinedApp` | `application` | 已定义应用、协议应用 |
| `IPAddress` | `network` | IP、地址、主机 |
| `Prefix24` | `network` | 网段 |
| `IPConversation` | `network` | 会话、对端连接 |
| `TotalTraffic` | `system` | 系统整体 |

如果用户表达和对象类型冲突，以对象类型为主，并在必要时澄清。

---

## 9. 标准场景模板

### T001：连接失败最多的 IP 并分析

用户：

```text
找到连接失败最多的地址，然后分析它。
```

模板：

```json
{
  "service": "overview",
  "queryModeKey": "overview",
  "overviewScene": "network",
  "analysisPipeline": {
    "targetObjectType": "IPAddress",
    "selection": {
      "rank": 1
    },
    "discoveryQuery": {
      "service": "topValues",
      "queryModeKey": "topn",
      "groups": [
        { "type": "IPAddress" }
      ],
      "metrics": ["RFCI"],
      "topMetric": "RFCI",
      "topCount": 1
    }
  },
  "start": "<from napm-resolve-time-range>",
  "end": "<from napm-resolve-time-range>",
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "format": "json"
}
```

### T002：HTTP 500 最严重业务并分析

用户：

```text
哪个业务 HTTP 500 最严重，并分析原因？
```

模板：

```json
{
  "service": "overview",
  "queryModeKey": "overview",
  "overviewScene": "business",
  "analysisPipeline": {
    "targetObjectType": "WebApplication",
    "selection": {
      "rank": 1
    },
    "discoveryQuery": {
      "service": "topValues",
      "queryModeKey": "topn",
      "groups": [
        { "type": "WebApplication" }
      ],
      "metrics": ["PGHTTP500"],
      "topMetric": "PGHTTP500",
      "topCount": 1
    }
  },
  "start": "<from napm-resolve-time-range>",
  "end": "<from napm-resolve-time-range>",
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "format": "json"
}
```

### T003：丢包最严重 IP 并分析

用户：

```text
丢包最严重的 IP 是谁，为什么？
```

模板：

```json
{
  "service": "overview",
  "queryModeKey": "overview",
  "overviewScene": "network",
  "analysisPipeline": {
    "targetObjectType": "IPAddress",
    "selection": {
      "rank": 1
    },
    "discoveryQuery": {
      "service": "topValues",
      "queryModeKey": "topn",
      "groups": [
        { "type": "IPAddress" }
      ],
      "metrics": ["PLI", "PLO"],
      "topMetric": "PLI",
      "topCount": 1
    }
  },
  "start": "<from napm-resolve-time-range>",
  "end": "<from napm-resolve-time-range>",
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  },
  "format": "json"
}
```

### T004：最慢业务并分析

用户：

```text
哪个业务系统最慢，分析一下。
```

模板：

```json
{
  "service": "overview",
  "queryModeKey": "overview",
  "overviewScene": "business",
  "analysisPipeline": {
    "targetObjectType": "WebApplication",
    "selection": {
      "rank": 1
    },
    "discoveryQuery": {
      "service": "topValues",
      "queryModeKey": "topn",
      "groups": [
        { "type": "WebApplication" }
      ],
      "metrics": ["PGTME"],
      "topMetric": "PGTME",
      "topCount": 1
    }
  },
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

## 10. 失败处理契约

### 10.1 discovery 无数据

返回要求：

```text
本次未在指定时间范围内发现符合条件的对象，因此没有进入聚焦分析。
查询对象：IPAddress
排序指标：RFCI
时间范围：最近一小时
```

禁止：

```text
沿用上轮对象。
编造一个对象。
把空结果解释成系统一定正常。
```

### 10.2 discovery 查询失败

返回要求：

```text
先说明 discovery 查询失败。
给出失败阶段：discoveryQuery。
给出错误原因或边界校验原因。
不继续执行 focused overview。
```

### 10.3 focused overview 失败

返回要求：

```text
保留 discovery 发现结果。
说明已锁定对象，但聚焦分析失败。
给出失败原因。
不编造分析结论。
```

### 10.4 语义不完整

如果用户问：

```text
找最严重的，然后分析。
```

但没有说明“什么最严重”，应澄清：

```text
你想按哪个方向找最严重对象：连接失败、丢包、HTTP 错误、响应时间，还是流量？
```

---

## 11. 输出契约

复合分析输出至少包含：

```text
1. 发现对象
2. 发现依据
3. 聚焦分析结论
4. 关键证据
5. 时间范围
6. 建议动作
```

推荐结构：

```text
发现结果：
连接失败最多的 IP 是 101.254.114.237，按 RFCI 排名第 1。

分析结论：
该 IP 的异常主要集中在连接失败，伴随连接请求增加和建连耗时升高。

关键证据：
- RFCI：...
- CONI：...
- CSTI：...

建议动作：
优先检查该 IP 的对端会话、关联应用和防火墙/服务端连接限制。

数据时间：
最近一小时，2026-05-28 14:07 至 15:07。
```

---

## 12. 验收测试建议

首批测试用例：

| 测试编号 | 用户问题 | 预期 |
|---|---|---|
| AT001 | 找到连接失败最多的地址，然后分析它 | 构造 network overview + IPAddress/RFCI discovery |
| AT002 | 哪个业务 HTTP 500 最严重，并分析原因 | 构造 business overview + WebApplication/PGHTTP500 discovery |
| AT003 | 丢包最严重的 IP 是谁，为什么 | 构造 network overview + IPAddress/PLI discovery |
| AT004 | 哪个业务系统最慢，分析一下 | 构造 business overview + WebApplication/PGTME discovery |
| AT005 | 找最严重的，然后分析 | 不构造查询，要求澄清严重方向 |

每个测试需要断言：

- `service === "overview"`。
- `analysisPipeline.discoveryQuery.service === "topValues"`。
- `analysisPipeline.targetObjectType` 与 `discoveryQuery.groups[0].type` 一致。
- 顶层存在 `start/end`。
- `discoveryQuery` 内部不携带 `start/end`。
- `resolutionHints.time.source === "time_range_resolver"`。

