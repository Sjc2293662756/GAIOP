# GAIOP NAPM BUG-A 实施指令 — Phase 8：Unified Error Contract + Remaining Legacy Cleanup + Final BUG-A Regression

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
> - Phase 7：PASS
> - Phase 7.1：PASS
> - Phase 8：GO
>
> 当前真实执行链已经收口为：
>
> ```text
> Natural Language
> → Canonical Semantic Contract
> → Semantic Lifecycle
> → Canonical ResolvedQuery
> → Atomic Safe Repair
> → ResolvedQueryContract
> → Static Executable Validator
> → Runtime Capability（仅 UNKNOWN）
> → Final Admission
> → NapmQuerySerializer
> → GroupBuilder
> → MetricExecutionKernel / PageViewsExecutionKernel
> → NapmClient
> → HTTP
> ```
>
> Phase 7.1 已确认：
>
> ```text
> production group encoder = 1
> production metrics comma encoder = 1
> topMetric || metric = 0
> Kernel metrics[0] execution truth = 0
> Kernel queryModeKey routing = 0
> Kernel legacy metric read = 0
> Serializer legacy metric value read = 0
> NapmClient metric business read = 0
> ```
>
> 本轮是 BUG-A 的**最终收口阶段**。
>
> 核心目标：
>
> > **统一“失败到底是什么失败”，删除已经被新架构替代的 legacy / duplicate / dead logic，并通过最终端到端回归证明原始 BUG-A 已闭环。**
>
> 本轮完成后：
>
> ```text
> BUG-A 应进入 DONE / FINAL PASS
> ```
>
> `PageFamily → pageViews` 的 BUG-B 仍作为独立问题，不在本轮修复。

---

# 0. Phase 8 的三大任务

本轮只做三类工作：

```text
A. Unified Error / Outcome Contract
B. Remaining Legacy / Duplicate Truth Cleanup
C. Final BUG-A End-to-End Regression
```

本轮不再新增新的业务架构层。

如果发现必须新增大量新 Service 才能完成 Phase 8：

```text
先停下来报告
不要继续堆抽象
```

---

# 1. Phase 8 的最终目标状态

BUG-A 最终必须形成：

```text
用户语义错误 / Query 不合法
→ VALIDATION_FAILURE

运行时能力无法确认
→ RUNTIME_CAPABILITY_FAILURE

Serializer / transport DTO invariant 失败
→ SERIALIZATION_FAILURE

合法 Query 真正发出 data 请求，但 HTTP / transport / parse 失败
→ EXECUTION_FAILURE

合法 Query 真正执行成功，结果为 0 行
→ NO_DATA

合法 Query 真正执行成功，结果非空
→ SUCCESS
```

最关键的是：

```text
VALIDATION_FAILURE ≠ NO_DATA
RUNTIME_CAPABILITY_FAILURE ≠ NO_DATA
SERIALIZATION_FAILURE ≠ NO_DATA
EXECUTION_FAILURE ≠ NO_DATA
```

---

# 2. 本轮禁止事项

不要：

```text
修改 Metric Semantic 业务规则
修改 Ranking Grammar
修改 Object Ontology
扩大 Metric Catalog
修改 Object×Metric ownership 业务结论
放宽 supportedProductBaseline/exhaustive
修改 Runtime Capability provider 语义
扩大 Atomic Repair allowlist 到语义替换
重构 HTTP library / retry / auth / TLS
处理 BUG-B
连接真实 NAPM
部署
重启
自动 commit
```

除非本轮最终 Review 后另行授权。

---

# 3. 开始前记录 Git 基线

执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --numstat
git diff --check
```

建议额外保存：

```text
Phase 8 start snapshot
```

方便本轮单独统计新增/删除。

报告：

```text
branch:
HEAD:
Phase 8 start status:
Phase 8 start diff stat:
```

禁止：

```text
reset
stash
覆盖已有修改
```

---

# 4. 先做 Outcome / Error Consumer Audit

修改前搜索：

```bash
rg "NO_DATA|VALIDATION_FAILURE|EXECUTION_FAILURE|RUNTIME_CAPABILITY|SERIALIZATION_FAILURE|reasonCode|errorCode|outcome|status" \
  skills/openclaw-napm-query \
  napm-openclaw-plugin.remote.js
