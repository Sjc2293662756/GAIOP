# NAPM BUG-A Phase 3：Canonical Query Contract 与 Legacy Adapter 实施报告

日期：2026-09-10  
范围：仅 Canonical ResolvedQuery Contract、Semantic→Query 映射和 legacy `metric` 输入迁移  
结论：Phase 3 已完成；未进入 Phase 4/5。

## 1. Git 基线与保护措施

| 项目 | 结果 |
|---|---|
| 分支 | `codex/napm-turn-decision-phase1` |
| Phase 3 起始 HEAD | `c07a652aa80dd593ecf3546fe41f8f621175491a` |
| Phase 3 结束 HEAD | `c07a652aa80dd593ecf3546fe41f8f621175491a`（本阶段不提交） |
| 起始工作区 | dirty；包含 Phase 0/1/2/2.1 累积修改 |
| 结束工作区 | dirty；保留此前修改并叠加 Phase 3 |
| 修改前备份 | `C:\Users\20693\AppData\Local\Temp\codex-napm-bug-a-phase3-pre-20260909-180100`（28 个文件） |
| reset / stash | 均未执行 |
| 版本号 | 未修改 |
| 发布包 / 部署 | 未制作、未部署 |
| 远端服务器 | 未连接、未修改、未重启 |

## 2. Canonical Query Contract

唯一 schema：`napm-resolved-query.v1`。唯一 required/optional/forbidden 规则源：`ResolvedQueryContract.js`。

| service | required | optional/derived | forbidden | legacy |
|---|---|---|---|---|
| `topValues` | schema、service、非空 groups、非空 metrics、topMetric、topCount、start/end | `queryModeKey=topn`、timeRange、filters、format、semantic/path/execution hints | `metric`、granularity、pageFamilyId、maxLimit | `metric` 仅 Adapter 输入 |
| `averageValues` | schema、service、非空 groups、非空 metrics、start/end | `queryModeKey=average` 及通用提示字段 | `metric`、topMetric、topCount、granularity、pageFamilyId、maxLimit | `metric` 可迁为单元素 metrics |
| `timeValues` | schema、service、非空 groups、非空 metrics、granularity、start/end | `queryModeKey=timeseries` 及通用提示字段 | `metric`、topMetric、topCount、pageFamilyId、maxLimit | `metric` 可迁为单元素 metrics |
| `pageViews` | schema、service、pageFamilyId、start/end | `queryModeKey=detail`、maxLimit、可信引用及通用提示字段 | groups、metrics、`metric`、topMetric、topCount、granularity | `metric` 不允许迁移 |

构造阶段保留既有相对时间边界：Plugin Hook 可以暂存受支持的 `timeRange.key`；进入 execute/QueryValidator 时必须已经物化为分钟对齐的根级 `start/end`。嵌套 `timeRange.start/end` 返回 `INVALID_TIME_FIELD_LOCATION`。

## 3. Canonical 字段定义

| 字段 | 权威性 | 是否派生 | legacy | 后续发送 NAPM |
|---|---|---|---|---|
| `schemaVersion` | canonical required | Plugin 可为未版本化旧 Tool payload 补当前版本；Resolver 显式输出 | NO | NO |
| `service` | canonical authoritative | NO | NO | 映射到 HTTP `type` |
| `metrics[]` | canonical authoritative 返回指标集合 | Semantic `requestedMetrics[]` 映射；legacy Adapter 可补空槽 | NO | Serializer/Kernel join 为 HTTP `metrics` |
| `topMetric` | `topValues` authoritative 排序指标 | 只从 Semantic `rankingMetric`；legacy Adapter 只补空槽 | NO | HTTP `topMetric` |
| `metric` | 非 canonical | 仅 legacy Adapter 消费后删除 | YES | NO |
| `queryModeKey` | 非第二真源 | 从 service 派生并验证一致 | transitional | NO |
| `primaryMetric` | Semantic-only optional | 不从 `metrics[0]` 制造 | NO | NO |

明确不成立：

```text
metric = metrics[0] = topMetric
topMetric ∈ metrics[]
metrics[0] -> primaryMetric
```

## 4. Semantic → Canonical Query 映射

