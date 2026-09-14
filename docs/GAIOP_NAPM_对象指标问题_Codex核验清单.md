# GAIOP NAPM Query 对象/指标问题核验清单

> 目的：请基于 **GAIOP-main 当前项目代码** 对下面的问题逐项核验。  
> **本轮只做代码审查、调用链追踪和本地复现，不要先修改代码。**
>
> 请不要直接接受本文结论。每一项都要给出：
>
> - `CONFIRMED / PARTIALLY_CONFIRMED / NOT_FOUND`
> - 对应文件、函数、关键代码位置
> - 实际调用链
> - 可运行的本地复现结果
> - 如果本文判断不准确，请明确指出真实情况
>
> 核心复现问句：
>
> ```text
> 最近业务访问较慢的前5个业务都有谁？
> ```
>
> 当前争议点不是“要不要给 PGTME 增加一个别名”，而是：
>
> **项目是否已经存在对象、指标、对象-指标兼容性判断，但这些能力没有在同一条执行链上形成统一的最终否决机制。**

---

## 1. 先确认当前真实主链，不要根据文件名猜

请先追踪以下两条实际运行链路：

### 1.1 OpenClaw / Plugin 正常查询链

请从插件入口开始一直追到南向 NAPM：

```text
用户 prompt
→ NapmResolvedQueryResolverService ?
→ QueryDecisionPolicy ?
→ QueryTurnCoordinator ?
→ Query Skill
→ RequirementParserService ?
→ QueryMetadataConstraintService ?
→ NapmMetadataService ?
→ QueryValidator / ExecutionKernelPolicy ?
→ MetricExecutionKernel ?
→ NapmClient
→ NAPM
```

请明确：

1. 哪一步负责自然语言语义解析；
2. 哪一步负责构造 `resolvedQuery`；
3. 哪一步有最终 `southboundAllowed=true/false` 的决定权；
4. 哪一步检查对象与指标是否兼容；
5. 哪一步只是 warning；
6. 哪一步会真正 throw / reject；
7. `metricsForGroup` 是在数据查询之前还是之后调用；
8. 一次非法 `WebApplication + TRTI` 请求到底会产生几次 NAPM southbound。

### 1.2 Direct / Skill Runtime 链

重点检查：

```text
skills/openclaw-napm-query/scripts/run_napm_query.js
```

以及它后续调用的：

```text
RequirementParserService
executeGatewayRequest
prepareGatewayExecution
executeDirectGatewayRequest
MetricExecutionKernel
NapmClient
```

确认 direct 路径是否一定经过 `QueryDecisionPolicy`。

如果 direct 路径不经过，请明确说明：

> 只在 QueryDecisionPolicy 增加兼容性校验，是否仍然存在 direct execute 绕过的可能。

---

# 2. 核验：项目其实已经存在“对象 → 指标归属”能力

重点文件：

```text
skills/openclaw-napm-query/src/constants/objectMetricOwnership.js
```

请检查这些内容：

```text
BUSINESS_OBJECT_TYPES
NON_BUSINESS_OBJECT_TYPES
BUSINESS_METRIC_IDS
NON_BUSINESS_METRIC_IDS
OBJECT_TYPE_DEFAULT_METRIC_PRIORITY

getOwnedMetricIdsForObjectType()
isOwnedMetricForObjectType()
resolveMetricOwnershipObjectType()
isMetricCompatibleWithGroupPath()
```

请本地执行并给出结果：

```js
isMetricCompatibleWithGroupPath(
  [{ type: 'WebApplication' }],
  'TRTI',
  'WebApplication'
)

isMetricCompatibleWithGroupPath(
  [{ type: 'WebApplication' }],
  'PGTME',
  'WebApplication'
)

isMetricCompatibleWithGroupPath(
  [{ type: 'DefinedApp' }],
  'TRTI',
  'DefinedApp'
)
```

我这边观察到的预期是：

```text
WebApplication + TRTI  → false
WebApplication + PGTME → true
DefinedApp + TRTI      → true
```

如果结果一致，则说明：

> 当前问题不能简单描述为“项目没有对象—指标能力矩阵”。

更准确的问题可能是：

> **已有兼容性知识没有被最终执行门禁完整消费。**

---

# 3. 核验：项目还存在第二套指标域 / 对象兼容知识

重点文件：