```

重点审计：

```text
QueryDecisionPolicy
RequirementParserService
ResolvedQueryExecutionAdmissionService
RuntimeMetricCapabilityService
AtomicQueryRepairService
NapmQuerySerializer
MetricExecutionKernel
PageViewsExecutionKernel
run_napm_query.js
Plugin / Hook
result narration / summary
```

输出：

```markdown
| Layer | Current outcome/error shape | Can emit NO_DATA? | Can emit validation failure? | P8 action |
|---|---|---:|---:|---|
| Plugin | ... | ... | ... | ... |
| Skill runtime | ... | ... | ... | ... |
| Kernel | ... | ... | ... | ... |
| Narration | ... | ... | ... | ... |
```

---

# 5. 新增/收口唯一 Unified Outcome Contract

建议：

```text
services/ExecutionOutcomeContract.js
```

或项目风格下等价模块。

它只定义：

```text
top-level outcome enum
reasonCode taxonomy
stage taxonomy
required structured fields
```

它不负责：

```text
解析自然语言
决定 metric
决定 object
做 repair
调用 southbound
```

---

# 6. Top-Level Outcome Enum

建议最终只保留：

```text
SUCCESS
NO_DATA
VALIDATION_FAILURE
RUNTIME_CAPABILITY_FAILURE
SERIALIZATION_FAILURE
EXECUTION_FAILURE
```

如项目已有明确的：

```text
UNSUPPORTED
AMBIGUOUS
UNRESOLVED
```

这些属于 Semantic Lifecycle，不要混进“已形成 executable query 后的 execution outcome”。

---

# 7. Semantic Lifecycle 与 Execution Outcome 必须分层

Semantic 阶段：

```text
RESOLVED
AMBIGUOUS
UNRESOLVED
UNSUPPORTED
```

Execution 阶段：

```text
SUCCESS
NO_DATA
VALIDATION_FAILURE
RUNTIME_CAPABILITY_FAILURE
SERIALIZATION_FAILURE
EXECUTION_FAILURE
```

禁止：

```text
AMBIGUOUS → NO_DATA
UNSUPPORTED → EXECUTION_FAILURE
```

---

# 8. `VALIDATION_FAILURE` 的覆盖范围

统一包含：

```text
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
RUNTIME_METRIC_UNSUPPORTED
REPAIR_REJECTED（若来源是 Query 本身不可安全规范化）
POST_REPAIR_VALIDATION_FAILED
canonical field conflict
```

但保留具体：

```text
reasonCode
stage
issues[]
```

例如：

```json
{
  "outcome": "VALIDATION_FAILURE",
  "stage": "static_validation",
  "reasonCode": "OBJECT_METRIC_INCOMPATIBLE"
}
```

---

# 9. `RUNTIME_CAPABILITY_FAILURE`

仅表示：

```text
Static = UNKNOWN
且需要 runtime provider
但 provider 无法给出可靠结论
```

例如：

```text
metricsForGroup 网络失败
HTTP 失败
响应 malformed
schema 不可判定
provider mismatch / unavailable
```

注意：

```text
runtime 明确 UNSUPPORTED
```

不是 capability failure，而是：

```text
VALIDATION_FAILURE
reasonCode=RUNTIME_METRIC_UNSUPPORTED
```

---

# 10. `SERIALIZATION_FAILURE`

只用于：

```text
Final Admission 已 ALLOW
但 Canonical Query → NAPM transport DTO 出现内部 invariant failure
```

例如：

```text
serializer 不支持该 service
group encoder 内部 invariant broken
transport DTO 无法生成
```

它不是：

```text
用户无数据
```

也不是：

```text
runtime capability failure
```

---

# 11. `EXECUTION_FAILURE`

只有在：

```text
数据请求真正进入 NapmClient / HTTP execution
```

之后发生失败才使用。

覆盖：

```text
network error
HTTP error
timeout
response parse failure
unexpected data response shape
```

不要用它表示：

```text
Static invalid
Runtime unsupported
Serializer failure
```

---

# 12. `NO_DATA` 的严格定义

只有全部满足：

```text
1. Canonical Query 合法
2. Final Admission = ALLOW
3. Serializer 成功
4. Data request 真正发送
5. HTTP / transport 成功
6. Response parse 成功
7. Result collection 明确为合法空结果
```

才允许：

```text
NO_DATA
```

---

# 13. `NO_DATA` 必须有 Data-Call Proof

建议结果上下文保留：

```text
dataRequestAttempted=true
dataRequestSucceeded=true
rowCount=0
```

不一定对外暴露全部字段，但测试必须能证明。

禁止：

```text
dataRequestAttempted=false
→ NO_DATA
```

---

# 14. Zero-Call Failure 永远不能是 NO_DATA

以下所有场景：

```text
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
RUNTIME_METRIC_UNSUPPORTED
RUNTIME_CAPABILITY_FAILURE
REPAIR_REJECTED
SERIALIZATION_FAILURE
```

都必须：

```text
NO_DATA = false
```

---

# 15. Error ReasonCode 不要无限扩散

Top-level outcome 应稳定。

`reasonCode` 可以细分，但必须集中定义。

建议按 stage 分类：

```text
SEMANTIC_*
VALIDATION_*
RUNTIME_*
REPAIR_*
SERIALIZATION_*
EXECUTION_*
```

不要让各模块自由拼字符串。

---

# 16. 建立唯一 ReasonCode Registry

建议同一个 Outcome Contract 中维护：

```text
known reason codes
```

或单独：

```text
ExecutionReasonCodes.js
```

但不要多套。

---

# 17. Stage Taxonomy

建议：

```text
semantic
canonicalization
repair
contract_validation
static_validation
runtime_capability
serialization
execution
response_parse
```

输出必须可追溯。

---

# 18. Structured Error / Outcome Shape

建议统一：

```json
{
  "ok": false,
  "outcome": "VALIDATION_FAILURE",
  "stage": "static_validation",
  "reasonCode": "OBJECT_METRIC_INCOMPATIBLE",
  "issues": [],
  "queryExecuted": false,
  "dataRequestAttempted": false
}
```

成功：

```json
{
  "ok": true,
  "outcome": "SUCCESS",
  "stage": "execution",
  "queryExecuted": true,
  "dataRequestAttempted": true,
  "rowCount": 5
}
```

空数据：

```json
{
  "ok": true,
  "outcome": "NO_DATA",
  "stage": "execution",
  "queryExecuted": true,
  "dataRequestAttempted": true,
  "rowCount": 0
}
```

---

# 19. 不强制所有内部 Service 改成同一个大对象

内部组件可以保留自己的：

```text
Static status
Runtime status
Repair status
Serializer status
```

但跨层输出到：

```text
Skill Runtime / Plugin / Narration
```

时必须经过唯一 Outcome Mapper。

---

# 20. 新增/收口 Outcome Mapper

建议：

```text
ExecutionOutcomeMapper
```

职责：

```text
internal stage result
→ unified external execution outcome
```

它不改变事实，只映射。

不要让：

```text
Plugin 一套
Runner 一套
Narration 又一套
```

---

# 21. Plugin / Hook 必须消费统一 Outcome

Plugin 不再根据：

```text
字符串包含
rows.length
error.message
```

自行猜：

```text
NO_DATA / VALIDATION_FAILURE
```

统一消费 structured outcome。

---

# 22. Narration / Final Answer 不能覆盖 Outcome

如果 outcome：

```text
VALIDATION_FAILURE
```

Narration 不能写：

```text
“未查到数据”
```

如果：

```text
RUNTIME_CAPABILITY_FAILURE
```

不能写：

```text
“没有符合条件的数据”
```

---

# 23. 统一用户可见语义

建议：

```text
VALIDATION_FAILURE
→ 查询口径/参数不合法或当前对象不支持该指标

