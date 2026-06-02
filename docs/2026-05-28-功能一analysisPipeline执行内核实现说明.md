# 功能一 analysisPipeline 执行内核实现说明

日期：2026-05-28

## 1. 修改背景

功能一要求支持“先发现对象，再聚焦分析”的复杂问题，例如：

```text
找到连接失败最多的地址，然后分析它。
丢包最严重的 IP 是谁，为什么？
哪个业务 HTTP 500 最严重，并分析原因？
```

这类问题不能只返回 TopN，也不能由输出层补查。正确链路应为：

```text
OpenClaw 构造 overview resolvedQuery
  -> analysisPipeline.discoveryQuery 声明 discovery 查询
  -> skill 执行 discovery
  -> 提取 Top1 对象
  -> 绑定 focused overview
  -> 输出复合分析 narration contract
```

## 2. 本次实现内容

### 2.1 discoveryQuery 时间契约收紧

修改文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`

新增 `stripDiscoveryQueryExecutionTime()`。

现在 `analysisPipeline.discoveryQuery` 在 resolvedQuery 声明态中不保留：

```json
{
  "start": 1777982400,
  "end": 1777986000,
  "timeRange": {
    "start": 1777982400,
    "end": 1777986000
  }
}
```

执行 discovery 时，`buildDiscoveryQuery()` 会从顶层 overview resolvedQuery 注入 `start/end`。

这样保证：

- 时间只由顶层 resolvedQuery 管理。
- discovery 与 focused overview 复用同一时间范围。
- `discoveryQuery` 不形成第二套时间真相源。

### 2.2 analysisPipeline 契约校验

新增 `validateAnalysisPipelineContract()`，在执行 discovery 前阻断错误结构。

当前校验：

- 必须存在 `analysisPipeline.discoveryQuery`。
- 顶层必须存在 `start/end`。
- `targetObjectType` 必须可解析。
- `discoveryQuery.groups[0].type` 必须存在。
- `targetObjectType` 必须与 discovery 主 group 类型一致。
- 首版 discovery 只支持 `service=topValues`。
- discovery 必须有 `metric` / `metrics[0]` / `topMetric`。

如果不满足，不继续执行 discovery，也不继续 overview。

### 2.3 discovery 失败态标准化

`buildAnalysisDiscoveryFailureResult()` 现在区分：

- `analysisPipeline` 契约失败。
- `discoveryQuery` 执行失败。
- discovery 执行成功但未锁定对象。

输出中会明确：

```text
失败阶段：analysisPipeline / discoveryQuery
查询对象：...
排序指标：...
失败原因：...
```

不会沿用历史对象，也不会继续执行 focused overview。

### 2.4 overview_with_discovery 输出类型

修改文件：

- `skills/openclaw-napm-query/services/OpenClawNarrationContractService.js`

当执行结果带有：

```json
{
  "responseType": "overview_with_discovery"
}
```

narrationStructure 会保留该类型，而不是降级为普通 `overview`。

这样输出层可以识别这是“先发现再分析”的复合分析结果。

## 3. 测试覆盖

修改文件：

- `test/run-napm-query-input-contract.test.js`
- `test/openclaw-narration-contract.test.js`

新增/调整断言：

- `analysisPipeline.discoveryQuery` 声明态不保留 `start/end`。
- 执行态 discovery query 会注入顶层 `start/end`。
- 对象类型错配会阻断。
- 缺顶层时间会阻断。
- 成功链路返回 `responseType=overview_with_discovery`。
- narrationStructure 保留 `overview_with_discovery`。

## 4. 验证结果

已通过：

```text
npm test -- --runTestsByPath test/run-napm-query-input-contract.test.js
npm test -- --runTestsByPath test/openclaw-narration-contract.test.js
npm test -- --runTestsByPath test/napm-openclaw-plugin-time-contract.test.js
npm test -- --runTestsByPath test/overview-module.test.js
npm test -- --runTestsByPath test/packet-loss-default-sort-metric.test.js
```

结果：

```text
5 个测试文件通过
61 个测试用例通过
```

## 5. 当前边界

本次实现的是执行内核正式链路，不包含：

- OpenClaw prompt 示例注入。
- resolver 自动生成 `analysisPipeline.discoveryQuery`。
- 多对象对比分析。
- 多 discovery 指标归并排序。
- focused overview 的更细粒度根因推断。

下一步建议：

1. 增加 OpenClaw 构造侧 prompt 示例和 guard 测试。
2. 让 resolver 对 P0 复杂问法生成标准 `analysisPipeline.discoveryQuery`。
3. 补 `function-one-resolved-query-contract.test.js`，把文档中的 P0-009、P0-010、P0-011 固化成回归测试。

