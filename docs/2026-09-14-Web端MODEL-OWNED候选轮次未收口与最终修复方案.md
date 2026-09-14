# Web 端 MODEL_OWNED 连续问候失败：现状与最终修复方案

## 1. 当前结论

rc.60 已成功部署，但 Web 端连续问候仍存在一个新的输出生命周期问题：

```text
第一轮问候：正常
第二轮问候：OUTPUT_TURN_AMBIGUOUS
第三轮问候：OUTPUT_TURN_AMBIGUOUS
```

这不是 Web 页面渲染问题，也不是 NAPM 查询语义问题，而是：

```text
Web 输出 Hook 缺少 runId/messageId
+
MODEL_OWNED candidate 在输出成功后没有完成收口
```

当前 rc.60 只解决了：

```text
无身份时不能直接套用 NAPM_QUERY 门禁
```

但还没有解决：

```text
scope-only MODEL_OWNED 输出成功后，candidate 何时退休
```

## 2. 当前部署状态

```text
active version: 1.1.0-rc.60
deployed commit: 574f42a8991807d7e6b640f8f55f5e8546efefee
branch: codex/napm-turn-decision-phase1
```

rc.60 部署前验证：

- 158 个测试套件、1343 个测试通过；
- lint 通过；
- runtime contract 通过；
- staged 验证通过；
- dry-run 通过；
- 正式安装成功；
- Gateway、Syslog watcher、8 个生产 Tool、lifecycle smoke 均正常。

因此本次 Web 问题不是版本没有部署。

## 3. Web 端远端日志证据

Web scope：

```text
agent:main:main:dm:webchat-c6f1a811ed5844f3afc84b2fce3a65f0
```

### 3.1 第一轮“你好？”

审计日志：`2026-09-14 10:40:40` 左右。

```text
status=RESOLVED
provenance=UNIQUE_SCOPE_RESOLUTION
authority=ROUTE_IDENTITY_ONLY
route=model_owned
turnId=napm-turn-a5a494fb-ac7e-46da-9bf3-984dc001f752
```

第一轮只有一个 candidate，因此 scope-only resolution 成功。

### 3.2 第二轮“你是？”

审计日志：`2026-09-14 10:41:04` 左右。

```text
status=AMBIGUOUS
code=OUTPUT_TURN_AMBIGUOUS
candidateCount=2
```

Hook 上下文仍然是：

```json
{
  "runId": null,
  "messageId": null,
  "sessionKey": "agent:main:main:dm:webchat-c6f1a811ed5844f3afc84b2fce3a65f0"
}
```

### 3.3 第三轮“你可以做些什么？”

审计日志：`2026-09-14 10:41:13` 左右。

```text
status=AMBIGUOUS
code=OUTPUT_TURN_AMBIGUOUS
candidateCount=3
```

这证明 candidate 没有在前一轮输出完成后被移除或标记为已交付。

## 4. 企业微信为什么正常

企业微信端拥有更完整的输出身份：

```text
provenance=MESSAGE_BOUND
authority=STRONG_TURN_BINDING
```

因此即使 `before_message_write` 的 scope-only 解析出现歧义，后续 `message_sending` 仍可以通过 `messageId` 精确找到当前 turn 并完成最终发送。

Web 端没有这个强绑定，所以直接暴露了 candidate 未收口问题。

```text
企业微信：
messageId → 精确 turn → 正常发送

Web：
只有 sessionKey → 依赖 scope candidate → candidate 累积后歧义
```

## 5. 当前代码位置

### 5.1 Candidate 创建

```text
napm-openclaw-plugin.remote.js
rememberOutputTurnAdmission()
```

当前每个 `message_received` 都会保存一份 Output Turn Admission。

### 5.2 Candidate 读取

```text
napm-openclaw-plugin.remote.js
getOutputTurnCandidates()
```

当前逻辑会把所有满足以下条件的 turn 视为候选：

