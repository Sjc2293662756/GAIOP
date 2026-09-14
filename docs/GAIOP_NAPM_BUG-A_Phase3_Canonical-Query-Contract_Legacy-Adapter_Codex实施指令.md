# GAIOP NAPM BUG-A 实施指令 — Phase 3：Canonical Query Contract + Legacy Metric Input Adapter

> 前置状态：
>
> - Phase 0：PASS
> - Phase 1：PASS
> - Phase 2：PASS
> - Phase 2.1：PASS
> - Phase 3：GO
> - Phase 4/5：HOLD
>
> 当前已经完成：
>
> ```text
> 自然语言
> → Canonical Semantic Contract
> → lifecycle status
> ```
>
> 并且只有：
>
> ```text
> status=RESOLVED
> ```
>
> 才有资格进入 Query Draft assembly。
>
> **本轮只实施 Phase 3：Canonical Query Contract + Legacy Metric Input Adapter。**
>
> 完成后立即停止，不进入 Phase 4。
>
> 本轮的核心问题只有一个：
>
> > **Semantic Contract 已经知道用户想查什么以后，GAIOP 内部唯一合法的 ResolvedQuery 到底长什么样？旧 `metric` 输入如何安全迁移到该结构？**

---

# 0. Phase 3 最终目标

本轮要正式结束下面这种状态：

```text
metric
metrics[]
topMetric
```

在不同模块里被当成三个同级、可自由填写、相互兜底的事实来源。

最终收口为：

```text
Semantic Contract
  requestedMetrics[]
  rankingMetric
        ↓
Resolver
        ↓
Canonical ResolvedQuery

metrics: string[]
topMetric: string   // only topValues
```

并明确：

```text
metric
= legacy compatibility input only
= 非 canonical field
= 非 NAPM API field
= 不得作为独立事实来源
```

---

# 1. Phase 3 的核心原则

## 1.1 Canonical Execution Fields

正式定义：

```text
metrics: string[]
```

含义：

```text
GAIOP 内部请求返回的指标数组
↓
后续 Serializer 序列化
↓
NAPM HTTP:
metrics=TPI,TPO
```

正式定义：

```text
topMetric: string
```

含义：

```text
仅 topValues 使用
独立的 Top 排序指标
↓
NAPM HTTP:
topMetric=TPIO
```

正式定义：

```text
metric
```

含义：

```text
旧调用方兼容字段
不是 canonical query field
不是 NAPM API 参数
禁止调用方在新 canonical path 独立指定
```

---

## 1.2 不允许以下关系成为 Contract

禁止：

```text
metric = metrics[0] = topMetric
```

禁止：

```text
topMetric 必须 ∈ metrics[]
```

禁止：

```text
metrics[0]
自动成为 primaryMetric
```

禁止：

```text
topMetric 缺失
→ Kernel 用 metric 猜
```

最后一项 Kernel fallback 可以在后续 Kernel 阶段物理删除，但：

> Phase 3 之后的 canonical path 不得再依赖该 fallback 才能工作。

---

# 2. 开始前记录 Git 基线

