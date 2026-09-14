# GAIOP NAPM BUG-A 实施指令 — Phase 2：统一 Metric / Ranking Semantic Contract

> 前置状态：Phase 0、Phase 1 已通过 Review。
>
> **本轮只实施 Phase 2：统一 Metric / Ranking Semantic Contract。**
>
> 完成后立即停止，不进入 Phase 3。
>
> 本轮允许修改“自然语言 → Semantic Contract → Resolver 输入”的语义行为；**不允许提前修改 Query Contract、Shared Validator、Policy/Gateway/Direct 门禁、Runtime Metadata、Serializer、Kernel。**

---

# 0. 本轮目标

本轮只解决：

```text
同一句自然语言
目前被 WorkflowClassifier / Resolver / TagNormalizer 等多处重复理解
```

最终收口成：

```text
ObjectOntologyService
        +
MetricSemanticNormalizerService
        +
RankingIntentParserService
        +
统一时间解析器（沿用现有，不在本轮重构）
        ↓
Canonical Semantic Contract
        ↓
WorkflowClassifier 只组合结构化结果
        ↓
Resolver 只消费 Semantic Contract
```

本轮结束后必须做到：

```text
谁理解对象：
ObjectOntologyService

谁理解指标：
Resolution Spec.metricSemanticRules
→ MetricSemanticNormalizerService

谁理解排行 / 方向 / 数量：
Resolution Spec.rankingGrammar
→ RankingIntentParserService

谁组合：
WorkflowClassifierService

谁生成 Query Draft：
NapmResolvedQueryResolverService
但不再从 raw prompt 自己推断 metric / ranking / count / direction
```

---

# 1. 核心原则

## 1.1 Semantic Truth Source 必须唯一

Phase 1 已确定 canonical Resolution Spec：

```text
skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
```

本轮新增：

```text
metricSemanticRules
rankingGrammar
```

生产语义解析只能读取这里。

禁止继续让生产主链依赖：

```text
Resolver inferMetric()
Resolver isRankingPrompt()
Resolver inferTopCount()
Resolver inferDirection()
WorkflowClassifier.hasRankingIntent()
TagNormalizer.METRIC_CODE_MAP
MetricSemanticNormalizer 私有 METRIC_PATTERNS 业务规则
Policy / Runner / Kernel 中的自然语言关键词
```

## 1.2 不新增第二份 semantic config

不要新建：

```text
metric-semantic-rules.json
ranking-rules.json
slow-business-map.js
```

机器规则只放 canonical Resolution Spec。

人类说明可以继续保留：

```text
chinese-semantic-metric-mapping.md
```

但 runtime 不解析 Markdown。

## 1.3 Parser 可以有通用算法，不能有业务词表

允许代码里有：

```text
通用 regex executor
中文数字 / 阿拉伯数字解析
pattern priority
candidate scoring
object constraint checking
specificity comparison
```

禁止代码里硬写：

```text
慢业务 → PGTME
服务器响应时间 → TRTI
网络时延 → RTTI
前5个 / 最多 / 最高 ...
```

这些必须来自 Resolution Spec。

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

报告中必须区分：

```text
pre-existing docs / memory
Phase 0 changes
Phase 1 changes
Phase 2 changes
```

禁止：

```text
reset
stash
自动提交
覆盖已有修改
```

---

# 3. 先审计当前所有自然语言语义入口

修改前搜索：

```bash
rg "inferMetric|isRankingPrompt|inferTopCount|inferDirection|hasRankingIntent|METRIC_PATTERNS|METRIC_CODE_MAP|resolveMetricSemantic|WorkflowClassifier|TagNormalizer" .
```

再搜索生产代码中的业务语义词：

```bash
rg "页面响应时间|服务器响应时间|网络时延|慢页面|访问较慢|排行|排名|Top|前[0-9N]" skills/openclaw-napm-query napm-openclaw-plugin.remote.js
```

输出审计表：

