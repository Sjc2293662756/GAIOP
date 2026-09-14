# GAIOP NAPM BUG-A Phase 8.1 最终验证与签核报告

日期：2026-09-11  
分支：`codex/napm-turn-decision-phase1`  
HEAD：`e63f94ef1e8948544d77ff03488e9a0a645121f9`（未提交）  
Phase 8.1 开始状态：继承 Phase 8 工作区；可用最近的 Phase 8 备份 `C:\Users\20693\AppData\Local\Temp\codex-napm-phase8-pre-20260911-165843\working-tree.zip`，没有单独的 8.1 起始快照。  
Phase 8.1 结束状态：最终验证通过，工作区仍保留全部未提交修改。

## 结论

```text
Phase 8.1: PASS
Phase 8: PASS
BUG-A: DONE / FINAL PASS（等待 Review）
```

本轮没有新增业务架构；发现并修正的生产问题仅限 Transport/展示兼容边界：移除剩余执行层 `metrics[0]` fallback，使用明确 `topMetric` 或非权威 `find(Boolean)` 提示；保持 Semantic、Ownership、Runtime Capability、Atomic Repair、Serializer 业务结论不变。

## Phase 8 Deletion Stats

以下是从 Phase 8 起始备份到当前工作树的累计差异，包含 Phase 8 与 8.1，不能伪称为 8.1-only 统计。备份包含日志/依赖目录，统计时排除了 `node_modules`、归档、dist、OpenClaw 临时目录及 Query logs。

| Category | Added | Deleted | Net |
|---|---:|---:|---:|
| Production | 634 | 48 | +586 |
| Tests | 668 | 1 | +667 |
| Docs/Contracts | 166 | 0 | +166 |
| Other | 3464 | 0 | +3464 |

Phase 8/8.1 物理删除或收口：

| Old Logic | Current Status | Physically Deleted | Replacement |
|---|---|---:|---|
| Kernel `topMetric || metric` | DELETED | YES | canonical `topMetric` + Serializer |
| Kernel legacy `metric` read | DELETED | YES | Legacy Adapter boundary only |
| Kernel `metrics[0]` execution truth | DELETED | YES | role-aware canonical fields |
| Kernel `queryModeKey` routing | DELETED | YES | canonical `service` |
| Kernel metrics comma encoding | DELETED | YES | NapmQuerySerializer |
| Validation/Runtime/Serializer errors as NO_DATA | DELETED | YES | ExecutionOutcomeMapper |
| warning-string execution control | NOT FOUND | YES | structured validation/outcome |
| `validateExecutableQueryAtBoundary` | DELETED | YES | shared admission |
| `buildMetricCsv` | DELETED | YES | Serializer |
| `RequirementParserService.buildUrl` | DELETED | YES | no production caller |
| `LegacyMetricInputAdapter` | KEEP_TEMPORARILY | NO | explicit legacy input boundary |
| `TagNormalizer` | KEEP_TEMPORARILY | NO | compatibility-label facade |

## LegacyMetricInputAdapter Caller Graph

| Caller | Production | Why Needed | Removal Condition |
|---|---:|---|---|
| `RequirementParserService.adaptLegacyMetricInputAtBoundary` | YES | explicit old Tool/Skill input boundary | all external callers send canonical `metrics[]/topMetric` |
| `OverviewPlanCompiler.buildBaseQueryFromCandidate` | YES | overview candidate migration input | all overview candidates emit canonical metric arrays |
| Plugin `prepareSkillExecutionArgs` | YES | legacy Tool payload compatibility | production adapters stop sending singular `metric` |
| Tests / contract fixtures | NO | migration characterization | remove with legacy cleanup |

The adapter never reaches MetricExecutionKernel, Serializer, NapmClient, or NAPM transport.

## TagNormalizer Caller Graph

| Caller | Production | Can choose canonical metric | Can build executable Query | Removal Condition |
|---|---:|---:|---:|---|
| `TagNormalizer.js` itself | NO external production caller | NO | NO | remove after compatibility test/doc migration |
| Phase 2 runtime-contract / reachability tests | NO | NO | NO | retain while historical contract is supported |