```text
turn 存在
turn 未过期
turn 非 TERMINAL
```

对于 `MODEL_OWNED`，turn 通常一直停留在 `RECEIVED`，因此不会自然退出候选集合。

### 5.3 输出 Hook

```text
message_sending
before_message_write
```

两个 Hook 共用 `OutputTurnContextResolver`，这是正确方向；问题是 scope-only MODEL_OWNED 放行后没有记录：

```text
outputDelivered
outputCompletedAt
candidateRetired
```

## 6. 根因分类

### 主要根因：候选轮次生命周期未闭合

```text
MODEL_OWNED 输出成功
  ↓
Hook 返回 undefined / 原样放行
  ↓
没有将 candidate 标记为已交付
  ↓
下一轮继续参与 scope resolution
  ↓
OUTPUT_TURN_AMBIGUOUS
```

### 次要根因：Web 输出 Hook 缺少强身份

Web 端 `before_message_write` 上下文只有 session scope，没有：

```text
runId
messageId
```

所以短期必须依赖严格唯一 candidate，长期仍应让 OpenClaw 传递强身份。

## 7. 最终修复方案

### 7.1 第一阶段：Plugin candidate 收口

只修改当前 NAPM Plugin：

```text
napm-openclaw-plugin.remote.js
```

新增 candidate 生命周期字段：

```text
claimId
claimedAt
claimHook
claimProvenance
finalizedAt
retiredAt
deliveryStatus = ELIGIBLE / CLAIMED / FINALIZED / RETIRED
```

增加只读/写入边界：

```text
claimOutputTurn(scope, turnId, outputAttempt)
finalizeOutputTurn(scope, turnId, outputAttempt)
retireOutputTurn(scope, turnId)
```

`getOutputTurnCandidates()` 排除：

```text
deliveryStatus=CLAIMED
deliveryStatus=FINALIZED
deliveryStatus=RETIRED
```

### 7.2 何时可以退休 candidate

只有以下条件全部满足才允许进入 `CLAIMED`：

```text
route = MODEL_OWNED
resolution = RESOLVED
输出是非流式最终 assistant 文本
消息不包含 toolCall
没有被 cancel
当前输出确实被 Hook 接受
```

`CLAIMED` 不等于 `DELIVERED`，更不等于用户已经收到。只有存在可信的后续成功事件，才允许进入 `FINALIZED`，再进入 `RETIRED`。

不能在以下情况下退休：

```text
streaming preview
toolCall 中间消息
OUTPUT_TURN_AMBIGUOUS
OUTPUT_TURN_UNRESOLVED
NAPM_QUERY
执行中的其他 Skill
```

### 7.3 两个 Hook 的收口位置

#### `before_message_write`

Web 端主要经过此路径，因此必须在：

```text
MODEL_OWNED + UNIQUE_SCOPE_RESOLUTION
→ 确认非流式 assistant final
→ claimOutputTurn()
→ 原样保留消息
```

这里的语义是：

```text
Plugin 已接受该 output，并将其从普通 scope candidate 集合中暂时排除。
```

不是：

```text
已经完成 channel/WebSocket delivery
```

#### `message_sending`

企业微信等拥有强绑定的路径，在最终发送成功后也应收口：

```text
MODEL_OWNED + STRONG_TURN_BINDING
→ 发送前通过 message_sending
→ 不能直接称为 delivery success
→ 若存在同一 output 的 message_sent/after-delivery 事件，再 finalizeOutputTurn()
```

两个 Hook 必须使用同一份 candidate/claim 状态，避免重复领取或提前退休。

## 8. 并发安全要求

### 8.1 两个 MODEL_OWNED 重叠

```text
Turn A：你好
Turn B：你是谁？
```

如果没有强身份：

```text
candidateCount=2
→ AMBIGUOUS
→ 不得猜测
```

不能因为 A 比 B 早就自动退休 A，也不能读取 latest turn。

