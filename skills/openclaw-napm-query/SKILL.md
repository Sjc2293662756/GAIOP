---
name: openclaw-napm-query
description: NAPM semantic decision and query execution skill. Use when OpenClaw needs to handle NAPM or NetInside concept explanations, broad analysis entry questions, direct query requests, multi-turn refinements, or result follow-ups, and route them through decision, intent structuring, metadata resolution, query execution, and stable output formatting. Avoid using it for pure non-NAPM operation tasks.
---

# OpenClaw NAPM Semantic Decision + Query

Use this skill as a decision-first NAPM runtime. Do not start from `topValues/averageValues/timeValues` classification. Always decide first, then execute only when the decision allows query execution.

## Layered Architecture

1. Decision Layer
2. Intent Structuring Layer
3. Metadata Resolution Layer
4. Query Execution Layer
5. Result Interpretation / Output Layer

Execution resources from the old skill (metric mapping, group mapping, time normalization, validation, execution, formatting) are preserved, but they are post-decision capabilities.

## Workflow (Decision-First)

1. Determine whether the request continues an existing NAPM session.
2. Determine whether the request is in scope for NAPM.
3. Classify the task as `explanation`, `query`, `analysis_entry`, or `result_interpretation`.
4. Determine whether information is sufficient: `S1_DIRECT_QUERY`, `S2_OVERVIEW_FIRST`, `S3_NEED_CLARIFICATION`, `S4_UNMAPPABLE`.
5. Produce a decision object.
6. If next action is query-related, build an intermediate intent object.
7. Resolve metadata using metric, dimension, and validation resources.
8. Execute the final NAPM query only after resolution succeeds.
9. Format the answer or next-step prompt.

## Decision Layer Rules (Mandatory)

### 1) Continuation before scope

Always run continuation detection before scope detection. If current input is a continuation of an active NAPM session, keep it in NAPM domain even when current utterance has no explicit NAPM keywords.

### 2) Continuation type enum

- `subject_switch`
- `time_switch`
- `metric_switch`
- `view_switch`
- `result_follow_up`
- `query_refinement`
- `step_forward`

### 3) Scope policy

In-scope:

- NAPM concept explanation
- NAPM query request
- NAPM performance analysis entry
- NAPM result interpretation

Out-of-scope:

- restart services
- code debugging and code-level RCA
- generic DBA/operation action
- non-NAPM generic QA

### 4) Task-type policy and priority

Task enum:

- `explanation`
- `query`
- `analysis_entry`
- `result_interpretation`

Priority order (high to low):

1. `explanation`
2. `result_interpretation`
3. `query`
4. `analysis_entry`

### 5) Information sufficiency policy

Apply only to `query` and `analysis_entry`:

- `S1_DIRECT_QUERY`
- `S2_OVERVIEW_FIRST`
- `S3_NEED_CLARIFICATION`
- `S4_UNMAPPABLE`

### 6) Action enum

- `ANSWER_CONCEPTUALLY`
- `GO_DIRECT_QUERY`
- `GO_OVERVIEW_QUERY`
- `ASK_CLARIFYING_QUESTION`
- `INTERPRET_RESULT`
- `REJECT_AND_REDIRECT`

## Session State Contract

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

### Inheritance rules

- `subject`: inherit when continuation is `time_switch`, `metric_switch`, `view_switch`, `step_forward`, or `result_follow_up`
- `time_range`: inherit unless user explicitly switches time
- `metric`: inherit for result follow-up and view switch when no new metric is supplied
- `group_path`: inherit when follow-up narrows or expands view without replacing subject
- `result_context`: inherit only when `last_result_available = true` and `turn_expiry > 0`

## Decision Object Schema

Use this structure inside the skill:

```json
{
  "is_continuation": true,
  "continuation_type": "result_follow_up",
  "in_scope": true,
  "scope_reason": "",
  "task_type": "result_interpretation",
  "task_reason": "",
  "information_sufficiency": "not_applicable",
  "sufficiency_reason": null,
  "recognized_subject_hint": "239web",
  "recognized_time_hint": "yesterday",
  "recognized_goal_hint": "interpret_result",
  "inherit_subject": true,
  "inherit_time_range": true,
  "inherit_metric": true,
  "next_action": "INTERPRET_RESULT",
  "need_clarification": false,
  "clarifying_question": null
}
```

