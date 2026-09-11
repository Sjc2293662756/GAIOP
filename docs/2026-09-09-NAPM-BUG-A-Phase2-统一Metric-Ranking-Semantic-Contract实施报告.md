# NAPM BUG-A Phase 2：统一 Metric / Ranking Semantic Contract 实施报告

日期：2026-09-09  
范围：仅 Phase 2（自然语言 → Semantic Contract → Resolver 输入）  
结论：Phase 2 已完成；未进入 Phase 3，未改 Query Execution Gate。

> 2026-09-09 Phase 2.1 后续说明：本报告记录 Phase 2 当时基线。Semantic Lifecycle 已在 Phase 2.1 收口；“最低的5个业务”因缺 `rankingMetric` 现为 `UNRESOLVED`，只有“页面响应时间最低的5个业务”等完整 BottomN 才为 `UNSUPPORTED/RANK_BOTTOM_UNSUPPORTED`。无对象、无 operation 的多指标问句现为 `UNRESOLVED`；明确“业务 + 趋势”的多指标问句才为 `RESOLVED`。以 Phase 2.1 实施报告为准。

## 1. Git 基线与保护措施

| 项目 | 结果 |
|---|---|
| 分支 | `codex/napm-turn-decision-phase1` |
| Phase 2 起始 HEAD | `c07a652aa80dd593ecf3546fe41f8f621175491a` |
| Phase 2 结束 HEAD | `c07a652aa80dd593ecf3546fe41f8f621175491a`（未提交） |
| 修改前备份 | `C:\Users\20693\AppData\Local\Temp\codex-napm-bug-a-phase2-pre-20260909-154500` |
| reset / stash | 均未执行 |
| 版本号 | 未修改 |
| 发布包 / 部署 | 未制作、未部署 |
| 远端服务器 | 未连接、未修改、未重启 |

Phase 2 开始前工作区已有 Phase 0、Phase 1 及文档/记忆修改，全部保留。当前工作区不干净是阶段指令要求“不自动提交”的结果，不代表测试失败。

变更来源区分：

- pre-existing：本分支既有 Query Turn、页面下钻、文档与维护记录。
- Phase 0：Characterization Tests 与基线报告。
- Phase 1：Truth Source 收口、Metric Catalog fail-closed、ownership 三态 API 与报告。
- Phase 2：本报告第 4 节列出的统一语义契约、配置驱动解析、BottomN 收口、测试和文档同步。

## 2. 目标与阶段边界

本阶段解决的是同一句自然语言被 Classifier、Resolver、TagNormalizer 多次解释的问题。落地后的唯一主链为：

```text
ObjectOntologyService
        +
Resolution Spec.metricSemanticRules
        → MetricSemanticNormalizerService
        +
Resolution Spec.rankingGrammar
        → RankingIntentParserService
        +
ResolvedQueryTimeRangeService
        ↓
napm-query-semantic.v1
        ↓
WorkflowClassifierService（只组合）
        ↓
NapmResolvedQueryResolverService（只消费契约）
        ↓
过渡期 legacy Query Draft shape
```

本阶段明确没有实施：

- Canonical Query Contract、`metric` 迁移和 LegacyMetricInputAdapter（Phase 3）。
- Shared Validator、Object × Metric hard gate 和错误 Query 零南向（Phase 4/5）。
- Runtime Metadata 调用顺序、Serializer、Kernel、Error Contract 重构。
- BUG-B / pageViews 追问链路修改。

因此，本阶段只能声明“自然语言语义解析已统一”，不能声明 BUG-A 的所有错误结构化输入均已阻断。

## 3. 修改前语义入口审计

| 组件 | 修改前理解内容 | 是否位于本阶段 canonical 语义主链 | Phase 2 处理 |
|---|---|---:|---|
| `ObjectOntologyService` | 对象类型与别名 | YES | 成为对象唯一入口；补入缺失的 canonical `IPAddress` |
| `MetricSemanticNormalizerService` | 私有指标正则与 aliases | YES | 删除私有业务词表，只执行 canonical rules |
| `WorkflowClassifierService` | 工作流、对象、指标、私有排行判断 | YES | 删除私有排行判断，只组合四类结构化结果 |
| `NapmResolvedQueryResolverService` | 再次推断指标、排行、数量、方向 | YES | 删除重复推断，新增 `resolveSemanticContract()` |
| `TagNormalizer` | tag、指标选择、Query 构造 | 旧兼容入口 | 降为 compatibility-label facade，禁止构造 Resolved Query |
| `TopValuesResultNormalizerService` | desc/asc 都本地排序 | 结果归一化 | 仅 desc TopN 排序；asc 不再伪造 BottomN |
| Plugin / `QueryDecisionPolicy` | 路由、准入和执行门禁 | NO（属于后续 Gate 阶段） | 本阶段不修改 |
| `RequirementParserService` / Overview helpers | 旧修复、概览和兼容路径的 prompt 辅助逻辑 | NO（不签发 canonical contract） | 按阶段禁令保留，后续对应阶段再迁移 |