```markdown
| 组件 | 当前理解什么 | 是否生产主链 | Phase 2 后处理 |
|---|---|---|---|
| WorkflowClassifier | ... | YES/NO | 保留/删除/降级 |
| MetricSemanticNormalizer | ... | ... | ... |
| Resolver | ... | ... | ... |
| TagNormalizer | ... | ... | ... |
| Plugin | ... | ... | ... |
```

目标：先确认所有重复语义入口，再收口。

---

# 4. Canonical Semantic Contract

Phase 2 必须正式产出统一结构，例如：

```json
{
  "schemaVersion": "napm-query-semantic.v1",
  "operation": "rank_top",
  "direction": "desc",
  "targetObjectType": "WebApplication",
  "primaryMetric": "PGTME",
  "requestedMetrics": ["PGTME"],
  "rankingMetric": "PGTME",
  "topCount": 5,
  "timeIntent": {
    "key": "recent"
  },
  "confidence": 0.98,
  "source": {
    "object": "object-ontology",
    "metric": "metric-semantic-normalizer",
    "ranking": "ranking-intent-parser"
  }
}
```

## 4.1 schemaVersion

```text
required
```

当前：

```text
napm-query-semantic.v1
```

未知版本不能被 Resolver 静默接受。

## 4.2 operation

本轮至少支持：

```text
rank_top
rank_bottom
average
timeseries
detail_list
metadata_list
```

`rank_bottom` 只表示可识别语义，不代表当前可执行。

## 4.3 direction

```text
rank_top    → desc
rank_bottom → asc
```

非排行可为空。

Resolver 不得重新计算 direction。

## 4.4 targetObjectType

来自：

```text
ObjectOntologyService
```

对象不唯一时：

```text
semantic unresolved / clarification
```

Resolver 不得猜。

## 4.5 primaryMetric

```text
始终 optional
只表达用户语义上的主要关注指标
不是执行参数
```

禁止：

```text
primaryMetric = requestedMetrics[0]
```

## 4.6 requestedMetrics

表示：

```text
用户要求查看 / 返回的指标
```

支持多指标，例如：

```json
{
  "requestedMetrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ]
}
```

不要求 primaryMetric。

## 4.7 rankingMetric

```text
rank_top / rank_bottom 必填
排行依据
Resolver 未来生成 topMetric 的唯一语义来源
```

不能由 `metrics[0]` 反推。

## 4.8 topCount

只由：

```text
RankingIntentParserService
```

生成。

Resolver 不再调用：

```text
inferTopCount(rawPrompt)
```

## 4.9 source

至少记录：

```text
object
metric
ranking
```

用于证明同一语义槽位没有被多个组件再次覆盖。

---

# 5. Resolution Spec：新增 metricSemanticRules

本轮正式把机器指标语义放进 canonical Resolution Spec。

规则至少能表达：

```text
rule id
priority
patterns / phrases
object constraints
metricId
specificity
```

示例只表达结构，字段名可按项目风格调整：

```json
{
  "id": "web_application_slow_response",
  "priority": 200,
  "objectTypes": ["WebApplication"],
  "patterns": [
    "业务访问较慢",
    "业务响应慢",
    "页面响应慢"
  ],
  "metricId": "PGTME"
}
```

---

# 6. 本轮必须落地的产品语义

## 6.1 WebApplication 页面响应慢

表达至少覆盖：

```text
业务慢
业务访问较慢
业务响应慢
页面响应慢
页面响应时间
页面耗时
页面时延
```

对象：

```text
WebApplication
```

canonical metric：

```text
PGTME
```

## 6.2 慢页面数量

表达：

```text
慢页面数量
慢页面个数
慢页面最多
```

对象：

```text
WebApplication
PageFamily
```

canonical metric：

```text
PGNSLPGE
```

要求：

```text
“慢页面数量”必须优先于泛化的“慢”
```

不能被 PGTME 规则抢先匹配。

## 6.3 服务器响应时间

表达：

```text
服务器响应时间
服务端响应时间
```

canonical metric：

```text
TRTI
```

对象约束至少符合现有产品定义：

```text
DefinedApp
以及项目已有明确允许的非业务应用对象
```

