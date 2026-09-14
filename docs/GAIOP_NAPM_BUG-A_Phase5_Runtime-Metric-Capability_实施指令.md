# GAIOP NAPM BUG-A 实施指令 — Phase 5：Runtime Metric Capability Confirmation / `metricsForGroup`

> 前置状态：
>
> - Phase 0：PASS
> - Phase 1：PASS
> - Phase 2：PASS
> - Phase 2.1：PASS
> - Phase 3：PASS
> - Phase 4：PASS
> - Phase 4.1：PASS
> - Phase 5：GO
>
> 当前已经完成：
>
> ```text
> 自然语言
> → Canonical Semantic Contract
> → Semantic Lifecycle
> → Canonical ResolvedQuery
> → Shared Static Executable Validator
> ```
>
> 目前 Static Gate 已经能够稳定区分：
>
> ```text
> VALID
> CONTRACT_INVALID
> METRIC_UNKNOWN
> KNOWN_INCOMPATIBLE
> UNKNOWN
> ```
>
> 并且 Phase 4 已经确认：
>
> ```text
> CONTRACT_INVALID
> METRIC_UNKNOWN
> KNOWN_INCOMPATIBLE
> → 0 southbound
>
> UNKNOWN
> → RUNTIME_CAPABILITY_REQUIRED
> → Phase 4 暂时 0 southbound
> ```
>
> **本轮只实施 Phase 5：对 `UNKNOWN` 做运行时能力确认。**
>
> 核心目标：
>
> > **只有 Static Validator 无法确定的 `UNKNOWN`，才允许调用 `metricsForGroup`；运行时明确支持后才允许数据查询，运行时明确不支持则拒绝执行。**
>
> 完成后立即停止，不进入后续 Serializer / Kernel Cleanup / Error Contract / Legacy Cleanup / BUG-B 阶段。

---

# 0. 官方 NAPM 能力依据

NAPM 文档对 `metricsForGroup` 的定义是：

```text
分组指标（metricsForGroup）
= 返回某个分组下钻可用的指标列表
```

它与：

```text
topValues
averageValues
timeValues
```

一样使用：

```text
numGroups
groupType1...groupTypeN
groupArgument1...groupArgumentN（如需要）
```

因此 Phase 5 可以使用：

```text
canonical group path
→ metricsForGroup
→ 当前设备 / 当前分组路径实际可用 Metric IDs
```

作为运行时 capability evidence。

注意：

> `metricsForGroup` 证明的是“当前设备、当前 exact group path 下该 metric 是否可用”。

不要把它扩张成：

```text
自然语言语义真相
Object Ontology 真相
Metric Catalog 真相
任意 service capability 真相
```

---

# 1. Phase 5 的唯一主链

最终目标：

```text
Canonical ResolvedQuery
        ↓
Shared Static Validator
        ↓
┌──────────────────────────────────────────┐
│ VALID                                    │
│ → 不调用 metricsForGroup                │
│ → 直接进入既有 data execution            │
├──────────────────────────────────────────┤
│ CONTRACT_INVALID                         │
│ METRIC_UNKNOWN                           │
│ KNOWN_INCOMPATIBLE                       │
│ → 不调用 metricsForGroup                │
│ → VALIDATION_FAILURE                     │
│ → 0 data                                 │
├──────────────────────────────────────────┤
│ UNKNOWN                                  │
│ → RuntimeMetricCapabilityService         │
│ → metricsForGroup                        │
│ → runtime evidence                       │
│                                          │
│     全部 SUPPORTED                       │
│     → ALLOW                              │
│     → data execution                     │
│                                          │
│     任一 UNSUPPORTED                     │
│     → VALIDATION_FAILURE                 │
│     → 0 data                             │
│                                          │
│     capability 查询失败 / 响应不可判定    │
│     → RUNTIME_CAPABILITY_FAILURE         │
│     → 0 data                             │
└──────────────────────────────────────────┘
```

---

# 2. 最重要的不变量

Phase 5 必须锁死：

```text
KNOWN_COMPATIBLE / VALID
→ metricsForGroup = 0

KNOWN_INCOMPATIBLE
→ metricsForGroup = 0

METRIC_UNKNOWN
→ metricsForGroup = 0

CONTRACT_INVALID
→ metricsForGroup = 0

只有 UNKNOWN
→ 才允许 metricsForGroup
```

如果任何已知状态也去调用 `metricsForGroup`：

```text
Phase 5 FAIL
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
```

禁止：

```text
reset
stash
自动提交
覆盖已有修改
```

---

# 4. 先审计现有 `metricsForGroup` 实现

修改前执行：

```bash
rg "metricsForGroup|reviewQuery|NapmMetadataService|RUNTIME_CAPABILITY_REQUIRED|requiredRuntimeChecks" .
```

必须回答：

```text
1. NapmClient 是否已有 metricsForGroup 方法？
2. NapmMetadataService 是否已有统一调用封装？
3. 当前 metadata review 是否已经调用 metricsForGroup？
4. 当前 group path → metricsForGroup params 是谁负责构造？
5. 当前返回值标准化后是什么 shape？
6. 当前是否已有 cache？
7. Plugin / Gateway / Direct 对 UNKNOWN 的现有 action 分别是什么？
```

输出审计表。

不要在已有稳定实现旁边重新拼一套 URL。

---

# 5. 新增 `RuntimeMetricCapabilityService`

建议新增：

```text
skills/openclaw-napm-query/services/RuntimeMetricCapabilityService.js
```

若已有明确等价组件，可复用。

职责唯一：

```text
requiredRuntimeChecks
+
canonical ResolvedQuery
+
current runtime/NAPM client context
        ↓
调用 metricsForGroup
        ↓
生成 runtime capability evidence
```

它不负责：

```text
自然语言解析
Semantic Lifecycle
ResolvedQuery shape validation
Metric Catalog existence
静态 Object × Metric ownership
repair
data query
narration
```

---

# 6. Runtime Service 输入

输入只允许来自 Phase 4 Static Validator 的：

```text
status=UNKNOWN
requiredRuntimeChecks[]
```

典型：

