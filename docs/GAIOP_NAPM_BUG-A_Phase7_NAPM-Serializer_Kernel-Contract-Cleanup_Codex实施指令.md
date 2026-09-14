# GAIOP NAPM BUG-A 实施指令 — Phase 7：NAPM Serializer + MetricExecutionKernel Contract Cleanup

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
> - Phase 6：PASS
> - Phase 7：GO
>
> 当前主链已经闭环：
>
> ```text
> Natural Language
> → Canonical Semantic Contract
> → Semantic Lifecycle
> → Canonical ResolvedQuery
> → Atomic Safe Repair
> → ResolvedQueryContract
> → Static Validator
> → Runtime Capability（仅 UNKNOWN）
> → Final Admission
> → MetricExecutionKernel
> → NapmClient
> ```
>
> Phase 6 已经保证：
>
> ```text
> Query 在进入最终执行前，
> 语义、Query shape、静态兼容、运行时能力、Repair 都已完成。
> ```
>
> **本轮只实施 Phase 7：Canonical Query → NAPM Transport Serializer + Kernel Contract Cleanup。**
>
> 核心原则：
>
> > **执行层只能“序列化并发送”上游已经确定的 Canonical Query，不能再次解释、猜测、修复或补全业务语义。**
>
> 完成后立即停止，不进入 Global Error Contract、全量 Legacy Cleanup、BUG-B 或真实部署阶段。

---

# 0. Phase 7 要解决的历史技术债

当前项目仍可能存在执行层历史 fallback / 隐式推导，例如：

```text
MetricExecutionKernel:
topMetric = queryRequest.topMetric || queryRequest.metric
```

以及潜在的：

```text
metrics[0] 代表主指标
metric 兜底 metrics[]
通过字段存在性猜 service
Kernel 再补 group 参数
Client 层重新转换业务字段
queryModeKey 重新决定 service
```

这些逻辑在 Phase 0–6 之前曾用于容错，但现在已经会形成第二套执行真相源。

Phase 7 要彻底解决：

> **NAPM transport 层不再拥有业务决策权。**

---

# 1. Phase 7 最终目标

最终执行链必须收口为：

```text
Canonical ResolvedQuery
        ↓
NapmQuerySerializer
        ↓
NAPM Request DTO / Params
        ↓
MetricExecutionKernel
        ↓
NapmClient
        ↓
HTTP
```

其中 `NapmQuerySerializer` 只负责：

```text
canonical field
→ official NAPM request field
```

它不负责：

```text
语义解析
repair
metric selection
object selection
static validation
runtime capability
fallback
```

---

# 2. Phase 7 的四个核心不变量

必须固定：

```text
1. Canonical Query 中没有 `metric`
2. Kernel 不读取 `metric`
3. Serializer 不读取 `metric`
4. NapmClient data request 不接收 `metric`
```

并且：

```text
metrics[]
→ 唯一序列化为 NAPM `metrics`

topMetric
→ 唯一序列化为 NAPM `topMetric`
```

禁止恢复：

```text
metric → metrics
metric → topMetric
metrics[0] → topMetric
topMetric → metrics[]
```

---

# 3. 开始前记录 Git 基线

