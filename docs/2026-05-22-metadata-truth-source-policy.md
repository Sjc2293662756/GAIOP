# 元数据真相源收口方案

日期：2026-05-22

## 背景

项目中长期同时存在三类元数据来源：

- 南向实时 API：`applications`、`businessGroups`、`groupArguments`、`metricsForGroup` 等。
- 本地结构快照：`config/groups-tree.static.json`。
- 本地语义/归属配置：`objectMetricOwnership.js`、mapping、spec、模板配置等。

问题不在于来源多，而在于没有明确“每个来源负责什么”。一旦执行链路把静态结构、语义映射和实时对象实例混用，就会出现：

- 南向存在 `WebApplication`，但本地链路误判为空。
- `WebApplication` 查询误走协议应用 `applications`。
- `DefinedApp/Application` 和 `WebApplication` 枚举混为一份列表。
- `groupArguments` 缺少明确 `argumentType` 时继续兜底，导致 400 或错误空结果。

## 收口原则

本次修改将元数据按“真相域”拆开：

- `object_instances`：运行时对象实例清单，只能来自南向实时 API。
- `hierarchy`：对象结构、下钻层级、可达路径，可以使用 `groups-tree.static.json`。
- `metric_compatibility`：路径与指标是否可执行，以 `metricsForGroup` 为准。
- `semantic_policy`：本地 ownership/mapping/spec 只做语义候选、排序、提示，不证明对象真实存在。

## 运行时对象实例 provider

新增统一入口：

- `NapmMetadataService.resolveObjectInstanceProviderMetadata(objectType)`
- `NapmMetadataService.listObjectInstances(objectType, keyword)`

当前 provider 规则：

- `WebApplication` / `PageFamily` / `User` / `ClientBusinessGroup`：走 `groupArguments`，必须解析到明确 `argumentType`。
- `DefinedApp` / `Application`：走 `applications`，统一视为协议/已定义应用实例。
- `BusinessGroup`：走 `businessGroups`。

返回行统一携带审计字段：

- `requestedObjectType`
- `effectiveObjectType`
- `objectType`
- `metadataTruthDomain`
- `providerType`
- `source`
- `argumentType`
- `fallbackUsed`

## 关键代码变更

- 新增 `MetadataTruthSourcePolicy.js`，显式定义四类真相域：
  `hierarchy`、`object_instances`、`metric_compatibility`、`semantic_policy`。
- 新增 `ObjectMetadataRegistry.js`，集中定义对象实例 provider，禁止执行层自行决定实例来源。
- `NapmMetadataService` 增加对象实例 provider 策略，禁止执行层各自决定 `WebApplication` / `DefinedApp` 应该去哪查。
- `RequirementParserService` 的单对象 `groups` 元数据查询改为调用 `listObjectInstances()`，不再手写 `Application/DefinedApp/WebApplication/BusinessGroup` 分支。
- `groupArguments` 调用前必须拿到有效 `argumentType`；拿不到直接报错，不再默认兜成 `4`。
- `getGroupDefinitions()` 对 `Application -> DefinedApp` 做运行时 key 归一化，避免静态树中 `Application` 节点无法服务运行时 `DefinedApp`。
- `reviewQuery()` 只在单对象路径时拉实例清单，多层路径不再预拉顶层对象实例，避免多层 `groups` 查询被顶层清单污染。
- `QueryMetadataConstraintService` 校验 `groupArguments` 时按对象命名空间过滤，禁止用 `DefinedApp` 实例证明 `WebApplication` 参数存在。

## 已覆盖测试

新增 `test/metadata-truth-source-policy.test.js`：

- `WebApplication` 清单必须走 `groupArguments`，不能走 `applications`。
- `DefinedApp` 清单必须走 `applications`，不能走 `groupArguments`。
- `groupArguments` 缺少 `argumentType` 时必须失败，不能静默兜底。
- 单对象元数据清单必须经统一 `listObjectInstances()` 入口执行。
- `WebApplication` 参数不能被 `DefinedApp` 实例列表误匹配。

同时回归：

- `test/requirement-parser-groups-multilevel.test.js`

确保多层 `groups` 查询不会被顶层对象实例清单短路。

## 后续建议

- 将 provider 规则从代码常量下沉到 `config/napm-resolution-spec.v1.json` 或独立 `metadata-truth-source-policy.v1.json`，让上游 resolver 和 skill 共用。
- 为南向 `groupArguments` 的 `argumentType` 建启动时探测或健康检查，提前发现环境差异。
- 输出层展示 metadata debug 时优先展示 `providerType/source/effectiveObjectType`，便于判断错误发生在解析、元数据查询还是执行层。
