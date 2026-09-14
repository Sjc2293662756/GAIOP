# NAPM BUG-A Phase 5：Runtime Metric Capability 实施报告

## 1. Git 与范围

branch: codex/napm-turn-decision-phase1

HEAD at Phase 5 start: e63f94ef1e8948544d77ff03488e9a0a645121f9

backup: C:\Users\20693\AppData\Local\Temp\codex-napm-phase5-pre-20260911-\HEAD-e63f94e.zip

Phase 5 production code changed: YES

Phase 5 commit: not yet committed

本阶段只实现 Static UNKNOWN 的运行时指标能力确认；未修改语义规则、排行语法、Object Ontology、Metric Catalog、Static ownership coverage、Serializer、Kernel legacy fallback、全局 Error Contract 或 BUG-B。

## 2. Runtime Capability Architecture

Canonical ResolvedQuery → ResolvedQueryExecutableValidator → Static UNKNOWN + requiredRuntimeChecks → ResolvedQueryExecutionAdmissionService → RuntimeMetricCapabilityService → NapmMetadataService.getMetricsForGroupPathEvidence() → metricsForGroup → Runtime Evidence → Final Admission → MetricExecutionKernel / data execution

ResolvedQueryExecutableValidator 保持 pure。QueryDecisionPolicy 对 UNKNOWN 返回 EXECUTE_WITH_RUNTIME_CONFIRMATION，只允许 Query Skill 进入 runtime gate，不直接获得 data permission。

## 3. Provider Contract

输入必须是 Static Validator status=UNKNOWN 的 requiredRuntimeChecks[]，且 check 必须同时满足 type=METRIC_CAPABILITY、provider=METRICS_FOR_GROUP、service + groupPathSignature + metricId。

路径参数由 NapmMetadataService.getMetricsForGroupPathEvidence() 调用 GroupBuilder.buildGroupParams() 生成：numGroups、groupTypeN、groupArgumentN。Runtime Service 不修复路径、不补对象、不改 Query。

响应标准化为 supportedMetricIds：

- 合法数组且包含 metric ID：SUPPORTED；
- 合法数组但不包含 metric ID，包括合法空数组：UNSUPPORTED；
- 请求失败、响应非数组、条目缺少合法 id：INDETERMINATE。

Runtime evidence 绑定当前 Query 的 exact path，不写回静态配置，也不使用新的跨请求缓存。

## 4. Final Admission

| Static | Runtime | Final Admission | Data |
|---|---|---|---:|
| VALID | n/a | ALLOW | 允许 |
| CONTRACT_INVALID | n/a | DENY_STATIC | 0 |
| METRIC_UNKNOWN | n/a | DENY_STATIC | 0 |
| KNOWN_INCOMPATIBLE | n/a | DENY_STATIC | 0 |
| UNKNOWN | SUPPORTED | ALLOW | 允许 |
| UNKNOWN | UNSUPPORTED | DENY_RUNTIME_UNSUPPORTED | 0 |
| UNKNOWN | INDETERMINATE | RUNTIME_CAPABILITY_FAILURE | 0 |

运行时不支持不会换指标，运行时失败不会变成 NO_DATA。

## 5. 三入口调用矩阵

| Entry | Static | Runtime | Query Skill | metricsForGroup | Kernel | Data |
|---|---|---|---:|---:|---:|---:|
| Plugin | UNKNOWN | SUPPORTED | 1 | 1 | 1 | 1 |
| Plugin | UNKNOWN | UNSUPPORTED | 1 | 1 | 0 | 0 |
| Gateway | UNKNOWN | SUPPORTED | n/a | 1 | 1 | 1 |
| Gateway | UNKNOWN | UNSUPPORTED | n/a | 1 | 0 | 0 |
| Gateway | UNKNOWN | INDETERMINATE | n/a | 1 | 0 | 0 |
| Direct | UNKNOWN | SUPPORTED | n/a | 1 | 1 | 1 |
| Direct | UNKNOWN | UNSUPPORTED | n/a | 1 | 0 | 0 |
| Static KNOWN_INCOMPATIBLE | n/a | n/a | 0 | 0 | 0 | 0 |
| Static METRIC_UNKNOWN | n/a | n/a | 0 | 0 | 0 | 0 |

Plugin 不直接访问 NapmClient；Gateway、Direct 共享同一 ResolvedQueryExecutionAdmissionService。

## 6. 多指标与非回归

同一路径多个 UNKNOWN metric 只调用一次 metricsForGroup，返回列表同时判断全部角色。RETURN_METRIC 和 RANKING_METRIC 在同一 metric 上合并保存；topMetric 不要求属于 metrics[]，但会独立确认。

same-path dedup: 1 call

metrics[] every unknown item checked: YES

topMetric independently checked: YES

roles merged: YES

Prepared proof、Phase 3 canonical contract、Phase 2 semantic contract、Phase 4.1 static gate 均保持通过。

## 7. 测试与命令结果

| Test Group | Suites | Tests | PASS | FAIL | SKIP |
|---|---:|---:|---:|---:|---:|
| Phase 0 relevant | 5 | 67 | 67 | 0 | 0 |
| Phase 1 | 2 | 19 | 19 | 0 | 0 |
| Phase 2 | 5 | 45 | 45 | 0 | 0 |
| Phase 2.1 | 1 | 9 | 9 | 0 | 0 |
| Phase 3 | 7 | 43 | 43 | 0 | 0 |
| Phase 4 | 4 | 17 | 17 | 0 | 0 |
| Phase 4.1 | 3 | 7 | 7 | 0 | 0 |
| Phase 5 | 4 | 17 | 17 | 0 | 0 |
| Full repo | 147 | 1267 | 1267 | 0 | 0 |

npm test -- --runInBand: PASS, 147 suites / 1267 tests

npm run lint: PASS

npm run verify:runtime-contract: PASS

git diff --check: PASS

## 8. 边界确认

Metadata architecture refactored: NO

Serializer added: NO

Kernel legacy fallback removed: NO

Global Error Contract refactored: NO

BUG-B touched: NO

Remote NAPM: NO

Deploy: NO

Restart: NO

Commit: NO

Phase 6 started: NO

Phase 5 完成：YES。
