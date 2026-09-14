# GAIOP NAPM BUG-A 实施指令 — Phase 2.1：Semantic Lifecycle Contract 收口

> 前置状态：
>
> - Phase 0：PASS
> - Phase 1：PASS
> - Phase 2：CONDITIONAL PASS
> - Phase 3：HOLD
>
> 本轮只处理 Phase 2 遗留的 Semantic Lifecycle 边界问题。
>
> **本轮目标非常小：**
>
> ```text
> 1. 给 Canonical Semantic Contract 增加明确生命周期状态
> 2. Resolver 只接受 RESOLVED
> 3. 补完整 BottomN fail-closed 测试
> ```
>
> 完成后立即停止，不进入 Phase 3。

---

# 0. 本轮范围

只做：

```text
Semantic Contract lifecycle
+
Semantic → Resolver fail-closed boundary
+
完整 BottomN semantic 测试
```

不要再改：

```text
指标语义规则
排行语法
对象本体
Metric Catalog
ownership tri-state
QueryDecisionPolicy
Gateway / Direct
Shared Validator
metric / metrics[] / topMetric contract
LegacyMetricInputAdapter
Metadata
Kernel
Serializer
Error Contract
BUG-B
```

---

# 1. 给 Canonical Semantic Contract 增加正式状态字段

当前 `napm-query-semantic.v1` 已有：

```text
schemaVersion
operation
direction
targetObjectType
primaryMetric
requestedMetrics
rankingMetric
topCount
timeIntent
confidence
source
```

Phase 2.1 增加：

```text
status
```

正式枚举只允许：

```text
RESOLVED
AMBIGUOUS
UNRESOLVED
UNSUPPORTED
```

不要使用自由字符串。

---

# 2. 四种状态的精确定义

## 2.1 RESOLVED

含义：

> 当前 Semantic Contract 已具备进入 Resolver 所需的全部语义。

例如：

```json
{
  "schemaVersion": "napm-query-semantic.v1",
  "status": "RESOLVED",
  "operation": "rank_top",
  "direction": "desc",
  "targetObjectType": "WebApplication",
  "primaryMetric": "PGTME",
  "requestedMetrics": ["PGTME"],
  "rankingMetric": "PGTME",
  "topCount": 5
}
```

只有：

```text
status=RESOLVED
```

才允许进入：

```text
NapmResolvedQueryResolverService.resolveSemanticContract(...)
```

生成 Query Draft。

---

## 2.2 AMBIGUOUS

含义：

> 已理解用户意图范围，但某个关键 semantic slot 存在多个同等可信候选，不能唯一决定。

建议结构：

```json
{
  "schemaVersion": "napm-query-semantic.v1",
  "status": "AMBIGUOUS",
  "operation": "rank_top",
  "targetObjectType": "WebApplication",
  "requestedMetrics": [],
  "rankingMetric": null,
  "ambiguities": [
    {
      "slot": "metric",
      "candidates": [
        {"metricId": "PGTME", "ruleId": "..."},
        {"metricId": "PGNSLPGE", "ruleId": "..."}
      ]
    }
  ]
}
```

要求：

```text
Resolver 不得生成 Query Draft
不得默认取 candidates[0]
不得回退 Resolver inferMetric
```

进入现有 clarification lifecycle。

本轮不重构 clarification UI，只保证：

```text
AMBIGUOUS 不进入执行 Query 生成
```

---

## 2.3 UNRESOLVED

含义：

> 缺失 Resolver 所需关键语义，且不存在足够候选做 ambiguity。

例如：

```text
“帮我查前5个”
```

可以得到：

```json
{
  "status": "UNRESOLVED",
  "operation": "rank_top",
  "targetObjectType": null,
  "requestedMetrics": [],
  "rankingMetric": null,
  "topCount": 5,
  "unresolvedSlots": [
    "targetObjectType",
    "rankingMetric"
  ]
}
```

要求：

```text
Resolver 不得生成 Query Draft
```

不能：

```text
默认 WebApplication
默认第一个 metric
默认 topMetric
```

