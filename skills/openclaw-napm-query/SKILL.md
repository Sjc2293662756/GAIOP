---
name: openclaw-napm-query
description: Direct OpenClaw NAPM query skill. Use for NAPM or NetInside concept explanations, metadata inventory, metric-ownership and scope questions, structured semantic query execution, ranking/average/trend queries, comprehensive analysis, multi-turn refinements, and result narration. The skill owns structured query execution, metadata resolution, API construction, execution, and Chinese narration contract without relying on the removed gateway layer.
---

# OpenClaw NAPM Direct Query Skill

This skill is the runtime entry for NAPM / NetInside questions. OpenClaw should call this skill directly, provide structured `resolvedQuery`, and let the skill execute NAPM queries and return machine-readable narration input.

Do not route NAPM requests through the removed project gateway layer. Do not depend on `src/routes`, project-level `src/services`, gateway policy, or upstream decision approval before querying.

For detailed query construction, inventory, metric-ownership, drilldown, time, follow-up, and cross-skill boundary rules, load `references/query-workflow-contract.md` when the user request requires semantic construction or troubleshooting of the query flow.

## Skill Boundary

Use this skill for NAPM metric, metadata, inventory, hierarchy, and result-interpretation questions, including:

- 吞吐、流量、丢包、重传、响应时间、连接数、失败数等性能指标查询。
- TopN 排行、均值、趋势、时间序列、综合分析。
- 系统中有哪些业务、业务组、工作组、应用、已定义应用、自动识别应用。
- 某对象支持哪些指标、某对象支持哪些下钻路径。
- 对 NAPM 查询结果进行中文解释和诊断。

Do not use this skill for alert-event queries, packet-capture, targeted fault diagnosis, or report-export tasks:

- 告警摘要、告警时间线、告警详情、告警通知字段 -> use `openclaw-napm-alert-query`.
- 数据包、报文、抓包、原始包、pcap、cap、packetsPreview、packetsDown、DownServlet -> use `openclaw-napm-packet-analysis`.
- 生成报告、导出 Word/docx/PDF、将以上整理成文档 -> use `openclaw-napm-report`.
- **针对具体命名业务、应用、页面或 IP 的分析、诊断、排查和根因请求 -> use `openclaw-napm-fault-diagnosis`，无论用户是否要求报告。** 例如“分析支付web的报错原因”“排查 10.0.0.1 网络慢”。纯排行/统计（如“哪个业务报错最多”）和单指标读取（如“支付业务的400数量”）仍使用本 Skill。

Do not reinterpret packet wording as `topValues`, `timeValues`, `averageValues`, `overview`, `BusinessGroup`, or `DefinedApp` metric queries. For example, `分析 101.254.114.238 最近一天的数据包 数据情况` is not a metric query; it belongs to `openclaw-napm-packet-analysis`.

Object wording contract:

- `业务` / `业务系统` / `Web应用` -> `WebApplication`.
- `业务组` / `工作组` -> `BusinessGroup`.
- `自动识别应用` -> `CompositeApplication`.
- `已定义应用` -> `DefinedApp`.
- Do not merge `DefinedApp` Type=2 and `WebApplication` Type=3 when the user asks plain `业务`.

Core structured-query contract:

- Production execution requires a complete `resolvedQuery`.
- `prompt` and `userQuery` are trace-only. The plugin must never construct, complete, or repair `resolvedQuery` from their text.
- Relative-time queries must provide a concrete supported `timeRange.key`; the plugin `execute()` entry materializes root-level `start` and `end` from the server clock.
- Fixed-time queries must provide minute-aligned root-level `start` and `end` with `executionOptions.timeMode="fixed"`.
- `timeRange.start` / `timeRange.end` are never execution timestamps. Placeholder keys such as `lastNminutes` are invalid.
- Executable data queries without either a supported relative key or valid fixed timestamps must fail; do not assign a default window.
- Object inventory uses `groups` with `queryModeKey="metadata"`.
- Metric inventory uses `metrics` with `queryModeKey="metadata"`.
- Drilldown hierarchy uses `drilldownCatalog`.

## Core Policy