RUNTIME_CAPABILITY_FAILURE
→ 当前无法确认设备在该对象路径上的指标能力

SERIALIZATION_FAILURE
→ 查询已通过校验，但请求参数生成失败

EXECUTION_FAILURE
→ 查询已发出，但南向请求/响应失败

NO_DATA
→ 查询成功执行，但当前时间范围没有数据
```

具体中文文案可由现有 narration 层处理。

---

# 24. Outcome 必须在 Plugin / Gateway / Direct 一致

同一失败条件：

```text
Plugin
Gateway
Direct
```

必须得到：

```text
同一 top-level outcome
同一核心 reasonCode
```

允许：

```text
不同 trace context
```

---

# 25. Final Error Matrix

必须建立测试：

```markdown
| Scenario | Data Call | Outcome | Reason |
|---|---:|---|---|
| CONTRACT_INVALID | 0 | VALIDATION_FAILURE | ... |
| METRIC_UNKNOWN | 0 | VALIDATION_FAILURE | METRIC_UNKNOWN |
| KNOWN_INCOMPATIBLE | 0 | VALIDATION_FAILURE | OBJECT_METRIC_INCOMPATIBLE |
| Runtime UNSUPPORTED | 0 | VALIDATION_FAILURE | RUNTIME_METRIC_UNSUPPORTED |
| Runtime provider failure | 0 | RUNTIME_CAPABILITY_FAILURE | ... |
| Repair rejected | 0 | VALIDATION_FAILURE | REPAIR_REJECTED/... |
| Serializer failure | 0 | SERIALIZATION_FAILURE | ... |
| Data HTTP/network failure | 1 | EXECUTION_FAILURE | ... |
| Data parse failure | 1 | EXECUTION_FAILURE | ... |
| Valid empty response | 1 | NO_DATA | none/NO_DATA |
| Valid rows | 1 | SUCCESS | none |
```

---

# 26. Remaining Legacy / Duplicate Truth Cleanup — 总原则

P8 是减法阶段。

每个 legacy / duplicate / dead path 必须分类：

```text
KEEP
DEPRECATE
DELETE
```

不能继续：

```text
“先放着以后再说”
```

---

# 27. LegacyMetricInputAdapter

P7.1 已确认它仍有生产 caller。

P8 必须查明：

```text
具体 caller 是谁
是否确实属于生产入口
是否可以迁移到 canonical
```

执行：

```bash
rg "LegacyMetricInputAdapter|metric:" .
```

输出 caller graph。

如果所有 production caller 都能安全迁移：

```text
迁移 caller
删除 LegacyMetricInputAdapter
删除 legacy branch
```

如果仍有仓库外/不可迁移 caller：

```text
KEEP_TEMPORARILY
```

并明确：

```text
边界
deprecation reason
removal condition
```

---

# 28. Summary `metric` / `metrics[0]`

P7.1 已确认：

```text
run_napm_query summary
```

仍存在展示兼容逻辑。

P8 必须判断：

```text
是否还有 consumer 依赖单数 metric？
```

如果 NO：

```text
删除
```

如果 YES：

```text
改名为 displayPrimaryMetric / summaryMetric
```

并保证：

```text
任何 execution code 都不读取
```

---

# 29. QueryMetadataConstraintService 的 `metrics[0]`

P7.1 已确认该处仍存在。

P8 必须消除：

```text
metrics[0] 代表整个 Query compatibility truth
```

优先：

```text
删除重复 compatibility 判断
消费 Shared Validator / Runtime evidence
```

若仅用于展示：

```text
改成非权威 summary
```

---

# 30. RequirementParserService 旧 compatibility 读取

审计：

```text
metric
metrics[0]
default metric
fallback object
queryModeKey
```

分类：

```text
semantic compatibility
execution dependency
dead code
```

凡是 P2–P7 已替代的 execution dependency：

```text
删除
```

---

# 31. 旧 TagNormalizer

执行：

```bash
rg "TagNormalizer" .
```

若：

```text
production caller = 0
```

且主链已由：

```text
Resolution Spec + MetricSemanticNormalizer
```

接管：

```text
DELETE
```

否则说明其不可替代职责。

---

# 32. Resolver `inferMetric()` / 独立 alias 推断

执行：

```bash
rg "inferMetric|metricAliases|metric alias" \
  skills/openclaw-napm-query/services
