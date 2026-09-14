# GAIOP NAPM Query 下一轮设计对齐指令（给 Codex）

> 背景：上一轮代码核验已经基本确认核心事实：
>
> - 项目并不缺少对象、指标、对象—指标兼容知识；
> - `WebApplication + TRTI` 已经能被现有静态 ownership / domain / metadata 判断为不兼容；
> - 但这些判断没有收敛成所有执行入口共享的、具有最终否决权的 executable validation contract；
> - `WorkflowClassifier`、`MetricSemanticNormalizer`、Resolver aliases、`TagNormalizer`、语义文档之间存在多套指标语义来源；
> - `QueryDecisionPolicy` 会放行非法 `WebApplication + TRTI`；
> - `QueryMetadataConstraint` 和 runtime `metricsForGroup` 能发现问题，但当前主要是 warning / issue / repair，不是统一 hard reject；
> - direct runtime 可以绕过 `QueryDecisionPolicy`；
> - `metric / metrics[] / topMetric` 存在契约漂移；
> - 原始问句“最近业务访问较慢的前5个业务都有谁？”还存在 TopN 识别和指标语义识别两层问题。
>
> **本轮目标：只做设计对齐，不修改代码。**
>
> 请基于当前分支真实代码，给出一个“最小可实施设计”，重点回答下面 5 个核心设计问题，并明确现有文件如何复用。不要再新增一套重复 truth source。

---

# 1. 静态对象—指标兼容知识：谁是 authoritative source？

当前至少存在：

```text
objectMetricOwnership.js
metricDomains.js
DimensionMappingService.js
napm-resolution-spec.v1.json 中的 metric/domain/ownership 信息
runtime metricsForGroup
```

请设计并明确：

## 1.1 每一份现有知识未来保留什么职责

请按下面格式输出：

```markdown
| 组件 | 当前职责 | 未来职责 | 是否 authoritative | 是否参与 hard gate |
|---|---|---|---|---|
| objectMetricOwnership.js | ... | ... | YES/NO | YES/NO |
| metricDomains.js | ... | ... | YES/NO | YES/NO |
| DimensionMappingService | ... | ... | YES/NO | YES/NO |
| Resolution Spec | ... | ... | YES/NO | YES/NO |
| metricsForGroup | ... | ... | YES/NO | YES/NO |
```

## 1.2 不要新建第五套 capability matrix

如果现有 `objectMetricOwnership.js` 已经足够表达：

```text
WebApplication + TRTI     → incompatible
WebApplication + PGTME    → compatible
DefinedApp + TRTI         → compatible
IPAddress + RTTI          → compatible
```

优先复用。

如果它表达能力不足，请明确指出“缺什么”，再说明是扩展现有结构，还是需要新增新结构。

## 1.3 静态与动态能力分层

请明确设计三态结果：

```text
KNOWN_COMPATIBLE
KNOWN_INCOMPATIBLE
UNKNOWN
```

建议语义：

```text
KNOWN_INCOMPATIBLE
→ 直接 VALIDATION_FAILURE
→ 0 次 southbound

KNOWN_COMPATIBLE
→ 可以继续

UNKNOWN
→ 进入 runtime metadata / metricsForGroup 再确认
```

请确认这种三态是否适合当前项目。

---

# 2. 指标语义：统一成一条主链

当前至少存在：

```text
MetricSemanticNormalizerService
WorkflowClassifierService
Resolver 的 spec.metrics.aliases / inferMetric()
TagNormalizer
chinese-semantic-metric-mapping.md
Resolution Spec aliases
```

上一轮已经确认：

- `MetricSemanticNormalizerService` 内建规则覆盖不完整；
- 它支持 `specMetricAliases`，但 `WorkflowClassifierService` 当前调用时没有传；
- Resolver 又自己基于 Spec aliases 独立解析指标；
- `TagNormalizer` 认识一些映射，但主链未必引用；
- `chinese-semantic-metric-mapping.md` 有既定中文语义规则，但未形成正式 executable source。

请设计一条唯一主链：

```text
用户自然语言
→ WorkflowClassifier
→ MetricSemanticNormalizer
→ structured metric intent
→ Resolver
```

## 2.1 请明确唯一指标语义入口

请回答：

```text
谁负责把自然语言“页面响应时间 / 服务器响应时间 / 网络时延 / 慢页面数量”解析成 canonical metric？
```

推荐候选是：

```text
MetricSemanticNormalizerService
```

但请基于当前代码判断是否应该由它承担。

## 2.2 Resolver 不应再独立理解指标

如果采用统一 Normalizer，请设计：

```text
WorkflowClassifier
↓
metricSemantic = resolved / ambiguous / unresolved
↓
Resolver 只消费结构化结果
```

而不是：

