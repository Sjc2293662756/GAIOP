# 2026-05-25 resolvedQuery 时间字段上游构造校验修复

## 背景

用户测试：

```text
丢包率最高的IP是谁？
```

OpenClaw 调用 `napm-skill-query` 时传入了如下结构：

```json
{
  "service": "topValues",
  "groups": [{ "type": "IPAddress" }],
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "topCount": 1,
  "timeRange": {
    "start": 1779638400,
    "end": 1779724799
  }
}
```

而当前 resolvedQuery-first 契约要求：

```json
{
  "service": "topValues",
  "start": 1779638400,
  "end": 1779724740,
  "timeRange": {
    "key": "today",
    "displayText": "今天"
  }
}
```

即：执行时间必须在 `resolvedQuery.start` / `resolvedQuery.end` 根层级，并且必须按 60 秒分钟边界对齐。

## 问题判断

这次不是 skill 没有正确解析时间。

`run_napm_query.js` 删除 `timeRange.start/end` 是符合新契约的行为：`timeRange` 只允许作为声明性元数据，不再是执行字段。

真正的问题在上游构造：OpenClaw 仍然把可执行时间放进了 `timeRange.start/end`，没有生成根层级 `start/end`。

旧链路里这个问题会一直拖到 skill 执行阶段才暴露，日志表现为：

```json
{
  "service": "topValues",
  "timeRange": {},
  "start": null,
  "end": null
}
```

这容易误判成 skill 时间解析失败。

## 修改目标

本次不做兜底，不把 `timeRange.start/end` 自动搬运到根层级。

本次目标是：

- 让 OpenClaw 工具描述和 schema 明确要求根层级 `start/end`。
- 在 plugin 边界提前拒绝错误结构，避免错误请求进入 skill。
- 在审计日志里显式标出是否存在嵌套时间字段，方便判断是上游构造问题还是 skill 执行问题。

## 修改内容

### 1. 强化 `napm-skill-query` 工具 schema

文件：

```text
napm-openclaw-plugin.remote.js
```

变更：

- `napm-skill-query` 的 description 增加时间构造契约。
- `resolvedQuery.start` / `resolvedQuery.end` 增加字段说明。
- `timeRange` 只允许 `key` / `displayText`，不再允许 `start` / `end`。
- 对 `topValues`、`averageValues`、`timeValues`、`overview`、`topValues_multi_protocol` 增加条件 schema，要求必须提供根层级 `start/end`。

### 2. 强化系统提示中的时间契约

在 `buildNapmRoutingSystemContext()` 中新增明确规则：

- 执行型数据服务必须生成根层级 `start/end`。
- `start/end` 必须在构造阶段按 60 秒对齐。
- `timeRange` 只用于 `key/displayText`。
- 给出错误与正确示例，避免模型继续构造 `timeRange.start/end`。

### 3. plugin 边界提前拦截错误 resolvedQuery

新增校验：

```text
invalid_time_field_location
```

触发条件：

- service 需要根层级 `start/end`；
- 但根层级缺失或非法；
- 同时存在 `timeRange.start` 或 `timeRange.end`。

返回信息：

```text
resolvedQuery.service=topValues must put executable timestamps at root-level start/end.
timeRange.start/timeRange.end are declarative only and cannot be used for execution.
```

同时新增分钟边界校验：

```text
invalid_time_boundary_alignment
```

触发条件：

- 根层级 `start/end` 存在；
- 但不是 60 秒整数倍。

### 4. 工具 execute 入口也执行同一套校验

此前主要依赖 `before_tool_call` 进行校验。

如果某些 OpenClaw 调用路径绕过了 guard 状态，但仍直接执行 `napm-skill-query.execute()`，错误结构可能继续进入 skill。

本次在 `createSkillToolDefinition().execute()` 内也加了同一套 `validateResolvedQueryAgainstSpec()` 校验。

如果校验失败，直接返回：

```json
{
  "ok": false,
  "source": "napm_openclaw_plugin_boundary",
  "responseType": "BOUNDARY_VALIDATION_ERROR",
  "error": {
    "code": "UPSTREAM_RESOLVED_QUERY_INVALID",
    "reason": "invalid_time_field_location"
  }
}
```

这不是兜底，而是强制上游重新构造正确 resolvedQuery。

### 5. 增强审计摘要

`summarizeResolvedQueryForAudit()` 新增字段：

```json
{
  "timeRangeKey": "today",
  "nestedTimeRangeStart": 1779638400,
  "nestedTimeRangeEnd": 1779724799,
  "hasNestedTimeRangeStart": true,
  "hasNestedTimeRangeEnd": true
}
```

以后看 audit 日志时：

- `start/end` 有值且 `hasNestedTimeRangeStart=false`：构造正确。
- `start/end=null` 且 `hasNestedTimeRangeStart=true`：上游构造错误。
- `reason=invalid_time_boundary_alignment`：上游没有完成分钟对齐。

## 测试

新增测试：

```text
test/napm-openclaw-plugin-time-contract.test.js
```

覆盖：

- 只有 `timeRange.start/end` 时，plugin 边界直接拒绝。
- 根层级 `start/end` 且按分钟对齐时允许通过。
- 直接调用工具 `execute()` 时，也会在进入 skill 前返回边界错误。

同时修正部分旧测试输入，使测试中的 `topValues` resolvedQuery 符合当前 strict 契约：

- 补齐 `queryModeKey: "topn"`。
- 补齐 `metrics: [...]`。

验证结果：

```text
npm test -- --runInBand
31 test suites passed
184 tests passed
```

## 后续判断方式

如果用户再次问：

```text
丢包率最高的IP是谁？
```

若日志出现：

```text
napm_plugin_resolved_query_blocked
reason=invalid_time_field_location
```

说明 OpenClaw 上游仍在构造错误形状，需要继续调整上游 resolvedQuery 构造提示或模型侧 schema 消费。

若日志出现：

```text
napm_plugin_resolved_query_forwarded
resolvedQuerySummary.start=...
resolvedQuerySummary.end=...
```

说明时间字段已经构造正确，后续问题才进入 skill 执行层排查。