OpenClaw runtime rule:

- The upper planner/model should produce this `decision` object first.
- The executor script validates the contract and only uses local fallback rules when the incoming `decision` is missing or invalid.
- Do not let the executor become the primary boundary judge; boundary judgement belongs to the skill-side model following this schema.

## Intent Structuring Layer

Input: user request + decision object + session state  
Output: intermediate `intent` object only. Do not output final execution JSON here.

Recommended intent fields:

```json
{
  "intent_type": "query",
  "goal": "topn|trend|average|overview|diagnose|interpret",
  "subject_hint": "239web",
  "time_hint": "today",
  "metric_hint": "吞吐",
  "view_hint": "group_by_ip",
  "constraints": {},
  "use_context_inheritance": true
}
```

## Metadata Resolution Layer

Responsibilities:

- resolve subject existence
- resolve object type and group path
- resolve metric mapping
- resolve service mode
- apply validation and safe repair strategy

Output: `resolvedQuery` only after resolution completes.

## Query Execution Layer

Run query only when action is `GO_DIRECT_QUERY` or `GO_OVERVIEW_QUERY`.  
Reuse existing workspace capabilities:

- RequirementParserService
- MetricMappingService
- GroupBuilder
- QueryValidator
- NapmClient
- TimeUtils

Supported execution service remains:

- `topValues`
- `averageValues`
- `timeValues`

These service types are execution-layer internals, not skill entry classification.

## Result Interpretation / Output Layer

Always return stable structure and include one of:

- direct result summary
- empty result explanation
- result interpretation from existing context
- next-step suggestion
- clarifying question
- rejection and redirection

## Invocation Rules

Prefer this skill when requests involve:

- NAPM / NetInside concepts or metrics
- broad analysis entry (`最近情况怎么样`, `为什么最近慢`)
- query execution requests
- result follow-up and multi-turn refinement
- interpretation of NAPM result snippets/tables

Do not use this skill for:

- non-NAPM generic tasks
- operation actions (restart/deploy/config change)
- code-level troubleshooting requests

## Script Interface

Use [scripts/run_napm_query.js](./scripts/run_napm_query.js).
Decision logic is implemented in [scripts/decision-layer.js](./scripts/decision-layer.js).

OpenClaw runtime preference:

- Prefer the OpenClaw plugin/tool command `napm-skill-query` when it is available.
- Pass the raw user prompt plus optional structured `decision`, `intent`, `resolvedQuery`, and `sessionState`.
- Use the local script only as the execution reference implementation or fallback runtime.
- Prefer machine-payload narration: when the executor returns `narrationInput`, generate the final user-facing reply from `narrationInput.result.narrationStructure` first, then `narrationInput.summary` + `narrationInput.result` (rows/structuredRows/structuredSeries/overview). When `responseMode=machine_narration_input` and `narrationInput.narrationRequired=true`, you must output the final Chinese answer in the same turn instead of stopping at JSON acknowledgement. Only fall back to `displayText`/`replyText` when `narrationInput` is missing.
- Web access ranking rule: when the user asks for `访问量 / 访问次数 / 页面访问` and also mentions `客户端 / 客户端IP`, prefer `PGNPGE` plus target object `ClientIPs`, not default throughput metrics. If the same request contains `其他web应用 / 其它web应用 / 未注册web应用 / Other Web Application`, treat that phrase as an explicit `WebApplication` argument and keep the request executable instead of forcing clarification.

Supported inputs:

1. raw prompt
2. structured payload with any of `decision`, `intent`, `resolvedQuery`, `sessionState`

When OpenClaw already produced a `decision`, pass it through `payload.decision`. The executor will:

- validate enum values and required fields
- reject unsupported action families such as restart/deploy/config/code/db-internal actions
- preserve model-produced `response_text` / `clarifying_question` when present
- block execution when `decision` is missing/invalid and return a clarification prompt
- do not fallback to local heuristic decision/scoring

Example:

```bash
node skills/openclaw-napm-query/scripts/run_napm_query.js --prompt "239web 最近异常吗"
```

```bash
node skills/openclaw-napm-query/scripts/run_napm_query.js --payload "{\"decision\":{\"next_action\":\"GO_DIRECT_QUERY\"},\"resolvedQuery\":{\"service\":\"topValues\",\"metric\":\"TPIO\",\"groups\":[{\"type\":\"IPAddress\"}],\"start\":1762732800,\"end\":1762819199,\"topCount\":10}}"
```