---

## 2.4 UNSUPPORTED

含义：

> 语义已经理解清楚，但当前 GAIOP/NAPM 执行能力不能保证正确实现。

当前典型：

```text
rank_bottom
```

例如：

```json
{
  "schemaVersion": "napm-query-semantic.v1",
  "status": "UNSUPPORTED",
  "operation": "rank_bottom",
  "direction": "asc",
  "targetObjectType": "WebApplication",
  "requestedMetrics": ["PGTME"],
  "rankingMetric": "PGTME",
  "topCount": 5,
  "reasonCode": "RANK_BOTTOM_UNSUPPORTED"
}
```

要求：

```text
Resolver 不得生成 executable Query Draft
NapmClient 不得因该 semantic path 被调用
```

本轮不实现新的 BottomN 能力。

---

# 3. status 由谁决定

建议由：

```text
WorkflowClassifierService
```

在组合：

```text
Object result
Metric semantic result
Ranking result
Time result
```

之后统一确定最终：

```text
Semantic Contract.status
```

不要让：

```text
Resolver
Policy
Runner
```

再重新判断 Semantic Lifecycle。

---

# 4. Slot 级结果要保留

Phase 2 已有：

```text
metric matcher:
resolved / ambiguous / unresolved
```

Phase 2.1 需要把 slot 状态真正汇总到 Canonical Contract。

建议：

```json
{
  "source": {
    "object": {
      "status": "resolved",
      "source": "object-ontology"
    },
    "metric": {
      "status": "ambiguous",
      "source": "metric-semantic-normalizer"
    },
    "ranking": {
      "status": "resolved",
      "source": "ranking-intent-parser"
    }
  }
}
```

最终 Contract 顶层：

```text
status
```

由这些 slot 结果统一汇总。

---

# 5. 顶层状态合并原则

建议：

```text
先判断关键 semantic slots 是否完整
↓
存在歧义
→ AMBIGUOUS

关键槽位缺失
→ UNRESOLVED

语义完整，但 operation/capability 已知当前不支持
→ UNSUPPORTED

全部满足
→ RESOLVED
```

重点：

```text
不要仅因为识别出 rank_bottom 就直接 UNSUPPORTED，
如果 rankingMetric/object 等关键槽位仍未解析完整，应先 UNRESOLVED。
```

这样不会用“不支持”掩盖“语义没解析完整”。

---

# 6. Resolver 增加 fail-closed boundary

`NapmResolvedQueryResolverService.resolveSemanticContract(...)`

必须在任何 Query Draft 组装之前检查：

```text
semanticContract.schemaVersion
semanticContract.status
```

## 6.1 schemaVersion

未知版本：

```text
SEMANTIC_SCHEMA_UNSUPPORTED
```

不生成 Query Draft。

## 6.2 status=RESOLVED

允许：

```text
继续 Resolver
```

## 6.3 status=AMBIGUOUS

返回：

```text
ok=false
reasonCode=SEMANTIC_AMBIGUOUS
```

可附带：

```text
ambiguities
```

且：

```text
queryDraft = null
resolvedQuery = null
```

## 6.4 status=UNRESOLVED

返回：

```text
ok=false
reasonCode=SEMANTIC_UNRESOLVED
```

可附带：

```text
unresolvedSlots
```

不得生成 Query Draft。

## 6.5 status=UNSUPPORTED

返回：

```text
ok=false
reasonCode=<semantic reasonCode>
```

例如：

```text
RANK_BOTTOM_UNSUPPORTED
```

不得生成 executable Query Draft。

---

# 7. resolvePrompt(rawPrompt) 也必须遵守 status boundary

Phase 2 已规定：

```text
raw prompt
→ unified semantic pipeline
→ Semantic Contract
→ resolveSemanticContract()
```

Phase 2.1 必须确保：

```text
resolvePrompt()
```

不会因为：

```text
AMBIGUOUS
UNRESOLVED
UNSUPPORTED
```

再调用旧 fallback 补 metric / object / ranking。