```json
{
  "type": "METRIC_CAPABILITY",
  "service": "topValues",
  "groupPathSignature": "WebApplication",
  "metricId": "PGTME",
  "roles": [
    "RETURN_METRIC",
    "RANKING_METRIC"
  ]
}
```

不要让任意 caller 自由构造：

```text
“帮我检查 TRTI”
```

然后跳过 canonical query / static validation。

---

# 7. `requiredRuntimeChecks` 必须有 provider 语义

Phase 5 要确认：

```text
UNKNOWN
```

是否真的能由 `metricsForGroup` 解决。

建议 runtime check 增加或明确：

```text
type=METRIC_CAPABILITY
provider=METRICS_FOR_GROUP
```

只有：

```text
provider=METRICS_FOR_GROUP
```

的 UNKNOWN 才由本阶段 RuntimeMetricCapabilityService 处理。

如果未来出现：

```text
SERVICE_CAPABILITY
DEVICE_FEATURE
LICENSE_CAPABILITY
...
```

不能一律拿 `metricsForGroup` 猜。

---

# 8. 不要把所有 UNKNOWN 都强行解释成 metricsForGroup

如果 Static Validator 的 UNKNOWN 原因是：

```text
无法确认 exact path
service contract 本身缺静态/运行时证据
非 metric capability 类型
```

且没有：

```text
provider=METRICS_FOR_GROUP
```

则保持：

```text
RUNTIME_CAPABILITY_REQUIRED
```

或：

```text
RUNTIME_CAPABILITY_UNRESOLVED
```

但：

```text
不执行 data query
```

本轮不要猜。

---

# 9. Runtime evidence 的作用域必须精确

`metricsForGroup` 结果至少绑定：

```text
当前 NAPM client / device context
exact canonical group path
exact group arguments
capability provider=metricsForGroup
```

不要形成全局：

```text
PGTME supported=true
```

这种脱离 group path / device 的事实。

---

# 10. Group Path 参数必须复用现有 canonical builder

官方接口使用：

```text
numGroups
groupTypei
groupArgumenti
```

RuntimeMetricCapabilityService 必须复用现有：

```text
GroupPathPlanner
group parameter builder
NapmMetadataService
或当前 canonical serializer helper
```

不要重新维护：

```text
if WebApplication...
if IPAddress...
```

---

# 11. 不允许为 runtime check 修复 group path

如果 canonical query 的 group path：

```text
缺 argument
path 非法
```

这应该在：

```text
ResolvedQueryContract / GroupPath validation
```

阶段处理。

RuntimeMetricCapabilityService 不允许：

```text
自动查 groupArguments
自动补 object
自动换 path
```

它只查询已经确定的 exact path。

---

# 12. `metricsForGroup` 调用必须最小化

一个 `metricsForGroup` 响应返回：

```text
该 exact group path 下的可用 Metric IDs
```

因此同一路径有：

```text
metrics=[PGNPGE,PGTME]
topMetric=PGTME
```

且全部是 UNKNOWN 时：

```text
不应该调用 metricsForGroup 3 次
```

目标：

```text
每个 unique exact group path
最多 1 次 metricsForGroup
```

然后用返回列表同时判断多个 metric role。

---

# 13. Phase 5 不新增跨请求长期 cache

本轮优先：

```text
单次 admission / 单次 Query request 内去重
```

不要新增：

```text
process-global capability cache
永久 device capability cache
长 TTL cache
```

原因：

```text
metricsForGroup 是设备运行时能力
可能受版本 / 配置 / license / device context 影响
```

如果现有 NapmMetadataService 已有 cache：

```text
不要擅自重构
```

只在报告里说明。

---

# 14. 如果必须 cache，key 必须包含完整 capability scope

至少：

```text
device/client identity
groupPathSignature
group arguments
```

不能只：

```text
metricId
```

但本轮默认不新增新跨请求 cache。

---

# 15. `metricsForGroup` 返回结果标准化

RuntimeMetricCapabilityService 应得到规范结果：

```text
Set<string> supportedMetricIds
```

来源例如：

```text
[
  { Id: "PGTME", Label: "..." },
  { Id: "PGNPGE", Label: "..." }
]
```

只使用：

```text
Id
```

判断。

不要根据：

```text
Label
中文名
描述文字
```

判断支持关系。

---

# 16. Metric ID 标准化只能做格式归一

允许：

```text
trim
统一大小写（若现有 Catalog canonical ID 为大写）
```

禁止：

```text
alias repair
PGTIME → PGTME
TRTI → PGTME
```

Metric ID 已经过 Phase 1 Catalog existence。

---

# 17. Runtime capability result enum

建议统一：

```text
SUPPORTED
UNSUPPORTED
INDETERMINATE
```

其中：

## SUPPORTED

```text
metricsForGroup 请求成功
响应 schema 合法
metricId 明确存在于返回 Id 集合
```

## UNSUPPORTED

```text
metricsForGroup 请求成功
响应 schema 合法
metricId 不在返回 Id 集合
```

## INDETERMINATE

```text
请求失败
HTTP/transport error
响应解析失败
schema 不合法
无法确认数据是否 authoritative
```

不要把：

```text
INDETERMINATE
```

当成：

```text
UNSUPPORTED
```

---

# 18. 成功的空列表如何处理

如果：

```text
metricsForGroup HTTP/transport 成功
响应格式合法
明确解析为合法空 Metric 列表
```

则对任何 requested metric：

```text
UNSUPPORTED
```

但如果所谓“空”来自：

```text
解析失败
异常 response
字段缺失
HTML 错误页
```

则：

```text
INDETERMINATE
```

不能误判成 unsupported。

---

# 19. Runtime Service 输出建议

例如：

```json
{
  "status": "SUPPORTED",
  "provider": "METRICS_FOR_GROUP",
  "evidence": [
    {
      "service": "topValues",
      "groupPathSignature": "WebApplication",
      "metricId": "PGTME",
      "roles": [
        "RETURN_METRIC",
        "RANKING_METRIC"
      ],
      "status": "SUPPORTED"
    }
  ],
  "metadataCalls": 1
}
```

多指标：

```json
{
  "status": "UNSUPPORTED",
  "evidence": [
    {
      "metricId": "PGNPGE",
      "status": "SUPPORTED"
    },
    {
      "metricId": "TRTI",
      "status": "UNSUPPORTED"
    }
  ]
}
```

