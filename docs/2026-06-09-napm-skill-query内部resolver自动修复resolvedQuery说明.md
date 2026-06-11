# NAPM skill query 内部 resolver 自动修复 resolvedQuery 说明

## 背景

2026-06-09 企业微信中出现如下查询链路问题：

```text
用户：最近丢包率最高的前10个IP都有谁？这次查询你耗时多久？分别在哪里时间长了？
模型：先手写 resolvedQuery 调用 napm-skill-query
插件：第一次拦截，提示缺 queryModeKey、metrics、topMetric
模型：第二次改写 resolvedQuery 后才成功
```

这不是 NAPM 查询接口慢，也不是 skill executor 本身慢。真实原因是生产主链路没有强制使用确定性 resolver 构造 `resolvedQuery`，导致模型在调用 `napm-skill-query` 前自由拼字段。

远端 audit 中的第一次错误结构如下：

```json
{
  "service": "topValues",
  "start": 1717891200,
  "end": 1717923600,
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近1小时"
  },
  "metric": "packetLossRate",
  "topCount": 10,
  "groups": [{ "type": "IPAddress" }],
  "order": "desc"
}
```

缺失字段：

- `queryModeKey`
- `metrics`
- `topMetric`

并且 `metric=packetLossRate` 不是执行层可用的 NAPM metric code。

同一句话在远端直接调用 `NapmResolvedQueryResolverService.resolvePrompt()` 可以一次生成正确结构：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 10
}
```

## 根因

生产工具面当前只注册：

```text
napm-skill-query
napm-report-export
napm-packet-analysis
```

诊断工具 `napm-resolve-query` / `napm-mainflow-query` 默认不注册，只有打开 `NAPM_ENABLE_DEV_RESOLVER_TOOLS=true` 时才会注册。

因此生产中模型不能依赖显式 resolver 工具。如果插件入口也不主动调用 resolver，模型就只能手写 `resolvedQuery`，于是出现：

```text
自然语言问题
  -> 模型自由拼 resolvedQuery
  -> napm-skill-query 边界校验失败
  -> 模型再尝试
  -> 用户感知为“查询耗时长、不断试错”
```

## 修复原则

本次没有把 `napm-resolve-query` / `napm-mainflow-query` 暴露为生产工具。

原因：

- 生产工具面应保持稳定，避免模型在 query skill 和 resolver 工具之间来回选择。
- resolver 是确定性构造能力，应作为 `napm-skill-query` 内部前置步骤，而不是让模型显式编排。
- 真正的生产链路应该是单入口：用户自然语言问题进入 `napm-skill-query`，插件内部自动补齐结构。

修复后的目标链路：

```text
用户自然语言问题
  -> OpenClaw 选择 napm-skill-query
  -> plugin prepare/before_tool_call 内部调用 NapmResolvedQueryResolverService
  -> validateResolvedQueryAgainstSpec
  -> run_napm_query.js
  -> NetInside
```

## 本次代码改动

### 1. queryModeKey 规范化

修改文件：

```text
napm-openclaw-plugin.remote.js
```

新增函数：

```text
normalizeQueryModeKeyForService()
normalizeResolvedQueryForPlugin()
```

行为：

```text
service=topValues:
  topValues / topN / top / ranking / data -> topn

service=averageValues:
  averageValues / avg / data -> average

service=timeValues:
  timeValues / trend / data -> timeseries

service=groups / metrics:
  groups / metrics / list / data -> metadata

service=overview:
  overview / overall / data -> overview
