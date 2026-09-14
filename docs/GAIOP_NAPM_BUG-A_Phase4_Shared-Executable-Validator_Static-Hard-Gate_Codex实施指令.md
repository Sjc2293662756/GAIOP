# GAIOP NAPM BUG-A 实施指令 — Phase 4：Shared Executable Validator + Static Hard Gate

> 前置状态：
>
> - Phase 0：PASS
> - Phase 1：PASS
> - Phase 2：PASS
> - Phase 2.1：PASS
> - Phase 3：PASS
> - Phase 4：GO
> - Phase 5：HOLD
>
> 当前已经完成：
>
> ```text
> 自然语言
> → Canonical Semantic Contract
> → lifecycle
> → Canonical ResolvedQuery
> ```
>
> 并且：
>
> ```text
> metrics[]
> topMetric
> ```
>
> 已成为 canonical Query 执行字段；
>
> ```text
> metric
> ```
>
> 已退出 canonical contract，只允许存在于 legacy input boundary。
>
> **本轮只实施 Phase 4：Shared Executable Validator + Static Hard Gate。**
>
> 完成后立即停止，不进入 Phase 5。
>
> 本轮核心目标：
>
> > **让“项目已经静态知道非法”的 Query 在任何执行入口都获得统一、确定、不可绕过的否决。**

---

# 0. Phase 4 的职责边界

本轮只解决：

```text
Canonical ResolvedQuery
↓
共享结构化校验
↓
静态执行准入
```

本轮建立：

```text
ResolvedQueryExecutableValidator
```

或仓库风格下等价名称。

它必须统一消费：

```text
ResolvedQueryContract
Metric Catalog
objectMetricOwnership tri-state
Group/Path existing contract
argument policy
pageViews existing contract
```

它自己：

```text
不解析自然语言
不保存 Metric Matrix
不保存 Object Ontology
不执行 repair
不调用 NapmClient
不调用 metricsForGroup
不决定 narration
```

---

# 1. Phase 4 最关键的校验顺序

顺序必须固定，不能互换：

```text
Step 1
Canonical ResolvedQuery Contract / service shape

Step 2
Metric ID existence

Step 3
Object × Metric static ownership tri-state

Step 4
汇总静态执行结论
```

特别强调：

```text
METRIC_UNKNOWN
必须先于
Object × Metric compatibility
```

例如：

```text
PGSUPERFAST
```

正确：

```text
Metric Catalog
→ 不存在
→ METRIC_UNKNOWN
→ STOP
```

禁止：

```text
Ownership
→ KNOWN_INCOMPATIBLE
```