---

# 20. 新增统一 Runtime Admission 编排

不要让：

```text
executeGatewayRequest
executeDirectGatewayRequest
Overview child
```

各自写一遍：

```text
if UNKNOWN then metricsForGroup...
```

建议新增共享编排，例如：

```text
ResolvedQueryExecutionAdmissionService
```

或当前代码风格下的等价 helper。

它的职责：

```text
Shared Static Validator
        ↓
VALID
→ ALLOW

hard failure
→ DENY

UNKNOWN
→ RuntimeMetricCapabilityService
→ ALLOW / DENY / CAPABILITY_FAILURE
```

---

# 21. 不修改 Static Validator 的“静态事实”语义

`ResolvedQueryExecutableValidator` 必须继续保持：

```text
pure
no-southbound
static only
```

不要改成：

```text
validate()
→ 自己调用 metricsForGroup
```

Phase 4 的纯度必须保留。

---

# 22. 不要把 Runtime evidence 写回静态 truth source

禁止：

```text
metricsForGroup 说支持
→ 修改 objectMetricOwnership.js
→ 修改 Resolution Spec
→ 修改 Metric Catalog
```

运行时证据只在当前 execution admission 中生效。

---

# 23. Final Admission 状态

建议统一：

```text
ALLOW
DENY_STATIC
DENY_RUNTIME_UNSUPPORTED
RUNTIME_CAPABILITY_FAILURE
```

或项目现有等价命名。

含义：

```text
ALLOW
→ 可以进入 data execution

DENY_STATIC
→ Phase 4 已知非法

DENY_RUNTIME_UNSUPPORTED
→ 当前 device/path 明确不支持

RUNTIME_CAPABILITY_FAILURE
→ 无法获取可靠 capability evidence
```

---

# 24. Runtime UNSUPPORTED 应如何映射

如果：

```text
metricsForGroup 成功
metric 不在支持列表
```

这是：

```text
当前设备 / exact group path 明确不支持
```

建议外层 outcome：

```text
VALIDATION_FAILURE
```

reasonCode：

```text
RUNTIME_METRIC_UNSUPPORTED
```

不要：

```text
NO_DATA
```

因为：

```text
data query 根本没有执行
```

---

# 25. Runtime Capability 查询失败如何映射

如果：

```text
metricsForGroup 网络失败
HTTP error
parse failure
schema invalid
```

不能返回：

```text
VALIDATION_FAILURE
```

因为并没有证明用户参数不合法。

也不能返回：

```text
NO_DATA
```

建议：

```text
RUNTIME_CAPABILITY_FAILURE
```

或当前统一基础设施 failure code。

最终 Error Contract 可后续再统一。

本轮必须至少保证：

```text
0 data query
```

---

# 26. Plugin path 的 Phase 5 行为

Phase 4 中：

```text
UNKNOWN
→ RUNTIME_CONFIRMATION_REQUIRED
→ Query Skill = 0
```

Phase 5 要有意改变。

Plugin 自己不要直接访问 NAPM metadata。

推荐：

```text
Plugin static decision
        ↓
VALID
→ invoke Query Skill

UNKNOWN
→ action=EXECUTE_WITH_RUNTIME_CONFIRMATION
  或保留 RUNTIME_CONFIRMATION_REQUIRED，
  但明确 skillInvocationAllowed=true
→ invoke Query Skill exactly once

static failure
→ Query Skill=0
```

真正 runtime confirmation：

```text
在 Query Skill runtime 内完成
```

---

# 27. Plugin 不得直接获得 data permission

Plugin 看到：

```text
UNKNOWN
```

只能决定：

```text
“允许进入 Query Skill 做 runtime confirmation”
```

不能决定：

```text
“允许直接执行 data query”
```

因此建议区分：

```text
skillInvocationAllowed
dataExecutionAllowed
```

但不要把这两个字段塞回 Static Validator。

它们属于 orchestration/admission 层。

---

# 28. Plugin UNKNOWN 支持场景调用计数

期望：

```text
Plugin Static Validator      = 1
Query Skill                  = 1

Skill Static Validator       = 1
metricsForGroup              = 1
data query                   = 1
```

如果是：

```text
topValues
```

则：

```text
NapmClient total
= 2
  (1 metadata capability + 1 topValues)
```

不应：

```text
Query Skill=2
```

---

# 29. Plugin UNKNOWN 不支持场景调用计数

期望：

```text
Plugin Static Validator = 1
Query Skill             = 1

Skill Static Validator  = 1
metricsForGroup         = 1
data query              = 0
```

最终：

```text
VALIDATION_FAILURE
reasonCode=RUNTIME_METRIC_UNSUPPORTED
```

---

# 30. Plugin UNKNOWN capability failure

期望：

```text
Query Skill=1
metricsForGroup=1
data query=0
```

最终：

```text
RUNTIME_CAPABILITY_FAILURE
```

不要变成：

```text
NO_DATA
```

---

# 31. Gateway path

`executeGatewayRequest`：

```text
canonical query
↓
static validator
↓
UNKNOWN
↓
RuntimeMetricCapabilityService
↓
SUPPORTED
→ data execution
```

必须保证 runtime capability：

```text
发生在 data query 前
```

---

# 32. Direct path

`executeDirectGatewayRequest` 也必须使用同一 admission 编排。

禁止：

```text
Gateway 支持 UNKNOWN confirmation
Direct 仍然 UNKNOWN→Kernel
```

或：

```text
Direct 直接跳过 RuntimeMetricCapabilityService
```

---

# 33. Prepared proof 与 Phase 5

Phase 4.1 已证明：

```text
prepared proof
```

不可伪造、不可跨实例、不可重复消费。

Phase 5 不要破坏。

如果：

```text
prepareGatewayExecution
```

已经完成：

```text
static validation
+
runtime capability confirmation
```

则 proof 可以代表：

```text
“当前 canonical query 在当前 admission 流程已完成 capability gate”
```

但 proof 必须继续：

```text
instance-local
one-time
non-serializable
```

---

# 34. Proof 不得缓存 runtime capability 到未来请求

proof 只对：

