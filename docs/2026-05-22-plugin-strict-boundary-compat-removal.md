# 2026-05-22 Plugin 兼容构造路径下线说明

## 背景

当前目标是解决 NAPM 查询链路中的职责边界失焦问题。正常链路应固定为：

```text
OpenClaw -> napm-mainflow-query -> NapmResolvedQueryResolverService.resolvePrompt()
         -> resolvedQuery -> napm-skill-query -> NAPM execution
```

插件只负责工具注册、边界拦截、审计与安全守卫，不再负责从自然语言 prompt 构造或修正 `resolvedQuery`。

## 本次调整

1. 下线 `compat` 边界模式

- `napm-openclaw-plugin.remote.js` 的 `getBoundaryMode()` 固定返回 `strict`。
- `ResolutionSpecService.getBoundaryMode()` 固定返回 `strict`。
- `.env.example` 中说明改为 strict-only，不再提示 `compat` 作为可选模式。

2. 取消插件侧 prompt 到 resolvedQuery 的构造

以下 helper 保留函数名用于兼容测试/外部引用，但统一返回 `null`：

- `buildBusinessObjectInventoryResolvedQuery()`
- `buildMetricInventoryResolvedQuery()`
- `buildOverviewResolvedQuery()`
- `buildPacketLossClientTopResolvedQuery()`
- `resolvePromptInjectedResolvedQuery()`
- `materializePluginPromptRoute()`

3. 取消插件侧查询前改写

- `applyPathPreflightToResolvedQuery()` 改为直接透传原始 `resolvedQuery`。
- `prepareSkillExecutionArgs()` 不再为丢包 TopN 自动注入 `resolvedQuery`。
- `buildCanonicalSkillToolParams()` 不再为任何 prompt 自动补 `resolvedQuery`。

4. 取消插件侧 resolver fallback

- `buildResolvedQueryForPrompt()` 不再调用 `NapmResolvedQueryResolverService`。
- `buildResolvedQueryForPrompt()` 不再回退到 `PromptRoutingService.materializePromptRouteResolvedQuery()`。
- 如果插件输出阶段发现没有已记录的 skill 结果，会提示必须先由 OpenClaw 主链构造 structured `resolvedQuery`，而不是由插件自行补查。

5. 物理删除 skill 内 prompt fallback 构造器

- `run_napm_query.js` 删除了不可达的 prompt-only fallback 构造函数。
- 删除范围包括业务清单、指标清单、overview、丢包 TopN、未知端口 TCP/UDP 等 prompt fallback builder。
- `__test__` 不再导出 `buildPromptFallback*`、`isPromptFallback*`、`inferPromptFallback*`、`isUnknownPortTrafficPrompt`、`detectUnknownPortProtocol`。
- 未知端口双协议执行测试改为直接传入显式 `resolvedQuery`，继续覆盖执行器能力，但不再依赖 prompt fallback。

## 保留能力

- `napm-resolve-query` 工具仍可由 OpenClaw 主链显式调用，用于构造 `resolvedQuery`。
- `napm-mainflow-query` 仍是推荐入口，内部按主链语义完成 resolve + skill query。
- 插件仍拦截 legacy direct tools，例如 `napm-topn`、`napm-average`、`napm-timeseries`。
- 插件仍允许带有显式 `resolvedQuery` 的 `napm-skill-query` 调用通过。

## 验证

已执行：

```powershell
npm test -- --runTestsByPath test/napm-openclaw-plugin-packet-loss-guard.test.js test/napm-openclaw-plugin-business-inventory-guard.test.js test/napm-openclaw-plugin-metric-inventory-guard.test.js test/napm-openclaw-plugin-overview-scene.test.js test/napm-openclaw-plugin-path-preflight.test.js test/napm-openclaw-plugin-resolver-tool.test.js test/run-napm-query-input-contract.test.js
```

结果：

```text
Test Suites: 7 passed, 7 total
Tests: 55 passed, 55 total
```

物理清理后已执行全量测试：

```powershell
npm test
```

结果：

```text
Test Suites: 27 passed, 27 total
Tests: 163 passed, 163 total
```

测试日志中出现一次 “Start and end timestamps must be aligned to 60-second minute boundaries”，这是既有输入契约测试覆盖错误路径的预期日志，不代表本轮失败。

## 后续注意

- 生产侧不要再配置或依赖 `NAPM_RESOLUTION_BOUNDARY_MODE=compat`。
- 如果自然语言问题没有得到 `resolvedQuery`，应排查 OpenClaw 是否调用了 `napm-mainflow-query` 或 `napm-resolve-query`，而不是在 plugin 或 skill 中补兜底。
- 若后续要进一步收口输出纠偏，应单独评估 `message_sending` / `before_message_write` 中的安全守卫、泄露拦截和结果复用逻辑，避免一次性移除后影响正常回答保护。