```text
skills/openclaw-napm-query/src/constants/metricDomains.js
skills/openclaw-napm-query/services/DimensionMappingService.js
```

请确认：

### `application_performance`

是否包含：

```text
TRTI
TRTO
ARTI
ARTO
...
```

以及 preferred objects 是否主要是：

```text
DefinedApp
IPConversation
BusinessGroup
IPAddress
```

### `web_experience`

是否包含：

```text
PGTME
PGNSLPGE
PGSLPCT
PGHTTP400
PGHTTP500
...
```

以及 preferred objects 是否主要是：

```text
WebApplication
PageFamily
User
ClientBusinessGroup
```

再检查：

```js
DimensionMappingService.getObjectsForMetric('TRTI')
DimensionMappingService.getObjectsForMetric('PGTME')
```

请回答：

1. `objectMetricOwnership.js` 和 `metricDomains.js` 是否存在知识重叠；
2. 两者是否都参与实际执行链；
3. 两者冲突时谁是 authoritative source；
4. 是否还有第三份类似知识存在于 `napm-resolution-spec.v1.json`。

如果没有明确 authoritative source，请把它列为架构问题，但不要先新建第五份“统一矩阵”。

---

# 4. 核验：原始问句实际上不仅“指标没识别”，连 TopN workflow 都可能没识别

原始问句：

```text
最近业务访问较慢的前5个业务都有谁？
```

重点文件：

```text
skills/openclaw-napm-query/services/WorkflowClassifierService.js
```

重点函数：

```text
hasRankingIntent()
classifyWorkflow()
```

请直接运行：

```js
WorkflowClassifierService.classifyWorkflow(
  '最近业务访问较慢的前5个业务都有谁？'
)
```

我这边观察到的结果是：

```json
{
  "targetObjectType": "WebApplication",
  "metricSemantic": null,
  "workflowType": null,
  "confidence": 0.2,
  "reason": "workflow_unresolved"
}
```

请重点确认为什么：

```text
“前5个”
“都有谁”
```

没有触发 `hasRankingIntent()`。

当前硬编码 ranking regex 看起来包含：

```text
最大 / 最高 / 最多 / 最小 / 最低
top
排行
排名
是谁
哪个
哪一个
```

但是否缺少：

```text
前5个 / 前10个 / 前N个
有谁 / 都有谁
```

特别注意：

`napm-resolution-spec.v1.json` 的 `topValues.semanticHints` 中似乎已经有：

```text
前N
TopN
```

请确认 WorkflowClassifier 是否真正消费了这些 semanticHints。

如果 spec 写了“前N”，但 classifier 自己另写一套 regex 且没有消费 spec，则属于**语义规则漂移**。

---

# 5. 核验：MetricSemanticNormalizer 名义上统一，但当前覆盖并不完整

重点文件：

```text
skills/openclaw-napm-query/services/MetricSemanticNormalizerService.js
```

请列出 `METRIC_PATTERNS` 当前直接覆盖了哪些指标。

我这边看到主要只有：

```text
PGHTTP400
PGHTTP500
PLI
TPIO
BYTIO
```

请确认是否缺少：

```text
PGTME
PGNSLPGE
PGSLPCT
TRTI
RTTI
RTXI / RTXO
...
```

它虽然支持：

```js
options.specMetricAliases
```

但继续检查：

```text
WorkflowClassifierService.classifyWorkflow()
```

调用：

```js
MetricSemanticNormalizerService.resolveMetricSemantic(text)
```

时是否传入了：

```text
specMetricAliases
```

如果没有，请本地执行：

```js
classifyWorkflow('页面响应时间最高的前5个业务')
classifyWorkflow('服务器响应时间最高的前5个已定义应用')
classifyWorkflow('网络时延最高的前5个IP')
```

检查是否出现：

```text
workflowType = metric_topn
metricSemantic = null
```

如果是，说明：

> WorkflowClassifier 能识别“这是排行”，但它的统一 Metric Semantic 层并没有真正识别 PGTME / TRTI / RTTI。

---

# 6. 核验：Resolver 又独立解析了一次指标

重点文件：

```text
skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js
```

重点函数：

```text
inferMetric()
resolveTopValuesPrompt()
resolvePrompt()
```

当前 `inferMetric()` 是否直接使用：

```js
spec.metrics.aliases
```