来掩盖“指标根本不存在”。

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
Phase 4
```

禁止：

```text
reset
stash
自动提交
覆盖已有修改
```

---

# 3. 先审计所有真正执行入口

修改前必须搜索：

```bash
rg "QueryDecisionPolicy|prepareGatewayExecution|executeGatewayRequest|executeDirectGatewayRequest|MetricExecutionKernel|NapmClient" .
```

输出表格：

```markdown
| 入口 | 能否到 metadata | 能否到 data | 当前是否经过 Policy | Phase 4 接入点 |
|---|---:|---:|---:|---|
| Plugin/Hook | ... | ... | ... | ... |
| executeGatewayRequest | ... | ... | ... | ... |
| executeDirectGatewayRequest | ... | ... | ... | ... |
| Overview child execution | ... | ... | ... | ... |
| 其他真实入口 | ... | ... | ... | ... |
```

目的：

> 不要只修 Plugin Policy，然后让 Direct / Overview / internal execution 绕过。

如果发现有真实入口可以直接：

```text
caller
→ MetricExecutionKernel
→ NapmClient
```

绕过任何 canonical boundary：

```text
先报告
并在本阶段封入口
```

但不要把业务规则复制进 Kernel。

---

# 4. 新增 Shared Executable Validator

建议：

```text
skills/openclaw-napm-query/services/ResolvedQueryExecutableValidator.js
```

如已有更合适 Service，可复用，但必须保持唯一实现。

---

# 5. Validator 输入

只接受：

```text
Canonical ResolvedQuery
```

禁止传：

```text
raw prompt
Semantic raw text
legacy metric
```

如果输入仍含：

```text
metric
```

应该已经在 Phase 3 canonical contract 被拒绝/适配。

Validator 不负责 legacy migration。

---

# 6. Validator 输出必须保持“事实型”，不要泄漏 orchestration policy

建议：

```json
{
  "ok": false,
  "status": "KNOWN_INCOMPATIBLE",
  "reasonCode": "OBJECT_METRIC_INCOMPATIBLE",
  "issues": [
    {
      "field": "topMetric",
      "metricId": "TRTI",
      "groupPathSignature": "WebApplication"
    }
  ],
  "requiredRuntimeChecks": []
}
```

允许的顶层 status 建议统一：

```text
VALID
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
UNKNOWN
```

Validator 不返回：

```text
skillInvocationAllowed
metadataSouthboundAllowed
dataSouthboundAllowed
```

这些由：

```text
QueryDecisionPolicy / RequirementParser orchestration
```

映射。

---

# 7. CONTRACT_INVALID

先调用 Phase 3 的：

```text
ResolvedQueryContract
```

如果 canonical shape 不合法：

```text
status=CONTRACT_INVALID
```

复用 Phase 3 canonical reasonCode，例如：

```text
METRICS_REQUIRED
TOP_METRIC_REQUIRED
TOP_COUNT_INVALID
GRANULARITY_REQUIRED
...
```

不要在 Validator 内复制一份 service required/forbidden fields。

---

# 8. Metric ID existence 必须检查所有指标角色

对 Metric Query Service：

```text
topValues
averageValues
timeValues
```

Validator 必须从 canonical Query 收集：

```text
metrics[]
```

以及：

```text
topMetric
```

注意：

```text
topMetric 可以不在 metrics[]
```

所以必须独立检查。

## 8.1 `metrics[]`

逐个检查。

任何一个不存在：

```text
METRIC_UNKNOWN
```

issue 必须指出：

```text
field=metrics[index]
metricId
```

## 8.2 `topMetric`

对：

```text
topValues
```

单独检查。

如果不存在：

```text
METRIC_UNKNOWN
```

即使：

```text
metrics[]
```

全部合法。

## 8.3 不要只检查 `metrics[0]`

禁止：

```text
const metric = metrics[0]
```

然后代表整个 Query。

---

# 9. Metric Catalog unavailable 不是 METRIC_UNKNOWN

Phase 1 已 fail-closed。

如果：

```text
Metric Catalog 无法加载
```

这是：

```text
CONFIGURATION_FAILURE / CATALOG_UNAVAILABLE
```

不是：

```text
METRIC_UNKNOWN
```

请复用当前基础设施错误类型。

---

# 10. Object × Metric compatibility 必须分别检查 `metrics[]` 和 `topMetric`

Metric ID 全部存在之后：

```text
objectMetricOwnership.classifyObjectMetricCompatibility(...)
```

对每个 metric role 单独分类。

例如：

```text
WebApplication × PGNPGE
WebApplication × PGTME
WebApplication × PGHTTP500
WebApplication × topMetric=PGTME
```

如果 topMetric 与 metrics 内某项相同：

```text
实现可以内部去重计算
```

但 issue/role 语义不能混淆。

---

# 11. 不允许 `topMetric ∈ metrics[]` 规则复活

合法例子继续必须 PASS：

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

只需要分别验证：

```text
TPI
TPO
TPIO
```

是否存在、是否适用于目标对象/path。

---

# 12. Group Path 必须使用完整 canonical path

不要只拿：

```text
groups[0].type
```

代表所有查询。

应优先复用：

```text
GroupPathPlanner
existing group/path normalization
objectMetricOwnership canonical signature builder
```

最终 ownership 输入必须是：

```text
exact service
+
exact groupPathSignature
+
productBaseline
+
metricId
```

如果：

```text
多层 path
复杂组合
静态 coverage 不完整
```

应得到：

```text
UNKNOWN
```

而不是猜。

---

# 13. Baseline 规则保持 Phase 1 设计

`KNOWN_COMPATIBLE / KNOWN_INCOMPATIBLE` 只能在：

```text
exact service
+
exact groupPathSignature
+
supportedProductBaseline match
+
exhaustive=true
```

前提下成立。

否则：

```text
UNKNOWN
```

Phase 4 不允许为了让测试通过绕过 baseline 条件。

---

# 14. 如果生产 baseline 当前无法确认

很多查询得到：

```text
UNKNOWN
```

是正确的。

不要把：

```text
UNKNOWN
```

强行变成：

```text
KNOWN_COMPATIBLE / KNOWN_INCOMPATIBLE
```

Phase 5 才负责：

```text
UNKNOWN
→ metricsForGroup runtime confirmation
```

---

# 15. Phase 4 对 UNKNOWN 的处理

Validator：

```text
status=UNKNOWN
requiredRuntimeChecks=[...]
```

但 Phase 4：

```text
不调用 metricsForGroup
```

## 15.1 UNKNOWN 不能获得 data execution permission

禁止：

```text
UNKNOWN
→ EXECUTE_QUERY
→ data southbound
```

## 15.2 Policy 推荐映射

```text
UNKNOWN
→ RUNTIME_CONFIRMATION_REQUIRED
```

不是：

```text
EXECUTE_QUERY
```

由于 Phase 5 尚未实现：

```text
UNKNOWN
```

本阶段必须停在：

```text
metadata/data 之前
```

并返回确定性：

```text
RUNTIME_CAPABILITY_REQUIRED
```

或项目统一 reasonCode。

---

# 16. KNOWN_INCOMPATIBLE 的处理

必须：

```text
VALIDATION_FAILURE
```

并确保：

```text
0 metadata southbound
0 data southbound
```

Plugin/Policy path：

```text
Query Skill invocation = 0
```

Skill/direct path：

```text
metadata=0
NapmClient=0
data=0
```

---

# 17. METRIC_UNKNOWN 的处理

同样：

```text
VALIDATION_FAILURE
```

并：

```text
0 metadata
0 data
```

Plugin path：

```text
Query Skill=0
```

Skill/direct path：

```text
NapmClient=0
```

---

# 18. pageViews 本轮怎么处理

`pageViews` 是独立 Detail Contract。

如果 canonical pageViews 不包含：

```text
metrics/topMetric
```

Validator 只复用：

```text
ResolvedQueryContract / pageViews existing contract
```

不做：

```text
Metric Catalog
Object × Metric
```

不要修改 BUG-B。

---

# 19. Metadata Services 本轮不进入 Object × Metric gate

当前 metadata overloaded service 仍未拆。

Phase 4 不把 metadata 请求当 Metric Query 做：

```text
metrics[] / topMetric ownership
```

---

# 20. QueryDecisionPolicy 接入 Shared Validator

调用顺序：

```text
legacy/canonical boundary
↓
ResolvedQueryContract canonical
↓
ResolvedQueryExecutableValidator
↓
QueryDecisionPolicy 映射 action
```

Policy 不再自行：

```text
解析 metric
解析 object
查 ownership matrix
```

---

# 21. Policy 映射表

```text
VALID
→ EXECUTE_QUERY
```

```text
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
→ VALIDATION_FAILURE
```

```text
UNKNOWN
→ RUNTIME_CONFIRMATION_REQUIRED
```

不要：

```text
UNKNOWN → EXECUTE_QUERY
```

---

# 22. Plugin path 的零调用要求

对：

```text
KNOWN_INCOMPATIBLE
METRIC_UNKNOWN
CONTRACT_INVALID
```

必须：

```text
Query Skill invocation = 0
NapmClient = 0
```

---

# 23. prepareGatewayExecution 接入点

必须在：

```text
reviewGatewayRequestMetadata()
```

之前。

目标：

```text
canonical query
↓
Shared Validator
↓
非法/unknown
→ STOP