```

若 Resolver 仍自行决定业务指标：

```text
Phase 8 FAIL
```

必须：

```text
删除 / 降级为只消费 structured semantic
```

---

# 33. 默认对象补位

执行：

```bash
rg "defaultTargetObjectType|IPAddress" \
  skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js
```

若仍有：

```text
缺对象 → 默认 IPAddress → executable query
```

必须删除。

P2.1 已要求 fail closed。

---

# 34. root vs skill-local Spec / Ontology

审计：

```text
Resolution Spec
Object Ontology
```

回答：

```text
runtime 真正读取哪一份
另一份是否能影响 runtime
是否存在 drift
```

规则：

```text
两份都能影响 runtime → FAIL
一份 docs/generator source → 明确标识并加 drift guard
dead copy → DELETE
```

---

# 35. Ownership / Metric Domain 角色再次锁死

最终必须保持：

```text
objectMetricOwnership
= static execution compatibility truth

metricDomains
= classification/display/recommendation only

Resolution Spec
= semantic/service contract

DimensionMappingService
= query wrapper，不保存第二矩阵
```

任何第二 hard-gate truth：

```text
删除
```

---

# 36. Warning-Based Control Flow

执行：

```bash
rg "warning.*includes|includes\\(.*warning|metric_group_incompatible_but_preserve" .
```

目标：

```text
warning string → execution decision
count = 0
```

---

# 37. Dead Code Sweep

重点：

```text
旧 validator wrapper
旧 metric normalizer
旧 query builder
旧 serializer
旧 status mapper
旧 fallback helper
```

删除标准：

```text
production caller = 0
且不是公开 contract
且不是 migration boundary
```

---

# 38. P8 删除统计

必须用 Phase 8 start/end snapshot 输出：

```markdown
| Category | Added | Deleted | Net |
|---|---:|---:|---:|
| Production | ... | ... | ... |
| Tests | ... | ... | ... |
| Docs/Contracts | ... | ... | ... |
```

并列出：

```text
deleted legacy logic
deleted dead code
deleted duplicate truth source
retained migration boundary
```

---

# 39. Final Truth-Source Audit

最终必须输出：

```markdown
| Concern | Single Truth Source |
|---|---|
| Natural-language metric semantics | Resolution Spec + MetricSemanticNormalizer |
| Semantic lifecycle | Canonical Semantic Contract lifecycle |
| Query shape | ResolvedQueryContract |
| Static object×metric compatibility | objectMetricOwnership |
| Runtime metric capability | RuntimeMetricCapabilityService + metricsForGroup |
| Safe deterministic repair | AtomicQueryRepairService |
| NAPM request serialization | NapmQuerySerializer |
| Group transport encoding | GroupBuilder |
| Execution outcome | ExecutionOutcomeContract / Mapper |
```

任何 concern 有两个 production truth source：

```text
Phase 8 FAIL
```

---

# 40. Final BUG-A Regression：原始问句

必须覆盖：

```text
最近业务访问较慢的前5个业务都有谁？
```

期望 Semantic：

```text
operation=rank_top
targetObjectType=WebApplication
requestedMetrics=[PGTME]
rankingMetric=PGTME
topCount=5
```

Canonical：

```json
{
  "service": "topValues",
  "groups": [
    {"type": "WebApplication"}
  ],
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "topCount": 5
}
```

不含：

```text
metric
```

---

# 41. 原始问句 Static VALID

verified baseline：

```text
WebApplication + PGTME
→ VALID
→ metricsForGroup=0
→ Serializer=1
→ Data=1
```

Outcome：

```text
SUCCESS 或 NO_DATA
```

取决于 fixture 数据。

---

# 42. 原始问句 Static UNKNOWN

无可信 baseline：

```text
WebApplication + PGTME
→ UNKNOWN
→ provider=METRICS_FOR_GROUP
→ metricsForGroup=1
```

runtime 支持：

```text
→ Serializer=1
→ Data=1
```

---

# 43. 错误 Query：`WebApplication + TRTI`

verified baseline：

```text
KNOWN_INCOMPATIBLE
```

必须：

```text
Outcome=VALIDATION_FAILURE
reasonCode=OBJECT_METRIC_INCOMPATIBLE
Serializer=0
Data=0
```

绝不能：

```text
NO_DATA
```

---

# 44. Static UNKNOWN + Runtime Unsupported

```text
WebApplication + TRTI
→ Static UNKNOWN
→ metricsForGroup=1
→ runtime list 不含 TRTI
```

必须：

```text
VALIDATION_FAILURE
reasonCode=RUNTIME_METRIC_UNSUPPORTED
Data=0
```

---

# 45. METRIC_UNKNOWN

```text
PGSUPERFAST
```

必须：

```text
VALIDATION_FAILURE
reasonCode=METRIC_UNKNOWN
metricsForGroup=0
Serializer=0
Data=0
```

---

# 46. Multi-Metric TopN

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

必须合法：

```text
transport metrics=TPI,TPO
transport topMetric=TPIO
```

不要求：

```text
TPIO ∈ metrics[]
```

---

# 47. Multi-Metric One Invalid

```text
WebApplication
metrics=[PGNPGE,TRTI]
topMetric=PGTME
```

verified baseline：

```text
VALIDATION_FAILURE
issue → metrics[1]=TRTI
Data=0
```

不能删掉 TRTI 后继续。

---

# 48. Ranking Metric Invalid

```text
metrics=[PGNPGE,PGTME]
topMetric=TRTI
```

必须：

```text
VALIDATION_FAILURE
role=RANKING_METRIC
Data=0
```

---

# 49. Runtime Capability Failure

```text
Static UNKNOWN
metricsForGroup throws / malformed
```

必须：

```text
RUNTIME_CAPABILITY_FAILURE
Serializer=0
Data=0
```

绝不能：

```text
NO_DATA
```

---

# 50. Serializer Failure

构造：

```text
Final Admission=ALLOW
但 serializer invariant failure fixture
```

必须：

```text
SERIALIZATION_FAILURE
NapmClient data=0
```

---

# 51. Data Execution Failure

合法 admitted query：

```text
Serializer success
Data request attempted
```

mock：

```text
network error
HTTP error
timeout
```

必须：

```text
EXECUTION_FAILURE
```

---

# 52. Parse Failure

HTTP 成功但 data response malformed：

```text
EXECUTION_FAILURE
stage=response_parse
```

不能：

```text
NO_DATA
```

---

# 53. 真正 NO_DATA

合法 query：

```text
Final Admission=ALLOW
Serializer success
Data call=1
HTTP success
parse success
rows=[]
```

必须：

```text
NO_DATA
```

---

# 54. SUCCESS

合法 query：

```text
rows > 0
```

必须：

```text
SUCCESS
```

---

# 55. NO_DATA 不触发 Repair

必须：

```text
NO_DATA
→ post-data Repair calls=0
→ second Data call=0
```

---

# 56. 三入口 Outcome 一致性

同一 fixture：

```text
Plugin
Gateway
Direct
```

必须得到：

```text
同一 top-level outcome
同类 reasonCode
```

至少测试：

```text
KNOWN_INCOMPATIBLE
Runtime UNSUPPORTED
NO_DATA
EXECUTION_FAILURE
```

---

# 57. Narration Contract

至少锁：

```text
VALIDATION_FAILURE 文案不能表达“未查到数据”
RUNTIME_CAPABILITY_FAILURE 文案不能表达“没有数据”
EXECUTION_FAILURE 文案不能表达“没有数据”
NO_DATA 才允许表达“当前无数据”
```

不要求固定整句文案。

---

# 58. Final Zero-Call / Call Matrix

最终报告：

```markdown
| Scenario | Query Skill | metricsForGroup | Serializer | Data | Outcome |
|---|---:|---:|---:|---:|---|
| Static valid + rows | ... | 0 | 1 | 1 | SUCCESS |
| Static valid + empty | ... | 0 | 1 | 1 | NO_DATA |
| Static incompatible | ... | 0 | 0 | 0 | VALIDATION_FAILURE |
| Metric unknown | ... | 0 | 0 | 0 | VALIDATION_FAILURE |
| Runtime supported | ... | 1 | 1 | 1 | SUCCESS/NO_DATA |
| Runtime unsupported | ... | 1 | 0 | 0 | VALIDATION_FAILURE |
| Runtime failure | ... | 1 | 0 | 0 | RUNTIME_CAPABILITY_FAILURE |
| Serializer failure | ... | 0/1 | 1 | 0 | SERIALIZATION_FAILURE |
| Data network failure | ... | 0/1 | 1 | 1 attempted | EXECUTION_FAILURE |
```

---

# 59. Final Legacy Audit 搜索

执行：

```bash
rg "topMetric.*\\|\\|.*metric|metric.*\\|\\|.*topMetric" .
rg "metrics\\s*\\[\\s*0\\s*\\]" skills/openclaw-napm-query
rg "inferMetric" .
rg "TagNormalizer" .
rg "defaultTargetObjectType" .
rg "metric_group_incompatible_but_preserve" .
rg "LegacyMetricInputAdapter" .
rg "queryModeKey" skills/openclaw-napm-query/services
```

逐项分类：

```text
execution truth
semantic compatibility
display-only
dead
migration boundary
```

---

# 60. Final `metric` Audit

输出：

```markdown
| Location | Reads legacy metric | Production caller | Category | Action |
|---|---:|---:|---|---|
| LegacyMetricInputAdapter | ... | ... | migration | ... |
| Kernel | NO | ... | execution | ... |
| Serializer | NO | ... | execution | ... |
| Client data | NO | ... | transport | ... |
| Summary | ... | ... | display | ... |
```

---

# 61. Final `metrics[0]` Audit

禁止剩余用途：

```text
execution truth
static compatibility truth
runtime capability truth
transport truth
```

如果仅 display：

```text
必须有显式 display-only 命名
```

---

# 62. Final `queryModeKey` Audit

如果仍存在：

```text
只能作为 transitional/display metadata
```

不能决定 data service。

---

# 63. Duplicate Config Audit

输出：

```markdown
| Config | Runtime Source | Duplicate Copy | Can Affect Runtime | Action |
|---|---|---|---:|---|
| Resolution Spec | ... | ... | ... | ... |
| Object Ontology | ... | ... | ... | ... |
| Metric ownership | ... | ... | ... | ... |
```

---

# 64. Warning-Control-Flow Audit

目标：

```text
warning string → execution decision
count = 0
```

---

# 65. P8 Runtime Contract

`verify:runtime-contract` 至少新增：

```text
single ExecutionOutcomeContract/Mapper

