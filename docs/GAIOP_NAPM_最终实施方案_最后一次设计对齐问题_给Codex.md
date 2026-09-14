# GAIOP NAPM Query 最终实施方案——最后一次设计对齐问题（给 Codex）

> 背景：已阅读你给出的《2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案》。
>
> 整体方案已基本认可，核心架构方向没有重大异议。  
> 当前只剩少量边界问题需要在实施前彻底定死。
>
> **本轮仍然不修改代码、不连接远端、不提交 commit。**
>
> 目标：回答完下面 7 个问题后，冻结最终设计，下一轮进入实施。

---

# 1. `rank_bottom / asc` 当前只有语义，没有真正闭环到执行契约

你的方案已经定义：

```text
最低的5个
最少的5个
→ direction=asc
→ rank_bottom
```

并且 Ranking Grammar 与测试中也包含：

```text
最低的5个
最少的5个
→ direction=asc
```

但当前 canonical `topValues` Execution Contract 中只有：

```text
metrics[]
topMetric
topCount
groups
start/end
```

Serializer 也只发送：

```text
metrics
topMetric
topCount
groups
start/end
```

NAPM 当前材料中也没有看到：

```text
direction=asc
order=asc
bottom=true
```

之类正式参数。

所以必须回答：

## 1.1 NAPM 是否真的支持 BottomN / Ascending Top？

请只基于：

```text
当前项目代码
已有 NAPM 接口材料
HAR / 已知真实请求
```

回答。

如果支持，请给出：

```text
真实参数
真实 service
真实示例
```

并纳入 canonical contract。

---

## 1.2 如果 NAPM 不支持直接 BottomN

不能这样做：

```text
topValues(topCount=5)
→ 拿到最大5个
→ 本地 asc 排序
→ 当作最小5个
```

这是错误结果。

请明确采用以下哪一种策略：

### A. 有完整候选集能力

```text
先获取完整/足够候选
→ 本地按 metric asc 排序
→ 取前 N
```

必须定义：

```text
最大候选数量
分页/上限
结果完整性保证
性能边界
```

### B. 无法保证 BottomN 正确性

则：

```text
rank_bottom
→ UNSUPPORTED / VALIDATION_FAILURE / clarification
```

不能生成一个语义上正确、执行上错误的 Query。

---

## 1.3 请补 execution-level contract test

现在不能只测：

```text
“最低的5个”
→ direction=asc
```

还必须测：

```text
最终返回的5个
确实是整个候选范围中的最小5个
```

---

# 2. Metadata Service Contract 需要区分 GAIOP abstraction 与 NAPM 原生 service

方案中目前定义了：

```text
service="groups"
required: groups[]

service="metrics"
required: groups[]
```

这里需要再次核实。

NAPM 原生语义通常是：

```text
type=groups
→ 返回 group 定义/树
→ 本身不一定需要输入 groups

type=metrics
→ 返回全局指标目录
→ 本身不需要 group

type=metricsForGroup
→ 返回某 Group Path 可用指标
→ 需要 group path
```

所以请明确：

## 2.1 GAIOP 的 `service="metrics"` 到底表示什么？

如果它同时表示：

```text
全局指标目录
+
某对象可用指标
```

这是一个 overloaded contract。

请考虑明确拆成概念：

```text
metric_catalog
→ NAPM metrics

metric_capability
→ NAPM metricsForGroup
```

不一定必须改 service 名，但必须在设计里区分语义与 required fields。

---

## 2.2 `groups` 也要区分

请明确：

```text
group_catalog / group_tree
```

与：

```text
某个 Group Path 上的 runtime query
```

不是同一层含义。

不要为了适配 GAIOP 内部已有 shape，把 NAPM metadata service 的真实契约永久扭曲。

---

# 3. `primaryMetric` 需要改成真正 optional，并补 `rankingMetric`

方案当前一处写：

```text
primaryMetric
= 指标查询通常必填
= 不足时澄清
```

但 regression matrix 又写：

```text
多指标 average/time query
无 primaryMetric
→ 可以合法执行
```

这两者需要统一。

## 3.1 建议正式定义

```text
primaryMetric
= optional
= 用户语义上主要关注的指标
```

只有某类 operation 真正需要唯一主指标时才 required。

例如：

```text
rank_top / rank_bottom
→ 需要 ranking metric

averageValues / timeValues 多指标
→ 不一定需要 primaryMetric
```

示例：

```json
{
  "operation": "timeseries",
  "targetObjectType": "WebApplication",
  "requestedMetrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ]
}
```

这是完整语义，不需要强行制造 `primaryMetric`。

---

## 3.2 建议正式增加 `rankingMetric`

当前方案文字里已经提到：

```text
topMetric
由 primaryMetric 或明确 rankingMetric 生成
```

但 Semantic Contract schema 中没有正式定义 `rankingMetric`。

建议：