VALID
→ 才能进入现有 metadata/data 流程
```

对：

```text
KNOWN_INCOMPATIBLE
METRIC_UNKNOWN
```

必须：

```text
metadata review = 0
applications = 0
metricsForGroup = 0
NapmClient = 0
```

---

# 24. executeGatewayRequest 不得绕过

如果：

```text
executeGatewayRequest
```

能不经 prepare：

```text
必须接同一 Validator 或统一调用 prepare
```

不要复制校验逻辑。

---

# 25. executeDirectGatewayRequest 必须有最后防线

Direct path：

```text
canonical/legacy boundary
↓
Shared Validator
↓
只有 VALID 才能进入 Kernel
```

对：

```text
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
CONTRACT_INVALID
UNKNOWN
```

Phase 4：

```text
MetricExecutionKernel calls = 0
NapmClient calls = 0
```

---

# 26. Overview / child query 也必须经过同一 Gate

Phase 3 已将 child query canonical 化。

Phase 4 必须确认：

```text
Overview child query
```

最终也经过：

```text
Shared Validator
```

内部生成 Query 不等于可信 Query。

---

# 27. Validator 不做 Repair

例如：

```text
WebApplication + TRTI
```

禁止：

```text
TRTI → PGTME
```

Validator 只返回：

```text
KNOWN_INCOMPATIBLE
```

---

# 28. Validator 不做 Clarification

Validator 只判断：

```text
执行准入
```

不重新解析或追问自然语言。

---

# 29. Static issue 结构

每个 issue 建议至少有：

```text
code
field
metricId
service
groupPathSignature
role
```

role 至少：

```text
RETURN_METRIC
RANKING_METRIC
```

---

# 30. 多指标 Query 的失败语义

例如：

```text
metrics=[PGNPGE,TRTI]
topMetric=PGTME
WebApplication
```

如果 TRTI incompatible：

```text
整体 KNOWN_INCOMPATIBLE
```

不能删掉 TRTI 后继续。

---

# 31. `topMetric` 单独非法也必须失败

例如：

```text
metrics=[PGNPGE,PGTME]
topMetric=TRTI
WebApplication
```

返回：

```text
KNOWN_INCOMPATIBLE
```

---

# 32. `topMetric` 不存在

例如：

```text
metrics=[PGTME]
topMetric=PGSUPERFAST
```

必须：

```text
METRIC_UNKNOWN
```

不能变成：

```text
KNOWN_INCOMPATIBLE
```

---

# 33. 一个 metrics[] 成员不存在

例如：

```text
metrics=[PGTME,PGSUPERFAST]
topMetric=PGTME
```

必须：

```text
METRIC_UNKNOWN
field=metrics[1]
```

---

# 34. UNKNOWN 传播规则

如果：

```text
metric A = KNOWN_COMPATIBLE
metric B = UNKNOWN
topMetric = KNOWN_COMPATIBLE
```

整体：

```text
UNKNOWN
```

`requiredRuntimeChecks` 只列真正 UNKNOWN 的项。

---

# 35. 多个 UNKNOWN 去重

可按：

```text
service + groupPathSignature + metricId
```

去重。

但保留：

```text
roles[]
```

说明它是返回指标、排行指标还是两者。

---

# 36. Validator 不做 runtime metadata

绝对禁止：

```text
validator.validate()
→ NapmClient.metricsForGroup()
```

Shared Validator 必须：

```text
pure / no-southbound
```

---

# 37. KNOWN_COMPATIBLE 测试必须使用可信 baseline fixture

测试：

```text
WebApplication + PGTME
→ KNOWN_COMPATIBLE
```

必须显式给：

```text
verified supportedProductBaseline fixture
```

---

# 38. KNOWN_INCOMPATIBLE 测试同样显式 baseline

```text
WebApplication + TRTI + verified baseline
→ KNOWN_INCOMPATIBLE
```

同时必须测试：

```text
WebApplication + TRTI + no baseline
→ UNKNOWN
```

两者缺一不可。

---

# 39. 不要通过 Phase 4 测试偷偷放宽 baseline

不能为了“修复原 BUG”破坏 Phase 1 的：

```text
baseline + exhaustive
```

语义。

---

# 40. Phase 4 与原 BUG-A 的真实状态要诚实报告

如果生产 runtime 仍无法确认 baseline：

```text
WebApplication + TRTI
```

可能正确得到：

```text
UNKNOWN
→ RUNTIME_CAPABILITY_REQUIRED
```

而不是：

```text
KNOWN_INCOMPATIBLE
```

这不是 Phase 4 失败。

真正 runtime confirmation：

```text
UNKNOWN → metricsForGroup
```

属于 Phase 5。

---

# 41. QueryDecisionPolicy 不再拥有对象指标业务规则

Phase 4 后检查：

```bash
rg "PGTME|TRTI|PGNSLPGE|RTTI|WebApplication|DefinedApp"   skills/openclaw-napm-query/services/QueryDecisionPolicy.js
```

用于 Object × Metric compatibility 的硬编码应不存在。

Policy 只消费 Validator result。

---

# 42. RequirementParser 不再自行判断 ownership

若存在重复：

```text
isMetricCompatible...
metric-group regex
```

用于执行 gate：

```text
统一移除
```

改成调用 Shared Validator。

---

# 43. QueryMetadataConstraint 的定位

Phase 4 后：

```text
Shared Validator
```

拥有真正执行裁决权。

Constraint 可保留：

```text
metadata hints / normalization / warning
```

但不能作为最终执行准入。

---

# 44. Phase 4 Error Outcome

本轮至少统一：

```text
VALIDATION_FAILURE
```

覆盖：

```text
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
```

UNKNOWN：

```text
RUNTIME_CAPABILITY_REQUIRED
```

不要在本轮重构最终 narration Error Contract。

但必须确保：

```text
VALIDATION_FAILURE
```

不会进入：

```text
NO_DATA
```

---

# 45. 0 Southbound 的定义

至少包括所有 NapmClient 真实调用：

```text
applications
businessGroups
groups
groupArguments
metrics
metricsForGroup
granularities
topValues
averageValues
timeValues
pageViews
```

对：

```text
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
CONTRACT_INVALID
```

必须全部：

```text
0
```

---

# 46. UNKNOWN 在 Phase 4 的 southbound

Phase 5 尚未开始，所以本轮：

```text
UNKNOWN
```

也不能调用：

```text
metricsForGroup
```

因此：

```text
metadata=0
data=0
```

并返回：

```text
RUNTIME_CAPABILITY_REQUIRED
```

Phase 5 后这条会有意改变。

---

# 47. Phase 4 核心测试矩阵

## A. Contract Invalid

```text
topValues missing topMetric
→ CONTRACT_INVALID
→ VALIDATION_FAILURE
→ 0 southbound
```

## B. Metric Unknown

```text
WebApplication
metrics=[PGSUPERFAST]
topMetric=PGSUPERFAST
→ METRIC_UNKNOWN
→ 0 southbound
```

必须证明：

```text
Metric Catalog existence
先于
ownership classification
```

## C. Known Incompatible

verified baseline：

```text
WebApplication
metrics=[TRTI]
topMetric=TRTI
→ KNOWN_INCOMPATIBLE
→ VALIDATION_FAILURE
→ 0 metadata
→ 0 data
```

Plugin：

```text
Query Skill=0
```

Direct：

```text
Kernel=0
NapmClient=0
```

## D. Known Compatible

verified baseline：

```text
WebApplication
metrics=[PGTME]
topMetric=PGTME
→ VALID
```

允许继续现有执行路径。

## E. Unknown

无 baseline / non-exhaustive path：

```text
WebApplication + PGTME
→ UNKNOWN
→ RUNTIME_CAPABILITY_REQUIRED
→ metadata=0
→ data=0
```

## F. topMetric independent

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

如果 ownership compatible：

```text
VALID
```

不能因不在 metrics[] 中失败。

## G. Mixed metrics

```text
metrics=[PGNPGE,TRTI]
topMetric=PGTME
WebApplication
verified baseline
→ KNOWN_INCOMPATIBLE
```

issue 精确指向：

```text
metrics[1]=TRTI
```

## H. Ranking metric incompatible

```text
metrics=[PGNPGE,PGTME]
topMetric=TRTI
WebApplication
verified baseline
→ KNOWN_INCOMPATIBLE
field=topMetric
role=RANKING_METRIC
```

---

# 48. 三个入口的零调用测试

## Plugin / Hook

Static invalid：

```text
QueryDecisionPolicy
→ Shared Validator
→ VALIDATION_FAILURE

