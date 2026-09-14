# GAIOP NAPM BUG-A 实施指令 — Phase 4.1：Static Gate Verification / 验证补证据

> 前置状态：
>
> - Phase 0：PASS
> - Phase 1：PASS
> - Phase 2：PASS
> - Phase 2.1：PASS
> - Phase 3：PASS
> - Phase 4：CONDITIONAL PASS
> - Phase 4.1：VERIFICATION REQUIRED
> - Phase 5：HOLD
>
> Phase 4 已经完成 Shared Executable Validator 与 Static Hard Gate 的主体实现。
>
> 本轮**不是新的架构阶段**，只做 Phase 4 的验证闭环与证据补齐。
>
> **本轮原则：**
>
> ```text
> 优先只补测试、调用计数、执行顺序证明和报告
> 不扩大架构
> 不进入 Phase 5
> 不连接真实 NAPM
> ```
>
> 如果现有实现无法满足下述验证项，才允许做最小修正；任何修正必须明确报告。

---

# 0. 本轮目标

Phase 4.1 只回答以下 6 个问题：

```text
1. Phase 4 全部测试和全仓测试是否真实运行并通过？
2. Plugin / Gateway / Direct 三个入口是否真的做到静态非法 0 southbound？
3. UNKNOWN / METRIC_UNKNOWN / KNOWN_INCOMPATIBLE 是否按设计严格区分？
4. Plugin 中 time materialization 与 Shared Validator 的真实执行顺序是否正确？
5. prepared proof 是否真的不可伪造、不可跨实例复用、不可重复消费？
6. 多指标 metrics[] 与独立 topMetric 是否真的逐项校验？
```

本轮完成后，如果全部通过：

```text
Phase 4 → PASS
Phase 5 → GO
```

否则：

```text
Phase 4 → FAIL / NEED FIX
Phase 5 → HOLD
```

---

# 1. 本轮禁止事项

禁止：

```text
新增 RuntimeMetricCapabilityService
调用 metricsForGroup 处理 UNKNOWN
修改 Phase 1 ownership coverage 模型
放宽 supportedProductBaseline
重构 Metadata Service
拆 metadata overload
新增 AtomicQueryRepair
修改 Semantic rules
修改 Ranking grammar
修改 Object Ontology
修改 LegacyMetricInputAdapter 决策表
新增正式 Serializer
删除 Kernel legacy fallback
重构 Error Contract
处理 BUG-B
连接真实 NAPM
部署
提交 commit
```

本轮不是：

```text
Phase 5 implementation
```

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

报告：

```text
branch:
HEAD:
start status:
Phase 4 existing changes:
Phase 4.1 new changes:
```

不要：

```text
reset
stash
覆盖已有修改
```

---

# 3. 第一项：真实运行所有验证命令

Phase 4 报告中列出了应执行的命令，但 Phase 4.1 必须给出真实执行结果。

实际运行：

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

另外单独运行：

```text
Phase 4 executable-validator tests
Phase 4 static-gate tests
Phase 4 plugin-static-gate tests
Phase 4 runtime-contract tests
```

如果仓库测试框架支持，给出精确：

```text
suite 数
test 数
pass
fail
skip
duration
```

禁止只写：

```text
“已覆盖”
“应该通过”
“测试存在”
```

必须写：

```text
已运行
实际 PASS / FAIL
```

---

# 4. 输出完整 Phase 4 Test Matrix

最终报告至少输出：

```markdown
| Test Group | Suites | Tests | PASS | FAIL | SKIP |
|---|---:|---:|---:|---:|---:|
| Phase 0 relevant | ... | ... | ... | ... | ... |
| Phase 1 | ... | ... | ... | ... | ... |
| Phase 2 | ... | ... | ... | ... | ... |
| Phase 2.1 | ... | ... | ... | ... | ... |
| Phase 3 | ... | ... | ... | ... | ... |
| Phase 4 | ... | ... | ... | ... | ... |
| Full repo | ... | ... | ... | ... | ... |
```

同时：

```text
lint:
runtime-contract:
diff-check:
```

---

# 5. 第二项：Plugin / Gateway / Direct 三入口真实调用计数

必须使用 Phase 0 建立的：

```text
FakeNapmClient
SpyNapmClient
SouthboundCallCounter
```

或当前等价测试设施。

不要连接真实服务器。

---

# 6. 场景 A：KNOWN_INCOMPATIBLE

必须使用：

```text
verified supportedProductBaseline fixture
+
exhaustive=true coverage
```