说明：仓库内仍能搜索到报告/概览/诊断兼容路径的文字判断，但它们不再为 `napm-query-semantic.v1` 赋值，也不是 Resolver 的第二套指标/排行解析器。若要求整个仓库所有旧辅助逻辑都删除，需要在后续阶段结合 Query Contract、Gateway 和 Overview 单独迁移，不能在 Phase 2 越界处理。

## 4. Phase 2 文件变更

| 文件 | 修改目的 | Semantic 行为改变 | Query Execution Gate 改变 |
|---|---|---:|---:|
| `skills/openclaw-napm-query/config/napm-resolution-spec.v1.json` | 增加唯一 `metricSemanticRules`、`rankingGrammar`，弃用旧 aliases 生产匹配 | YES | NO |
| `skills/openclaw-napm-query/config/object-ontology.v1.json` | 补充已由旧代码支持但 canonical ontology 缺失的 `IPAddress`，保存兼容默认对象 | YES | NO |
| `services/ResolutionSpecService.js` | 暴露两类 canonical 语义配置 | YES | NO |
| `services/ObjectOntologyService.js` | 暴露 canonical 默认指标查询对象 | YES | NO |
| `services/MetricSemanticNormalizerService.js` | 配置驱动指标匹配、优先级、歧义和多指标 | YES | NO |
| `services/RankingIntentParserService.js` | 唯一排行操作、方向、数量解析器 | YES | NO |
| `services/WorkflowClassifierService.js` | 组合并冻结统一 Semantic Contract | YES | NO |
| `services/NapmResolvedQueryResolverService.js` | 只消费 Semantic Contract；raw prompt 入口只委托统一链路 | YES | NO |
| `services/TagNormalizer.js` | 退出指标决策和 Query 构造，只保留兼容标签 | YES | NO |
| `services/TopValuesResultNormalizerService.js` | 禁止用 asc 反转 TopN 冒充 BottomN | YES | NO |
| `scripts/verify-napm-skill-runtime-contract.js` | 增加语义真源和生产可达性静态契约 | NO | NO |
| Phase 2 tests | 核心问句、优先级、歧义、多指标、BottomN、可达性、runtime contract | NO | NO |
| `AGENTS.md`、`SOUL.md`、`PROJECT.md`、`TOOLS.md`、`CLAUDE.md`、`CONTEXT.md`、Query `SKILL.md` | 同步实际架构和阶段边界 | NO | NO |

没有修改 `QueryDecisionPolicy`、插件 Tool execute、`RequirementParserService`、`QueryValidator`、`NapmClient`、Metadata/Metric Kernel 或 Serializer。

## 5. Semantic Truth Source

| 槽位 | 唯一来源 | 消费者 |
|---|---|---|
| object | `skills/openclaw-napm-query/config/object-ontology.v1.json` | `ObjectOntologyService` |
| metric semantic | canonical Resolution Spec 的 `metricSemanticRules` | `MetricSemanticNormalizerService` |
| ranking grammar | canonical Resolution Spec 的 `rankingGrammar` | `RankingIntentParserService` |
| time | `ResolvedQueryTimeRangeService` | `WorkflowClassifierService` |
| legal Metric ID | `skills/openclaw-napm-query/config/metrics-config.yml` | semantic rule contract check |

- canonical Semantic 主链是否还有第二套 metric parser：**NO**。
- canonical Semantic 主链是否还有第二套 ranking parser：**NO**。
- 全仓是否已删除所有历史 prompt helper：**NO**。旧 Overview、诊断路由和执行兼容 helper 按阶段边界保留，但不能签发或覆盖 canonical Semantic Contract。

## 6. Canonical Semantic Contract

实际 schema：`napm-query-semantic.v1`。

