# GAIOP NAPM：MODEL_OWNED 输出被 Lifecycle Guard 覆盖

## 1. 文档目的

本文记录 Web 端普通问候/身份回答被替换为：

```text
当前回复无法确认所属的 NAPM 查询轮次，已阻止未经验证的查询内容。
请重新发起查询。
```

的只读根因核验结果和后续解决方案。

本文用于审核，当前不代表已经实施修复。

本轮范围：

- 读取远端审计日志；
- 核对 rc.59 活动版本与本地代码；
- 回放本地 Plugin Hook 生命周期；
- 区分 `MODEL_OWNED` 与 `NAPM_QUERY` 的安全边界；
- 给出最小修复边界和回归测试计划。

本轮未做：

- 未修改运行时代码；
- 未修改 BUG-A 查询语义、指标、对象、执行门禁；
- 未调用真实 NAPM 南向查询；
- 未部署、未重启远端服务。

## 2. 当前版本和工作区状态

```text
branch: codex/napm-turn-decision-phase1
HEAD: 030f9ae3647f21ac52a55311346456a7bbcaaf3b
working tree（诊断开始前）: clean
remote active version: 1.1.0-rc.59
remote active commit: 030f9ae3647f21ac52a55311346456a7bbcaaf3b
```

本地插件文件 SHA-256 与远端活动 extension 文件一致：

```text
1d819de1946c9de5fa0b312f443154ef13083e3ea42a2ef67aa779e1912448c8
```

因此，本问题不是“本地修改没有部署”或“远端仍运行旧插件”。

## 3. 现象定义

### 3.1 用户可见现象

用户发送普通问候或身份问题，例如：

```text
你好
你是谁？
你能做什么？
```

模型已经生成了正常回答，但 Web 端最终显示生命周期失败文案。

### 3.2 正确目标

```text
用户问候/身份问题
  ↓
MODEL_OWNED
  ↓
模型依据 SOUL.md / IDENTITY.md 回答
  ↓
不调用 NAPM Tool
  ↓
输出 Hook 原样保留模型回答
```

### 3.3 不应发生的路径

```text
用户问候/身份问题
  ↓
MODEL_OWNED 已确定
  ↓
输出 Hook 先要求 NAPM Query Turn binding
  ↓
缺少 runId/messageId
  ↓
覆盖模型回答为 NAPM 生命周期失败文案
```

## 4. 远端日志证据

远端日志文件：

```text
/home/netinside/.openclaw/logs/audit.log
```

核验时间：2026-09-14；日志事件发生在 2026-09-13（北京时间约 21:01）。

### 4.1 入站轮次已经正确创建

日志：`2026-09-13T13:01:46.595Z`。

```json
{
  "event": "turn_admission_decided",
  "turnId": "napm-turn-7be1cd11-a62f-4628-ab02-fe151a86a409",
  "runId": null,
  "messageId": "ece13ae8-8b75-46ea-95ed-9ef2ad44409f",
  "route": "model_owned",
  "action": "MODEL_OWNED",
  "expectedTool": null,
  "intentType": "model_owned",
  "handling": "model_owned",
  "reasonCode": "platform_identity_fast_path"
}
```

这证明：

1. `message_received` 已创建 `turnId`；
2. 已生成不可变 `MODEL_OWNED` Decision；
3. 当前轮没有期望 Tool；
4. 不是 Query Decision 错误；
5. 入站阶段至少有可用的 `messageId`。

审计日志不记录用户原始文本，因此不能仅凭该日志恢复“你好”三个字；但 `platform_identity_fast_path` 已确认属于身份/问候类语义。

### 4.2 输出阶段身份丢失

日志：`2026-09-13T13:01:58.525Z`。

```json
{
  "event": "lifecycle_identity_missing",
  "hook": "before_message_write",
  "conversationKey": "session:agent:main:main:dm:webchat-2fcc5fa5c6e14a8b8c146854d0fa7096"
}
```

该事件只会由以下条件触发：

```javascript
!hasLifecycleIdentity(ctx)
```

而 `hasLifecycleIdentity()` 只检查：

```javascript
ctx.runId || ctx.messageId
```

因此可以确定：

```text
before_message_write 收到的 ctx 中，runId 和 messageId 均为空或不可验证。
```

### 4.3 没有发生 NAPM Tool 调用

在该 `turnId` 的审计记录中没有：