不能将 WebApplication 语义解释成 TRTI。

注意：Phase 2 只做正确语义选择，不做执行 hard gate。

## 6.4 网络时延

表达：

```text
网络时延
RTT
网络延迟
```

canonical metric：

```text
RTTI
```

对象：

```text
IPAddress
以及已有明确网络对象
```

---

# 7. Metric Rule 匹配优先级

至少遵守：

```text
1. 明确指标 ID 优先
2. 更具体短语优先
3. object constraint 匹配优先
4. 高 priority 优先
5. 同等级仍有多个候选 → ambiguous / clarification
```

例如：

```text
慢页面数量最多的前5个业务
```

必须得到：

```text
PGNSLPGE
```

不能因“慢”匹配到 PGTME。

---

# 8. Semantic Rule 中的 metricId 必须存在

MetricSemanticNormalizer 允许产出：

```text
resolved
ambiguous
unresolved
```

但 Resolution Spec 中所有 `metricSemanticRules.metricId` 必须存在于 Phase 1 canonical Metric Catalog。

如果配置引用不存在指标：

```text
这是 runtime-contract / configuration failure
```

不能在运行时当普通 unresolved。

新增 contract test：

```text
metricSemanticRules 引用 metric ID
→ 必须存在于 canonical Metric Catalog
```

---

# 9. MetricSemanticNormalizerService 改成配置驱动

当前私有：

```text
METRIC_PATTERNS
```

不再作为生产主链业务真相。

Phase 2 后：

```text
MetricSemanticNormalizerService
↓
ResolutionSpecService.getMetricSemanticRules()
↓
通用 matcher
↓
structured result
```

建议输出：

```json
{
  "status": "resolved",
  "primaryMetric": "PGTME",
  "requestedMetrics": ["PGTME"],
  "matchedRuleIds": ["web_application_slow_response"],
  "confidence": 0.98
}
```

多指标：

```json
{
  "status": "resolved",
  "primaryMetric": null,
  "requestedMetrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ]
}
```

歧义：

```json
{
  "status": "ambiguous",
  "candidates": [
    {"metricId": "...", "ruleId": "..."}
  ]
}
```

---

# 10. 现有 metrics.aliases 的迁移规则

不要留下：

```text
metrics.aliases
+
metricSemanticRules
```

两套生产语义真相。

先审计现有 `metrics.aliases`。

首选：

```text
生产 matcher 只读取 metricSemanticRules
```

旧 aliases：

```text
deprecated
只用于非生产展示 / 兼容
```

如果旧消费者必须存在，可以由 machine rules 生成 alias projection，但不得人工双维护。

禁止：

```text
Normalizer 读一份
Resolver 再读另一份
```

---

# 11. 新增 RankingIntentParserService

新增：

```text
skills/openclaw-napm-query/services/RankingIntentParserService.js
```

职责：

```text
唯一排行意图 / 方向 / 数量解析入口
```

只消费：

```text
Resolution Spec.rankingGrammar
```

不要复制业务 regex 到代码里。

---

# 12. Resolution Spec：新增 rankingGrammar

至少表达：

```text
rank_top cues
rank_bottom cues
count patterns
default count
single-result cues
```

覆盖：

```text
前5个
前10个
前 N 个
Top5
Top 10
TopN
最高的5个
最多的5个
最低的5个
最少的5个
排行
排名
都有谁
有哪些
```

---

# 13. Count 解析是真 parser，不是 includes

不能：

```js
semanticHints.includes("前N")
```

去匹配：

```text
前5个
```

必须有统一 count extractor。

至少支持：

```text
前5个      → 5
前 5 个    → 5
Top5       → 5
Top 10     → 10
最高的10个 → 10
```

如项目已有中文数字解析器，优先复用。

不要在多个地方重新解析数量。

---

# 14. Ranking parser 输出

例如：

```json
{
  "status": "resolved",
  "operation": "rank_top",
  "direction": "desc",
  "topCount": 5,
  "countSource": "explicit",
  "matchedRuleIds": ["top_prefix_count"]
}
```

