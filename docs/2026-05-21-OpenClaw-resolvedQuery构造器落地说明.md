# OpenClaw resolvedQuery 构造器落地说明

日期：2026-05-21

## 背景

本次修改的目标是解决 OpenClaw 上游没有稳定产出 `resolvedQuery`，导致 NAPM 问题要么被 `napm-skill-query` strict 边界拒绝，要么被 Agent 绕到 `exec/curl` 直连底层 API 的问题。

边界原则保持不变：

```text
用户自然语言
-> OpenClaw 主链构造 resolvedQuery
-> napm-skill-query 严格执行 structured resolvedQuery
-> 禁止 prompt-only skill fallback 和 direct API 绕过
```

## 本次新增

### 1. 新增 resolver service

文件：

```text
skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js
```

职责：

- 只做自然语言到 `resolvedQuery` 的构造。
- 消费 `config/napm-resolution-spec.v1.json` 中的 service、metric alias、object alias。
- 不查询 NetInside 数据。
- 不替代 `napm-skill-query` 执行层。

当前支持的稳定问法：

- `丢包最大的IP地址是谁？` -> `topValues + PLI + IPAddress`
- `哪个客户端IP丢包最高？` -> `topValues + PLI + IPAddress`
- `系统中有哪些工作组？` -> `groups + BusinessGroup + metadata_list`
- `业务都可以查哪些指标？` -> `metrics + WebApplication + metadata_list`
- `BusinessGroup 可以往下钻到哪里？` -> `drilldownCatalog + BusinessGroup`

### 2. plugin 暴露 OpenClaw 可调用工具

文件：

```text
napm-openclaw-plugin.remote.js
```

新增工具：

```text
napm-resolve-query
napm-mainflow-query
```

推荐 OpenClaw 调用：

```text
napm-mainflow-query
```

它内部固定执行：

```text
resolve(prompt) -> skill(resolvedQuery)
```

如果 OpenClaw 不使用编排入口，也可以显式调用：

```text
napm-resolve-query -> napm-skill-query
```

### 3. guard 白名单和路由提示

`SAFE_NAPM_TOOL_NAMES` 已加入：

```text
napm-resolve-query
napm-mainflow-query
napm-skill-query
```

`buildNapmRoutingSystemContext()` 已更新，明确提示 OpenClaw：

- NAPM 问题优先调用 `napm-mainflow-query`。
- 若不用 `napm-mainflow-query`，必须先调用 `napm-resolve-query`，再把 `resolvedQuery` 原样传给 `napm-skill-query`。
- 不允许 prompt-only 直接调用 `napm-skill-query`。

### 4. 自动刷新路径也改为 resolver-first

旧的 `message_sending` 自动刷新路径曾经直接：

```text
prompt -> runSkillExecutor
```

strict 模式下会被拒绝。

现在改为：

```text
prompt -> runResolvedSkillExecutor -> resolver -> skill
```

这样模型没有主动调工具时，兜底刷新也不会回到 prompt-only skill fallback。

## 审计日志

新增/复用的关键 audit event：

```text
napm_resolver_request_received
napm_resolver_resolved_query_created
napm_resolver_failed
napm_mainflow_skill_completed
napm_plugin_skill_executor_invoked
napm_plugin_skill_executor_completed
```

排查方法：

```text
没有 napm_resolver_* 日志
=> OpenClaw 没有进入 resolver/mainflow 构造阶段

有 napm_resolver_failed
=> resolver 没能从问句构造 resolvedQuery

有 napm_resolver_resolved_query_created，但 skill 失败
=> resolvedQuery 已产出，问题在 skill 执行或参数契约

有 skill completed，但回答缺 IP/标签
=> 下游结果格式化/摘要层问题，不是 resolvedQuery 生成问题

出现 exec/curl
=> Agent 绕过 NAPM 工具链，需要继续查入口 guard
```

## 测试

新增测试：

```text
test/napm-resolved-query-resolver-service.test.js
test/napm-openclaw-plugin-resolver-tool.test.js
```

更新测试：

```text
test/napm-openclaw-plugin-business-inventory-guard.test.js
```

验证命令：

```bash
npx jest test/napm-resolved-query-resolver-service.test.js test/napm-openclaw-plugin-resolver-tool.test.js test/napm-openclaw-plugin-packet-loss-guard.test.js test/napm-openclaw-plugin-business-inventory-guard.test.js test/napm-openclaw-plugin-metric-inventory-guard.test.js test/napm-openclaw-plugin-hierarchy-guard.test.js test/run-napm-query-input-contract.test.js --runInBand
```

验证结果：

```text
Test Suites: 7 passed, 7 total
Tests: 51 passed, 51 total
```

## 注意事项