- OpenClaw is the required owner of natural-language understanding, domain boundary judgment, follow-up understanding, clarification policy, and `resolvedQuery` construction.
- The skill consumes executable `resolvedQuery`; it is no longer the formal owner of prompt-to-query parsing, out-of-scope refusal, or redirect guidance in the active runtime.
- `decision` is a trace and guardrail, not an upstream blocking contract.
- Ask a clarification question only when multiple plausible NAPM queries would produce materially different answers.
- Do not answer with "upstream decision failed", "policy blocked", or similar gateway-era wording.
- Do not reuse stale historical data as the current answer when a fresh query fails.
- Every data answer must include the data time range, for example `数据时间：2026-04-29 00:00:00 至 2026-04-30 00:00:00`.
- If `resolvedQuery` is missing, return a Chinese decision-style fallback that asks OpenClaw to finish intent resolution or scope clarification first. Do not silently invent a new query from raw prompt text.

## Direct Architecture

Runtime path:

```text
OpenClaw user request
  -> openclaw-napm-query skill
  -> skill services and scripts
  -> NapmClient
  -> NetInside / NAPM WebService
  -> OpenClaw Chinese narration
```

Skill-owned layers:

1. Structured query normalization
2. Execution guard and validation
3. NAPM API construction and execution
4. Comprehensive analysis query expansion and aggregation
5. Result interpretation and Chinese output

## Workflow

1. Receive `resolvedQuery` and optional session context from OpenClaw.
2. Normalize the structured query into the runtime execution shape.
3. Validate the query and apply execution guardrails.
4. Execute the query through the skill script or OpenClaw tool.
5. Return machine-readable result data and narration input.

## Composite Analysis Chain

For composite asks such as:

- `先找最...的对象，再分析它`
- `找到失败最多的地址，然后综合分析`
- `报错最多的是哪个业务，继续分析它`

use this project-aligned chain:

1. Discover the target object first.
2. Lock the discovered object as the analysis focus.
3. Convert the request into focused comprehensive analysis. The execution service remains `overview` for compatibility.
4. Return Chinese narration with both the discovery result and the focused analysis result.

Construction rules:

- Use outer `service=overview` for the final task, but set semantic naming fields such as `analysisType="comprehensive_analysis"`, `analysisMode`, and `analysisScene`.
- Put the discovery step into `analysisPipeline.discoveryQuery`.
- Prefer `topValues` for discovery when the user is selecting among multiple objects by “谁 / 哪个 / 最高 / 最多 / 最差”.
- Keep the discovery metric aligned with the selection condition.
- If the object is already explicit, skip discovery and go directly to focused comprehensive analysis.
- Keep discovery and focused analysis on the same time range unless the user explicitly changes time.

The skill is not the owner of:

- deciding whether a question is in NAPM scope
- deciding whether a broad question should be refused and redirected
- deciding whether a short follow-up such as `继续` or `需要` should inherit previous context

Those decisions must stay in OpenClaw mainflow.

## Execution Interface

Prefer the OpenClaw tool command `napm-skill-query` when it is available.

Fallback command:

```bash
node skills/openclaw-napm-query/scripts/run_napm_query.js --resolvedQuery "{\"service\":\"groups\",\"queryModeKey\":\"metadata\",\"groups\":[{\"type\":\"WebApplication\"}],\"format\":\"json\"}"
```

Supported payload fields:

- `resolvedQuery`: required fully resolved query
- `prompt`: optional trace and narration text; never a query-construction input
- `session`: optional continuation state
- `sessionState`: optional alias for continuation state
- `decision`: optional hint from OpenClaw
- `intent`: optional structured intent

The executor requires executable `resolvedQuery`. A missing `decision` must not block execution, but a missing or incomplete `resolvedQuery` must return a Chinese fallback contract instead of being reconstructed from `prompt` or exposing low-level English errors to the user.

## Drilldown Hierarchy Questions

For questions such as:

- `IPAddress 支持哪些下钻路径`
- `BusinessGroup 可以往下钻到哪里`
- `有哪些顶层对象，以及各自支持哪些下钻`

prefer the local static groups tree at `config/groups-tree.static.json` as the primary source of truth for structural drill-down hierarchy.

Important rules:

- Do not answer these questions with `403`-style metadata failure wording when the static groups tree is available locally.
- Treat the static tree as authoritative for "structure / hierarchy / reachable paths" questions, even when runtime metadata APIs are blocked.
- Distinguish between:
  - structural drill-down reachability from the group tree
  - runtime executability and metric compatibility, which may still require `metricsForGroup` or live API validation