禁止：

```text
semantic.status != RESOLVED
↓
Resolver 再猜
```

---

# 8. 不新增第二套 lifecycle 判定

禁止新增：

```text
Resolver.isSemanticComplete()
Policy.isClarificationRequired()
Runner.canResolve()
```

各自维护另一套状态规则。

生命周期权威只能是：

```text
Canonical Semantic Contract.status
```

各下游只消费。

---

# 9. primaryMetric 继续 optional

本轮不要因为 lifecycle 收口而重新要求：

```text
primaryMetric 必填
```

多指标：

```json
{
  "status": "RESOLVED",
  "operation": "timeseries",
  "requestedMetrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ],
  "primaryMetric": null
}
```

只要该 operation 不要求单一 ranking metric，就仍然应：

```text
RESOLVED
```

---

# 10. rankingMetric 的 required 条件保持

排行语义：

```text
rank_top
```

若准备进入 Resolver：

```text
rankingMetric 必须存在
```

如果：

```text
operation=rank_top
rankingMetric=null
```

则：

```text
UNRESOLVED
```

不是：

```text
RESOLVED
```

---

# 11. rank_bottom 的状态规则

必须区分两种情况。

## Case A：语义完整的 BottomN

例如：

```text
页面响应时间最低的5个业务
```

应：

```text
object=WebApplication
operation=rank_bottom
direction=asc
requestedMetrics=[PGTME]
rankingMetric=PGTME
topCount=5
```

但：

```text
status=UNSUPPORTED
reasonCode=RANK_BOTTOM_UNSUPPORTED
```

## Case B：语义本身还不完整

例如：

```text
最低的5个业务
```

如果：

```text
rankingMetric=null
```

建议：

```text
status=UNRESOLVED
```

因为首先缺失排行指标。

不要只因为 operation=rank_bottom 就把所有缺槽位情况直接标为：

```text
UNSUPPORTED
```

---

# 12. 必补完整 BottomN 测试

新增问句：

```text
页面响应时间最低的5个业务
```

预期 Semantic Contract：

```json
{
  "status": "UNSUPPORTED",
  "operation": "rank_bottom",
  "direction": "asc",
  "targetObjectType": "WebApplication",
  "requestedMetrics": ["PGTME"],
  "rankingMetric": "PGTME",
  "topCount": 5,
  "reasonCode": "RANK_BOTTOM_UNSUPPORTED"
}
```

Resolver：

```text
ok=false
reasonCode=RANK_BOTTOM_UNSUPPORTED
queryDraft=null
```

必须证明：

```text
不生成 topValues
不进入 fake asc path
```

---

# 13. AMBIGUOUS 测试

至少新增一个可控测试。

优先使用：

```text
测试专用 fixture rule
```

构造两个相同：

```text
priority
specificity
object match
```

的 metric candidate。

期望：

```text
MetricSemanticNormalizer
→ ambiguous

WorkflowClassifier
→ status=AMBIGUOUS

Resolver
→ no Query Draft
```

不要为了制造歧义污染正式产品规则。

---

# 14. UNRESOLVED 测试

至少：

```text
“帮我查前5个”
```

或当前项目能稳定产生缺 object/metric 的表达。

期望：

```text
status=UNRESOLVED
unresolvedSlots 包含必要字段
Resolver no Query Draft
```

---

# 15. RESOLVED 测试

已有核心问句全部增加 status 断言：

```text
最近业务访问较慢的前5个业务都有谁？
→ RESOLVED

页面响应时间最高的前5个业务
→ RESOLVED

慢页面数量最多的前5个业务
→ RESOLVED

服务器响应时间最高的前5个已定义应用
→ RESOLVED

网络时延最高的前5个IP
→ RESOLVED
```

---

# 16. 多指标 RESOLVED 测试

```text
同时查看访问量、页面响应时间和 HTTP500
```

应：

```text
status=RESOLVED
primaryMetric=null
requestedMetrics=[PGNPGE,PGTME,PGHTTP500]
```