| Semantic operation | 映射 |
|---|---|
| `rank_top` | `requestedMetrics[] -> metrics[]`；`rankingMetric -> topMetric`；`topCount -> topCount` |
| `average` | `requestedMetrics[] -> metrics[]`；不生成 metric/topMetric/topCount |
| `timeseries` | `requestedMetrics[] -> metrics[]`；统一时间结果生成 start/end；按跨度生成 granularity；不生成排行字段 |

Resolver 先检查 Phase 2.1 lifecycle；只有 `RESOLVED` 进入 assembly。Canonical candidate 随后仍经过 `ResolvedQueryContract`，所以 `RESOLVED` 不等于 Query Contract 一定合法。

核心结果：

| 输入 | canonical 输出 |
|---|---|
| 最近业务访问较慢的前5个业务都有谁？ | `topValues + WebApplication + metrics=[PGTME] + topMetric=PGTME + topCount=5` |
| 返回 TPI/TPO、按 TPIO 排行 | `metrics=[TPI,TPO] + topMetric=TPIO`，合法 |
| 查看业务页面访问量、页面响应时间和 HTTP500的趋势 | `timeValues + metrics=[PGNPGE,PGTME,PGHTTP500] + granularity` |
| 业务页面响应时间平均值 | `averageValues + metrics=[PGTME]` |

以上输出均不含 `metric`。

## 5. Legacy Adapter 决策表

成功迁移统一返回 `LEGACY_METRIC_DEPRECATED` warning，并用 `kind=adapted/redundant` 区分。

| service | input shape | canonical output | warning | reject reason |
|---|---|---|---|---|
| topValues | 只有 `metric=M` | `metrics=[M]`、`topMetric=M`，删除 metric | adapted | — |
| topValues | metrics 已有、缺 topMetric、`metric=M` | metrics 保持、`topMetric=M` | adapted | — |
| topValues | `topMetric=M`、缺 metrics、`metric=M` | `metrics=[M]` | adapted | — |
| topValues | `topMetric=T`、缺 metrics、`metric=M` 且 T≠M | 无 Query | — | `LEGACY_METRIC_PARTIAL_CONFLICT` |
| topValues | 完整 canonical + metric 与 topMetric 或 metrics 有关 | canonical 保持、删除 metric | redundant | — |
| topValues | 完整 canonical + 无关 metric | 无 Query | — | `LEGACY_METRIC_CONFLICT` |
| average/time | 只有 metric | `metrics=[M]` | adapted | — |
| average/time | metrics 已含 metric | metrics 保持、删除 metric | redundant | — |
| average/time | metrics 不含 metric | 无 Query | — | `LEGACY_METRIC_CONFLICT` |
| pageViews/非指标 service | 携带 metric | 无 Query | — | `LEGACY_METRIC_NOT_ALLOWED_FOR_SERVICE` |

Adapter 成功输出会再次经过完整 Canonical Contract validation，不能直接获得执行权限，也不判断 Object × Metric 兼容性。

## 6. Adapter 调用次数

| 路径 | Adapter 调用 |
|---|---:|
| Semantic Contract → Resolver → canonical Query | 0 |
| canonical Tool/Skill 输入 | 0 |
| legacy 外部输入（含 metric） | 1 |
| Hook 已适配后进入 execute | 0 次重复调用 |
| Requirement `executeGatewayRequest` 已适配后进入 direct | 0 次重复调用 |
| legacy 冲突 | 1，随后在 metadata/data 前终止 |

Overview Candidate Registry 中仍存在的旧模板 `metric` 在 Candidate 编译边界适配一次；生成的每个真实 child query 均为 canonical，RequirementParser 不会再次适配。

## 7. QueryValidator 与 Plugin

| 检查 | Phase 3 结果 |
|---|---|
| QueryValidator 是否要求 `metric` | NO |
| QueryValidator 是否调用共享 Contract | YES |
| Plugin 是否要求 `topMetric ∈ metrics[]` | NO |
| Plugin 是否调用共享 Contract | YES |
| QueryMetadataConstraint 是否执行 `metrics[0] -> metric` | NO |
| run_napm_query / QueryContextResolver 是否写 canonical metric | NO |
| 页面详情是否仍为独立 Detail Contract | YES |

