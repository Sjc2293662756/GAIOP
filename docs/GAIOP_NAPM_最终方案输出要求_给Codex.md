# GAIOP NAPM Query 最终方案输出要求（给 Codex）

这版设计我基本对齐。下一步请不要修改代码，先基于双方已经确认的事实与设计原则，输出一份**最终完整解决方案**，作为后续实施基线。

本轮只做最终方案收口，不连接远端、不改代码、不提交 commit。

---

# 一、这几项作为已对齐前提

## 1. 指标语义入口

```text
Resolution Spec
→ MetricSemanticNormalizer
→ WorkflowClassifier
→ structured metricSemantic
→ Resolver
```

原则：

- Resolution Spec 是机器可读的指标语义真相源；
- `MetricSemanticNormalizerService` 是自然语言指标解析的统一运行时入口；
- WorkflowClassifier 消费统一指标语义结果；
- Resolver 不再独立从 raw prompt 重新推断指标；
- `TagNormalizer`、Resolver aliases 等重复逻辑需要降级、合并或退出主链；
- `chinese-semantic-metric-mapping.md` 作为产品说明/reference 保留，但 runtime 不直接解析 Markdown。

---

## 2. 静态对象—指标准入

```text
objectMetricOwnership.js
= 静态 Object × Metric 执行准入 authoritative source
```

其他组件职责：

```text
metricDomains.js
→ 分类、领域、推荐、展示
→ 不拥有最终执行准入权

DimensionMappingService
→ 查询/消费已有领域知识
→ 不保存新的 ownership truth

Resolution Spec
→ service contract
→ semantic aliases
→ default semantic policy
→ 不再人工维护第二套独立执行 ownership

metricsForGroup
→ runtime device capability confirmation
→ 不覆盖静态 KNOWN_INCOMPATIBLE
```

请在最终方案中说明当前 Resolution Spec 中已有 ownership/domain 字段如何处理，避免未来出现：

```text
objectMetricOwnership
+
Resolution Spec ownership
```

两份需要人工同步的执行真相源。

---

## 3. Shared Executable Validator

需要有一个共享的结构化执行校验器，例如：

```text
ResolvedQueryExecutableValidator
```

名字可以调整，但职责必须保持：

```text
校验编排器
```

而不是：

```text
新知识库
新语义解析器
新 repair engine
```

它应复用：

```text
Resolution Spec
→ service contract

现有 GroupPathPlanner / group validation
→ group/path contract

argument policy
→ argument contract

objectMetricOwnership
→ Object × Metric compatibility

pageViews existing contract
→ detail query contract
```

自身只负责：

```text
调用
汇总
裁决
```

并输出类似：

```text
VALID
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
UNKNOWN
```

不允许在 Validator 中加入自然语言关键词规则。

---

# 二、请把 `metric / metrics[] / topMetric` 最终定死

这里需要采用更精确的定义。

## 1. GAIOP 内部 Execution Contract

```text
metrics: string[]
= GAIOP 内部指标数组
= 请求 NAPM 查询并返回哪些指标列
= 序列化为 NAPM HTTP 的逗号分隔 metrics 参数

topMetric: string
= 仅用于 topValues
= 独立排序指标
= 序列化为 NAPM topMetric 参数

metric
= 不是 NAPM Web Services 正式参数
= 不属于 canonical execution contract
= 只能作为迁移期历史兼容字段
```

例如：

```json
{
  "metrics": ["TPI", "TPO"],
  "topMetric": "TPIO"
}
```

序列化为：

```text
metrics=TPI,TPO
topMetric=TPIO
```

这是合法能力。

因此必须确认：

```text
不要求 topMetric ∈ metrics[]
不要求 metric = metrics[0] = topMetric
```

---

## 2. `metric` 的最终定位

请进一步明确：

```text
primaryMetric
= Semantic Contract 字段
= 可选
= 表达用户语义上主要关注的指标

metrics[]
= Execution Contract 权威字段

topMetric
= topValues Execution Contract 权威字段

metric
= deprecated / compatibility field
= 非 authoritative
= 非 NAPM 参数
= 调用方禁止独立指定
= 后续逐步删除
```

### topValues

迁移期如旧代码必须读取 `metric`：

```text
metric 可以暂时由 topMetric 派生
```

但 `metric` 不能反向覆盖 `topMetric`。

### averageValues / timeValues

不要把下面规则固化成长期设计：

```text
metric = metrics[0]
```

例如：

```json
{
  "metrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ]
}
```

不能因为数组第一项是 `PGNPGE`，就把它隐式定义成用户的 primary semantic metric。

最终原则：

```text
只有存在明确 primaryMetric 时，才允许为旧代码派生 metric；
没有明确 primaryMetric 时，metric 可以为空。
```