执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --check
```

报告区分：

```text
pre-existing
Phase 0
Phase 1
Phase 2
Phase 2.1
Phase 3
Phase 4
Phase 4.1
Phase 5
Phase 6
Phase 7
```

禁止：

```text
reset
stash
自动 commit
覆盖已有修改
```

---

# 4. 修改前先做 Execution Consumer Audit

必须搜索：

```bash
rg "\bmetric\b|metrics\b|topMetric\b|queryModeKey\b|service\b|groupType|groupArgument|granularity|topCount"   skills/openclaw-napm-query/services   skills/openclaw-napm-query/src   skills/openclaw-napm-query/scripts   napm-openclaw-plugin.remote.js
```

重点审计：

```text
MetricExecutionKernel
NapmClient
RequirementParserService
ResolvedQueryExecutionAdmissionService
QueryMetadataConstraintService
run_napm_query.js
Report/Data helper
Overview child execution
任何 serializer / request builder
```

输出：

```markdown
| Consumer | Reads canonical query | Re-derives fields? | Sends NAPM params? | P7 action |
|---|---:|---:|---:|---|
| MetricExecutionKernel | ... | ... | ... | ... |
| NapmClient | ... | ... | ... | ... |
| ... | ... | ... | ... | ... |
```

---

# 5. 新增唯一 `NapmQuerySerializer`

建议新增：

```text
services/NapmQuerySerializer.js
```

或仓库风格下等价名称。

它是：

```text
Canonical Query
→ NAPM transport params
```

的唯一正式入口。

---

# 6. Serializer 输入

只接受：

```text
napm-resolved-query.v1
```

并且只在：

```text
Final Admission = ALLOW
```

之后调用。

Serializer 本身不拥有 admission 权。

不接受：

```text
raw prompt
Semantic Contract
legacy metric
unresolved candidate
```

---

# 7. Serializer 必须 pure / deterministic

Serializer：

```text
不调用 NapmClient
不调用 metadata
不调用 metricsForGroup
不调用 LLM
不调用 repair
不解析自然语言
不查询 Metric Catalog
不查询 ownership
```

同一输入：

```text
必须产生同一 transport output
```

---

# 8. Serializer 不允许修改输入

禁止：

```javascript
query.metrics = query.metrics.join(',');
delete query.schemaVersion;
```

正确：

```text
构造新的 params object
```

测试：

```text
before serialize
after serialize
deepEqual = true
```

---

# 9. Transport DTO 只能使用 allowlist

以下内部字段绝不能发到 NAPM：

```text
schemaVersion
queryModeKey
repairApplied
repairAudit
beforeFingerprint
afterFingerprint
staticValidation
runtimeCapability
finalAdmission
preparedProof
semantic source
confidence
reasonCode
issues
warnings
legacy markers
```

禁止：

```javascript
const params = {...query};
```

然后再 delete 若干字段。

必须显式构造 transport DTO。

---

# 10. `metrics[]` 的唯一序列化位置

Canonical：

```json
{
  "metrics": ["TPI", "TPO"]
}
```

Transport：

```text
metrics=TPI,TPO
```

要求：

```text
保持顺序
不排序
不补值
不删值
不重新去重
```

`join(',')` 只允许发生在 Serializer。

---

# 11. `topMetric` 独立序列化

Canonical：

```json
{
  "metrics": ["TPI", "TPO"],
  "topMetric": "TPIO"
}
```

Transport：

```text
metrics=TPI,TPO
topMetric=TPIO
```

不得要求：

```text
topMetric ∈ metrics[]
```

Serializer 只做 transport mapping，不做此类业务约束。

---

# 12. 正式删除 Kernel 的 legacy `metric` fallback

当前已知历史逻辑类似：

```javascript
params.topMetric = queryRequest.topMetric || queryRequest.metric;
```

Phase 7 后：

```text
Kernel 不得读取 queryRequest.metric
```

更推荐：

```text
Kernel 不直接拼 topMetric
Kernel 调 NapmQuerySerializer
```

---

# 13. Kernel 中 `query.metric` 必须从 data path 消失

执行：

```bash
rg "queryRequest\.metric|request\.metric|query\.metric"   skills/openclaw-napm-query
```

生产 data execution path 目标：

```text
0
```

允许保留位置：

```text
LegacyMetricInputAdapter
legacy tests
migration docs
```

---

# 14. Kernel 不得从 `metrics[0]` 推导业务字段

禁止：

```text
topMetric = metrics[0]
primaryMetric = metrics[0]
metric = metrics[0]
```

Kernel 不再拥有“主指标”概念。

---

# 15. Kernel 不得根据字段猜 service

禁止：

```text
if topMetric exists → topValues
if granularity exists → timeValues
```

执行服务唯一事实：

```text
query.service
```

Kernel 只能按 canonical `service` dispatch。

---

# 16. `queryModeKey` 不得成为执行 routing truth

Phase 3 已定义：

```text
service = canonical truth
queryModeKey = derived/transitional
```

Phase 7：

```text
Kernel 不再按 queryModeKey 选择执行服务
```

如果 queryModeKey 暂时保留给 UI / trace：

```text
可以保留
但不参与 data routing
```

---

# 17. `queryModeKey` 不得发送到 NAPM

Serializer output：

```text
不得包含 queryModeKey
```

---

# 18. Service-specific Serializer 只定义 mapping，不复制 Contract

可使用：

```text
service handler registry
```

例如：

```text
topValues
averageValues
timeValues
pageViews
```

但不要再定义一套：

```text
required fields
forbidden fields
semantic validity
```

这些继续由：

```text
ResolvedQueryContract
```

唯一负责。

---

# 19. `topValues` Serializer

Canonical 输入：

```text
service=topValues
groups[]
metrics[]
topMetric
topCount
start
end
```

输出 NAPM transport：

```text
numGroups
groupType1...
groupArgument1...
metrics
topMetric
topCount
start
end
```

以及当前接口明确要求的其他 transport-only 参数。

禁止发送：

```text
metric
queryModeKey
repair metadata
admission metadata
```

---

# 20. `averageValues` Serializer

Canonical 输入：

```text
service=averageValues
groups[]
metrics[]
start
end
```

输出：

```text
group params
metrics
start
end
```

不得发送：

```text
topMetric
topCount
metric
```

---

# 21. `timeValues` Serializer

Canonical 输入：

```text
service=timeValues
groups[]
metrics[]
granularity
start
end
```

输出：

```text
group params
metrics
granularity
start
end
```

不得发送：

```text
topMetric
topCount
metric
```

---

# 22. `pageViews` 保持独立 Detail Contract

P7 不修 BUG-B。

pageViews 使用现有正式参数契约。

不要为了统一 metric query 强行加入：

```text
metrics
topMetric
metric
```

---

# 23. Group Params 只能复用一个 builder

必须复用当前正式：

```text
GroupBuilder
GroupPathPlanner
canonical group param helper
```

不要在 Serializer 再造：

```text
if WebApplication...
if IPAddress...
```

第二套规则。

---

# 24. Group 参数只做序列化，不做解析或补全

Canonical：

```text
groups[]
```

Transport：

```text
numGroups
groupTypeN
groupArgumentN
```

Serializer 不允许：

```text
查询 groupArguments
自动补 argument
替换 group type
猜对象
```

---

# 25. 时间字段只做 transport encoding

Canonical：

```text
start
end
```

已经物化。

Serializer 不允许：

```text
解析“最近1小时”
调用 now()
补默认时间
```

---

# 26. Granularity 不重新选择

只发送 canonical：

```text
granularity
```

不能根据：

```text
时间跨度
结果量
```

重新决定粒度。

---

# 27. topCount 不重新默认或 clamp

Canonical Contract 已负责合法性。

Serializer 不允许：

```text
缺失 → 10
1000 → clamp 100
```

---

# 28. NapmClient 的职责收口

目标职责：

```text
HTTP transport
```

不再：

```text
知道 Semantic
读取 legacy metric
决定 topMetric
决定 metrics[]
补 group path
repair
```

---

# 29. NapmClient 应接收 transport-ready params

推荐：

```text
client.topValues(serializedParams)
client.averageValues(serializedParams)
client.timeValues(serializedParams)
client.pageViews(serializedParams)
```

或当前等价结构。

重点：

> NapmClient 不再接收一个需要业务解释的 Query。

---

# 30. 不要求重写整个 NapmClient

如果当前 method API 已稳定：

```text
保留
```

只需要保证：

```text
Client 前存在唯一 serializer
Client 内无业务字段推导
```

---

# 31. Kernel 的最终职责

Phase 7 后 Kernel 应收口为：

```text
1. 接收已 admission 的 canonical query
2. 调 NapmQuerySerializer
3. 按 canonical service dispatch
4. 调 NapmClient
5. 返回 execution result
```

Kernel 不负责：

```text
repair
semantic choice
metric fallback
group fallback
time fallback
runtime capability
```

---

# 32. Serializer Failure 必须在 NapmClient 前终止

理论上 admitted canonical query 不应在 Serializer 出错。

但如果发现：

```text
unsupported service
internal invariant broken
```

必须：

```text
NapmClient=0
```

可以使用：

```text
SERIALIZATION_FAILURE
SERIALIZER_SERVICE_UNSUPPORTED
```

本轮不做全局 Error Contract。

---

# 33. Serializer 不做 Repair

若发现：

```text
metrics 非数组
topMetric 缺失
```

不能自动补。

这代表：

```text
上游 invariant 被破坏
```

应 fail closed。

---

# 34. Serializer 不重复 Validator

顺序已经是：

```text
Admission
→ Serializer
```

Serializer 不再：

```text
查 Metric Catalog
查 ownership
查 runtime capability
```

---

# 35. Serializer 不消费 Repair Suggestion

P6 已结束 Repair。

Transport 层不应知道：

```text
repair plan
```

---

# 36. Serializer 不消费 Runtime Evidence

Runtime evidence 只决定：

```text
ALLOW / DENY
```

Serializer 不根据它修改：

```text
metrics
topMetric
groups
```

---

# 37. 内部元数据不得泄漏到 NAPM

必须测试 transport params 中不存在：

```text
schemaVersion
queryModeKey
status
reasonCode
provider
roles
issues
runtimeCapability
repairAudit
fingerprint
preparedProof
```

---

# 38. 建立 Serializer Golden Tests

对：

```text
topValues
averageValues
timeValues
```

建立 exact snapshot。

pageViews 按当前 contract 建现状测试。

---

# 39. Serializer 不改变 Query

测试：

```text
deepEqual(queryAfter, queryBefore)
```

必须：

```text
true
```

---

# 40. Kernel 执行后 Query 仍不可变

Canonical Query 在 Kernel 前后：

```text
完全一致
```

---

# 41. Repair Audit 不发到 Client

即使当前 execution context 含：

```text
repairApplied
changes
fingerprint
```

NapmClient params 中：

```text
全部 absent
```

---

# 42. Runtime Evidence 不发到 Client

以下同样 absent：

```text
staticValidation
runtimeCapability
finalAdmission
requiredRuntimeChecks
```

---

# 43. Legacy `metric` 必须在 Serializer / Kernel / Client data path 绝迹

如果人工构造：

```text
canonical query + metric
```

正常应在 ResolvedQueryContract 提前拒绝。

即使绕过：

```text
Serializer 也不得使用 metric
```

推荐 fail closed，而不是兼容。

---

# 44. LegacyMetricInputAdapter 继续保留

P7 不做完整 Legacy Cleanup。

旧调用仍：

```text
legacy metric
→ LegacyMetricInputAdapter
→ canonical metrics[] / topMetric
```

随后：

```text
metric 从 execution path 消失
```

---

# 45. Adapter 与 Serializer Boundary

Legacy Path：

```text
Adapter=1
Serializer=1
Kernel metric reads=0
```

---

# 46. New Semantic Path

```text
Adapter=0
Serializer=1
```

---

# 47. Static VALID Path

```text
Static VALID
→ metricsForGroup=0
→ Serializer=1
→ Data=1
```

---

# 48. Static INVALID Path

对：

```text
KNOWN_INCOMPATIBLE
METRIC_UNKNOWN
CONTRACT_INVALID
```

必须：

```text
Serializer=0
Kernel=0
Data=0
```

---

# 49. Runtime SUPPORTED Path

```text
Static UNKNOWN
→ metricsForGroup=1
→ SUPPORTED
→ Serializer=1
→ Data=1
```

---

# 50. Runtime UNSUPPORTED Path

```text
metricsForGroup=1
→ UNSUPPORTED
→ Serializer=0
→ Kernel=0
→ Data=0
```

---

# 51. Runtime INDETERMINATE Path

```text
metricsForGroup=1
→ INDETERMINATE
→ Serializer=0
→ Kernel=0
→ Data=0
```

---

# 52. Repair Applied Path

```text
Repair=1
→ repaired candidate
→ post-repair admission ALLOW
→ Serializer=1
→ Data=1
```

Serializer 必须使用：

```text
repaired candidate
```

不是 original query。

---

# 53. Repair Rejected Path

```text
Serializer=0
Data=0
```

---

# 54. Prepared Proof 非回归

P7 不修改 Phase 4.1 / P6 proof security。

如果 proof 对应 admitted query A：

```text
不能拿 query B 进入 Serializer/Kernel
```

---

# 55. Fingerprint 可作为 invariant，但不要重做 admission

如果现有 proof/fingerprint 机制可用：

```text
Kernel 可以 assert query identity
```

但不要：

```text
重新 Static/Runtime validation
```

---

# 56. Kernel 不允许 merge override 改 Query

禁止：

```text
execute(query, overrides)
→ merge
→ 形成 query B
```

后再发南向。

---

# 57. Overview Child

每个 child：

```text
独立 canonical query
独立 admission
独立 serializer
```

不能复用 root transport params。

---

# 58. Overview Child Static Invalid

必须：

```text
child Serializer=0
child Data=0
```

---

# 59. Overview Child UNKNOWN→SUPPORTED

必须：

```text
child metricsForGroup=1
child Serializer=1
child Data=1
```

---

# 60. 多指标 TopN Golden Test

Canonical：

```json
{
  "service": "topValues",
  "metrics": ["TPI", "TPO"],
  "topMetric": "TPIO",
  "topCount": 5
}
```

Transport：

```text
metrics=TPI,TPO
topMetric=TPIO
topCount=5
```

必须：

```text
无 metric
不要求 TPIO ∈ [TPI,TPO]
```

---

# 61. 慢业务 Top5 Golden Test

Canonical：

```text
service=topValues
groups=[WebApplication]
metrics=[PGTME]
topMetric=PGTME
topCount=5
```

Transport：

```text
metrics=PGTME
topMetric=PGTME
topCount=5
```

group params 复用正式 builder。

---

# 62. 多指标趋势 Golden Test

Canonical：

```text
service=timeValues
metrics=[
  PGNPGE,
  PGTME,
  PGHTTP500
]
granularity=...
```

Transport：

```text
metrics=PGNPGE,PGTME,PGHTTP500
granularity=...
```

不得出现：

```text
topMetric
metric
```

---

# 63. Average Golden Test

Canonical：

```text
service=averageValues
metrics=[PGTME,PGNPGE]
```

Transport：

```text
metrics=PGTME,PGNPGE
```

不得出现：

```text
topMetric
topCount
metric
```

---

# 64. Metrics Order 必须保持

例如：

```text
metrics=[TPO,TPI]
```

Transport：

```text
TPO,TPI
```

不得重新排序。

---

# 65. `join(',')` 只能存在于 Serializer

搜索执行层：

```bash
rg "metrics.*join|join\(['\"]?,['\"]?\)" skills/openclaw-napm-query
```

业务 data path 中：

```text
Resolver / Kernel / Client
```

不应重复做 metrics transport encoding。

---

# 66. Serializer Registry 不复制 ResolvedQueryContract

Serializer service registry 只回答：

```text
怎么 map
```

不回答：

```text
这个 Query 合不合法
```

---

# 67. Serializer 使用字段 allowlist

示意：

```text
topValues:
groups
metrics
topMetric
topCount
start
end