```text
napm_plugin_skill_call_received
trusted_tool_context_bound
napm_plugin_resolved_query_forwarded
```

并且 Decision 中：

```text
expectedTool = null
action = MODEL_OWNED
```

因此该问题不涉及真实 NAPM 查询，也没有南向调用重复或查询结果污染。

## 5. 当前代码调用链

### 5.1 入站阶段

当前代码在 [napm-openclaw-plugin.remote.js](../napm-openclaw-plugin.remote.js) 中执行：

```text
message_received
  ↓
生成 turnId
  ↓
buildConversationScopedGuardState()
  ↓
Turn Admission Decision = MODEL_OWNED
  ↓
QueryTurnCoordinator.begin(route=MODEL_OWNED)
  ↓
保存 guardState / conversationState
```

对应代码位置：

- `turnId` 创建：约第 8793 行；
- `QueryTurnCoordinator.begin()`：约第 8859 行；
- `turn_admission_decided` 审计：约第 8883 行。

### 5.2 `message_sending` 当前顺序

当前顺序为：

```text
1. native command bypass
2. hasLifecycleIdentity(ctx)
3. 缺少 runId/messageId → cancel=true
4. getConversationKey(ctx)
5. getGuardState(ctx)
6. getQueryTurnForContext(ctx)
7. 缺少 run-bound turn → cancel=true
8. 处理进度消息、终态结果、报告、告警和媒体
9. 计算 activeTurnRoute
10. MODEL_OWNED → passthrough
```

关键位置：

- 身份硬门禁：[napm-openclaw-plugin.remote.js:9957](../napm-openclaw-plugin.remote.js:9957)
- turn binding 硬门禁：[napm-openclaw-plugin.remote.js:9974](../napm-openclaw-plugin.remote.js:9974)
- `MODEL_OWNED` 放行：[napm-openclaw-plugin.remote.js:10229](../napm-openclaw-plugin.remote.js:10229)

所以 `MODEL_OWNED` 判断发生在生命周期身份硬门禁之后。

### 5.3 `before_message_write` 当前顺序

当前顺序为：

```text
1. native command bypass
2. 只处理 assistant 消息
3. hasLifecycleIdentity(ctx)
4. 缺少 runId/messageId → 用 buildLifecycleBindingFailureReply() 替换原消息
5. getQueryTurnForContext(ctx)
6. 缺少 run-bound turn → 再次用同一失败文案替换
7. toolCall / progress 处理
8. 计算 activeTurnRoute
9. explicit_out_of_scope / boundary 处理
10. ensureAuthoritativeQueryTurnForFinalOutput()
11. MODEL_OWNED 相关输出处理
```

关键位置：

- 身份失败替换：[napm-openclaw-plugin.remote.js:10387](../napm-openclaw-plugin.remote.js:10387)
- turn binding 失败替换：[napm-openclaw-plugin.remote.js:10404](../napm-openclaw-plugin.remote.js:10404)
- route 判断开始：[napm-openclaw-plugin.remote.js:10462](../napm-openclaw-plugin.remote.js:10462)

这就是当前 Web 端“模型已经回答，但最终回答被替换”的直接原因。

## 6. 本地最小回放矩阵

本地使用 Plugin 注册的真实 Hook 进行回放，未调用真实 NAPM。

| Prompt | platformIdentityPrompt | Turn Policy | Coordinator route | Tool calls | 完整 ctx 输出 | 输出 ctx 无 run/message |
|---|---:|---|---|---:|---|---|
| 你好 | true | MODEL_OWNED | MODEL_OWNED | 0 | 原样保留 | cancel / 替换失败文案 |
| 你是谁？ | true | MODEL_OWNED | MODEL_OWNED | 0 | 原样保留 | cancel / 替换失败文案 |
| 你能做什么？ | true | MODEL_OWNED | MODEL_OWNED | 0 | 原样保留 | cancel / 替换失败文案 |
| 你是什么模型？ | true | MODEL_OWNED | MODEL_OWNED | 0 | 原样保留 | cancel / 替换失败文案 |
| 谢谢 | false | MODEL_OWNED | MODEL_OWNED | 0 | 原样保留 | 同样受身份硬门禁影响 |
| 最近业务访问较慢的前5个业务都有谁？ | false | NAPM_CANDIDATE | NAPM_QUERY | 0（本回放未调用 Tool） | Skill-required 兜底 | 继续 fail-closed |