NO_DATA requires real successful data execution

VALIDATION_FAILURE cannot map to NO_DATA

RUNTIME_CAPABILITY_FAILURE cannot map to NO_DATA

SERIALIZATION_FAILURE cannot map to NO_DATA

EXECUTION_FAILURE requires execution/response stage

Plugin consumes structured outcome

Narration cannot override structured outcome

no execution-layer legacy metric truth

no metrics[0] compatibility truth

no warning-string execution control flow
```

继续保持 P0–P7.1 contracts。

---

# 66. P8 允许修改

预计：

```text
新增或收口：
ExecutionOutcomeContract.js
ExecutionOutcomeMapper.js
（如已有等价模块则优先复用）

修改：
run_napm_query.js
Plugin/Hook outcome handling
RequirementParserService
QueryMetadataConstraintService
NapmResolvedQueryResolverService（仅 dead legacy cleanup）
summary/narration
runtime-contract
tests

可能删除：
dead TagNormalizer
dead inferMetric helper
dead default object fallback
dead warning control flow
dead duplicate config/helper
```

---

# 67. 不要把 Cleanup 变成大重写

每个删除项：

```text
先证明 caller
再删除
```

不要因为 P8 是 cleanup 就重写所有 Service。

---

# 68. BUG-B 严禁顺手修

如果触发：

```text
PageFamily → pageViews
```

第三轮问题：

```text
记录独立 issue
不要修改
```

---

# 69. 默认不访问真实 NAPM

Final Regression 使用：

```text
Fake/Spy NapmClient
contract fixture
现有接口文档
```

真实远端验证另行授权。

---

# 70. 完成后必须运行

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

另外单独运行：

```text
Phase 8 outcome tests
Phase 8 cleanup tests
Final BUG-A regression suite
```

---

# 71. 建议新增 Final BUG-A Acceptance Suite

建议命名：

```text
bug-a-final-regression.test.js
```

必须覆盖至少：

```text
A 原始慢业务 Top5
B 原始问句 + runtime UNKNOWN supported
C WebApplication + TRTI static deny
D WebApplication + TRTI runtime unsupported
E legal empty → NO_DATA
F data network/HTTP failure
G metrics=[TPI,TPO], topMetric=TPIO
H METRIC_UNKNOWN
I safe repair + single execution
J unsafe repair suggestion rejected
```

---

# 72. Phase 8 删除统计报告

用 Phase 8 start/end snapshot：

```markdown
| Category | Added | Deleted | Net |
|---|---:|---:|---:|
| Production | ... | ... | ... |
| Tests | ... | ... | ... |
| Docs/Contracts | ... | ... | ... |
```

并列：

```text
实际删除 legacy logic
实际删除 dead code
实际删除 duplicate truth
仍保留 migration boundary
```

---

# 73. Final Search Counts

必须给真实数字：

```text
production topMetric || metric:
count =