执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --check
```

报告必须区分：

```text
pre-existing
Phase 0
Phase 1
Phase 2
Phase 2.1
Phase 3
```

禁止：

```text
reset
stash
自动提交
覆盖已有修改
```

---

# 3. 先审计全部 `metric / metrics / topMetric` 消费者

修改前执行类似：

```bash
rg "\.metric\b|metrics\b|topMetric\b|top_metric_not_in_metrics|Metric is required"   skills/openclaw-napm-query   napm-openclaw-plugin.remote.js
```

并逐项分类：

```markdown
| 文件/函数 | 当前读取字段 | 当前职责 | Phase 3 分类 |
|---|---|---|---|
| Resolver | metric/metrics/topMetric | Query 构造 | 本轮迁移 |
| QueryValidator | metric | shape validation | 本轮迁移 |
| Plugin validation | metrics/topMetric | Tool shape validation | 本轮迁移 |
| QueryMetadataConstraint | metric/metrics | repair/constraint | 本轮只去除错误 canonical 派生 |
| MetricExecutionKernel | topMetric || metric | execution fallback | 后续删除；本轮 canonical path 不依赖 |
| ... | ... | ... | ... |
```

Phase 3 开始前必须先明确：

```text
哪些 `query.metric` 读取属于 Contract 迁移
哪些属于 Phase 4 compatibility/gate
哪些属于 Kernel/Serializer 后续清理
```

不要看到 `metric` 就一口气全删。

---

# 4. 建立正式 Canonical ResolvedQuery Contract

建议新增共享定义，例如：

```text
ResolvedQueryContract
```

具体命名按项目风格。

它只能定义：

```text
schema
required fields
optional fields
forbidden fields
derived/legacy fields
shape normalization
```

它不是：

```text
Object × Metric Validator
Runtime Capability Validator
Repair Engine
Natural Language Parser
```

---

# 5. Canonical ResolvedQuery 必须带 schemaVersion

建议：

```text
napm-resolved-query.v1
```

例如：

```json
{
  "schemaVersion": "napm-resolved-query.v1",
  "service": "topValues",
  "groups": [
    {
      "type": "WebApplication"
    }
  ],
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "topCount": 5,
  "start": 0,
  "end": 0
}
```

实际时间值按现有项目合法 contract。

未知 schemaVersion：

```text
RESOLVED_QUERY_SCHEMA_UNSUPPORTED
```

fail closed。

---

# 6. `queryModeKey` 的定位也要明确

如果当前代码仍需要：

```text
queryModeKey
```

Phase 3 要明确：

```text
service
= canonical execution operation