```text
本次 prepare → execute
```

生效。

不能：

```text
下一个独立 query
```

继续使用。

---

# 35. Overview / child query

每一个 child query 都是独立 canonical query。

如果 child：

```text
Static=UNKNOWN
```

则 child 自己：

```text
metricsForGroup
→ capability confirmation
```

不能因为 root query 已 VALID：

```text
child 自动获得许可
```

---

# 36. Overview child capability 调用去重边界

同一个 child execution 内：

```text
同一路径多个 unknown metrics
→ metricsForGroup 1 次
```

不同 child：

```text
默认各自独立
```

Phase 5 不新增跨-child 全局 cache。

如果现有 request-level context 很容易安全共享：

```text
可选
```

但不是本轮必须目标。

---

# 37. `KNOWN_COMPATIBLE` 绝不调用 runtime metadata

使用 verified baseline fixture：

```text
WebApplication + PGTME
→ static VALID
```

必须：

```text
metricsForGroup=0
data=1
```

不要为了“保险”又确认一遍 runtime。

否则 Phase 1 static truth source 失去意义。

---

# 38. `KNOWN_INCOMPATIBLE` 绝不调用 runtime metadata

verified baseline：

```text
WebApplication + TRTI
→ KNOWN_INCOMPATIBLE
```

必须：

```text
metricsForGroup=0
data=0
```

即使真实 device 某次返回 TRTI：

```text
也不能让 runtime evidence 覆盖静态明确禁止
```

静态明确禁止优先级更高。

---

# 39. `METRIC_UNKNOWN` 绝不调用 runtime metadata

```text
PGSUPERFAST
```

必须：

```text
Metric Catalog → METRIC_UNKNOWN
metricsForGroup=0
data=0
```

不要问设备：

```text
“你认识这个系统都不认识的 metric 吗？”
```

---

# 40. Runtime metadata 不能覆盖 Static KNOWN_INCOMPATIBLE

Phase 5 优先级固定：

```text
Static KNOWN_INCOMPATIBLE
> Runtime evidence
```

也就是说：

```text
static DENY
→ STOP
```

不存在：

```text
static deny
→ metricsForGroup says yes
→ allow
```

---

# 41. Runtime evidence 只补 Static UNKNOWN

它不是 repair。

这是 Phase 5 的最重要语义：

```text
runtime evidence
只能把 UNKNOWN
→ SUPPORTED / UNSUPPORTED / INDETERMINATE
```

不能改变：

```text
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
CONTRACT_INVALID
```

---

# 42. 多指标 runtime confirmation

例如 static result：

```text
metrics=[
  PGNPGE,
  PGTME
]
topMetric=PGTME
```

两个 metric 都 UNKNOWN。

同一路径：

```text
metricsForGroup=1
```

返回：

```text
PGNPGE
PGTME
...
```

则：

```text
全部 SUPPORTED
→ ALLOW
```

---

# 43. 多指标有一项 runtime 不支持

例如返回：

```text
PGNPGE
```

但没有：

```text
PGTME
```

则：

```text
PGNPGE=SUPPORTED
PGTME=UNSUPPORTED

overall:
DENY_RUNTIME_UNSUPPORTED
```

不能：

```text
删除 PGTME
继续查询 PGNPGE
```

不 repair。

---

# 44. 独立 topMetric runtime confirmation

继续保持 Phase 3：

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

如果 static 全部 UNKNOWN，

`metricsForGroup` 返回：

```text
TPI
TPO
TPIO
```

则：

```text
ALLOW
```

不要求：

```text
topMetric ∈ metrics[]
```

---

# 45. topMetric runtime unsupported

如果：

```text
TPI
TPO
```

存在，但：

```text
TPIO
```

不在 runtime list：

```text
DENY_RUNTIME_UNSUPPORTED
```

issue：

```text
field=topMetric
role=RANKING_METRIC
metricId=TPIO
```

---

# 46. Runtime issue/evidence schema

建议至少：

```text
provider
metricId
roles[]
service
groupPathSignature
status
```

必要时：

```text
deviceScope
```

例如：

```json
{
  "provider": "METRICS_FOR_GROUP",
  "metricId": "TPIO",
  "roles": ["RANKING_METRIC"],
  "service": "topValues",
  "groupPathSignature": "DefinedApp",
  "status": "UNSUPPORTED"
}
```

---

# 47. Runtime evidence 不应伪装成 Static Validator result

不要返回：

```text
KNOWN_COMPATIBLE
```

作为 runtime 结果。

推荐保持来源清晰：

```text
STATIC:
KNOWN_COMPATIBLE / KNOWN_INCOMPATIBLE / UNKNOWN

RUNTIME:
SUPPORTED / UNSUPPORTED / INDETERMINATE
```

最终 admission 再汇总。

---

# 48. `metricsForGroup` metadata failure 与 data execution failure 分开

本轮至少确保：

```text
capability metadata failed
```

不会变成：

```text
data EXECUTION_FAILURE
```

因为：

```text
data 请求根本没发
```

建议保留明确：

```text
stage=runtime_capability
```

方便后续 Error Contract。

---

# 49. 不要复用 `NO_DATA`

以下都不能：

```text
Runtime UNSUPPORTED
Runtime INDETERMINATE
Metric unknown
Static incompatible
```

映射为：

```text
NO_DATA
```

只有未来真正执行了合法 data query 且返回 0 行：

```text
才可能是 NO_DATA
```

---

# 50. 本轮对 NapmMetadataService 的边界

可以：

```text
复用现有 metricsForGroup 调用
```

但不要：

```text
拆 metadata service
改 service overload
大规模重构 metadata architecture
```

Phase 5 只需要一个可靠 capability provider。

---

# 51. 本轮不允许附带调用其他 metadata

Runtime capability confirmation 的最小目标：

```text
metricsForGroup
```

不要顺手调用：

```text
applications
groups
groupArguments
metrics
granularities
businessGroups
```

除非当前已有 canonical group path builder 必须依赖某个本地缓存，但不应为 P5 再发额外 southbound。

目标调用：

```text
UNKNOWN
→ metricsForGroup exactly once per unique exact path
```

---

# 52. Phase 4.1 两个补强回归顺手补齐