### 8.2 NAPM_QUERY + MODEL_OWNED 重叠

```text
Turn A：NAPM_QUERY
Turn B：你好
```

如果没有强身份：

```text
不能借用 MODEL_OWNED route 放行 A
不能把 NAPM_QUERY 当作 MODEL_OWNED
不能交付 NAPM 结果
```

必须保持 `AMBIGUOUS/UNRESOLVED → fail-closed`。

### 8.3 `/new`

`/new` 会清理 scope 下的 candidate；但正常 Web 连续聊天不能依赖用户发送 `/new` 才清理。

## 9. 第二阶段：OpenClaw Web 强身份传递

这是长期平台层修复，不属于当前 NAPM 查询仓库。

远端运行时相关文件：

```text
/home/netinside/.npm-global/lib/node_modules/openclaw/dist/message-hook-mappers-QYKm9QGS.js
/home/netinside/.npm-global/lib/node_modules/openclaw/dist/dispatch-C8IbdPmU.js
/home/netinside/.npm-global/lib/node_modules/openclaw/dist/compaction-successor-transcript-CQKOnfuL.js
```

对应 OpenClaw 源码职责：

```text
src/hooks/message-hook-mappers.ts
src/auto-reply/dispatch.ts
SessionManager / before_message_write hook context
```

### 9.1 `message-hook-mappers`

重点函数：

```text
deriveInboundMessageHookContext()
toPluginMessageContext()
buildCanonicalSentMessageHookContext()
toPluginMessageSentEvent()
```

确保输出 Hook context 继续携带：

```text
runId
messageId
sessionKey
conversationId
```

### 9.2 `dispatch` 输出上下文

重点函数：

```text
buildMessageSendingBeforeDeliver()
```

该函数不能只用 scope 构造输出 Hook context，而要把当前入站 run/message 身份传递到 `message_sending`。

### 9.3 `before_message_write`

当前 SessionManager 相关路径可能只传：

```text
agentId
sessionKey
```

长期需要传递：

```text
runId + messageId
```

或不可伪造的 `OutputTurnContext/admission token`。

不允许通过 conversation latest turn 代替。

注意：不应直接修改服务器上的 bundle 文件。应修改 OpenClaw 源码/发布包，重新构建并与 NAPM 部署流程协同发布。

## 10. 不需要修改的代码

本问题不需要修改：

- `skills/openclaw-napm-query` 查询语义；
- Object Ontology；
- Metric Catalog；
- Object × Metric ownership；
- Runtime Capability；
- `NapmQuerySerializer`；
- `QueryDecisionPolicy`；
- NAPM 南向接口；
- Web 前端页面渲染代码。

## 11. 必须补充的测试

### Plugin 本地测试

- 单轮 Web MODEL_OWNED split-hook → 原样输出；
- 连续三轮 Web 问候 → 三轮均正常；
- 第一轮输出后 candidate 被退休；
- 两个重叠 MODEL_OWNED → AMBIGUOUS；
- NAPM_QUERY + MODEL_OWNED → 不借用 route；
- NAPM_QUERY 缺 binding → fail-closed；
- streaming/toolCall 不退休 candidate；
- `/new` 清理 candidate；
- 过期 candidate 自动清理。

### OpenClaw 平台测试

- Web `message_received` 与 `before_message_write` 使用同一 message identity；
- Web `message_sending` 携带当前 run/message；
- 重叠 run 不共享 output identity；
- `before_message_write` 不再只携带 sessionKey；
- 企业微信现有强绑定行为不回退。

## 12. 最终实施顺序

```text
第一步：Plugin candidate delivery retirement
  ↓
本地回归 + rc.61 staged/dry-run
  ↓
第二步：真实 Web 端连续问候验收
  ↓
第三步：OpenClaw 源码补齐 runId/messageId
  ↓
OpenClaw 与 NAPM 统一发布验证
```