补充回放：

```text
message_received（完整 ctx，生成 MODEL_OWNED turn）
  ↓
before_message_write（ctx 去掉 runId/messageId）
  ↓
当前回复无法确认所属的 NAPM 查询轮次……
```

该结果与远端日志完全一致。

## 7. Previous NAPM Turn 污染核验

回放：

```text
第一轮：最近业务访问较慢的前5个业务都有谁？
第二轮：你好
```

在完整 run/message 上下文下：

```text
第二轮 Turn Policy = MODEL_OWNED
第二轮 Coordinator route = MODEL_OWNED
没有继承上一轮 NAPM route
没有读取上一轮 NAPM finalContent
```

结论：

```text
previous turn reused: NO
previous route leaked: NO
```

若第二轮输出 Hook 丢失生命周期身份，仍会失败，但失败原因是输出 Hook 身份缺失，不是 previous NAPM contamination。

## 8. 根因分类

### 主要根因：E + C

#### E. OpenClaw Hook identity capability mismatch

既有部署设计明确规定：

- `before_message_write` 可能只有 session identity；
- `message_sending` 可能只有 channel/account/conversation identity；
- 两者通过 canonical scope / alias 关联。

参见：

[2026-08-11-OpenClaw工具调用多答案与重复交付全链路根治方案.md:175](2026-08-11-OpenClaw工具调用多答案与重复交付全链路根治方案.md:175)

当前 rc.59 代码却要求输出 Hook 必须携带 `runId/messageId`，与上述 Hook 能力不一致。

#### C. Output Guard scope/order 错误

输出 Hook 在判断 route 之前强制执行 Query 生命周期身份检查。

因此：

```text
MODEL_OWNED
被错误地套用了
NAPM_QUERY 的 execution binding 门禁
```

### 已排除的根因

| 分类 | 结论 | 证据 |
|---|---|---|
| A. MODEL_OWNED turn 创建失败 | 排除 | 远端有 `turnId` 和 `MODEL_OWNED` Decision |
| B. 入站 run/message binding 创建失败 | 非主要原因 | 入站日志有 `messageId`；输出 Hook 才丢失身份 |
| D. previous NAPM route 泄漏 | 排除 | 本地 previous-NAPM → greeting 回放为 MODEL_OWNED |
| F. 远端版本不一致 | 排除 | 活动 manifest 和文件 SHA-256 与 rc.59 一致 |
| G. NAPM 南向查询错误 | 排除 | 当前身份轮没有 Tool/南向事件 |

## 9. 文档与代码契约差异

| Contract | 文档要求 | 当前代码 | 结果 |
|---|---|---|---|
| 每轮创建 turnId / Decision | 必须创建，包括 MODEL_OWNED | 已创建 | 一致 |
| MODEL_OWNED 不覆盖模型回答 | 输出 Hook 只在明确安全门禁时改写 | 身份检查先于 route 检查 | 不一致 |
| 输出 Hook 可能缺少 run/message identity | 通过 session/channel scope 关联 | 直接要求 runId/messageId | 不一致 |
| NAPM_QUERY 缺 binding | fail-closed | fail-closed | 一致 |
| 禁止 latest-turn fallback | 不能读取会话最新轮次 | 当前未使用 | 一致 |
| MODEL_OWNED 不需要 NAPM execution proof | 不调用 Query Skill，不需要 finalContent | 被错误要求 Query binding | 不一致 |

## 10. 修订后的解决方案：先解析 Output Turn，再执行 route 门禁

上一版方案中“可验证 `route=MODEL_OWNED`”定义不充分。修订后明确：

```text
不能先读 conversation route 再决定是否需要 binding。
必须先证明当前输出属于哪个可信 Turn，
再读取该 Turn 的 immutable route，
最后执行 route-specific authority checks。
```

正式链路：

```text
Assistant Output
  ↓
resolveTrustedOutputTurnContext()
  ↓
OutputTurnContext + resolutionStatus + provenance
  ↓
route-aware admission
  ↓
MODEL_OWNED / EXPLICIT_OUT_OF_SCOPE / NAPM_QUERY policy
```

禁止链路：

```text
Assistant Output
  ↓
读取 conversation current/latest route
  ↓
猜测当前输出属于哪个 Turn
  ↓
决定是否绕过 Query binding
```

