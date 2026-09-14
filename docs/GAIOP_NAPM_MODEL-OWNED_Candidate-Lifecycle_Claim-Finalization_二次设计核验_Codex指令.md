# GAIOP NAPM — MODEL_OWNED Candidate 生命周期二次设计核验指令
## 主题：从“直接退休”进一步核验为 `claim / accepted → finalization / retirement`

> 当前已知部署现状：
>
> ```text
> rc.60 已部署
> 第一轮 Web MODEL_OWNED 问候正常
> 第二轮开始 OUTPUT_TURN_AMBIGUOUS
> 第三轮 candidateCount 继续增加
> ```
>
> 当前现状文档已经确认：
>
> ```text
> Web 输出 Hook 缺 runId/messageId
> +
> MODEL_OWNED scope candidate 在上一轮输出成功后没有退出候选集合
> ```
>
> 当前方案提出：
>
> ```text
> MODEL_OWNED 输出被 Hook 接受
> → markOutputTurnDelivered()
> → candidate retired
> ```
>
> 这个“需要收口 candidate”的方向是正确的。
>
> 但在正式实施 rc.61 前，还需要结合项目真实 Hook 生命周期再次核验一个关键问题：
>
> > `before_message_write` 的“允许继续”是否真的等价于“消息已经 delivered”？
>
> 如果不是，则不能过早把 candidate 标成 `delivered/retired`，否则可能在同一消息后续 Hook、真实发送失败或并发情况下制造新的生命周期错误。
>
> **本轮只做设计核验，不修改代码。**

---

# 1. 本轮性质

本轮：

```text
READ-ONLY LIFECYCLE DESIGN VERIFICATION
```

不要：

```text
修改 Plugin 代码
修改 OpenClaw bundle
修改 BUG-A
修改 BUG-B
打包 rc.61
部署
重启 Gateway / watcher
commit 新实现
```

可以：

```text
读取项目代码
读取当前设计文档
读取 Hook 注册和调用链
读取 OpenClaw 本地/已安装源码（只读）
运行现有测试或写临时只读回放脚本
更新设计文档
```

---

# 2. 已确认事实，不要重新争论

当前远端/项目证据已经确认：

```text
1. rc.60 第一轮 Web MODEL_OWNED：
   UNIQUE_SCOPE_RESOLUTION
   route=MODEL_OWNED
   正常输出

2. 第二轮：
   OUTPUT_TURN_AMBIGUOUS
   candidateCount=2

3. 第三轮：
   OUTPUT_TURN_AMBIGUOUS
   candidateCount=3

4. Web before_message_write：
   runId=null
   messageId=null
   只有 sessionKey/scope

5. 企业微信可通过 MESSAGE_BOUND 强绑定正常工作

6. MODEL_OWNED turn 通常停留在 RECEIVED，
   当前 candidate 查询只排除：
   expired / TERMINAL

7. 因此前一轮 MODEL_OWNED 在输出后没有自然退出 candidate 集合
```

当前核心根因：

```text
Candidate Lifecycle Not Closed
```

这个判断继续作为基线。

---

# 3. 当前方案中需要再次验证的关键点

当前方案拟在：

```text
before_message_write
```

中：

```text
MODEL_OWNED
+
UNIQUE_SCOPE_RESOLUTION
+
non-streaming assistant final
+
no toolCall
+
not cancelled
↓
markOutputTurnDelivered()
↓
retired
```

请不要直接实施。

先回答：

> `before_message_write` 到底证明了什么？

可能的事实层级至少有：

```text
A. 当前 output 已唯一归属于某 turn
B. 当前 Hook 已接受 output
C. 当前 output 已写入内部 message/session
D. 当前 output 已进入发送流程
E. 当前 output 已成功发往 channel/WebSocket
F. 用户端已经收到
```

必须基于真实代码确认 `before_message_write` 对应哪一级。

---

# 4. 必须追清真实 Hook 顺序

请从当前项目 + OpenClaw 真实源码/安装包中核验：

```text
message_received
↓
模型生成
↓
before_message_write
↓
？
↓
message_sending
↓
？
↓
实际 channel delivery / WebSocket / persistence
↓
是否存在 message_sent / after_delivery / completion callback
```

输出精确调用链：

```text
文件
函数
调用顺序
Hook 返回值如何被消费
Hook 失败/取消意味着什么
```

至少回答：