Bottom：

```json
{
  "status": "resolved",
  "operation": "rank_bottom",
  "direction": "asc",
  "topCount": 5
}
```

---

# 15. Ranking default 只允许一个来源

未明确数量时的产品默认值只能存在于：

```text
Resolution Spec.rankingGrammar.defaults
```

不能出现：

```text
WorkflowClassifier 默认 5
Resolver 默认 10
Kernel 默认 20
```

本轮只统一 semantic default。

旧执行层如仍有 default 20，可以留到后续 Phase，但 semantic/resolver 主链生成的 Draft 必须已有明确 topCount。

---

# 16. rank_bottom：识别但不能生成可执行 Top Query

当前设计已经冻结：

```text
NAPM 没有可验证的 BottomN / asc Top 能力
```

所以：

```text
“最低的5个”
“最少的5个”
```

应该解析：

```text
operation=rank_bottom
direction=asc
topCount=5
```

但是：

```text
Resolver 不得生成 topValues executable Query Draft
```

统一返回：

```text
reasonCode=RANK_BOTTOM_UNSUPPORTED
```

外层结构按当前兼容形式设计。

本轮绝对不要生成：

```text
topValues + direction=asc
```

---

# 17. 删除当前 fake BottomN 语义主链

Phase 0 已证明当前存在错误行为：

```text
NAPM 返回 100,90,80,70,60
direction=asc
→ 本地变成 60,70,80,90,100
```

Phase 2 允许修复这一点。

目标：

```text
TopValuesResultNormalizerService
只处理 rank_top / desc
```

收到：

```text
asc / rank_bottom
```

不得本地重排后冒充 BottomN。

可以：

```text
保持原结果并返回 unsupported / internal contract signal
```

或由上游确保路径不可到达。

必须有测试证明：

```text
BottomN 不再通过本地 asc 排序伪造
```

但本轮不要新增 Shared Validator。

---

# 18. WorkflowClassifierService 的新职责

Phase 2 后 WorkflowClassifier：

```text
只组合：
ObjectOntologyService result
MetricSemanticNormalizer result
RankingIntentParser result
Time parser result
```

形成 Canonical Semantic Contract。

删除 / 停用：

```text
hasRankingIntent()
私有排行 regex
私有 metric guess
```

---

# 19. Object 识别统一走 ObjectOntologyService

Phase 0 已证明：

```text
网络时延最高的前5个IP
```

Resolver 能得到 `IPAddress`，WorkflowClassifier 却没有。

Phase 2 必须让 Classifier：

```text
只消费 ObjectOntologyService
```

不要自己维护 object keyword regex。

## 19.1 不随意扩展 Ontology

如果 canonical Object Ontology 已经有：

```text
IP / IP地址 → IPAddress
```

只修调用链。

如果确实缺产品已确认 alias：

```text
先报告
```

如必须补，只能改 canonical：

```text
skills/openclaw-napm-query/config/object-ontology.v1.json
```

并在报告中单独说明。

---

# 20. Resolver 停止独立理解 raw prompt

当前 Resolver 存在：

```text
inferMetric()
isRankingPrompt()
inferTopCount()
inferDirection()
```

Phase 2 目标：

```text
Resolver 只消费 Semantic Contract
```

## 20.1 新 canonical resolver API

建议：

```js
resolveSemanticContract(semanticContract, context)
```

或按项目风格命名。

只读取：

```text
operation
direction
targetObjectType
primaryMetric
requestedMetrics
rankingMetric
topCount
timeIntent
```

不得重新读取 raw prompt 做指标/排行推断。

## 20.2 保留 raw prompt 兼容入口时

可以暂时保留：

```text
resolvePrompt(rawPrompt)
```

但必须变为：

```text
rawPrompt
→ unified semantic pipeline
→ Semantic Contract
→ resolveSemanticContract()
```

禁止内部继续调用：

```text
inferMetric(rawPrompt)
isRankingPrompt(rawPrompt)
inferTopCount(rawPrompt)
inferDirection(rawPrompt)
```