```

这样可以兼容模型写出的常见别名，但最终进入执行层前会变成 resolution spec 声明的标准值。

### 2. 收紧 queryModeKey 校验

`validateResolvedQueryAgainstSpec()` 增加了 `serviceSpec.queryModes` 白名单校验。

例如：

```text
topValues 只接受 queryModeKey=topn
averageValues 只接受 queryModeKey=average
timeValues 只接受 queryModeKey=timeseries
groups/metrics 只接受 queryModeKey=metadata
overview 只接受 queryModeKey=overview
```

注意：校验前会先做规范化。因此 `queryModeKey=topValues` 会先归一成 `topn`，不会被误拦截。

但 `overview + queryModeKey=auto_app_list` 这类语义错配不会被自动重建，而是继续交给专项 guard 拦截，避免把错误路由悄悄覆盖。

### 3. 自动修复缺失或不完整 resolvedQuery

新增函数：

```text
maybeAutoRepairResolvedQuery()
buildResolvedQueryForPrompt()
shouldAttemptResolvedQueryAutoRepair()
```

自动修复触发条件：

```text
missing_resolved_query
missing_service
unknown_service
incomplete_resolved_query
relative_time_range_stale_or_miscalculated
```

不自动修复：

```text
invalid_time_field_location
invalid_time_boundary_alignment
invalid_query_mode
```

其中 `invalid_time_field_location` 指只把执行时间放在 `timeRange.start/end`，没有根级 `start/end`。这类结构仍然必须拦截，因为 `timeRange` 是声明性元数据，不是执行时间字段。

### 4. prepare 和 before_tool_call 双入口接入

接入点：

```text
prepareSkillExecutionArgs()
buildCanonicalSkillToolParams()
before_tool_call napm-skill-query 分支
createSkillToolDefinition().execute()
```

这样可以覆盖两类入口：

- OpenClaw hook 路径：`before_tool_call`
- 直接 tool execute 路径：`napm-skill-query.execute()`

修复后，缺失或错误的结构会在进入执行器前变成：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 10,
  "start": 1780970460,
  "end": 1780974060,
  "timeRange": {
    "key": "last1hour",
    "displayText": "最近1小时"
  }
}
```

### 5. 自动修复 audit

新增 audit 事件：

```text
napm_plugin_resolved_query_auto_repaired
napm_plugin_resolved_query_auto_repair_failed
```

成功修复事件包含：

- 原始 `resolvedQuery`
- 原始摘要
- 修复后的 `resolvedQuery`
- 修复后摘要
- 触发修复的校验原因
- resolver intent
- resolver diagnostics

这可以用于后续回答：

```text
这次有没有发生模型重试？
在哪里耗时？
是不是插件自动修复了字段？
```

## 回归测试

修改测试：

```text
test/napm-openclaw-plugin-packet-loss-guard.test.js
test/napm-openclaw-plugin-resolver-tool.test.js
test/napm-openclaw-plugin-time-contract.test.js
```

新增覆盖：

- 原始丢包 Top IP 问句没有 `resolvedQuery` 时，自动生成 `topValues/topn/PLI/IPAddress`。
- 模型手写错误结构时，自动修复 `metric=packetLossRate`、缺 `metrics/topMetric/queryModeKey`、旧时间戳。
- `queryModeKey=topValues` 会归一为 `topn`，且不替换有效显式 query。
- `before_tool_call` 会把自动生成的 `resolvedQuery` 回写到 `params`。
- 生产工具面仍不暴露诊断 resolver 工具。
- 时间解析契约改为直接验证 `ResolvedQueryTimeRangeService`。

本次通过的关键回归：

```text
npm test -- --runTestsByPath \
  test/napm-openclaw-plugin-packet-loss-guard.test.js \
  test/napm-openclaw-plugin-resolver-tool.test.js \
  test/napm-resolved-query-resolver-service.test.js \
  test/napm-openclaw-plugin-time-contract.test.js \
  test/napm-openclaw-plugin-composite-application-inventory-guard.test.js \
  --runInBand
```

结果：

```text
Test Suites: 5 passed, 5 total
Tests: 41 passed, 41 total
```

语法检查：

```text
node --check napm-openclaw-plugin.remote.js
node --check .codex-temp/napm-openclaw-plugin.remote.js
```

均通过。

## 远端部署

部署目标：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
```

部署前备份：

```text
/home/netinside/.openclaw/deploy_backups/napm-openclaw-plugin-index.20260609-131246.js
```

上传后重启：

```text
systemctl --user restart openclaw-gateway.service
```

服务状态：

```text
openclaw-gateway.service active
```

远端插件 SHA256：

```text
7db1cd04fd31333b158324ca549e1e5ade392eff6c1c5402885ed4f605ee3821
```

与本地插件一致。

## 远端验证

### 1. 生产工具面

远端加载插件后注册工具：

```json
[
  "napm-packet-analysis",
  "napm-report-export",
  "napm-skill-query"
]
```

未注册：

```text
napm-resolve-query
napm-mainflow-query
```

### 2. 缺失 resolvedQuery 自动补齐

输入：

```text
最近丢包率最高的前10个IP都有谁？
```

调用 `napm-skill-query`，参数中没有 `resolvedQuery`。

远端 hook 输出：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 10,
  "start": 1780970460,
  "end": 1780974060
}
```