上一轮 Review 留有两个非阻塞增强项。

本轮请显式增加：

```text
METRIC_UNKNOWN × executeGatewayRequest
→ metricsForGroup=0
→ data=0
→ NapmClient=0
```

以及：

```text
UNKNOWN × executeDirectGatewayRequest
→ Phase 5:
metricsForGroup=1
→ supported/unsupported 分别验证
```

这样三入口 × 状态矩阵更完整。

---

# 53. Runtime Service 单测：SUPPORTED

Mock：

```text
metricsForGroup
→ [
  {Id:"PGTME"},
  {Id:"PGNPGE"}
]
```

check：

```text
PGTME
```

期望：

```text
SUPPORTED
```

---

# 54. Runtime Service 单测：UNSUPPORTED

Mock：

```text
metricsForGroup
→ [
  {Id:"PGNPGE"}
]
```

check：

```text
PGTME
```

期望：

```text
UNSUPPORTED
```

---

# 55. Runtime Service 单测：空合法列表

Mock：

```text
metricsForGroup
→ []
```

响应本身：

```text
成功 + schema 合法
```

期望：

```text
PGTME → UNSUPPORTED
```

---

# 56. Runtime Service 单测：metadata failure

Mock：

```text
metricsForGroup
throws network error
```

期望：

```text
INDETERMINATE
RUNTIME_CAPABILITY_FAILURE
data calls=0
```

---

# 57. Runtime Service 单测：malformed response

例如：

```text
metricsForGroup
→ HTML / invalid shape / parse failure
```

期望：

```text
INDETERMINATE
```

不是：

```text
UNSUPPORTED
```

---

# 58. Runtime Service 单测：多指标同一路径去重

required checks：

```text
PGNPGE
PGTME RETURN_METRIC
PGTME RANKING_METRIC
```

期望：

```text
metricsForGroup calls=1
```

并：

```text
PGTME roles 合并
```

---

# 59. Runtime Service 单测：不同路径

如果测试可构造两个 distinct capability path：

```text
path A
path B
```

期望：

```text
metricsForGroup calls=2
```

即：

```text
1 call / unique exact path
```

如果当前 Canonical ResolvedQuery 天然只有一个 path：

```text
无需为了测试强造 multi-path query
```

只证明单路径去重。

---

# 60. Gateway 集成测试：UNKNOWN → SUPPORTED

无 trusted static baseline：

```text
WebApplication
metrics=[PGTME]
topMetric=PGTME
```

Static：

```text
UNKNOWN
```

Runtime mock：

```text
metricsForGroup includes PGTME
```

期望：

```text
Static Validator=UNKNOWN
metricsForGroup=1
Runtime=SUPPORTED
MetricExecutionKernel=1
topValues=1
```

---

# 61. Gateway 集成测试：UNKNOWN → UNSUPPORTED

同样 query。

Runtime mock：

```text
metricsForGroup excludes PGTME
```

期望：

```text
metricsForGroup=1
Kernel=0
topValues=0
outcome=VALIDATION_FAILURE
reasonCode=RUNTIME_METRIC_UNSUPPORTED
```

---

# 62. Gateway 集成测试：UNKNOWN → FAILURE

Runtime mock：

```text
metricsForGroup throws
```

期望：

```text
metricsForGroup=1
Kernel=0
data=0
outcome=RUNTIME_CAPABILITY_FAILURE
```

---

# 63. Direct 集成测试：UNKNOWN → SUPPORTED

`executeDirectGatewayRequest`：

```text
Static UNKNOWN
metricsForGroup=1
SUPPORTED
Kernel=1
data=1
```

不能要求 caller 先走 Gateway。

Direct 自身必须安全。

---

# 64. Direct 集成测试：UNKNOWN → UNSUPPORTED

期望：

```text
metricsForGroup=1
Kernel=0
data=0
```

---

# 65. Plugin 集成测试：UNKNOWN → SUPPORTED

必须验证：

```text
Plugin does not call metadata directly
Query Skill=1

inside Skill:
metricsForGroup=1
data=1
```

Plugin 不应：

```text
Query Skill=2
```

---

# 66. Plugin 集成测试：UNKNOWN → UNSUPPORTED

期望：

```text
Query Skill=1
metricsForGroup=1
data=0
```

Plugin 最终拿到：

```text
VALIDATION_FAILURE
RUNTIME_METRIC_UNSUPPORTED
```

---

# 67. Plugin 静态 INVALID 非回归

verified baseline：

```text
WebApplication + TRTI
→ KNOWN_INCOMPATIBLE
```

必须继续：

```text
Query Skill=0
metricsForGroup=0
data=0
```

P5 不能让 runtime path 削弱 P4 Static Gate。

---

# 68. Plugin METRIC_UNKNOWN 非回归

```text
PGSUPERFAST
```

继续：

```text
Query Skill=0
metricsForGroup=0
```

---

# 69. Static VALID 非回归

verified baseline：

```text
WebApplication + PGTME
→ VALID
```

应：

```text
metricsForGroup=0
data=1
```

---

# 70. `UNKNOWN` 只确认未知项

如果 static result：

```text
PGNPGE = KNOWN_COMPATIBLE
PGTME = UNKNOWN
```

Runtime capability check 只需为：

```text
PGTME
```

生成 evidence。

不要重新确认：

```text
PGNPGE
```

---

# 71. Runtime check 与 static roles

如果：

```text
PGTME
```

既是：

```text
RETURN_METRIC
RANKING_METRIC
```

只确认一次。

evidence：

```text
roles=[
  RETURN_METRIC,
  RANKING_METRIC
]
```

---

# 72. Static Validator 结果必须保留用于审计

最终 admission result 建议同时携带：

```text
staticValidation
runtimeCapability
finalAdmission
```

例如：

```json
{
  "staticValidation": {
    "status": "UNKNOWN"
  },
  "runtimeCapability": {
    "status": "SUPPORTED"
  },
  "finalAdmission": {
    "status": "ALLOW"
  }
}
```

不要覆盖 static result：

```text
UNKNOWN → VALID
```

导致失去 evidence provenance。

---

# 73. QueryDecisionPolicy 的 Phase 5 修改边界

Policy 负责 Plugin 侧 orchestration。