| 字段 | 存在性 | 约束 |
|---|---|---|
| `schemaVersion` | required | 只接受 `napm-query-semantic.v1`；未知版本 fail-closed |
| `operation` | required for resolved intent | 支持 `rank_top`、`rank_bottom`、`average`、`timeseries`、`detail_list`、`metadata_list`；无法分类时为 `null` |
| `direction` | ranking required | `rank_top=desc`、`rank_bottom=asc`；非排行为 `null` |
| `targetObjectType` | optional at semantic stage | 只能来自 Object Ontology；执行所需而未识别时由后续生命周期澄清 |
| `primaryMetric` | always optional | 只表示主要关注指标，不从 `requestedMetrics[0]` 强制生成 |
| `requestedMetrics` | required array | 表示要求返回的指标，支持多指标和空数组 |
| `rankingMetric` | ranking execution required | 排行依据；未来 `topMetric` 的唯一语义来源；不能由 `requestedMetrics[0]` 反推 |
| `topCount` | ranking required | 只来自 Ranking Intent Parser；非排行为 `null` |
| `timeIntent` | required object | 来自统一时间解析器 |
| `confidence` | required number | 组合结果置信度 |
| `source` | required object | 至少记录 object、metric、ranking 的 schema/source/status |

Resolver 的过渡期输出仍含 `metric`，这是 Phase 3 前的兼容 shape；该字段只从 Semantic Contract 派生，不再从 raw prompt 猜测。

## 7. 指标匹配规则

通用 matcher 的决策次序：

1. canonical Metric Catalog 中显式 Metric ID。
2. 更具体的短语/规则。
3. 与对象约束匹配的候选。
4. 更高 priority。
5. 更长匹配。
6. 同等级仍冲突则返回 `ambiguous` 和候选集合，不默认选第一个。

对象约束只用于语义消歧，不承担执行兼容性 hard gate。例如 `WebApplication + TRTI` 仍会被语义层识别，是否允许执行留给 Phase 4。

旧 `metrics.aliases` 已标记 deprecated，生产 matcher 不读取；传入 `specMetricAliases` 也不会恢复旧行为。所有 semantic rule 的 Metric ID 必须存在于 canonical Metric Catalog，否则 runtime contract 失败。

## 8. 核心问句结果

| 问句 | object | operation | direction | requestedMetrics | rankingMetric | topCount | Resolver |
|---|---|---|---|---|---|---:|---|
| 最近业务访问较慢的前5个业务都有谁？ | `WebApplication` | `rank_top` | `desc` | `[PGTME]` | `PGTME` | 5 | `topValues` draft |
| 页面响应时间最高的前5个业务 | `WebApplication` | `rank_top` | `desc` | `[PGTME]` | `PGTME` | 5 | `topValues` draft |
| 慢页面数量最多的前5个业务 | `WebApplication` | `rank_top` | `desc` | `[PGNSLPGE]` | `PGNSLPGE` | 5 | `topValues` draft |
| 服务器响应时间最高的前5个已定义应用 | `DefinedApp` | `rank_top` | `desc` | `[TRTI]` | `TRTI` | 5 | `topValues` draft |
| 网络时延最高的前5个IP | `IPAddress` | `rank_top` | `desc` | `[RTTI]` | `RTTI` | 5 | `topValues` draft |
| 最低的5个业务 | `WebApplication` | `rank_bottom` | `asc` | `[]` | `null` | 5 | `RANK_BOTTOM_UNSUPPORTED` |

多指标结果：

- “同时查看访问量、页面响应时间和 HTTP500” → `requestedMetrics=[PGNPGE,PGTME,PGHTTP500]`、`primaryMetric=null`。
- “同时查看流入吞吐量和流出吞吐量，按总吞吐量排行前10” → `requestedMetrics=[TPI,TPO]`、`rankingMetric=TPIO`、`topCount=10`。

## 9. Duplicate Parser Audit

| 旧入口 | Phase 2 状态 |
|---|---|
| `WorkflowClassifier.hasRankingIntent` | deleted |
| Resolver `inferMetric` | deleted |
| Resolver `isRankingPrompt` | deleted |
| Resolver `inferTopCount` | deleted |
| Resolver `inferDirection` | deleted |
| `MetricSemanticNormalizer.METRIC_PATTERNS` | deleted |
| `TagNormalizer.METRIC_CODE_MAP` | deleted |
| `TagNormalizer.mapTagsToResolvedQuery` | compatibility facade；返回 `TAG_MAPPER_DEPRECATED`，无 `resolvedQuery` |

Runtime contract 和 production-reachability tests 会阻止上述决策逻辑重新进入 Classifier/Resolver/TagNormalizer 主链。