queryModeKey
= transitional / derived routing field
```

不能让：

```text
service=topValues
queryModeKey=timeseries
```

这种冲突成为两个 truth source。

建议：

```text
queryModeKey 只能从 service/semantic operation 派生
调用方不得独立覆盖
```

如果当前历史兼容暂时无法删除：

```text
保持字段
但 canonicalizer 必须校验一致性
```

不要新造第三套 service truth。

---

# 7. Service Contract：`topValues`

Canonical required：

```text
schemaVersion
service="topValues"
groups[]
metrics[] 非空
topMetric 非空
topCount 合法
start/end（按当前 NAPM contract）
```

允许：

```text
metrics[] 中有多个指标
topMetric 不在 metrics[] 中
```

例如必须合法：

```json
{
  "service": "topValues",
  "metrics": ["TPI", "TPO"],
  "topMetric": "TPIO",
  "topCount": 10
}
```

以及：

```json
{
  "service": "topValues",
  "groups": [
    {"type": "WebApplication"}
  ],
  "metrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ],
  "topMetric": "PGTME",
  "topCount": 5
}
```

Canonical forbidden：

```text
metric
granularity（除非现有正式 topValues contract 明确允许）
```

---

# 8. Service Contract：`averageValues`

Canonical required：

```text
schemaVersion
service="averageValues"
groups[]
metrics[] 非空
start/end
```

Canonical forbidden：

```text
topMetric
topCount
metric
```

允许多指标：

```json
{
  "service": "averageValues",
  "metrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ]
}
```

不要求：

```text
primaryMetric
```

---

# 9. Service Contract：`timeValues`

Canonical required：

```text
schemaVersion
service="timeValues"
groups[]
metrics[] 非空
granularity
start/end
```

Canonical forbidden：

```text
topMetric
topCount
metric
```

允许：

```text
primary semantic metric 不存在
```

只要：

```text
requestedMetrics[]
```

完整。

---

# 10. `pageViews` 单独保持 Detail Contract

Phase 3 可以把已有 `pageViews` shape 纳入：

```text
Canonical ResolvedQuery Contract registry
```

但不得顺手修 BUG-B。

原则：

```text
pageViews
≠ topValues/averageValues/timeValues metric service
```

如果当前 pageViews 正式 contract 不使用：

```text
metrics
topMetric
metric
```

则标：

```text
forbidden
```

依据只能是：

```text
当前 pageViews 实现 / 已有真实 contract
```

不要为了统一 Metric Query 强行改 pageViews。

---

# 11. Metadata service 本轮不要大重构

当前 metadata overload：

```text
service=metrics
+ groups presence
→ metrics / metricsForGroup
```

属于后续 Metadata Contract 阶段。

Phase 3：

```text
可以记录 / schema 标记 legacy
```

但不要在本轮拆：

```text
metricCatalog
metricCapability
groupCatalog
```

默认：

> 本轮聚焦 Metric Query Contract + legacy metric，不扩大到 Metadata provider 重构。

---

# 12. Semantic → Canonical Query 的唯一映射

Phase 2.1 已保证：

```text
只有 status=RESOLVED
```

才进入 Resolver assembly。

Phase 3 后 Resolver 对 metric query 的映射必须固定。

## rank_top

Semantic：

```text
requestedMetrics[]
rankingMetric
topCount
```

映射：

```text
requestedMetrics[] → metrics[]
rankingMetric      → topMetric
topCount           → topCount
```

禁止：

```text
primaryMetric → topMetric
```

作为默认 truth。

只有：

```text
rankingMetric
```

是排行依据。

## average

```text
requestedMetrics[]
→ metrics[]
```

不生成：

```text
topMetric
metric
```

## timeseries

```text
requestedMetrics[]
→ metrics[]
```

并使用统一：

```text
timeIntent
→ start/end
granularity
```

不生成：

```text
topMetric
metric
```

---

# 13. Resolver 不再输出 canonical `metric`

Phase 2 报告中：

```text
Resolver 仍输出含 legacy metric 的过渡 shape
```

Phase 3 要结束这一点。

正常新路径：

```text
Semantic Contract
→ Resolver
→ Canonical ResolvedQuery
```

输出中：

```text
不得出现 metric
```

优先：

```text
canonical query object 完全不含 metric
```

---

# 14. 新增 `LegacyMetricInputAdapter`

建议新增：

```text
LegacyMetricInputAdapter
```

职责唯一：

```text
旧外部输入
→ canonical fields
```

它：

```text
不解析自然语言
不判断对象兼容
不调用 metadata
不 repair 业务语义
```

只负责：

```text
legacy shape migration
```

---

# 15. Adapter 只能运行在 Legacy Boundary

正常新链：

```text
Semantic Contract
→ Resolver
→ Canonical ResolvedQuery
```

必须：

```text
LegacyMetricInputAdapter calls = 0
```

旧调用：

```text
legacy queryDraft
→ LegacyMetricInputAdapter
→ Canonical ResolvedQuery
```

必须：

```text
Adapter exactly once
```

禁止：

```text
Resolver 后再 Adapter
prepare 再 Adapter
direct 又 Adapter
```

重复迁移。

---

# 16. Legacy `metric` 决策表必须固定

## 16.1 topValues：legacy-only

输入：

```json
{
  "service": "topValues",
  "metric": "PGTME"
}
```

在其余必要字段存在的前提下，Adapter 可以：

```text
metrics=[PGTME]
topMetric=PGTME
```

并：

```text
删除 metric
记录 LEGACY_METRIC_DEPRECATED
```

## 16.2 topValues：完整 canonical + 同值 legacy

输入：

```json
{
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "metric": "PGTME"
}
```

处理：

```text
canonical 字段保持
metric 删除
deprecation warning
不 reject
```

## 16.3 topValues：完整 canonical + 冲突 legacy

输入：

```json
{
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "metric": "TRTI"
}
```

处理：

```text
LEGACY_METRIC_CONFLICT
→ reject
→ 不允许 metric 覆盖 canonical
```

---

# 17. topValues Partial Canonical 决策

## 17.1 有 metrics[]，缺 topMetric，有 legacy metric

例如：

```json
{
  "metrics": ["TPI", "TPO"],
  "metric": "TPIO"
}
```

允许 Adapter：

```text
topMetric=TPIO
metrics 保持 [TPI,TPO]
删除 metric
warning
```

## 17.2 有 topMetric，缺 metrics[]，有 legacy metric

如果：

```text
topMetric == metric
```

可以：

```text
metrics=[metric]
```

作为 legacy migration。

如果：

```text
topMetric != metric
```

不能猜用户希望返回哪个指标集合。

返回：

```text
LEGACY_METRIC_PARTIAL_CONFLICT
```

## 17.3 只有 metrics[]，没有 topMetric，也没有 metric

应由 Canonical Contract：

```text
TOP_METRIC_REQUIRED
```

拒绝。

## 17.4 只有 topMetric，没有 metrics[] / metric

应：

```text
METRICS_REQUIRED
```

拒绝。

---

# 18. average/time Legacy 决策

## 18.1 legacy-only

输入：

```json
{
  "service": "timeValues",
  "metric": "PGTME"
}
```

允许迁移：

```text
metrics=[PGTME]
删除 metric
warning
```

同理：

```text
averageValues
```

## 18.2 canonical metrics[] + legacy metric

如果：

```text
metric ∈ metrics[]
```

则：

```text
canonical metrics[] 保持
删除 metric
deprecation warning
```

不把：

```text
metric
```

提升成 primary truth。

## 18.3 canonical metrics[] + legacy metric 不在集合

例如：

```json
{
  "service": "timeValues",
  "metrics": ["PGNPGE", "PGTME"],
  "metric": "TRTI"
}
```

处理：

```text
LEGACY_METRIC_CONFLICT
→ reject
```

---

# 19. pageViews / 非 Metric Service 的 legacy metric

如果 service contract 不接受 metric：

```text
legacy metric
```

不得自动迁移。

返回：

```text
LEGACY_METRIC_NOT_ALLOWED_FOR_SERVICE
```

不要为了兼容把 pageViews 变成 Metric Query。

---

# 20. Adapter 输出必须是 Canonical Query

Adapter 成功后：

```text
metric
```

必须消失。

最终输出必须再次经过：

```text
Canonical ResolvedQuery Contract shape validation
```

流程：

```text
legacy input
↓
LegacyMetricInputAdapter
↓
canonical candidate
↓
ResolvedQueryContract validation
↓
canonical output
```

Adapter 不直接赋予“可执行”权限。

---

# 21. Adapter 不做 Object × Metric 校验

例如：

```json
{
  "service": "topValues",
  "metric": "TRTI",
  "groups": [
    {"type": "WebApplication"}
  ]
}
```

Adapter 可以做 shape migration：

```text
metrics=[TRTI]
topMetric=TRTI
```

但：

```text
WebApplication + TRTI 是否允许
```

属于 Phase 4 Shared Validator。

本轮不要提前：

```text
VALIDATION_FAILURE
0 southbound
```

---

# 22. `QueryValidator` 改成 Canonical Contract

当前已知错误：

```text
topValues
→ 要求 target.metric
```

Phase 3 必须改成：

```text
topValues:
metrics[] required
topMetric required
topCount valid
```

average/time：

```text
metrics[] required
```

timeValues：

```text
granularity required
```

不再要求：

```text
metric
```

QueryValidator 不判断：

```text
Object × Metric compatibility
```

只做：

```text
shape / service contract
```

---

# 23. Plugin `topMetric ∈ metrics[]` 错误约束必须删除

当前：

```text
if (topMetric && !metrics.includes(topMetric))
→ top_metric_not_in_metrics
```

Phase 3 必须删除该规则。

改成分别校验 shape：

```text
metrics[] 非空
topMetric 存在
```

但：

```text
不检查包含关系
```

必须新增正式 contract test：

```text
metrics=[TPI,TPO]
topMetric=TPIO
→ PASS
```

---

# 24. QueryMetadataConstraint 不再从 `metrics[0]` 生成 canonical `metric`

当前历史逻辑：

```text
metric = metrics[0]
```

Phase 3 必须停止把它当 canonical normalization。

要求：

```text
canonical query 中不存在 metric
```

正常 canonical path：

```text
不得生成 metric
```

---

# 25. 不允许 QueryMetadataConstraint“同步三字段”

禁止新增：

```text
metrics=[PGTME]
topMetric=PGTME
metric=PGTME
```

这种所谓“统一”。

正确逻辑：

```text
metrics[]
topMetric
```

各自独立。

如果后续需要 object-metric compatibility：

```text
分别校验
```

Phase 4 做。

---

# 26. MetricExecutionKernel 本轮的边界

当前：

```text
params.topMetric = queryRequest.topMetric || queryRequest.metric
```

Phase 3 不一定要物理删除该 fallback。

但必须新增测试证明：

```text
新 canonical topValues path
始终有 topMetric
```

因此：

```text
canonical path 不依赖 metric fallback
```

如果删除 fallback 会影响未知旧入口：

```text
本轮可以保留
```

并标：

```text
legacy fallback / later removal
```

后续 Kernel/Serializer 阶段物理删除。

---

# 27. Semantic Lifecycle enum 所有权顺手收口

Phase 2.1 当前：

```text
RESOLVED
AMBIGUOUS
UNRESOLVED
UNSUPPORTED
```

只在 `WorkflowClassifierService` 定义一次。

Phase 3 建立正式 Contract module 时，可以把该 enum：

```text
移动
```

到共享 Semantic Contract constants/schema。

要求：

```text
只移动所有权
不定义第二份
不改变 lifecycle 行为
```

WorkflowClassifier / Resolver / tests：

```text
统一 import
```

---

# 28. `timeIntent` → Query 时间字段

Phase 2.1 Review 留下一个注意点：

```text
Semantic RESOLVED
不能导致最终 Query 缺 start/end
```

Phase 3 Resolver 在生成 canonical metric query 时：

```text
timeIntent
→ 当前统一时间服务
→ start/end
```

必须保证：

```text
topValues
averageValues
timeValues
```

需要时间范围时 canonical query 具备合法时间字段。

但：

```text
不要在本轮重写时间解析器
```

只消费 Phase 2 已统一的时间结果。

---

# 29. `RESOLVED` 不等于 Query Contract Valid

继续保持：

```text
Semantic status=RESOLVED
```

只表示：

```text
用户意图完整唯一
```

Resolver 组装 canonical candidate 后仍可能因：

```text
missing field
unsupported service shape
invalid topCount
invalid granularity
```

得到：

```text
QUERY_CONTRACT_INVALID
```

这是正常。

不要为了让所有 RESOLVED 都能生成 Query 而补默认字段。

---

# 30. Query Contract Error Codes

本轮至少统一 shape-level reasonCode，例如：

```text
RESOLVED_QUERY_SCHEMA_UNSUPPORTED
SERVICE_UNSUPPORTED

