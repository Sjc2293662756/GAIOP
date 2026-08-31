# NAPM Query Workflow Contract

This document contains query-specific workflow rules that belong to `openclaw-napm-query`.

OpenClaw owns natural-language understanding and Query Draft construction. The `napm-skill-query` adapter owns Query Decision evaluation and Query Turn state. This skill receives only complete Resolved Queries and owns normalization, validation, execution, metadata resolution, and result narration input.

## 1. Accepted Scope

Use this skill for:

- NAPM / NetInside metric queries.
- Object inventory and metadata listing.
- Metric inventory and metric ownership questions.
- Drilldown hierarchy and structural path questions.
- Ranking, average, trend, time-series, overview, and comprehensive analysis.
- Chinese explanation of current NAPM query results.

Do not use this skill for:

- Alert summary, timeline, detail, notification-field, or alert-event analysis. Use `openclaw-napm-alert-query`.
- Packet capture or packet-file analysis. Use `openclaw-napm-packet-analysis`.
- Analysis, diagnosis, troubleshooting, or root-cause requests for a specific named business, application, page, or IP. Use `openclaw-napm-fault-diagnosis` whether or not a report is requested.
- Report file generation. Use `openclaw-napm-report`.
- General system operations, deployment, shell, SQL, or unrelated Q&A.

## 2. Structured Input Contract

The production Tool accepts `queryDraft` (with `resolvedQuery` as a migration alias). A Query Draft may omit a value that must come from the user. The adapter evaluates exactly one action:

- `ASK_CLARIFYING_QUESTION`: return `ok=true`, `isError=false`; do not call the Skill or southbound API.
- `EXECUTE_QUERY`: promote the draft to a complete Resolved Query and call the Skill once.
- `REJECT_QUERY`: return a local rejection; do not call the Skill or southbound API.

The standalone Skill CLI still requires a complete `resolvedQuery`.

Accepted input channel:

```json
{
  "queryDraft": {
    "service": "topValues",
    "queryModeKey": "topn",
    "groups": [{ "type": "IPAddress" }],
    "metrics": ["PLI", "PLO"],
    "topMetric": "PLI",
    "topCount": 10,
    "timeRange": {
      "key": "last1hour",
      "displayText": "最近一小时"
    }
  }
}
```

Rules:

- `queryDraft.service` is required. The legacy Tool field `resolvedQuery` is interpreted as the same draft during migration.
- `prompt` and `userQuery` are optional trace fields and must never supply missing query semantics.
- Missing user parameters are not validation errors. For example, a single-object `DefinedApp` trend without `groups[0].argument` returns a clarification terminal outcome.
- Structural corruption, unknown services, invalid time fields, and unsupported modes remain validation failures.
- Relative-time queries provide one concrete supported `timeRange.key`; plugin `execute()` materializes root-level `start` and `end` from the server clock.
- Fixed-time queries provide root-level Unix-second `start` and `end`, aligned to minute boundaries, with `executionOptions.timeMode="fixed"`.
- Never place executable timestamps in `timeRange.start` / `timeRange.end`.
- Placeholder keys such as `lastNminutes` are invalid.
- Missing time in an executable data query is an error, not an implicit default.

Application traffic example:

```json
{
  "prompt": "最近 7 天应用流量趋势如何？",
  "queryDraft": {
    "service": "timeValues",
    "queryModeKey": "timeseries",
    "groups": [{ "type": "DefinedApp" }],
    "metrics": ["TPIO"],
    "granularity": 3600,
    "timeRange": { "key": "last7days" }
  }
}
```

This returns a clarification asking for the concrete application name. It must never be rewritten to `TotalTraffic`.

Bad:

```json
{
  "service": "topValues",
  "timeRange": {
    "start": 1780882620,
    "end": 1780886220
  }
}
```