## 10. BottomN 结果

| 检查 | 结果 |
|---|---|
| Parser 是否识别 `rank_bottom/asc` | YES |
| 是否生成 executable `topValues` | NO |
| `TopValuesResultNormalizer` 是否仍 asc 重排 | NO |
| `NapmClient` 是否因该语义路径执行 BottomN | NO |

原因：现有接口材料和已验证调用均没有真实 BottomN/升序 Top 能力。将 NAPM 返回的最大 N 条倒序，只会改变显示顺序，不会得到最小 N 条。

## 11. Phase 0/1 非目标行为回归

| 项目 | Phase 2 结果 | 后续归属 |
|---|---|---|
| Policy `WebApplication + TRTI` | 保持原行为，仍可能 `EXECUTE_QUERY` | Phase 4 |
| Gateway 错误对象指标组合 | 保持原 metadata/data 调用边界 | Phase 4/5 |
| Direct execute | 未修改 | Phase 4/5 |
| Plugin `topMetric in metrics` | 未修改 | Phase 3 |
| QueryValidator legacy `metric` | 未修改 | Phase 3 |
| Metric Kernel fallback | 未修改 | 后续 Kernel 阶段 |
| Metadata overloaded service | 未修改 | Metadata 阶段 |
| Error classifier empty/no-data | 未修改 | Error Contract 阶段 |
| ownership tri-state | 保持 Phase 1，实现但未接 Policy | Phase 4 |
| Metric Catalog fail-closed | 保持并通过回归 | Phase 1 已完成 |
| Root truth-source duplicates | 保持删除状态 | Phase 1 已完成 |

本阶段有意改变的 Phase 0 行为只有：慢业务/页面/网络指标可统一解析、`IPAddress` 在 Classifier 中可识别、BottomN 不再由 asc 本地伪造。

## 12. Runtime Contract

| 契约 | 结果 |
|---|---|
| single metric semantic source | PASS |
| semantic rule Metric IDs valid | PASS |
| single ranking grammar source | PASS |
| no Resolver private metric inference | PASS |
| no Resolver private ranking/count/direction inference | PASS |
| no WorkflowClassifier private ranking parser | PASS |
| TagNormalizer no production Query construction | PASS |

原 Phase 1 六项 Truth Source contract 也全部 PASS。

## 13. 测试结果

| 门禁 | 结果 |
|---|---|
| Phase 0 relevant characterization | 5 suites / 69 tests PASS |
| Phase 1 truth-source tests | 2 suites / 19 tests PASS |
| Phase 2 semantic/ranking tests | 5 suites / 44 tests PASS |
| full repo `npm.cmd test -- --runInBand` | 128 suites / 1175 tests PASS |
| `npm run lint` | PASS |
| `npm run verify:runtime-contract` | PASS |
| `git diff --check` | PASS |

说明：Windows 下使用 `npm.cmd test -- --runInBand`，实际 npm 输出为 `jest --runInBand`，确认全仓串行执行。此前一次非串行尝试出现两个报告模板测试超时，串行门禁未复现，最终门禁结果以上表为准。

## 14. 阶段结论与遗留风险

Phase 2 是否完成：**YES**。

完成定义已满足：唯一机器 Metric Semantic source、唯一 Ranking Grammar source、配置驱动 Normalizer、唯一 canonical 排行解析器、Classifier 只组合、Resolver 只消费、Object Ontology 统一、TagNormalizer 退出 Query 构造、多指标与独立 rankingMetric、BottomN fail-closed、Phase 1 真源与 Metric Catalog fail-closed 保持、所有要求门禁通过。

遗留风险：

1. Resolver 输出仍是含 legacy `metric` 的过渡 shape；必须等 Phase 3 统一 `metrics[]/topMetric`。
2. 错误结构化输入（例如直接提交 `WebApplication + TRTI`）尚未由统一 Validator 做零南向 hard gate；必须等 Phase 4/5。
3. `IPAddress` 是本阶段对 canonical ontology 的必要补充，因为旧 Resolver 已支持该对象、核心验收问句要求 Classifier/Resolver 一致；需要后续 Review 确认产品命名无异议。
4. 仓库仍有 Overview、诊断路由、旧执行修复路径的 prompt helpers；它们不签发 canonical Semantic Contract，但后续阶段迁移时仍应继续收口，避免再次获得主语义决策权。

本轮到此停止，未进入 Phase 3，未提交 commit，未连接远端。