GROUPS_REQUIRED
METRICS_REQUIRED
TOP_METRIC_REQUIRED
TOP_COUNT_INVALID
GRANULARITY_REQUIRED

TOP_METRIC_FORBIDDEN
TOP_COUNT_FORBIDDEN
GRANULARITY_FORBIDDEN

LEGACY_METRIC_DEPRECATED
LEGACY_METRIC_CONFLICT
LEGACY_METRIC_PARTIAL_CONFLICT
LEGACY_METRIC_NOT_ALLOWED_FOR_SERVICE
```

具体命名按项目现有风格，但：

```text
同一种 contract failure 只能有一个 canonical reasonCode
```

不要 Plugin 一套字符串、QueryValidator 另一套字符串。

---

# 31. Canonical Contract 应成为 shape validation 的唯一规则源

Phase 3 后：

```text
Resolver
Plugin
QueryValidator
Legacy Adapter
```

不能各自手写：

```text
topValues 需要什么字段
```

建议：

```text
ResolvedQueryContract
```

提供：

```text
getServiceContract(service)
validateShape(query)
normalizeCanonicalShape(query)
```

Plugin / QueryValidator：

```text
调用共享 contract
```

而不是复制 required/forbidden fields。

---

# 32. Phase 3 不做 Metric ID existence hard gate

虽然 Phase 1 已有 canonical Metric Catalog，

但：

```text
METRIC_UNKNOWN
→ 0 southbound
```

属于 Phase 4 Shared Validator。

Phase 3 Contract shape 可以检查：

```text
metrics 是 string[]
topMetric 是 string
```

不要在本轮提前做 execution gate。

---

# 33. Phase 3 不做 Object × Metric compatibility

禁止本轮修改：

```text
WebApplication + TRTI
→ Policy EXECUTE_QUERY
```

该人工结构化错误 Query 到 Phase 3 结束时仍可能放行。

真正：

```text
KNOWN_INCOMPATIBLE
→ VALIDATION_FAILURE
→ 0 southbound
```

是 Phase 4。

---

# 34. Phase 3 不做 Runtime Metadata

不要新增：

```text
RuntimeMetricCapabilityService
metricsForGroup orchestration
UNKNOWN runtime confirmation
```

Phase 5。

---

# 35. Phase 3 不做 Serializer 重构

本轮只定义：

```text
GAIOP Canonical ResolvedQuery
```

不要新增正式：

```text
NapmMetricQuerySerializer
```

默认 Serializer/Kernel 参数收口放后续阶段。

---

# 36. Phase 3 允许修改的文件

预计：

```text
NapmResolvedQueryResolverService.js
QueryValidator.js

