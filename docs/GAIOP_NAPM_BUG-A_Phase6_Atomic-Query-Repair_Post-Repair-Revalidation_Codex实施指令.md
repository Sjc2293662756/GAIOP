# GAIOP NAPM BUG-A 实施指令 — Phase 6：Atomic Query Repair + Post-Repair Revalidation

> 前置状态：
>
> - Phase 0：PASS
> - Phase 1：PASS
> - Phase 2：PASS
> - Phase 2.1：PASS
> - Phase 3：PASS
> - Phase 4：PASS
> - Phase 4.1：PASS
> - Phase 5：PASS
> - Phase 6：GO
>
> 当前主链已经闭环：
>
> ```text
> 自然语言
> → Canonical Semantic Contract
> → Semantic Lifecycle
> → Canonical ResolvedQuery
> → Shared Static Executable Validator
> → Runtime Capability Confirmation（仅 UNKNOWN）
> → Final Admission
> → Data Execution
> ```
>
> **本轮只实施 Phase 6：Atomic Query Repair + Post-Repair Revalidation。**
>
> 核心目标：
>
> > **任何会修改 Canonical ResolvedQuery 的 repair / normalization / metadata-assisted adjustment，都必须是原子的、可审计的、不能改变用户业务口径，并且修复后必须重新经过完整执行门禁。**
>
> 完成后立即停止，不进入 Serializer / Kernel Cleanup / Error Contract / Legacy Cleanup / BUG-B。

---

# 0. Phase 6 要解决的真实风险

历史上项目曾出现过这类问题：

```text
修复前：
metric=TRTI
metrics=[TRTI]
topMetric=TRTI

repair 后：
metric=PGTME
metrics=[PGTME]
topMetric=TRTI
```

虽然 Phase 3 已经让 canonical Query 不再包含 `metric`，但只要系统中仍存在：

```text
QueryMetadataConstraintService
metadata review
repair helper
normalizer
legacy compatibility path
group argument adjustment
```

这些组件可以修改：

```text
groups[]
metrics[]
topMetric
topCount
granularity
start/end
queryModeKey
group arguments
```

就仍然存在：

```text
局部修改
字段漂移
修复后绕过 Validator
repair 改变用户语义
```

的风险。

Phase 6 的任务就是：

```text
所有 Query 修改
→ 统一收口成 Atomic Repair
→ 修复后重新执行完整 admission
```

---

# 1. Phase 6 的核心原则

必须同时满足：

```text
1. Repair 只能处理“确定性、等价、不改变业务口径”的变换
2. Repair 必须先生成完整 repair plan
3. Repair 必须一次性应用到 candidate
4. Repair 前后 Query 都要可审计
5. Repair 后必须重新走 Canonical Contract
6. Repair 后必须重新走 Static Validator
7. Repair 后如仍 UNKNOWN，必须重新走 Runtime Capability
8. Repair 不能绕过任何 Gate
9. Repair 不能修改用户真正关注的指标语义
10. Repair 失败必须 fail closed
```

---

# 2. 本轮最重要的边界

允许 Repair：

```text
格式规范化
大小写规范化
去重
canonical alias 归一
字段顺序规范化
等价 group argument 规范化
queryModeKey 从 service 派生
已验证、唯一、无歧义的 legacy → canonical 转换
```

禁止 Repair：

```text
WebApplication + TRTI
→ PGTME

runtime 不支持 TRTI
→ 换成第一个支持的 metric

用户问服务器响应时间
→ 自动改页面响应时间

用户问返回 TPI/TPO
→ 为了通过校验删掉 TPO

topMetric 不合法
→ 自动改成 metrics[0]

对象不匹配
→ 自动换对象类型

缺少关键语义
→ 靠默认值补成另一个业务问题
```

---

# 3. Repair 的正式定义

本轮建议新增统一组件：

```text
AtomicQueryRepairService
```

或仓库风格下等价名称。

职责：

```text
Canonical ResolvedQuery
+
Repair Context
        ↓
分析是否存在可安全规范化项
        ↓
生成 Repair Plan
        ↓
一次性应用
        ↓
得到 Repaired Candidate
```

它不负责：

```text
自然语言解析
Semantic Lifecycle
Metric Catalog existence
Object × Metric admission
Runtime metricsForGroup
data execution
narration
```

---

# 4. Repair Service 输入必须是 Canonical Query

只接受：

```text
napm-resolved-query.v1
```

不接受：

```text
raw prompt
legacy metric
半 canonical query
unresolved semantic contract
```

Legacy input 仍应先经过：

```text
LegacyMetricInputAdapter
```

然后才有资格进入 Repair。

---

# 5. Repair 输出必须是 Plan，不是边改边走

建议：

```json
{
  "status": "REPAIR_AVAILABLE",
  "changes": [
    {
      "path": "queryModeKey",
      "from": "topn",
      "to": "topValues",
      "reasonCode": "DERIVED_FIELD_NORMALIZATION"
    }
  ]
}
```