Good:

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "groups": [{ "type": "IPAddress" }],
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "topCount": 10,
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近一小时"
  }
}
```

## 3. Time Resolution Contract

OpenClaw resolves the user's time semantics to a concrete key or an explicitly fixed range. The plugin `execute()` entry owns relative timestamp materialization.

Time wording:

- `今天` / `today`: Shanghai local-day start `00:00:00`, end at the current server minute. Do not query a future end time.
- `昨天` / `yesterday`: previous local-day start `00:00:00`, previous local-day end `23:59:00`.
- `最近一小时` / `过去一小时`: `last1hour`.
- `最近24小时` / `过去一天` / `最近一天`: `last24hours`.
- Missing time in metric queries: ask for or inherit an explicit time scope; never silently default in the plugin or Skill.

Required hint:

```json
{
  "resolutionHints": {
    "time": {
      "source": "time_range_resolver",
      "key": "last1hour",
      "alignment": "minute_floor"
    }
  }
}
```

Never hard-code example timestamps from previous turns.

## 4. Object Inventory Contract

Inventory wording such as `系统中有哪些...` belongs to metadata listing.

### WebApplication

Plain business wording maps to `WebApplication`:

- `业务`
- `业务系统`
- `Web应用`
- `web应用`
- `网站`
- `站点`

Example:

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "workflowType": "object_inventory"
  },
  "groups": [{ "type": "WebApplication" }]
}
```

Runtime catalog source:

```text
applications Type=3
```

Do not merge `DefinedApp` Type=2 and `WebApplication` Type=3 when the user asks plain `业务`.

### BusinessGroup

Explicit group wording maps to `BusinessGroup`:

- `业务组`
- `工作组`
- `业务分组`
- `BusinessGroup`

Example:

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "workflowType": "object_inventory"
  },
  "groups": [{ "type": "BusinessGroup" }]
}
```

Do not switch plain `业务` to `BusinessGroup` because WebApplication results seem ambiguous or numerous.

### DefinedApp

Explicit defined-application wording maps to `DefinedApp`:

- `已定义应用`
- `服务器应用`
- `已知应用`
- `DefinedApp`

Runtime catalog source:

```text
applications Type=2
```

### CompositeApplication

Explicit auto-recognized application wording maps to `CompositeApplication`:

- `自动识别应用`
- `自动识别的应用`
- `自动识别出来的应用`
- `系统自动识别的应用`
- `复合协议`
- `复合应用`
- `多协议应用`

Runtime catalog source:

```text
applications Type=4
```

Example:

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list",
    "workflowType": "object_inventory"
  },
  "groups": [{ "type": "CompositeApplication" }]
}
```

Do not add `argument: "all"` for full inventory. Full inventory is represented by omitting `argument`.

### BuiltinApplication

Explicit builtin/protocol wording maps to `BuiltinApplication`:

- `内置应用`
- `协议应用`
- `基础协议`

Runtime catalog source:

```text
applications Type=1
```

## 5. Metric Inventory Contract

Metric-inventory wording asks what metrics a dimension supports.

Examples:

```json
{
  "service": "metrics",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list"
  },
  "groups": [{ "type": "WebApplication" }]
}
```

Important distinctions:

- `业务都可以查哪些指标` uses `WebApplication`.
- `工作组都可以查哪些指标` uses `BusinessGroup`.
- Plain `业务` metric inventory should center on Web/page/business metrics such as `PG*`.
- Do not advertise BusinessGroup network metrics under plain `业务` unless the user explicitly says `业务组` / `工作组`.

Reference order when metric ownership is unclear:

1. `references/top-level-metric-ownership.md`
2. `references/metric-category-mapping.md`
3. `references/metric-dimension-ownership.md`

## 6. Drilldown Hierarchy Contract

Hierarchy wording:

- `下钻`
- `钻取`
- `层级`
- `路径`
- `可以往下钻到哪里`
- `支持哪些下钻`

Use `drilldownCatalog`.

Example:

```json
{
  "service": "drilldownCatalog",
  "groups": [{ "type": "BusinessGroup" }],
  "format": "json"
}
```

Rules:

- Answer from current skill result, not from guessed hierarchy.
- The local static groups tree is authoritative for structure when live metadata APIs are blocked.
- Do not inspect a single `children: []` node and conclude that no drilldown exists.
- Do not invent combination paths that are not returned by the current catalog.

## 7. Service Selection

Use these service modes:

- `topValues`: ranking / TopN / 最多 / 最高 / 最严重 / 谁 / 哪个.
- `averageValues`: average / 均值 / 是多少.
- `timeValues`: trend / 走势 / 曲线 / 按时间.
- `overview`: overview / 综合分析 / 状态 / 为什么 / 原因.
- `groups`: object inventory and object metadata.
- `metrics`: metric inventory.
- `drilldownCatalog`: hierarchy and drilldown paths.
- `topValues_multi_protocol`: multi-protocol ranking when explicitly needed.
- `security_refusal`: security-sensitive refusal path when declared by spec.

Ranking rules:

- Singular questions such as `是谁` / `哪个` prefer `topCount=1`.
- `前10个` / `Top10` sets `topCount=10`.
- Discovery steps in composite analysis usually use `topValues`.

## 8. Composite Analysis Contract

Composite asks include:

- `先找最...的对象，再分析它`
- `找到失败最多的地址，然后综合分析`
- `报错最多的是哪个业务，继续分析它`

Workflow:

1. Discover target object.
2. Lock discovered object as analysis focus.
3. Convert final task into focused comprehensive analysis.
4. Return both discovery result and analysis result.

Construction:

```json
{
  "service": "overview",
  "analysisType": "comprehensive_analysis",
  "analysisPipeline": {
    "discoveryQuery": {
      "service": "topValues"
    }
  }
}
```

Keep discovery and focused analysis on the same time range unless the user explicitly changes time.

## 9. Follow-up Contract

OpenClaw owns follow-up understanding.

This skill can consume inherited `sessionState`, but should not independently decide broad conversation policy.

Expected behavior:

- `最近一天呢？` after a metric ranking should inherit object, metric, and service shape, and only change time.
- `这个呢？` should inherit previous object if the referent is unambiguous.
- `继续分析` after a discovery result should use the discovered object as focus.
- If multiple materially different interpretations exist, ask a clarification question.
- After the adapter asks for a concrete object name, a reply such as `HTTP` is merged by OpenClaw into a new Query Draft for the new turn. The stateless Skill does not mutate the previous turn.

Do not answer from stale memory when a fresh query is required.

## 10. Boundary With Other Skills

Alert boundary:

- Any alert summary, alert timeline, alert detail, event-field, notification-field, or alert-event request belongs to `openclaw-napm-alert-query`.

Fault-diagnosis boundary:

- A request belongs to `openclaw-napm-fault-diagnosis` only when it contains both a specific named target and an analysis/diagnosis/troubleshooting/root-cause intent.
- Global ranking/statistics such as “哪个业务报错最多” remain `openclaw-napm-query`.
- Single-metric reads such as “支付业务的400数量” remain `openclaw-napm-query`.
- The presence or absence of a report request does not decide fault-diagnosis routing.

Packet boundary:

- Any request containing `数据包`, `报文`, `抓包`, `pcap`, `cap`, `packetsPreview`, `packetsDown`, `DownServlet`, or `数据包情况` belongs to `openclaw-napm-packet-analysis`.
- Do not reinterpret packet wording as metric query wording.

Report boundary:

- Any request containing `生成报告`, `导出 Word`, `docx`, `PDF`, `将以上整理成文档` belongs to `openclaw-napm-report`, usually after this query skill has produced structured result data.

## 11. Output Contract

The final user-facing answer should be Chinese.

For data answers:

- Include the data time range.
- State object scope and metric scope.
- Prefer skill-returned `displayText` / `summary.displayText` when available.
- If a `requestUrl` is present and the active OpenClaw policy requires debug output, append `Debug API:` with the exact URL.

For metadata answers:

- State the object type and catalog source when helpful.
- Do not claim direct curl/python/raw API probing unless that is the actual executed skill path.

For failures:

- Distinguish no data from execution error.
- Distinguish validation error from southbound API rejection.
- Do not invent successful data when execution failed.

## Metric-Condition Arbitration Addendum

Inventory words such as `有哪些`, `哪些`, `列出`, or `查看` do not always mean metadata inventory.

If the same question contains metric/error/quality evidence such as `400`, `500`, `4xx`, `5xx`, `错误`, `报错`, `异常`, `失败`, `慢`, `响应时间`, `丢包`, `重传`, `吞吐`, or `流量`, classify it as an executable metric query. Metric evidence has higher priority than inventory wording.

### Metric Disambiguation for Error/报错 Terms

When the user uses `报错` / `错误` / `异常` / `失败` / `error` / `failure` without an explicit HTTP status code, the metric must be resolved according to the object scope:

| Object scope | User wording | Default error metrics |
|---|---|---|
| WebApplication / PageFamily | 业务、业务系统、网站、web应用 | `PGHTTP400` + `PGHTTP500` |
| BusinessGroup / IPAddress / Prefix24 | 业务组、工作组、IP、网段 | `RFCI` + `RFCO` |
| DefinedApp / OtherApp | 已定义应用、未知应用 | `RFCI` + `PGHTTP400` |

Hard rules:

1. **Explicit status-code**: `400`/`400错误` → `PGHTTP400`; `500`/`500错误` → `PGHTTP500`; `4xx`/`5xx` → both.
2. **Explicit connection-failure**: `连接失败`/`TCP失败` → `RFCI` (server-side) or `RFCO` (client-side).
3. **Ambiguous 报错 on WebApplication/业务**: default to `PGHTTP400` + `PGHTTP500` (HTTP errors). **Never default to PLI/PLO.**
4. **Ambiguous 报错 on BusinessGroup/业务组**: default to `RFCI` + `RFCO` (connection failures).
5. **PLI/PLO** are packet-loss metrics. Only use them when the user explicitly says `丢包` / `packet loss`.

### Example 1 — explicit HTTP status code

```text
在其他web应用中，有哪些页面出现400错误？
```

Correct resolvedQuery shape:

```json
{
  "service": "topValues",
  "metric": "PGHTTP400",
  "metrics": ["PGHTTP400"],
  "topMetric": "PGHTTP400",
  "groups": [
    { "type": "WebApplication", "argument": "其他Web应用" },
    { "type": "PageFamilies" },
    { "type": "PageFamily" }
  ],
  "semanticConstraints": {
    "workflowType": "metric_topn",
    "targetObjectType": "PageFamily"
  }
}
```

### Example 2 — ambiguous "报错" on business scope

```text
现在哪个业务报错最多？
```

Correct resolvedQuery shape:

```json
{
  "service": "topValues",
  "metric": "PGHTTP400",
  "metrics": ["PGHTTP400", "PGHTTP500"],
  "topMetric": "PGHTTP400",
  "topCount": 10,
  "groups": [
    { "type": "WebApplication" }
  ],
  "semanticConstraints": {
    "workflowType": "metric_topn",
    "targetObjectType": "WebApplication"
  }
}
```

Note: `业务` maps to `WebApplication`. On `WebApplication`, ambiguous `报错` defaults to HTTP error metrics (`PGHTTP400` + `PGHTTP500`), **not PLI/PLO**. The sort metric is `PGHTTP400` unless `500` is explicitly requested.

Do not answer this kind of question by trying `groups` metadata first and then probing alternative paths. The resolvedQuery must encode the target metric, scope, and terminal object path before execution.
