# GAIOP NAPM BUG-A 实施指令 — Phase 1：Truth Source 收口

> 前置状态：Phase 0 已通过 Review。
>
> Phase 0 已完成：
>
> - Characterization Tests
> - Southbound Call Counter
> - 当前错误行为基线冻结
> - 全仓测试 / lint / runtime-contract / diff-check 全绿
> - 未修改生产代码和生产行为
>
> **本轮只实施 Phase 1：Truth Source 收口。**
>
> 完成后立即停止，不进入 Phase 2。

---

# 0. 本轮目标

Phase 1 只解决：

```text
同一类知识存在多份 truth source
```

本轮需要收口：

```text
1. Resolution Spec
2. Object × Metric Ownership
3. Metric ID Catalog
4. root / Skill-local 重复配置
5. runtime-contract 对 truth source 漂移的防护
```

本轮允许建立：

```text
objectMetricOwnership tri-state API
exhaustive coverage metadata
supported product baseline metadata
```

但：

> **Phase 1 不允许把这些新能力接进 QueryDecisionPolicy / Runtime 执行门禁。**

也就是说，本轮只建立“正确且唯一的知识源”，不改变 BUG-A 当前执行行为。

---

# 1. 开始前重新记录 Git 基线

先执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --check
```

必须明确区分：

```text
Phase 0 已有变更
Phase 0 之前已有 docs / memory 变更
Phase 1 本轮新增变更
```

禁止：

```text
reset
stash
checkout 覆盖
删除已有测试
```

如果当前工作区存在用户未提交修改：

```text
不要整理掉
不要自动提交
只记录
```

---

# 2. Resolution Spec 唯一化

当前已确认：

```text
/config/napm-resolution-spec.v1.json
/skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
```

内容已经漂移。

最终设计规定：

```text
canonical authoring source
=
skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
```

## 2.1 先查全部读取者

执行：

```bash
rg "napm-resolution-spec\.v1\.json|ResolutionSpecService|resolution-spec" .
```

列出：

```text
运行时读取者
测试读取者
构建/打包读取者
文档引用者
脚本引用者
```

必须先明确：

```text
哪些地方直接读 root spec
哪些地方读 Skill-local spec
哪些地方通过 ResolutionSpecService
```

不要只凭当前某一个 Service 判断。

## 2.2 root Resolution Spec 的最终处理

优先级：

### 方案 A：删除 root 副本

如果没有必须直接读取 root spec 的构建/发布依赖，则：

```text
删除 /config/napm-resolution-spec.v1.json
```

所有消费者统一使用：

```text
skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
```

### 方案 B：生成镜像

如果构建 / 发布 / 工具链必须保留 root 文件，则：

```text
root 文件只能由 Skill-local canonical source 自动生成
```

要求：

```text
禁止人工双向编辑
verify:runtime-contract 必须验证 normalized JSON 等价
```

不能继续：

```text
root 一份
Skill-local 一份
开发者手工同步
```

## 2.3 Phase 1 不扩展 Resolution Spec 业务语义

本轮不要新增：

```text
metricSemanticRules
rankingGrammar
新 aliases
PGTME slow-business 规则
canonical metadata service 新业务内容
```

这些属于 Phase 2 / Phase 3。

本轮只做：

```text
authoritative source 收口
deprecated 标记
读取路径统一
防漂移
```

---

# 3. Resolution Spec execution ownership 先降级，不提前物理删除

当前 Spec 中存在：

```text
metrics.ownershipRules
metrics.ownershipMatrix
metrics.catalog.*.compatibleObjectTypes
metrics.catalog.*.preferredObjectTypes
metrics.catalog.*.ownershipClass
```

这些未来不能继续作为：

```text
Object × Metric execution admission truth
```

但 Phase 1 不应该为了“干净”直接全部删掉。

## 3.1 先找全部读取者

执行：

```bash
rg "ownershipRules|ownershipMatrix|compatibleObjectTypes|preferredObjectTypes|ownershipClass" .
```

逐项记录：

```text
谁读取
用于什么
是否参与执行准入
是否仅展示/推荐
```

## 3.2 Phase 1 目标

本阶段：

```text
1. 标记 deprecated
2. 禁止新增执行读取
3. 新 Validator / Policy / Resolver 不得以后依赖这些字段
4. 如当前生产仍有旧消费者，暂时保留兼容
```

不要在本阶段贸然删除还在运行的旧字段。

最终删除属于后续迁移阶段。

## 3.3 runtime-contract 防止新读取者出现

新增静态校验或 contract test：

```text
Validator
Policy
Resolver
新的执行组件
```

不得新增：

```text
Resolution Spec ownership
```

作为 execution admission 输入。

如果未来代码新增读取：

```text
ownershipMatrix
compatibleObjectTypes
ownershipClass
```

并用于执行准入：

```text
verify:runtime-contract 必须失败
```

实现方式按仓库现有脚本风格设计，不要引入复杂 AST 工具，除非项目已有类似机制。

---

# 4. objectMetricOwnership 唯一化

当前存在：

```text
root objectMetricOwnership.js
Skill-local objectMetricOwnership.js
```

Phase 0 已确认当前内容 SHA 相同，但仍是两个物理维护点。

最终规则：

```text
skills/openclaw-napm-query/src/constants/objectMetricOwnership.js
=
canonical runtime source
```

## 4.1 先搜索全部引用

执行：

```bash
rg "objectMetricOwnership" .
```

明确：

```text
谁 import root
谁 import Skill-local
谁通过间接 Service 使用
测试怎么引用
```

## 4.2 root 文件处理

优先：

```text
root 同名文件
→ thin re-export
```

实际相对路径按仓库结构实现。

如果确认 root 文件完全无消费者，可以删除。

但不要保留：

```text
两份复制内容
```

---

# 5. 给 objectMetricOwnership 增加 tri-state API

最终设计规定：

```text
KNOWN_COMPATIBLE
KNOWN_INCOMPATIBLE
UNKNOWN
```

Phase 1 可以建立该 API，但：

> **不能在本阶段让 QueryDecisionPolicy / RequirementParser / Kernel 消费它。**

## 5.1 新 API

建议：

```js
classifyObjectMetricCompatibility({
  service,
  groupPath,
  metricId,
  productBaseline
})
```

返回：

```text
KNOWN_COMPATIBLE
KNOWN_INCOMPATIBLE
UNKNOWN
```

不要返回 boolean。

## 5.2 指标不存在不在这里处理

重要：

```text
METRIC_UNKNOWN
```

属于 Metric Catalog。

所以 ownership API：

```text
不负责判断 metricId 是否存在
```

调用顺序未来会是：

```text
Metric Catalog existence
↓
Ownership tri-state
```

Phase 1 测试需要锁住这个职责边界。

---

# 6. exhaustive coverage 必须有明确结构

不能简单：

```text
WebApplication:
  exhaustive: true