averageValues:
groups
metrics
start
end

timeValues:
groups
metrics
granularity
start
end
```

最终以当前项目/NAPM接口契约为准。

---

# 68. 禁止 object spread 生成 transport params

禁止：

```javascript
const params = {...query};
```

应显式构造。

---

# 69. Serializer 输出 shape

建议：

```json
{
  "service": "topValues",
  "params": {
    "metrics": "TPI,TPO",
    "topMetric": "TPIO",
    "topCount": 5
  }
}
```

或当前等价结构。

但：

```text
service 不能混入 HTTP query params
```

---

# 70. Kernel 最终 Contract

Kernel 应只负责：

```text
serialize
dispatch
invoke client
return result
```

不再拥有：

```text
Metric choice
Object choice
Repair choice
Fallback choice
```

---

# 71. Unknown service

如果 admitted query 出现 serializer 不支持的 service：

```text
Serializer/Kernel fail closed
NapmClient=0
```

记录 invariant failure。

---

# 72. Client 不再接收需要解释的 Query

如果可行：

```text
NapmClient 接收 transport-ready params
```

如果现有 API 不能完全迁移：

```text
至少保证 Client 内没有 metrics/topMetric/metric 的业务推导
```

并在报告中列剩余债务。

---

# 73. 不做 networking 重构

不要改：

```text
HTTP library
retry
timeout
auth
TLS
```

---

# 74. 不做 Response Contract 重构

P7 只处理 request path。

不要重构：

```text
response normalization
NO_DATA
error narration
```

---

# 75. 不做 Metadata Architecture 重构

不要改：

```text
metricsForGroup provider architecture
metadata overload
```

---

# 76. 不删除 Legacy Adapter

P7 只保证：

```text
Adapter 后 execution path 不再看到 metric
```

---

# 77. 不要求全仓文本 `metric` 清零

允许：

```text
LegacyMetricInputAdapter
tests
migration docs
warnings
```

禁止：

```text
Serializer
Kernel
NapmClient data transport
```

把它当执行事实。

---

# 78. Runtime Contract 新保护

`verify:runtime-contract` 至少新增：

```text
single NapmQuerySerializer

