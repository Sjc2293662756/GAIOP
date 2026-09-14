# GAIOP NAPM BUG-A 实施指令 — Phase 8.1：Final Verification / Final Sign-off

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
> - Phase 8：CONDITIONAL PASS
> - Phase 8.1：FINAL VERIFICATION
> - BUG-A：FUNCTIONALLY FIXED / FINAL SIGN-OFF PENDING
>
> Phase 8 已经完成的功能性结论：
>
> ```text
> Unified Outcome Contract：已建立
> NO_DATA 与 VALIDATION_FAILURE：已分离
> NO_DATA 与 RUNTIME_CAPABILITY_FAILURE：已分离
> NO_DATA 与 SERIALIZATION_FAILURE：已分离
> NO_DATA 与 EXECUTION_FAILURE：已分离
>
> 原始“慢业务 Top5”回归：PASS
> WebApplication + TRTI 静态不兼容：PASS
> Runtime unsupported：PASS
> 合法空结果 → NO_DATA：PASS
> 网络失败 → EXECUTION_FAILURE：PASS
> 多指标 + 独立 topMetric：PASS
> METRIC_UNKNOWN：PASS
> Safe / Unsafe Repair：PASS
> ```
>
> **本轮不做新功能，不新增架构，不进入 BUG-B。**
>
> 本轮只补齐 Phase 8 最终签字前缺失的证据：
>
> ```text
> 1. Phase 8 删除量 / 物理删除证据
> 2. LegacyMetricInputAdapter / TagNormalizer caller graph
> 3. Final search counts
> 4. UNKNOWN → Runtime SUPPORTED 最终回归
> 5. Plugin / Gateway / Direct Outcome 一致性
> ```
>
> 如果全部通过：
>
> ```text
> Phase 8 = PASS
> BUG-A = DONE / FINAL PASS
> ```
>
> 完成后立即停止。

---

# 1. 本轮原则

Phase 8.1 是：

```text
verification-only
```

默认：

```text
Production code change = NO
```

只有在验证发现：

```text
Phase 8 报告与实际代码不一致
```

时才允许最小修正。

禁止为了让报告“好看”而继续重构。

---

# 2. 本轮禁止事项

禁止：

```text
新增业务 Service
修改 Semantic rules
修改 Ranking Grammar
修改 Object Ontology
修改 Metric Catalog
修改 Object×Metric ownership
修改 Runtime Capability 语义
扩大 Atomic Repair allowlist
修改 Serializer 业务映射
修改 GroupBuilder 业务规则
重构 Outcome Contract
删除仍有真实兼容 caller 的 Legacy Adapter
处理 BUG-B
连接真实 NAPM
部署
重启
commit
```

---

# 3. 开始前记录 Git 状态

执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --numstat
git diff --check
```

报告：

```text
branch:
HEAD:
Phase 8.1 start status:
production code changed before verification:
```

---

# 4. Verification A — Phase 8 Deletion Audit

Phase 8 报告确认 legacy execution truth 已退出，但最终报告没有给本阶段精确删除统计。

本轮必须补齐。

## 4.1 使用 Phase 8 start snapshot

如果已有：

```text
Phase 8 start backup / diff snapshot
```

使用它与当前工作树对比。

如果无法精确按阶段还原：

```text
明确说明原因
不要伪造数字
```

但至少要给：

```text
Phase 8 涉及文件
新增行
删除行
净变化
```

## 4.2 输出 Phase 8 统计

```markdown
| Category | Added | Deleted | Net |
|---|---:|---:|---:|
| Production | ... | ... | ... |
| Tests | ... | ... | ... |
| Docs/Contracts | ... | ... | ... |
```

## 4.3 输出物理删除清单

```markdown
| Old Logic / Symbol | Before Phase 8 | Current Status | Physically Deleted? | Replacement |
|---|---|---|---:|---|
| execution legacy metric truth | ... | ... | YES/NO | canonical metrics/topMetric |
| execution metrics[0] truth | ... | ... | YES/NO | role-aware validation |
| warning-string execution control | ... | ... | YES/NO | structured outcome |
| duplicate outcome mapper | ... | ... | YES/NO | ExecutionOutcomeMapper |
| dead legacy helper | ... | ... | YES/NO | ... |
```

要求区分：

```text
DELETED
KEEP_TEMPORARILY
DISPLAY_ONLY
DEAD_CODE_CANDIDATE
```

---

# 5. Verification B — LegacyMetricInputAdapter Caller Graph

Phase 8 当前结论：

```text
LegacyMetricInputAdapter = KEEP_TEMPORARILY
```

本轮必须证明为什么。

执行：

```bash
rg "LegacyMetricInputAdapter" .
rg "\bmetric\b" skills/openclaw-napm-query napm-openclaw-plugin.remote.js
```

## 5.1 输出 caller graph

```markdown
| Caller | Production? | Input Shape | Why Adapter Needed | Can Migrate Now? |
|---|---:|---|---|---:|
| ... | ... | ... | ... | ... |
```

## 5.2 必须回答

```text
production callers still send legacy `metric`:
YES / NO / UNKNOWN

