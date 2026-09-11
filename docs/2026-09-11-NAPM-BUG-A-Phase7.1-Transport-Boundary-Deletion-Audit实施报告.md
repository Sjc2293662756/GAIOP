# GAIOP NAPM BUG-A Phase 7.1 实施报告

日期：2026-09-11  
分支：`codex/napm-turn-decision-phase1`  
HEAD：`e63f94ef1e8948544d77ff03488e9a0a645121f9`（未提交）  
Phase 7.1 开始状态：保留 Phase 0–7 全部未提交修改；工作区基线通过 `git diff --check`。  
Phase 7.1 备份：`C:\Users\20693\AppData\Local\Temp\codex-napm-phase7-pre-20260911-150721\working-tree.zip`。  
Phase 7.1 结束状态：Transport Boundary 审计和最小 dead helper 清理完成，工作区仍保留全部未提交变更。

## 结论

Phase 7.1 PASS。真实执行链已经收口为：

```text
Canonical Query.groups[]
  → NapmQuerySerializer.serialize()
  → GroupBuilder.buildGroupParams()
  → NAPM HTTP-ready params
  → NapmClient.get()
  → HTTP
```

`NapmClient` 不解释对象/指标，不查询 metadata，不补 argument，不选择 service 或 metric；只发送已经准备好的参数。`MetricExecutionKernel` 不读取 legacy `metric`，不使用 `metrics[0]` 作为执行真相，不按 `queryModeKey` 路由，不补默认 `topCount`。

本轮未进入 Phase 8。

## Q1–Q10 审计结论

| 问题 | 结论 |
|---|---|
| Q1 groups[] 最后一米在哪里 | `NapmQuerySerializer.serialize()` 调用 `GroupBuilder.buildGroupParams()`，后者生成 `numGroups/groupTypeN/groupArgumentN`；Kernel 只接收结果，Client 只发送 |
| Q2 NapmClient 是否业务解释 | NO |
| Q3 production group encoder 几套 | 1：`GroupBuilder.buildGroupParams()` |
| Q4 production metrics comma encoder 几套 | 1：`NapmQuerySerializer.serialize()` |
| Q5 topMetric \\|\\| metric | Transport execution path 已物理删除 |
| Q6 execution metrics[0] fallback | Kernel/Serializer/Client 为 0；语义、metadata、展示兼容代码仍有提示性读取 |
| Q7 Kernel queryModeKey routing | 0 |
| Q8 Serializer/Kernel/Client legacy metric | 无 legacy metric 值读取；Serializer 仅做存在性拒绝 |
| Q9 P7/P7.1 生产代码 | P7 新增 Serializer；P7.1 删除无 caller helper并收紧审计，未改语义规则 |
| Q10 dead helper | `validateExecutableQueryAtBoundary`、`buildMetricCsv`、`RequirementParserService.buildUrl` 已删除；无生产 caller 的旧 fallback 不再保留 |

## Group Transport Chain

1. `skills/openclaw-napm-query/services/NapmQuerySerializer.js` 的 `NapmQuerySerializer.serialize()`：接收 admitted canonical Query，显式构造 transport DTO。
2. `skills/openclaw-napm-query/services/GroupBuilder.js` 的 `GroupBuilder.buildGroupParams()`：只做机械编号和字段复制：`groups.length → numGroups`、`group.type → groupTypeN`、非空 `group.argument → groupArgumentN`。
3. `skills/openclaw-napm-query/services/MetricExecutionKernel.js` / `PageViewsExecutionKernel.js`：消费 Serializer 输出并选择对应数据执行路径。
4. `skills/openclaw-napm-query/services/NapmClient.js` 的 `NapmClient.get()`：加入认证字段、URL 编码并发起 HTTP。

`NapmMetadataService` 和 `MetadataExecutionKernel` 也复用同一个 `GroupBuilder`，没有第二个 group flatten 实现。

## NapmClient Boundary

| 行为 | 结果 |
|---|---|
| 解释 Object semantics | NO |
| Repair group path | NO |
| 补 group argument | NO |
| 选择 service | NO |
| 选择 metrics/topMetric | NO |
| 只做机械 HTTP transport | YES |

## Deletion Audit

| 文件 | P7.1 处理 | 旧逻辑 |
|---|---|---|
| `RequirementParserService.js` | 删除无生产 caller 的 `validateExecutableQueryAtBoundary` | 旧的重复 Validator 入口 |
| `RequirementParserService.js` | 删除无生产 caller 的 `buildMetricCsv` | 旧的第二个 metrics comma 编码入口 |
| `RequirementParserService.js` | 删除无生产 caller 的 `buildUrl` | 旧的未使用 URL helper |
| `run_napm_query.js` | 展示字符串改用 `Array.toString()` | 避免把展示格式化误认成 transport encoder |
| `scripts/verify-napm-skill-runtime-contract.js` | 新增 Phase 7.1 contract | 锁定唯一 encoder、Client 边界和删除结果 |

当前 `git diff --numstat` 仍包含 Phase 0–7 的历史未提交改动，不能把整份 working-tree 数字归因于 Phase 7.1；上述表只列本轮确认的删除和新增职责。