即：兼容 wrapper 可以存在，但语义只解析一次。

---

# 21. Phase 2 仍允许 Resolver 输出 legacy Query Draft shape

重要阶段边界：

Phase 3 才统一：

```text
metrics[]
topMetric
legacy metric adapter
canonical ResolvedQuery
```

所以 Phase 2 不要求一次删光 `metric`。

如果现有生产路径需要 legacy Query Draft：

```text
允许 Resolver 暂时从 Semantic Contract 派生旧兼容 shape
```

但必须：

```text
legacy 字段只由 structured semantic 派生
不能再从 raw prompt 猜
```

并明确标注：

```text
transitional / Phase 3 migration
```

不要在本轮新增 LegacyMetricInputAdapter。

---

# 22. TagNormalizer 从生产语义决策主链退出

Phase 2：

```text
TagNormalizer 不能再直接决定最终 metric
不能直接构造 ResolvedQuery
```

允许暂时：

```text
输出候选 tag / compatibility label
```

如果还有旧调用方，可保留 facade，但最终 metric 必须来自 MetricSemanticNormalizer。

不要为了完全删除 TagNormalizer 跨太多 Phase。

---

# 23. Semantic Layer 不负责 compatibility hard gate

例如：

```text
WebApplication + TRTI
```

本轮 Semantic Layer 可以识别：

```text
服务器响应时间 → TRTI
业务 → WebApplication
```

但：

```text
是否允许执行
```

仍是 Phase 4 Shared Validator 的职责。

不要在 MetricSemanticNormalizer 中调用 objectMetricOwnership 后 hard reject。

Object constraint 可以用于：

```text
语义 disambiguation
```

但不能替代执行门禁。

---

# 24. 语义歧义处理

如果存在两个同等可信 metric 候选：

```text
不要默认选第一个
```

应返回：

```text
ambiguous
```

并携带 candidates。

外层转 clarification 可沿用现有生命周期，本轮不重构 clarification orchestration。

---

# 25. Phase 2 必须通过的核心问句

## Case 1

```text
最近业务访问较慢的前5个业务都有谁？
```

Semantic Contract 必须包含：

```json
{
  "operation": "rank_top",
  "direction": "desc",
  "targetObjectType": "WebApplication",
  "primaryMetric": "PGTME",
  "requestedMetrics": ["PGTME"],
  "rankingMetric": "PGTME",
  "topCount": 5
}
```

Resolver：

```text
不再 unsupported_prompt
不再自行选择 TRTI
```

## Case 2

```text
页面响应时间最高的前5个业务
```

应：

```text
WebApplication
rankingMetric=PGTME
topCount=5
```

## Case 3

```text
慢页面数量最多的前5个业务
```

应：

```text
WebApplication
rankingMetric=PGNSLPGE
topCount=5
```

不能：

```text
missing_metric
PGTME
```

## Case 4

```text
服务器响应时间最高的前5个已定义应用
```

应：

```text
DefinedApp
rankingMetric=TRTI
topCount=5
```

## Case 5

```text
网络时延最高的前5个IP
```

应：

```text
IPAddress
rankingMetric=RTTI
topCount=5
```

Classifier 与 Resolver 必须一致。

## Case 6

```text
最低的5个业务
```

应：

```text
operation=rank_bottom
direction=asc
topCount=5
```

然后：

```text
RANK_BOTTOM_UNSUPPORTED
```

不得生成假 BottomN Query。

---

# 26. 多指标 Semantic Contract 测试

至少测试：

```text
同时查看访问量、页面响应时间和 HTTP500
```

期望：

```json
{
  "requestedMetrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ]
}
```

不要求 primaryMetric。

---

# 27. 多指标排行测试

至少支持：

```text
同时查看流入吞吐量和流出吞吐量，按总吞吐量排行前10
```

Semantic Contract：

```json
{
  "operation": "rank_top",
  "direction": "desc",
  "requestedMetrics": ["TPI", "TPO"],
  "rankingMetric": "TPIO",
  "topCount": 10
}
```