- When listing paths, prefer runtime-normalized names used by the current skill:
  - normalize `Application` to `DefinedApp` where the runtime has already converged on `DefinedApp`
- If the user asks for all top-level drill-down hierarchies, summarize by top-level object and then list the direct children or common reachable paths rather than only one example.

## Metric Ownership

When the task is asking “这个维度下可以查哪些指标” or “这个指标属于哪个对象”, treat it as a metric-ownership question rather than a plain alias-mapping question.

Use `references/query-workflow-contract.md` as the workflow contract, then read the metric references only as needed:

1. `references/top-level-metric-ownership.md`
2. `references/metric-category-mapping.md`
3. `references/metric-dimension-ownership.md`

Core rule: `groups` decide the query subject; `metrics` decide the value being queried. Final execution must still validate metric compatibility through runtime metadata when available.

## Skill Services

Use the services under `skills/openclaw-napm-query/services/` as the active runtime implementation. These are skill-local capabilities, not the removed gateway layer.

Primary services:

- `RequirementParserService`
- `MetricMappingService`
- `DimensionMappingService`
- `QueryValidator`
- `NapmMetadataService`
- `NapmClient`
- `ClarificationGateService`
- `OpenClawNarrationContractService`

## Semantic Mapping Guardrails

These are known NAPM semantics, not a gateway rule layer. The detailed contract now lives in `references/query-workflow-contract.md`.

High-priority reminders:

- Application inventory truth source is `applications` plus `Type` filtering.
- `groups-tree.static.json` describes hierarchy and must not be used as the application catalog.
- Plain `业务` maps to `WebApplication`, not `BusinessGroup`.
- Explicit `业务组` / `工作组` maps to `BusinessGroup`.
- `自动识别应用` maps to `CompositeApplication`.
- `已定义应用` maps to `DefinedApp`.
- Packet-capture wording belongs to `openclaw-napm-packet-analysis`.
- Report-export wording belongs to `openclaw-napm-report`.
- `报错` / `错误` / `异常` / `失败` (without explicit HTTP/connection context):
  - On `WebApplication` / `业务` → default to `PGHTTP400` + `PGHTTP500` (HTTP error codes). **Never map to `PLI`/`PLO`.**
  - **例外：如果用户指定了具体对象并要求分析、诊断、排查或根因定位，不要拆成多次单指标查询——应使用 `openclaw-napm-fault-diagnosis` 一次性完成；是否要求报告不影响路由。单个指标读取不受影响。**
  - On `BusinessGroup` / `业务组` → default to `RFCI` + `RFCO` (TCP connection failures).
  - On `IPAddress` / `Prefix24` → default to `RFCI` + `RFCO`.
- `丢包` / `packet loss` → `PLI` / `PLO`. Only use these when the user explicitly mentions packet loss.
- `连接失败` / `connection failure` → `RFCI` / `RFCO`.
- `HTTP错误` / `4xx` / `5xx` / `400` / `500` → `PGHTTP400` / `PGHTTP500`.
- For metric disambiguation beyond these explicit guardrails, consult `references/chinese-semantic-metric-mapping.md` — the comprehensive forward-lookup table organized by Chinese semantic domain (报错/慢/流量/丢包/重传/连接/访问/用户体验), with object-context sensitivity and common mapping mistakes to avoid.

## Important Query Examples

`系统中有哪些web应用`

- Intent: inventory
- Object: `WebApplication`
- Expected behavior: return registered Web applications / business systems with Chinese narration

`访问其他web应用次数最多的客户端是谁`

- Service mode: ranking
- Metric: `PGNPGE`
- Groups: `WebApplication("Other Web Application") -> ClientIPs`
- Prefer `topCount=1`

`数据包数量最多的 5 个应用分别是谁`

- Service mode: ranking
- Metric: `PKIO`
- Object: use `DefinedApp` / `Application` unless context says Web application
- `topCount=5`

`101.254.114.238 的服务器响应时间是多少`

- Service mode: average
- Metric: `TRTI`
- Group argument: IP address `101.254.114.238`
- Do not map this wording to `RTTI`

`现在哪个业务报错最多？`