建议：

```text
VALID
→ EXECUTE_QUERY

static failures
→ VALIDATION_FAILURE

UNKNOWN
→ EXECUTE_WITH_RUNTIME_CONFIRMATION
```

如果保持已有：

```text
RUNTIME_CONFIRMATION_REQUIRED
```

也可以，但 Plugin 必须把该 action解释为：

```text
允许 Query Skill 进入 runtime gate
```

而不是最终拒绝。

---

# 74. QueryDecisionPolicy 不调用 `metricsForGroup`

重要：

```text
Plugin Policy
```

不应该因为 P5 直接拿 NapmClient。

真正 runtime confirmation 应在：

```text
Query Skill runtime
```

完成。

否则会出现：

```text
Plugin 一套 metadata access
Skill 又一套 metadata access
```

---

# 75. RequirementParser / Gateway 统一 Runtime Gate

建议新增共享 helper：

```text
evaluateExecutionAdmission()
```

或 Service。

Gateway 和 Direct 都消费。

不能：

```text
Gateway 一套 metricsForGroup
Direct 另一套
```

---

# 76. Runtime capability 失败不得 fallback 放行

禁止：

```text
metricsForGroup failed
→ “先执行 data 看看”
```

必须：

```text
fail closed
→ 0 data
```

---

# 77. Runtime UNSUPPORTED 不自动换 Metric

例如：

```text
WebApplication + TRTI
static UNKNOWN
runtime list 不含 TRTI
```

禁止：

```text
改成 PGTME
```

返回：

```text
RUNTIME_METRIC_UNSUPPORTED
```

---

# 78. Runtime SUPPORTED 不修改 Query

如果支持：

```text
原 canonical query 原样继续
```

不要：

```text
根据 metricsForGroup 排序结果
改变 metrics[]
改变 topMetric
增加其他 metrics
```

---

# 79. capability metadata 不能代替 Metric Catalog

即使 runtime 返回：

```text
PGSUPERFAST
```

但 canonical Metric Catalog 不认识：

```text
Phase 4 已经 METRIC_UNKNOWN
```

因此根本不应调用 `metricsForGroup`。

Runtime metadata 不能扩大 GAIOP 的 Metric vocabulary。

---

# 80. capability metadata 不能覆盖 static ownership deny

再次锁：

```text
Static deny wins.
```

---

# 81. Runtime capability 不处理 pageViews

`pageViews` 没有：

```text
metrics[]
topMetric
```

因此：

```text
不调用 metricsForGroup
```

继续只走其现有 Detail Contract。

不要顺手修 BUG-B。

---

# 82. Metadata services 自身不走 P5

例如：

```text
service=metrics
service=groups
service=applications
```

不是 metric data query。

不要对它们再调用：

```text
metricsForGroup
```

---

# 83. BottomN 非回归

```text
rank_bottom
→ Semantic UNSUPPORTED
→ 没有 Canonical executable Query
```

所以不会进入 P5。

不要因为 runtime metadata 支持某个 metric 就重新实现 BottomN。

---

# 84. Runtime capability 的调用阶段

必须发生：

```text
Canonical Query 已形成
Static Validator 已返回 UNKNOWN
```

之后。

必须发生：

```text
MetricExecutionKernel
```

之前。

调用链：

```text
Canonical Query
→ Static Validator
→ UNKNOWN
→ Runtime Capability
→ Final Admission
→ Kernel
```

---

# 85. Runtime Contract 新保护

`verify:runtime-contract` 至少新增：

```text
RuntimeMetricCapabilityService only consumes UNKNOWN runtime checks

RuntimeMetricCapabilityService uses metricsForGroup provider

KNOWN_COMPATIBLE path cannot call metricsForGroup

KNOWN_INCOMPATIBLE path cannot call metricsForGroup

METRIC_UNKNOWN path cannot call metricsForGroup

CONTRACT_INVALID path cannot call metricsForGroup

Gateway UNKNOWN confirmation before Kernel

Direct UNKNOWN confirmation before Kernel

Plugin UNKNOWN does not access NapmClient directly

Plugin UNKNOWN invokes Query Skill at most once

Runtime service does not mutate canonical Query

Runtime service does not import semantic parser

Runtime metadata failure cannot execute data

Runtime unsupported cannot execute data
```

继续保持 Phase 0～4.1 所有 runtime contracts。

---

# 86. Phase 5 允许修改

预计：

```text
新增：
services/RuntimeMetricCapabilityService.js

可选新增：
services/ResolvedQueryExecutionAdmissionService.js
或等价共享 admission helper

修改：
services/QueryDecisionPolicy.js
services/RequirementParserService.js
run_napm_query.js orchestration
Plugin UNKNOWN action mapping

可能复用/最小修改：
NapmMetadataService.js
NapmClient.js
（仅当已有 metricsForGroup contract 需要小适配）

相关：
tests
runtime-contract
docs / memory
```

---

# 87. Phase 5 禁止修改

不要：

```text
修改 Metric Semantic rules
修改 Ranking grammar
修改 Object Ontology
修改 Metric Catalog truth
修改 Static ownership matrix
放宽 baseline/exhaustive
修改 LegacyMetricInputAdapter 决策表
重构 metadata service 架构
拆 metadata overload
实现 AtomicQueryRepair
新增正式 Serializer
删除 Kernel legacy fallback
重构 Error Contract 全体系
修 NO_DATA 全局 classifier
处理 BUG-B
连接真实 NAPM
部署
提交 commit
```

---

# 88. 关于现有 Metadata Review

如果当前 `reviewGatewayRequestMetadata()` 已经调用：

```text
metricsForGroup
```

Phase 5 要避免：

```text
runtime capability confirmation 调一次
↓
metadata review 又调一次
```

目标：

```text
UNKNOWN capability confirmation
→ metricsForGroup 1 次 / unique path
```

如果后续 metadata review 只是重复做同样 capability check：

```text
应让本次 admission evidence 被当前 request 复用
```

但：

```text
不要重构整个 metadata subsystem
```

只做 request-scoped 去重。

---

# 89. 这一点必须有调用计数测试

UNKNOWN→SUPPORTED 的正常 Gateway：