Phase 2 重点验证：

```text
rankingMetric 与 requestedMetrics[] 独立
```

不要在本轮修 Plugin 的 `topMetric ∈ metrics[]`，那属于 Phase 3。

---

# 28. Phase 0 Characterization Tests 的迁移

以下 Phase 0 semantic behavior 将被 Phase 2 有意改变：

```text
慢业务 Top5 unresolved
页面响应时间 Top5 metricSemantic=null
慢页面数量 missing_metric
IP 网络时延 Classifier object unresolved
BottomN 假 asc 行为
```

这些可以迁移为 Phase 2 正式 semantic contract tests。

Phase 0 报告继续保留历史证据。

不要为了保持旧 characterization 全绿而保留错误语义。

---

# 29. Phase 2 不应改变的 Phase 0/1 行为

以下仍属于后续 Phase：

```text
Policy WebApplication + TRTI
→ 仍可能 EXECUTE_QUERY

Gateway WebApplication + TRTI
→ 仍可能 metadata + data

Direct
→ 仍可能绕过 Policy

Plugin topMetric-in-metrics
→ 仍存在

QueryValidator legacy metric
→ 仍存在

Kernel metric fallback
→ 仍存在

Metadata overloaded service
→ 仍存在

ExecutionFailureClassifier empty/no-data guessing
→ 仍存在
```

如果本轮这些发生变化，必须说明是否越界。

---

# 30. 不要接入 Phase 1 tri-state 执行门禁

本轮 QueryDecisionPolicy 不得因为新 Semantic Contract 而调用：

```text
classifyObjectMetricCompatibility()
```

进行 hard reject。

Phase 4 才做。

可以在 Semantic Layer 使用 object type 做：

```text
规则 disambiguation
```

但不能决定：

```text
southboundAllowed
```

---

# 31. 不要修改 Metric Catalog Truth Source

Phase 1 已完成 Metric Catalog fail closed。

Phase 2 只允许：

```text
读取 canonical Metric Catalog
验证 semantic rules 引用的 metric ID 存在
```

不要重新引入 fallback metric list。

---

# 32. Phase 2 runtime-contract 新规则

至少新增：

```text
metricSemanticRules 只存在于 canonical Skill-local Resolution Spec
metricSemanticRules 引用 metric ID 必须存在于 canonical Metric Catalog
rankingGrammar 只有一个 canonical source
生产 Resolver 不得直接读取旧 metrics.aliases 来决定 metric
生产 WorkflowClassifier 不得含独立 ranking business regex
生产 Resolver 不得在主链调用 inferMetric/isRankingPrompt/inferTopCount/inferDirection
TagNormalizer 不得直接构造生产 ResolvedQuery
```

如果旧函数暂时保留用于 test / deprecated compatibility，必须确保生产入口不可达。

---

# 33. Phase 2 允许修改的文件

预计允许：

```text
skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
services/ResolutionSpecService.js
services/MetricSemanticNormalizerService.js
services/WorkflowClassifierService.js
services/NapmResolvedQueryResolverService.js
services/TagNormalizer.js
services/TopValuesResultNormalizerService.js
新增 services/RankingIntentParserService.js
相关 tests
runtime-contract script
docs / memory
```

如 ObjectOntologyService 仅需调用链调整，可以修改。

---

# 34. Phase 2 禁止修改的核心行为

除非只是 import / compatibility 适配，不要修改：

```text
QueryDecisionPolicy 的执行判定
QueryValidator canonical contract
QueryMetadataConstraintService compatibility/repair
NapmMetadataService runtime 调用顺序
RequirementParserService gateway/direct 门禁
MetricExecutionKernel metric fallback
MetadataExecutionKernel overload
NapmClient
ExecutionFailureClassifier
Plugin topMetric-in-metrics 校验
objectMetricOwnership tri-state 行为
RuntimeMetricCapabilityService（尚未新增）
Shared Validator（尚未新增）
LegacyMetricInputAdapter（Phase 3）
Serializer（Phase 7）
BUG-B / pageViews follow-up
```