Serializer no raw prompt dependency
Serializer no semantic parser dependency
Serializer no repair dependency
Serializer no metadata dependency
Serializer no NapmClient dependency

Serializer does not read `metric`

MetricExecutionKernel does not read `metric`
MetricExecutionKernel does not derive topMetric
MetricExecutionKernel does not derive metrics
MetricExecutionKernel routes by service, not queryModeKey

NapmClient data path does not derive canonical fields

metrics[] → comma-separated `metrics` only in Serializer

topMetric remains independent from metrics[]

internal GAIOP fields not serialized

Serializer only after final admission ALLOW
```

继续保持 P0–P6 所有 contract。

---

# 79. Phase 7 允许修改

预计：

```text
新增：
services/NapmQuerySerializer.js

修改：
services/MetricExecutionKernel.js
NapmClient.js（最小 transport-boundary 修改）
RequirementParser / runner（只接 serializer/kernel 新 contract）

可能：
GroupBuilder / common transport helper
（只复用公共逻辑，不改业务规则）

相关：
tests
runtime-contract
docs / memory
```

---

# 80. Phase 7 禁止修改

不要：

```text
修改 Semantic rules
修改 Ranking grammar
修改 Object Ontology
修改 Metric Catalog
修改 ownership matrix
修改 Runtime capability provider
修改 Atomic Repair 语义边界
重构 Metadata architecture
全局 Error Contract
NO_DATA classifier
全量 Legacy Cleanup
BUG-B
连接真实 NAPM
部署
提交 commit
```

---

# 81. P6 Guard：case normalization 不得演变成 alias resolution

新增回归：

```text
已知 canonical case variant
→ safe normalize