Query Skill calls = 0
NapmClient calls = 0
```

## executeGatewayRequest

Static invalid：

```text
Shared Validator calls = 1
metadata review = 0
applications = 0
metricsForGroup = 0
topValues = 0
NapmClient total = 0
```

## executeDirectGatewayRequest

Static invalid：

```text
Shared Validator calls = 1
MetricExecutionKernel = 0
topValues = 0
NapmClient total = 0
```

---

# 49. Adapter 不应在 Phase 4 重复调用

保持 Phase 3：

```text
new semantic path
Adapter=0

legacy path
Adapter=1
```

Validator 只看：

```text
Adapter 后 canonical query
```

---

# 50. Semantic Lifecycle 非回归

继续保证：

```text
AMBIGUOUS
UNRESOLVED
UNSUPPORTED
```

不会产生 canonical executable Query。

Shared Validator 不接 Semantic Contract，只接 Canonical ResolvedQuery。

---

# 51. Phase 4 Runtime Contract

`verify:runtime-contract` 至少新增：

```text
single Shared Executable Validator implementation
QueryDecisionPolicy consumes Shared Validator
prepareGatewayExecution validates before metadata review
executeDirectGatewayRequest validates before Kernel
Metric Catalog existence precedes ownership classification
Validator has no NapmClient / metadata dependency
Validator does not parse raw prompt
Validator does not contain metric keyword business rules
QueryDecisionPolicy does not own Object×Metric matrix
RequirementParser does not duplicate Object×Metric gate
UNKNOWN cannot map directly to data execution
KNOWN_INCOMPATIBLE cannot produce southbound
METRIC_UNKNOWN cannot produce southbound
```

继续保持 Phase 0-3 contracts。

---

# 52. Phase 4 允许修改的文件

预计：

```text
新增：
services/ResolvedQueryExecutableValidator.js