或者：

```text
NO_REPAIR_NEEDED
REPAIR_AVAILABLE
REPAIR_REJECTED
```

---

# 6. Repair Plan 必须可审计

每一条 change 至少包括：

```text
path
before
after
reasonCode
source
semanticImpact
```

其中：

```text
semanticImpact
```

只允许：

```text
NONE
```

如果 repair 会改变用户业务含义：

```text
semanticImpact != NONE
→ REPAIR_REJECTED
```

---

# 7. Repair ReasonCode 建议

允许的例子：

```text
NORMALIZE_METRIC_ID_CASE
REMOVE_DUPLICATE_METRIC
NORMALIZE_GROUP_ARGUMENT
DERIVE_QUERY_MODE_KEY
REMOVE_REDUNDANT_FIELD
CANONICALIZE_ENUM
NORMALIZE_TIME_BOUND_FORMAT
```

禁止定义：

```text
FIX_WRONG_METRIC
AUTO_CHOOSE_COMPATIBLE_METRIC
AUTO_REPLACE_OBJECT
```

这种会改变业务语义的“修复”。

---

# 8. Repair 不得触碰 Semantic Truth

Phase 2 已确定：

```text
primaryMetric
requestedMetrics[]
rankingMetric
targetObjectType
operation
```

这些语义已经在 Query 形成前确定。

Phase 6 不能重新解释。

如果 Canonical Query 中：

```text
metrics=[]
topMetric=TRTI
groups=[WebApplication]
```

那是：

```text
contract / admission failure
```

不是 repair opportunity。

---

# 9. 先审计当前所有“会改 Query”的地方

修改前执行：

```bash
rg "repair|normalize|normalized|metadata.*constraint|reviewQuery|queryRequest\.|resolvedQuery\.|topMetric\s*=|metrics\s*=|groups\s*=|granularity\s*=|queryModeKey\s*="   skills/openclaw-napm-query   napm-openclaw-plugin.remote.js
```

重点审计：

```text
QueryMetadataConstraintService
RequirementParserService
NapmResolvedQueryResolverService
LegacyMetricInputAdapter
Plugin pre-execution normalization
run_napm_query.js
Overview child compiler
MetricExecutionKernel
Metadata review helpers
```

输出：

```markdown
| 组件 | 当前是否修改 Query | 修改字段 | 是否等价修复 | P6 处理 |
|---|---:|---|---:|---|
| ... | ... | ... | ... | ... |
```

---

# 10. QueryMetadataConstraintService 的 P6 定位

当前它可以保留：

```text
metadata hint
diagnostic warning
normalization suggestion
```

但不能再：

```text
直接改 Query
然后继续执行
```

Phase 6 后建议：

```text
QueryMetadataConstraintService
→ 输出 Repair Suggestion / Issue
→ AtomicQueryRepairService 决定是否属于 safe repair
```

---

# 11. Metadata Review 不能拥有最终 Query Mutation 权

如果：

```text
reviewGatewayRequestMetadata()
```

会直接修改：

```text
metrics[]
topMetric
groups[]
```

Phase 6 应收口。

目标：

```text
metadata review
→ evidence / suggestions
→ Repair Plan
→ atomic apply
→ full revalidation
```

不能：

```text
reviewQuery()
→ mutate original object
→ data execution
```

---

# 12. 原对象必须不可原地修改

Repair 必须：

```text
clone original query
```

在 candidate 上应用。

禁止：

```text
query.metrics = ...
query.topMetric = ...
```

直接修改传入对象。

测试必须证明：

```text
original query unchanged
```

---

# 13. Repair 必须是原子的

错误方式：

```text
先改 metrics
→ 校验部分通过
→ 再改 topMetric
→ 中间状态可能流出
```

正确：

```text
Repair Plan
↓
apply to isolated candidate
↓
candidate 完整生成
↓
统一 revalidation
↓
成功才 replace / continue
```

任何一步失败：

```text
原 Query 保持
candidate 丢弃
```

---

# 14. Repair 后必须重新走 Canonical Contract

第一步：

```text
ResolvedQueryContract.validate(repairedCandidate)
```

如果失败：

```text
REPAIR_POST_VALIDATION_FAILED
```

禁止：

```text
“repair 本身认为正确”
→ 直接执行
```

---

# 15. Repair 后必须重新走 Static Validator

即：

```text
repairedCandidate
↓
ResolvedQueryExecutableValidator
```

必须重新检查：

```text
Metric Catalog
Object × Metric ownership
groups/path
topMetric
metrics[]
```

---

# 16. Repair 后 UNKNOWN 必须重新走 Runtime Capability

如果 repaired candidate：

```text
Static UNKNOWN
```

必须：

```text
RuntimeMetricCapabilityService
```

重新确认。

不能复用：

```text
原 Query 的 runtime evidence
```

除非能够严格证明：

```text
capability scope 未改变
```

本轮建议：