```text
metricsForGroup total calls = 1
```

不能：

```text
2
```

如果现有 metadata review 还有别的合法 metadata：

```text
分别报告
```

但同一 `metricsForGroup` capability 不能重复。

---

# 90. `applications` / 其他 metadata 不应因 P5 自动增加

P5 不应该为了 runtime capability：

```text
先 applications
再 metricsForGroup
```

只使用 canonical group path 调：

```text
metricsForGroup
```

---

# 91. Phase 5 核心状态矩阵

最终报告必须有：

```markdown
| Static | Runtime | Final Admission | metricsForGroup | Data |
|---|---|---|---:|---:|
| VALID | n/a | ALLOW | 0 | 1 |
| CONTRACT_INVALID | n/a | DENY | 0 | 0 |
| METRIC_UNKNOWN | n/a | DENY | 0 | 0 |
| KNOWN_INCOMPATIBLE | n/a | DENY | 0 | 0 |
| UNKNOWN | SUPPORTED | ALLOW | 1 | 1 |
| UNKNOWN | UNSUPPORTED | DENY_RUNTIME_UNSUPPORTED | 1 | 0 |
| UNKNOWN | INDETERMINATE | RUNTIME_CAPABILITY_FAILURE | 1 | 0 |
```

---

# 92. 三入口 Phase 5 调用矩阵

必须输出：

```markdown
| Entry | Static | Runtime | Query Skill | metricsForGroup | Kernel | Data |
|---|---|---|---:|---:|---:|---:|
| Plugin | UNKNOWN | SUPPORTED | 1 | 1 | 1 | 1 |
| Plugin | UNKNOWN | UNSUPPORTED | 1 | 1 | 0 | 0 |
| Plugin | KNOWN_INCOMPATIBLE | n/a | 0 | 0 | 0 | 0 |
| Gateway | UNKNOWN | SUPPORTED | n/a | 1 | 1 | 1 |
| Gateway | UNKNOWN | UNSUPPORTED | n/a | 1 | 0 | 0 |
| Direct | UNKNOWN | SUPPORTED | n/a | 1 | 1 | 1 |
| Direct | UNKNOWN | UNSUPPORTED | n/a | 1 | 0 | 0 |
```

---

# 93. P4.1 prepared proof 非回归

必须继续通过：

```text
same instance first use
external forged proof
cross-instance proof
replay proof
```

如果 P5 admission evidence 被 proof 携带：

```text
仍必须 one-time / instance-local
```

---

# 94. P3 Canonical Contract 非回归

继续：

```text
canonical query 不含 metric
metrics[] 独立
topMetric 独立
topMetric 不要求在 metrics[]
Legacy Adapter exactly-once
```

---

# 95. P2 Semantic 非回归

核心问句继续：

```text
最近业务访问较慢的前5个业务都有谁？
→ WebApplication
→ PGTME
→ rank_top
→ 5
```

不要在 P5 改任何语义。

---

# 96. 原 BUG-A 在 P5 后的预期状态

正常问句：

```text
最近业务访问较慢的前5个业务都有谁？
```

如果 Static：

```text
KNOWN_COMPATIBLE
```

则：

```text
PGTME
→ no metricsForGroup
→ topValues
```

如果因为 production baseline：

```text
UNKNOWN
```

则：

```text
PGTME
→ metricsForGroup
→ 当前 device/path 支持
→ topValues
```

---

# 97. 错误 `WebApplication + TRTI`

如果 Static verified baseline：

```text
KNOWN_INCOMPATIBLE
→ 0 metricsForGroup
→ 0 data
```

如果 Static：

```text
UNKNOWN
```

则：

```text
metricsForGroup
```

如果 runtime list：

```text
不含 TRTI
```

则：

```text
RUNTIME_METRIC_UNSUPPORTED
→ 0 data
```

如果 runtime list明确含 TRTI：

```text
Runtime SUPPORTED
```

则从纯“当前设备 group capability”角度可进入 data。

但这里必须遵守一个边界：

> 只有 Phase 4 将该 UNKNOWN 标记为可由 `METRICS_FOR_GROUP` 解决时，runtime support 才能提升为 ALLOW。

如果该 UNKNOWN 实际源于：

```text
产品业务口径未覆盖
service-specific static policy 不确定
```

而不是设备 group-metric capability，

则不得仅凭 `metricsForGroup` 放行。

---

# 98. 上述边界必须有测试

构造一个：

```text
UNKNOWN
provider=METRICS_FOR_GROUP
```

→ runtime 可决定。

再构造一个：

```text
UNKNOWN
provider 非 METRICS_FOR_GROUP / 无 provider
```

即使 mock metadata 中有 metric：

```text
也不得 ALLOW
```

---

# 99. 这一步非常关键：不要让 P5 反向绕过 P4

P5 的目标不是：

```text
“只要设备说支持，就什么都能查”
```

而是：

```text
“Static Gate 明确说我不知道，
且明确声明这个未知可以由 metricsForGroup 确认，
才去问设备。”
```

---

# 100. 完成后必须运行

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
Phase 5 runtime capability
```

---

# 101. Phase 5 最终报告格式

完成后立即停止，不进入后续阶段。

## 101.1 Git

```text
branch:
HEAD:
Phase 5 start status:
Phase 5 end status:
Phase 5 files:
```

## 101.2 Runtime Capability Architecture

输出实际链路：

```text
Static Validator
→ UNKNOWN
→ RuntimeMetricCapabilityService
→ metricsForGroup
→ Runtime Evidence
→ Final Admission
→ Kernel
```

列出真实类/函数名。

## 101.3 `metricsForGroup` Provider Contract

明确：

```text
input:
group path params:
response raw shape:
normalized shape:
metric ID field:
```

## 101.4 Runtime Status

```text
SUPPORTED
UNSUPPORTED
INDETERMINATE
```

分别说明：

```text
定义
最终 outcome
是否 data execute
```

## 101.5 Static → Runtime Matrix

输出第 91 节完整矩阵。

## 101.6 Entry Point Matrix

输出第 92 节完整矩阵。

## 101.7 Call Counts

至少真实报告：

### VALID static

```text
metricsForGroup =
data =
```

### KNOWN_INCOMPATIBLE

```text
metricsForGroup =
data =
```

### METRIC_UNKNOWN

```text
metricsForGroup =
data =
```

### UNKNOWN → SUPPORTED

```text
metricsForGroup =
Kernel =
data =
```

### UNKNOWN → UNSUPPORTED

```text
metricsForGroup =
Kernel =
data =
```

### UNKNOWN → INDETERMINATE

```text
metricsForGroup =
Kernel =
data =
```

## 101.8 Multi-Metric Runtime Confirmation

回答：

```text
same-path dedup:
metricsForGroup calls =