如果现有旧代码强依赖 `metric` 非空，请设计兼容迁移方案，而不是让 `metrics[0]` 成为新的隐式 truth source。

---

# 三、不同服务的字段契约必须分开

请正式定义至少：

## topValues

```text
metrics[]   必填
topMetric   必填
topCount    必填/按 contract
metric      非 canonical
```

## averageValues

```text
metrics[]   必填
topMetric   禁止
metric      非 canonical
```

## timeValues

```text
metrics[]   必填
granularity 必填
topMetric   禁止
metric      非 canonical
```

## pageViews

请单独定义为：

```text
GAIOP / Detail Query Contract
```

不要和官方 `topValues / averageValues / timeValues` 混在同一个“NAPM 官方契约”层级。

`pageViews` 是否禁止 `metrics/topMetric`，依据应来自：

```text
当前项目 pageViews 实现
HAR
实际 detail query contract
```

而不是引用官方三类 metric service 文档。

---

# 四、指标校验顺序最终确定

请使用下面顺序：

```text
Step 1
Metric ID 是否存在于本地合法指标目录？
```

不存在：

```text
METRIC_UNKNOWN
→ VALIDATION_FAILURE
→ 0 southbound
```

存在后：

```text
Step 2
objectMetricOwnership
```

结果：

```text
KNOWN_INCOMPATIBLE
→ VALIDATION_FAILURE
→ 0 southbound

KNOWN_COMPATIBLE
→ 可以继续

UNKNOWN
→ runtime metricsForGroup
```

注意：

```text
UNKNOWN
```

只能表示：

> 指标 ID 本身合法存在，但本地 ownership 无法对当前复杂 Object / Group Path 作出确定结论。

不能把：

```text
拼错指标
模型乱造指标
不存在指标
```

当成 UNKNOWN 送给南向确认。

---

# 五、Validator 必须封住所有执行入口

最终要求：

```text
一个 Validator 实现
多个执行入口共同调用
```

至少覆盖：

```text
QueryDecisionPolicy
prepareGatewayExecution
executeDirectGatewayRequest
```

并继续检查是否还有能够直接进入：

```text
MetricExecutionKernel
NapmClient
```

的其他真实入口。

---

## 1. Plugin / Policy 路径

非法 ResolvedQuery：

```text
QueryDecisionPolicy
↓
Shared Validator
↓
VALIDATION_FAILURE
```

目标：

```text
Query Skill invocation = 0
NapmClient = 0
```

---

## 2. prepareGatewayExecution

必须在：

```text
reviewGatewayRequestMetadata()
```

之前校验。

对于静态明确非法：

```text
WebApplication + TRTI
```

必须满足：

```text
metadata review = 0
applications = 0
metricsForGroup = 0
NapmClient = 0
data query = 0
```

---

## 3. executeDirectGatewayRequest

仍需要再次调用同一个 Validator，作为最后防线。

因为调用方可能绕过 prepare。

规则只有一份，实现只有一份，允许多个入口重复调用同一校验器。

---

# 六、Runtime Metadata 的最终定位

```text
metricsForGroup
```

只用于：

```text
静态 UNKNOWN
新设备版本
复杂 Group Path
本地 ownership 无法确定
```

不用于：

```text
静态 KNOWN_INCOMPATIBLE
METRIC_UNKNOWN
```

而且：

```text
runtime metadata 不得覆盖 static deny
```

例如：

```text
WebApplication + TRTI
```

如果静态 ownership 已经明确禁止，就不应该再调用 `metricsForGroup`。

---

# 七、Validator 与 Repair 必须彻底分离

## Validator

```text
只判断
不修改 Query
不解析自然语言
```

## Repair

单独阶段。

静态发现：

```text
WebApplication + TRTI
```

不能自动：

```text
TRTI → PGTME
```

因为这改变了用户的业务口径。

最终边界：

```text
明确语义 + 对象不兼容
→ VALIDATION_FAILURE

语义本身歧义
→ clarification

大小写 / 去重 / legacy shape / 明确等价字段
→ normalization

存在唯一安全修复
→ atomic repair
→ repair 后重新完整 validation
```

---

# 八、Repair 必须是原子事务

上一轮已经复现过非法半修复：

```text
metric    = PGTME
metrics   = [PGTME]
topMetric = TRTI
```

这种状态必须禁止。

正确流程：

```text
ResolvedQuery before
↓
Repair Transaction
↓
生成完整新 ResolvedQuery
↓
重新执行 Shared Validator
↓
完全合法才能继续
```

同时 repair 必须理解字段角色。

例如合法：

```json
{
  "metrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ],
  "topMetric": "PGTME"
}
```

不能为了“字段一致”错误修成：

```json
{
  "metrics": ["PGTME"],
  "topMetric": "PGTME"
}
```

