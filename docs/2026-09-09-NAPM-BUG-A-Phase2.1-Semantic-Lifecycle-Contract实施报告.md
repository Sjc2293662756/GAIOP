# NAPM BUG-A Phase 2.1：Semantic Lifecycle Contract 收口实施报告

日期：2026-09-09  
范围：仅 Semantic Contract lifecycle 与 Semantic → Resolver fail-closed boundary  
结论：Phase 2.1 已完成；未进入 Phase 3，未修改 Query Gate。

> 后续状态：Phase 3 已于 2026-09-10 完成 Canonical ResolvedQuery Contract 与 Legacy Adapter；本报告仍是 Phase 2.1 生命周期历史基线。Phase 3 结果以对应实施报告为准。

## 1. Git 基线与保护措施

| 项目 | 结果 |
|---|---|
| 分支 | `codex/napm-turn-decision-phase1` |
| Phase 2.1 起始 HEAD | `c07a652aa80dd593ecf3546fe41f8f621175491a` |
| Phase 2.1 结束 HEAD | `c07a652aa80dd593ecf3546fe41f8f621175491a`（本阶段不提交） |
| 起始工作区 | dirty；包含此前 Phase 0/1/2 的未提交修改 |
| 结束工作区 | dirty；保留此前修改并叠加 Phase 2.1 |
| 修改前备份 | `C:\Users\20693\AppData\Local\Temp\codex-napm-bug-a-phase21-pre-20260909-171443` |
| reset / stash | 均未执行 |
| 版本号 | 未修改 |
| 发布包 / 部署 | 未制作、未部署 |
| 远端服务器 | 未连接、未修改、未重启 |

## 2. 本阶段回答的问题

Phase 2 已统一对象、指标、排行和时间语义来源，但 Contract 尚未明确表达“语义是否已经完整且唯一”。Phase 2.1 将唯一准入答案固定为：

```text
Object / Metric / Ranking / Time slot results
                    ↓
WorkflowClassifierService computes operation-required slots
                    ↓
napm-query-semantic.v1.status
                    ↓
        only RESOLVED may enter Query Draft assembly
```

`RESOLVED` 只表示“用户语义已经完整、唯一地被理解”，不表示 Query Contract 已合法、Object × Metric 已兼容、Runtime device 已支持或允许 southbound。这些仍属于 Phase 3/4/5。

## 3. Semantic Lifecycle Contract

生命周期枚举只在 `WorkflowClassifierService` 定义一次，下游只消费。

| status | 定义 | operation required slots 处理 | Resolver 行为 |
|---|---|---|---|
| `RESOLVED` | 用户语义已完整且唯一 | 无歧义、无缺槽且没有已知语义能力限制 | 允许进入 assembly；后续仍可因 Query/能力校验失败 |
| `AMBIGUOUS` | required slot 有多个同等可信候选 | 顶层保存 `ambiguities[]` | `SEMANTIC_AMBIGUOUS`，`queryDraft=null`、`resolvedQuery=null` |
| `UNRESOLVED` | required slot 缺失且没有足够候选形成歧义 | 顶层保存 `unresolvedSlots[]` | `SEMANTIC_UNRESOLVED`，`queryDraft=null`、`resolvedQuery=null` |
| `UNSUPPORTED` | 语义完整，但当前能力明确不能正确实现 | 顶层保存稳定 `reasonCode` | 返回该 semantic reason，`queryDraft=null`、`resolvedQuery=null` |

`napm-query-semantic.v1` 正式新增并始终携带：

```text
status
ambiguities[]
unresolvedSlots[]
reasonCode
```

生命周期合并顺序固定为：

1. 按 operation 计算 required semantic slots。
2. required slot 有 ambiguity → `AMBIGUOUS`。
3. 否则 required slot 缺失/unresolved → `UNRESOLVED`。
4. 否则语义完整但当前能力明确不支持 → `UNSUPPORTED`。
5. 否则 → `RESOLVED`。

当前 required slots：