- Service mode: ranking (topValues)
- Object: `WebApplication`（"业务" → WebApplication, not BusinessGroup）
- Metric: `PGHTTP400` + `PGHTTP500`（HTTP error codes, **not PLI/PLO**）
- topMetric: `PGHTTP400`
- `"报错"` on WebApplication defaults to HTTP error status codes. Do not map to `PLI`/`PLO` (packet loss) or `RFCI`/`RFCO` (connection failures) unless the user explicitly mentions those.

## Output Contract

The executor may return a machine payload, but OpenClaw must produce the final user-facing Chinese answer in the same turn.

Preferred output payload:

```json
{
  "ok": true,
  "decision": {},
  "intent": {},
  "resolvedQuery": {},
  "data": [],
  "responseMode": "machine_narration_input",
  "narrationBy": "openclaw",
  "narrationInput": {
    "schema": "openclaw_napm_narration.v1",
    "type": "query_result|decision_result",
    "summary": {},
    "result": {
      "narrationStructure": {}
    },
    "renderPolicy": {},
    "followUp": {}
  },
  "summary": {},
  "error": null
}
```

Narration priority:

1. `narrationInput.result.narrationStructure`
2. `narrationInput.result.timeRange` or `narrationInput.summary.timeRange`
3. structured rows / series / comprehensive analysis data
4. `narrationInput.summary`
5. `displayText` or `replyText` only when narration input is missing

Do not stop at `Groups list completed`, `Average query completed`, raw JSON acknowledgement, or `[object Object]`. Turn returned data into a readable Chinese answer.

Always include the time range represented by the data. If `timeRange.displayText` exists, put it near the beginning of the answer. If the query returned empty data, still say the queried time range.

For empty results, say what was queried: metric, object, time range, and scope. Do not invent an answer from previous runs.

Show debug API URLs only when the runtime explicitly enables that behavior. Always mask credentials.

## Session State

Suggested session state:

```json
{
  "active_domain": "NAPM",
  "active_task_type": null,
  "active_intent_type": null,
  "last_subject": {
    "text": null,
    "kind": null
  },
  "last_time_range": null,
  "last_metric": null,
  "last_groups": [],
  "last_result_available": false,
  "last_action": null,
  "dialog_stage": null,
  "turn_expiry": 3
}
```

Continuation inheritance:

- Inherit subject for time switch, metric switch, view switch, result follow-up, and step-forward turns.
- Inherit time range unless the user explicitly changes time.
- Inherit metric for result follow-up or view switch when no new metric is supplied.
- Inherit group path when the user narrows or expands scope without replacing the subject.
- Inherit result context only when a previous result exists and `turn_expiry > 0`.

## References

Use the `references/` directory progressively. Read only the minimum file needed for the current question.

- [references/source-index.md](./references/source-index.md): reference index
- [references/top-level-metric-ownership.md](./references/top-level-metric-ownership.md): top-level object ownership split between business and non-business metric categories
- [references/metric-definitions.md](./references/metric-definitions.md): metric meanings and aliases
- [references/group-hierarchy.md](./references/group-hierarchy.md): object scope and group hierarchy
- [references/metric-dimension-ownership.md](./references/metric-dimension-ownership.md): which metric families belong to which group dimensions and how to validate them
- [references/service-modes.md](./references/service-modes.md): ranking, average, trend, comprehensive-analysis semantics
- [references/query-construction.md](./references/query-construction.md): final query construction
- [references/runtime-lookup-notes.md](./references/runtime-lookup-notes.md): runtime lookup constraints
- [references/openclaw-integration.md](./references/openclaw-integration.md): OpenClaw invocation notes
- [references/capability-mapping.md](./references/capability-mapping.md): historical capability mapping; ignore any old gateway wording when it conflicts with this direct-skill policy
- [references/chinese-semantic-metric-mapping.md](./references/chinese-semantic-metric-mapping.md): **Chinese semantic keyword → metric code forward-lookup table**; consult this when the user's Chinese wording does not match an explicit guardrail in `agents/openai.yaml`

## Anti-Patterns

- Do not depend on project gateway routes or old `src/services` for NAPM query execution.
- Do not require an upstream planner decision before querying.
- Do not treat service modes (`topValues`, `averageValues`, `timeValues`) as the first-level intent.
- Do not map `Web应用` inventory to the broad protocol `applications` endpoint.
- Do not map `服务器响应时间` to `RTTI`.
- Do not map `数据包数量` to throughput; it is `PKIO`.
- Do not ask for clarification when the semantic target is already clear enough to query.