all such callers are inside this repo:
YES / NO

can all in-repo callers migrate now:
YES / NO

adapter removal condition:
...
```

## 5.3 决策规则

如果：

```text
production caller = 0
```

则：

```text
LegacyMetricInputAdapter
→ P8 cleanup candidate
```

但本轮不必强删，除非删除风险为 0。

如果：

```text
真实兼容入口仍存在
```

则可以保留：

```text
KEEP_TEMPORARILY
```

但必须明确：

```text
边界位置
不得进入 canonical execution truth
移除条件
```

---

# 6. Verification C — TagNormalizer Caller Graph

Phase 8 当前结论：

```text
TagNormalizer = KEEP_TEMPORARILY
compatibility facade
不构造 Query
```

本轮必须验证这一声明。

执行：

```bash
rg "TagNormalizer" .
```

输出：

```markdown
| Caller | Production? | Purpose | Can Influence Metric Selection? | Can Build Query? |
|---|---:|---|---:|---:|
| ... | ... | ... | ... | ... |
```

目标：

```text
Can Influence canonical metric truth = NO
Can Build executable query = NO
```

必须给 Removal Condition。

---

# 7. Verification D — Final Search Counts

必须真实执行并给 count。

## 7.1 `topMetric || metric`

```bash
rg "topMetric.*\|\|.*metric|metric.*\|\|.*topMetric" .
```

目标：

```text
production count = 0
```

## 7.2 execution `metric` truth

```bash
rg "\.metric\b|\['metric'\]|\[\"metric\"\]" \
  skills/openclaw-napm-query/services \
  skills/openclaw-napm-query/scripts \
  skills/openclaw-napm-query/src \
  napm-openclaw-plugin.remote.js
```

目标：

```text
Kernel execution metric truth = 0
Serializer execution metric truth = 0
NapmClient metric business truth = 0
Shared Validator metric legacy truth = 0
```

允许：

```text
LegacyMetricInputAdapter
display-only summary field
migration tests/docs
```

## 7.3 execution / compatibility `metrics[0]`

```bash
rg "metrics\s*\[\s*0\s*\]" skills/openclaw-napm-query
```

禁止类别：

```text
execution truth
static compatibility truth
runtime capability truth
transport truth
```

目标：

```text
count = 0
```

## 7.4 Kernel `queryModeKey` routing

```bash
rg "queryModeKey" skills/openclaw-napm-query/services/MetricExecutionKernel.js
```

目标：

```text
routing count = 0
```

## 7.5 Warning-string control flow

```bash
rg "warning.*includes|includes\(.*warning|metric_group_incompatible_but_preserve" .
```

目标：

```text
execution decision count = 0
```

## 7.6 production metrics comma encoder

```bash
rg "metrics.*join|join\(['\"]?,['\"]?\)" skills/openclaw-napm-query
```

目标：

```text
production data-query metrics encoder = 1
```

## 7.7 production group encoder

```bash
rg "numGroups|groupType[0-9]*|groupArgument[0-9]*" skills/openclaw-napm-query
```

目标：

```text
production canonical group encoder = 1
```

## 7.8 production outcome mapper

```bash
rg "ExecutionOutcomeMapper|map.*Outcome|outcome.*map" skills/openclaw-napm-query napm-openclaw-plugin.remote.js
```

目标：

```text
canonical production outcome mapper = 1
```

---

# 8. 最终 Search Count 表

```markdown
| Check | Production Count | Target |
|---|---:|---:|
| `topMetric || metric` | ... | 0 |
| execution legacy `metric` truth | ... | 0 |
| execution/compatibility `metrics[0]` truth | ... | 0 |
| Kernel `queryModeKey` routing | ... | 0 |
| warning-string execution control | ... | 0 |
| metrics comma encoder | ... | 1 |
| group encoder | ... | 1 |
| outcome mapper | ... | 1 |
```

如果任何一项不符合：

```text
Phase 8 不得 Final PASS
```

---

# 9. Verification E — Final UNKNOWN → Runtime SUPPORTED Regression

必须新增或复用最终回归 fixture：

```text
Static Validator → UNKNOWN
requiredRuntimeChecks.provider=METRICS_FOR_GROUP
metricsForGroup → includes requested metric
```

期望：

```text
Static = UNKNOWN
metricsForGroup calls = 1
Runtime = SUPPORTED
Final Admission = ALLOW
Serializer calls = 1
Kernel calls = 1
Data calls = 1
Outcome = SUCCESS 或 NO_DATA（由 fixture 决定）
```

建议使用：

```text
WebApplication
metrics=[PGTME]
topMetric=PGTME
topCount=5
```

在无 trusted static baseline 下触发 UNKNOWN。

---

# 10. UNKNOWN Provider Guard

加负向 fixture：

```text
Static UNKNOWN
provider != METRICS_FOR_GROUP
```

期望：

```text
metricsForGroup=0
Serializer=0
Data=0
```

---

# 11. Verification F — Plugin / Gateway / Direct Outcome 一致性

必须对以下三个 outcome 做三入口一致性验证。

## 11.1 VALIDATION_FAILURE

Fixture：

```text
WebApplication + TRTI
verified baseline
```

期望：

```text
Plugin  → VALIDATION_FAILURE
Gateway → VALIDATION_FAILURE
Direct  → VALIDATION_FAILURE
```

reasonCode：

```text
OBJECT_METRIC_INCOMPATIBLE
```

Data：

```text
0
```

## 11.2 NO_DATA

合法 Query：

```text
data response=[]
```

期望：

```text
Plugin  → NO_DATA
Gateway → NO_DATA
Direct  → NO_DATA
```

同时：

```text
dataRequestAttempted=true
dataRequestSucceeded=true
responseParseSucceeded=true
rowCount=0
```

## 11.3 EXECUTION_FAILURE

合法 Query：

```text
NapmClient data request throws network/HTTP error
```

期望：

```text
Plugin  → EXECUTION_FAILURE
Gateway → EXECUTION_FAILURE
Direct  → EXECUTION_FAILURE
```

且：

```text
dataRequestAttempted=true
```

不得：

```text
NO_DATA
```

---

# 12. 推荐顺带验证 Runtime Capability Failure 一致性

```text
Static UNKNOWN
metricsForGroup throws
```

三入口：

```text
RUNTIME_CAPABILITY_FAILURE
```

Data：

```text
0
```

---

# 13. Outcome 一致性矩阵

```markdown
| Scenario | Plugin | Gateway | Direct | Core Reason |
|---|---|---|---|---|
| Static incompatible | VALIDATION_FAILURE | VALIDATION_FAILURE | VALIDATION_FAILURE | OBJECT_METRIC_INCOMPATIBLE |
| Legal empty | NO_DATA | NO_DATA | NO_DATA | rowCount=0 |
| Data network failure | EXECUTION_FAILURE | EXECUTION_FAILURE | EXECUTION_FAILURE | execution |
| Runtime provider failure | ... | ... | ... | runtime_capability |
```

---

# 14. `NO_DATA` Final Proof

必须明确回答：

```text
NO_DATA requires dataRequestAttempted=true:
YES / NO