execution metric truth:
count =

execution metrics[0] truth:
count =

Kernel queryModeKey routing:
count =

warning-string execution control flow:
count =

production metrics comma encoders:
count =

production group encoders:
count =

production outcome mapper:
count =
```

目标：

```text
topMetric || metric = 0
execution metric truth = 0
execution metrics[0] truth = 0
Kernel queryModeKey routing = 0
warning-string control flow = 0
metrics comma encoder = 1
group encoder = 1
outcome mapper = 1
```

---

# 74. Phase 8 最终报告格式

## 74.1 Git

```text
branch:
HEAD:
Phase 8 start status:
Phase 8 end status:
Phase 8 files:
```

## 74.2 Outcome Contract

输出：

```text
top-level outcomes
stage enum
reasonCode registry
structured result schema
```

## 74.3 Error Matrix

输出第 25 节完整矩阵。

## 74.4 NO_DATA Proof

```text
NO_DATA requires dataRequestAttempted=true:
YES / NO

NO_DATA requires successful response parse:
YES / NO

Zero-call validation failure can become NO_DATA:
YES / NO
```

目标：

```text
YES
YES
NO
```

## 74.5 Legacy Cleanup Table

```markdown
| Legacy/Duplicate Item | Before | After | KEEP/DELETE | Reason |
|---|---|---|---|---|
| LegacyMetricInputAdapter | ... | ... | ... | ... |
| summary metric | ... | ... | ... | ... |
| QueryMetadataConstraint metrics[0] | ... | ... | ... | ... |
| RequirementParser legacy logic | ... | ... | ... | ... |
| TagNormalizer | ... | ... | ... | ... |
| Resolver inferMetric | ... | ... | ... | ... |
| defaultTargetObjectType | ... | ... | ... | ... |
| duplicate Spec/Ontology | ... | ... | ... | ... |
```

## 74.6 Deletion Stats

输出第 72 节表。

## 74.7 Final Truth Source Table

输出第 39 节表。

## 74.8 Final BUG-A Acceptance

逐项输出：

```text
Case A:
Case B:
Case C:
Case D:
Case E:
Case F:
Case G:
Case H:
Case I:
Case J:
```

每项给：

```text
PASS / FAIL
call counts
outcome
reasonCode
```

## 74.9 Final Search Counts

输出第 73 节真实数字。

## 74.10 P0–P7.1 Non-Regression

确认：

```text
Semantic Contract intact
Lifecycle intact
Canonical Query intact
Static Gate intact
Runtime Gate intact
Atomic Repair intact
Serializer/Kernel boundary intact
GroupBuilder uniqueness intact
Prepared proof safety intact
```

## 74.11 BUG-B Boundary

```text
BUG-B modified: NO
BUG-B tests intentionally changed: NO
```

## 74.12 Remote / Deploy / Commit

```text
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
```

## 74.13 Tests

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
Phase 7.1:
Phase 8:
Final BUG-A regression:
Full repo:
lint:
runtime-contract:
diff-check:
```