```text
任何影响 capability key 的 repair
→ runtime evidence invalidated
```

优先安全。

---

# 17. Capability Scope 变化必须使旧 runtime evidence 失效

以下字段变化：

```text
groups[]
groupArgument
metric set
topMetric
service
```

必须：

```text
invalidate previous runtime capability evidence
```

时间范围变化通常不影响：

```text
metricsForGroup capability
```

但本轮不建议做复杂 evidence reuse。

默认：

```text
Repair 后重新 admission
```

最安全。

---

# 18. Repair 后不得复用 prepared proof

Phase 4.1/5 已有：

```text
prepared proof
```

如果 Repair 修改 Query：

```text
旧 proof 立即失效
```

必须重新：

```text
Static / Runtime Admission
```

---

# 19. Safe Repair：大小写标准化

例如：

```text
metric id:
pgtme
→ PGTME
```

前提：

```text
Metric Catalog canonical ID 唯一
```

如果大小写规范后：

```text
唯一命中
```

可以 repair。

如果：

```text
Catalog 本身区分大小写且无法证明唯一
```

则不能猜。

---

# 20. Safe Repair：重复 metrics 去重

例如：

```text
metrics=[
  PGTME,
  PGTME
]
```

可：

```text
metrics=[PGTME]
```

前提：

```text
顺序语义不受影响
```

---

# 21. Safe Repair：queryModeKey

Phase 3 已定义：

```text
service = canonical
queryModeKey = derived/transitional
```

因此：

```text
queryModeKey 缺失
→ 可由 service 唯一派生

queryModeKey 与 service 冲突
→ 不要静默覆盖
```

建议：

```text
缺失 → repair
冲突 → REPAIR_REJECTED / CONTRACT_CONFLICT
```

因为冲突说明调用方产生了两个不同事实。

---

# 22. Safe Repair：冗余 legacy 字段

如果某些内部旧路径仍残留：

```text
metric
```

但已在 Legacy Adapter Boundary 之外，

不要让 Atomic Repair 帮忙兜底。

正确：

```text
canonical contract reject
```

Phase 6 不得重新把 legacy metric 引回 canonical path。

---

# 23. Safe Repair：time format normalization

允许：

```text
可证明等价的时间格式标准化
```

例如：

```text
number string
→ canonical integer timestamp
```

前提：

```text
无时区/语义歧义
```

禁止：

```text
缺时间范围
→ 自动默认最近1小时
```

除非该默认早已属于 Canonical Semantic/Query Contract。

---

# 24. Safe Repair：group argument normalization

仅允许：

```text
同一个 exact identifier 的格式归一
```

例如：

```text
trim
canonical encoding
确定性的 type conversion
```

不能：

```text
查列表后选一个“最像的”
```

---

# 25. 禁止 Repair：对象替换

例如：

```text
WebApplication + TRTI
```

绝不能：

```text
WebApplication → DefinedApp
```

即使这样能够通过 ownership。

这改变用户对象口径。

---

# 26. 禁止 Repair：指标替换

同理：

```text
WebApplication + TRTI
```

绝不能：

```text
TRTI → PGTME
```

自然语言正常路径早已在 P2 得到 PGTME。

如果结构化 Query 明确写 TRTI：

```text
暴露错误
```

---

# 27. 禁止 Repair：删掉失败指标

例如：

```text
metrics=[
  PGNPGE,
  TRTI
]
```

其中 TRTI incompatible。

不能：

```text
删 TRTI
→ 继续查询 PGNPGE
```

必须：

```text
whole query fails
```

---

# 28. 禁止 Repair：改 topMetric

例如：

```text
metrics=[TPI,TPO]
topMetric=TRTI
```

不能：

```text
topMetric=TPI
```

只为了通过。

---

# 29. 禁止 Repair：使用 runtime capability 自动选第一个可用指标

错误：

```text
runtime supported=[
  PGTME,
  PGNPGE
]

requested TRTI unsupported
→ choose PGTME
```

禁止。

---

# 30. Repair 决策状态建议

统一：

```text
NO_REPAIR_NEEDED
REPAIR_APPLICABLE
REPAIR_REJECTED
```

apply 后：

```text
REPAIR_APPLIED
POST_REPAIR_VALIDATION_FAILED
```

不要混用：

```text
VALIDATION_FAILURE
```

来描述 repair planner 内部状态。

---

# 31. Final Admission 与 Repair 关系

建议完整：

```text
Canonical Query
↓
Initial Admission
↓
┌──────────────────────┐
│ ALLOW                │ → Execute
│ HARD DENY            │ → Stop
│ REPAIRABLE NORMALIZE │
└──────────────────────┘
          ↓
   Atomic Repair
          ↓
 Repaired Candidate
          ↓
 Full Admission Again
          ↓
 ALLOW / DENY / FAILURE
```

---

# 32. Static Incompatible 不是 Repairable

P4/P5 的：