真正 unknown metric
→ METRIC_UNKNOWN
→ 不能因 uppercase 变合法
```

---

# 82. P6 Guard：Initial Contract Gate 不得成为第二套 Contract

审计 Phase 6：

```text
Initial Contract gate
```

必须确认它只是：

```text
进入 Repair 所需 envelope/invariant
```

完整 Query shape 真相仍只有：

```text
ResolvedQueryContract
```

如果发现复制：

```text
本轮最小收口
```

---

# 83. METRIC_UNKNOWN 不得被 Serializer/Kernel 修复

例如：

```text
pGSuPeRfAsT
```

不能由执行层：

```text
uppercase
→ 尝试执行
```

---

# 84. Serializer Unit Tests

至少新增：

```text
topValues single metric
topValues multi metrics + independent topMetric
averageValues multi metrics
timeValues multi metrics
pageViews current contract
unknown service
internal field filtering
input immutability
metrics order preservation
```

---

# 85. Kernel Unit Tests

至少：

```text
routes by service
does not read legacy metric
does not fallback topMetric
does not fallback metrics
does not mutate canonical query
does not call serializer when admission denied
serializer failure → client=0
```

---

# 86. Client Boundary Tests

Spy NapmClient 必须收到：

```text
exact serialized params
```

并断言：

```text
schemaVersion absent
queryModeKey absent
metric absent
repair metadata absent
runtime metadata absent
```

---

# 87. Integration：Static VALID

```text
Static VALID
→ Serializer=1
→ Client data=1
```

并验证 exact params。

---

# 88. Integration：UNKNOWN → SUPPORTED

```text
Static UNKNOWN
→ metricsForGroup=1
→ SUPPORTED
→ Serializer=1
→ Data=1
```

---

# 89. Integration：KNOWN_INCOMPATIBLE

```text
Serializer=0
Client data=0
```

---

# 90. Integration：METRIC_UNKNOWN

```text
Serializer=0
Client data=0
```

---

# 91. Integration：Repair Applied

```text
original
→ repaired candidate
→ ALLOW
→ Serializer must receive repaired candidate
```

---

# 92. Integration：Repair Rejected

```text
Serializer=0
Client=0
```

---

# 93. Integration：Legacy Input

```text
legacy metric
→ Adapter=1
→ canonical query no metric
→ Serializer=1
→ Kernel metric reads=0
```

---

# 94. Integration：New Semantic Path

```text
Adapter=0
Serializer=1
```

---

# 95. 调用计数矩阵

最终报告至少：

```markdown
| Scenario | Adapter | Repair | Static | metricsForGroup | Serializer | Kernel | Data |
|---|---:|---:|---:|---:|---:|---:|---:|
| Static VALID | 0/1 | 0 | 1 | 0 | 1 | 1 | 1 |
| Static INVALID | 0/1 | 0 | 1 | 0 | 0 | 0 | 0 |
| UNKNOWN+SUPPORTED | 0/1 | 0 | 1 | 1 | 1 | 1 | 1 |
| UNKNOWN+UNSUPPORTED | 0/1 | 0 | 1 | 1 | 0 | 0 | 0 |
| Repair+ALLOW | ... | 1 | 1 | 0/1 | 1 | 1 | 1 |
| Repair rejected | ... | 1 | 0/1 | 0 | 0 | 0 | 0 |
```

---

# 96. `metric` Consumer Audit 最终结果

P7 完成后输出：

```markdown
| Location | `metric` remains? | Reason |
|---|---:|---|
| LegacyMetricInputAdapter | YES | migration boundary |
| MetricExecutionKernel | NO | canonical only |
| NapmQuerySerializer | NO | canonical only |
| NapmClient data path | NO | transport only |
| QueryValidator | NO | canonical contract |
| Docs/tests | allowed | migration evidence |
```

---

# 97. `metrics[0]` Consumer Audit

搜索：

```bash
rg "metrics\s*\[\s*0\s*\]" skills/openclaw-napm-query
```

执行层：

```text
Serializer
Kernel
Client
```

必须不存在把 `metrics[0]` 当业务主指标的逻辑。

展示层若只是：

```text
显示第一个指标
```

可保留，但必须注明非 execution truth。

---

# 98. `topMetric || metric` 必须归零

搜索：

```bash
rg "topMetric.*\|\|.*metric|metric.*\|\|.*topMetric" .
```

生产执行代码目标：

```text
0
```

---

# 99. Serializer Golden Matrix

最终报告：

```markdown
| Service | Canonical metrics | topMetric | Transport metrics | Transport topMetric |
|---|---|---|---|---|
| topValues | [PGTME] | PGTME | PGTME | PGTME |
| topValues | [TPI,TPO] | TPIO | TPI,TPO | TPIO |
| averageValues | [PGTME,PGNPGE] | n/a | PGTME,PGNPGE | absent |
| timeValues | [PGNPGE,PGTME,PGHTTP500] | n/a | PGNPGE,PGTME,PGHTTP500 | absent |
```

---

# 100. Internal Field Leakage Matrix

至少确认：

```text
schemaVersion            absent
queryModeKey             absent
metric                   absent
repairApplied            absent
repairAudit              absent
runtimeCapability        absent
finalAdmission           absent
preparedProof            absent
```

---

# 101. Failure Matrix

```markdown
| Failure | Serializer | NapmClient |
|---|---:|---:|
| Static invalid | 0 | 0 |
| Runtime unsupported | 0 | 0 |
| Runtime failure | 0 | 0 |
| Repair rejected | 0 | 0 |
| Serializer invariant failure | 1 | 0 |
| Valid admitted query | 1 | 1 |
```

---

# 102. Phase 7 最终执行链

目标：

```text
Input
↓
Semantic / Legacy Adapter
↓
Canonical Query
↓
Atomic Repair
↓
Contract
↓
Static Gate
↓
Runtime Gate if UNKNOWN
↓
Final Admission = ALLOW
↓
NapmQuerySerializer
↓
Transport Params
↓
MetricExecutionKernel dispatch
↓
NapmClient
↓
HTTP
```

执行层从此不再拥有：

```text
Metric choice
Object choice
Repair choice
Fallback choice
```

---

# 103. 完成后必须运行

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
Phase 6
Phase 7 serializer/kernel
```

