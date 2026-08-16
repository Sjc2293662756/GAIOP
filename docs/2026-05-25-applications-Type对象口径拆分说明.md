# applications Type 对象口径拆分说明

## 背景

南向 `applications` 目录中的 `Type` 字段表示不同应用目录对象。此前项目中已经明确：

- `Type=1`：内置端口/系统内置应用
- `Type=2`：已定义应用/自动识别应用
- `Type=3`：业务系统/WebApplication
- `Type=4`：自动识别应用/特征识别应用/复合协议/复合应用

但代码中仍存在一处混合口径：`DefinedApp` / `Application` 使用 `applicationTypeFilter=[2,4]`，导致“已定义应用”和“复合协议”共享一个实例池。

## 本次修改

本次按对象边界拆分为四个独立 provider：

| applications Type | 语义对象 | provider | 执行维度 |
| --- | --- | --- | --- |
| `1` | `BuiltinApplication` | `applications Type=1` | `DefinedApp` |
| `2` | `DefinedApp` / `Application` | `applications Type=2` | `DefinedApp` |
| `3` | `WebApplication` | `applications Type=3` | `WebApplication` |
| `4` | `CompositeApplication` | `applications Type=4` | `DefinedApp` |

核心原则：

- `DefinedApp` 不再包含 `Type=4`。
- `CompositeApplication` 是独立对象，不再混入 `DefinedApp`。
- “系统中有哪些自动识别应用/复合协议/复合应用/多协议应用”应解析为 `groups:[{type:"CompositeApplication"}]`。
- Plain “系统中有哪些应用” 是歧义问法，不能默认等同 `DefinedApp`，也不能从 `groups-tree.static.json` 的 `Application` 节点解释。
- 执行层继续只按 `ObjectMetadataRegistry` 的 provider 决定实例来源，不能在回答层临时过滤。

## 修改文件

- `skills/openclaw-napm-query/services/ObjectMetadataRegistry.js`
- `skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js`
- `skills/openclaw-napm-query/services/PromptRoutingService.js`
- `src/constants/objectDimensions.js`
- `config/napm-resolution-spec.v1.json`
- `skills/openclaw-napm-query/SKILL.md`
- `skills/openclaw-napm-query/agents/openai.yaml`
- `skills/openclaw-napm-query/references/openclaw-integration.md`
- `docs/2026-05-22-metadata-truth-source-policy.md`
- `docs/2026-05-25-应用与业务对象口径落地说明.md`

## 验证点

- `NapmMetadataService.listObjectInstances("DefinedApp")` 只返回 `applicationType=2`。
- `NapmMetadataService.listObjectInstances("CompositeApplication")` 只返回 `applicationType=4`。
- `NapmResolvedQueryResolverService.resolvePrompt("系统中有哪些自动识别应用？")` 生成 `CompositeApplication` 元数据清单查询。
- `NapmResolvedQueryResolverService.resolvePrompt("系统中有哪些应用？")` 返回结构化歧义，不直接构造某一类应用清单。
- `PromptRoutingService` 的旧快速路由不再把“复合协议”归到 `DefinedApp`。
