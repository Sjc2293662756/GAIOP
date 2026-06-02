---
name: openclaw-napm-query
description: Direct OpenClaw NAPM query skill. Use for NAPM or NetInside concept explanations, metadata inventory, metric-ownership and scope questions, structured semantic query execution, ranking/average/trend queries, comprehensive analysis, multi-turn refinements, and result narration. The skill owns structured query execution, metadata resolution, API construction, execution, and Chinese narration contract without relying on the removed gateway layer.
---

# OpenClaw NAPM Direct Query Skill

This skill is the runtime entry for NAPM / NetInside questions. OpenClaw should call this skill directly, provide structured `resolvedQuery`, and let the skill execute NAPM queries and return machine-readable narration input.

Do not route NAPM requests through the removed project gateway layer. Do not depend on `src/routes`, project-level `src/services`, gateway policy, or upstream decision approval before querying.

## Core Policy

- OpenClaw is the required owner of natural-language understanding, domain boundary judgment, follow-up understanding, clarification policy, and `resolvedQuery` construction.
- The skill consumes executable `resolvedQuery`; it is no longer the formal owner of prompt-to-query parsing, out-of-scope refusal, or redirect guidance in the active runtime.
- `decision` is a trace and guardrail, not an upstream blocking contract.
- Ask a clarification question only when multiple plausible NAPM queries would produce materially different answers.
- Do not answer with "upstream decision failed", "policy blocked", or similar gateway-era wording.
- Do not reuse stale historical data as the current answer when a fresh query fails.
- Every data answer must include the data time range, for example `数据时间�?026-04-29 00:00:00 �?2026-04-30 00:00:00`.
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
- Prefer `topValues` for discovery when the user is selecting among multiple objects by “谁 / 哪个 / 最�?/ 最�?/ 最差�?
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
node skills/openclaw-napm-query/scripts/run_napm_query.js --resolvedQuery "{\"service\":\"groups\",\"groups\":[{\"type\":\"WebApplication\"}],\"format\":\"json\"}"
```

Supported payload fields:

- `resolvedQuery`: required fully resolved query
- `session`: optional continuation state
- `sessionState`: optional alias for continuation state
- `decision`: optional hint from OpenClaw
- `intent`: optional structured intent

The executor requires executable `resolvedQuery`. A missing `decision` must not block execution, but a missing `resolvedQuery` must return a Chinese fallback contract instead of exposing low-level English errors to the user.

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

When the task is really asking "这个维度下该用什么指�?, treat it as a metric-ownership question rather than a plain alias-mapping question.

Important rules:

- `groups` decide the query subject; `metrics` decide the value being queried.
- Semantic categories such as `业务数据`, `网络流量数据`, `连接数据`, `应用性能数据` are explanatory groupings, not legal `groupType`.
- Use static ownership rules only to choose candidates. Final execution must still validate metric compatibility through `metricsForGroup` or `NapmMetadataService.getMetricsForGroupPath()`.
- Distinguish throughput metrics such as `TPIO` from byte-volume metrics such as `BYTIO`.
- Distinguish server-side metrics such as `CONI`, `CCNI`, `RFCI`, `TRTI` from client-side metrics such as `CONO`, `CCNO`, `RFCO`, `TRTO`.
- Prefer `PG*` metrics for `WebApplication` / `PageFamily` / `User`, and prefer generic traffic / network / connection metrics for `TotalTraffic` / `IPAddress` / `IPConversation` / `BusinessGroup` unless runtime metadata says otherwise.
- Treat plain `业务都可以查哪些指标` and similar metric-inventory wording as a strict `WebApplication` ownership answer. Do not advertise `PLI`, `PLO`, `RTTI`, `RTTO`, `RDTI`, `RDTO`, `RTXI`, `RTXO`, `CONI`, `CCNI`, `RFCI`, `TPIO`, or `BYTIO` under plain `业务` unless the user explicitly asked for `业务组` / `工作组` or clearly changed scope away from `WebApplication`.
- For plain `业务` / `业务系统` / `WebApplication`, user-facing metric lists should stay centered on `PG*` page/business metrics plus page optimization metrics, even if runtime metadata also exposes broader cross-domain metrics.
- If the user is asking `某个指标分类下有哪些指标` or `某个分类对应哪些 metric code`, read `references/metric-category-mapping.md` as the primary category-to-code table.
- When ownership or compatibility is unclear, read `references/top-level-metric-ownership.md` first, then `references/metric-category-mapping.md`, then `references/metric-dimension-ownership.md` before constructing the final query.

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

These are known NAPM semantics, not a gateway rule layer. Use them to avoid common wrong API construction. For application inventory, `applications` plus `Type` filtering is the truth source; `groups-tree.static.json` only describes hierarchy and must not be used as the application catalog.

### Object / Dimension

- `业务组`, `工作组`, `业务分组` -> `BusinessGroup`
- `Web应用`, `web应用`, `网站`, `站点`, `业务系统` -> `WebApplication`
- Plain `业务` usually means `WebApplication` unless the user explicitly says `业务组`
- `业务都可以查哪些指标` should be answered from the `WebApplication` view, not the `BusinessGroup` view
- Plain `应用` / `系统中有哪些应用` is ambiguous; do not answer it from groups-tree `Application` nodes or raw full `applications` catalog. Clarify into WebApplication(Type=3), DefinedApp(Type=2), BuiltinApplication(Type=1), CompositeApplication(Type=4), or OtherApp.
- `已定义应用`, `服务器应用`, `协议应用` -> `DefinedApp` from `applications Type=2`
- `自动识别应用`, `自动识别的应用`, `自动识别出来的应用`, `系统自动识别的应用`, `特征识别应用`, `复合协议`, `复合应用`, `多协议应用` -> `CompositeApplication` from `applications Type=4`
- `客户端`, `客户端IP` -> `ClientIPs`
- `服务端`, `服务端IP`, explicit IP address -> `IPAddress` or server-side IP dimension according to query path
- `其他web应用`, `其它web应用`, `未注册web应用`, `Other Web Application` -> explicit `WebApplication` argument, not a vague pronoun

<!-- superseded: WebApplication inventory now uses applications Type=3 catalog, not groupArguments. -->

Inventory wording such as `系统中有哪些web应用` / `系统中有哪些业务` should list the `WebApplication` catalog from the southbound `applications` API filtered by `Type=3`. Runtime metric execution still uses `groupType=WebApplication`.
Inventory wording such as `系统中有哪些已定义应用` should list `DefinedApp` from `applications Type=2`. `系统中有哪些自动识别应用` / `系统中有哪些自动识别的应用` / `系统中有哪些自动识别出来的应用` / `系统中有哪些复合协议` / `系统中有哪些复合应用` should list `CompositeApplication` from `applications Type=4`. `系统中有哪些内置应用` should list `BuiltinApplication` from `applications Type=1`.

### Metrics

- `数据包数量`, `包数量`, `包个数`, `数据包个数`, `包流量` -> `PKIO`
- `流量`, `吞吐`, `吞吐量`, `带宽` -> throughput metrics such as `TPIO` unless the user explicitly asks for packets or bytes
- `字节流量`, `字节数` -> byte traffic metrics such as `BYTIO`
- Web `访问量`, `访问次数`, `页面访问` -> `PGNPGE`
- `服务器响应时间`, `服务端响应时间` -> `TRTI`
- `客户端响应时间` -> client-side response time metric when supported
- `RTT`, `往返时延`, `网络时延`, `延迟` -> RTT / latency metrics such as `RTTI`, not `TRTI`
- `页面响应时间`, `页面耗时`, `页面时延` -> page timing metric such as `PGTME`
- `丢包`, `丢包率` -> packet loss metrics
- `重传` -> retransmission metrics
- `HTTP 4xx`, `HTTP 5xx`, `500错误`, `报错`, `错误率` -> HTTP error metrics or error ratio metrics

### Service Mode

- `有哪些`, `列表`, `清单`, `系统中有哪些...` -> inventory / metadata listing
- `最多`, `最少`, `最高`, `最低`, `最慢`, `前N`, `TopN`, `是谁`, `哪个` -> ranking
- Singular ranking questions such as `是谁` or `哪个` should prefer `topCount=1`
- `是多少`, `平均`, `均值` -> average
- `整体`, `总览`, `综合分析`, `为什么`, `原因`, `情况怎么样`, `状态` -> comprehensive analysis using execution `service=overview`
- `趋势`, `走势`, `变化`, `曲线`, `按时间` -> time series
- Broad performance questions with a known subject and missing metric should run comprehensive-analysis-first rather than asking for every detail

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

`数据包数量最多的�?个应用分别是谁`

- Service mode: ranking
- Metric: `PKIO`
- Object: use `DefinedApp` / `Application` unless context says Web application
- `topCount=5`

`101.254.114.238 的服务器响应时间是多少`

- Service mode: average
- Metric: `TRTI`
- Group argument: IP address `101.254.114.238`
- Do not map this wording to `RTTI`

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

## Anti-Patterns

- Do not depend on project gateway routes or old `src/services` for NAPM query execution.
- Do not require an upstream planner decision before querying.
- Do not treat service modes (`topValues`, `averageValues`, `timeValues`) as the first-level intent.
- Do not map `Web应用` inventory to the broad protocol `applications` endpoint.
- Do not map `服务器响应时间` to `RTTI`.
- Do not map `数据包数量` to throughput; it is `PKIO`.
- Do not ask for clarification when the semantic target is already clear enough to query.