### 3. 错误 resolvedQuery 自动修复

输入错误结构：

```json
{
  "service": "topValues",
  "start": 1717891200,
  "end": 1717923600,
  "metric": "packetLossRate",
  "topCount": 10,
  "groups": [{ "type": "IPAddress" }]
}
```

远端 hook 修复为：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 10,
  "start": 1780970460,
  "end": 1780974060
}
```

### 4. 直接 tool execute 验证

同一个错误 payload 直接执行 `napm-skill-query.execute()`：

```text
ok: true
service: topValues
queryModeKey: topn
metric: PLI
rows: 10
requestUrlPresent: true
```

说明不再返回：

```text
UPSTREAM_RESOLVED_QUERY_INVALID
```

### 5. audit 验证

远端 audit 出现：

```text
napm_plugin_resolved_query_auto_repaired
napm_plugin_skill_call_received
napm_plugin_resolved_query_forwarded
```

其中 `napm_plugin_resolved_query_auto_repaired` 记录了：

- `reason=incomplete_resolved_query`
- 原始 `metric=packetLossRate`
- 原始缺失 `queryModeKey/metrics/topMetric`
- 修复后 `metric=PLI`
- 修复后 `queryModeKey=topn`

## 全量测试现状

本次执行过全量：

```text
npm test -- --runInBand
```

结果：

```text
Test Suites: 36 passed, 6 failed, 42 total
Tests: 257 passed, 14 failed, 271 total
```

失败主要来自旧契约测试，和本次修复后的生产行为冲突：

```text
test/napm-openclaw-plugin-direct-tool-removal.test.js
```

仍期待只注册 `napm-skill-query`，但当前生产实际已注册：

```text
napm-skill-query
napm-report-export
napm-packet-analysis
```

```text
test/napm-openclaw-plugin-business-inventory-guard.test.js
test/napm-openclaw-plugin-metric-inventory-guard.test.js
```

仍期待缺失 `resolvedQuery` 时直接阻断，但本次设计已经改为高确定性请求可由插件内部 resolver 自动补齐。

```text
test/napm-openclaw-plugin-meta-followup-guard.test.js
test/napm-openclaw-plugin-hierarchy-guard.test.js
```

部分测试仍期待没有 skill record 时不改写输出，但当前边界策略会输出 skill-required 文案。

```text
test/napm-openclaw-plugin-comprehensive-analysis-guard.test.js
```

该文件依赖未导出的旧测试 helper，并且综合分析 guard 相关实现与测试契约存在历史漂移。

这些失败不影响本次丢包 Top IP 主链修复，但后续应单独做一次旧契约测试清理。

## 当前正确行为

修复后，对于类似：

```text
最近丢包率最高的前10个IP都有谁？
```

模型不需要再手写完整 `resolvedQuery`，也不需要暴露生产 resolver 工具。

正确生产链路是：

```text
napm-skill-query
  -> plugin 自动 resolver
  -> topValues/topn/PLI/IPAddress
  -> run_napm_query.js
  -> NetInside topValues
```

用户不应再感知到“先失败一次、再查文档、再重试”的过程。

## 后续建议

1. 清理旧测试契约，把“缺 resolvedQuery 必须阻断”更新为“高确定性请求可内部 resolver 自动补齐”。
2. 对 resolver 自动补齐范围继续保持白名单，不要对所有自然语言问题无条件修复。
3. 对综合分析、下钻目录等复杂场景单独评估，不要被本次 TopN 修复顺手扩大语义重写范围。
4. audit 查询工具可以增加一组固定排查命令，便于直接定位是否发生 `auto_repaired`、是否进入 executor、真实耗时在哪里。