通过 `findAliasMatch()` 自己重新匹配自然语言？

如果是，请对比：

```text
WorkflowClassifier
→ MetricSemanticNormalizer

Resolver
→ inferMetric(spec.metrics.aliases)
```

请确认这是不是两套独立的指标语义解析逻辑。

请运行：

```js
resolvePrompt('页面响应时间最高的前5个业务')
resolvePrompt('服务器响应时间最高的前5个已定义应用')
resolvePrompt('网络时延最高的前5个IP')
```

我这边观察到 Resolver 可以分别生成：

```text
WebApplication + PGTME
DefinedApp + TRTI
IPAddress + RTTI
```

但相同 prompt 在 WorkflowClassifier 中 `metricSemantic` 仍可能是 `null`。

如果属实，说明：

> **Classifier 和 Resolver 对“指标是什么”的判断来源并不相同。**

这会造成后续维护时一处生效、一处不生效。

---

# 7. 核验：`慢页面数量` 也存在“某处认识、主链不认识”的现象

检查：

```text
skills/openclaw-napm-query/services/TagNormalizer.js
```

里面是否存在：

```text
slow_page → PGNSLPGE
page_latency → PGTME
```

然后检查 `TagNormalizer` 是否真的被当前 NAPM Query 主链 import / 调用。

再检查：

```text
skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
```

中的：

```text
metrics.aliases.PGNSLPGE
metrics.aliases.PGTME
```

我这边观察到：

```text
PGTME 有：
页面响应时间 / 页面耗时 / 页面时延

PGNSLPGE 在 metrics.aliases 中没有对应 alias
```

请运行：

```js
resolvePrompt('慢页面数量最多的前5个业务')
```

我这边观察到结果是：

```text
missing_metric
```

如果属实，请确认：

> `TagNormalizer` 虽然知道 “慢页面 → PGNSLPGE”，但当前 Resolver 主链并没有消费它。

这正是“项目多个地方都知道一点，但没有形成统一真相源”的具体例子。

---

# 8. 核验：QueryDecisionPolicy 当前是否根本没有对象—指标兼容检查

重点文件：

```text
skills/openclaw-napm-query/services/QueryDecisionPolicy.js
```

请完整检查：

```text
evaluateHighRiskSemanticConsistency()
evaluateQueryDecision()
```

目前它似乎主要检查：

```text
object_inventory contract
multi-group path contract
application traffic + TotalTraffic scope mismatch
required fields / query mode
group argument policy
```

请搜索它是否调用：

```text
isMetricCompatibleWithGroupPath
isOwnedMetricForObjectType
DimensionMappingService.getObjectsForMetric
metricsForGroup
```

如果都没有，请构造：

```js
{
  service: 'topValues',
  queryModeKey: 'topn',

  metric: 'TRTI',
  metrics: ['TRTI'],
  topMetric: 'TRTI',

  groups: [
    { type: 'WebApplication' }
  ],

  topCount: 5,
  start: <合法分钟边界时间>,
  end: <合法分钟边界时间>,

  semanticConstraints: {
    workflowType: 'metric_topn',
    operation: 'rank_top',
    targetObjectType: 'WebApplication'
  },

  userRequirement: '最近业务访问较慢的前5个业务都有谁？'
}
```

执行：

```js
QueryDecisionPolicy.evaluateQueryDecision(...)
```

请确认是不是最终：

```text
action = EXECUTE_QUERY
southboundAllowed = true
```

如果是，这就是当前问题最关键的证据之一：

> **静态 ownership 已明确返回 false，但真正拥有执行放行权的 QueryDecisionPolicy 没消费这个结果。**

---

# 9. 核验：QueryMetadataConstraint 能发现不兼容，但只是 warning

重点文件：

```text
skills/openclaw-napm-query/services/QueryMetadataConstraintService.js
```

重点函数：

```text
buildCompatibility()
```

请用：

```text
metric = TRTI
group = WebApplication
semanticConstraints.targetObjectType = WebApplication
```

跑一次 `constrain()`。

重点确认逻辑：

```js
businessOwnershipViolation || !isCompatible
```

之后，如果：

```text
explicitTarget === currentGroup
```

是否进入：

```text
metric_group_incompatible_but_preserve_explicit_target
```

并且：

```text
只 warnings.push(...)
没有 throw
没有 validation failure
没有 southboundAllowed=false
```