```text
KNOWN_INCOMPATIBLE
METRIC_UNKNOWN
RUNTIME_UNSUPPORTED
```

默认都不是 Repairable。

Phase 6 不要插手改变。

---

# 33. 哪些问题可以触发 Repair

建议仅允许：

```text
CANONICALIZATION_REQUIRED
NORMALIZATION_REQUIRED
REDUNDANT_FIELD
DERIVED_FIELD_MISSING
FORMAT_NORMALIZATION
```

不要把：

```text
OBJECT_METRIC_INCOMPATIBLE
METRIC_UNKNOWN
RUNTIME_METRIC_UNSUPPORTED
```

设成 repair trigger。

---

# 34. Repair Planner 必须有 Allowlist

安全方式：

```text
允许 reasonCode 白名单
```

只有显式列入：

```text
SAFE_REPAIR_CODES
```

才可 repair。

未知 suggestion：

```text
REPAIR_REJECTED
```

不能：

```text
默认全部 suggestion 都可以修
```

---

# 35. Repair 后重新校验调用次数

如果有 repair：

```text
Initial Static Validator = 1
Repair Service           = 1
Post-repair Static       = 1
```

如果 post-repair UNKNOWN：

```text
Runtime Capability       = 1
```

没有 repair：

```text
Repair Service
可为 0 或 planner=1/no-op
```

按实现设计。

---

# 36. Repair 不能造成重复 data execution

一次 query：

```text
最多一次最终 data execution
```

禁止：

```text
先试原 Query
失败
→ repair
→ 再执行
```

Repair 必须发生：

```text
data execution 之前
```

---

# 37. Phase 6 不做“失败后重试式修复”

禁止：

```text
topValues 返回空
→ 猜 metric 错
→ repair
→ 再查
```

空数据不能反向证明参数错误。

---

# 38. `NO_DATA` 不触发 Repair

明确：

```text
合法 Query
→ data call
→ 0 rows
→ NO_DATA
```

Phase 6 不能：

```text
NO_DATA
→ 尝试换 metric / object / group
```

---

# 39. QueryMetadataConstraint 的 Warning 迁移

如果它继续产生：

```text
metric_group_incompatible_but_preserve_explicit_target
```

这种 warning，

Phase 6 后执行层不能依赖该 warning 来决定继续执行。

真正执行结论仍来自：

```text
Static Validator / Runtime Capability
```

---

# 40. Metadata Constraint 只能贡献 Safe Suggestion

如果 Constraint 想提供 repair：

```text
必须输出结构化 suggestion
```

例如：

```json
{
  "reasonCode": "REMOVE_DUPLICATE_METRIC",
  "path": "metrics",
  "semanticImpact": "NONE"
}
```

而不是：

```text
warning string
```

再由下游解析字符串修 Query。

---

# 41. 禁止从 Warning 文本解析 Repair

不允许：

```text
warning.includes("metric_group_incompatible")
→ replace metric
```

Repair 必须消费结构化 suggestion。

---

# 42. 原 Query 与 Repaired Query 指纹

建议为审计提供：

```text
beforeFingerprint
afterFingerprint
```

可基于：

```text
stable canonical JSON hash
```

用于证明：

```text
Query 确实发生了什么变化
```

不要求引入复杂加密依赖。

---

# 43. Repair Audit 建议结构

例如：

```json
{
  "repairApplied": true,
  "beforeFingerprint": "...",
  "afterFingerprint": "...",
  "changes": [
    {
      "path": "metrics",
      "reasonCode": "REMOVE_DUPLICATE_METRIC"
    }
  ],
  "postRepairAdmission": {
    "status": "ALLOW"
  }
}
```

---

# 44. Repair 不得泄漏到 NAPM 参数

Repair metadata：

```text
repairApplied
changes
fingerprint
```

都不能发送到 NAPM。

---

# 45. Plugin Path 的 Repair

Plugin 自己不要：

```text
修 Query
```

推荐：

```text
Plugin
→ Semantic/Canonical construction
→ QueryDecisionPolicy
→ Query Skill
```

真正 Atomic Repair 放在：

```text
Query Skill runtime / shared admission layer
```

避免 Plugin/Skill 双修复。

---

# 46. Legacy Adapter 与 Repair 的顺序

必须：

```text
Legacy Input
→ LegacyMetricInputAdapter
→ Canonical Candidate
→ Atomic Repair
→ Full Admission
```

不能：

```text
Repair legacy metric
→ Adapter
```

---

# 47. Semantic Path 与 Repair

新 Semantic path：

```text
Semantic
→ Canonical Query
```

一般不应需要大量 repair。

如果频繁需要：

```text
说明上游 Resolver 仍在产出非 canonical Query
```

报告必须说明。

---

# 48. Gateway / Direct 共用同一个 Repair Pipeline

不要：

```text
Gateway Repair A
Direct Repair B
```

建议共享：

```text
prepareCanonicalQueryForExecution()
```

或等价 admission/repair helper。

---

# 49. Overview Child Query