## Output Contract (v2)

```json
{
  "ok": true,
  "decision": {},
  "intent": {},
  "resolvedQuery": {},
  "data": [],
  "displayText": null,
  "replyText": null,
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

For `ANSWER_CONCEPTUALLY`, `ASK_CLARIFYING_QUESTION`, `REJECT_AND_REDIRECT`, and `INTERPRET_RESULT`, `resolvedQuery` and `data` may be `null`.

## References

Use the `references/` directory progressively. Do not load everything by default. Read the minimum file needed for the current phase while keeping the decision-first architecture intact.

- [references/source-index.md](./references/source-index.md)
  Use as the index for the reference set. Read this first when you need to decide which reference file to consult next.
  Stage: explanation, metadata resolution, execution
- [references/capability-mapping.md](./references/capability-mapping.md)
  Use for the mapping between the decision-first skill layers and the existing gateway/runtime modules. Read this when you need to understand which existing implementation capability should be reused instead of inventing a new path.
  Stage: metadata resolution, execution
- [references/metric-definitions.md](./references/metric-definitions.md)
  Use for metric meaning, metric aliases, and concept-level interpretation of NAPM indicators. This is the primary reference for explanation answers and for narrowing metric hints before resolution.
  Stage: explanation, metadata resolution
- [references/group-hierarchy.md](./references/group-hierarchy.md)
  Use for object scope, group hierarchy, drill-down path, and subject-to-group understanding. Read this when resolving object type, group path, or follow-up scope inheritance.
  Stage: metadata resolution
- [references/service-modes.md](./references/service-modes.md)
  Use for choosing execution mode semantics and for understanding when a request should become ranking, average, trend, overview, or similar execution behavior without making service-first the entry architecture.
  Stage: metadata resolution, execution
- [references/query-construction.md](./references/query-construction.md)
  Use for final resolved-query construction rules, parameter assembly, and execution payload shape after decision and intent are already settled.
  Stage: metadata resolution, execution
- [references/runtime-lookup-notes.md](./references/runtime-lookup-notes.md)
  Use for runtime lookup notes, safe resolution behavior, and practical constraints when turning intermediate intent into live metadata/runtime lookups.
  Stage: metadata resolution, execution
- [references/openclaw-integration.md](./references/openclaw-integration.md)
  Use for OpenClaw-side routing, trigger policy, and tool registration expectations. Read this when adjusting how the skill is invoked from the upper planner while preserving the decision-first entry policy.
  Stage: explanation, metadata resolution, execution

Use [scripts/run_napm_query.js](./scripts/run_napm_query.js) to execute the actual query path.

## Decision Examples (Request -> Decision)

1. `什么是 NAPM 的吞吐量指标？` -> `ANSWER_CONCEPTUALLY`
2. `这个结果说明什么问题？` (session has last result) -> `INTERPRET_RESULT`
3. `查今天吞吐量前10的客户端IP` -> `GO_DIRECT_QUERY`
4. `访问其他web应用次数最多的客户端是谁` -> `GO_DIRECT_QUERY` with `metric=PGNPGE`, `groups=[WebApplication(\"Other Web Application\"), ClientIPs]`, prefer `topCount=1`
5. `239web 最近异常吗` -> `GO_OVERVIEW_QUERY`
6. `为什么最近慢` (with active subject in session) -> `GO_OVERVIEW_QUERY`
7. `改成最近24小时` -> continuation `time_switch`, `GO_DIRECT_QUERY`
8. `换成响应时间看趋势` -> continuation `metric_switch`, `GO_DIRECT_QUERY`
9. `只看这个对象` -> continuation `subject_switch`, `GO_DIRECT_QUERY`
10. `再下一步` -> continuation `step_forward`, `GO_DIRECT_QUERY`
11. `帮我重启 239web 服务` -> out-of-scope, `REJECT_AND_REDIRECT`
12. `查一下最近情况` (no subject) -> `ASK_CLARIFYING_QUESTION`
13. `分析一下数据库慢 SQL` -> out-of-scope, `REJECT_AND_REDIRECT`

## Anti-Pattern

Do not implement entry routing as: "first classify into `topValues/averageValues/timeValues`".
That logic belongs to query execution only and must not bypass decision-first flow.