---

# 35. Phase 2 测试矩阵

至少新增：

## Semantic Rule Tests

```text
WebApplication + 慢 → PGTME
慢页面数量 → PGNSLPGE
DefinedApp + 服务器响应时间 → TRTI
IPAddress + 网络时延 → RTTI
```

## Specificity Tests

```text
“慢页面数量”优先于“慢”
```

## Ambiguity Tests

```text
同等候选 → ambiguous → 不默认第一个
```

## Ranking Tests

```text
前5个
前 5 个
Top5
Top 10
最高的10个
最多的10个
最低的5个
最少的5个
```

## Resolver Tests

```text
Resolver 接 Semantic Contract
→ 不读取 raw prompt 再推断
```

## Production Reachability Tests

确保以下旧方法不再被生产主链调用：

```text
inferMetric
isRankingPrompt
inferTopCount
inferDirection
hasRankingIntent
```

## BottomN Tests

```text
rank_bottom semantic recognized
→ RANK_BOTTOM_UNSUPPORTED

TopValuesResultNormalizer
→ 不再 asc 重排 TopN 冒充 BottomN
```

## Multi-metric Tests

```text
requestedMetrics 多指标
primaryMetric absent
→ PASS

requestedMetrics=[TPI,TPO]
rankingMetric=TPIO
→ PASS
```

---

# 36. Southbound 回归边界

Phase 2 主要改变 semantic resolution。

对于人工直接提交的错误 Query：

```text
WebApplication + TRTI
```

仍应保持 Phase 1 旧执行行为。

Phase 2 不得声称：

```text
BUG-A 已彻底修复
```

本轮只解决：

```text
自然语言不会再因为多套语义解析而错误选择指标 / 排行
```

真正：

```text
错误 Query 0 southbound
```

要等 Phase 4 / 5。

---

# 37. 完成后必须运行

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

另外分别运行：

```text
Phase 0 relevant characterization
Phase 1 truth-source tests
Phase 2 semantic/ranking tests
```

---

# 38. Phase 2 输出要求

完成后立即停止，不进入 Phase 3。

## 38.1 Git 基线

```text
branch:
HEAD:

Phase 2 开始前 status:
Phase 2 结束后 status:

pre-existing:
Phase 0:
Phase 1:
Phase 2:
```

## 38.2 文件变更

```markdown
| 文件 | 修改目的 | Semantic 行为是否改变 | Query Execution Gate 是否改变 |
|---|---|---|---|
| ... | ... | YES/NO | YES/NO |
```

Phase 2：

```text
Semantic 行为：允许 YES
Query Execution Gate：应为 NO
```

## 38.3 Semantic Truth Source

输出：

```text
metric semantic source:
ranking grammar source:
object source:
time source:
```

确认：

```text
是否还有生产主链第二套 metric parser：YES / NO
是否还有生产主链第二套 ranking parser：YES / NO
```

目标：

```text
NO
NO
```

## 38.4 Canonical Semantic Contract

列出实际 schema：

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

说明 required / optional。

## 38.5 核心问句结果

```markdown
| 问句 | object | operation | direction | requestedMetrics | rankingMetric | topCount | Resolver |
|---|---|---|---|---|---|---:|---|
| 最近业务访问较慢... | ... | ... | ... | ... | ... | 5 | ... |
| 页面响应时间最高... | ... | ... | ... | ... | ... | 5 | ... |
| 慢页面数量最多... | ... | ... | ... | ... | ... | 5 | ... |
| 服务器响应时间最高... | ... | ... | ... | ... | ... | 5 | ... |
| 网络时延最高... | ... | ... | ... | ... | ... | 5 | ... |
| 最低的5个... | ... | rank_bottom | asc | ... | ... | 5 | RANK_BOTTOM_UNSUPPORTED |
```

## 38.6 Duplicate Parser Audit

列出：

```text
WorkflowClassifier.hasRankingIntent
Resolver.inferMetric
Resolver.isRankingPrompt
Resolver.inferTopCount
Resolver.inferDirection
MetricSemanticNormalizer.METRIC_PATTERNS
TagNormalizer.METRIC_CODE_MAP
```