必须给：

```text
suite count
test count
PASS / FAIL
```

## 74.14 Phase 8 Completion

```text
YES / NO
```

## 74.15 BUG-A Final Status

```text
DONE / NOT DONE
```

---

# 75. Phase 8 完成定义

只有全部满足才算完成：

```text
1. Unified execution outcome contract 唯一
2. Plugin/Gateway/Direct outcome 一致
3. VALIDATION_FAILURE 与 NO_DATA 完全分离
4. Runtime capability failure 与 NO_DATA 完全分离
5. Serialization failure 与 NO_DATA 完全分离
6. Execution failure 与 NO_DATA 完全分离
7. NO_DATA 必须有真实 data call proof
8. warning 文本不再控制 execution outcome
9. legacy metric 不重新进入 execution truth
10. metrics[0] 不再作为 compatibility/execution truth
11. QueryMetadataConstraint 不拥有重复 hard-gate truth
12. Resolver 不再拥有第二套 metric semantic truth
13. default object executable fallback 不存在
14. dead TagNormalizer/infer helper 按 caller 审计处理
15. duplicate runtime Spec/Ontology truth source 不存在
16. static ownership truth source 唯一
17. runtime capability truth source 唯一
18. repair truth source 唯一
19. serializer truth source 唯一
20. group encoder truth source 唯一
21. outcome mapper truth source 唯一
22. 原始“业务访问较慢 Top5”生成 WebApplication + PGTME
23. WebApplication + TRTI verified baseline → VALIDATION_FAILURE + 0 data
24. runtime unsupported → VALIDATION_FAILURE + 0 data
25. METRIC_UNKNOWN → VALIDATION_FAILURE + 0 data
26. 合法空结果 → NO_DATA + data=1
27. HTTP/network/parse failure → EXECUTION_FAILURE
28. independent topMetric contract 保持
29. unsafe repair 仍被拒绝
30. full tests/lint/runtime-contract/diff-check 全 PASS
31. BUG-B 未混入
32. 无远端/部署/重启/commit
```