每个 child：

```text
独立 canonical query
```

如果需要 repair：

```text
child 自己 repair
→ child post-repair admission
```

不能继承 root 的 repair proof。

---

# 50. Prepared Proof 与 Repair

如果 Query 未发生 repair：

```text
原 prepared proof 逻辑保持
```

如果 Query 被 repair：

```text
旧 proof 失效
```

Repair 后重新生成：

```text
新的 one-time proof
```

且仍然：

```text
instance-local
non-serializable
one-time
```

---

# 51. Runtime Capability Evidence 与 Repair

如果 repair 发生在 runtime capability 之前：

```text
正常重新计算
```

如果当前代码可能在 runtime capability 之后 repair：

```text
必须重构顺序
```

正确顺序：

```text
Canonical
→ safe repair
→ static validation
→ runtime capability if needed
→ execute
```

优先让 repair 在 admission 前完成。

---

# 52. 推荐最终执行顺序

建议统一成：

```text
Input
↓
Legacy Adapter（如需要）
↓
Canonical Candidate
↓
Safe Normalization / Atomic Repair
↓
ResolvedQueryContract
↓
Static Validator
↓
Runtime Capability（仅 UNKNOWN）
↓
Final Admission
↓
Kernel
↓
NAPM
```

如果项目当前必须：

```text
先静态发现 suggestion 再 repair
```

则可以：

```text
Initial Contract/Constraint Analysis
↓
Repair
↓
Full Contract + Static + Runtime Admission
```

但：

```text
最终 data 前只认 post-repair admission
```

---

# 53. 不要重复 Static Validator 两次无意义

如果 Repair planner 本身不依赖 Static Validator：

```text
先 repair
→ 再 static
```

即可。

不要为了形式固定：

```text
static
→ repair
→ static
```

除非现有 repair suggestion 确实来自 static/constraint analysis。

重点不是次数，而是：

```text
repair 后一定完整重验
```

---

# 54. Safe Repair 的来源必须唯一化

如果项目存在：

```text
Normalizer A
Constraint B
Plugin helper C
Runner helper D
```

都能修 Query，

Phase 6 应收口：

```text
Suggestion producers 可以多个
真正 apply 只能 AtomicQueryRepairService 一个
```

---

# 55. Repair Suggestion Producer 不得 mutate

统一约束：

```text
producer
→ return suggestion
```

不允许：

```text
producer
→ mutate query
```

---

# 56. Repair 冲突处理

如果两条 suggestion：

```text
对同一 path
给出不同 after
```

例如：

```text
topMetric → PGTME
topMetric → TRTI
```

即使二者都标 safe：

```text
REPAIR_REJECTED
reasonCode=REPAIR_CONFLICT
```

不要按顺序覆盖。

---

# 57. Repair 依赖排序

如果 suggestion 之间有依赖：

```text
尽量避免
```

本轮 Repair 应聚焦：

```text
独立、确定、无语义影响
```

不做复杂规则引擎。

---

# 58. Repair Plan 应稳定 deterministic

同一输入：

```text
同一 plan
同一 changes 顺序
同一 output
```

便于测试和审计。

---

# 59. Repair 不读取自然语言

禁止：

```text
AtomicQueryRepairService(prompt)
```

它只看：

```text
Canonical Query
Structured Suggestions
```

---

# 60. Repair 不调用 LLM

禁止：

```text
让模型猜该改哪个 metric
```

本轮必须 deterministic。

---

# 61. Repair 不调用 `metricsForGroup` 来找替代项

可以使用 Runtime Capability：

```text
确认 requested metric supported / unsupported
```

但不允许：

```text
拿返回列表选替代 metric
```

---

# 62. Repair 不修改 `requestedMetrics` 的业务集合

Canonical Query 里：

```text
metrics[]
```

是用户要求返回的指标。

除：

```text
去重 / 格式等价规范化
```

外，不得改集合语义。

---

# 63. Repair 不修改 `topMetric` 业务语义

只能：

```text
格式规范化
```

不能：

```text
换排序指标
```

---

# 64. Repair 不修改 `groups[]` 业务对象语义

只能：

```text
等价格式规范化
```

不能：

```text
WebApplication → DefinedApp
```

---

# 65. Repair 不修改 `service` 业务意图

例如：

```text
topValues
```

不能为了通过 contract 改成：

```text
averageValues
```

---

# 66. Repair 不修改 `topCount` 用户显式值

如果：

```text
topCount=5
```

不能改成：

```text
10
```

唯一允许：

```text
字符串 "5" → number 5
```

如果现有 Contract 支持这种无歧义规范化。

---

# 67. Repair 不修改 `granularity` 用户语义

只能：

```text
canonical enum normalization
```

不能：

```text
minute → hour
```

---

# 68. Repair 后 Error Outcome

如果 safe repair 本身失败：

```text
REPAIR_FAILURE
```

如果 repair applied 但 post-repair contract/static/runtime 失败：