It returns `TAG_MAPPER_DEPRECATED` labels only and cannot create `resolvedQuery`.

## Final Search Counts

| Check | Production Count | Target | Classification |
|---|---:|---:|---|
| `topMetric || metric` in execution boundary | 0 | 0 | PASS |
| Kernel/Serializer/Client legacy metric value reads | 0 | 0 | PASS |
| execution/compatibility `metrics[0]` truth | 0 | 0 | PASS |
| Kernel `queryModeKey` routing | 0 | 0 | PASS |
| warning-string execution control | 0 | 0 | PASS |
| production metrics comma encoder | 1 | 1 | `NapmQuerySerializer` |
| production group encoder | 1 | 1 | `GroupBuilder.buildGroupParams` |
| production outcome mapper implementation | 1 | 1 | `ExecutionOutcomeMapper` |

Remaining `metrics[0]`-like semantic/display references are non-execution summaries or compatibility data; they do not construct transport params, run gates, or decide outcome.

## UNKNOWN → SUPPORTED

```text
Static Validator calls: 1
Static status: UNKNOWN
metricsForGroup calls: 1
Runtime status: SUPPORTED
Serializer calls: 1
Kernel calls: 1
Data calls: 1
Outcome: NO_DATA (empty fixture)
```

Provider mismatch guard:

```text
Static UNKNOWN provider: OTHER_PROVIDER
metricsForGroup calls: 0
Serializer calls: 0
Data calls: 0
Outcome: RUNTIME_CAPABILITY_FAILURE
```

## Plugin / Gateway / Direct Outcome Consistency

| Scenario | Plugin | Gateway | Direct | Core Reason |
|---|---|---|---|---|
| Static incompatible | `VALIDATION_FAILURE` | `VALIDATION_FAILURE` | `VALIDATION_FAILURE` | `OBJECT_METRIC_INCOMPATIBLE` |
| Legal empty | `NO_DATA` | `NO_DATA` | `NO_DATA` | rowCount=0 |
| Data network failure | `EXECUTION_FAILURE` | `EXECUTION_FAILURE` | `EXECUTION_FAILURE` | execution |
| Runtime provider failure | `RUNTIME_CAPABILITY_FAILURE` | `RUNTIME_CAPABILITY_FAILURE` | `RUNTIME_CAPABILITY_FAILURE` | runtime capability |

## NO_DATA Proof

```text
NO_DATA requires dataRequestAttempted=true: YES
NO_DATA requires dataRequestSucceeded=true: YES
NO_DATA requires responseParseSucceeded=true: YES
NO_DATA requires rowCount=0: YES
Zero-call validation failure can become NO_DATA: NO
```

## Duplicate Config Audit

| Config | Runtime Source | Duplicate | Can Affect Runtime | Result |
|---|---|---:|---:|---|
| Resolution Spec | `skills/openclaw-napm-query/config/napm-resolution-spec.v1.json` | NO | YES | unique |
| Object Ontology | `skills/openclaw-napm-query/config/object-ontology.v1.json` | NO | YES | unique |
| Metric Catalog | `skills/openclaw-napm-query/config/metrics-config.yml` | NO | YES | unique |
| Metric ownership | `skills/openclaw-napm-query/src/constants/objectMetricOwnership.js` | root thin re-export only | YES | unique |

## Tests

- Phase 8.1 verification tests：7 tests PASS
- Final BUG-A regression：10 tests PASS
- Phase 8 outcome tests：15 tests PASS
- Full repo：157 suites / 1334 tests PASS
- `npm run lint`：PASS
- `npm run verify:runtime-contract`：PASS
- `git diff --check`：PASS

## Boundary Confirmation

```text
Semantic rules modified: NO
Ranking grammar modified: NO
Object Ontology modified: NO
Metric Catalog modified: NO
Ownership modified: NO
Runtime Capability semantics modified: NO
Atomic Repair semantics modified: NO
Serializer semantics modified: NO
BUG-B modified: NO
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
```

Phase 8.1 verification is complete. Stop here and await final Review.