```text
WorkflowClassifier 解析一次
Resolver inferMetric() 再解析一次
```

请明确：

- `inferMetric()` 是否保留；
- 如果保留，是否只作为 compatibility fallback；
- 哪些旧 alias matching 应删除 / 降级。

## 2.3 `chinese-semantic-metric-mapping.md` 的定位

请确认它是否应该成为正式产品语义规范。

目前文档规则包括：

```text
业务/WebApplication + 慢/响应慢 → PGTME
慢页面数量 → PGNSLPGE
慢页面占比 → PGSLPCT
服务器响应时间 → TRTI
网络时延 → RTTI
```

请明确：

- 这份文档是否 authoritative；
- 如果是，如何让代码消费它；
- 是否应该转成机器可读配置；
- 还是仅作为 reference，由 Resolution Spec/配置承载最终规则。

请避免：

```text
文档一份
Normalizer 一份
Resolver aliases 一份
TagNormalizer 一份
```

继续并存。

---

# 3. 设计共享 `ResolvedQueryCompatibilityValidator`

请设计一个纯结构化 Validator，**不允许解析自然语言**。

建议名字：

```text
ResolvedQueryCompatibilityValidator
```

如果你认为已有 Service 更适合承载，也可以复用现有类，但要说明理由。

## 3.1 输入

建议只接受：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "groups": [{ "type": "WebApplication" }],
  "metric": "PGTME",
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "topCount": 5,
  "start": 0,
  "end": 0,
  "semanticConstraints": {
    "workflowType": "metric_topn",
    "operation": "rank_top",
    "targetObjectType": "WebApplication"
  }
}
```

不要读取 raw prompt。

## 3.2 至少校验这些维度

```text
service contract
group/path contract
argument policy
metric existence
metric 对象兼容性
metrics[] 每个指标的对象兼容性
topMetric 的对象兼容性
service 与 query shape 是否匹配
```

注意：

```text
metric
metrics[]
topMetric
```

要分别校验用途，不要强制值完全相同。

## 3.3 输出契约

请设计明确的结构，例如：

```json
{
  "valid": false,
  "status": "KNOWN_INCOMPATIBLE",
  "reasonCode": "METRIC_OBJECT_INCOMPATIBLE",
  "issues": [
    {
      "field": "topMetric",
      "metric": "TRTI",
      "objectType": "WebApplication"
    }
  ]
}
```

请定义：

```text
KNOWN_COMPATIBLE
KNOWN_INCOMPATIBLE
UNKNOWN
```

分别如何处理。

## 3.4 Validator 只做判断，不做关键词 repair

不要让它再写：

```text
慢
快
访问
服务器
客户端
```

之类 regex。

它只消费结构化 Query。

---

# 4. Validator 在哪里调用？必须封住所有入口

上一轮已经确认：

```text
Plugin / Hook
会经过 QueryDecisionPolicy

Skill Runtime / Direct
不一定经过 QueryDecisionPolicy
```

因此请设计 Validator 的调用位置。

建议至少三层：

```text
QueryDecisionPolicy
        │
        └─ Shared CompatibilityValidator

prepareGatewayExecution
        │
        └─ Shared CompatibilityValidator
           （必须在 metadata review 之前）

executeDirectGatewayRequest
        │
        └─ Shared CompatibilityValidator
           （最后防线）