---

# 104. Phase 7 最终报告格式

完成后立即停止。

## 104.1 Git

```text
branch:
HEAD:
Phase 7 start status:
Phase 7 end status:
Phase 7 files:
```

## 104.2 Execution Consumer Audit

列出：

```text
metric
metrics[]
topMetric
queryModeKey
service
```

在执行层的 consumer。

## 104.3 Serializer Contract

说明：

```text
input
output
service mapping
metrics encoding
group encoding
time encoding
internal field filtering
```

## 104.4 Kernel Contract

回答：

```text
reads metric:
YES / NO

derives topMetric:
YES / NO

derives metrics:
YES / NO

routes by service:
YES / NO

routes by queryModeKey:
YES / NO

mutates canonical query:
YES / NO
```

目标：

```text
NO
NO
NO
YES
NO
NO
```

## 104.5 NapmClient Boundary

回答：

```text
receives canonical query:
YES / NO

receives serialized params:
YES / NO

derives canonical fields:
YES / NO
```

目标：

```text
NO
YES
NO
```

如果当前 Client API 无法完全做到第一项，必须列剩余技术债。

## 104.6 Golden Serializer Matrix

输出第 99 节表。

## 104.7 Internal Field Leakage

输出第 100 节检查结果。

## 104.8 Call Count Matrix