```text
Q1. before_message_write 一定早于 message_sending 吗？
Q2. 两个 Hook 是否每条 assistant final 都一定执行？
Q3. Web 与企业微信顺序是否完全一致？
Q4. message_sending 是“发送前”还是“发送成功后”？
Q5. 是否存在真正的 delivery-success / message_sent 回调？
Q6. before_message_write 返回 undefined 后，后续仍可能失败吗？
Q7. message_sending 返回允许后，后续仍可能失败吗？
Q8. 哪个位置是 Plugin 能看到的最晚、最可靠生命周期点？
```

---

# 5. 不要把“Hook 接受”直接命名成 Delivered，除非代码证明

如果代码只能证明：

```text
Plugin accepted this final output
```

则状态名应该更准确，例如：

```text
OUTPUT_ACCEPTED
PLUGIN_ACCEPTED
CLAIMED_FOR_OUTPUT
```

不要错误命名：

```text
DELIVERED
```

除非项目有真实证据表明：

```text
用户通道交付已经完成
```

---

# 6. 重点核验 TOCTOU：两个 Hook 之间 candidate 会发生什么

必须回放/分析：

```text
Turn A = MODEL_OWNED
只有一个 scope candidate
```

然后：

```text
before_message_write
→ UNIQUE_SCOPE_RESOLUTION=A
```

如果在这里立即：

```text
retire(A)
```

那么随后：

```text
message_sending
```

如果也没有 runId/messageId：

```text
getOutputTurnCandidates()
→ A 已被排除
→ 0 candidate
→ UNRESOLVED
```

请根据真实 Hook context 回答：

```text
这个情况会不会发生？
```

---

# 7. 本轮需要重点判断是否需要两阶段状态

请基于真实代码判断是否需要：

```text
ELIGIBLE
↓
CLAIMED_FOR_OUTPUT / ACCEPTED
↓
FINALIZED / RETIRED
```

而不是：

```text
ELIGIBLE
↓
直接 RETIRED
```

注意：

> 这是待验证设计，不是强制要求一定新增三个字段。

如果项目实际证明：

```text
before_message_write 是唯一 final admission，
后面没有第二次 scope resolution，
且“接受”后 candidate 就应该退出普通候选集合
```

那么可以给出更简单方案。

但必须用代码证据证明。

---

# 8. 如果采用 Claim，必须定义 Claim 的准确用途

Claim 不应成为第二套 Turn Truth Source。

它只能表达：

```text
某个已解析的 immutable turnId
已经被某一具体 output attempt 领取
```

不能重新保存/决定：

```text
route
expectedTool
semantic intent
NAPM authority
```

这些仍来自：

```text
immutable TurnAdmissionDecision
```

---

# 9. Claim 必须绑定“同一输出”，不能变成 latest claim

如果采用 claim，必须回答：

```text
后续 Hook 怎么知道：
“这个 claim 就属于我当前处理的同一条 output”？
```

不能使用：

```text
scope 下最新 claim
最后一个 claim
最近 claim
conversation current claim
```

否则只是把：

```text
latest turn fallback
```

换成：

```text
latest claim fallback
```

同样不安全。

---

# 10. 如果 Hook 没有 output attempt identity，必须明确现实边界

假设 Web：

```text
before_message_write
无 runId
无 messageId

message_sending
也无 runId
无 messageId
```

那么即使有 claim，也要问：

> 第二个 Hook 靠什么证明它处理的是同一个 output attempt？

请判断实际可用信息是否包括：

```text
sessionKey
conversationId
assistant message object/id
content object reference
timestamp
hook execution token
dispatch id
delivery id
```

其中哪些是：

```text
可信稳定 identity
```

哪些不能作为安全主键。

---

# 11. 必须核验 Assistant Message 本身是否有 ID

请继续检查：

```text
event.message.id
assistantMessage.id
message.id
payload.id
deliveryId
replyId
```

是否存在。

如果 assistant output 自己有稳定 message identity：

```text
这可能是 claim 跨 Hook 关联的最佳短期证据。
```

但必须确认两个 Hook 都拿得到同一值。

---

# 12. 必须检查是否存在真正 After-Delivery Hook

搜索：

```bash
rg "message_sent|after.*send|after.*deliver|delivered|delivery.*success|post.*send|message.*written|after_message"   .   <OpenClaw-source-or-installed-runtime>
```

如果存在真正发送成功后的 Hook：

```text
Claim/Accept earlier
→ Finalize/Retire at after-delivery
```

如果不存在：

```text
必须明确 Plugin 能保证的最高语义只是 PLUGIN_ACCEPTED，
而不是用户实际收到。
```

---

# 13. Candidate 从普通候选集合退出不一定等于彻底删除

可能需要区分：