## 物理删除状态

| 旧逻辑 | 状态 | 替代 |
|---|---|---|
| `MetricExecutionKernel` 的 `topMetric || metric` | DELETED | canonical `topMetric` → Serializer |
| Kernel 读取 `queryRequest.metric` | DELETED | canonical Contract/Legacy Adapter boundary |
| Kernel `metrics.join(',')` | DELETED | Serializer 唯一编码 |
| Kernel 默认 `topCount || 20` | DELETED | canonical Contract 提供合法值 |
| Kernel `queryModeKey` routing | DELETED | canonical `service` dispatch |
| 第二个 data metrics builder | DELETED | Serializer |
| 第二个 group flatten encoder | NOT PRESENT | GroupBuilder 唯一实现 |
| `validateExecutableQueryAtBoundary` | DELETED | shared `evaluateExecutableQueryAdmission` |
| `buildMetricCsv` | DELETED | Serializer |
| `RequirementParserService.buildUrl` | DELETED | 无 caller，移除 |

## Dead Code / Compatibility 分类

| 符号或位置 | 生产 caller | 分类 | 说明 |
|---|---:|---|---|
| `LegacyMetricInputAdapter` | 有 | KEEP_TEMPORARILY | 明确的旧输入迁移边界，本轮禁止删除 |
| `run_napm_query` 的 summary `metric`/metrics[0] | 有 | KEEP_TEMPORARILY | 结果摘要/展示字段，不是 transport truth |
| `QueryMetadataConstraintService` 的 metrics[0] | 有 | KEEP_TEMPORARILY | metadata compatibility 选择，不进入 Kernel/Client |
| `RequirementParserService` 的 template/提示读取 | 有 | KEEP_TEMPORARILY | 语义/模板兼容逻辑，本轮禁止改 Semantic rules |
| 旧 `buildMetricCsv` / `validateExecutableQueryAtBoundary` / `buildUrl` | 无 | DELETED | 已确认无生产 caller |

## Search Counts

针对 Transport execution boundary 的实际结果：

```text
topMetric || metric in MetricExecutionKernel: 0
execution metrics[0] in MetricExecutionKernel: 0
Kernel queryModeKey routing: 0
Kernel legacy metric value reads: 0
Serializer legacy metric value reads: 0（仅 1 个 legacy 字段存在性拒绝 guard）
NapmClient metric business reads: 0
production metrics comma transport encoders: 1
production group encoder definitions: 1
```

仓库中仍可检索到的 metrics[0]/metric 读取位于 semantic、metadata、narration 或 summary 代码；它们没有生成 NAPM transport params。本轮不修改这些模块，避免越界进入 Phase 8/Resolver cleanup。

## Golden Transport Matrix

| Service | Canonical | HTTP-ready params 核心字段 |
|---|---|---|
| `topValues` | `metrics=[TPO,TPI]`, `topMetric=TPIO`, `topCount=5` | `metrics=TPO,TPI`, `topMetric=TPIO`, `topCount=5` |
| `averageValues` | `metrics=[PGTME,PGNPGE]` | `metrics=PGTME,PGNPGE` |
| `timeValues` | `metrics=[PGNPGE,PGTME,PGHTTP500]`, `granularity=300` | `metrics=PGNPGE,PGTME,PGHTTP500`, `granularity=300` |
| `pageViews` | `pageFamilyId=8573007`, `maxLimit=20` | `pageFamilyId=8573007`, `maxLimit=20` |

所有最终 DTO 均不包含 `schemaVersion`、`queryModeKey`、`metric`、repair/runtime/proof metadata、`reasonCode`、`issues` 或 `warnings`。

## Zero-call Gates

- `KNOWN_INCOMPATIBLE` / `METRIC_UNKNOWN` / `CONTRACT_INVALID`：不调用 Serializer、Kernel 或数据 Client。
- Runtime `UNSUPPORTED` / `INDETERMINATE`：只调用 capability provider，不进入 Serializer 或数据 Client。
- Repair rejected：不进入 Serializer 或数据 Client。
- admitted valid：Serializer 一次，数据 Client 一次。

## 测试

- Phase 7.1：5 tests PASS（group chain、唯一 GroupBuilder、无 transport repair、Static invalid 零调用、Runtime unsupported 零调用）
- Phase 7：9 tests PASS
- Phase 6 runtime contract：2 tests PASS
- Full repo：153 suites / 1300 tests PASS
- `npm run lint`：PASS
- `npm run verify:runtime-contract`：PASS
- `git diff --check`：PASS

## 边界确认

```text
Semantic rules modified: NO
Object Ontology modified: NO
Metric Catalog modified: NO
Object × Metric ownership modified: NO
Runtime Capability semantics modified: NO
Atomic Repair semantics modified: NO
Global Error Contract refactored: NO
NO_DATA classifier refactored: NO
LegacyMetricInputAdapter removed: NO
Metadata architecture refactored: NO
BUG-B touched: NO
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
Phase 8 started: NO
```
