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
rc.61 package: not built
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

本轮只完成本地实现和提交：

```text
rc.61 package: not built
staged verification: not run for rc.61
dry-run: not run for rc.61
formal deployment: not performed
remote restart: not performed
```

远端当前仍是：

```text
1.1.0-rc.60
```

## 11. 后续发布前置条件

审核通过后才执行：

1. 升级版本号并构建 rc.61；
2. 运行完整本地质量门禁；
3. 上传完整 ZIP；
4. 远端 staged 验证；
5. installer dry-run；
6. 正式安装和自动回滚检查；
7. Web 连续三轮问候验收；
8. NAPM_QUERY fail-closed 回归验收。

本报告不代表 rc.61 已部署。