```text
eligibleForScopeResolution = true/false
```

和：

```text
recordExists = true/false
```

例如：

```text
A 已被当前 output claim
```

可以：

```text
不再作为下一轮普通 scope candidate
```

但仍保留：

```text
claim record
```

供同一 output 的后续 Hook解析。

不要把：

```text
从 candidate set 排除
```

等价成：

```text
立即删除所有状态。
```

---

# 14. 建议核验的生命周期模型

请根据项目选择或提出更好的方案。

候选模型：

```text
ELIGIBLE
  ↓
CLAIMED
  ↓
FINALIZED
  ↓
RETIRED / TTL CLEANUP
```

如果项目无需四态，可以简化。

但必须明确每个 transition 发生在哪个真实函数。

---

# 15. 必须定义 Transition Table

修改后的设计必须给：

```markdown
| Current State | Event | Preconditions | Next State | Can participate in new scope resolution? |
|---|---|---|---|---:|
| ELIGIBLE | before_message_write accepted | ... | ... | ... |
| ... | message_sending | ... | ... | ... | ... |
| ... | send cancelled | ... | ... | ... | ... |
| ... | timeout | ... | ... | ... | ... |
| ... | /new | ... | ... | ... | ... |
```

不能只写：

```text
成功就 retire
```

---

# 16. 必须定义失败恢复

重点回答：

```text
before_message_write 已 claim
但后续 message_sending cancel / throw / delivery fail
怎么办？
```

不能留下：

```text
永远 CLAIMED
```

导致未来同 scope 永久卡住。

---

# 17. 幂等性必须正式设计

必须保证：

```text
claim(A, outputX)
claim(A, outputX)
```

幂等。

```text
finalize(A, outputX)
finalize(A, outputX)
```

幂等。

但是：

```text
claim(A, outputX)
finalize(B, outputX)
```

必须拒绝。

```text
claim(A, outputX)
claim(B, outputX)
```

必须拒绝。

---

# 18. 不允许 Delivery State 成为第二 Route Truth

如果新增：

```text
OutputTurnAdmission / DeliveryRecord
```

其中可以缓存：

```text
turnId
scope
claim/delivery timestamps
provenance
```

但：

```text
route
expectedTool
```

若存储只能是审计快照，不能成为执行真相。

执行时必须继续：

```text
turnId
→ QueryTurnCoordinator / immutable TurnAdmissionDecision
→ route / expectedTool
```

---

# 19. 两个 Hook 必须继续共用同一 Resolver

rc.60 已正确做到：

```text
message_sending
before_message_write
→ 共用 OutputTurnContextResolver
```

如果引入 claim resolution，也必须进入同一个 Resolver。

不要：

```text
before_message_write 自己认 claim
message_sending 再写另一套逻辑
```

---

# 20. Resolver 推荐的新分层（待项目核验）

可以考虑：

```text
resolveTrustedOutputTurnContext()
↓
1. Strong Binding
↓
2. Exact Output Claim Binding（如果存在且可信）
↓
3. Unique Eligible Scope Candidate
↓
4. UNRESOLVED / AMBIGUOUS
```

但：

```text
Exact Output Claim Binding
```

只有在能够证明“同一 output attempt”时才允许。

不能使用 latest claim。

---

# 21. NAPM_QUERY 安全边界继续保持

不论 candidate/claim 怎么改：

```text
NAPM_QUERY
```

仍不能仅靠：

```text
UNIQUE_SCOPE_RESOLUTION
CLAIMED_SCOPE_ONLY
```

放行查询结果。

必须继续要求：

```text
execution authority
result/finalContent authority
expectedTool
trusted current-turn identity
```

---

# 22. 并发场景必须重新按新生命周期验证

至少设计：

```text
A. 连续三轮 Web MODEL_OWNED
B. 同一 Output 两个 Hook
C. 同一 Output 重复 Finalize
D. Claim A 后 Turn B 到达
E. 两个真正重叠 MODEL_OWNED
F. NAPM_QUERY + MODEL_OWNED
G. Claim 后下游取消
H. /new 清理
I. TTL 清理
```

关键要求：

```text
连续三轮正常
重叠轮次仍 AMBIGUOUS
A 后续 Hook 不领取 B
B 不误领 A claim
NAPM 不借 route/claim/finalContent
```

---

# 23. 强绑定通道不能回退

企业微信当前：

```text
MESSAGE_BOUND
authority=STRONG_TURN_BINDING
```

必须保持。

新的 candidate lifecycle 不得让强绑定路径反而走 scope fallback。

优先级应继续：