当前 rc.60 可以继续进行单轮 Web 问候测试，但连续问候可能再次触发 `OUTPUT_TURN_AMBIGUOUS`。

## 13. 当前审核结论

```text
当前现状：rc.60 已部署，但 Web 连续 MODEL_OWNED 输出仍存在 candidate 未退休问题。

立即修复位置：
NAPM Plugin 的 remember/get candidate 和两个输出 Hook。

长期修复位置：
OpenClaw message-hook-mappers、dispatch、before_message_write 上下文传递。

不涉及：
Web UI、NAPM Query Skill、Semantic、Metric、Query Gate。

本文件只记录现状和方案，不代表 rc.61 已实施。
```

## 14. CPT 二次设计核验结论

### 14.1 CPT 建议中确认正确的部分

以下意见与当前项目事实一致，已纳入修订方案：

1. `before_message_write` 的“允许继续”不能直接命名为 `delivered`；
2. `message_sending` 是发送前修改/取消 Hook，不等于发送成功；
3. candidate 生命周期应至少区分 `CLAIMED` 与 `FINALIZED/RETIRED`；
4. 必须考虑 Claim 后下游失败、超时和重复调用；
5. Claim 不能成为第二套 route truth；
6. 不能使用 latest claim 或 latest turn 作为输出归属；
7. 必须设计幂等和错误恢复。

### 14.2 需要结合本项目修正的部分

```text
CPT 建议“需要 Claim/Finalization”是正确方向，
但当前项目还不能直接断言 Web 存在 after-delivery 成功回调。
```

因此当前不能设计成：

```text
before_message_write
→ mark delivered
```

也不能设计成：

```text
message_sending 返回允许
→ 视为 delivered
```

修订后的现实语义是：

```text
before_message_write = Plugin accepted / transcript-write admission
message_sending = pre-channel-send mutation/cancel
message_sent = OpenClaw 某些 delivery path 的成功后事件，但 Web 是否经过该事件：当前未证明
```

## 15. 当前项目真实 Hook 语义

### 15.1 `before_message_write`

OpenClaw runtime 的 `runBeforeMessageWrite()` 是同步 Hook：

```text
Hook 返回 { message }
  → 替换待写入 transcript 的消息

Hook 返回 { block: true }
  → 阻止消息写入
```

它证明的最高语义是：

```text
PLUGIN_ACCEPTED_FOR_TRANSCRIPT_WRITE
```

它不证明：

```text
已经发送到 WebSocket
用户已经看到
channel delivery 成功
```

### 15.2 `message_sending`

OpenClaw 的 `runMessageSending()` 是发送前修改/取消 Hook：

```text
Hook 返回 { content }
  → 修改即将发送的内容

Hook 返回 { cancel: true }
  → 取消发送
```

它证明的最高语义是：

```text
PRE_SEND_ACCEPTED
```

它不等于：

```text
SEND_SUCCESS
```

### 15.3 `message_sent / after-delivery`

OpenClaw runtime 中存在 `message_sent` 事件和部分 channel delivery 回调，但当前 Web 的 `buildMessageSendingBeforeDeliver()` 路径是否必然触发可用于本 candidate 的 `message_sent`：

```text
UNKNOWN / NOT PROVEN
```

因此 rc.61 不能把 `message_sent` 当作已确认的 Web 最终化点，必须先做真实 Web Hook 回放核验。

## 16. 修订后的 candidate 状态机

```text
ELIGIBLE
  ↓  before_message_write / message_sending 成功领取
CLAIMED
  ↓  同一 output 的可信成功事件
FINALIZED
  ↓  清理或 TTL
RETIRED
```

### 16.1 状态含义

| 状态 | 含义 | 是否参与普通 scope candidate resolution |
|---|---|---:|
| `ELIGIBLE` | 尚未被当前 output 领取 | 是 |
| `CLAIMED` | 已被某个 output attempt 领取，暂时排除其他普通 scope 解析 | 否 |
| `FINALIZED` | 同一 output 已确认完成最终化 | 否 |
| `RETIRED` | 已清理/过期，不再参与任何解析 | 否 |