### 10.1 三个必须区分的概念

| 概念 | 含义 | MODEL_OWNED | NAPM_QUERY |
|---|---|---:|---:|
| Lifecycle / Output Identity | 当前输出来自哪个 run/message 或 Hook 执行环境 | 需要可信来源 | 需要可信来源 |
| Turn Identity | 当前输出属于哪个 `TurnAdmissionDecision/turnId` | 需要可信证明 | 需要可信证明 |
| NAPM Query Authority | 当前 Query 是否拥有合法执行、结果和 finalContent 权限 | 不需要 | 必须具备 |

因此：

```text
MODEL_OWNED != 不需要生命周期安全
MODEL_OWNED = 需要当前轮 provenance，但不需要 NAPM execution proof
```

## 11. OutputTurnContext 定义

方案正式引入结构化 `OutputTurnContext` 概念。它可以由现有对象收口，不要求本轮立即新增类。

```text
OutputTurnContext
├─ conversationScope
├─ turnId
├─ route
├─ expectedTool
├─ sourceRunId
├─ sourceMessageId
├─ provenance
├─ authority
└─ resolutionStatus
```

字段约束：

```text
conversationScope：可信 canonical scope
turnId：不可变 Turn id
route：来自 immutable TurnAdmissionDecision
expectedTool：来自 immutable TurnAdmissionDecision
sourceRunId/sourceMessageId：原始入站身份，缺失时为空
provenance：如何取得该 context
authority：可用于哪一级门禁
resolutionStatus：RESOLVED / UNRESOLVED / AMBIGUOUS
```

`OutputTurnContext` 不得从 assistant 输出正文重新分类，也不得从 raw prompt 重新跑语义分类器。

## 12. Output Turn Resolution 层级

### 12.1 Strong Binding

Strong Binding 是最可信来源：

```text
RUN_BOUND
  = ctx.runId + scope → turnId

MESSAGE_BOUND
  = ctx.messageId + scope → turnId

TURN_TOKEN
  = 插件签发的不可伪造 OutputTurnContext / admission token
```

Strong Binding 必须同时验证：

```text
scope 一致
turnId 存在
TurnAdmissionDecision 存在且不可变
source run/message 与 token/context 一致
token 未过期、未跨 scope、未重复使用
```

Strong Binding 成功后：

```text
resolutionStatus = RESOLVED
provenance = RUN_BOUND / MESSAGE_BOUND / TURN_TOKEN
```

### 12.2 Safe Scope-Level Resolution

只有在 Hook 没有 `runId/messageId` 时，才允许尝试 scope-level resolution。

scope-only 不是读取 current/latest turn，而是严格的唯一候选证明。必须同时满足：

1. canonical conversation scope 可信；
2. 当前 scope 内只有一个符合条件的 output candidate；
3. candidate 拥有 immutable TurnAdmissionDecision；
4. candidate route 明确；
5. candidate 未过期；
6. candidate 处于允许输出的生命周期状态；
7. 不存在第二个 active、pending-output、awaiting-final 或 execution-in-flight candidate；
8. 不存在重叠 run 可能竞争该输出；
9. candidate 不是通过“最近/最后一次/latest”选出的；
10. candidate 的 scope、route、turnId、source provenance 可以完整审计。

满足全部条件时：

```text
resolutionStatus = RESOLVED
provenance = UNIQUE_SCOPE_RESOLUTION
authority = ROUTE_IDENTITY_ONLY
```

否则不得猜测：

```text
0 个 candidate  → UNRESOLVED
多个 candidate   → AMBIGUOUS
```

### 12.3 Candidate 的正式定义

建议由 `QueryTurnCoordinator` 提供只读接口：

```text
findEligibleOutputTurns(scope)
```

或等价接口，不允许 Output Hook 直接读取内部 Map。

candidate 至少需要：

```text
scope 匹配
TurnAdmissionDecision 存在
turn 未过期
route 已冻结
turn 未被清理
```

对于 `MODEL_OWNED` / `EXPLICIT_OUT_OF_SCOPE`，candidate 通常可以处于 `RECEIVED`，但必须满足：

```text
没有另一个可竞争输出的 turn
没有同 scope 重叠 run
没有 delivery 已完成或已被其他输出领取
```

对于 `NAPM_QUERY`，scope candidate 只能证明 route identity，不能自动证明 Query execution/result authority。