```text
Strong Binding
>
Claim Binding（若存在）
>
Unique Scope Candidate
```

---

# 24. 必须重新核验 rc.60 新增 Admission Record 的职责

请查看：

```text
rememberOutputTurnAdmission()
getOutputTurnCandidates()
buildOutputTurnResolutionContext()
```

输出：

```markdown
| Record/Function | Stores What | Authoritative For What | Must Not Decide |
|---|---|---|---|
| ... | ... | ... | ... |
```

确认 Output Admission Record 没有成为：

```text
第二 route truth
第二 lifecycle truth
```

---

# 25. 必须查清当前 MODEL_OWNED QueryTurn 为什么一直是 RECEIVED

请回答：

```text
MODEL_OWNED 是否本来就应该在模型输出完成后进入某个已有 terminal state？
```

检查：

```text
QueryTurnCoordinator 所有状态
每个状态的语义
哪些 route 使用 terminal transition
MODEL_OWNED 是否被遗漏
```

如果已有：

```text
COMPLETED / DELIVERED / CLOSED
```

等合适状态，优先考虑复用。

---

# 26. 优先复用已有生命周期，不要重复造状态机

决策顺序：

```text
如果 QueryTurnCoordinator 已有适合的 output/delivery terminal state
→ 优先复用

如果没有
→ 再考虑 Output Admission 独立 claim/finalization 状态
```

不要未经核验就新增第二套生命周期。

---

# 27. 必须核验两个生命周期 Truth Source 的风险

当前可能有：

```text
QueryTurnCoordinator.status
```

和：

```text
OutputAdmission.retired/outputDeliveredAt
```

请明确：

```text
谁决定 turn 是否仍 active？
谁决定是否参与 output candidate？
谁负责 delivery audit？
```

目标：

```text
一个职责一个 truth source
```

---

# 28. OpenClaw 长期方案继续保留，但不要混入 rc.61

长期仍然：

```text
Web output hooks
→ runId + messageId
```

或：

```text
trusted OutputTurnContext token
```

当前 Plugin candidate lifecycle 只能是：

```text
bounded compatibility layer
```

---

# 29. 本轮需要输出的项目事实

最终报告必须先给事实，再给方案：

```text
before_message_write 实际生命周期语义：
message_sending 实际生命周期语义：
是否有 after-delivery hook：
Web 两个 Hook ctx：
企业微信两个 Hook ctx：
assistant message 是否有稳定 id：
是否有 output/delivery attempt id：
两个 Hook 是否共享同一个 message id/object：
QueryTurnCoordinator MODEL_OWNED 状态：
QueryTurnCoordinator 是否已有 terminal/delivery state：
```

不知道的必须写：

```text
UNKNOWN / NOT PROVEN
```

不要猜。

---

# 30. 最终设计必须明确选择

可以选择：

## Option A — 复用 QueryTurnCoordinator 终态

```text
Output final accepted
→ transition existing Turn state
→ candidate 自动退出
```

## Option B — Claim + Finalization

```text
ELIGIBLE
→ CLAIMED
→ FINALIZED/RETIRED
```

## Option C — 单点 Finalization，无 Claim

```text
两个 Hook 均保持 candidate
→ 只在最后一个可靠 Hook finalize
```

也可以提出 Option D。

但必须基于真实项目选择，不要为了迎合本指令强行选择 B。

---

# 31. 设计审核的关键问题

逐项回答：

```text
Q1. before_message_write 到底是不是 delivery terminal point？
Q2. message_sending 到底是在实际发送前还是发送成功后？
Q3. 两个 Hook 在 Web 是否都会执行？
Q4. 两个 Hook 是否都有 scope-only ctx？
Q5. 同一 assistant output 是否有跨 Hook 稳定 identity？
Q6. 如果 before_message_write 立即 retire，message_sending 会不会 UNRESOLVED？
Q7. 当前 QueryTurnCoordinator 是否已有可复用终态？
Q8. 是否真的需要新增 claim state？
Q9. claim 如何证明“同一 output”？
Q10. 禁止 latest claim 如何实现？
Q11. 下游发送失败时 claim/finalization 怎么恢复？
Q12. transition 是否幂等？
Q13. Output Admission Record 是否只是索引/审计，不是 route truth？
Q14. candidate 退出普通集合与 record 删除是否分离？
Q15. rc.61 最小需要改哪些函数？
Q16. 哪些函数明确不改？
Q17. OpenClaw 长期强身份方案是否仍保持独立？
```

---

# 32. 本轮最终文档建议结构

请更新：