不能因为：

```text
primaryMetric=null
```

变成 unresolved。

---

# 17. Semantic Contract runtime-contract

`verify:runtime-contract` 增加：

```text
Canonical Semantic Contract 必须定义 status

允许 status 仅：
RESOLVED
AMBIGUOUS
UNRESOLVED
UNSUPPORTED

Resolver production path 必须检查 status

Resolver 不能为非 RESOLVED semantic 生成 Query Draft

不允许新的 production module 自行定义第二套 semantic lifecycle enum
```

按仓库当前检查能力实现，不引入重量级依赖。

---

# 18. Phase 2 已完成规则不要再扩张

本轮不允许修改：

```text
WebApplication + 慢 → PGTME
慢页面数量 → PGNSLPGE
DefinedApp + 服务端响应时间 → TRTI
IPAddress + 网络时延 → RTTI
```

也不要新增新的：

```text
Metric rules
Ranking grammar
Object aliases
Count grammar
```

除非 Phase 2.1 测试暴露真实 bug；若必须改，先在报告中说明原因。

---

# 19. Phase 2.1 不得进入 Phase 3

本轮禁止：

```text
Canonical ResolvedQuery Contract
metrics[] / topMetric 正式迁移
LegacyMetricInputAdapter
删除 legacy metric
Plugin topMetric-in-metrics 修复
QueryValidator contract 修改
```

---

# 20. Phase 2.1 不得进入 Phase 4/5

禁止：

```text
Shared Validator
QueryDecisionPolicy hard gate
ownership tri-state 接线
METRIC_UNKNOWN gate
0 southbound
RuntimeMetricCapabilityService
metadata 调用顺序修改
```

---

# 21. Phase 2.1 不得进入后续 Kernel/Error 阶段

禁止：

```text
Serializer
MetricExecutionKernel fallback 删除
Metadata overload 拆分
Error Contract
NO_DATA classifier
BUG-B
```

---

# 22. 允许修改文件

预计允许：

```text
services/WorkflowClassifierService.js
services/NapmResolvedQueryResolverService.js

services/MetricSemanticNormalizerService.js
（仅 status / ambiguity 结构适配，如必要）

services/RankingIntentParserService.js
（仅 lifecycle 结构适配，如必要）

canonical Semantic Contract helper/schema
（优先复用已有结构）

tests
verify-runtime-contract
docs / memory
```

不应大面积改生产文件。

---

# 23. Phase 2.1 测试矩阵

至少包含：

## RESOLVED

```text
慢业务 Top5
页面响应时间 Top5
慢页面数量 Top5
服务器响应时间 Top5 DefinedApp
网络时延 Top5 IP
多指标非排行 primaryMetric=null
```

## AMBIGUOUS

```text
测试 fixture 双候选
→ AMBIGUOUS
→ Resolver no draft
```

## UNRESOLVED

```text
缺关键 object / metric
→ UNRESOLVED
→ Resolver no draft
```

## UNSUPPORTED

```text
页面响应时间最低的5个业务
→ UNSUPPORTED
→ RANK_BOTTOM_UNSUPPORTED
→ Resolver no draft
```

## Schema

```text
unknown semantic schemaVersion
→ fail closed
```

## Resolver Boundary

```text
RESOLVED → can resolve
AMBIGUOUS → cannot resolve
UNRESOLVED → cannot resolve
UNSUPPORTED → cannot resolve
```

---

# 24. Phase 0/1/2 非目标行为回归

本轮结束后以下仍不得提前修：

```text
Policy WebApplication + TRTI
Gateway WebApplication + TRTI
Direct execute bypass
Plugin topMetric-in-metrics
QueryValidator legacy metric
Kernel metric fallback
Metadata overload
Error text NO_DATA guessing
Ownership tri-state 未接 Policy
```

Phase 2 已完成的 Semantic 正确行为必须继续保持。

---

# 25. 完成后必须运行

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

并分别运行：

```text
Phase 0 relevant
Phase 1
Phase 2
Phase 2.1 lifecycle
```