修改：
services/QueryDecisionPolicy.js
services/RequirementParserService.js

可能最小修改：
Plugin Hook / execute decision mapping
run_napm_query orchestration
Overview execution boundary

相关：
tests
runtime-contract
docs / memory
```

优先复用：

```text
MetricMappingService / Metric Catalog
objectMetricOwnership
GroupPathPlanner
ResolvedQueryContract
```

不复制规则。

---

# 53. Phase 4 禁止修改

不要：

```text
新增 RuntimeMetricCapabilityService
调用 metricsForGroup 处理 UNKNOWN
重构 NapmMetadataService
拆 metadata overload
新增 AtomicQueryRepair
修改 Metric Semantic rules
修改 Ranking Grammar
修改 Object Ontology
修改 Legacy Adapter 决策表
新增 Serializer
删除 Kernel topMetric||metric fallback
重构 Error Contract
修 NO_DATA classifier
处理 BUG-B
连接远端
部署
提交 commit
```

---

# 54. Phase 0 Characterization 的迁移

以下历史行为会被 Phase 4 有意改变：

```text
Policy WebApplication + TRTI 放行
Gateway static invalid 仍调用 metadata/data
Direct static invalid 仍进入 Kernel
```

但只在：

```text
Validator 能静态确定 METRIC_UNKNOWN / KNOWN_INCOMPATIBLE
```

时改变。

---

# 55. Phase 4 不应改变的历史行为

仍保持：

```text
UNKNOWN 不调用 metricsForGroup
→ Phase 5 才改