输出第 95 节表。

## 104.9 `metric` Consumer Audit

输出第 96 节表。

## 104.10 Search Results

```text
production topMetric || metric:
count =

execution metrics[0] as primary truth:
count =

Kernel queryModeKey routing:
count =
```

目标：

```text
0
0
0
```

## 104.11 P6 Non-Regression

确认：

```text
Atomic repair unchanged
unsafe repair still denied
post-repair revalidation intact
prepared proof still safe
NO_DATA still does not trigger repair
```

## 104.12 P5 Non-Regression

```text
Static VALID → no metricsForGroup
UNKNOWN only → runtime confirmation
runtime unsupported → no Serializer/Data
runtime failure → no Serializer/Data
```

## 104.13 Phase Boundaries

```text
Global Error Contract refactored: NO
NO_DATA classifier refactored: NO
Legacy Adapter removed: NO
Metadata architecture refactored: NO
BUG-B touched: NO
Remote NAPM: NO
Deploy: NO
Commit: NO
```

## 104.14 Tests

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
Phase 7:
Full repo:
lint:
runtime-contract:
diff-check:
```

给真实：

```text
suite count
test count
PASS / FAIL
```

## 104.15 Phase 7 Completion

```text
YES / NO
```

---

# 105. Phase 7 完成定义

只有全部满足才算完成：

```text
1. NapmQuerySerializer 只有一个正式实现
2. Serializer 只接受 canonical query
3. Serializer pure / deterministic
4. Serializer 不修改输入
5. Serializer 不读取 legacy metric
6. Serializer 不解析自然语言
7. Serializer 不 repair
8. Serializer 不做 admission
9. metrics[] 只在 Serializer 转为 NAPM metrics transport field
10. topMetric 独立序列化
11. topMetric 不要求属于 metrics[]
12. Kernel 不读取 metric
13. Kernel 不执行 topMetric || metric fallback
14. Kernel 不用 metrics[0] 推导业务字段
15. Kernel 按 service routing
16. Kernel 不按 queryModeKey routing
17. Kernel 不修改 canonical query
18. NapmClient data path 不重新推导 metrics/topMetric
19. internal GAIOP fields 不发往 NAPM
20. group params 复用唯一 builder
21. time params 不重新解析
22. granularity 不重新选择
23. topCount 不重新默认/clamp
24. static invalid 不调用 Serializer
25. runtime unsupported 不调用 Serializer
26. runtime failure 不调用 Serializer
27. repair rejected 不调用 Serializer
28. admitted valid query Serializer=1 / Data=1
29. repaired admitted query 使用 repaired candidate
30. Legacy Adapter 后 metric 在 execution path 消失
31. new semantic path Adapter=0
32. P6 repair contract 不被削弱
33. P5 runtime capability contract 不被削弱
34. P4 static gate 不被削弱
35. 不进入 Global Error Contract / full Legacy Cleanup / BUG-B
36. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 106. 本轮最容易犯的错误