每项标记：

```text
deleted
deprecated but unreachable
compat facade
still active（若存在必须解释）
```

## 38.7 BottomN Result

明确：

```text
Parser 是否识别：YES/NO
是否生成 executable topValues：YES/NO
TopValuesResultNormalizer 是否仍 asc 重排：YES/NO
NapmClient 是否因本轮语义路径执行 BottomN：YES/NO
```

目标：

```text
YES
NO
NO
NO
```

## 38.8 Phase 0/1 非目标行为回归

列：

```text
Policy WebApplication + TRTI:
Gateway:
Direct:
Plugin topMetric-in-metrics:
QueryValidator metric:
Kernel fallback:
Metadata overload:
Error classifier:
Ownership tri-state:
Metric Catalog fail-closed:
```

说明哪些保持、哪些属于本轮有意变化。

## 38.9 Runtime Contract 新规则

逐条：

```text
single metric semantic source
single ranking source
semantic rule metric IDs valid
no production Resolver metric inference
no production Resolver ranking inference
no production WorkflowClassifier ranking regex
TagNormalizer no production Query construction
```

PASS / FAIL。

## 38.10 测试结果

```text
Phase 0:
Phase 1:
Phase 2:
full repo:
lint:
runtime-contract:
diff-check:
```

## 38.11 是否连接远端

必须：

```text
NO
```

## 38.12 是否提交 commit

除非用户另行明确要求：

```text
NO
```

## 38.13 Phase 2 是否完成

```text
YES / NO
```

完成后停止，不进入 Phase 3。

---

# 39. Phase 2 完成定义

只有全部满足才算完成：

```text
1. Resolution Spec 成为唯一机器 Metric Semantic source
2. Resolution Spec 成为唯一 Ranking Grammar source
3. MetricSemanticNormalizer 完全配置驱动
4. RankingIntentParserService 成为唯一排行解析器
5. WorkflowClassifier 只组合结构化解析结果
6. Object 识别统一消费 ObjectOntologyService
7. Resolver 不再从 raw prompt 独立推断 metric/ranking/count/direction
8. raw prompt 兼容入口如保留，只能委托统一 semantic pipeline
9. TagNormalizer 不再拥有生产指标决策权
10. primaryMetric 始终 optional
11. requestedMetrics 支持多指标
12. rankingMetric 成为排行依据的正式 semantic 字段
13. “慢业务 Top5”稳定得到 WebApplication + PGTME + rank_top + 5
14. “慢页面数量 Top5”稳定得到 PGNSLPGE
15. “服务器响应时间 Top5 已定义应用”稳定得到 TRTI
16. “网络时延 Top5 IP”稳定得到 RTTI + IPAddress
17. BottomN 可识别但不生成 executable query
18. 当前 fake BottomN asc 本地重排路径不再作为正确能力
19. 不提前接 Shared Validator / Query gate
20. Phase 1 truth-source 与 Metric Catalog fail-closed 保持
21. 全仓 test/lint/runtime-contract/diff-check 通过
```

---

# 40. 再次强调本轮禁止事项

不要：

```text
新增 Shared Validator
接 ownership tri-state 到 Policy
修 WebApplication+TRTI direct hard gate
实现 0 southbound
新增 RuntimeMetricCapabilityService
修改 metadata 调用顺序
统一 metric/metrics/topMetric canonical contract
新增 LegacyMetricInputAdapter
删除 QueryValidator legacy metric
删除 Kernel metric fallback
删除 Plugin topMetric-in-metrics
拆 Metadata overloaded service
实现 Serializer
重构 Error Contract
处理 BUG-B
连接远端
部署
提交 commit
```

---

# 41. 本轮结束

完成：

```text
Phase 2：统一 Metric / Ranking Semantic Contract
```

后立即停止。

下一阶段：

```text
Phase 3：Canonical Query Contract + Legacy Adapter
```

必须等待 Phase 2 Review 通过后再开始。