```text
2026-09-14-Web端MODEL-OWNED候选轮次未收口与最终修复方案.md
```

扩展为：

```text
1. rc.60 现象
2. 远端证据
3. Candidate 累积根因
4. 当前 Hook 真实生命周期
5. QueryTurnCoordinator 现有状态机
6. Output Admission Record 职责
7. Accepted 与 Delivered 的区别
8. 两 Hook TOCTOU 风险
9. 是否需要 Claim
10. Candidate Lifecycle 最终状态机
11. Transition Table
12. Idempotency
13. Failure Recovery
14. Concurrent Turn Safety
15. Strong-binding channel non-regression
16. NAPM_QUERY non-regression
17. rc.61 最小修改边界
18. 测试矩阵
19. OpenClaw 长期方案
20. 实施前审核结论
```

---

# 33. 本轮最终报告格式

完成后停止，不实施代码。

## Project Facts

```text
before_message_write semantics:
message_sending semantics:
after-delivery hook:
Web hook identities:
WeCom hook identities:
assistant output stable id:
delivery attempt id:
QueryTurnCoordinator states:
MODEL_OWNED current state:
existing terminal state:
```

## Root Cause

```text
Candidate accumulation:
CONFIRMED / NOT CONFIRMED
```

## Immediate Lifecycle Choice

```text
Option A / B / C / Other
```

说明为什么。

## Candidate State Machine

给正式状态图。

## Transition Table

给完整表。

## Two-Hook Consistency

```text
before_message_write resolves:
message_sending resolves:
same-output correlation:
```

## Idempotency

```text
duplicate claim:
duplicate finalize:
wrong-turn finalize:
```

## Failure Recovery

```text
accepted then send fail:
timeout:
new turn arrives:
```

## Truth Source

```text
route truth:
turn lifecycle truth:
candidate eligibility truth:
delivery audit truth:
```

不得重复。

## Concurrency Matrix

至少：

```text
single MODEL_OWNED
three sequential MODEL_OWNED
two overlapping MODEL_OWNED
NAPM + MODEL
claim A + new B
downstream fail
```

## rc.61 Minimal Change Boundary

列：

```text
需要修改
明确不修改
```

## Long-Term OpenClaw Fix

保持：

```text
runId/messageId or trusted token
```

## Code / Deployment

必须：

```text
Runtime code modified: NO
rc.61 built: NO
deployed: NO
remote restarted: NO
BUG-A modified: NO
BUG-B modified: NO
```

---

# 34. 审核通过条件

只有全部满足才允许实施 rc.61：

```text
1. 已证明真实 Hook 顺序
2. 已证明 before_message_write 的真实语义
3. 已证明 message_sending 的真实语义
4. 已确认是否存在 after-delivery callback
5. 已确认 Web 两 Hook 可用 identity
6. 已确认同一 output 是否有稳定跨 Hook identity
7. 已确认 QueryTurnCoordinator 是否已有可复用 terminal state
8. 没有重复造第二生命周期 truth source
9. candidate 退出与 record 删除语义清楚
10. 两 Hook 不会因为提前 retire 产生 UNRESOLVED
11. 若采用 claim，claim 能绑定同一 output，不是 latest claim
12. claim/finalize 幂等
13. 下游失败有恢复策略
14. Strong Binding 路径不退化
15. 两个 MODEL_OWNED 重叠仍 AMBIGUOUS
16. NAPM + MODEL 不借 route/claim
17. NAPM_QUERY scope-only 仍不能交付 result
18. /new 和 TTL 只做清理，不代替正常收口
19. rc.61 修改边界最小
20. OpenClaw 长期强身份方案保持独立
21. 本轮未修改运行时代码
```

---

# 35. 本轮最重要的原则

这次不要把问题简单理解成：

```text
“第一轮用完后把 candidate 删掉”
```

更准确的问题是：

```text
一个 output turn 从：
可被解析
→ 被某个 output attempt 接受/领取
→ 完成 Plugin 输出责任
→ 不再参与未来 candidate resolution

这条生命周期
到底应该如何与现有 QueryTurnCoordinator / OpenClaw Hook 对齐？
```

目标是修复 candidate 累积，但同时避免：

```text
提前退休
同一消息第二 Hook 失去 turn
假 delivered
latest claim fallback
第二生命周期真相源
```

---

# 36. 本轮结束

完成项目事实核验和修订方案后：

```text
STOP
```

不要实施 rc.61。

把修订后的设计与核验结果提交 Review。

审核通过后，再单独进入：

```text
rc.61 Candidate Lifecycle Closure — Implementation
```