```

## 4.1 Plugin / Policy 路径

目标：

```text
非法 ResolvedQuery
→ QueryDecisionPolicy
→ VALIDATION_FAILURE
→ Query Skill invocation = 0
→ NapmClient = 0
```

## 4.2 prepareGatewayExecution 路径

Validator 必须位于：

```text
reviewGatewayRequestMetadata()
```

之前。

因为后者会产生：

```text
applications
metricsForGroup
groups
groupArguments
```

等 southbound metadata 请求。

对于静态明确非法：

```text
WebApplication + TRTI
```

目标：

```text
metadata review = 0
NapmClient = 0
metricsForGroup = 0
topValues = 0
```

## 4.3 executeDirectGatewayRequest 路径

即使有人直接调用 direct，也必须再次防御：

```text
CompatibilityValidator
→ fail fast
```

请确认是否还有其他可以直接进入：

```text
MetricExecutionKernel
NapmClient
```

的入口，也需要覆盖。

---

# 5. 正式统一 Query Contract：`metric / metrics[] / topMetric`

这是本轮最关键的设计问题之一。

请基于：

```text
Resolution Spec
QueryValidator
Plugin validation
QueryMetadataConstraint
MetricExecutionKernel
NAPM API 构造规则
```

正式定义三者。

## 5.1 `metrics[]`

请明确：

```text
查询 / 返回哪些指标
```

例如：

```json
"metrics": ["TPI", "TPO"]
```

## 5.2 `topMetric`

请明确：

```text
topValues 的排序指标
```

例如：

```json
"topMetric": "TPIO"
```

## 5.3 `metric`

请明确它在 GAIOP 内部到底是什么：

候选：

```text
A. primary/canonical semantic metric
B. legacy compatibility field
C. derived field
D. 不再作为 canonical source
```

请给出明确结论。

## 5.4 重要：不要要求 `topMetric ∈ metrics[]`

现有 NAPM API 构造资料已有合法例子：

```text
metrics=TPI,TPO
topMetric=TPIO
```

所以请检查并设计如何修正当前：

```text
Plugin 要求 topMetric 必须出现在 metrics[]
```

这类规则。

## 5.5 不要强制三者相等

不要写成：

```text
metric = metrics[0] = topMetric
```

正确设计应该允许：

```json
{
  "metrics": ["PGNPGE", "PGTME", "PGHTTP500"],
  "topMetric": "PGTME"
}
```

同时确保每个字段都与当前 Group Path / Object 合法。

---

# 6. Repair 机制要设计成“原子 Query repair”

上一轮本地复现出现了：

```text
metric    = PGTME
metrics   = [PGTME]
topMetric = TRTI
```

说明当前 metadata repair 会造成 Query 内部语义分裂。

请设计：

```text
ResolvedQuery Repair Transaction
```

要求：

- repair 不能只改一个字段；
- 必须理解 `metric / metrics[] / topMetric` 各自角色；
- repair 后必须重新执行 CompatibilityValidator；
- 如果无法唯一安全修复，必须失败或要求 clarification；
- 不要默默生成“半修复 Query”。

请说明：

```text
哪些情况允许自动 repair
哪些情况必须 hard reject
哪些情况必须 clarification
```

---

# 7. 原始问句应该如何进入主链

请以：

```text
最近业务访问较慢的前5个业务都有谁？
```

为完整示例，设计改造后的每一步输出。

如果项目确认：

```text
WebApplication + 慢/响应慢 → PGTME
```

是正式产品语义规则，那么目标可以是：

```text
用户问句
↓
WorkflowClassifier
  operation = rank_top
  targetObjectType = WebApplication
  metricSemantic = PGTME
  topCount = 5
↓
Resolver
  service = topValues
  groups = [{ type: WebApplication }]
  metrics = [PGTME]
  topMetric = PGTME
  topCount = 5
↓
CompatibilityValidator
  KNOWN_COMPATIBLE
↓
runtime metadata（必要时）
↓
execute
```

请同时说明：

```text
“慢页面数量最多的前5个业务”
→ PGNSLPGE

“服务器响应时间最高的前5个已定义应用”
→ TRTI + DefinedApp

“网络时延最高的前5个IP”
→ RTTI + IPAddress
```

---

# 8. TopN 识别也要统一

上一轮确认：

```text
前5个
前10个
前N
都有谁
有哪些
```

并没有统一进入 ranking intent。

而 Resolution Spec 中似乎已经存在：

```text
前N
TopN
```

semantic hints。

请设计：

```text
WorkflowClassifier
```

是否应该消费 Spec 的 semantic hints，而不是自己维护另一套 ranking regex。

请明确：

- `hasRankingIntent()` 的规则来源；
- Resolver 的 `isRankingPrompt()` 是否应该删除/降级；
- `topCount` 从哪里统一解析。

---

# 9. Runtime `metricsForGroup` 的最终定位

请明确：

```text
metricsForGroup
```

未来只用于什么。

推荐：

```text
静态 UNKNOWN
→ runtime capability verification

新设备版本 / 复杂 group path
→ runtime confirmation