## 13. 明确禁止 Conversation-Level Current/Latest Route

以下对象都不能单独作为当前输出归属证明：

```text
conversation latest turn
conversation current route
conversation latest guardState
conversationState.activeRoute
最近创建的 turn
最后一次 TurnAdmissionDecision
最近一个 MODEL_OWNED turn
```

禁止逻辑：

```text
output hook 缺 runId/messageId
  ↓
读取 conversation currentRoute
  ↓
route=MODEL_OWNED
  ↓
passthrough
```

### 13.1 并发风险示例

```text
Turn A：NAPM_QUERY，正在执行
Turn B：MODEL_OWNED，用户问“你好”
```

如果 B 成为 conversation latest route，而 A 的最终输出晚到且缺少身份：

```text
A 的 NAPM_QUERY 输出
→ 错误借用 B 的 MODEL_OWNED route
→ 绕过 Query execution/result authority
```

因此：

```text
LATEST_TURN = NEVER TRUSTED OUTPUT BINDING
```

## 14. Route-specific Contract

### 14.1 MODEL_OWNED

必须具备：

```text
resolutionStatus=RESOLVED
可信 current-turn provenance
route=MODEL_OWNED
expectedTool=null
```

不要求：

```text
NAPM Query execution proof
Query Skill result
NapmClient result
Query finalContent
```

允许：

```text
保留模型原回答
Tool Guard 继续阻止模型调用 NAPM Tool
```

### 14.2 EXPLICIT_OUT_OF_SCOPE

必须具备：

```text
resolutionStatus=RESOLVED
可信 current-turn provenance
route=EXPLICIT_OUT_OF_SCOPE
```

然后才能输出固定软引导。不能因为 conversation latest route 是域外就覆盖任意 assistant output。

### 14.3 NAPM_QUERY

必须具备：

```text
resolutionStatus=RESOLVED
可信 current-turn binding
route=NAPM_QUERY
Turn Admission authority
expectedTool=napm-skill-query（普通 Query）
execution authority
result/finalContent authority
```

即使 `provenance=UNIQUE_SCOPE_RESOLUTION` 能证明 route，也只能得到：

```text
route identity
```

不能直接放行 Query 结果。缺少 execution/result authority 时仍然：

```text
fail closed
```

## 15. Resolution 状态和安全策略

输出解析状态必须至少有三态：

```text
RESOLVED
UNRESOLVED
AMBIGUOUS
```

状态含义：

| 状态 | 含义 | 允许选择任意 turn | 安全处理 |
|---|---|---:|---|
| `RESOLVED` | 唯一可信地证明当前输出属于某 turn | 否，只能使用已解析 turn | 进入 route policy |
| `UNRESOLVED` | 没有候选或证据不足 | 否 | fail-safe，不猜测 |
| `AMBIGUOUS` | 存在多个可竞争候选 | 否 | fail-safe，不猜测 |

`UNRESOLVED/AMBIGUOUS` 不得使用 NAPM 专属文案冒充 route 已知。最终用户文案的细化可在实施阶段决定，但内部 reason 必须区分：

```text
OUTPUT_TURN_UNRESOLVED
OUTPUT_TURN_AMBIGUOUS
NAPM_QUERY_BINDING_REQUIRED
NAPM_QUERY_AUTHORITY_REQUIRED
```

## 16. Provenance 矩阵

| Provenance | MODEL_OWNED | EXPLICIT_OUT_OF_SCOPE | NAPM_QUERY route identity | NAPM_QUERY result authority |
|---|---:|---:|---:|---:|
| `RUN_BOUND` | allow | allow | allow | 仍需验证 execution proof |
| `MESSAGE_BOUND` | allow | allow | allow | 仍需验证 execution proof |
| `TURN_TOKEN` | allow | allow | allow | 仍需验证 execution proof |
| `UNIQUE_SCOPE_RESOLUTION` | conditional allow | conditional allow | identity only | 不足以放行 |
| `LATEST_TURN` | never | never | never | never |
| `AMBIGUOUS` | deny | deny | deny | deny |
| `UNRESOLVED` | deny | deny | deny | deny |

其中 `conditional allow` 的条件是：候选唯一、无竞争、未过期，且输出类型确实属于非 Query route。不能把它扩展成 Query 结果授权。

## 17. 状态矩阵