### 16.2 Claim 不等于 Delivered

```text
CLAIMED
≠
DELIVERED
```

`CLAIMED` 只表示：

```text
Plugin 已接受当前 output attempt，
并暂时不让该 candidate 被下一轮 scope-only 解析再次领取。
```

## 17. Transition Table

| Current State | Event | Preconditions | Next State | 可参与新的 scope resolution |
|---|---|---|---|---:|
| `ELIGIBLE` | `before_message_write` accepted | MODEL_OWNED、唯一解析、非流式、无 toolCall、产生 claimId | `CLAIMED` | 否 |
| `ELIGIBLE` | `message_sending` accepted | 强绑定或同一 output claim、未 cancel | `CLAIMED` | 否 |
| `CLAIMED` | `message_sent/after-delivery` success | 能证明同一 output attempt | `FINALIZED` | 否 |
| `CLAIMED` | downstream cancel/failure | 能证明同一 output attempt | `ELIGIBLE` 或进入短期 recovery lease | 是/按 lease |
| `CLAIMED` | timeout | 无成功回调且超过 claim TTL | `RETIRED` 或按安全策略恢复 | 否 |
| `FINALIZED` | duplicate finalize | 同一 claimId | 保持 `FINALIZED` | 否 |
| `FINALIZED` | wrong-turn finalize | claimId/turnId 不一致 | 拒绝 | 否 |
| 任意 | `/new` / scope clear | scope 匹配 | `RETIRED`/删除 | 否 |
| 任意未终态 | expiry | 超过 OutputTurn TTL | `RETIRED` | 否 |

如果当前 Web 没有可靠的下游失败/成功回调，`CLAIMED` 必须有有限 TTL，不能永久卡住 scope。

## 18. Claim 的身份和幂等

Claim 只能绑定：

```text
scope
turnId
claimId
claimHook
claimProvenance
output fingerprint（如果可取得）
claimedAt
```

Claim 不重新决定：

```text
route
expectedTool
semantic intent
NAPM authority
```

这些仍由 immutable `TurnAdmissionDecision` 和 Query Turn 提供。

幂等要求：

```text
claim(A, outputX) + claim(A, outputX) → 第二次返回已有 claim，不重复领取
finalize(A, outputX) + finalize(A, outputX) → 保持 FINALIZED
claim(A, outputX) + finalize(B, outputX) → 拒绝
claim(A, outputX) + claim(B, outputX) → 拒绝
```

如果两个 Hook 没有共享稳定的 output attempt identity：

```text
不能把第二个 Hook 的“最近 claim”当作同一 output 的证明。
```

## 19. 两个 Hook 的 TOCTOU 风险

必须避免：

```text
before_message_write
  → 立即 FINALIZED/RETIRED

message_sending
  → 再次解析同一 scope
  → 0 candidate
  → UNRESOLVED
```

因此修订为：

```text
before_message_write
  → CLAIMED，不直接 FINALIZED

message_sending / message_sent
  → 只有能证明同一 output 才继续 finalize
```

若 Web 实际只经过 `before_message_write`，则 Web 兼容路径的最高语义是：

```text
PLUGIN_ACCEPTED + CLAIMED
```

不能在文案、审计或设计中称为用户已收到。

## 20. Truth Source 职责划分

| Record/Function | Stores | Authoritative for | Must not decide |
|---|---|---|---|
| `TurnAdmissionDecision` | route、action、expectedTool、source | 当前轮 route truth | channel delivery |
| `QueryTurnCoordinator` | turn phase、attempt、finalContent、Query delivery claim | NAPM Query lifecycle/result | Web output transport |
| `OutputTurnAdmission` | scope、turnId、claim/finalization timestamps、provenance | 输出 candidate/claim 索引与审计 | route、semantic intent、NAPM authority |
| `OutputTurnContextResolver` | Strong/Claim/Unique Scope resolution | 当前输出归属解析 | 重新分类 prompt |
| OpenClaw delivery callback | channel delivery outcome（若存在） | 实际发送成功/失败 | NAPM Query route |