---

# 26. Phase 2.1 输出格式

完成后立即停止，不进入 Phase 3。

## 26.1 Git

```text
branch:
HEAD:
Phase 2.1 start status:
Phase 2.1 end status:
Phase 2.1 files:
```

## 26.2 Semantic Lifecycle Contract

列出最终：

```text
RESOLVED
AMBIGUOUS
UNRESOLVED
UNSUPPORTED
```

每项说明：

```text
definition
required fields
Resolver behavior
```

## 26.3 Resolver Boundary

```markdown
| status | Resolver allowed | Query Draft | reasonCode |
|---|---:|---:|---|
| RESOLVED | YES | YES | ... |
| AMBIGUOUS | NO | NO | SEMANTIC_AMBIGUOUS |
| UNRESOLVED | NO | NO | SEMANTIC_UNRESOLVED |
| UNSUPPORTED | NO | NO | semantic reason |
```

## 26.4 Core Results

```markdown
| Input | status | object | operation | rankingMetric | topCount | Resolver |
|---|---|---|---|---|---:|---|
| 慢业务Top5 | ... | ... | ... | ... | 5 | ... |
| 页面响应时间最低5个 | UNSUPPORTED | WebApplication | rank_bottom | PGTME | 5 | no draft |
| ambiguous fixture | AMBIGUOUS | ... | ... | ... | ... | no draft |
| unresolved input | UNRESOLVED | ... | ... | ... | ... | no draft |
```

## 26.5 Runtime Contract

逐项：

```text
semantic status enum
resolver status guard
no non-resolved Query Draft
single lifecycle source
```

PASS / FAIL。

## 26.6 Phase 2 non-regression

确认：

```text
Metric rules unchanged
Ranking grammar unchanged
Object ontology unchanged
BottomN still no executable query
```

## 26.7 Later-phase non-regression

确认：

```text
Policy hard gate unchanged
Gateway unchanged
Direct unchanged
QueryValidator unchanged
Kernel unchanged
Metadata unchanged
Error classifier unchanged
```

## 26.8 Tests

```text
Phase 0:
Phase 1:
Phase 2:
Phase 2.1:
full repo:
lint:
runtime-contract:
diff-check:
```

## 26.9 Remote / Commit

```text
Remote NAPM: NO
Deploy: NO
Commit: NO
Phase 3 started: NO
```

## 26.10 Completion

```text
Phase 2.1 complete: YES / NO
```

---

# 27. Phase 2.1 完成定义

只有全部满足才算完成：

```text
1. Canonical Semantic Contract 有正式 status
2. status 仅有：
   RESOLVED
   AMBIGUOUS
   UNRESOLVED
   UNSUPPORTED
3. WorkflowClassifier 统一决定顶层 lifecycle
4. Metric ambiguity 能传递到顶层 Contract
5. Resolver 只接受 RESOLVED
6. AMBIGUOUS 不生成 Query Draft
7. UNRESOLVED 不生成 Query Draft
8. UNSUPPORTED 不生成 Query Draft
9. unknown schemaVersion fail closed
10. 多指标 primaryMetric=null 仍可以 RESOLVED
11. 完整 BottomN：
    页面响应时间最低的5个业务
    → UNSUPPORTED
    → RANK_BOTTOM_UNSUPPORTED
    → no executable Query
12. Phase 2 已有 metric/ranking/object semantics 不发生无关漂移
13. 不进入 Phase 3
14. 不进入 Phase 4/5
15. full tests / lint / runtime-contract / diff-check 全部通过
```

---

# 28. 最终提醒

这是一轮很小的边界收口。

不要把它扩大成：

```text
重新设计 Semantic Contract
重写 WorkflowClassifier
重写 Resolver
开始 Query Contract migration
开始 Shared Validator
```

本轮只回答一个问题：

> **什么样的 Semantic Contract 有资格生成 Query？**

最终答案必须唯一：

```text
只有 status=RESOLVED
```

完成后停止，等待 Phase 2.1 Review。
