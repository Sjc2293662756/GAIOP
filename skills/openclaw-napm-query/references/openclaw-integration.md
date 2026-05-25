# OpenClaw Integration Notes (Direct Skill Runtime)

## Goal

OpenClaw should route NAPM-related requests directly to `openclaw-napm-query`.

Responsibility split in the current runtime:

- OpenClaw owns domain boundary judgement, follow-up understanding, clarification policy, and standard `resolvedQuery` construction.
- The skill owns query normalization, metadata validation, NAPM execution, and machine-readable narration contract generation.

There is no gateway approval layer in the active runtime.

## Trigger Strategy

Prefer this skill when the request is likely one of:

- NAPM / NetInside concept explanation
- NAPM metadata inventory, such as "系统中有哪些web应用"
- NAPM metric-ownership or scope explanation, such as "业务都可以查哪些指标"、"业务组都可以查哪些指标"、"WebApplication 和 BusinessGroup 区别"
- direct query, ranking, average, trend, or overview
- broad analysis entry, such as "最近情况怎么样" or "为什么最近慢"
- result interpretation
- multi-turn refinement, such as "改成最近24小时" or "只看这个对象"

Do not require a hard NAPM keyword match when there is an active NAPM session and the current turn looks like a continuation.

## Runtime Policy

1. Prefer structured `resolvedQuery` from OpenClaw as the standard contract.
2. Use continuation context when present.
3. Treat `decision` and `intent` as optional hints, but do not require them for execution.
4. Require executable `resolvedQuery` for normal query execution.
5. Return a machine-readable result for OpenClaw final narration.

## Recommended Tool

Recommended command name:

- `napm-skill-query`

Fallback script:

```bash
node skills/openclaw-napm-query/scripts/run_napm_query.js --resolvedQuery "{\"service\":\"groups\",\"groups\":[{\"type\":\"WebApplication\"}],\"format\":\"json\"}"
```

Executor inputs:

- `resolvedQuery`: required structured executable query for the standard path
- `payload`: optional object containing `decision`, `intent`, `resolvedQuery`, `session`, or `sessionState`
- `--session`: optional continuation state for local execution

Executor output should stay machine-readable, but OpenClaw should turn it into the final Chinese answer in the same turn.

## Semantic Reminders

- Do not answer application inventory from `groups-tree.static.json` `Application` nodes. The tree is hierarchy metadata, not the application catalog truth source.
- Plain `系统中有哪些应用` is ambiguous. Clarify whether the user wants `WebApplication(Type=3)`, `DefinedApp(Type=2)`, `BuiltinApplication(Type=1)`, `CompositeApplication(Type=4)`, or `OtherApp`.
- `系统中有哪些web应用` / `系统中有哪些业务` means list `WebApplication` catalog objects from `applications Type=3`; runtime metric execution still uses `groupType=WebApplication`.
- `系统中有哪些已定义应用` means list `DefinedApp` catalog objects from `applications Type=2`.
- `系统中有哪些自动识别应用` / `系统中有哪些复合协议` / `系统中有哪些复合应用` means list `CompositeApplication` catalog objects from `applications Type=4`.
- `系统中有哪些内置应用` means list `BuiltinApplication` catalog objects from `applications Type=1`.
- `数据包数量`, `包数量`, `包个数`, `数据包个数`, `包流量` mean metric `PKIO`.
- `服务器响应时间` / `服务端响应时间` means `TRTI`, not `RTTI`.
- `RTT`, `往返时延`, `网络时延`, and `延迟` are latency / RTT concepts.
- `访问其他web应用次数最多的客户端是谁` should prefer:
  `service=topValues`, `metric=PGNPGE`, `groups=[{type:"WebApplication",argument:"Other Web Application"},{type:"ClientIPs"}]`, `topCount=1`.

## Output Advice

- Do not stop at raw JSON, `Groups list completed`, `Average query completed`, or `[object Object]`.
- Every data answer must include the data time range. Prefer `narrationInput.result.timeRange.displayText` or `narrationInput.summary.timeRange.displayText`.
- Summarize the returned rows in Chinese.
- For empty results, say what metric, object, time range, and scope were queried.
- Do not use old cached data as the answer for a failed fresh query.
- Show debug API only when explicitly enabled by runtime policy, and always mask credentials.