- 不建议把 `NAPM_RESOLUTION_BOUNDARY_MODE` 改回 `compat`。
- `compat` 会重新允许 plugin/skill prompt fallback，不符合 resolvedQuery 上游收口目标。
- 当前 resolver 是规则化第一版，覆盖核心 NAPM 问法；后续应继续把更多稳定模板迁入 `napm-resolution-spec.v1.json`，并让 resolver 从 spec 读取，而不是分散硬编码。
- TopN 返回有值但缺标签是另一个问题，应在 skill 结果结构化输出/摘要层继续修，不应靠 direct API 绕过。

## 远端部署记录

部署时间：2026-05-21 18:29 CST

部署主机：

```text
<OPENCLAW_HOST>
```

覆盖文件：

```text
<OPENCLAW_HOME>/extensions/napm-openclaw-plugin/index.js
<OPENCLAW_HOME>/extensions/napm-openclaw-plugin/openclaw.plugin.json
<OPENCLAW_HOME>/skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js
<OPENCLAW_HOME>/npm/node_modules/@wecom/wecom-openclaw-plugin/dist/src/monitor.js
<OPENCLAW_HOME>/docs-2026-05-21-OpenClaw-resolvedQuery构造器落地说明.md
```

备份目录：

```text
<OPENCLAW_HOME>/deploy_backups/20260521_182828_resolvedquery_resolver
```

WeCom 入口调整：

```text
识别到 NAPM 问句后不再直接调用 skill boundary。
现在放行到 OpenClaw Agent，由 napm-mainflow-query / napm-resolve-query -> napm-skill-query 链路处理。
```

远端自检结果：

```text
resolver: 丢包最大的IP地址是谁？ -> topValues + PLI + IPAddress + rank_top
resolver: 系统中有哪些工作组？ -> groups + BusinessGroup + metadata_list
plugin tools: napm-resolve-query, napm-mainflow-query, napm-skill-query
openclaw-gateway.service: active (running)
```

建议测试问句：

```text
丢包最大的IP地址是谁？
系统中有哪些工作组？
BusinessGroup 可以往下钻到哪里？
业务都可以查哪些指标？
刚才有没有走 skill？
```

## 20:26 吞吐量 Top10 问题复盘

问题时间：2026-05-21 20:26 CST

用户问句：

```text
吞吐量最大的前10个IP地址是谁？
```

排查结论：

```text
这次不是 resolver 完全没有构造 resolvedQuery。
20:28:46 的 audit 证明 napm-mainflow-query 已经调用 resolver，并产出了 resolvedQuery。
真正失败点是 resolver 生成的 start/end 没有按 NetInside 要求对齐到分钟整倍数。
```

失败证据：

```json
{
  "event": "napm_mainflow_skill_completed",
  "traceId": "napm-mainflow-1779366525742",
  "service": "topValues",
  "metric": "TPIO",
  "groups": [
    {
      "type": "IPAddress"
    }
  ],
  "topCount": 10,
  "start": 1779280125,
  "end": 1779366525,
  "error": {
    "code": "NAPM_UPSTREAM_ERROR",
    "message": "NAPM API error: Request failed with status code 400"
  }
}
```

`1779280125 % 60 != 0`，`1779366525 % 60 != 0`。NetInside `topValues` 要求 `start/end` 是分钟整倍数，所以这个 resolvedQuery 结构语义正确，但时间字段不符合执行契约。随后模型自行构造了分钟对齐的参数 `1779279960/1779366360`，查询成功，但这属于绕开 mainflow 的坏路径。

本次补丁：

```text
NapmResolvedQueryResolverService.buildLast24HoursTimeRange()
```

修改为：

```text
end = Math.floor(nowSeconds / 60) * 60
start = end - 24 * 60 * 60
```

这样 `napm-mainflow-query` 自动生成的 `resolvedQuery.start/end` 永远是分钟边界。

同步加固：

```text
before_tool_call 的 NAPM 绕行拦截提示从 “must call napm-skill-query first”
改为 “must call napm-mainflow-query first, or call napm-resolve-query and then napm-skill-query”
```

原因是当前正确链路已经不是 prompt-only skill，而是：

```text
自然语言 -> napm-mainflow-query
或
自然语言 -> napm-resolve-query -> napm-skill-query
```

新增/更新测试：

```text
test/napm-resolved-query-resolver-service.test.js
test/napm-openclaw-plugin-resolver-tool.test.js
test/napm-openclaw-plugin-direct-tool-removal.test.js
```

验证命令：

```bash
npx jest test/napm-resolved-query-resolver-service.test.js test/napm-openclaw-plugin-resolver-tool.test.js test/napm-openclaw-plugin-direct-tool-removal.test.js --runInBand
```

验证结果：

```text
Test Suites: 3 passed, 3 total
Tests: 12 passed, 12 total
```