例如：

```text
service=topValues
groups=[WebApplication]
metrics=[TRTI]
topMetric=TRTI
topCount=5
```

确保该 fixture 下 ownership 明确返回：

```text
KNOWN_INCOMPATIBLE
```

## 6.1 Plugin / Hook

必须实际记录：

```text
Shared Validator calls =
QueryDecisionPolicy calls =
Query Skill calls =
NapmClient total =
```

目标：

```text
Shared Validator = 1
Query Skill = 0
NapmClient total = 0
```

## 6.2 executeGatewayRequest

实际记录：

```text
Shared Validator =
metadata review =
applications =
businessGroups =
groups =
groupArguments =
metrics =
metricsForGroup =
granularities =
topValues =
averageValues =
timeValues =
pageViews =
NapmClient total =
```

目标：

```text
Shared Validator = 1
metadata review = 0
所有 metadata calls = 0
所有 data calls = 0
NapmClient total = 0
```

## 6.3 executeDirectGatewayRequest

实际记录：

```text
Shared Validator =
MetricExecutionKernel =
topValues =
averageValues =
timeValues =
pageViews =
NapmClient total =
```

目标：

```text
Shared Validator = 1
MetricExecutionKernel = 0
所有 data calls = 0
NapmClient total = 0
```

---

# 7. 场景 B：METRIC_UNKNOWN

构造：

```text
service=topValues
groups=[WebApplication]
metrics=[PGSUPERFAST]
topMetric=PGSUPERFAST
```

期望：

```text
status=METRIC_UNKNOWN
outcome=VALIDATION_FAILURE
```

必须验证顺序：

```text
Metric Catalog existence check
先于
ObjectMetricOwnership classifier
```

最好使用 spy 证明：

```text
ownership classifier calls = 0
```

## 7.1 METRIC_UNKNOWN southbound

Plugin：

```text
Query Skill = 0
```

Gateway：

```text
metadata review = 0
NapmClient = 0
```

Direct：

```text
Kernel = 0
NapmClient = 0
```

---

# 8. 场景 C：UNKNOWN

必须使用：

```text
无可信 baseline
```

或：

```text
non-exhaustive group path
```

例如：

```text
WebApplication + PGTME
```

在无 baseline fixture 下：

```text
UNKNOWN
```

或使用：

```text
WebApplication > PageFamily
```

非 exhaustive path。

期望：

```text
Validator status=UNKNOWN
Policy action=RUNTIME_CONFIRMATION_REQUIRED
```

Phase 4.1 必须证明：

```text
metricsForGroup = 0
metadata calls = 0
data calls = 0
NapmClient total = 0
```

因为：

```text
Phase 5 尚未开始
```

---

# 9. 场景 D：KNOWN_COMPATIBLE

使用：

```text
verified baseline fixture
+
exhaustive coverage
```

例如：

```text
WebApplication + PGTME
```

期望：

```text
Validator=VALID
```

本轮只需要证明：

```text
静态 Gate 不错误阻断
```

后续现有执行路径可继续。

---

# 10. 第三项：状态矩阵必须完整输出

最终报告必须有：

```markdown
| Query | Baseline | Contract | Metric existence | Ownership | Validator status | Policy outcome | Southbound |
|---|---|---|---|---|---|---|---:|
| WebApplication + PGTME | verified | valid | exists | compatible | VALID | EXECUTE_QUERY | existing path |
| WebApplication + TRTI | verified | valid | exists | incompatible | KNOWN_INCOMPATIBLE | VALIDATION_FAILURE | 0 |
| WebApplication + TRTI | unknown | valid | exists | UNKNOWN | UNKNOWN | RUNTIME_CAPABILITY_REQUIRED | 0 |
| PGSUPERFAST | any | valid | missing | not evaluated | METRIC_UNKNOWN | VALIDATION_FAILURE | 0 |
| missing topMetric | any | invalid | n/a | n/a | CONTRACT_INVALID | VALIDATION_FAILURE | 0 |
```

---

# 11. 第四项：Plugin time materialization 与 Validator 顺序

Phase 4.1 必须明确实际调用链。

输出真实流程，例如：

```text
legacy/canonical input
→ Legacy Adapter（如 legacy）
→ canonical normalization
→ time intent resolution/materialization
→ canonical ResolvedQuery
→ Shared Validator
→ QueryDecisionPolicy
→ Query Skill
```

或者：

