# GAIOP NAPM BUG-A Phase 8 实施报告

日期：2026-09-11  
分支：`codex/napm-turn-decision-phase1`  
HEAD：`e63f94ef1e8948544d77ff03488e9a0a645121f9`（未提交）  
Phase 8 开始备份：`C:\Users\20693\AppData\Local\Temp\codex-napm-phase8-pre-20260911-165843\working-tree.zip`  
Phase 8 结束状态：统一 Outcome、最终回归和文档同步完成；工作区仍保留全部未提交修改。

## 结论

Phase 8 PASS。BUG-A 的执行结果边界已统一，原始“慢业务 Top5”回归通过，`NO_DATA` 与校验失败、能力失败、序列化失败、南向执行失败已完全分离。BUG-B、部署和远端验证不在本阶段。

## Unified Outcome Contract

`ExecutionOutcomeContract` 唯一定义六种执行结果：

```text
SUCCESS
NO_DATA
VALIDATION_FAILURE
RUNTIME_CAPABILITY_FAILURE
SERIALIZATION_FAILURE
EXECUTION_FAILURE
```

Semantic Lifecycle 仍独立使用：

```text
RESOLVED / AMBIGUOUS / UNRESOLVED / UNSUPPORTED
```

统一结构字段：`outcome`、`stage`、`reasonCode`、`queryExecuted`、`dataRequestAttempted`、`dataRequestSucceeded`、`responseParseSucceeded`、`rowCount`、`issues[]`。

`ExecutionOutcomeMapper` 是跨 Query Runtime、Gateway、Direct、Plugin、Narration 的唯一映射入口。

## NO_DATA Proof

| 条件 | 结果 |
|---|---|
| `dataRequestAttempted=true` | 必须 |
| `dataRequestSucceeded=true` | 必须 |
| `responseParseSucceeded=true` | 必须 |
| `rowCount=0` | 必须 |
| 零调用校验失败映射为 NO_DATA | 禁止 |
| Runtime capability failure 映射为 NO_DATA | 禁止 |
| Serializer failure 映射为 NO_DATA | 禁止 |
| Execution failure 映射为 NO_DATA | 禁止 |

## Error Matrix

| 场景 | Data Call | Outcome | Reason/Stage |
|---|---:|---|---|
| Contract invalid | 0 | `VALIDATION_FAILURE` | contract/static validation |
| Metric unknown | 0 | `VALIDATION_FAILURE` | `METRIC_UNKNOWN` |
| Known incompatible | 0 | `VALIDATION_FAILURE` | `OBJECT_METRIC_INCOMPATIBLE` |
| Runtime unsupported | 0 | `VALIDATION_FAILURE` | `RUNTIME_METRIC_UNSUPPORTED` |
| Runtime provider failure | 0 | `RUNTIME_CAPABILITY_FAILURE` | runtime capability |
| Repair rejected | 0 | `VALIDATION_FAILURE` | `REPAIR_REJECTED` / unsafe suggestion |
| Serializer failure | 0 | `SERIALIZATION_FAILURE` | serialization |
| Data network/HTTP failure | 1 attempted | `EXECUTION_FAILURE` | execution |
| Data response parse failure | 1 attempted | `EXECUTION_FAILURE` | response_parse |
| Valid empty response | 1 | `NO_DATA` | execution, rowCount=0 |
| Valid non-empty response | 1 | `SUCCESS` | execution |

## Final BUG-A Acceptance

| Case | 结果 |
|---|---|
| A 原始“最近业务访问较慢的前5个业务都有谁？” | PASS：`WebApplication + PGTME + topCount=5`，无 `metric` |
| B Static VALID | PASS：metricsForGroup=0，data=1，`SUCCESS` |
| C WebApplication + TRTI 静态不兼容 | PASS：`VALIDATION_FAILURE`，data=0 |
| D Runtime unsupported | PASS：metricsForGroup=1，`VALIDATION_FAILURE/RUNTIME_METRIC_UNSUPPORTED`，data=0 |
| E 合法空结果 | PASS：data=1，`NO_DATA` |
| F 南向网络失败 | PASS：data attempted=1，`EXECUTION_FAILURE` |
| G 多指标 + 独立 topMetric | PASS：`metrics=TPI,TPO`、`topMetric=TPIO` |
| H 未知指标 | PASS：`VALIDATION_FAILURE/METRIC_UNKNOWN`，零南向调用 |
| I 安全 repair | PASS：只执行一次，使用 repaired Query |
| J 不安全 repair | PASS：`REPAIR_REJECTED`，零数据调用 |

## Legacy Cleanup

| 项目 | 状态 | 说明 |
|---|---|---|
| `LegacyMetricInputAdapter` | `KEEP_TEMPORARILY` | 明确迁移边界，仍有兼容入口；未删除 |
| `TagNormalizer` | `KEEP_TEMPORARILY` | 已是 compatibility facade，不构造 Query；Phase 2 contract 继续保护 |
| `metric` execution truth | DELETE/禁止 | Kernel、Serializer、Client 不读取；只保留 adapter/展示兼容字段 |
| `metrics[0]` execution truth | DELETE/禁止 | 语义/展示场景可用作提示，不能进入 gate/transport |
| QueryMetadata compatibility warnings | 保留为诊断 | 不作为执行 hard gate 或 warning-string control flow |
| duplicate ownership/spec sources | 无新增 | 现有唯一真源 contract 持续通过 |

## Final Truth Sources

| Concern | Single Truth Source |
|---|---|
| Natural-language metric semantics | Resolution Spec + MetricSemanticNormalizer |
| Semantic lifecycle | `napm-query-semantic.v1` / WorkflowClassifierService |
| Query shape | ResolvedQueryContract |
| Static Object × Metric | objectMetricOwnership |
| Runtime capability | RuntimeMetricCapabilityService + metricsForGroup |
| Safe repair | AtomicQueryRepairService |
| NAPM serialization | NapmQuerySerializer |
| Group transport | GroupBuilder |
| Execution outcome | ExecutionOutcomeContract + ExecutionOutcomeMapper |

## 验证结果

- Phase 8 outcome tests：通过，15 tests
- Final BUG-A regression：通过，10 tests
- Full repo：156 suites / 1327 tests PASS
- `npm run lint`：PASS
- `npm run verify:runtime-contract`：PASS
- `git diff --check`：PASS

## 边界确认

```text
Semantic rules modified: NO
Ranking grammar modified: NO
Object Ontology modified: NO
Metric Catalog modified: NO
Object × Metric ownership modified: NO
Runtime Capability semantics modified: NO
Atomic Repair allowlist expanded: NO
BUG-B modified: NO
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
```

## BUG-A Final Status

```text
Phase 8: PASS
BUG-A: DONE / FINAL PASS (等待 Review)
```