本地复现结果：

```json
{
  "prompt": "吞吐量最大的前10个IP地址是谁？",
  "service": "topValues",
  "metric": "TPIO",
  "groups": [
    {
      "type": "IPAddress"
    }
  ],
  "topCount": 10,
  "start": 1779280080,
  "end": 1779366480,
  "startModulo60": 0,
  "endModulo60": 0
}
```

## 21:07 IP 应用路径被补成四层问题复盘

问题时间：2026-05-21 20:55-21:07 CST

用户问句：

```text
<OPENCLAW_HOST> 这个IP最近一天主要跑哪些应用
```

用户给出的合法 API：

```text
type=groups
groupType1=IPAddress
groupArgument1=<OPENCLAW_HOST>
groupType2=Applications
groupType3=DefinedApp
numGroups=3
```

远端 audit 证明当时 skill 实际发出的是四层：

```text
type=topValues
numGroups=4
groupType1=IPAddress
groupArgument1=<OPENCLAW_HOST>
groupType2=Applications
groupType3=DefinedApp
groupType4=ConnectedIP
```

根因：

```text
resolvedQuery 已经显式传入三层路径：
IPAddress(<OPENCLAW_HOST>) -> Applications -> DefinedApp

并且上游传了 skipPathPlanning=true。

但 run_napm_query.js 的 applyStaticPathPlanningIfNeeded()
和 RequirementParserService.applyStaticGroupPathPlanning()
没有尊重 skipPathPlanning=true。

因此 GroupPathPlannerService 根据“应用/application”关键词继续从静态 groups tree 里选择更深路径，
把三层显式路径扩成：
IPAddress -> Applications -> DefinedApp -> ConnectedIP
```

这不是用户给的三层 API 不合法，也不是三层路径一定没数据；是 skill 执行前把用户明确指定的路径改写了。

本次补丁：

```text
skills/openclaw-napm-query/scripts/run_napm_query.js
skills/openclaw-napm-query/services/RequirementParserService.js
```

新增统一契约：

```text
如果 resolvedQuery.skipPathPlanning === true
或 resolvedQuery.executionHints.skipPathPlanning === true
则不再执行静态路径规划，不追加任何 group 层级。
```

新增/更新测试：

```text
test/run-napm-query-drilldown-continuation.test.js
test/requirement-parser-groups-multilevel.test.js
```

验证命令：

```bash
npx jest test/run-napm-query-drilldown-continuation.test.js test/requirement-parser-groups-multilevel.test.js --runInBand
```

验证结果：

```text
Test Suites: 2 passed, 2 total
Tests: 10 passed, 10 total
```

本地验证发出的 group 参数：

```text
groupType1=IPAddress
groupArgument1=<OPENCLAW_HOST>
groupType2=Applications
groupType3=DefinedApp
numGroups=3
groupType4 不存在
```

## 09:33 最近一小时被解析成默认窗口问题复盘

问题时间：2026-05-22 09:33 CST

用户问句：

```text
最近一小时连接失败数最多的是谁？
```

问题表现：

```text
napm-mainflow-query / napm-resolve-query 能识别指标和排行意图，
但 resolver 没有真正解析“最近一小时”，仍按默认时间窗生成 resolvedQuery。
模型随后手工构造了 start/end=1779409980/1779413580 再查询。
```

根因：

```text
NapmResolvedQueryResolverService 只有 buildLast24HoursTimeRange()。
resolveTopValuesPrompt() 对所有 TopN 查询都调用这个固定 24h 时间窗。
它没有显式时间优先逻辑，也没有“未说明时间则默认最近一小时”的规则。
```

本次补丁：

```text
新增 inferTimeRange()
新增 buildLast1HourTimeRange()
保留 buildLast24HoursTimeRange()
```

时间规则：

```text
1. 用户明确说“最近一小时 / 过去1小时 / last hour” -> last1hour
2. 用户明确说“过去24小时 / 最近一天 / last 24 hours” -> last24hours
3. 用户明确说 N 小时 / N 分钟 / N 天 -> 按 N 解析
4. 用户未说明时间 -> 默认 last1hour
5. 所有 start/end 都按分钟对齐
```

本地验证：

```json
{
  "prompt": "最近一小时连接失败数最多的是谁？",
  "service": "topValues",
  "metric": "RFCI",
  "groups": [
    {
      "type": "IPAddress"
    }
  ],
  "topCount": 1,
  "start": 1779409980,
  "end": 1779413580,
  "timeRange": {
    "key": "last1hour"
  }
}
```

回归测试：

```bash
npx jest test/napm-resolved-query-resolver-service.test.js --runInBand
```

结果：

```text
Test Suites: 1 passed, 1 total
Tests: 8 passed, 8 total
```