NO_DATA requires dataRequestSucceeded=true:
YES / NO

NO_DATA requires responseParseSucceeded=true:
YES / NO

NO_DATA requires rowCount=0:
YES / NO

zero-call validation failure can become NO_DATA:
YES / NO
```

目标：

```text
YES
YES
YES
YES
NO
```

---

# 15. Final Truth Source Audit

输出：

```markdown
| Concern | Production Truth Source | Duplicate Production Truth? |
|---|---|---:|
| Natural-language metric semantics | Resolution Spec + MetricSemanticNormalizer | NO |
| Semantic lifecycle | Canonical Semantic Contract lifecycle | NO |
| Query shape | ResolvedQueryContract | NO |
| Static Object×Metric | objectMetricOwnership | NO |
| Runtime capability | RuntimeMetricCapabilityService + metricsForGroup | NO |
| Safe repair | AtomicQueryRepairService | NO |
| NAPM serialization | NapmQuerySerializer | NO |
| Group transport | GroupBuilder | NO |
| Execution outcome | ExecutionOutcomeContract + ExecutionOutcomeMapper | NO |
```

任何 YES 都阻塞 Final PASS。

---

# 16. Duplicate Config 最终确认

审计：

```text
Resolution Spec
Object Ontology
Metric Ownership
```

输出：

```markdown
| Config | Runtime Source | Duplicate | Duplicate Can Affect Runtime | Drift Guard |
|---|---|---|---:|---|
| Resolution Spec | ... | ... | ... | ... |
| Object Ontology | ... | ... | ... | ... |
| Metric Ownership | ... | ... | ... | ... |
```

如果两份配置都能影响 runtime：

```text
Phase 8 FAIL
```

---

# 17. 默认不修改生产代码

如果所有验证通过：

```text
production code changed in 8.1 = NO
```

如果验证发现差异：

```text
停止
报告真实问题
不要悄悄扩大修改
```

---

# 18. 测试要求

必须运行：

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

单独报告：

```text
Phase 8.1 verification tests
Final BUG-A regression
```

---

# 19. Phase 8.1 最终报告格式

## 19.1 Git

```text
branch:
HEAD:
Phase 8.1 start status:
Phase 8.1 end status:
production code changed:
YES / NO
```

## 19.2 Phase 8 Deletion Stats

```markdown
| Category | Added | Deleted | Net |
|---|---:|---:|---:|
| Production | ... | ... | ... |
| Tests | ... | ... | ... |
| Docs/Contracts | ... | ... | ... |
```

## 19.3 Physical Deletion List

```markdown
| Old Logic | Physically Deleted | If Retained, Why |
|---|---:|---|
| execution legacy metric truth | ... | ... |
| execution metrics[0] truth | ... | ... |
| warning-string execution control | ... | ... |
| duplicate outcome mapping | ... | ... |
| dead helpers | ... | ... |
```

## 19.4 LegacyMetricInputAdapter Caller Graph

```markdown
| Caller | Production | Why Needed | Removal Condition |
|---|---:|---|---|
| ... | ... | ... | ... |
```

## 19.5 TagNormalizer Caller Graph

```markdown
| Caller | Production | Can Choose Canonical Metric | Can Build Query | Removal Condition |
|---|---:|---:|---:|---|
| ... | ... | ... | ... | ... |
```

## 19.6 Final Search Counts

输出第 8 节完整表。

## 19.7 UNKNOWN → SUPPORTED Final Regression

```text
Static Validator calls:
Static status:
metricsForGroup calls:
Runtime status:
Serializer calls:
Kernel calls:
Data calls:
Outcome:
```

目标：

```text
1
UNKNOWN
1
SUPPORTED
1
1
1
SUCCESS / NO_DATA
```

## 19.8 UNKNOWN Provider Guard

```text
provider mismatch:
metricsForGroup calls:
Serializer calls:
Data calls:
```

目标：

```text
0
0
0
```

## 19.9 Entry Outcome Consistency Matrix

输出第 13 节完整表。

## 19.10 NO_DATA Proof

输出第 14 节五个答案。

## 19.11 Final Truth Source Table

输出第 15 节完整表。

## 19.12 Duplicate Config Audit

输出第 16 节表。

## 19.13 Tests

```text
Phase 8.1:
Final BUG-A regression:
Full repo:
lint:
runtime-contract:
diff-check:
```

给真实：

```text
suite count
test count
PASS / FAIL
```

## 19.14 Boundary Confirmation

```text
Semantic rules modified: NO
Ranking grammar modified: NO
Object Ontology modified: NO
Metric Catalog modified: NO
Ownership modified: NO
Runtime Capability semantics modified: NO
Atomic Repair semantics modified: NO
Serializer semantics modified: NO
BUG-B modified: NO
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
```

## 19.15 Final Decision

Codex 必须给：

```text
Phase 8:
PASS / FAIL