```

最终设计要求 coverage 至少绑定：

```text
service
groupPathSignature
supportedProductBaseline
exhaustive
source
```

建议结构示例：

```js
{
  service: 'topValues',
  groupPathSignature: 'WebApplication',
  exhaustive: true,
  supportedProductBaseline: '...',
  allowedMetricIds: [
    'PGNPGE',
    'PGTME',
    'PGNSLPGE'
  ],
  source: 'verified-product-contract'
}
```

具体字段名称可根据现有代码风格调整。

## 6.1 tri-state 规则

必须是：

```text
exact service
+
exact groupPathSignature
+
baseline match
+
exhaustive=true
+
metric in allow list
→ KNOWN_COMPATIBLE
```

```text
exact service
+
exact groupPathSignature
+
baseline match
+
exhaustive=true
+
metric NOT in allow list
→ KNOWN_INCOMPATIBLE
```

其他情况：

```text
UNKNOWN
```

## 6.2 UNKNOWN 不能再等于 true

当前旧：

```text
isMetricCompatibleWithGroupPath()
```

对未知对象/path 可能返回 true。

Phase 1 新 tri-state API 必须避免这种语义。

但不要为了 Phase 1 兼容旧代码，直接把旧 boolean API 改成新行为导致生产逻辑变化。

建议：

```text
旧 API 暂时保持
新 tri-state API 单独新增
```

并在测试中说明：

```text
legacy API
vs
new canonical API
```

后续 Phase 4 再切换执行准入。

---

# 7. supportedProductBaseline 必须不是装饰字段

Phase 1 必须明确：

```text
baseline 从哪里来
如何判断当前环境是否匹配
不匹配时怎么办
```

## 7.1 最低要求

优先复用项目已有：

```text
版本配置
产品版本
profile
NAPM capability baseline
```

不要为了一个字符串立即新增重量级 Service。

## 7.2 Phase 1 安全规则

如果：

```text
当前 runtime baseline 无法确认
```

tri-state 必须：

```text
UNKNOWN
```

不能因为静态表写 exhaustive=true 就直接 KNOWN_COMPATIBLE / KNOWN_INCOMPATIBLE。

也就是说：

```text
exhaustive=true
```

只有在：

```text
baseline match
```

时生效。

## 7.3 不连接远端读取版本

本轮禁止连接远端 NAPM。

如果当前项目没有可信本地 baseline 信息：

```text
Phase 1 可以先建立 baseline metadata 与匹配接口
测试使用 fixture / fake baseline
生产默认 UNKNOWN
```

不要为了得到版本信息去请求远端。

---

# 8. Metric Catalog 唯一化

Phase 0 已证实：

```text
metrics-config.yml 缺失
metrics-config.yml 无效
metrics-config.yml 读取失败
```

都会：

```text
loadDefaultMetrics()
→ 加载 42 个内置指标
→ 继续运行
```

这属于：

```text
第二套合法 Metric ID truth source
```

Phase 1 必须改掉。

---

# 9. metrics-config.yml 成为唯一 Metric ID Catalog

最终：

```text
skills/openclaw-napm-query/config/metrics-config.yml
```

作为唯一合法 Metric ID Catalog。

先搜索：

```bash
rg "metrics-config\.yml|loadDefaultMetrics|MetricMappingService" .
```

明确：

```text
root 是否有副本
谁读取
谁 fallback
哪些测试依赖内置 42 指标
```

## 9.1 fail closed

以下情况必须变为明确错误：

```text
文件不存在
YAML/JSON 解析失败
读取异常
内容结构非法
```

而不是 fallback。

## 9.2 不用内置 fallback 继续补合法指标

最终禁止：

```text
config failed
→ use built-in metrics
→ continue
```

如果内置列表还被展示/fixture/文档使用，可以保留数据，但不得作为合法 Metric ID Catalog fallback。

必要时改名，避免未来误用。

---

# 10. Metric Catalog 正式测试

新增正式 contract tests：

## Case A：正常配置

```text
valid metrics-config
→ loads expected metric IDs
→ PASS
```

## Case B：文件不存在

```text
→ explicit failure
→ no built-in fallback
```

## Case C：非法格式

```text
→ explicit failure
→ no fallback
```

## Case D：读取失败

使用 mock：

```text
fs error
→ explicit failure
```

## Case E：未知指标

```text
catalog has no PGSUPERFAST
→ existence=false
```

本 Phase 不把它接入 QueryDecisionPolicy。

---

# 11. Phase 0 characterization 测试如何处理

Phase 0 中：

```text
Metric Catalog 缺失/失败
→ fallback 42 个
```

这条 behavior 将被 Phase 1 有意改变。

不要为了保持 Phase 0 65/65 原样而保留错误 fallback。

正确做法：

```text
1. 保留历史证据
2. 将这条测试迁移成 Phase 1 正式 contract test
3. test 名称反映新契约
```

报告中说明：

```text
Phase 1 intentionally replaces Phase 0 characterization X
```

其他不属于 Phase 1 的 characterization：

```text
WebApplication + TRTI Policy 仍 EXECUTE_QUERY
Direct 仍可绕过 Policy
BottomN 仍错误本地重排
Plugin 仍要求 topMetric ∈ metrics[]
```

本轮应继续保持。

如果这些突然改变：

```text
说明 Phase 1 越界
```

---

# 12. Object Ontology 本轮也收口来源

Phase 0 已发现：

```text
root / Skill-local object-ontology.v1.json
内容漂移
```

最终：

```text
skills/openclaw-napm-query/config/object-ontology.v1.json
```

为唯一 Object Ontology source。

## 12.1 先搜索消费者

```bash
rg "object-ontology\.v1\.json|ObjectOntologyService" .
```

## 12.2 最终规则

Skill-local：

```text
canonical source
```

root：

```text
删除
或自动生成镜像
```

禁止人工双份维护。

## 12.3 不改 Object Ontology 语义内容

本轮只统一来源。

不要：

```text
新增 IPAddress alias
改 Business/WebApplication 语义
补 Resolver 行为
```

这些属于 Phase 2。

---

# 13. root / Skill metrics-config 双份也处理

如果存在：

```text
root metrics-config
Skill-local metrics-config
```

即使当前 SHA 相同，也不能继续人工维护双份。

规则：

```text
Skill-local canonical
```

root：

```text
thin mirror / generated mirror / 删除
```

按真实构建依赖决定。

runtime-contract 必须阻止未来漂移。

---

# 14. verify:runtime-contract 在 Phase 1 后必须新增的保护

至少增加：

## Contract A：Resolution Spec 唯一性

如果 root mirror 保留：

```text
normalized content != canonical
→ FAIL
```

如果 root 应删除：

```text
重新出现实体副本
→ FAIL
```

## Contract B：Object Ontology 唯一性

禁止 root / Skill 人工漂移。

## Contract C：Ownership 唯一性

root ownership：

```text
只能 thin re-export
或不存在
```

不能复制规则表。

## Contract D：Metric Catalog 唯一性

不能存在第二份可被 runtime 独立读取的合法 Metric Catalog。

## Contract E：禁止内置 Metric fallback

检测：

```text
MetricMappingService
```

不能在 catalog 配置失败后静默执行：

```text
loadDefaultMetrics()
```

作为运行时准入。

## Contract F：Resolution Spec execution ownership deprecated

至少阻止新的执行组件从：

```text
ownershipMatrix
compatibleObjectTypes
ownershipClass
```

读取执行准入。

如果现有旧消费者暂时存在：

```text
使用显式 allowlist 记录技术债
```

不能为了全绿把检查做成什么都不管。

---

# 15. 本轮不允许修改 Query 执行行为

以下 Phase 0 characterization 在本轮结束时原则上仍应保持：

```text
WebApplication + TRTI
→ QueryDecisionPolicy 仍可能 EXECUTE_QUERY