```json
{
  "operation": "rank_top",
  "targetObjectType": "WebApplication",
  "primaryMetric": "PGTME",
  "requestedMetrics": [
    "PGNPGE",
    "PGTME",
    "PGHTTP500"
  ],
  "rankingMetric": "PGTME",
  "topCount": 5
}
```

职责：

```text
primaryMetric
= 用户核心关注指标，可选

requestedMetrics[]
= 用户要求展示/返回哪些指标

rankingMetric
= 排行依据，仅 ranking operation 必需
```

Resolver 映射：

```text
requestedMetrics[]
→ metrics[]

rankingMetric
→ topMetric
```

这样对：

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

这种合法能力也更自然。

---

# 4. Validator 不要承载 orchestration policy

你的方案强调：

```text
ResolvedQueryExecutableValidator
= 无副作用校验编排器
```

这个方向正确。

但示例输出中又包含：

```text
skillInvocationAllowed
metadataSouthboundAllowed
dataSouthboundAllowed
```

这些字段已经属于 orchestration / policy 概念。

建议最终边界：

## Validator 输出

只返回：

```json
{
  "ok": false,
  "status": "KNOWN_INCOMPATIBLE",
  "reasonCode": "OBJECT_METRIC_INCOMPATIBLE",
  "issues": [],
  "requiredRuntimeChecks": []
}
```

例如：

```text
VALID
CONTRACT_INVALID
METRIC_UNKNOWN
KNOWN_INCOMPATIBLE
UNKNOWN
```

## Policy / Orchestrator 映射

由：

```text
QueryDecisionPolicy
RequirementParser orchestration
```

决定：

```text
是否允许调用 Skill
是否允许 metadata southbound
是否允许 data southbound
```

这样 Validator 才真正保持：

```text
只判断
不懂 Plugin 生命周期
不懂 Skill invocation
不懂 southbound orchestration
```

如果你坚持让 Validator 输出 allowed flags，请说明为什么这不构成职责泄漏。

---

# 5. LegacyMetricInputAdapter 的冲突规则需要唯一结论

当前方案有两类描述：

### 情况 A

```text
已有 metrics[] + topMetric
同时存在 metric

→ canonical 字段为准
→ 删除 metric
→ deprecation warning
```

### 情况 B

```text
metric 与 metrics[] / topMetric 冲突

→ LEGACY_METRIC_CONFLICT
→ 先 warning 后 reject
```

这两种规则在某些输入下会重叠。

例如：

```json
{
  "metrics": ["PGTME"],
  "topMetric": "PGTME",
  "metric": "TRTI"
}
```

到底：

```text
A. 忽略 metric，只 warning
```

还是：

```text
B. 因冲突 reject
```

必须在实施前定死。

建议给出完整决策表：

```markdown
| 输入情况 | canonical 输出 | warning | reject |
|---|---|---|---|
| legacy-only metric | ... | ... | ... |
| canonical + same metric | ... | ... | ... |
| canonical + conflicting metric | ... | ... | ... |
| partial canonical + metric | ... | ... | ... |
```

核心原则要明确：

```text
legacy metric 是否永远无权覆盖 canonical 字段？
```

如果答案 YES，那么 conflict 应该是：

```text
兼容期 warning
+
canonical 字段继续生效
```

还是：

```text
为了避免隐藏调用方 bug，直接 reject
```

二选一，不能实施时临时判断。

---

# 6. `KNOWN_COMPATIBLE` 的语义范围必须明确

方案现在定义：

```text
KNOWN_COMPATIBLE
→ 不调用 metricsForGroup
→ 直接继续
```

这只有在一个前提成立时才完全安全：

> `objectMetricOwnership` 对已覆盖对象给出的 compatible，不只是“语义允许”，而是 GAIOP 可以据此直接认为当前标准 NAPM 能力可执行。

请明确 `KNOWN_COMPATIBLE` 到底代表：

## A. 静态产品准入

```text
从 GAIOP 语义上允许
但设备版本是否真的支持仍可能不同
```

如果是 A，那么可能仍需要 runtime capability confirmation。

## B. 静态完整执行准入

```text
对这个被标记为 exhaustive coverage 的 Object × Metric
可以直接执行
无需 metricsForGroup 再确认
```

如果是 B，请在：

```text
objectMetricOwnership
```

中明确 coverage metadata，例如：

```text
exhaustive: true/false
```

或者等价机制。

最终建议三态语义写清楚：

```text
KNOWN_COMPATIBLE
= 当前对象属于静态穷举覆盖范围，metric 在允许集合中

KNOWN_INCOMPATIBLE
= 当前对象属于静态穷举覆盖范围，metric 不在允许集合中

UNKNOWN
= 当前对象/path 未被静态穷举覆盖
```

这样 `metricsForGroup` 只处理 UNKNOWN 才逻辑闭环。

---

