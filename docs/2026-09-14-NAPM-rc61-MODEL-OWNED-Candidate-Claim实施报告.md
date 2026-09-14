# NAPM rc.61：MODEL_OWNED Candidate Claim 生命周期实施报告

## 1. 实施结论

本轮已完成 MODEL_OWNED Output Candidate Claim 生命周期的本地实现。

目标是解决 rc.60 Web 端连续问候问题：

```text
第一轮 MODEL_OWNED 正常
第二轮 candidateCount=2 → OUTPUT_TURN_AMBIGUOUS
第三轮 candidateCount=3 → OUTPUT_TURN_AMBIGUOUS
```

短期语义明确为：

```text
MODEL_OWNED final output 被当前 Plugin 唯一消费
→ CLAIMED
→ 立即退出普通 scope candidate 池
```

`CLAIMED` 不代表 channel delivery success 或用户已经收到。

## 2. 版本、提交和备份

```text
branch: codex/napm-turn-decision-phase1
code commit: a3aa39a
docs commit: a903ca3
current remote: 1.1.0-rc.60
rc.61 package: NAPM_skill-1.1.0-rc.61-4af35d6d.zip
```

修改前备份：

```text
C:\Users\20693\AppData\Local\Temp\napm-rc61-pre-claim-20260914-114637
```

## 3. 实现范围

新增 Candidate 状态：

```text
ELIGIBLE
CLAIMED
FINALIZED
RETIRED
```

语义：

| 状态 | 含义 | 是否参加普通 scope resolution |
|---|---|---:|
| `ELIGIBLE` | 尚未被 output 消费 | 是 |
| `CLAIMED` | 已被 output attempt 消费 | 否 |
| `FINALIZED` | 同一 output 有可信最终化事件 | 否 |
| `RETIRED` | 已清理、过期或放弃 | 否 |

新增能力：

```text
claimOutputTurn()
finalizeOutputTurn()
retireOutputTurn()
```

Candidate 记录保存：

```text
claimId
claimedAt
claimHook
claimProvenance
claimExpiresAt
finalizedAt
retiredAt
deliveryStatus
```

## 4. Claim 规则

只有以下条件全部满足才允许 Claim：

```text
route = MODEL_OWNED
resolution = RESOLVED
输出是非流式 assistant final
消息不含 toolCall
没有 cancel/block
```

Claim 后：

```text
candidate 不再进入新的普通 scope resolution
```

Claim 不等于：

```text
DELIVERED
用户已收到
channel send success
```

## 5. Hook 行为

### before_message_write

Web 端主要依赖此 Hook：

```text
MODEL_OWNED + UNIQUE_SCOPE_RESOLUTION
→ claimOutputTurn()
→ 原样保留模型文本
```

它只证明：

```text
PLUGIN_ACCEPTED_FOR_TRANSCRIPT_WRITE
```

不证明用户已收到消息。

### message_sending

强绑定通道继续优先使用：

```text
RUN_BOUND / MESSAGE_BOUND
```

`message_sending` 是发送前修改/取消 Hook，不能直接当作发送成功。

只有将来存在同一 output 的可信 `message_sent/after-delivery` 事件时，才调用 `finalizeOutputTurn()`。

## 6. 安全边界

### NAPM_QUERY

本轮没有放宽 NAPM_QUERY：

- scope-only Claim 不能交付 NAPM 查询结果；
- 缺少可信 turn binding 仍 fail-closed；
- 缺少 execution/result authority 仍 fail-closed；
- 不读取 conversation latest turn；
- 不借用 MODEL_OWNED route 或 claim。

### 并发

```text
两个真正重叠 MODEL_OWNED
→ candidateCount > 1
→ AMBIGUOUS
→ fail-safe
```

```text
NAPM_QUERY + MODEL_OWNED
→ 不跨轮借用 route、claim 或 finalContent
```

Claim 超时后：

```text
CLAIMED → RETIRED
```

不会回到 generic `ELIGIBLE`。

## 7. 代码变更文件

```text
napm-openclaw-plugin.remote.js
plugin/OutputTurnContextResolver.js
test/napm-openclaw-plugin-out-of-scope-guard.test.js
test/output-turn-context-resolver.test.js
```

未修改：

```text
QueryTurnCoordinator 的 Query 状态机核心语义
ResolvedQueryContract
Semantic/Object/Metric 配置
Object×Metric ownership
Runtime Capability
NapmQuerySerializer
NapmClient
NAPM Southbound
BUG-A Query Gate
BUG-B
Web UI
```

## 8. 测试覆盖

- 单轮 Web MODEL_OWNED split-hook；
- 连续三轮 MODEL_OWNED 输出 candidate 收口；
- 两个重叠 MODEL_OWNED → `AMBIGUOUS`；
- NAPM_QUERY + MODEL_OWNED 不串 route；
- Claim 重复调用幂等；
- 错误 Claim 被拒绝；
- Finalize 重复调用幂等；
- 错误 turn/claim finalize 被拒绝；
- explicit out-of-scope split-hook；
- NAPM Query fail-closed；
- streaming/toolCall 不提前退休 candidate。

## 9. 验证结果

```text
Jest: 158 suites / 1345 tests passed
lint: passed
verify:runtime-contract: passed
git diff --check: passed
Node syntax check: passed
```

## 10. 发布和部署状态

本轮已完成本地实现、统一打包和正式部署：

```text
rc.61 package: built
staged verification: passed
dry-run: passed
formal deployment: passed
remote restart: installer controlled and service recovery passed
```

远端当前为：

```text
1.1.0-rc.61

发布信息：

```text
commit: 4af35d6db6b7061342786e8b2bf8b2267c97f99d
sha256: 3ace059e9403f68355edcde1244ca69606775bccdd096ec5be41762091d654bd
backup: /home/netinside/.openclaw/deploy_backups/20260914_131958_napm_1.1.0-rc.61_4af35d6d/
```

部署后验证：

- workspace / extension manifest 均为 rc.61；
- Gateway active；
- system watcher active；
- 8 个生产 Tool 注册完整；
- lifecycle smoke 通过。
```

## 11. 后续发布前置条件

部署后仍需人工完成真实 Web 连续三轮问候和 NAPM_QUERY 业务验收；本次未执行真实南向业务查询。