如果属实，说明这个组件当前承担的是：

> **constraint / warning / optional repair**

而不是：

> **final execution gate**

这不是说这个实现一定错，而是需要明确它当前没有“否决权”。

---

# 10. 核验：动态 `metricsForGroup` 也能发现问题，但仍然没有硬阻断

重点文件：

```text
skills/openclaw-napm-query/services/NapmMetadataService.js
```

检查：

```text
reviewQuery()
```

是否会：

```js
getMetricsForGroupPath(query.groups)
```

然后在当前 `query.metric` 不存在于结果中时：

```text
issues.push(
  metric_not_supported_for_group:<metric>
)
```

再看：

```text
QueryMetadataConstraintService.constrainWithDynamicMetadata()
```

是否只是增加：

```text
metric_not_in_dynamic_metrics_for_group:<metric>
```

warning。

再看：

```text
RequirementParserService.applyMetadataDrivenFinalization()
```

如果 metadata repair 没显式开启：

```text
executionOptions.allowMetadataRepair !== true
executionHints.allowMetadataRepair !== true
```

是否会保持原 metric，而不是 block。

请确认最终对于：

```text
WebApplication + TRTI
```

动态 metadata 层的行为到底是：

```text
A. hard reject
B. 自动改成其他 metric
C. warning 后继续
D. 取决于 allowMetadataRepair
```

请给出实际调用结果，不要只看某一个函数。

---

# 11. 核验：静态已知非法组合是否仍然会先访问 NAPM metadata

重点文件：

```text
skills/openclaw-napm-query/services/RequirementParserService.js
```

重点函数：

```text
prepareGatewayExecution()
```

当前顺序看起来类似：

```text
normalizeTopLevelQueryShape
→ QueryMetadataConstraint.constrain
→ argument policy
→ reviewGatewayRequestMetadata
→ metricsForGroup / groups / groupArguments 等 NAPM metadata
→ constrainWithDynamicMetadata
→ applyMetadataDrivenFinalization
→ executeDirectGatewayRequest
```

请确认：

> 在 `WebApplication + TRTI` 已经可以被本地 `objectMetricOwnership` 明确判定为 false 的情况下，是否仍然会调用 `reviewGatewayRequestMetadata()`。

如果会，则即使后面不发 `topValues` 数据查询，仍然已经发生 southbound metadata 请求。

因此请区分两个验收口径：

### 数据查询零调用

```text
topValues / averageValues / timeValues = 0
```

### 所有南向零调用

```text
NapmClient = 0
包括 metricsForGroup / groups / groupArguments
```

如果我们要求“静态明确非法组合零南向”，那么兼容性 hard gate 必须发生在 `reviewGatewayRequestMetadata()` 之前。

---

# 12. 核验：Direct execute 是否也能绕过对象—指标兼容性

重点：

```text
RequirementParserService.executeDirectGatewayRequest()
```

请检查它在进入：

```text
MetricExecutionKernel.execute()
```

之前到底检查了什么。

目前看起来包括：

```text
argument policy
ExecutionKernelPolicy.assertWorkflowServiceContract
QueryValidator.validateGatewayRequest
```

请检查：

```text
QueryValidator
```

是否只验证：

```text
service
start/end
metric/metrics 是否存在
topCount
granularity
```

而完全不检查：

```text
WebApplication + TRTI
```

这种 ownership / compatibility。

如果 direct path 确实没有兼容检查，请确认：

> 单独给 `QueryDecisionPolicy` 加校验，并不能保证所有调用方式都安全。

---

# 13. 核验：`metric`、`metrics[]`、`topMetric` 当前契约是否发生漂移

重点检查：

```text
napm-resolution-spec.v1.json
QueryValidator.js
QueryMetadataConstraintService.js
MetricExecutionKernel.js
run_napm_query.js
```

请分别说明三个字段的当前定义：

```text
metric
metrics[]
topMetric
```

NAPM `topValues` 的业务语义应该允许：

```text
metrics = 返回/查询哪些指标
topMetric = 用哪个指标排序
```

因此不要默认“三者值必须完全相同”。

例如这种结构本身可能是合法的：

```json
{
  "metrics": ["TPI", "TPO"],
  "topMetric": "TPIO"
}
```

请重点检查当前项目：