```text
返回 post-repair validation/admission outcome
```

同时附：

```text
repairApplied=true
```

不要伪装：

```text
NO_DATA
```

---

# 69. Phase 6 不做全局 Error Contract 重构

可以新增：

```text
REPAIR_REJECTED
REPAIR_CONFLICT
POST_REPAIR_VALIDATION_FAILED
```

但不要本轮统一所有：

```text
VALIDATION_FAILURE
NO_DATA
EXECUTION_FAILURE
```

那放下一阶段。

---

# 70. Phase 6 Runtime Contract 新保护

`verify:runtime-contract` 至少新增：

```text
single AtomicQueryRepairService applier

repair service no raw prompt dependency

repair service no LLM dependency

repair service no NapmClient dependency

repair service cannot replace metric semantics

repair service cannot replace object type

repair service cannot change service

repair service cannot drop unsupported metrics

repair service operates on clone

repair applied query must re-enter ResolvedQueryContract

repair applied query must re-enter Static Validator

runtime capability evidence invalid after capability-scope-changing repair

prepared proof invalid after repair

metadata/constraint producers do not mutate canonical query directly
```

---

# 71. Phase 6 允许修改

预计：

```text
新增：
services/AtomicQueryRepairService.js

可选新增：
services/QueryRepairPlan.js
或等价结构 helper

修改：
services/QueryMetadataConstraintService.js
services/RequirementParserService.js
run_napm_query.js admission pipeline

可能：
Overview child preparation
Plugin/Skill boundary only if needed to prevent duplicate repair

相关：
tests
runtime-contract
docs / memory
```

---

# 72. Phase 6 禁止修改

不要：

```text
修改 Metric Semantic rules
修改 Ranking grammar
修改 Object Ontology
修改 Metric Catalog
修改 Static ownership matrix
放宽 baseline/exhaustive
修改 Runtime capability provider 规则
新增新的 metadata provider
重构 metadata architecture
新增正式 NAPM Serializer
删除 Kernel legacy fallback
全局 Error Contract 重构
修 NO_DATA classifier
处理 BUG-B
连接真实 NAPM
部署
提交 commit
```

---

# 73. P5 回归：Static VALID 不应被 Repair 影响

verified baseline：

```text
WebApplication + PGTME
```

如果 canonical query 已经合法：

```text
NO_REPAIR_NEEDED
metricsForGroup=0
data=1
```

---

# 74. P5 回归：Static KNOWN_INCOMPATIBLE 不 Repair

```text
WebApplication + TRTI
```

verified baseline：

```text
KNOWN_INCOMPATIBLE
```

期望：

```text
Repair does NOT replace TRTI
metricsForGroup=0
data=0
```

---

# 75. P5 回归：UNKNOWN → runtime unsupported 不 Repair

```text
Static UNKNOWN
runtime excludes TRTI
```

期望：

```text
RUNTIME_METRIC_UNSUPPORTED
data=0
```

不能：

```text
Repair → PGTME
```

---

# 76. 单测：重复 metrics 去重

输入：

```json
{
  "metrics": ["PGTME", "PGTME"],
  "topMetric": "PGTME"
}
```

期望：

```text
REPAIR_APPLIED
metrics=[PGTME]
```

并：

```text
original query unchanged
```

---

# 77. 单测：Metric ID 大小写

如果项目 Catalog canonical IDs 大写且大小写等价规则明确：

```text
pgtme
→ PGTME
```

否则：

```text
不要实现该 repair
```

测试必须依据实际 Catalog/既有 contract。

---

# 78. 单测：queryModeKey 缺失

若当前 queryModeKey 是 derived field：

```text
service=topValues
queryModeKey missing
```

可以：

```text
repair derive
```

---

# 79. 单测：queryModeKey 冲突

```text
service=topValues
queryModeKey=timeseries
```

期望：

```text
REPAIR_REJECTED
```

不能：

```text
静默覆盖其中一个
```

---

# 80. 单测：非法 metric 替换 suggestion

构造 suggestion：

```text
TRTI → PGTME
```

即使 suggestion producer 给出：

```text
semanticImpact=NONE
```

Repair Service 必须通过自身 allowlist：

```text
拒绝
```

不能只相信 producer。

---

# 81. 单测：对象替换 suggestion

```text
WebApplication → DefinedApp
```

必须：

```text
REPAIR_REJECTED
```

---

# 82. 单测：service 替换 suggestion

```text
topValues → averageValues
```

必须：

```text
REPAIR_REJECTED
```

---

# 83. 单测：删除失败指标 suggestion

```text
metrics=[PGNPGE,TRTI]
suggestion=remove TRTI
```

必须拒绝。

---

# 84. 单测：Repair 冲突

两个 suggestion：

```text
same path
different after
```

期望：

```text
REPAIR_CONFLICT
```

---

# 85. 单测：原对象不可变

调用 repair 后：

```text
deepEqual(original, originalSnapshot)
```

必须：