QueryMetadataConstraintService.js
（只处理 canonical shape / 不再 metrics[0]→metric）

napm-openclaw-plugin.remote.js
（移除 topMetric-in-metrics 错误 contract，接共享 shape contract）

新增：
ResolvedQueryContract.js
LegacyMetricInputAdapter.js

Semantic Contract constants/schema
（仅迁移 lifecycle enum 所有权）

相关 tests
runtime-contract
docs / memory
```

如 RequirementParser 只需接 canonical shape normalization：

```text
允许最小修改
```

但不能接执行 hard gate。

---

# 37. Phase 3 禁止修改

不要：

```text
接 ownership tri-state 到 QueryDecisionPolicy
新增 Shared Executable Validator
实现 METRIC_UNKNOWN execution gate
实现 WebApplication+TRTI 0 southbound
修改 metadata 调用顺序
新增 RuntimeMetricCapabilityService
拆 metadata overload
实现 AtomicQueryRepair
新增正式 Serializer
删除所有 Kernel fallback
重构 Error Contract
处理 BUG-B
连接远端
部署
提交 commit
```

---

# 38. Phase 3 核心测试矩阵

## A. Canonical topValues

```text
metrics=[TPI,TPO]
topMetric=TPIO
→ PASS
```

```text
metrics=[PGNPGE,PGTME,PGHTTP500]
topMetric=PGTME
→ PASS
```

```text
topMetric 不在 metrics[]
→ 仍 PASS
```

## B. topValues 缺字段

```text
metrics missing
→ METRICS_REQUIRED
```

```text
topMetric missing
→ TOP_METRIC_REQUIRED
```

```text
topCount invalid
→ TOP_COUNT_INVALID
```

## C. averageValues

```text
metrics 多指标
→ PASS
```

```text
topMetric present
→ forbidden
```

## D. timeValues

```text
metrics 多指标 + granularity
→ PASS
```

```text
topMetric present
→ forbidden
```

```text
granularity missing
→ GRANULARITY_REQUIRED
```

---

# 39. Legacy Adapter 测试

## topValues legacy-only

```text
metric=PGTME
→ metrics=[PGTME]
→ topMetric=PGTME
→ metric removed
```

## topValues canonical + same metric

```text
metrics=[PGTME]
topMetric=PGTME
metric=PGTME
→ canonical pass
→ warning
→ metric removed
```

## topValues canonical + conflict

```text
metrics=[PGTME]
topMetric=PGTME
metric=TRTI
→ LEGACY_METRIC_CONFLICT
```

## partial

```text
metrics=[TPI,TPO]
metric=TPIO
→ topMetric=TPIO
→ PASS
```

```text
topMetric=TPIO
metric=TPIO
metrics missing
→ metrics=[TPIO]
→ PASS
```

```text
topMetric=TPIO
metric=TPI
metrics missing
→ LEGACY_METRIC_PARTIAL_CONFLICT
```

---

# 40. average/time Adapter 测试

```text
metric=PGTME
→ metrics=[PGTME]
```

```text
metrics=[PGNPGE,PGTME]
metric=PGTME
→ warning
→ metric removed
```

```text
metrics=[PGNPGE,PGTME]
metric=TRTI
→ LEGACY_METRIC_CONFLICT
```

---

# 41. Canonical Path / Legacy Path 调用次数

必须测试：

```text
新 Semantic path
→ LegacyMetricInputAdapter calls = 0
```

```text
legacy external input
→ LegacyMetricInputAdapter calls = 1
```

```text
prepare/direct
→ 不重复调用 Adapter
```

---

# 42. Resolver 映射测试

核心问句：

```text
最近业务访问较慢的前5个业务都有谁？
```

Phase 3 Resolver canonical output：

```json
{
  "schemaVersion": "napm-resolved-query.v1",
  "service": "topValues",
  "groups": [
    {"type": "WebApplication"}
  ],
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "topCount": 5
}
```

必须：

```text
metric absent
```

## 多指标排行

Semantic：

```text
requestedMetrics=[TPI,TPO]
rankingMetric=TPIO
```

Resolver：

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

## 多指标趋势

```text
requestedMetrics=[PGNPGE,PGTME,PGHTTP500]
```

Resolver：

```text
service=timeValues
metrics=[PGNPGE,PGTME,PGHTTP500]
metric absent
topMetric absent
```

---

# 43. Phase 2.1 生命周期非回归

必须继续：

```text
AMBIGUOUS
→ no Query Draft