metrics[] every unknown item checked:
YES / NO

topMetric independently checked:
YES / NO

roles merged:
YES / NO
```

## 101.9 Provider Guard

回答：

```text
UNKNOWN without METRICS_FOR_GROUP provider
can runtime service allow execution?
YES / NO
```

目标：

```text
NO
```

## 101.10 Metadata Duplication

明确：

```text
UNKNOWN→SUPPORTED
metricsForGroup total calls:
```

目标同一路径：

```text
1
```

如果 >1：

```text
解释原因
```

## 101.11 P4 Static Gate Non-Regression

```text
KNOWN_INCOMPATIBLE zero runtime metadata:
PASS / FAIL

METRIC_UNKNOWN zero runtime metadata:
PASS / FAIL

CONTRACT_INVALID zero runtime metadata:
PASS / FAIL
```

## 101.12 Prepared Proof Non-Regression

```text
same instance:
forged:
cross-instance:
replay:
```

## 101.13 Phase Boundaries

确认：

```text
Metadata architecture refactored: NO
Serializer added: NO
Kernel legacy fallback removed: NO
Error Contract globally refactored: NO
BUG-B touched: NO
Remote NAPM: NO
Deploy: NO
Commit: NO
```

## 101.14 Tests

```text
Phase 0:
Phase 1:
Phase 2:
Phase 2.1:
Phase 3:
Phase 4:
Phase 4.1:
Phase 5:
Full repo:
lint:
runtime-contract:
diff-check:
```

必须给真实：

```text
suite count
test count
PASS/FAIL
```

## 101.15 Phase 5 Completion

```text
YES / NO
```

---

# 102. Phase 5 完成定义

只有全部满足才算完成：

```text
1. RuntimeMetricCapabilityService 只有一个实现
2. Runtime service 只消费 Static UNKNOWN
3. 只有 METRICS_FOR_GROUP provider 的 UNKNOWN 才可由 metricsForGroup 解决
4. VALID 不调用 metricsForGroup
5. KNOWN_INCOMPATIBLE 不调用 metricsForGroup
6. METRIC_UNKNOWN 不调用 metricsForGroup
7. CONTRACT_INVALID 不调用 metricsForGroup
8. UNKNOWN 可调用 metricsForGroup
9. exact group path 参数复用 canonical builder
10. runtime service 不 repair query
11. runtime service 不修改 static truth
12. metricsForGroup 成功且 metric 存在 → SUPPORTED
13. 成功且 metric 不存在 → UNSUPPORTED
14. metadata failure / malformed → INDETERMINATE
15. UNSUPPORTED → 0 data
16. INDETERMINATE → 0 data
17. SUPPORTED → 允许 data
18. 同一路径多个 unknown metrics → metricsForGroup 最多 1 次
19. topMetric 独立 runtime check
20. topMetric 不要求属于 metrics[]
21. Plugin UNKNOWN → Query Skill exactly 1
22. Plugin 不直接访问 NAPM metadata
23. Gateway UNKNOWN 在 Kernel 前 runtime confirm
24. Direct UNKNOWN 在 Kernel 前 runtime confirm
25. Overview child UNKNOWN 独立经过同一 runtime gate
26. Static hard deny 不能被 runtime evidence 覆盖
27. provider 不匹配的 UNKNOWN 不能被 runtime metadata 放行
28. runtime unsupported 不自动换 metric
29. runtime capability failure 不变成 NO_DATA
30. Phase 4 prepared proof 安全保持
31. Phase 3 canonical query contract 保持
32. Phase 2 semantic contract 保持
33. 不进入 Metadata Refactor / Serializer / Kernel Cleanup / Error Contract / BUG-B
34. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 103. 本轮最容易犯的错误

禁止以下实现：

```text
❌ 所有 Query 都先 metricsForGroup

❌ KNOWN_INCOMPATIBLE 再去问 runtime 能不能覆盖

❌ METRIC_UNKNOWN 再去问设备

❌ metricsForGroup 失败后继续 data query

❌ runtime unsupported 后静默换 metric

❌ 一个 metricsForGroup 请求只检查 metrics[0]

❌ 忽略独立 topMetric

❌ Plugin 自己新增 NapmClient

❌ Gateway / Direct 各复制一套 runtime capability 逻辑

❌ RuntimeMetricCapabilityService 修改 canonical Query

❌ 将 runtime support 写回 objectMetricOwnership

❌ 将任何 UNKNOWN 都默认标 provider=METRICS_FOR_GROUP
```

---

# 104. Phase 5 完成后的系统状态

完成后应该形成：

```text
自然语言
↓
Semantic Contract
↓
Canonical Query
↓
Static Validator
↓
┌─────────────────────┐
│ STATIC VALID         │──────────────┐
└─────────────────────┘              │
                                     ↓
                               Data Execution
                                     ↑
┌─────────────────────┐              │
│ STATIC UNKNOWN       │              │
└─────────────────────┘              │
          ↓                          │
  metricsForGroup                    │
          ↓                          │
      SUPPORTED ─────────────────────┘
          │
          ├── UNSUPPORTED
          │      ↓
          │ VALIDATION_FAILURE
          │
          └── INDETERMINATE
                 ↓
          CAPABILITY_FAILURE

STATIC INVALID
↓
VALIDATION_FAILURE
↓
0 southbound
```

---

# 105. 本轮结束

完成：

```text
Phase 5：Runtime Metric Capability Confirmation
```

后立即停止。

不要继续做：

```text
Atomic Repair
Serializer / Kernel Cleanup
Error Contract
Legacy Cleanup
BUG-B
```

提交 Phase 5 实施报告，等待 Review。