目标是：

```text
route truth = TurnAdmissionDecision
turn lifecycle truth = QueryTurnCoordinator
candidate claim truth = OutputTurnAdmission
channel delivery truth = OpenClaw delivery callback（若可用）
```

不能让 OutputAdmission 成为第二套 route truth。

## 21. CPT 建议与本项目的最终判断

| CPT 建议 | 判断 | 项目化结论 |
|---|---|---|
| 不要把 before_message_write accepted 直接叫 delivered | 正确 | 改为 CLAIMED/PLUGIN_ACCEPTED |
| 需要 claim/finalization 两阶段 | 正确 | 作为 rc.61 设计基线 |
| 检查 message_sent/after-delivery | 正确 | Web 是否存在需要真实验证，当前 NOT PROVEN |
| claim 必须绑定同一 output | 正确 | 禁止 latest claim |
| claim/finalize 必须幂等 | 正确 | 纳入测试 |
| QueryTurnCoordinator 是否复用 | 部分正确 | 当前 QueryTurn 没有 MODEL_OWNED delivery terminal；不直接改 Query 状态机，先用独立 OutputAdmission |
| 立即删除 candidate | 不正确 | 只能从普通 candidate 集合退出，record 保留用于 claim/finalize/recovery |
| message_sending accepted 等于 delivery success | 不正确 | 它是发送前 Hook，不是成功回调 |

## 22. rc.61 最小修改边界（实施前）

### 需要修改

- `napm-openclaw-plugin.remote.js`：OutputAdmission claim/finalization/recovery；
- `getOutputTurnCandidates()`：只返回 `ELIGIBLE`；
- 两个输出 Hook：共用 claim 状态；
- 必要时新增 OutputAttempt identity/fingerprint；
- 补充 Web 连续三轮、双 Hook TOCTOU、下游失败、TTL、幂等测试。

### 明确不修改

- `QueryTurnCoordinator` 的 Query 状态机核心语义；
- NAPM Query Skill、Semantic、Metric、Object×Metric、Runtime Capability；
- `NapmQuerySerializer`、NapmClient、南向接口；
- Web 前端 UI；
- BUG-A Query Gate；
- BUG-B；
- 不直接修改 OpenClaw 远端 bundle。

### 长期平台修改

另开 OpenClaw 平台变更：

```text
message-hook-mappers
dispatch
before_message_write context
```

补齐 runId/messageId 或可信 OutputTurnContext token；不与 rc.61 Plugin candidate claim 混成一个变更。

## 23. 本轮最终结论

```text
CPT 的核心审核意见正确。

上一版方案“Hook 接受后直接 markOutputTurnDelivered”不够严谨，已修订为：

ELIGIBLE
  → CLAIMED / PLUGIN_ACCEPTED
  → FINALIZED（只有可信成功事件）
  → RETIRED
```

当前项目事实：

```text
before_message_write：同步写入前 Hook，不是 delivery success
message_sending：发送前修改/取消 Hook，不是 delivery success
message_sent/after-delivery：runtime 存在，但 Web 是否必经，UNKNOWN/NOT PROVEN
```

因此本轮不实施 rc.61，等待确认：

1. OpenClaw Web 是否提供稳定的 output/message/delivery identity；
2. Web 是否触发 `message_sent` 或等价成功回调；
3. Claim 后失败/超时的恢复方式；
4. 是否采用独立 OutputAdmission 状态，而不是改 QueryTurnCoordinator。

```text
Runtime code modified: NO
rc.61 built: NO
deployed: NO
remote restarted: NO
BUG-A modified: NO
BUG-B modified: NO
```