UNRESOLVED
→ no Query Draft

UNSUPPORTED
→ no Query Draft

RESOLVED
→ only then canonical assembly
```

不要让 Legacy Adapter 绕过 Semantic status。

Legacy external query 本身不是自然语言 Semantic path，可以走 Legacy Adapter；

但：

```text
raw prompt
```

不得绕 Semantic Lifecycle 直接构造 Query。

---

# 44. Runtime Contract 新规则

`verify:runtime-contract` 至少增加：

```text
Canonical ResolvedQuery schema 只有一个 source
topValues contract 不要求 topMetric ∈ metrics[]
canonical query 不允许 metric
QueryValidator 不要求 metric
Resolver canonical output 不含 metric
生产新 Semantic path 不调用 LegacyMetricInputAdapter
Legacy Adapter 输出不得含 metric
QueryMetadataConstraint 不允许 metrics[0]→metric canonical derivation
Plugin 不允许恢复 topMetric-in-metrics constraint
service required/forbidden fields 只能来自 shared ResolvedQueryContract
```

以及 Phase 0/1/2/2.1 原 contract 全部继续 PASS。

---

# 45. Phase 3 有意改变的历史行为

以下 Phase 0 characterization 将被本轮有意改变：

```text
Plugin topMetric-in-metrics
→ 删除错误限制