metadata overload
→ 保持

Kernel legacy fallback
→ 保持物理代码

Error text no-data guessing
→ 保持

BUG-B
→ 保持

BottomN
→ 继续 UNSUPPORTED

Semantic rules
→ 保持 Phase 2

Canonical Query Contract
→ 保持 Phase 3
```

---

# 56. 完成后必须运行

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
Phase 4 validator/gate/call-count tests
```

---

# 57. Phase 4 输出格式

完成后立即停止，不进入 Phase 5。

## 57.1 Git

```text
branch:
HEAD:
Phase 4 start status:
Phase 4 end status:
Phase 4 files:
```

## 57.2 Validator Contract

输出：

```text
input:
status enum:
reasonCodes:
issues schema:
requiredRuntimeChecks schema:
```

## 57.3 Validation Order

明确：

```text
1. ResolvedQueryContract
2. Metric Catalog existence
3. ObjectMetricOwnership tri-state
4. Aggregate result
```

确认：

```text
METRIC_UNKNOWN 是否先于 ownership：
YES / NO
```

目标：

```text
YES
```

## 57.4 Entry Point Coverage

```markdown
| 入口 | Shared Validator | 在 metadata 前 | 在 Kernel 前 | 可否绕过 |
|---|---:|---:|---:|---:|
| Plugin Policy | ... | ... | ... | ... |
| executeGatewayRequest | ... | ... | ... | ... |
| executeDirectGatewayRequest | ... | ... | ... | ... |
| Overview child | ... | ... | ... | ... |
```

## 57.5 Static Gate Result

至少：

```text
METRIC_UNKNOWN:
Plugin Skill calls =
Gateway metadata =
Direct Kernel =
NapmClient total =

KNOWN_INCOMPATIBLE:
Plugin Skill calls =
Gateway metadata =
Direct Kernel =
NapmClient total =
```

目标均为：

```text
0
```

## 57.6 UNKNOWN Result

分别报告：

```text
verified baseline:
result = ...

no baseline:
result = UNKNOWN
policy action =
metadata calls =
data calls =
```

Phase 4 目标：

```text
UNKNOWN
→ RUNTIME_CAPABILITY_REQUIRED
→ metadata=0
→ data=0
```

