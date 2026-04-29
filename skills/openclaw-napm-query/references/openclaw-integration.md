# OpenClaw Integration Notes (Decision-First v2)

## Goal

Make OpenClaw route NAPM-related requests to a decision-first skill runtime, not a direct service classifier.

## Trigger Strategy

Prefer this skill when the request is likely one of:

- NAPM concept explanation
- NAPM direct query
- broad analysis entry (`最近情况`, `最近为什么慢`)
- result interpretation (`这个结果怎么解读`)
- multi-turn refinement (`改成最近24小时`, `只看这个对象`)

Do not require hard keyword match when there is an active NAPM session and continuation evidence.

## Planner Policy

1. First check continuation against session state.
2. Then check scope boundary.
3. Then classify task type and decide next action.
4. Execute query only on query-related actions.

Suggested next-action mapping:

- `ANSWER_CONCEPTUALLY`: answer concept in NAPM context without query
- `INTERPRET_RESULT`: interpret prior result context
- `GO_DIRECT_QUERY`: run intent -> resolution -> query
- `GO_OVERVIEW_QUERY`: run overview-first path
- `ASK_CLARIFYING_QUESTION`: ask one minimal clarification question
- `REJECT_AND_REDIRECT`: reject out-of-scope and suggest closest NAPM-available path

Special direct-query guidance for Web access questions:

- If the request contains `访问量 / 访问次数 / 页面访问` plus `客户端 / 客户端IP`, prefer metric `PGNPGE` and target object `ClientIPs`.
- If the same request contains `其他web应用 / 其它web应用 / 未注册web应用 / Other Web Application`, treat it as an explicit `WebApplication` argument, not as a vague pronoun that requires clarification.
- Example target shape:
  `service=topValues`, `metric=PGNPGE`, `topMetric=PGNPGE`, `groups=[{type:"WebApplication",argument:"Other Web Application"},{type:"ClientIPs"}]`
- For singular asks such as `谁`, prefer `topCount=1`.

## Tool Registration

Register this skill as `semantic decision + query` capability.

Recommended bridge command name:

- `napm-skill-query`

Executor inputs:

- `prompt`: raw natural-language request
- `payload`: optional structured object containing `decision`, `intent`, `resolvedQuery`, `sessionState`

Executor output contract:

```json
{
  "ok": true,
  "decision": {},
  "intent": {},
  "resolvedQuery": {},
  "data": [],
  "summary": {},
  "error": null
}
```

## Operational Advice

- keep NAPM credentials injected through environment variables
- keep metric mapping single-sourced from workspace config
- log `decision`, `intent`, and `resolvedQuery` for observability
- keep clarification minimal and specific
- prefer `GO_OVERVIEW_QUERY` for analysis-entry requests with recognized subject and missing explicit metric
