# 执行内核稳定性修复说明

日期：2026-05-22

## 背景

执行内核存在几类 P0 稳定性问题：

- `topValues` / `averageValues` / `timeValues` 在构造请求参数时直接调用 `queryRequest.metrics.join(',')`，当上游只传 `metric` 或 `topMetric` 时可能触发空指针。
- `resolveMetricOwnershipObjectType is not a function` 类错误很难在启动阶段发现，通常到查询执行时才暴露。
- 对象元数据查询中 `argumentType` 解析失败会被包装为 `NAPM_UPSTREAM_ERROR`，导致无法区分“本地构造失败”“元数据契约失败”和“南向无数据”。

这些问题会让用户看到“系统像是理解了问题，但执行莫名失败”，排障时也很难判断是无数据还是代码炸了。

## 修改目标

执行内核必须满足：

- 参数缺失不能触发 JS TypeError。
- 可从 `metric/topMetric/metrics` 派生的指标必须稳定派生。
- 无法派生时返回结构化错误，而不是进入南向请求或伪装成无数据。
- 本地构造错误、依赖契约错误、元数据 argumentType 错误与南向 API 错误分开。

## 主要改动

### 1. 执行入口增加统一 query shape 归一化

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

新增：

```js
normalizeExecutableQueryShape(gatewayRequest)
```

归一化规则：

- `groups` / `metrics` 元数据查询会删除 `metric/metrics/topMetric`，避免把数据指标误带入元数据服务。
- 数据查询会从 `metrics`、`metric`、`topMetric` 收集指标候选并去重。
- `topValues` 缺 `topMetric` 时优先从 `metric` 派生，其次从 `metrics[0]` 派生。
- `topValues` 只有 `metric` 但没有 `metrics` 时，会自动生成 `metrics: [metric]`。

### 2. 替换不安全的 `metrics.join()`

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

新增：

```js
buildMetricCsv(queryRequest, service)
```

执行参数构造不再直接调用：

```js
queryRequest.metrics.join(',')
```

而是统一调用 `buildMetricCsv()`。

如果无法从 `metrics/metric/topMetric` 派生有效指标，返回结构化错误：

```json
{
  "code": "QUERY_SHAPE_INVALID"
}
```

### 3. QueryValidator 结构化错误分类

文件：`skills/openclaw-napm-query/services/QueryValidator.js`

校验失败不再只是普通 `Error`，而是带：

```js
error.code = 'QUERY_SHAPE_INVALID'
error.details = { mode, errors, service }
```

这样缺字段、时间不合法、service 不合法等执行前输入问题，不会再被误归类为南向 API 错误。

### 4. 元数据 argumentType 错误结构化

文件：`skills/openclaw-napm-query/services/NapmMetadataService.js`

当 `groupArguments` 需要 `argumentType` 但无法解析时，错误改为：

```json
{
  "code": "METADATA_ARGUMENT_TYPE_UNRESOLVED",
  "details": {
    "requestedObjectType": "...",
    "effectiveObjectType": "...",
    "providerType": "groupArguments"
  }
}
```

这类错误明确表示本地元数据契约或结构层级有问题，不再当成“南向返回空”或普通上游错误。

### 5. 依赖契约自检

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

新增：

```js
assertDependencyContracts()
```

启动/实例化阶段检查 `src/constants/objectMetricOwnership` 必须提供：

- `filterMetricsForObjectType`
- `rankMetricIdsForObjectType`
- `resolveMetricOwnershipObjectType`
- `isMetricCompatibleWithGroupPath`

如果远端部署文件不同步导致函数缺失，会抛出：

```json
{
  "code": "DEPENDENCY_CONTRACT_MISMATCH"
}
```

这比用户查询时才出现 `xxx is not a function` 更容易定位。

## 错误分类边界

当前执行错误分类：

- `QUERY_SHAPE_INVALID`：resolvedQuery / gatewayRequest 形态不合法，缺 service、缺指标、时间不对齐等。
- `METADATA_ARGUMENT_TYPE_UNRESOLVED`：对象实例元数据需要 `groupArguments`，但无法获得可信 `argumentType`。
- `DEPENDENCY_CONTRACT_MISMATCH`：部署文件或模块导出契约不一致。
- `NAPM_UPSTREAM_ERROR`：南向 NetInside API 请求失败、网络失败、真实上游错误。

## 验证

新增测试：

```text
test/execution-kernel-stability.test.js
```

覆盖：

- `topValues` 只有 `metric/topMetric`、没有 `metrics` 时不再崩溃。
- 无法派生指标时返回 `QUERY_SHAPE_INVALID`。
- `argumentType` 无法解析时返回 `METADATA_ARGUMENT_TYPE_UNRESOLVED`。
- 依赖契约自检可用。

已执行：

```bash
npm test -- --runInBand test/execution-kernel-stability.test.js
npm test -- --runInBand test/run-napm-query-input-contract.test.js test/metadata-truth-source-policy.test.js test/execution-boundary-repair-policy.test.js
```

结果均通过。

## 后续建议

远端部署时必须同步：

- `skills/openclaw-napm-query/services/RequirementParserService.js`
- `skills/openclaw-napm-query/services/QueryValidator.js`
- `skills/openclaw-napm-query/services/NapmMetadataService.js`
- `src/constants/objectMetricOwnership.js`

同步后重启 OpenClaw gateway，避免 Node 模块缓存继续使用旧版本。
