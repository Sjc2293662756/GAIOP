# 2026-05-21 NAPM `resolvedQuery` 严格收口修改文档

## 1. 目标

这次修改不是继续给 `napm-skill-query` 增加 prompt fallback，而是把边界真正收口到：

- 上游 OpenClaw mainflow 负责把自然语言稳定产出为结构化 `resolvedQuery`
- `napm-openclaw-plugin` 负责守边界、做路由约束、传递结构化参数
- `openclaw-napm-query` skill 负责执行结构化查询，不再默认兜底做 prompt 到 query 的主链语义构造

最终目标是让下面这类问法，都必须先形成结构化 `resolvedQuery` 再进入 skill：

- `系统中有哪些工作组？`
- `业务都可以查哪些指标？`
- `BusinessGroup 可以往下钻到哪里？`
- `哪个客户端 IP 丢包最高？`
- `现在应用整体情况怎么样？`

## 2. 当前确认的问题

结合项目代码、测试结论和你给的 reviewer 反馈，当前主问题有 4 个：

1. 默认边界模式没有真正收口
默认行为仍保留旧的 `compat` 语义，导致 prompt-only 请求还能在 skill 内继续被本地拼成 `resolvedQuery`。

2. `spec` 还不是唯一事实来源
虽然已经有 `config/napm-resolution-spec.v1.json`，但上游路由、plugin 提示词、skill 行为还没有完全按它统一收口。

3. plugin 还残留旧的 query fabrication 心智
plugin 里虽然已经开始做边界约束，但仍保留了部分历史 helper 和 prompt route 语义，容易让上游继续把 plugin / skill 当成“自然语言解析器”。

4. hierarchy 结构化执行链路不完整
当上游显式给出 `service=drilldownCatalog` 的 `resolvedQuery` 时，skill 之前仍依赖 prompt 派生的 `hierarchyCatalogPayload`，这会导致 strict 路径不闭合。

## 3. 本次修改原则

这轮修改按下面几个原则推进：

- `strict` 作为默认边界模式
- 默认禁止 prompt-only 主链执行
- `resolvedQuery` 成为 skill 的正式输入契约
- `--query` 更名为 `--queryJson`，避免误导为普通自然语言 query
- plugin 不再默认帮上游伪造主链 `resolvedQuery`
- hierarchy、metadata、overview 都按结构化输入走统一执行口

## 4. 已完成的修改

### 4.1 边界默认模式切到 `strict`

已改文件：

- `skills/openclaw-napm-query/services/ResolutionSpecService.js`
- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- `napm-openclaw-plugin.remote.js`
- `.env.example`

已完成内容：

- `ResolutionSpecService.getBoundaryMode()` 默认值改为 `strict`
- `run_napm_query.js` 中边界模式默认值改为 `strict`
- plugin 的 `getBoundaryMode()` 默认值改为 `strict`
- `.env.example` 中的示例边界模式改为 `NAPM_RESOLUTION_BOUNDARY_MODE=strict`

目标效果：

- 如果运行环境没有显式配置，系统默认就按 `strict` 约束执行
- 生产不再默认容忍 prompt-only 主链语义兜底

### 4.2 skill 入口默认拒绝 prompt-only 请求

已改文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`

已完成内容：

- `resolveInput()` 只接受以下结构化输入通道：
  - `--queryJson`
  - `--resolvedQuery`
  - `payload.resolvedQuery`
- 去掉了主执行路径里基于 prompt 自动构造 `resolvedQuery` 的 fallback 分支
- 当缺少结构化 `resolvedQuery` 时，直接抛出：
  - `UPSTREAM_RESOLVED_QUERY_REQUIRED`

当前错误契约：

- `code=UPSTREAM_RESOLVED_QUERY_REQUIRED`
- `details.acceptedInputs=['--queryJson','--resolvedQuery','payload.resolvedQuery']`
- `details.boundaryMode='strict'`

目标效果：

- skill 不再把自然语言 prompt 当成正式执行输入
- 问题会在边界入口暴露出来，而不是继续在 skill 里悄悄补 query

### 4.3 输入契约更名为 `--queryJson`

已改文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- `config/napm-resolution-spec.v1.json`

已完成内容：

- CLI 参数解析由 `--query` 改为 `--queryJson`
- `spec.queryContract.acceptedInputs` 同步改为 `--queryJson`

目标效果：

- 避免上游误解 `--query` 可以直接传自然语言
- 明确这里只有“结构化 JSON query”是合法输入

### 4.4 显式 `drilldownCatalog` 已补结构化执行链路

已改文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`

已完成内容：

- 新增 `buildHierarchyCatalogPayloadFromResolvedQuery(resolvedQuery)`
- 当 `resolvedQuery.service === 'drilldownCatalog'` 时：
  - 若 `groups` 为空，走 `NapmMetadataService.getTopLevelDrilldownCatalog({ maxDepth: 2 })`
  - 若 `groups[0].type` 存在，走 `NapmMetadataService.getDrilldownPathsForGroupType(type, { maxDepth: 2 })`
- `main()` 中的 hierarchy contract 输出不再只依赖 prompt fallback 产生的 `hierarchyCatalogPayload`

目标效果：

- strict 模式下，即使完全没有 prompt fallback
- 只要上游给了结构化 `resolvedQuery`
- `drilldownCatalog` 也能正常执行并返回层级目录结果

### 4.5 plugin 系统上下文继续强化 `resolvedQuery-first`

本轮继续沿用并保留前面已经做过的修改：

已改文件：

- `napm-openclaw-plugin.remote.js`
- `config/napm-resolution-spec.v1.json`

已完成内容：