---

# 九、TopN 语义也必须只有一套解析

当前存在：

```text
WorkflowClassifier.hasRankingIntent()
Resolver.isRankingPrompt()
Resolution Spec semanticHints
```

多套排行识别。

最终希望：

```text
Resolution Spec
→ 结构化 ranking grammar/config
→ 一个统一 RankingIntentParser
```

输出：

```json
{
  "operation": "rank_top",
  "direction": "desc",
  "topCount": 5
}
```

需要覆盖：

```text
前5个
前10个
前N个
Top5
Top 10
最高的5个
最多的5个
都有谁
有哪些
排行
排名
```

不能简单使用：

```text
"前N".includes(...)
```

去匹配“前5个”。

Resolver 不再自己重新判断排行。

---

# 十、`WebApplication + 慢 → PGTME` 作为正式产品语义

如果项目确认：

```text
业务/WebApplication + 慢/响应慢
→ PGTME
```

是既定产品语义，那么原始问句：

```text
最近业务访问较慢的前5个业务都有谁？
```

目标必须稳定为：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "groups": [
    {
      "type": "WebApplication"
    }
  ],
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "topCount": 5
}
```

但这条规则只能存在于正式 machine semantic truth source 中。

不能分别写入：

```text
Classifier
Resolver
Policy
Runner
TagNormalizer
```

多个位置。

---

# 十一、Execution Kernel / Serializer 最终必须“不猜”

这是本轮需要额外明确的一点。

迁移阶段可以暂时兼容旧 `metric`，但最终目标必须是：

```text
Semantic Layer
→ 理解/推断

Resolver
→ 生成完整 ResolvedQuery

Validator
→ 判断是否合法

Repair
→ 如需修复则单独完成并重验

Execution Kernel / Serializer
→ 只读取 canonical execution fields
→ 不猜
→ 不补语义
→ 不 repair

NapmClient
→ 只通信
```

最终 serializer 应类似：

```text
metrics[] → join(",") → NAPM metrics
topMetric → NAPM topMetric
topCount → NAPM topCount
```

不应长期保留：

```text
topMetric || metric
```

这种兜底。

因为这种 fallback 会掩盖上游 contract 缺失。

---

# 十二、Error Contract 最终定死

至少统一：

```text
VALIDATION_FAILURE
NO_DATA
EXECUTION_FAILURE
```

## VALIDATION_FAILURE

Query 在真正数据执行前被拒绝。

例如：

```text
WebApplication + TRTI
METRIC_UNKNOWN
service contract invalid
```

不能被 narration 说成：

```text
“未查到数据”
```

## NO_DATA

必须满足：

```text
Query 合法
NAPM 数据请求真实执行成功
返回 0 行
```

才允许。

## EXECUTION_FAILURE

例如：

```text
network
HTTP
timeout
NAPM error
parse failure
```

请说明：

```text
Policy
Skill Runtime
Narration
```

如何统一映射。

---

# 十三、PageFamily 第三轮问题继续独立成 BUG-B

保持独立：

```text
PageFamily → pageViews
短追问
result reference / source type
```

不混入：

```text
Object + Metric + Query Contract + Executable Gate
```

这次主方案。

最终文档中只记录：

```text
BUG-B
```

的独立问题描述和后续建议。

---

# 十四、请输出最终完整解决方案

请不要再只回答局部问题。

最终文档必须包含：

## 1. 最终架构原则

明确：

```text
谁理解指标？
谁理解排行？
谁判断 Object × Metric compatibility？
谁拥有最终执行否决权？
谁负责 runtime capability confirmation？
谁负责 repair？
谁负责 serializer？
```

---

## 2. Authoritative Source Matrix

至少列：

```text
Object ontology
Metric semantic
Object-metric ownership
Service contract
Group path
Ranking grammar
Runtime capability
```

每一类只能有一个明确 authoritative source。

---

## 3. Canonical Semantic Contract

例如：

```json
{
  "operation": "rank_top",
  "targetObjectType": "WebApplication",
  "primaryMetric": "PGTME",
  "topCount": 5
}
```

明确字段 required / optional。

---

## 4. Canonical ResolvedQuery Contract

分别定义：

```text
topValues
averageValues
timeValues
pageViews
metadata services
```

每个 service 的：

```text
required
optional
forbidden
derived
legacy
```

字段。

---

## 5. `metric` Migration Plan

明确：

```text
为什么现在不能立刻删
哪些地方禁止继续写入
哪些地方只允许读取
如何派生
什么时候可以为空
最终何时删除
```

特别说明：

```text
禁止把 metrics[0] 长期当成隐式 primaryMetric
```

---

## 6. Shared Validator Contract

定义：

```text
input
output
status
reasonCode
调用位置
```

---

## 7. Runtime Metadata Contract

明确：

```text
什么时候调用 metricsForGroup
什么时候绝对不调用
runtime metadata 能否覆盖 static deny
```

---

## 8. Repair Contract

明确：

```text
normalization
repair
clarification
hard reject
```

的边界。

---

## 9. Serializer Contract

明确：

```text
GAIOP metrics: string[]
→ NAPM metrics=逗号分隔

