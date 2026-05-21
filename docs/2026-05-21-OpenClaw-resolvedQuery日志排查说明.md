# 2026-05-21 OpenClaw `resolvedQuery` 日志排查说明

## 1. 目标

这份文档专门说明一件事：

- 如何判断某次 NAPM 问答里，OpenClaw 是否真的产出了 `resolvedQuery`
- 如果产出了，skill 是否正确收到并执行
- 如果失败，失败点是在上游构造、边界拦截，还是 skill 执行阶段

这次日志增强后，plugin 和 skill 会共同把关键链路写入同一个 `audit.log`。

## 2. 日志文件位置

默认日志文件：

- `/home/netinside/.openclaw/logs/audit.log`

如果环境变量 `NAPM_AUDIT_LOG_PATH` 被单独配置，则以环境变量为准。

## 3. 新增的关键日志事件

### 3.1 plugin 侧

plugin 会记录这些事件：

- `napm_plugin_skill_call_received`
- `napm_plugin_resolved_query_blocked`
- `napm_plugin_resolved_query_forwarded`
- `napm_plugin_skill_executor_invoked`
- `napm_plugin_skill_executor_completed`
- `napm_plugin_skill_executor_failed`

含义如下：

- `napm_plugin_skill_call_received`
  - 表示 OpenClaw 已经准备调用 `napm-skill-query`
  - 这里能看到原始 `resolvedQuery` 和规范化后的 `resolvedQuery`

- `napm_plugin_resolved_query_blocked`
  - 表示 plugin 在边界入口直接拦截了这次 skill 调用
  - 通常说明上游没有构造出合法的 `resolvedQuery`

- `napm_plugin_resolved_query_forwarded`
  - 表示 plugin 认为这次调用可以继续进入 skill
  - 这时说明上游至少已经带上了一个可放行的结构化查询

- `napm_plugin_skill_executor_invoked`
  - 表示 plugin 已经开始调用本地 skill 脚本

- `napm_plugin_skill_executor_completed`
  - 表示 skill 脚本返回了结果

- `napm_plugin_skill_executor_failed`
  - 表示 plugin 调用 skill 脚本时发生了进程级/脚本级错误

### 3.2 skill 侧

skill 会记录这些事件：

- `napm_skill_resolved_query_received`
- `napm_skill_execution_started`
- `napm_skill_execution_completed`
- `napm_skill_execution_failed`
- `napm_skill_missing_resolved_query`

含义如下：

- `napm_skill_resolved_query_received`
  - 表示 skill 已经真正收到结构化输入
  - 会记录 `resolvedQuery` 来源和最终归一化后的内容

- `napm_skill_execution_started`
  - 表示 skill 已经开始执行查询

- `napm_skill_execution_completed`
  - 表示 skill 正常完成
  - 可能是数据查询完成，也可能是澄清、拒绝、drilldownCatalog、security_refusal 这类“正常结束”

- `napm_skill_execution_failed`
  - 表示 skill 在执行阶段报错

- `napm_skill_missing_resolved_query`
  - 表示 skill 根本没有拿到合法结构化 `resolvedQuery`
  - 即命中 `UPSTREAM_RESOLVED_QUERY_REQUIRED`

## 4. traceId 的作用

这次改动增加了 `traceId`。

作用：

- plugin 写日志时带 `traceId`
- plugin 调 skill 时把 `traceId` 一起传给 skill
- skill 继续带着同一个 `traceId` 写日志

这样可以把一次问答的 plugin 日志和 skill 日志串起来看。

## 5. 日志里重点看哪些字段

### 5.1 plugin 侧重点字段

- `traceId`
- `prompt`
- `boundaryMode`
- `validation.ok`
- `validation.reason`
- `originalResolvedQuery`
- `canonicalResolvedQuery`
- `resolvedQuerySummary`
- `context.conversationId`
- `context.runId`
- `context.messageId`

### 5.2 skill 侧重点字段

- `traceId`
- `resolvedQuerySource`
- `resolvedQuery`
- `resolvedQuerySummary`
- `service`
- `requestUrl`
- `rowCount`
- `responseType`
- `error.code`
- `error.message`