| Output Turn Resolution | Route | Execution Authority | Action |
|---|---|---|---|
| `RESOLVED` | `MODEL_OWNED` | n/a | passthrough |
| `RESOLVED` | `EXPLICIT_OUT_OF_SCOPE` | n/a | soft guidance |
| `RESOLVED` | `NAPM_QUERY` | valid | allow authoritative result |
| `RESOLVED` | `NAPM_QUERY` | missing | fail closed |
| `UNRESOLVED` | any | any | fail-safe |
| `AMBIGUOUS` | any | any | fail-safe |

## 18. 两个输出 Hook 的新顺序

### 18.1 `message_sending`

目标顺序：

```text
1. native command bypass
2. 解析 canonical scope
3. resolveTrustedOutputTurnContext()
4. 检查 resolutionStatus
5. route-aware policy
6. NAPM_QUERY 才执行 Query authority checks
7. 处理终态、媒体、报告和发送声明
8. send / cancel
```

### 18.2 `before_message_write`

目标顺序：

```text
1. assistant only
2. 解析 canonical scope
3. resolveTrustedOutputTurnContext()
4. 检查 resolutionStatus
5. route-aware policy
6. NAPM_QUERY 才执行 execution/result authority checks
7. 保留或替换消息
```

两个 Hook 必须共用同一个 `resolveTrustedOutputTurnContext()`，不能各自实现 scope fallback。

## 19. 并发安全模型

### Test A：NAPM A + Greeting B，A 输出晚到

```text
A = NAPM_QUERY，执行中
B = MODEL_OWNED
A 输出缺 runId/messageId
```

结果必须是：

```text
A 不能读取 B 的 MODEL_OWNED route
A 不能 passthrough
A 不能读取 latest turn
A = UNRESOLVED/AMBIGUOUS → fail-safe
```

### Test B：NAPM A + Greeting B，B 输出缺身份

如果 A 仍 active、B 也 pending：

```text
候选不唯一
resolution=AMBIGUOUS
不得猜 B
```

### Test C：单独 Greeting

scope 内只有一个未过期、无竞争的 MODEL_OWNED candidate：

```text
UNIQUE_SCOPE_RESOLUTION
→ MODEL_OWNED
→ Tool=0
→ passthrough
```

### Test D：两个重叠 MODEL_OWNED

```text
A = 你好
B = 你是谁？
```

两个输出均无 run/message 时：

```text
AMBIGUOUS
不能按 latest turn 猜
```

### Test E：MODEL_OWNED 尝试调用 Tool

仍由 `before_tool_call` 阻断，不因为 output fallback 放宽 Tool Guard。

### Test F/G：NAPM_QUERY 缺 binding 或 authority

仍然 fail-closed，scope-only route 不能放行查询结果。

### Test H：Previous NAPM → New Greeting

不得继承旧 route、旧 finalContent 或旧 proof。

### Test I/J：重叠 Query

不得串 turn、串 result、串 finalContent 或读取 latest turn。

## 20. Q1-Q15 设计结论

| 问题 | 结论 |
|---|---|
| Q1 无 runId/messageId 用什么证据？ | 只允许严格 `UNIQUE_SCOPE_RESOLUTION`；不能用 current/latest route |
| Q2 什么叫唯一 candidate？ | 唯一未过期、Decision 已冻结、状态可输出、无竞争 candidate |
| Q3 什么状态可做 candidate？ | 非终态且允许输出；MODEL_OWNED 通常是 RECEIVED，但必须无并发竞争 |
| Q4 两个 candidate？ | `AMBIGUOUS`，不得猜 |
| Q5 0 个 candidate？ | `UNRESOLVED`，不得猜 |
| Q6 能否读 latest turn？ | NO |
| Q7 MODEL_OWNED 需要什么 proof？ | 当前 turn provenance + immutable route=MODEL_OWNED + expectedTool=null |
| Q8 MODEL_OWNED 不需要什么？ | 不需要 NAPM execution/result/finalContent proof |
| Q9 NAPM_QUERY 还需什么？ | Turn Admission、expectedTool、execution authority、result/finalContent authority |
| Q10 scope-only 能否放行 Query result？ | NO |
| Q11 两个 Hook 是否共用 Resolver？ | YES |
| Q12 A=NAPM_QUERY/B=MODEL_OWNED 如何防串？ | A 必须 exact binding；scope-only 多候选时 ambiguous；禁止 latest fallback |
| Q13 两个 MODEL_OWNED 重叠怎么办？ | `AMBIGUOUS`，不按最新轮次猜 |
| Q14 previous NAPM 能否 fallback？ | NO |
| Q15 长期根治？ | OpenClaw 输出 Hook 传递 runId+messageId 或不可伪造 OutputTurnContext token |