## 8. 文件范围

核心新增：

- `skills/openclaw-napm-query/services/ResolvedQueryContract.js`
- `skills/openclaw-napm-query/services/LegacyMetricInputAdapter.js`
- 7 个 Phase 3 contract/adapter/resolver/plugin/execution/runtime tests

核心迁移：

- Resolver、QueryValidator、QueryMetadataConstraint、RequirementParser、NapmMetadata
- Plugin Hook/execute normalization 与 validation
- QueryContextResolver、run_napm_query、OverviewPlanCompiler/Execution
- Narration 与 ReportData 的 canonical 字段读取
- Phase 0 Characterization 和相关 Query/Plugin/Kernel 测试预期
- AGENTS/SOUL/PROJECT/TOOLS/CLAUDE/CONTEXT、Query SKILL、最终设计、memory 和审计文档

消费者明细见：`docs/2026-09-10-NAPM-BUG-A-Phase3-Metric字段消费者审计.md`。

## 9. Runtime Contract

| contract | 结果 |
|---|---|
| single ResolvedQuery contract/schema source | PASS |
| canonical services forbid metric | PASS |
| topMetric independent from metrics[] | PASS |
| QueryValidator uses shared Contract | PASS |
| Plugin uses shared Contract and no membership rule | PASS |
| Resolver emits schema + canonical roles | PASS |
| Semantic path skips Adapter | PASS |
| Adapter output removes metric and validates | PASS |
| QueryMetadataConstraint has no metric derivation | PASS |

Phase 0/1/2/2.1 runtime contracts 继续全部 PASS。

## 10. Later-phase non-regression

- QueryDecisionPolicy hard gate：未修改；`WebApplication + TRTI` 的结构化兼容性准入仍留给 Phase 4。
- Gateway/Direct：只接共享 shape contract 和 legacy Adapter；未接 ownership tri-state 或 Shared Executable Validator。
- Ownership tri-state：仍未接 Policy。
- Runtime Metadata / `metricsForGroup` orchestration：调用顺序未重构，Phase 5 未开始。
- Metadata overloaded service：仍保留，未拆分。
- MetricExecutionKernel：`topMetric || metric` legacy fallback 物理代码仍保留；canonical path 已不依赖，后续 Kernel/Serializer 阶段删除。
- Serializer：未新增、未重构。
- Error classifier / NO_DATA：未修改。
- BUG-B：未修改页面访问业务语义，只把已有 pageViews shape 注册进共享 Contract。

## 11. 测试结果

| 门禁 | 结果 |
|---|---|
| Phase 0 relevant | 5 suites / 67 tests PASS |
| Phase 1 | 2 suites / 19 tests PASS |
| Phase 2 | 5 suites / 45 tests PASS |
| Phase 2.1 | 1 suite / 9 tests PASS |
| Phase 3 | 7 suites / 43 tests PASS |
| full repo `npm.cmd test -- --runInBand` | 136 suites / 1226 tests PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run verify:runtime-contract` | PASS |
| `git diff --check` | PASS |

Phase 0 数量较 Phase 2.1 报告少 2 条，是旧“官方结构被拒绝/三字段自动同步”Characterization 被 Phase 3 正式 Contract 测试替换；新增 Phase 3 共有 43 条，并未降低覆盖面。

## 12. 遗留风险

1. Kernel 中仍有 legacy `topMetric || metric` fallback；canonical 主链不依赖，但物理删除留待后续阶段。
2. Object × Metric compatibility、未知 Metric ID、运行时设备 capability 尚未成为共享 hard gate；这是 Phase 4/5 的明确范围。
3. Resolution Spec 的旧 service required 列表和 Overview Candidate legacy 字段仍作为历史配置存在，但 canonical service validation 已不消费它们作为 shape 真源。
4. Plugin 会为未版本化但不含 `metric` 的旧 Tool payload 补 `napm-resolved-query.v1`；未知显式版本仍 fail closed。

## 13. Remote / Commit / Completion

```text
Remote NAPM: NO
Deploy: NO
Package: NO
Restart: NO
Commit: NO
Phase 4 started: NO
Phase 3 complete: YES
```