禁止：

```text
❌ Serializer 里重新校验 object-metric ownership

❌ Serializer 里用 metric 兜底 topMetric

❌ Kernel 里用 metrics[0] 当主指标

❌ Client 再把 array 拼成 metrics

❌ Resolver / Kernel / Client 多处 join(',')

❌ queryModeKey 再决定 service

❌ transport params 用 {...query}

❌ 把 repair/runtime/proof 字段发到 NAPM

❌ Serializer 发现缺字段后自动补默认

❌ Kernel 发现 topMetric 缺失后回退 metric

❌ Serializer/Kernel 改变 metrics 顺序

❌ 为了 P7 顺手重构 Error Contract
```

---

# 107. Phase 7 完成后的系统边界

完成后应正式形成：

```text
“上游决定业务含义”
        ↓
Canonical Query

“门禁决定能否执行”
        ↓
Final Admission

“Serializer 只决定怎么发”
        ↓
NAPM transport params

“Kernel 只负责 dispatch”
        ↓
NapmClient / HTTP
```

任何执行层模块都不再拥有：

```text
“用户到底想查哪个指标？”
“哪个对象更合适？”
“topMetric 缺了该用哪个？”
“这个 Query 要不要偷偷修一下？”
```

这些问题在到达执行层之前必须已经结束。

---

# 108. 本轮结束

完成：

```text
Phase 7：NAPM Serializer + MetricExecutionKernel Contract Cleanup
```

后立即停止。

下一阶段建议：

```text
Phase 8：Error Contract + Remaining Legacy Cleanup + Final BUG-A Regression
```

必须等待 Phase 7 Review 通过后再开始。