QueryValidator topValues requires metric
→ 改为 metrics[] + topMetric

Resolver output includes metric
→ canonical path 删除

QueryMetadataConstraint metrics[0]→metric
→ canonical path 删除
```

这些测试应迁移为：

```text
Phase 3 formal contract tests
```

---

# 46. Phase 3 不应改变的历史行为

仍必须保持：

```text
Policy WebApplication + TRTI
→ 仍可能 EXECUTE_QUERY

Gateway invalid object/metric
→ 仍可能 metadata + data

Direct
→ 仍无 Shared Validator hard gate

ownership tri-state
→ 仍未接 Policy

metadata overload
→ 仍存在

Kernel legacy fallback
→ 如本轮未删除则继续标 legacy

Error message "empty/no data"
→ 仍保持旧分类

BUG-B
→ 未修改
```

如果这些变化：

```text
必须解释是否越界
```

---

# 47. 完成后必须运行

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
Phase 3 contract/adapter
```

---

# 48. Phase 3 输出格式

完成后立即停止，不进入 Phase 4。

## 48.1 Git

```text
branch:
HEAD:
Phase 3 start status:
Phase 3 end status:
Phase 3 files:
```

## 48.2 Canonical Query Contract

按 service 输出：

```markdown
| service | required | optional | forbidden | legacy |
|---|---|---|---|---|
| topValues | ... | ... | ... | metric |
| averageValues | ... | ... | ... | metric |
| timeValues | ... | ... | ... | metric |
| pageViews | ... | ... | ... | ... |
```