## 6. 如何快速查看日志

### 6.1 直接看最近的 NAPM 审计日志

```bash
tail -f /home/netinside/.openclaw/logs/audit.log | grep napm_
```

### 6.2 只看 plugin 侧 `resolvedQuery` 入口

```bash
tail -f /home/netinside/.openclaw/logs/audit.log | grep 'napm_plugin_'
```

### 6.3 只看 skill 侧执行情况

```bash
tail -f /home/netinside/.openclaw/logs/audit.log | grep 'napm_skill_'
```

### 6.4 按某次 `traceId` 精确筛选

```bash
grep 'napm-xxxx' /home/netinside/.openclaw/logs/audit.log
```

实际使用时，把 `napm-xxxx` 替换成日志里的真实 `traceId`。

## 7. 怎么判断问题在哪一层

### 情况 1：上游没有产出 `resolvedQuery`

典型特征：

- 有 `napm_plugin_skill_call_received`
- 紧接着出现 `napm_plugin_resolved_query_blocked`
- `validation.ok=false`
- `validation.reason` 常见为：
  - `missing_resolved_query`
  - `missing_service`
  - `incomplete_resolved_query`

判断：

- 问题在 OpenClaw mainflow
- 还没有形成合法 `resolvedQuery`
- 这不是 skill 的执行问题

### 情况 2：plugin 放行了，但 skill 没拿到

典型特征：

- 有 `napm_plugin_resolved_query_forwarded`
- 也有 `napm_plugin_skill_executor_invoked`
- 但 skill 出现 `napm_skill_missing_resolved_query`

判断：

- 问题在 plugin 到 skill 的传递链路
- 说明上游有结构化意图，但最终没正确传入 skill

### 情况 3：skill 收到了，但执行失败

典型特征：

- 有 `napm_skill_resolved_query_received`
- 有 `napm_skill_execution_started`
- 最后是 `napm_skill_execution_failed`

判断：

- 问题在 skill 执行阶段
- 可能是参数转换、底层网关调用、返回数据解析等问题

### 情况 4：skill 正常完成

典型特征：

- 有 `napm_skill_execution_completed`
- 且会带 `service`、`responseType`、`requestUrl`、`rowCount`

判断：

- skill 查询链路是正常的
- 如果用户回复仍不对，问题更可能在：
  - 上游问题理解
  - 最终回答整合
  - 展示层解释

## 8. 建议测试问法

建议用下面这些问法做验证：

- `系统中有哪些工作组？`
- `业务都可以查哪些指标？`
- `BusinessGroup 可以往下钻到哪里？`
- `哪个客户端IP丢包最高？`
- `现在应用整体情况怎么样？`

## 9. 预期判责方式

### `系统中有哪些工作组？`

预期：

- 应先在 plugin 日志中看到：
  - `service=groups`
  - `operation=metadata_list`
  - `groups=[{type:"BusinessGroup"}]`

如果没有：

- 说明上游没有稳定构造 `resolvedQuery`

### `BusinessGroup 可以往下钻到哪里？`

预期：

- plugin 放行的 `resolvedQuerySummary.service` 应为 `drilldownCatalog`
- skill 侧应出现：
  - `napm_skill_resolved_query_received`
  - `napm_skill_execution_completed`
  - `responseType=drilldown_catalog`

### `哪个客户端IP丢包最高？`

预期：

- strict 模式下，必须由上游显式产出：
  - `service=topValues`
  - `metric=PLI`
  - `topMetric=PLI`
  - `groups=[{type:"IPAddress"}]`

如果 plugin 直接拦截：

- 说明不是 skill 错
- 而是上游没有把问法结构化

## 10. 结论

这次日志增强的目的不是增加更多 fallback，而是让链路具备“可判责性”：

- 到底有没有 `resolvedQuery`
- 是谁没产出
- 是谁传丢了
- 还是谁执行失败了

这样你后面测试时，不需要再靠猜，就能从日志直接判断问题落点。