BUG-A:
DONE / NOT DONE
```

---

# 20. Phase 8.1 完成定义

只有全部满足才算完成：

```text
1. Phase 8 deletion stats 已给出或明确说明无法精确还原的原因
2. Phase 8 物理删除项已列出
3. LegacyMetricInputAdapter caller graph 已明确
4. LegacyMetricInputAdapter removal condition 已明确
5. TagNormalizer caller graph 已明确
6. TagNormalizer 不能决定 canonical metric
7. TagNormalizer 不能构造 executable query
8. production topMetric||metric = 0
9. execution legacy metric truth = 0
10. execution/compatibility metrics[0] truth = 0
11. Kernel queryModeKey routing = 0
12. warning-string execution control = 0
13. production metrics comma encoder = 1
14. production group encoder = 1
15. production outcome mapper = 1
16. UNKNOWN + METRICS_FOR_GROUP provider + SUPPORTED → Data=1
17. UNKNOWN provider mismatch → Data=0
18. Plugin/Gateway/Direct 的 VALIDATION_FAILURE 一致
19. Plugin/Gateway/Direct 的 NO_DATA 一致
20. Plugin/Gateway/Direct 的 EXECUTION_FAILURE 一致
21. NO_DATA 必须有真实成功 data call proof
22. duplicate production truth source = 0
23. duplicate config 不能共同影响 runtime
24. Full repo tests PASS
25. lint PASS
26. runtime-contract PASS
27. diff-check PASS
28. BUG-B 未修改
29. 无远端/部署/重启/commit
```

---

# 21. 最终签字规则

如果 Phase 8.1 全部 PASS：

```text
Phase 8 = PASS
BUG-A = DONE / FINAL PASS
```

此后不要继续：

```text
P8.2
P8.3
```

除非发现真实新的 BUG-A 回归。

下一项工作应切换到独立：

```text
BUG-B：PageFamily → pageViews 短追问
```

---

# 22. 本轮结束

完成 Phase 8.1 验证报告后立即停止，等待最终 Review。