```text
true
```

---

# 86. 单测：Repair 后 contract 重验

构造一个 repair：

```text
产生违反 ResolvedQueryContract 的 candidate
```

期望：

```text
POST_REPAIR_VALIDATION_FAILED
data=0
```

---

# 87. 单测：Repair 后 Static 重验

构造 safe format repair 后：

```text
candidate static incompatible
```

期望：

```text
KNOWN_INCOMPATIBLE / VALIDATION_FAILURE
data=0
```

不要因为 repair applied 就放行。

---

# 88. 单测：Repair 后 Runtime 重验

repair 后 candidate：

```text
Static UNKNOWN
```

runtime mock：

```text
SUPPORTED
```

期望：

```text
metricsForGroup=1
data=1
```

---

# 89. 单测：Repair 后 Runtime Unsupported

```text
Static UNKNOWN
runtime unsupported
```

期望：

```text
metricsForGroup=1
data=0
```

---

# 90. prepared proof 失效测试

流程：

```text
prepare original
→ proof A
→ repair changes query
→ try use proof A
```

期望：

```text
proof A invalid
```

必须重新 admission。

---

# 91. Runtime evidence 失效测试

如果 capability scope 变化：

```text
metric/group/service 改动
```

不能复用：

```text
original runtime evidence
```

---

# 92. Plugin 不重复 Repair

新 Semantic path：

```text
Plugin repair calls=0
Skill Atomic Repair=0 or 1
```

取决于是否有 safe normalization。

legacy path：

```text
Adapter=1
Repair=最多1
```

---

# 93. Gateway / Direct Repair 一致性

同一 canonical input：

```text
Gateway
Direct
```

应得到：

```text
相同 Repair Plan
相同 post-repair canonical query
```

不能两套行为。

---

# 94. Overview Child Repair

如果 child 需要 safe repair：

```text
child Repair=1
child post-repair admission=1
```

不能使用 root repair proof。

---

# 95. 调用计数：No Repair

合法 query：

```text
Repair=0/no-op
Static=1
Runtime=按 P5 规则
Data=1
```

---

# 96. 调用计数：Repair Applied

```text
Repair=1
Post-repair Contract=1
Post-repair Static=1
Runtime=0/1
Data 最多1
```

---

# 97. 调用计数：Repair Rejected

```text
Repair=1
Data=0
NapmClient data=0
```

---

# 98. Repair 不触发 metadata 额外请求

Safe repair 本身：

```text
NapmClient=0
```

不要为了 repair：

```text
applications
metricsForGroup
groups
```

除非进入 post-repair P5 Runtime Gate。

---

# 99. Phase 6 状态矩阵

最终报告至少输出：

```markdown
| Initial Query | Repair | Post-Repair Contract | Static | Runtime | Final |
|---|---|---|---|---|---|
| canonical valid | none | valid | VALID | n/a | ALLOW |
| duplicate metrics | applied | valid | VALID | n/a | ALLOW |
| unsafe metric replace | rejected | n/a | n/a | n/a | DENY |
| safe repair → static incompatible | applied | valid | KNOWN_INCOMPATIBLE | n/a | DENY |
| safe repair → UNKNOWN → supported | applied | valid | UNKNOWN | SUPPORTED | ALLOW |
| safe repair → UNKNOWN → unsupported | applied | valid | UNKNOWN | UNSUPPORTED | DENY |
```

---

# 100. Phase 6 最终执行链

目标：

```text
Legacy Input / Semantic Query
        ↓
Canonicalization
        ↓
Atomic Safe Repair
        ↓
Canonical ResolvedQuery
        ↓
ResolvedQueryContract
        ↓
Static Validator
        ↓
UNKNOWN ?
   │
   ├─ NO → final static decision
   │
   └─ YES
        ↓
Runtime Capability
        ↓
Final Admission
        ↓
Kernel
        ↓
NAPM
```

---

# 101. 完成后必须运行

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
Phase 2.1
Phase 3
Phase 4
Phase 4.1
Phase 5
Phase 6 repair / post-repair validation
```

---

# 102. Phase 6 最终报告格式

完成后立即停止。

## 102.1 Git

```text
branch:
HEAD:
Phase 6 start status:
Phase 6 end status:
Phase 6 files:
```

## 102.2 Query Mutation Audit

输出：

```markdown
| Component | Previously mutated query | P6 behavior |
|---|---:|---|
| QueryMetadataConstraintService | ... | ... |
| RequirementParser | ... | ... |
| Plugin | ... | ... |
| Runner | ... | ... |
| Overview | ... | ... |
```

## 102.3 Repair Contract

明确：

```text
input
status enum
allowed reasonCodes
forbidden mutation classes
plan schema
audit schema
```

## 102.4 Safe Repair Allowlist

列实际允许：

```text
...
```

并明确不允许：

```text
metric semantic replacement
object replacement
service replacement
drop requested metric
ranking metric replacement
```

## 102.5 Atomicity

回答：

```text
original query mutated:
YES / NO