# 7. 最终调用链需要把 QueryDecisionPolicy 与 Legacy Adapter 的 canonical boundary 画清楚

方案文字说：

```text
QueryDecisionPolicy
prepare
direct
Kernel
```

都调用 Shared Validator。

但 After Mermaid 主链里：

```text
Resolver
→ LegacyMetricInputAdapter
→ Normalizer
→ Validator
→ prepare
```

没有清楚画出 QueryDecisionPolicy 的准确位置。

请最终明确：

## 7.1 正常 Semantic → Resolver 路径

如果 Resolver 已经产出 canonical query：

```text
Semantic Contract
→ Resolver
→ Canonical Normalizer
→ Validator
→ QueryDecisionPolicy 映射 Decision
→ Query Skill
```

是否还需要 Legacy Adapter？

正常新链路最好：

```text
不经过 Legacy Adapter
```

---

## 7.2 Legacy 外部输入路径

例如旧 Tool caller：

```text
legacy queryDraft
→ LegacyMetricInputAdapter
→ Canonical Normalizer
→ Validator
→ QueryDecisionPolicy
```

Adapter 只运行一次。

---

## 7.3 Skill Runtime

请明确：

```text
QueryDecisionPolicy 已通过
→ Query Skill
→ prepareGatewayExecution
→ Shared Validator 再次防御
→ Runtime Capability（仅 UNKNOWN）
→ pre-execution Validator
→ Serializer
→ Kernel assertion
→ NapmClient
```

---

## 7.4 Direct Runtime

```text
direct caller
→ canonical/legacy boundary
→ Shared Validator
→ ...
```

不能出现：

```text
direct caller
→ Kernel
```

绕过 canonical boundary。

---

# 8. 请同步修正最终方案与测试矩阵

以上问题对齐后，请更新最终设计文档，至少补：

```text
1. rank_bottom 的真正执行策略/不支持策略
2. metadata service contract 的准确分层
3. primaryMetric optional
4. rankingMetric 正式进入 Semantic Contract
5. Validator 与 orchestration 的职责边界
6. LegacyMetricInputAdapter conflict decision table
7. KNOWN_COMPATIBLE 的 coverage/exhaustive 定义
8. QueryDecisionPolicy / Legacy Adapter / canonical boundary 的最终调用链
```

同时补回归测试：

```text
A. BottomN execution correctness
不能只测 direction=asc

B. global metrics catalog
与 metricsForGroup capability query 分开

C. 多指标 average/time 无 primaryMetric
→ PASS

D. rankingMetric != requestedMetrics[0]
→ 正确生成 topMetric

E. canonical fields + conflicting legacy metric
→ 按最终明确策略处理

F. KNOWN_COMPATIBLE exhaustive coverage
→ 不调用 metricsForGroup

G. non-exhaustive object/path
→ UNKNOWN
→ 只调用 runtime capability

H. 正常新 Semantic 路径
→ Legacy Adapter 调用次数 = 0

I. legacy 输入路径
→ Legacy Adapter 调用次数 = 1
```

---

# 9. 本轮最后回答格式

请按以下结构回答：

```markdown
# 最终补充对齐

## 1. BottomN / rank_bottom
- 当前 NAPM 是否支持：
- 证据：
- 最终执行策略：
- Contract：
- Test：

## 2. Metadata Service Contract
- global metric catalog：
- metricsForGroup capability：
- group catalog：
- GAIOP service naming/映射：

## 3. Semantic Metric Fields
- primaryMetric：
- requestedMetrics：
- rankingMetric：
- required/optional 规则：

## 4. Validator Boundary
- Validator 返回：
- Policy/Orchestrator 返回：
- 为什么：

## 5. LegacyMetricInputAdapter
- 决策表：
- conflicting metric 最终策略：

## 6. KNOWN_COMPATIBLE Definition
- exhaustive coverage：
- KNOWN_COMPATIBLE：
- KNOWN_INCOMPATIBLE：
- UNKNOWN：
- 是否需要 runtime check：

## 7. Final Call Chain
- 新 canonical 路径：
- legacy 路径：
- Plugin：
- Skill Runtime：
- direct：
- Kernel：

## 8. Final Document Changes
- 修改哪些章节：
- 新增哪些 contract tests：

## 9. 是否还有未解决设计问题
YES / NO
如果 YES，请列出。
```

---

# 10. 本轮约束

```text
1. 不修改运行时代码。
2. 不连接远端 NAPM。
3. 不提交 commit。
4. 只完成最终设计补充与文档修订。
5. 不为了支持 rank_bottom 猜测 NAPM 不存在的参数。
6. 不允许语义层生成执行层无法保证正确性的 Query。
7. 不重新引入第二套 ownership / metric / ranking truth source。
```

本轮目标：

> 解决最后 7 个设计边界问题。

如果这些问题全部闭环，最终方案即可冻结，下一轮正式进入代码实施。