## 57.7 Core Matrix

```markdown
| Query | baseline | result | outcome | southbound |
|---|---|---|---|---:|
| WebApplication + PGTME | verified | ... | ... | ... |
| WebApplication + TRTI | verified | ... | ... | 0 |
| WebApplication + TRTI | unknown | UNKNOWN | RUNTIME_CAPABILITY_REQUIRED | 0 |
| METRIC_UNKNOWN | any | METRIC_UNKNOWN | VALIDATION_FAILURE | 0 |
| metrics=[TPI,TPO], topMetric=TPIO | verified | ... | ... | ... |
```

## 57.8 Multi-Metric Validation

报告：

```text
是否逐个检查 metrics[]：YES/NO
是否独立检查 topMetric：YES/NO
是否只看 metrics[0]：YES/NO
是否要求 topMetric ∈ metrics[]：YES/NO
```

目标：

```text
YES
YES
NO
NO
```

## 57.9 Phase 3 Non-Regression

确认：

```text
canonical query no metric
Legacy Adapter exactly-once
QueryValidator shared contract
Plugin no topMetric membership rule
Semantic lifecycle unchanged
```

## 57.10 Later-Phase Non-Regression

确认：

```text
Runtime metricsForGroup not implemented
Metadata overload unchanged
Kernel fallback physically unchanged
Serializer not added
Error Contract unchanged
BUG-B unchanged
```

## 57.11 Tests

```text
Phase 0:
Phase 1:
Phase 2:
Phase 2.1:
Phase 3:
Phase 4:
full repo:
lint:
runtime-contract:
diff-check:
```

## 57.12 Remote / Commit

```text
Remote NAPM: NO
Deploy: NO
Commit: NO
Phase 5 started: NO
```

## 57.13 Phase 4 Completion

```text
YES / NO
```

---

# 58. Phase 4 完成定义

只有全部满足才算完成：

```text
1. Shared Executable Validator 只有一个实现
2. Validator 只接受 canonical ResolvedQuery
3. Validator 不解析自然语言
4. Validator 不调用任何 southbound
5. Contract validation 复用 ResolvedQueryContract
6. Metric existence 使用 canonical Metric Catalog
7. Metric existence 在 ownership 前
8. metrics[] 每项逐个检查
9. topMetric 独立检查
10. topMetric 不要求属于 metrics[]
11. ownership 使用 Phase 1 tri-state
12. baseline/exhaustive 规则未被绕过
13. KNOWN_INCOMPATIBLE → VALIDATION_FAILURE
14. METRIC_UNKNOWN → VALIDATION_FAILURE
15. CONTRACT_INVALID → VALIDATION_FAILURE
16. 以上三类 → 0 metadata + 0 data
17. Plugin static invalid → Query Skill=0
18. Gateway static invalid → metadata review=0
19. Direct static invalid → Kernel=0
20. UNKNOWN 不直接 data execute
21. UNKNOWN 在 Phase 4 返回 RUNTIME_CAPABILITY_REQUIRED
22. UNKNOWN 在 Phase 4 不调用 metricsForGroup
23. Policy/RequirementParser 不复制 ownership 规则
24. QueryMetadataConstraint 不拥有最终 hard gate
25. Overview child query 不能绕过 Validator
26. Phase 3 canonical/legacy contract 保持
27. Phase 2 Semantic lifecycle 保持
28. Metadata/Serializer/Error/BUG-B 未提前修改
29. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 59. 特别提醒：不要把 Phase 4 的阶段目标夸大

如果生产 baseline 当前未知，那么 Phase 4 并不一定让所有：

```text
WebApplication + TRTI
```

在真实环境立即变成：

```text
KNOWN_INCOMPATIBLE
```

它可能正确得到：

```text
UNKNOWN
→ RUNTIME_CAPABILITY_REQUIRED
```

真正：

```text
UNKNOWN
→ metricsForGroup
→ ALLOW / DENY
```

是 Phase 5。

Phase 4 真正完成的是：

> **静态已知非法一定阻断；未知不再被误当作允许。**

---

# 60. 本轮结束

完成：

```text
Phase 4：Shared Executable Validator + Static Hard Gate
```

后立即停止。

下一阶段：

```text
Phase 5：Runtime Capability Confirmation / metricsForGroup
```

必须等待 Phase 4 Review 通过后再开始。