```text
pre-validation
→ time materialization
→ full canonical validation
→ Query Skill
```

关键要求：

> Shared Executable Validator 做 `ResolvedQueryContract` 完整 shape 校验时，拿到的必须是已经满足 canonical 时间字段要求的 Query。

---

# 12. 必须验证合法 relative-time Query 不被提前拒绝

新增/确认测试，例如：

```text
“最近1小时页面响应时间最高的前5个业务”
```

或直接构造 Plugin pending/time-intent 输入。

期望：

```text
time materialization 成功
→ canonical start/end 形成
→ Shared Validator 通过
→ 不因 start/end 尚未物化而 CONTRACT_INVALID
```

如果当前 Validator 分两层：

```text
pre-contract validation
full contract validation
```

请明确每层职责。

不要复制 `ResolvedQueryContract` 规则。

---

# 13. Plugin time-order 输出要求

报告中明确：

```text
Shared Validator 完整 contract validation 时：
start/end 是否已经 materialized：YES / NO
```

目标：

```text
YES
```

如果 NO：

```text
必须说明为什么仍不会误拒绝合法 Query
```

并提供测试证据。

---

# 14. 第五项：prepared proof 安全验证

Phase 4.1 必须验证 internal prepared proof 真的不可绕过。

## 14.1 正常同实例

```text
same RequirementParser instance
prepareGatewayExecution()
→ creates internal proof
→ executeDirectGatewayRequest()
→ proof accepted once
```

目标：

```text
PASS
```

## 14.2 外部伪造

构造类似：

```text
prepared=true
proof=...
```

的普通输入对象。

期望：

```text
NOT TRUSTED
```

必须：

```text
重新经过 Shared Validator
或直接 reject
```

绝不能直接进入 Kernel。

## 14.3 跨实例复用

```text
Parser A prepare
→ proof

Parser B direct execute
→ same proof
```

期望：

```text
proof invalid
```

## 14.4 重复消费

```text
Parser A prepare
→ proof

第一次 execute
→ accepted

第二次 execute same proof
→ rejected / validator rerun
```

不能多次使用。

---

# 15. prepared proof 的实现安全要求

优先：

```text
WeakMap
Symbol
private object identity
instance-local nonce/token store
```

或当前等价不可由普通外部 JSON 构造的机制。

不接受：

```text
{ prepared: true }
```

这种仅靠可序列化字段判断信任。

如果当前实现已经安全，只补测试证明即可。

---

# 16. 第六项：多指标与独立 topMetric 验证

必须明确证明：

```text
Validator 逐个检查 metrics[]
+
独立检查 topMetric
```

不能只检查：

```text
metrics[0]
```

---

# 17. Case A：返回指标中间项不兼容

使用 verified baseline：

```text
service=topValues
groups=[WebApplication]
metrics=[PGNPGE,TRTI]
topMetric=PGTME
```

期望：

```text
KNOWN_INCOMPATIBLE
```

issue：

```text
field=metrics[1]
metricId=TRTI
role=RETURN_METRIC
```

---

# 18. Case B：只有 ranking metric 不兼容

```text
metrics=[PGNPGE,PGTME]
topMetric=TRTI
```

期望：

```text
KNOWN_INCOMPATIBLE
```

issue：

```text
field=topMetric
metricId=TRTI
role=RANKING_METRIC
```

---

# 19. Case C：topMetric 不在 metrics[] 仍合法

必须继续测试：

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

在 verified compatible baseline fixture 下：

```text
VALID
```

不能出现：

```text
top_metric_not_in_metrics
```

---

# 20. Case D：metrics[] 某一项不存在

```text
metrics=[PGTME,PGSUPERFAST]
topMetric=PGTME
```

期望：

```text
METRIC_UNKNOWN
```

issue：

```text
field=metrics[1]
metricId=PGSUPERFAST
```

并：

```text
ownership 不对 PGSUPERFAST 下结论
```

---

# 21. Case E：topMetric 不存在

```text
metrics=[PGTME]
topMetric=PGSUPERFAST
```

期望：

```text
METRIC_UNKNOWN
field=topMetric
role=RANKING_METRIC
```

不能：

```text
KNOWN_INCOMPATIBLE
```

---

# 22. UNKNOWN requiredRuntimeChecks 验证

如果：

```text
metrics=[PGNPGE,PGTME]
topMetric=PGTME
```

其中同一个 `PGTME` 同时作为：

```text
RETURN_METRIC
RANKING_METRIC
```