| operation | required slots |
|---|---|
| `rank_top/rank_bottom` | `operation`、`targetObjectType`、`rankingMetric`、`topCount`、`direction` |
| `timeseries/average` | `operation`、`targetObjectType`、非空 `requestedMetrics[]` |
| `detail_list/metadata_list/drilldown` | `operation`、`targetObjectType` |
| `overview` | `operation` |
| 无法确定 operation | `operation` |

## 4. Resolver Boundary

| status | Resolver allowed into assembly | Query Draft | reasonCode |
|---|---:|---:|---|
| `RESOLVED` | YES | MAYBE；仍需后续构造/校验 | 后续阶段决定 |
| `AMBIGUOUS` | NO | NO | `SEMANTIC_AMBIGUOUS` |
| `UNRESOLVED` | NO | NO | `SEMANTIC_UNRESOLVED` |
| `UNSUPPORTED` | NO | NO | Contract 自带原因，例如 `RANK_BOTTOM_UNSUPPORTED` |
| 缺少/非法 status | NO | NO | `SEMANTIC_STATUS_INVALID` |
| 未知 schemaVersion | NO | NO | `SEMANTIC_SCHEMA_UNSUPPORTED` |

Resolver 已删除 `defaultTargetObjectType` 补位。即使调用方在 context 中伪造该字段，也不会填入缺失对象。可信上下文若能确定对象，必须在 Semantic Contract 构造阶段写入 `targetObjectType`，并由 `source.object` 记录来源。

## 5. 核心结果

| Input | status | object | operation | requested/ranking metric | topCount | Resolver |
|---|---|---|---|---|---:|---|
| 最近业务访问较慢的前5个业务都有谁？ | `RESOLVED` | `WebApplication` | `rank_top` | `[PGTME] / PGTME` | 5 | 可生成过渡期 TopN Query |
| 页面响应时间最高的前5个业务 | `RESOLVED` | `WebApplication` | `rank_top` | `[PGTME] / PGTME` | 5 | 可生成过渡期 TopN Query |
| 慢页面数量最多的前5个业务 | `RESOLVED` | `WebApplication` | `rank_top` | `[PGNSLPGE] / PGNSLPGE` | 5 | 可生成过渡期 TopN Query |
| 服务器响应时间最高的前5个已定义应用 | `RESOLVED` | `DefinedApp` | `rank_top` | `[TRTI] / TRTI` | 5 | 可生成过渡期 TopN Query |
| 网络时延最高的前5个IP | `RESOLVED` | `IPAddress` | `rank_top` | `[RTTI] / RTTI` | 5 | 可生成过渡期 TopN Query |
| 查看业务页面访问量、页面响应时间和 HTTP500的趋势 | `RESOLVED` | `WebApplication` | `timeseries` | `[PGNPGE,PGTME,PGHTTP500] / null` | — | 具备进入 assembly 的语义资格；Phase 3 尚未实现正式 Query Contract |
| 同时查看访问量、页面响应时间和 HTTP500 | `UNRESOLVED` | `null` | `null` | `[PGNPGE,PGTME,PGHTTP500] / null` | — | no draft；缺 `operation` |
| 帮我查前5个 | `UNRESOLVED` | `null` | `rank_top` | `[] / null` | 5 | no draft；缺对象和排行指标 |
| 最低的5个业务 | `UNRESOLVED` | `WebApplication` | `rank_bottom` | `[] / null` | 5 | no draft；先报告缺排行指标 |
| 页面响应时间最低的5个业务 | `UNSUPPORTED` | `WebApplication` | `rank_bottom` | `[PGTME] / PGTME` | 5 | `RANK_BOTTOM_UNSUPPORTED`，no draft |
| 双候选测试 fixture | `AMBIGUOUS` | `IPAddress` | `rank_top` | `[] / null` | 5 | `SEMANTIC_AMBIGUOUS`，no draft |

多指标趋势的 `primaryMetric=null` 不会使语义变成未解析；`timeseries` 要求的是非空 `requestedMetrics[]`，不是单一主指标。