---

# 76. 最容易犯的错误

禁止：

```text
❌ 所有错误统一成 EXECUTION_FAILURE

❌ 把空数组继续当所有失败的兜底

❌ Runtime provider 失败返回 NO_DATA

❌ Serializer failure 返回 NO_DATA

❌ Plugin 根据 message 文本重新猜 outcome

❌ 为了删 Adapter 破坏真实外部兼容

❌ 把展示层 summaryMetric 喂回执行层

❌ 保留 QueryMetadataConstraint 的 metrics[0] hard decision

❌ 保留 Resolver 第二套 inferMetric 主链

❌ root/skill-local 两份配置都可影响 runtime

❌ 为了减少 LOC 删除有真实 caller 的兼容边界

❌ 顺手修 BUG-B
```

---

# 77. Phase 8 完成后的 BUG-A 最终架构

目标：

```text
用户自然语言
↓
唯一 Semantic Truth
↓
Canonical Semantic Contract
↓
Semantic Lifecycle
↓
唯一 Canonical Query Contract
↓
Atomic Safe Repair
↓
Static Object×Metric Gate
↓
Runtime Capability（仅 UNKNOWN）
↓
Final Admission
↓
唯一 Serializer
↓
唯一 Group Encoder
↓
Kernel Dispatch
↓
HTTP Transport
↓
Unified Outcome Contract
↓
Narration
```

并且：

```text
错误 Query
≠
无数据

不知道能力
≠
无数据

序列化失败
≠
无数据

网络失败
≠
无数据

只有合法查询真正成功返回 0 行
=
NO_DATA
```

---

# 78. 本轮结束

完成：

```text
Phase 8：
Unified Error Contract
+ Remaining Legacy / Duplicate Truth Cleanup
+ Final BUG-A Regression
```

后立即停止。

如果 Phase 8 Review 通过：

```text
BUG-A = DONE
```

之后再单独规划：

```text
BUG-B：PageFamily → pageViews 短追问
```

不要在本轮提前开始。