且 ownership UNKNOWN，

`requiredRuntimeChecks` 可以按：

```text
service + groupPathSignature + metricId
```

去重。

但必须保留：

```text
roles=[RETURN_METRIC,RANKING_METRIC]
```

测试证明：

```text
不会在 Phase 5 重复发两个能力请求
```

---

# 23. Shared Validator 必须仍然 pure

再次验证：

```text
ResolvedQueryExecutableValidator
```

内部：

```text
NapmClient calls = 0
metricsForGroup calls = 0
metadata service calls = 0
```

建议静态/runtime-contract 同时锁住。

---

# 24. QueryDecisionPolicy 不得重新拥有业务规则

检查：

```bash
rg "PGTME|TRTI|PGNSLPGE|RTTI|WebApplication|DefinedApp" \
  skills/openclaw-napm-query/services/QueryDecisionPolicy.js
```

如果存在用于：

```text
Object×Metric execution admission
```

的业务规则：

```text
FAIL
```

---

# 25. RequirementParser 不得重复实现 ownership gate

必须只调用：

```text
Shared Validator
```

不能再自己维护：

```text
WebApplication + TRTI
```

这种规则。

---

# 26. Overview / Child Query bypass 验证

至少有一个测试：

```text
Overview/internal child query
→ canonical child query
→ Shared Validator
```

对 static invalid child：

```text
Kernel=0
NapmClient=0
```

如果 Overview 当前不实际经过该执行路径：

```text
明确说明真实调用链
```

不要假设已覆盖。

---

# 27. CONTRACT_INVALID 真实 0-call

例如：

```text
topValues
metrics=[PGTME]
topMetric missing
```

期望：

```text
CONTRACT_INVALID
VALIDATION_FAILURE
```

并证明：

```text
metadata=0
Kernel=0
NapmClient=0
```

---

# 28. Error Outcome 验证

Phase 4.1 不重构 Error Contract。

但必须证明：

```text
KNOWN_INCOMPATIBLE
METRIC_UNKNOWN
CONTRACT_INVALID
```

不会最终变成：

```text
NO_DATA
```

至少断言：

```text
outcome=VALIDATION_FAILURE
```

UNKNOWN：

```text
outcome/action=RUNTIME_CAPABILITY_REQUIRED
```

---

# 29. Phase 4.1 不改 UNKNOWN runtime semantics

本轮仍然：

```text
UNKNOWN
→ 0 metricsForGroup
→ 0 metadata
→ 0 data
```

不要提前做 Phase 5。

---

# 30. 若验证失败，允许的最小修正

只有当测试证明 P4 实现存在真实缺陷时，可以修：

```text
entry point bypass
Plugin validation/time order
prepared proof security
multi-metric iteration bug
status mapping bug
call-count leakage
```

禁止借机：

```text
实现 runtime metadata
修改 ownership coverage
增加新 semantic rules
```

每个生产代码修正必须在报告中说明：

```text
问题
原因
最小 diff
对应测试
```

---

# 31. runtime-contract 补充验证

如果尚未覆盖，补：

```text
Shared Validator no NapmClient dependency
Shared Validator no metadata dependency
Plugin static gate before Query Skill
Gateway static gate before metadata review
Direct static gate before Kernel
prepared proof not externally serializable/trustable
Metric existence before ownership
metrics[] iteration required
topMetric independently validated
UNKNOWN cannot reach data execution
```

---

# 32. 完成后必须再次运行

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

并输出真实结果。

---

# 33. Phase 4.1 最终报告格式

完成后立即停止，不进入 Phase 5。

## 33.1 Git

```text
branch:
HEAD:
Phase 4.1 start status:
Phase 4.1 end status:
production code changed in 4.1: YES / NO
```

如果 YES：

```text
列出文件和原因
```

## 33.2 Full Verification Results

```text
Phase 0 relevant:
Phase 1:
Phase 2:
Phase 2.1:
Phase 3:
Phase 4:
Phase 4.1:
Full repo:
lint:
runtime-contract:
diff-check:
```

必须给实际：

```text
PASS / FAIL
tests count
```

## 33.3 Three Entry Call Count Matrix