- plugin 的系统上下文会明确告诉 OpenClaw：
  - `resolvedQuery` 必须由上游 mainflow 构造
  - `napm-skill-query` 是结构化查询执行器，不是自然语言主解析器
  - metadata inventory / hierarchy / overview / ranking 等问题，应先形成结构化查询
- 对部分结构化类问题，如果调用 `napm-skill-query` 时没有合法 `resolvedQuery`，plugin 已有守卫阻断能力

目标效果：

- 上游不应该再把 raw prompt 直接塞给 skill
- 上游必须学会先按 spec 形成 `resolvedQuery`

## 5. 当前还在继续收口的点

这部分不是方向不清，而是还需要把已有改动彻底收完。

### 5.1 测试口径还要从“保留 fallback”切到“验证 strict 契约”

当前已经开始改的测试文件：

- `test/run-napm-query-input-contract.test.js`
- `test/run-napm-query-hierarchy-catalog.test.js`
- `test/overview-scene-routing.test.js`

收口方向：

- prompt-only 请求默认应返回 `UPSTREAM_RESOLVED_QUERY_REQUIRED`
- 显式结构化 `resolvedQuery` 应继续可执行
- hierarchy 应验证结构化 `resolvedQuery` 能独立跑通
- 不再把“fallback helper 还能不能识别 prompt”当成主测试目标

### 5.2 plugin 内历史 helper 还存在，但不应再代表正式边界能力

当前仍能看到部分历史 helper，例如：

- `buildPromptFallbackResolvedQuery`
- `buildPromptFallbackMetricInventoryResolvedQuery`
- `buildPromptFallbackBusinessObjectInventoryResolvedQuery`
- 以及 plugin 侧部分 hierarchy / inventory / overview 检测 helper

处理原则：

- 可以暂时保留为测试/迁移辅助函数
- 但生产主链不能再依赖它们完成 query fabrication
- 后续建议继续下沉或清理，避免语义双写

## 6. 建议的最终落地方案

### 阶段 1：先把 skill 默认边界彻底收紧

执行项：

- skill 默认只接受结构化 `resolvedQuery`
- hierarchy 显式结构化路径补齐
- 测试口径全部改为 strict-first

验收标准：

- prompt-only 主路径默认报 `UPSTREAM_RESOLVED_QUERY_REQUIRED`
- 显式 `resolvedQuery` 的 `overview` / `groups(metadata)` / `metrics(metadata)` / `drilldownCatalog` 能正常执行

### 阶段 2：让上游稳定消费 spec 产出 `resolvedQuery`

执行项：

- 继续强化 plugin system context
- 让上游对下面几类问题稳定产出结构化路由：
  - `groups + BusinessGroup + metadata_list`
  - `groups + WebApplication + metadata_list`
  - `metrics + BusinessGroup/WebApplication + metadata_list`
  - `drilldownCatalog + groups`
  - `overview + overviewScene`
  - `topValues + IPAddress + PLI`

验收标准：

- `系统中有哪些工作组？` 必须形成：
  - `service=groups`
  - `queryModeKey=metadata`
  - `semanticConstraints.operation=metadata_list`
  - `groups=[{type:'BusinessGroup'}]`
- `BusinessGroup 可以往下钻到哪里？` 必须形成：
  - `service=drilldownCatalog`
  - `groups=[{type:'BusinessGroup'}]`

### 阶段 3：清理历史 compat 心智

执行项：

- 删除或弱化 `buildPromptFallback*` 系列 helper 的对外语义地位
- 不再新增任何新的 prompt fallback
- 将剩余兼容逻辑明确标注为 legacy / migration only

验收标准：

- 代码中不存在新的 prompt-to-query 主链构造入口
- plugin、skill、spec 之间的语义规则不再三处双写

## 7. 关键文件清单

本轮涉及的核心文件如下：

- `config/napm-resolution-spec.v1.json`
- `napm-openclaw-plugin.remote.js`
- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- `skills/openclaw-napm-query/services/ResolutionSpecService.js`
- `test/run-napm-query-input-contract.test.js`
- `test/run-napm-query-hierarchy-catalog.test.js`
- `test/overview-scene-routing.test.js`

## 8. 建议测试用例

建议按下面这些问法做联调验证：

### 8.1 必须先形成 `resolvedQuery`

- `系统中有哪些工作组？`
- `业务都可以查哪些指标？`
- `BusinessGroup 可以往下钻到哪里？`
- `哪个客户端 IP 丢包最高？`
- `现在应用整体情况怎么样？`

预期：

- 如果上游没有构造 `resolvedQuery`
- plugin 或 skill 入口必须显式报错/阻断
- 不能再静默走本地 prompt fallback

### 8.2 显式结构化请求必须可执行

建议验证这些结构化请求：

- `groups + BusinessGroup + metadata_list`
- `groups + WebApplication + metadata_list`
- `metrics + BusinessGroup + metadata_list`
- `overview + application`
- `drilldownCatalog + BusinessGroup`
- `topValues + IPAddress + PLI + topCount=1`

## 9. 当前状态说明

截至这份文档落地时，代码已经进入“严格收口”阶段：

- 默认边界模式已切向 `strict`
- prompt-only 主链执行已默认禁止
- `--queryJson` 输入契约已收口
- `drilldownCatalog` 的结构化执行链路已补齐

还需要继续完成的主要工作是：

- 把剩余测试全部改到 strict 口径
- 跑完整本地测试
- 再推送远端部署并重启服务验证

## 10. 结论

这次修改的核心不是“再设计几个兜底”，而是把真正的问题暴露出来：

- 如果上游没有稳定产出 `resolvedQuery`
- 那就应该在边界入口失败
- 而不是继续把责任下沉给 skill 做自然语言补 query

这才符合你现在要的方向，也符合 `resolvedQuery-boundary-design.md` 的设计目标。