repair applied on clone:
YES / NO

partial candidate can escape:
YES / NO
```

目标：

```text
NO
YES
NO
```

## 102.6 Post-Repair Revalidation

```text
ResolvedQueryContract rerun:
YES / NO

Static Validator rerun:
YES / NO

Runtime Capability rerun when UNKNOWN:
YES / NO
```

目标全部：

```text
YES
```

## 102.7 Proof / Runtime Evidence Invalidation

```text
prepared proof invalid after query change:
PASS / FAIL

runtime capability evidence invalidated on capability-scope change:
PASS / FAIL
```

## 102.8 Core Repair Matrix

输出第 99 节完整矩阵。

## 102.9 Call Counts

至少：

```text
no-repair valid
safe repair valid
repair rejected
post-repair static deny
post-repair runtime supported
post-repair runtime unsupported
```

分别给：

```text
Repair calls
Static Validator calls
metricsForGroup calls
Kernel calls
Data calls
NapmClient total
```

## 102.10 P5 Non-Regression

确认：

```text
VALID does not call metricsForGroup
KNOWN_INCOMPATIBLE no runtime metadata
METRIC_UNKNOWN no runtime metadata
UNKNOWN only provider-qualified runtime confirmation
Runtime unsupported no data
Runtime failure no data
```

## 102.11 Phase Boundaries

```text
Serializer added: NO
Kernel legacy fallback removed: NO
Global Error Contract refactored: NO
Metadata architecture refactored: NO
BUG-B touched: NO
Remote NAPM: NO
Deploy: NO
Commit: NO
```

## 102.12 Tests

```text
Phase 0:
Phase 1:
Phase 2:
Phase 2.1:
Phase 3:
Phase 4:
Phase 4.1:
Phase 5:
Phase 6:
Full repo:
lint:
runtime-contract:
diff-check:
```

必须给真实 PASS/FAIL 和 tests count。

## 102.13 Phase 6 Completion

```text
YES / NO
```

---

# 103. Phase 6 完成定义

只有全部满足才算完成：

```text
1. 只有一个 Atomic Query Repair applier
2. Repair 只处理 canonical query
3. Repair 不解析自然语言
4. Repair 不调用 LLM
5. Repair 不调用 southbound
6. Repair 不修改 metric 业务语义
7. Repair 不修改 object 业务语义
8. Repair 不修改 service 业务语义
9. Repair 不删除 requested metric
10. Repair 不替换 ranking metric
11. Repair 有显式 safe allowlist
12. Repair suggestion producer 不直接 mutate query
13. Repair 在 clone 上工作
14. 原 query 保持不变
15. Repair plan deterministic
16. conflicting repairs fail closed
17. Repair applied 后重新 ResolvedQueryContract
18. Repair applied 后重新 Static Validator
19. post-repair UNKNOWN 重新 Runtime Capability
20. capability-scope-changing repair 使旧 runtime evidence 失效
21. Repair 后旧 prepared proof 失效
22. data execution 发生在 repair/admission 全部完成后
23. 一个 query 最多执行一次最终 data request
24. NO_DATA 不触发 repair
25. runtime unsupported 不触发替代 metric repair
26. KNOWN_INCOMPATIBLE 不触发 repair
27. METRIC_UNKNOWN 不触发 repair
28. Phase 5 runtime gate 不被削弱
29. Phase 3 canonical query contract 保持
30. Phase 2 semantic contract 保持
31. 不进入 Serializer / Kernel Cleanup / Error Contract / BUG-B
32. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 104. 本轮最容易犯的错误

禁止：

```text
❌ 看见不兼容就自动换成兼容 metric

❌ 看见空数据就尝试修 Query

❌ metadata review 直接 mutate canonical Query

❌ repair 一半字段后就继续执行

❌ repair 后不重新 Validator

❌ repair 后沿用旧 prepared proof

❌ repair 后沿用旧 runtime capability evidence

❌ runtime unsupported 后选第一个可用 metric

❌ 删除失败的 metrics[] 成员后继续查

❌ Plugin 和 Skill 各 repair 一次

❌ Gateway / Direct 复制不同 repair 逻辑

❌ repair service 读取 raw prompt
```

---

# 105. Phase 6 完成后的目标状态

完成后应形成：

```text
用户语义
↓
Canonical Query
↓
安全、等价、原子的 Query Normalization/Repair
↓
完整 Contract + Static + Runtime Revalidation
↓
Final Admission
↓
Data Execution
```

任何会改变：

```text
用户对象
指标含义
排序依据
查询服务
```

的所谓 repair：

```text
一律禁止自动执行。
```

---

# 106. 本轮结束

完成：

```text
Phase 6：Atomic Query Repair + Post-Repair Revalidation
```

后立即停止。

下一阶段建议：

```text
Phase 7：Serializer / Kernel Contract Cleanup
```

必须等待 Phase 6 Review 通过后再开始。