## 21. 最小实施边界

### 计划修改

1. 新增/收口 `OutputTurnContextResolver`；
2. 必要时给 `QueryTurnCoordinator` 增加只读 `findEligibleOutputTurns(scope)`，只返回正式 candidate，不暴露内部 Map；
3. `message_sending` 和 `before_message_write` 共用 Resolver；
4. route-specific policy 分离 MODEL_OWNED、EXPLICIT_OUT_OF_SCOPE、NAPM_QUERY；
5. 细分 unresolved/ambiguous/binding/authority reasonCode；
6. 增加 split-hook、唯一 candidate、并发 candidate、过期和跨 scope 测试。

### 明确不修改

- QueryTurnCoordinator Query 状态机核心语义；
- `ResolvedQueryContract`；
- Semantic/Object/Metric 配置；
- Object × Metric ownership；
- Runtime Capability；
- `NapmQuerySerializer`；
- Direct Tool trace authority；
- BUG-A Query Gate；
- `buildLifecycleBindingFailureReply()` 的既有直接 Tool 语义；
- latest-turn fallback（明确禁止新增）。

## 22. 长期 OpenClaw 平台方案

短期 scope-only resolution 只能是受限兼容机制，不是最终架构。

长期应让 OpenClaw 输出 Hook 直接携带：

```text
runId + messageId
```

或插件签发的不可伪造 token：

```text
conversation scope
turnId
route
expectedTool
source run/message
expiry
```

这样输出 Hook 可直接 exact resolve 当前 turn，不需要 scope-level 推断。

## 23. 审核前检查清单

```text
1. 不使用模糊的“可验证 MODEL_OWNED route”
2. 已定义 OutputTurnContext
3. 已定义 Strong Binding
4. 已定义 Safe Scope-Level Resolution
5. Safe Scope Resolution 必须 unique + non-competing
6. 0 candidate = UNRESOLVED
7. >1 candidate = AMBIGUOUS
8. latest-turn fallback = FORBIDDEN
9. MODEL_OWNED 需要可信 current-turn provenance
10. MODEL_OWNED 不需要 NAPM execution proof
11. NAPM_QUERY 保持 execution/result authority
12. scope-only route 不足以放行 NAPM Query result
13. 两个输出 Hook 共用 Resolver
14. 不根据 assistant 文本重新分类
15. 不重新跑 Semantic classifier 决定 route
16. 已覆盖 NAPM A + MODEL B 并发
17. 已覆盖两个 MODEL_OWNED 重叠
18. previous NAPM 不能作为 fallback
19. BUG-A Query Gate 不削弱
20. 长期方案是 runId/messageId 或 trusted token
21. 本轮不修改代码
```

## 24. 当前审核结论

```text
Root Cause: CONFIRMED

Previous Design Risk:
上一版“可验证 MODEL_OWNED route”未定义 provenance，存在误用 conversation current/latest route 的风险。

Trusted Output Turn Resolution:
Strong Binding 优先；无身份时仅允许 unique + non-competing 的 UNIQUE_SCOPE_RESOLUTION。

Safe Scope Fallback Rule:
0 个 candidate=UNRESOLVED；多个 candidate=AMBIGUOUS；不得猜测。

MODEL_OWNED Proof Requirement:
可信当前轮 provenance + immutable route=MODEL_OWNED + expectedTool=null。

NAPM_QUERY Proof Requirement:
可信当前轮、Turn Admission、expectedTool、execution authority、result/finalContent authority 全部满足。

Ambiguous Turn Handling:
fail-safe，不读取 latest turn，不借用其他 route。

Latest Turn Fallback:
FORBIDDEN

Concurrency Safety:
任何 scope-only resolution 都必须唯一且无竞争；NAPM Query 结果不能仅凭 scope resolution 放行。

Functions Proposed To Change:
OutputTurnContextResolver、两个输出 Hook，必要时 QueryTurnCoordinator 只读 candidate 查询接口。

Functions Explicitly Not Changed:
BUG-A Query Gate、Query Contract、Semantic/Object/Metric、Runtime Capability、Serializer、Direct Tool trace authority。

Code Modified: YES（本轮已进入实施阶段）
Runtime Deployed: YES（rc.60）
Remote Restarted: YES（由 install-release.sh 自动恢复）
BUG-A Modified: NO
BUG-B Modified: NO
```