## 6. 修改范围

生产实现：

- `skills/openclaw-napm-query/services/WorkflowClassifierService.js`
- `skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js`
- `scripts/verify-napm-skill-runtime-contract.js`

测试与预期迁移：

- 新增 `test/bug-a-phase21-semantic-lifecycle.test.js`
- 更新 `test/bug-a-phase2-semantic-contract.test.js`
- 更新 `test/bug-a-phase2-runtime-contract.test.js`
- 更新 `test/bug-a-phase0-semantic-characterization.test.js`
- 更新 `test/napm-resolved-query-resolver-service.test.js`

文档同步：

- `AGENTS.md`、`SOUL.md`、`PROJECT.md`、`TOOLS.md`、`CLAUDE.md`、`CONTEXT.md`
- `skills/openclaw-napm-query/SKILL.md`
- 最终实施方案、Phase 2 历史报告说明、当天 memory 与本报告

本阶段没有修改 Metric Semantic rules、Ranking grammar、Object Ontology、Metric Catalog、ownership tri-state、QueryDecisionPolicy、Plugin/Gateway/Direct、QueryValidator、Kernel、Metadata 或错误分类器。

## 7. Runtime Contract

| contract | 结果 |
|---|---|
| semantic status enum 仅含四态 | PASS |
| lifecycle enum 只在 WorkflowClassifier 定义一次 | PASS |
| Contract 包含 `status/ambiguities/unresolvedSlots/reasonCode` | PASS |
| Resolver 在 operation assembly 前检查 status | PASS |
| 非 `RESOLVED` 明确返回 null Query Draft / Resolved Query | PASS |
| Resolver 不存在 `defaultTargetObjectType` | PASS |

## 8. Phase 2 与后续阶段非回归

Phase 2 非回归：

- Metric rules：未改。
- Ranking grammar：未改。
- Object Ontology：未改。
- `rank_top/desc` 核心问句：保持 `RESOLVED` 并可构造 TopN。
- BottomN：仍无 executable query；仅按最终生命周期规则区分“缺槽”和“完整但不支持”。

后续阶段保持未启动：

- Phase 3 Canonical Query Contract、`metrics[]/topMetric` 正式迁移：未实施。
- Shared Validator、Policy hard gate、Gateway/Direct 接线和零南向：未实施。
- QueryValidator、Metric Kernel、Metadata、Serializer、Error Contract：未修改。

## 9. 测试结果

| 门禁 | 结果 |
|---|---|
| Phase 0 relevant | 5 suites / 69 tests PASS |
| Phase 1 | 2 suites / 19 tests PASS |
| Phase 2 | 5 suites / 45 tests PASS |
| Phase 2.1 | 1 suite / 9 tests PASS |
| full repo `npm.cmd test -- --runInBand` | 129 suites / 1185 tests PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run verify:runtime-contract` | PASS |
| `git diff --check` | PASS |

Windows 环境使用 `npm.cmd` 调用，npm 实际执行的脚本与要求的 `npm test`、`npm run lint`、`npm run verify:runtime-contract` 相同。

## 10. 遗留风险

1. `timeseries/average` 虽可得到 `RESOLVED` Semantic，但当前 Resolver 仍只具备 Phase 2 的过渡装配能力；正式 Canonical Query Contract 属于 Phase 3。
2. `RESOLVED` 不承诺 Object × Metric 兼容或 runtime capability。错误结构化 Query 的 Shared Validator、Gate 和零南向证明仍属于 Phase 4/5。
3. 本阶段只保证非 `RESOLVED` 不生成 Query Draft，尚未重构 clarification UI 或把 lifecycle 状态接入 Query Gate。
4. 当前工作区包含 Phase 0/1/2/2.1 累积未提交修改；Review 时应按阶段报告和备份区分来源。

## 11. Remote / Commit / Completion

```text
Remote NAPM: NO
Deploy: NO
Package: NO
Restart: NO
Commit: NO
Phase 3 started: NO
Phase 2.1 complete: YES
```