### Resolution Spec

`topValues.required` 是否是：

```text
service
queryModeKey
metrics
topMetric
start
end
```

### QueryValidator

是否反而要求：

```text
target.metric
```

并默认：

```text
topCount = 20
```

请判断这是不是 Query Contract 漂移。

这不是当前 `TRTI + WebApplication` 的唯一根因，但会让以后统一兼容校验变复杂。

---

# 14. 核验：root config 与 skill-local config 是否已经存在双真相源

比较：

```text
/config/napm-resolution-spec.v1.json
/skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
```

以及：

```text
/config/object-ontology.v1.json
/skills/openclaw-napm-query/config/object-ontology.v1.json
```

请检查两份是否完全一致。

我这边看到至少：

```text
timeValues.required
```

存在差异：

一份要求：

```text
groups
```

另一份不要求。

请列出实际 diff，并确认运行时到底加载哪一份。

这属于“谁是 authoritative source”的另一个问题。

---

# 15. 不要把“业务访问较慢”直接当作 PGTME 同义词，先核验业务语义

请检查当前 WebApplication 可用的“慢”相关指标是否至少包含：

```text
PGTME    页面响应/页面时延
PGNSLPGE 慢页面数量
PGSLPCT  慢页面百分比
PGSLRT   慢页面率
PGTMC    页面服务端时延
PGTMS    页面客户端时延
```

然后回答：

```text
“业务访问较慢”
```

在没有产品规则的情况下，是否真的能够**唯一**映射为 `PGTME`。

请把下面两类情况区分开：

### 明确指标语义

```text
“页面响应时间最高”
→ PGTME

“慢页面数量最多”
→ PGNSLPGE

“服务器响应时间最高的已定义应用”
→ TRTI

“网络时延最高的 IP”
→ RTTI
```

### 现象描述 / 潜在歧义

```text
“业务访问较慢”
“网站很慢”
“业务很卡”
```

如果存在多个合理指标，应明确：

```text
A. 产品定义默认 metric
或
B. 要求澄清
```

不要把“默认策略”和“语义同义词”混成一件事。

---

# 16. 请重点回答：当前真正缺的是“新能力矩阵”，还是“已有能力没有收口”

请在完整代码审查后明确选择：

## 情况 A：项目确实缺少对象—指标兼容知识

如果 `objectMetricOwnership`、`metricDomains` 等实际上没有参与有效判断，那么说明需要建立新能力。

## 情况 B：项目已经有兼容知识，但没有统一执行否决权

如果下面同时成立：

```text
objectMetricOwnership:
WebApplication + TRTI = false

DimensionMapping:
TRTI 不偏好 WebApplication

QueryMetadataConstraint:
发现 incompatible

NapmMetadataService:
metricsForGroup 发现不支持

QueryDecisionPolicy:
仍然 EXECUTE_QUERY
```

那么根因应该描述成：

> **现有多个兼容判断没有汇聚到统一的 executable validation contract。**

这种情况下，不建议先创建另一套新的 `UnifiedCapabilityMatrix`，而应优先决定：

```text
哪些现有知识是 authoritative
↓
由哪个共享 Validator 消费
↓
所有执行入口都必须经过它
```

---

# 17. 请验证下面这张“当前可能真实链路”

请不要直接接受，逐节点验证：

```text
用户：
“最近业务访问较慢的前5个业务都有谁？”
        │
        ▼
ObjectOntology
“业务” → WebApplication
        │
        ├───────────────┐
        │               │
        ▼               ▼
WorkflowClassifier   MetricSemanticNormalizer
workflow unresolved  metricSemantic = null
        │
        ▼
Resolver
自己用 spec aliases 再解析一次
        │
        ├─ 当前原始问句：
        │    ranking intent 也可能未识别
        │    → unsupported_prompt
        │
        └─ 如果模型/外部直接提交：
             WebApplication + TRTI
                    │
                    ▼
QueryDecisionPolicy
检查 query shape / 高风险场景
但未检查 metric ownership
                    │
                    ▼
EXECUTE_QUERY ?
                    │
                    ▼
QueryMetadataConstraint
发现 TRTI + WebApplication incompatible
但显式 target → warning / preserve
                    │
                    ▼
RequirementParser
调用 runtime metadata
                    │
                    ▼
metricsForGroup
再次发现 TRTI 不支持
                    │
                    ▼
warning / issue
                    │
                    ▼
QueryValidator
只校验 shape，不校验 ownership
                    │
                    ▼
MetricExecutionKernel
                    │
                    ▼
NapmClient
                    │
                    ▼
NAPM
```