executeGatewayRequest
→ 仍可能调用 metadata + topValues

executeDirectGatewayRequest
→ 仍可能直接执行

BottomN
→ 仍可能本地 asc 重排

Plugin
→ 仍可能要求 topMetric ∈ metrics[]

QueryValidator
→ 仍可能要求 legacy metric

Kernel
→ 仍可能有 metric fallback

metadata
→ 仍可能 overloaded

ExecutionFailureClassifier
→ 仍可能通过文本猜 NO_DATA
```

本轮不要顺手修。

---

# 16. Phase 1 允许修改的生产范围

允许：

```text
config source / mirror
ResolutionSpecService 读取路径
ObjectOntologyService 读取路径
MetricMappingService catalog loading / fail-closed
objectMetricOwnership canonical source
objectMetricOwnership 新 tri-state API / coverage metadata
runtime-contract verification scripts
相关测试
```

谨慎允许：

```text
构建脚本 / 镜像同步脚本
```

但必须只为 truth source 收口。

---

# 17. Phase 1 禁止修改的生产范围

除非只是 import path 调整，否则不要改：

```text
WorkflowClassifierService
MetricSemanticNormalizerService
NapmResolvedQueryResolverService
QueryDecisionPolicy
QueryMetadataConstraintService
NapmMetadataService 调用顺序
RequirementParserService 执行逻辑
QueryValidator contract
MetricExecutionKernel
TopValuesResultNormalizerService
ExecutionFailureClassifier
Plugin Query 行为
TagNormalizer 语义逻辑
pageViews / BUG-B
```

如果 truth-source 收口确实需要改某个 import：

```text
允许最小 import-path 修改
```

但不能改变功能语义。

---

# 18. tri-state Phase 1 测试矩阵

新增：

```text
exact coverage
+
baseline match
+
exhaustive=true
+
allowed metric
→ KNOWN_COMPATIBLE
```

```text
exact coverage
+
baseline match
+
exhaustive=true
+
legal metric not allowed
→ KNOWN_INCOMPATIBLE
```

```text
coverage exhaustive=false
→ UNKNOWN
```

```text
path mismatch
→ UNKNOWN
```

```text
service mismatch
→ UNKNOWN
```

```text
baseline mismatch
→ UNKNOWN
```

```text
baseline unknown
→ UNKNOWN
```

```text
unknown metric ID
→ ownership API 不承担 METRIC_UNKNOWN 判定
```

最后一项按实现形式验证 ownership 不自行创建 Metric existence truth。

---

# 19. 不要偷偷把 tri-state 接进 Policy

新增 guard test：

```text
QueryDecisionPolicy
```

本轮仍不得因为 tri-state 新 API 而改变行为。

例如：

```text
WebApplication + TRTI
→ 仍保持 Phase 0 characterization
```

直到 Phase 4。

---

# 20. Phase 1 测试策略

分三类：

## A. Phase 0 仍应保持的旧行为

继续 PASS。

## B. Phase 1 有意改变的旧行为

例如：

```text
Metric Catalog fallback
root/Skill truth source
```

更新为新 contract test。

## C. Phase 2+ 才改变的行为

保持 Phase 0 baseline。

---

# 21. 完成后必须运行

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

以及：

```text
Phase 0 characterization suites
Phase 1 truth-source / tri-state suites
```

---

# 22. Phase 1 输出要求

完成后立即停止。

不要进入 Phase 2。

## 22.1 Git 状态

```text
branch:
HEAD:

Phase 1 开始前 status:
Phase 1 结束后 status:

pre-existing changes:
Phase 0 changes:
Phase 1 changes:
```

## 22.2 文件变更

```markdown
| 文件 | 修改类型 | Phase 1 目的 | 是否改变 Query 执行语义 |
|---|---|---|---|
| ... | ... | ... | YES/NO |
```

正常：

```text
Query 执行语义应为 NO
```

Metric Catalog fail-closed 属于 truth-source loading behavior change，需要单独标注。

## 22.3 Authoritative Source Result

```text
Resolution Spec canonical:
root spec status:

Object Ontology canonical:
root ontology status:

ObjectMetricOwnership canonical:
root ownership status:

Metric Catalog canonical:
root metrics-config status:
```

## 22.4 Duplicate Source Audit

列出：

```text
已经消除的 duplicate truth
仍因兼容暂时存在的 duplicate projection
仍需 Phase 8 删除的 legacy field
```

## 22.5 Ownership Tri-State Result

```markdown
| service | groupPath | metric | baseline | exhaustive | result |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | KNOWN_COMPATIBLE/... |
```

明确：

```text
是否已经接入 QueryDecisionPolicy：NO
是否已经改变 southbound 行为：NO
```

## 22.6 Metric Catalog Result

```text
valid config:
missing config:
invalid config:
read failure:
unknown metric:
```

确认：

```text
是否仍会加载 42 built-in fallback：
YES / NO
```

Phase 1 目标：

```text
NO
```

## 22.7 Runtime Contract 新规则

逐条列：

```text
Resolution Spec uniqueness
Object Ontology uniqueness
Ownership uniqueness
Metric Catalog uniqueness
No runtime metric fallback
No new Resolution Spec execution ownership consumer
```

每条：

```text
PASS / FAIL
```

## 22.8 Phase 0 非目标行为回归

必须列：

```text
Policy WebApplication + TRTI:
Gateway WebApplication + TRTI:
Direct WebApplication + TRTI:
BottomN asc:
Plugin topMetric-in-metrics:
QueryValidator metric requirement:
Kernel metric fallback:
Metadata overload:
Error message NO_DATA guessing:
```

预期：

```text
本轮不应被修复
```

如果任何行为发生变化：

```text
说明原因
判断是否越界
```

## 22.9 测试结果

```text
Phase 0 tests:
Phase 1 tests:
full repo tests:
lint:
runtime-contract:
diff-check:
```

## 22.10 是否连接远端

```text
NO
```

## 22.11 是否提交 commit

除非用户额外明确要求：

```text
NO
```

## 22.12 Phase 1 是否完成

```text
YES / NO
```

如果 NO：

```text
阻塞点
未完成 truth source
建议
```

---

# 23. Phase 1 完成定义

只有全部满足才算完成：

```text
1. Resolution Spec 有唯一 canonical authoring source
2. Object Ontology 有唯一 canonical source
3. objectMetricOwnership 有唯一 canonical runtime source
4. Metric ID Catalog 有唯一 canonical source
5. Metric Catalog 配置失败 fail closed
6. 内置 Metric fallback 不再作为运行时合法 ID truth
7. ownership tri-state API 已建立
8. exhaustive coverage 有 service + exact path + baseline 语义
9. baseline 不匹配/未知时返回 UNKNOWN
10. root/Skill duplicate 不再人工双维护
11. verify:runtime-contract 能阻止 truth source 再分叉
12. Resolution Spec execution ownership 已进入 deprecated/禁止新增读取状态
13. QueryDecisionPolicy / Gateway / Direct 等执行行为未提前进入 Phase 4
14. Phase 0 非目标 characterization 基本保持
15. 全仓测试、lint、runtime-contract、diff-check 通过
```

---

# 24. 再次强调禁止事项

本轮不要：

```text
修慢业务 PGTME
改 WorkflowClassifier
统一 MetricSemantic
改 Resolver
加 RankingIntentParser
修 BottomN
加 LegacyMetricInputAdapter
改 metric/metrics/topMetric contract
删 Plugin topMetric-in-metrics
加 Shared Validator
改 QueryDecisionPolicy
改 Gateway / Direct 门禁
改 metadata 调用顺序
加 RuntimeMetricCapabilityService
改 Repair
加 Serializer
改 Kernel fallback
改 Error Contract
处理 BUG-B
```

这些属于后续 Phase。

---

# 25. 本轮结束

完成：

```text
Phase 1：Truth Source 收口
```

后立即停止。

不要进入：

```text
Phase 2：统一 Metric / Ranking Semantic Contract
```

交付：

```text
diff
truth-source audit
tri-state API
contract verification
test result
Phase 0 non-target behavior regression
```

等待下一轮 Review。