静态 KNOWN_INCOMPATIBLE
→ 不调用 metricsForGroup
```

请不要让动态 metadata 成为“静态已知非法组合”的第一道门禁。

---

# 10. Error Contract 统一

请正式设计：

```text
VALIDATION_FAILURE
NO_DATA
EXECUTION_FAILURE
```

建议：

## VALIDATION_FAILURE

```text
Query 未进入数据执行
```

例如：

```text
WebApplication + TRTI
```

## NO_DATA

```text
Query 合法
确实执行成功
NAPM 返回 0 行
```

## EXECUTION_FAILURE

```text
HTTP / 网络 / timeout / parse / NAPM error
```

请说明：

- Plugin 层返回什么；
- Skill Runtime 返回什么；
- narration 层如何避免把 VALIDATION_FAILURE 说成“未查到数据”。

---

# 11. PageFamily 第三轮短追问问题：单独 ticket，不混入本补丁

上一轮确认：

```text
“查看第一个都访问了哪些？”
```

存在 `PageFamily → pageViews` result-reference / source type 问题。

请：

```text
只记录为独立 BUG / ticket
```

不要在本轮 Object + Metric + Query Contract + Execution Gate 设计中一起修改。

请给出：

```text
BUG-B:
PageFamily result reference follow-up contract
```

的简短问题描述即可。

---

# 12. 最后必须输出“现有文件怎么处理”

请按下面格式给出：

## A. 保留

```text
文件
原因
未来职责
```

## B. 职责调整

```text
文件
当前职责
调整后职责
```

## C. 删除 / 废弃 / 降级的重复逻辑

例如：

```text
Resolver inferMetric()
某些 duplicated regex
TagNormalizer 重复映射
Plugin 独立 topMetric constraint
```

请基于真实代码决定，不要为了“整洁”随便删除。

## D. 新增文件

只有确有必要才新增。

如果新增：

```text
ResolvedQueryCompatibilityValidator.js
```

请说明为什么不能复用已有 Service。

## E. 调用链 before / after

### Before

```text
prompt
→ multiple semantic parsing
→ policy partial validation
→ warning-only compatibility
→ metadata
→ direct execute
→ NAPM
```

### After

请画出真实目标链。

---

# 13. 最小实施顺序

请给出一个尽量小的顺序，例如：

```text
Step 1
统一 Query Contract

Step 2
抽共享 CompatibilityValidator

Step 3
接入 Policy / prepare / direct

Step 4
统一 Metric Semantic 主链

Step 5
统一 TopN intent / topCount

Step 6
修 repair transaction

Step 7
补测试

Step 8
再决定是否收敛 root / skill-local config
```

如果你认为顺序不同，请说明理由。

---

# 14. 必须给出的回归测试清单

至少包括：

```text
1. 最近业务访问较慢的前5个业务都有谁？
   → WebApplication + PGTME + topValues + 5

2. 页面响应时间最高的前5个业务
   → WebApplication + PGTME

3. 慢页面数量最多的前5个业务
   → WebApplication + PGNSLPGE

4. 服务器响应时间最高的前5个已定义应用
   → DefinedApp + TRTI

5. 网络时延最高的前5个IP
   → IPAddress + RTTI

6. WebApplication + TRTI
   → VALIDATION_FAILURE
   → 0 metadata southbound
   → 0 data southbound

7. DefinedApp + TRTI
   → allowed

8. IPAddress + PLI
   → allowed

9. metrics=[TPI,TPO], topMetric=TPIO
   → contract allowed

10. metrics=[PGNPGE,PGTME,PGHTTP500], topMetric=PGTME
    → allowed

11. metadata repair 不得出现
    metric=PGTME
    metrics=[PGTME]
    topMetric=TRTI

12. Plugin path 非法 query
    Query Skill invocation = 0

13. executeGatewayRequest 非法 query
    metadata review = 0
    NapmClient = 0

14. executeDirectGatewayRequest 非法 query
    NapmClient = 0

15. 合法 Query 返回 0 行
    → NO_DATA
    不能返回 VALIDATION_FAILURE
```

---

# 15. 本轮输出格式

请严格按下面结构回答：

```markdown
# 设计结论

## 1. authoritative sources
...

## 2. Metric Semantic 单一主链
...

## 3. ResolvedQueryCompatibilityValidator 设计
...

## 4. 三个执行入口如何接入
...

## 5. Query Contract
### metric
...
### metrics[]
...
### topMetric
...

## 6. Repair Contract
...

## 7. Runtime Metadata 定位
...

## 8. Error Contract
...

## 9. 文件级改造清单
### 保留
### 职责调整
### 删除/降级
### 新增

## 10. Before / After 调用链
...

## 11. 最小实施顺序
...

## 12. 回归测试
...

## 13. 独立 BUG-B：PageFamily 第三轮短追问
...
```

---

# 16. 本轮约束

```text
1. 不修改代码。
2. 不访问远端 NAPM。
3. 不创建新 capability matrix，除非证明现有结构无法表达。
4. 不在 QueryDecisionPolicy 中新增自然语言 regex。
5. 不在 Hook / Direct / Runner 各复制一套 compatibility 逻辑。
6. 不要求 metric / metrics[] / topMetric 完全一致。
7. 不要求 topMetric 必须出现在 metrics[]。
8. 不把 PageFamily follow-up bug 混进同一个实现补丁。
9. 所有设计必须基于当前真实文件和调用链。
10. 如果你不同意任何一条，请明确指出并给出代码证据。
```

本轮目标不是“多写设计”，而是把下面四件事彻底定死：

```text
谁负责理解指标？
谁负责判断对象—指标兼容？
谁拥有最终执行否决权？
ResolvedQuery 的 canonical contract 到底是什么？
```

这四件事一旦对齐，下一轮才进入代码修改。