## 25. 本轮实施记录

本轮先完成本地实现，随后按统一发布流程部署远端。

### 25.1 新增模块

```text
plugin/OutputTurnContextResolver.js
```

统一输出轮次解析，支持：

- `RUN_BOUND`；
- `MESSAGE_BOUND`；
- `TURN_TOKEN`；
- `UNIQUE_SCOPE_RESOLUTION`；
- `RESOLVED`；
- `UNRESOLVED`；
- `AMBIGUOUS`。

### 25.2 Plugin 集成

`napm-openclaw-plugin.remote.js` 新增：

- 当前 scope 下的不可变 Output Turn Admission 记录；
- 过期清理；
- `/new` / scope 清理；
- 输出 Hook 共用 `buildOutputTurnResolutionContext()`；
- `output_turn_context_resolved` / `output_turn_context_blocked` 审计事件。

输出策略：

```text
Strong Binding
  → 继续现有精确 turn/result 处理

唯一 scope candidate + MODEL_OWNED
  → 原样放行，不要求 NAPM execution proof

唯一 scope candidate + EXPLICIT_OUT_OF_SCOPE
  → 固定软引导

唯一 scope candidate + NAPM_QUERY
  → 仅获得 route identity，仍阻断 Query result 交付

多 candidate / 无 candidate
  → AMBIGUOUS / UNRESOLVED，fail-safe
```

没有新增 conversation latest-turn fallback。

### 25.3 回归测试

新增：

```text
test/output-turn-context-resolver.test.js
```

补充：

```text
test/napm-openclaw-plugin-out-of-scope-guard.test.js
```

覆盖：

- split-hook MODEL_OWNED 问候；
- split-hook explicit out-of-scope；
- 两个重叠 MODEL_OWNED → AMBIGUOUS；
- NAPM_QUERY + MODEL_OWNED 重叠 → 不借用 MODEL_OWNED route；
- NAPM Query fail-closed；
- latest-turn fallback 禁止。

### 25.4 当前验证状态

```text
定向测试：125 tests passed
完整 Jest：158 suites / 1343 tests passed
lint：passed
verify:runtime-contract：passed
git diff --check：passed
```

实现阶段未：

```text
远端部署
```

### 25.5 rc.60 部署记录

```text
version: 1.1.0-rc.60
commit: 574f42a8991807d7e6b640f8f55f5e8546efefee
package: NAPM_skill-1.1.0-rc.60-574f42a8.zip
sha256: 9f4f1b01831a908f47fd2e914a5a0a063a30650ffce3ec751b1be24a8f293c5b
```

部署验证：

- 远端 SHA-256 与本地一致；
- staged release verification 通过；
- installer dry-run 从 rc.59 升级到 rc.60 通过；
- 正式安装成功，未触发回滚；
- workspace / extension manifest 均为 rc.60；
- Gateway active；
- system watcher active；
- 8 个生产 Tool 注册完整；
- lifecycle smoke 通过。

自动回滚备份：

```text
/home/netinside/.openclaw/deploy_backups/20260914_103341_napm_1.1.0-rc.60_574f42a8/
```

备份目录：

```text
C:\Users\20693\AppData\Local\Temp\napm-model-owned-pre-20260914-100656
```

## 26. 实施后审核重点

审核时重点确认：

1. `UNIQUE_SCOPE_RESOLUTION` 是否只在唯一且无竞争 candidate 时成立；
2. `NAPM_QUERY` 是否仍不能凭 scope-only route 交付结果；
3. 强绑定的当前告警/报告结果是否保持原有确定性交付；
4. 两个输出 Hook 是否确实共用同一个 Resolver；
5. 是否存在任何读取 conversation latest turn 的新路径；
6. 当前 scope admission 记录是否会在 `/new` 和过期后清理；
7. OpenClaw 真实 split-hook 上下文是否与测试夹具一致。

rc.60 已部署完成；真实企业微信业务问候和 NAPM 查询验收仍需人工验证。
