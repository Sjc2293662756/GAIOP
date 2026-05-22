# resolvedQuery 入口唯一化修改说明

日期：2026-05-22

## 背景

此前 NAPM/OpenClaw 集成处于迁移双轨并存状态，生产环境同时暴露：

- `napm-resolve-query`
- `napm-mainflow-query`
- `napm-skill-query`

这会让同一句用户问题存在多条可选链路：

- 先调用 resolver，再手动把 `resolvedQuery` 传给 skill。
- 调用 mainflow，由插件本地 resolver 构造并执行。
- 直接调用 skill，但如果缺少 `resolvedQuery` 又被 strict 边界拒绝。

结果是 OpenClaw 可能在不同轮次选择不同入口，导致“有时像走了 skill、有时像绕过 skill、有时模型自己补 resolvedQuery”的现象，排查时很难判断问题发生在上游构造、插件转发还是 skill 执行。

## 修改目标

生产环境只保留一条查询入口：

```text
OpenClaw upstream resolvedQuery construction
  -> napm-skill-query
  -> NAPM skill executor
  -> NetInside southbound API
  -> skill displayText / narrationStructure
  -> OpenClaw narration
```

`napm-resolve-query` 和 `napm-mainflow-query` 不再作为生产入口，只保留为本地诊断工具。

## 主要改动

### 1. 生产默认只注册 `napm-skill-query`

文件：`napm-openclaw-plugin.remote.js`

默认注册逻辑调整为：

- 始终注册 `napm-skill-query`。
- 仅当 `NAPM_ENABLE_DEV_RESOLVER_TOOLS=true` 时，才注册 `napm-resolve-query` 和 `napm-mainflow-query`。

### 2. 工具契约收口

文件：`openclaw.plugin.json`

`contracts.tools` 从三入口改为只声明：

```json
["napm-skill-query"]
```

这样 OpenClaw 在生产工具发现阶段不会把 resolver/mainflow 当成可选查询路径。

### 3. 系统提示词收口

文件：`napm-openclaw-plugin.remote.js`

提示词从“优先调用 `napm-mainflow-query`，否则 resolve + skill”改为：

- NAPM 问题只能在上游已生成完整 `resolvedQuery` 后调用 `napm-skill-query`。
- `napm-resolve-query` 和 `napm-mainflow-query` 是诊断工具，不是生产查询路径。
- plugin 只转发结构化查询，skill 只执行结构化查询。

### 4. guard 拦截文案收口

文件：`napm-openclaw-plugin.remote.js`

当 NAPM prompt 试图调用 shell、exec、curl 或其他非 NAPM 工具时，拦截原因不再推荐 mainflow/resolver，而是明确：

```text
NAPM requests must use the single production entry napm-skill-query with an upstream-produced resolvedQuery.
```

### 5. 诊断开关

新增环境变量：

```bash
NAPM_ENABLE_DEV_RESOLVER_TOOLS=true
```

仅用于开发/诊断：

- 打开后注册 `napm-resolve-query`。
- 打开后注册 `napm-mainflow-query`。
- 打开后 guard 允许这两个诊断工具参与 NAPM prompt。

生产环境不应开启该变量。

## 当前边界

生产职责边界现在是：

- OpenClaw 上游：负责自然语言理解与 `resolvedQuery` 构造。
- napm-openclaw-plugin：负责工具注册、边界拦截、参数校验和转发。
- NAPM skill：负责执行结构化 `resolvedQuery`，不再从 prompt 构造查询。
- NetInside 南向 API：负责返回实时数据。

## 验证

已执行：

```bash
npm test -- --runInBand test/napm-openclaw-plugin-resolver-tool.test.js test/napm-openclaw-plugin-direct-tool-removal.test.js
```

结果：

```text
PASS test/napm-openclaw-plugin-resolver-tool.test.js
PASS test/napm-openclaw-plugin-direct-tool-removal.test.js
Test Suites: 2 passed, 2 total
Tests: 7 passed, 7 total
```

## 后续排障方式

如果需要判断“上游是否产出了 resolvedQuery”，不要在生产链路里让 plugin 自己补。推荐看审计日志：

- `napm_plugin_skill_call_received`
- `napm_plugin_resolved_query_blocked`
- `napm_plugin_resolved_query_forwarded`

如果确实需要本地验证 resolver 规则，可临时开启：

```bash
NAPM_ENABLE_DEV_RESOLVER_TOOLS=true
```

验证完成后必须关闭，避免生产再次回到多入口并存。