## 48.3 Canonical Field Definition

明确：

```text
metrics[]
topMetric
metric
queryModeKey
schemaVersion
```

每个：

```text
authoritative?
derived?
legacy?
sent to NAPM later?
```

## 48.4 Legacy Adapter Decision Table

完整输出：

```markdown
| service | input shape | output | warning | reject reason |
|---|---|---|---|---|
| topValues | metric only | ... | ... | ... |
| topValues | canonical + same metric | ... | ... | ... |
| topValues | canonical + conflicting metric | ... | ... | ... |
| ... | ... | ... | ... | ... |
```

## 48.5 Core Query Results

至少：

```text
慢业务 Top5
多指标 Top:
  metrics=[TPI,TPO]
  topMetric=TPIO

多指标 timeValues
```

确认：

```text
canonical output metric absent
```

## 48.6 Adapter Invocation Counts

```text
new semantic path:
LegacyMetricInputAdapter = 0

legacy path:
LegacyMetricInputAdapter = 1

prepare/direct:
duplicate adapter calls = 0
```

## 48.7 QueryValidator / Plugin Result

确认：

```text
QueryValidator requires metric:
YES / NO

Plugin requires topMetric ∈ metrics[]:
YES / NO
```

目标：

```text
NO
NO
```

## 48.8 Runtime Contract

逐条：

```text
single ResolvedQuery contract source
canonical metric forbidden
topMetric independent from metrics[]
no Resolver metric output
no metrics[0]→metric canonical derivation
adapter exactly-once boundary
```

PASS / FAIL。

## 48.9 Later-phase Non-Regression

```text
Policy hard gate unchanged
Gateway unchanged
Direct unchanged
Ownership tri-state not wired
Metadata unchanged
Kernel fallback status
Error classifier unchanged
BUG-B unchanged
```

## 48.10 Tests

```text
Phase 0:
Phase 1:
Phase 2:
Phase 2.1:
Phase 3:
full repo:
lint:
runtime-contract:
diff-check:
```

## 48.11 Remote / Commit

```text
Remote NAPM: NO
Deploy: NO
Commit: NO
Phase 4 started: NO
```

## 48.12 Phase 3 Completion

```text
YES / NO
```

---

# 49. Phase 3 完成定义

只有全部满足才算完成：

```text
1. Canonical ResolvedQuery schema 唯一
2. topValues 正式使用 metrics[] + topMetric
3. topMetric 不要求属于 metrics[]
4. average/time 正式只使用 metrics[]
5. canonical query 不包含 metric
6. metric 只存在于 legacy input boundary
7. LegacyMetricInputAdapter 已建立
8. new semantic path Adapter=0
9. legacy path Adapter=1
10. legacy conflict 有稳定 fail-closed decision
11. Resolver 从 requestedMetrics/rankingMetric 生成 canonical fields
12. QueryValidator 不再要求 metric
13. Plugin 删除 topMetric-in-metrics 错误约束
14. QueryMetadataConstraint 不再把 metrics[0] 生成 canonical metric
15. primaryMetric 不被 metrics[0] 隐式制造
16. Semantic lifecycle Phase 2.1 全部保持
17. 不接 Object×Metric hard gate
18. 不实现 0 southbound
19. 不进入 Runtime Metadata / Serializer / Error Contract
20. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 50. 最终提醒

Phase 3 的问题不是：

```text
这个 Query 能不能执行？
```

而是：

> **这个 Query 的 canonical shape 到底是什么？**

执行准入仍然留给：

```text
Phase 4：Shared Executable Validator
Phase 5：Runtime Capability / Metadata
```

本轮完成后立即停止，等待 Phase 3 Review。