请指出哪些箭头与真实代码不符。

---

# 18. 必须做的本地复现

请至少执行下面测试，并贴出精简结果。

## A. Workflow classification

```text
最近业务访问较慢的前5个业务都有谁？
页面响应时间最高的前5个业务
慢页面数量最多的前5个业务
服务器响应时间最高的前5个已定义应用
网络时延最高的前5个IP
```

输出：

```text
workflowType
targetObjectType
metricSemantic
reason
```

---

## B. Resolver

同样 5 个问句，输出：

```text
ok
reason
service
group type
metric
metrics
topMetric
topCount
```

---

## C. Static ownership

```text
WebApplication + TRTI
WebApplication + PGTME
WebApplication + PGNSLPGE
DefinedApp + TRTI
IPAddress + RTTI
IPAddress + PLI
```

---

## D. QueryDecisionPolicy

构造合法 shape：

```text
topValues + WebApplication + TRTI
```

确认：

```text
action
outcome
southboundAllowed
reasonCode
```

---

## E. QueryMetadataConstraint

同一个 Query，确认：

```text
compatibility.isCompatible
warnings
corrections
最终 group
最终 metric
```

分别测试：

```text
allowMetadataRepair = false
allowMetadataRepair = true
```

---

## F. Direct execute 零调用测试

用 mock / spy 替换：

```text
NapmClient.get()
```

然后直接调用执行入口。

对于：

```text
WebApplication + TRTI
```

统计：

```text
QueryDecisionPolicy 调用次数
reviewGatewayRequestMetadata 调用次数
NapmClient.get 调用次数
topValues 调用次数
metricsForGroup 调用次数
```

不要真的连接远端 NAPM。

---

# 19. 最后请按这个格式给结论

```markdown
## 核验结论

### 1. 原始问句为什么失败
- ...
- ...

### 2. 对象识别是否正确
- CONFIRMED / NOT_FOUND
- 证据：

### 3. 指标语义是否存在多套解析
- CONFIRMED / NOT_FOUND
- 证据：

### 4. WebApplication + TRTI 是否已经能被项目识别为不兼容
- CONFIRMED / NOT_FOUND
- 证据：

### 5. QueryDecisionPolicy 是否仍会放行
- CONFIRMED / NOT_FOUND
- 证据：

### 6. QueryMetadataConstraint 是否只是 warning
- CONFIRMED / NOT_FOUND
- 证据：

### 7. metricsForGroup 是否只是 issue/warning，而不是 hard reject
- CONFIRMED / NOT_FOUND
- 证据：

### 8. Direct execute 是否可能绕过 QueryDecisionPolicy
- CONFIRMED / NOT_FOUND
- 证据：

### 9. 当前是否存在多个 truth source
- CONFIRMED / NOT_FOUND
- 具体有哪些：

### 10. 真正根因
请只写代码证据能支持的根因，不先给改造方案。

### 11. 最小修复边界
只说明必须修哪几个决策点，不要开始改代码。

### 12. 长期架构问题
把长期重构和当前 bug 修复分开。
```

---

# 20. 本轮最重要的审查原则

请特别避免下面几种方式：

```text
1. 看到 TRTI + WebApplication 就直接新增一个 PGTME patch。
2. 没核实现有 objectMetricOwnership 就新建第五套 capability matrix。
3. 把“业务访问较慢”直接等同于 PGTME，不检查是否存在语义歧义。
4. 只修改 QueryDecisionPolicy，不检查 direct execute 是否绕过。
5. 把 metric / metrics / topMetric 强制要求值完全相同。
6. 把 runtime metricsForGroup 当成静态已知非法组合的第一道门禁。
7. 在 Hook、Plugin、Resolver、Policy、Runner 中分别复制相同正则。
8. 一边审查一边大范围改代码，导致无法确认真实根因。
```

本轮目标只有一个：

> **先把“谁负责理解指标、谁负责判断对象兼容、谁拥有最终执行否决权”这三件事在当前代码里查清楚。**

确认真实链路后，再讨论最小修复和长期收口方案。