GAIOP topMetric
→ NAPM topMetric
```

以及哪些 legacy 字段绝不能进入 serializer。

---

## 10. Error Contract

```text
VALIDATION_FAILURE
NO_DATA
EXECUTION_FAILURE
```

---

## 11. 文件级改造方案

按真实文件分：

```text
保留
职责调整
删除/降级
新增
```

---

## 12. Before / After 调用链

必须画完整链。

---

## 13. Migration Plan

考虑：

```text
旧 metric 依赖
Resolver inferMetric
TagNormalizer
Plugin topMetric validation
QueryValidator
QueryMetadataConstraint
MetricExecutionKernel fallback
root / skill-local config
```

不要设计成一次删光。

---

## 14. Regression / Contract Test Matrix

至少包含：

```text
1.
metrics=[TPI,TPO]
topMetric=TPIO
→ PASS

2.
WebApplication
metrics=[PGNPGE,PGTME,PGHTTP500]
topMetric=PGTME
→ PASS

3.
WebApplication + TRTI
→ VALIDATION_FAILURE
→ 0 metadata southbound
→ 0 data southbound

4.
DefinedApp + TRTI
→ PASS

5.
IPAddress + RTTI
→ PASS

6.
METRIC_UNKNOWN
→ VALIDATION_FAILURE
→ 0 southbound

7.
最近业务访问较慢的前5个业务都有谁？
→ WebApplication + PGTME + topCount=5

8.
慢页面数量最多的前5个业务
→ WebApplication + PGNSLPGE

9.
服务器响应时间最高的前5个已定义应用
→ DefinedApp + TRTI

10.
网络时延最高的前5个IP
→ IPAddress + RTTI

11.
合法 Query 返回 0 rows
→ NO_DATA

12.
禁止出现：
metric=PGTME
metrics=[PGTME]
topMetric=TRTI

13.
Plugin path 非法 query
→ Query Skill invocation = 0

14.
executeGatewayRequest 非法 query
→ metadata review = 0
→ NapmClient = 0

15.
executeDirectGatewayRequest 非法 query
→ NapmClient = 0
```

---

# 十五、最后请明确回答 Yes / No

请逐项回答，不要含糊。

```text
1. objectMetricOwnership 是否成为唯一静态执行准入真相源？
YES / NO

2. Resolution Spec 是否成为唯一机器指标语义真相源？
YES / NO

3. MetricSemanticNormalizer 是否成为唯一自然语言指标解析入口？
YES / NO

4. Resolver 是否停止独立从 raw prompt 推断指标？
YES / NO

5. Ranking intent 是否改为唯一统一解析入口？
YES / NO

6. Validator 是否只做结构化校验编排，不保存新的业务规则？
YES / NO

7. 静态 KNOWN_INCOMPATIBLE 是否必须 0 southbound？
YES / NO

8. METRIC_UNKNOWN 是否必须本地直接失败、0 southbound？
YES / NO

9. topMetric 是否允许不在 metrics[] 中？
YES / NO

10. metric 是否不再属于 canonical NAPM Query contract？
YES / NO

11. metrics[0] 是否禁止长期充当隐式 primaryMetric？
YES / NO

12. metadata repair 是否必须原子化并 repair 后完整重验？
YES / NO

13. Execution Kernel / Serializer 最终是否停止依赖 metric fallback？
YES / NO

14. runtime metricsForGroup 是否不得覆盖 static deny？
YES / NO

15. PageFamily follow-up 是否继续独立成 BUG-B？
YES / NO
```

如果任何一项回答 `NO`，请给出：

```text
代码证据
接口材料证据
兼容性原因
```

---

# 十六、本轮约束

```text
1. 不修改代码。
2. 不连接远端 NAPM。
3. 不提交 commit。
4. 不新建第五套 capability matrix。
5. 不在 Policy / Resolver / Runner 中继续新增重复自然语言 regex。
6. 不要求 topMetric ∈ metrics[]。
7. 不要求 metric = metrics[0] = topMetric。
8. 不把 metrics[0] 长期当成 primaryMetric。
9. 不让 Runtime Metadata 覆盖静态明确禁止。
10. 不把 PageFamily BUG-B 混入当前主补丁。
```

本轮目标：

> 输出一份最终、完整、可实施、可测试、可迁移的解决方案。

等这份最终方案对齐后，下一轮才进入具体代码修改。