```markdown
| Scenario | Entry | Validator | Query Skill | Metadata Review | Kernel | metricsForGroup | Data Call | NapmClient Total |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| KNOWN_INCOMPATIBLE | Plugin | ... | ... | n/a | n/a | ... | ... | ... |
| KNOWN_INCOMPATIBLE | Gateway | ... | n/a | ... | ... | ... | ... | ... |
| KNOWN_INCOMPATIBLE | Direct | ... | n/a | ... | ... | ... | ... | ... |
| METRIC_UNKNOWN | ... | ... | ... | ... | ... | ... | ... | ... |
| UNKNOWN | ... | ... | ... | ... | ... | ... | ... | ... |
```

## 33.4 Status Matrix

```markdown
| Query | Baseline | Validator | Policy Outcome | Southbound |
|---|---|---|---|---:|
| WebApplication + PGTME | verified | VALID | EXECUTE_QUERY | existing |
| WebApplication + TRTI | verified | KNOWN_INCOMPATIBLE | VALIDATION_FAILURE | 0 |
| WebApplication + TRTI | unknown | UNKNOWN | RUNTIME_CAPABILITY_REQUIRED | 0 |
| PGSUPERFAST | any | METRIC_UNKNOWN | VALIDATION_FAILURE | 0 |
| missing topMetric | any | CONTRACT_INVALID | VALIDATION_FAILURE | 0 |
```

## 33.5 Plugin Time Order

明确：

```text
actual order:
```

并回答：

```text
Shared Validator 做完整 ResolvedQueryContract 校验时，
start/end 是否已 materialized：YES / NO
```

附测试名称。

## 33.6 Prepared Proof Security

```markdown
| Case | Expected | Actual | PASS |
|---|---|---|---|
| same instance first use | accepted | ... | ... |
| external forged proof | rejected/revalidated | ... | ... |
| cross-instance proof | rejected | ... | ... |
| replay consumed proof | rejected | ... | ... |
```

## 33.7 Multi-Metric Validation

明确：

```text
metrics[] every item checked: YES / NO
topMetric checked independently: YES / NO
metrics[0]-only shortcut exists: YES / NO
topMetric membership required: YES / NO
```

目标：

```text
YES
YES
NO
NO
```

并列出 Case A-E 测试结果。

## 33.8 Validator Purity

```text
Validator NapmClient dependency:
Validator metadata dependency:
Validator raw prompt parsing:
Validator repair:
```

目标全部：

```text
NO
```

## 33.9 Overview / Internal Child Query

回答：

```text
是否经过 Shared Validator：YES / NO
是否存在 bypass：YES / NO
```

附测试证据。

## 33.10 Phase 4 Final Decision

Codex 自己先给：

```text
Phase 4:
PASS / FAIL
```

如果 PASS，逐项确认：

```text
Static invalid = 0 southbound
UNKNOWN = no execution
Metric unknown precedes ownership
All entries covered
Prepared proof safe
Multi-metric correct
All tests green
```

## 33.11 Remote / Deployment / Commit

必须：

```text
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
Phase 5 started: NO
```

---

# 34. Phase 4.1 完成定义

只有全部满足才算完成：

```text
1. Phase 4 测试真实运行并全部通过
2. Full repo tests 全通过
3. lint 全通过
4. runtime-contract 全通过
5. diff-check 全通过
6. KNOWN_INCOMPATIBLE Plugin=0 Query Skill
7. KNOWN_INCOMPATIBLE Gateway=0 metadata/data
8. KNOWN_INCOMPATIBLE Direct=0 Kernel/data
9. METRIC_UNKNOWN = 0 southbound
10. METRIC_UNKNOWN 在 ownership 前确定
11. UNKNOWN = RUNTIME_CAPABILITY_REQUIRED
12. UNKNOWN = 0 metricsForGroup / 0 data（Phase 4）
13. Plugin time materialization 与完整 contract validation 顺序明确且正确
14. prepared proof 不可外部伪造
15. prepared proof 不可跨实例复用
16. prepared proof 不可重复消费
17. metrics[] 逐项验证
18. topMetric 独立验证
19. topMetric 不要求属于 metrics[]
20. Overview/internal child query 无静态门禁 bypass
21. Validator 仍 pure/no-southbound
22. 不进入 Phase 5
```

---

# 35. 最终提醒

Phase 4.1 不是继续开发功能。

本轮只回答：

> **Phase 4 声称建立的 Static Hard Gate，是否真的在所有真实入口都成立，并且有可重复的测试证据？**

如果答案 YES：

```text
Phase 4 = PASS
Phase 5 = GO
```

如果任何一项关键 0-call / bypass / proof 安全失败：

```text
Phase 4 = NOT PASS
Phase 5 = HOLD
```

完成后停止，等待 Review。
