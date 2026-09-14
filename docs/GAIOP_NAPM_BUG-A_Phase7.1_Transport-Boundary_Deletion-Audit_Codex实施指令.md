# GAIOP NAPM BUG-A 实施指令 — Phase 7.1：Transport Boundary Verification + Dead Code / Deletion Audit

> 前置状态
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
> - Phase 7：CONDITIONAL PASS
> - Phase 7.1：VERIFICATION REQUIRED
> - Phase 8：HOLD
>
> **本轮不是新功能阶段。**
>
> Phase 7 主体已经完成：
>
> ```text
> Canonical ResolvedQuery
> → NapmQuerySerializer
> → MetricExecutionKernel
> → NapmClient
> ```
>
> 本轮只验证两件事：
>
> 1. `groups[]` 到最终 NAPM `numGroups/groupTypeN/groupArgumentN` 的“最后一米”到底在哪里完成，以及该层是否真的只是机械 transport encoding。
> 2. Phase 7 是否真的物理删除了旧 fallback / duplicate mapping / dead helper，而不是只新增 Serializer 覆盖在旧逻辑之上。
>
> 完成后立即停止，不进入 Phase 8。

---

## 1. Phase 7.1 核心验收问题

必须回答：

```text
Q1. groups[] → numGroups/groupTypeN/groupArgumentN 到底在哪里转换？
Q2. 如果转换在 NapmClient，NapmClient 是否仍承担业务解释？
Q3. production group encoder 到底有几套？
Q4. production metrics comma encoder 到底有几套？
Q5. topMetric || metric 是否已物理删除？
Q6. execution metrics[0] fallback 是否已物理删除？
Q7. Kernel queryModeKey routing 是否已物理删除？
Q8. Serializer / Kernel / Client data path 是否完全不再读取 legacy metric？
Q9. P7 实际新增/删除多少生产代码？
Q10. 有没有 dead helper 已无生产 caller 但仍留在仓库？
```

---

## 2. 本轮禁止事项

禁止：

```text
修改 Semantic rules
修改 Object Ontology
修改 Metric Catalog
修改 Object×Metric ownership
修改 Runtime Capability 语义
修改 Atomic Repair 语义
重构 Global Error Contract
重构 NO_DATA classifier
大规模重构 Metadata architecture
删除 LegacyMetricInputAdapter
处理 BUG-B
连接真实 NAPM
部署
重启
提交 commit
```

允许：

```text
补验证测试
补 runtime-contract
删除已确认 dead fallback/helper
把重复的纯 transport group encoding 收口成唯一 helper
移除 NapmClient 中仍残留的业务推导
```

任何生产代码改动都必须是“验证发现真实问题后”的最小修正。

---

## 3. 开始前记录 Git 基线

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
Phase 7.1 start status:
Phase 7 existing diff:
```

禁止：

```text
reset
stash
覆盖已有修改
```

---

## 4. 审计 `groups[]` 最终 Transport Chain

执行：

```bash
rg "numGroups|groupType[0-9]*|groupArgument[0-9]*|groups"   skills/openclaw-napm-query   napm-openclaw-plugin.remote.js
```

必须输出**真实代码链**，例如：

```text
Canonical Query.groups[]
→ NapmQuerySerializer.params.groups
→ NapmClient.topValues()
→ GroupTransportEncoder
→ numGroups/groupTypeN/groupArgumentN
→ HTTP
```

或：

```text
Canonical Query.groups[]
→ NapmQuerySerializer
→ numGroups/groupTypeN/groupArgumentN
→ NapmClient
→ HTTP
```

每一步必须列：

```text
文件
函数
职责
```

不能只写概念图。

---

## 5. 如果 Group Expansion 发生在 NapmClient

逐项回答：

```text
NapmClient 根据 object type 做业务判断：YES / NO
NapmClient 查询 groupArguments：YES / NO
NapmClient 补缺失 argument：YES / NO
NapmClient 替换 group type：YES / NO
NapmClient 调整 group 顺序：YES / NO
NapmClient 根据 service 改 group path：YES / NO
NapmClient 只做机械 flatten/encode：YES / NO
```

目标：

```text
NO
NO
NO
NO
NO
NO
YES
```

如果不是这个结果：

```text
Phase 7 不能直接 PASS
```

---

## 6. “机械 Transport Encoding”的允许边界

允许：

```text
groups.length → numGroups
groups[0].type → groupType1
groups[0].argument → groupArgument1
field numbering
string conversion
URL encoding
```

禁止：

```text
if WebApplication then ...
if missing argument then query metadata
if unsupported path then换 group
if service=topValues then重排 groups
自动补对象
自动补 argument
repair group path
```

---

## 7. Group Encoder 必须只有一个 Production Truth

审计所有：

```text
numGroups
groupTypeN
groupArgumentN
```

输出：

```markdown
| Location | Encodes groups | Production caller | Mechanical only | Action |
|---|---:|---:|---:|---|
| ... | ... | ... | ... | ... |
```

目标：

```text
production group encoder = 1
```

如果 metadata 和 data 共用同一纯 helper：

```text
可以
```

但不能：

```text
Serializer 一套
Kernel 一套
Client 一套
metadata 又一套
```

---

## 8. Serializer / Client 边界必须明确选一种

### 可接受方案 A

```text
NapmQuerySerializer
→ 完全 HTTP-ready group params
→ NapmClient
```

### 可接受方案 B

```text
NapmQuerySerializer
→ structured transport DTO.groups
→ 唯一 pure GroupTransportEncoder
→ NapmClient HTTP
```

方案 B 的前提：

```text
GroupTransportEncoder 不拥有业务语义
```

禁止隐含第三种：

```text
Serializer 映射一部分
NapmClient 再判断、补参、repair
```

---

## 9. P7 Deletion Audit

执行：

```bash
git diff --stat
git diff --numstat
```

对 P7/P7.1 涉及的生产文件单独输出：

```markdown
| File | Added | Deleted | Net | 说明 |
|---|---:|---:|---:|---|
| NapmQuerySerializer.js | ... | ... | ... | new single serializer |
| MetricExecutionKernel.js | ... | ... | ... | removed fallback/assembly |
| NapmClient.js | ... | ... | ... | transport cleanup |
| ... | ... | ... | ... | ... |
```

注意：

> 本轮不是要求“删除行数必须大于新增行数”。

真正目标是确认：

```text
新增正式边界
换掉旧的 fallback / duplicate truth source
```

测试代码和 contract guard 增长是合理的。

---

## 10. 必须列出“物理删除”的旧逻辑

逐项说明：

```text
topMetric || metric
query.metric execution read
metrics[0] primary fallback
Kernel metrics.join(',')
Kernel default/clamp topCount
Kernel queryModeKey routing
duplicate data param builder
duplicate group encoder
dead fallback helper
```

每项输出：

```markdown
| Old Logic | File/Function | Status | Replacement |
|---|---|---|---|
| topMetric || metric | ... | DELETED/STILL_EXISTS | canonical topMetric |
| ... | ... | ... | ... |
```

---

## 11. 旧代码必须分三类

### A. 已物理删除

```text
DELETED
```

### B. 仍活跃的明确 Migration Boundary

例如：

```text
LegacyMetricInputAdapter
```

标：

```text
KEEP_TEMPORARILY
```

### C. 已无生产调用但仍在仓库

标：

```text
DEAD_CODE_CANDIDATE
```

P7.1 应尽量删除 C 类。

若不删除：

```text
说明原因
指定 P8 cleanup
```

---

## 12. Dead Code Symbol Audit

至少检查：

```text
旧 metric fallback helper
旧 metrics encoder
旧 service router
旧 queryModeKey router
旧 group serializer
旧 data param builder
```

用：

```bash
rg "<symbol-name>" .
```

输出：

```markdown
| Symbol | Production Callers | Test Callers | Dead | Action |
|---|---:|---:|---:|---|
| ... | ... | ... | ... | ... |
```

---

## 13. `topMetric || metric` 生产代码必须为 0

执行：

```bash
rg "topMetric.*\|\|.*metric|metric.*\|\|.*topMetric" .
```

生产执行代码目标：

```text
count = 0
```

测试/历史文档不计入 production count。

---

## 14. Execution `metrics[0]` Truth 必须为 0

执行：

```bash
rg "metrics\s*\[\s*0\s*\]" skills/openclaw-napm-query
```

逐条分类。

以下用途目标必须为 0：

```text
metrics[0] → metric
metrics[0] → primaryMetric
metrics[0] → topMetric
metrics[0] → service routing
```

纯展示代码可保留，但必须明确：

```text
非 execution truth
```

---

## 15. Kernel `queryModeKey` Routing 必须为 0

执行：

```bash
rg "queryModeKey" skills/openclaw-napm-query/services/MetricExecutionKernel.js
```

如果仍存在：

```text
只能用于 trace/audit
```

不能参与：

```text
dispatch
```

---

## 16. Serializer / Kernel / Client Legacy `metric` Read 必须为 0

搜索：

```bash
rg "\.metric\b|\['metric'\]|\[\"metric\"\]"   skills/openclaw-napm-query/services/MetricExecutionKernel.js   skills/openclaw-napm-query/services/NapmQuerySerializer.js   skills/openclaw-napm-query/src   skills/openclaw-napm-query/scripts
```

目标：

```text
MetricExecutionKernel production read = 0
NapmQuerySerializer production read = 0
NapmClient data-path business read = 0
```

Legacy Adapter 不计。

---

## 17. `metrics.join(',')` 必须只有一个 Production Encoding Truth

搜索：

```bash
rg "metrics.*join|join\(['\"]?,['\"]?\)" skills/openclaw-napm-query
```

data query transport encoding 目标：

```text
production encoder = 1
```

如果 Serializer 负责：

```text
Kernel / Client 不得再 join
```

---

## 18. Service Routing 不得再隐式猜测

搜索是否存在：

```text
topMetric exists → topValues
granularity exists → timeValues
queryModeKey → service
metrics shape → service
```

执行 routing 必须只认：

```text
canonical query.service
```

---

## 19. NapmClient Consumer Audit

搜索 NapmClient 对：

```text
metric
metrics
topMetric
queryModeKey
groups
service
```

的所有读取。

输出：

```markdown
| Field | Read Location | Purpose | Mechanical Transport | Business Derivation |
|---|---|---|---:|---:|
| groups | ... | ... | ... | ... |
| metrics | ... | ... | ... | ... |
| ... | ... | ... | ... | ... |
```

目标：

```text
Business Derivation = 0
```

---

## 20. Client Boundary Snapshot Test

使用 Spy/Fake NapmClient。

至少覆盖：

```text
topValues
averageValues
timeValues
pageViews
```

确认 Client 收到的是：

```text
transport-ready DTO
```

而不是：

```text
需要重新理解的 Canonical Query
```

---

## 21. Group Transport Snapshot Test

构造 canonical groups：

```json
[
  {
    "type": "BusinessGroup",
    "argument": "abc"
  },
  {
    "type": "IPAddress"
  }
]
```

最终 HTTP-ready 参数应精确形成：

```text
numGroups=2
groupType1=BusinessGroup
groupArgument1=abc
groupType2=IPAddress
```

具体字段以项目现有真实接口契约为准。

测试必须锁定：

```text
顺序
index
argument presence
```

---

## 22. Group Encoder 不得 Repair

对非法/缺失 argument 的输入：

```text
group encoder
```

不得：

```text
查 metadata
补 argument
换 group type
```

应由更早的 Contract / Admission fail closed。

---

## 23. Internal Field Leakage 再验证

最终 HTTP-ready params 中必须 ABSENT：

```text
schemaVersion
queryModeKey
metric
repairApplied
repairAudit
staticValidation
runtimeCapability
finalAdmission
preparedProof
reasonCode
issues
warnings
```

---

## 24. Multi-Metric TopN 最后一米验证

Canonical：

```text
metrics=[TPI,TPO]
topMetric=TPIO
```

最终：

```text
metrics=TPI,TPO
topMetric=TPIO
```

必须继续证明：

```text
TPIO 不要求属于 metrics[]
```

---

## 25. 慢业务 Top5 最后一米验证

Canonical：

```text
service=topValues
groups=[WebApplication]
metrics=[PGTME]
topMetric=PGTME
topCount=5
```

最终 HTTP-ready params 必须精确，并确认：

```text
无 metric
无 queryModeKey
无 repair/runtime internal fields
```

---

## 26. 趋势与平均值 Transport 验证

### timeValues

```text
metrics=[PGNPGE,PGTME,PGHTTP500]
```

最终：

```text
metrics=PGNPGE,PGTME,PGHTTP500
```

不得出现：

```text
topMetric
metric
```

### averageValues

```text
metrics=[PGTME,PGNPGE]
```

最终：

```text
metrics=PGTME,PGNPGE
```

不得出现：

```text
topMetric
topCount
metric
```

---

## 27. Static Invalid 不到 Serializer / Group Encoder / Client

验证：

```text
KNOWN_INCOMPATIBLE
→ Serializer=0
→ Group Encoder=0
→ Data Client=0
```

同样适用于：

```text
METRIC_UNKNOWN
CONTRACT_INVALID
```

---

## 28. Runtime Unsupported 不到 Data Transport

```text
UNKNOWN
→ metricsForGroup=1
→ UNSUPPORTED
→ Serializer=0
→ Data group encoder=0
→ Data Client=0
```

---

## 29. Repair Rejected 不到 Data Transport

```text
Repair rejected
→ Serializer=0
→ Data Client=0
```

---

## 30. Legacy Input Boundary 只做审计，不删除

必须回答：

```text
生产调用方是否仍发送 legacy `metric`：
YES / NO / UNKNOWN
```

如果 YES：

```text
列出 caller
```

如果 NO：

```text
标记 LegacyMetricInputAdapter 为 P8 cleanup candidate
```

本轮不删除 Adapter。

---

## 31. Phase 6 Initial Contract Gate Guard

必须确认：

```text
Initial Contract gate
```

只是：

```text
进入 Repair 所需 envelope/invariant 检查
```

而不是第二套：

```text
topValues/averageValues/timeValues full contract
```

完整 shape truth 仍必须只有：

```text
ResolvedQueryContract
```

---

## 32. Unknown Metric 不得在执行层被 case/alias 修复

回归：

```text
真正未知 metric
→ METRIC_UNKNOWN
```

Serializer / Kernel / Client 不得：

```text
uppercase
alias-map
guess
```

然后尝试执行。

---

## 33. Runtime Contract 增强

若当前还没有，增加：

```text
single production data group encoder
single production metrics comma encoder
NapmClient group handling mechanical only
group encoder no metadata dependency
group encoder no repair dependency
no execution metric fallback
no execution metrics[0] truth
no Kernel queryModeKey routing
```

---

## 34. Phase 7.1 允许的最小生产改动

只有验证失败才允许：

```text
删除 dead fallback helper
删除 dead duplicate serializer
删除 dead queryModeKey router
删除 duplicate metrics encoder
删除 duplicate group encoder
收口唯一 pure GroupTransportEncoder
移除 NapmClient 中业务推导
```

每个改动必须：

```text
有失败证据
有对应测试
```

---

## 35. 不为“删代码”而删代码

不要求：

```text
Deleted > Added
```

判断标准是：

```text
新唯一边界是否替代了旧重复 truth source
```

合理增加：

```text
Serializer
contract tests
runtime-contract
```

没问题。

不合理的是：

```text
新 Serializer 已存在
但旧 fallback / duplicate builder / dead helper 仍全留着
```

---

## 36. 完成后必须运行

真实执行：

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

并单独报告：

```text
Phase 7.1 tests
```

---

# 37. 最终报告格式

## 37.1 Git

```text
branch:
HEAD:
Phase 7.1 start status:
Phase 7.1 end status:
production code changed in 7.1: YES / NO
```

若 YES：

```text
列文件与原因
```

---

## 37.2 Group Transport Chain

输出：

```text
Canonical groups[]
→ [真实类/函数]
→ [真实类/函数]
→ numGroups/groupTypeN/groupArgumentN
→ HTTP
```

每一步列：

```text
文件
函数
职责
```

---

## 37.3 NapmClient Boundary

回答：

```text
interprets object semantics: YES / NO
repairs group path: YES / NO
fills group arguments: YES / NO
chooses service: YES / NO
chooses metrics/topMetric: YES / NO
only mechanically encodes/sends: YES / NO
```

目标：

```text
NO
NO
NO
NO
NO
YES
```

---

## 37.4 Group Encoder Ownership

```markdown
| Encoder | Production | Mechanical only | Keep |
|---|---:|---:|---:|
| ... | ... | ... | ... |
```

目标：

```text
one production truth
```

---

## 37.5 Deletion Audit

```markdown
| File | Added | Deleted | Net | Old logic removed |
|---|---:|---:|---:|---|
| ... | ... | ... | ... | ... |
```

---

## 37.6 Physical Deletion List

```text
topMetric || metric:
DELETED / STILL EXISTS

metrics[0] execution fallback:
DELETED / STILL EXISTS

Kernel metrics.join:
DELETED / STILL EXISTS

Kernel topCount default:
DELETED / STILL EXISTS

Kernel queryModeKey routing:
DELETED / STILL EXISTS

duplicate data serializer:
DELETED / STILL EXISTS

duplicate group encoder:
DELETED / STILL EXISTS
```

---

## 37.7 Dead Code Candidates

```markdown
| Symbol/File | Production Callers | Reason Still Present | P8 Cleanup Candidate |
|---|---:|---|---:|
| ... | ... | ... | ... |
```

---

## 37.8 Search Counts

必须给真实数字：

```text
production topMetric || metric:
count =

execution metrics[0] primary truth:
count =

Kernel queryModeKey routing:
count =

Kernel metric reads:
count =

Serializer metric reads:
count =

NapmClient metric business reads:
count =

production metrics comma encoders:
count =

production group encoders:
count =
```

目标：

```text
topMetric || metric = 0
metrics[0] primary truth = 0
Kernel queryModeKey routing = 0
Kernel metric reads = 0
Serializer metric reads = 0
NapmClient metric business reads = 0
metrics comma encoder = 1
group encoder = 1
```

---

## 37.9 Final Transport Golden Matrix

```markdown
| Service | Canonical Query | Final HTTP-ready Params |
|---|---|---|
| topValues single metric | ... | ... |
| topValues multi + independent topMetric | ... | ... |
| averageValues | ... | ... |
| timeValues | ... | ... |
| pageViews | ... | ... |
```

---

## 37.10 Internal Field Leakage

逐项：

```text
schemaVersion: ABSENT/PRESENT
queryModeKey: ABSENT/PRESENT
metric: ABSENT/PRESENT
repairAudit: ABSENT/PRESENT
runtimeCapability: ABSENT/PRESENT
finalAdmission: ABSENT/PRESENT
preparedProof: ABSENT/PRESENT
reasonCode: ABSENT/PRESENT
issues: ABSENT/PRESENT
warnings: ABSENT/PRESENT
```

目标全部：

```text
ABSENT
```

---

## 37.11 Legacy Adapter Usage

```text
production callers still send metric:
YES / NO / UNKNOWN
```

若 YES：

```text
列 caller
```

若 NO：

```text
P8 cleanup candidate = YES
```

---

## 37.12 P6 Guard

```text
Initial Contract gate duplicates full ResolvedQueryContract:
YES / NO
```

目标：

```text
NO
```

```text
Unknown metric can be repaired in execution layer:
YES / NO
```

目标：

```text
NO
```

---

## 37.13 Tests

```text
Phase 7.1:
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

---

## 37.14 Remote / Deployment / Commit

必须：

```text
Remote NAPM: NO
Deploy: NO
Restart: NO
Commit: NO
Phase 8 started: NO
```

---

## 37.15 Phase 7 Final Decision

Codex 自己先给：

```text
Phase 7:
PASS / FAIL
```

只有全部满足才允许 PASS：

```text
1. groups → HTTP group params 的真实链路已证明
2. NapmClient 不做业务解释
3. group encoder production truth 唯一
4. metrics comma encoder production truth 唯一
5. topMetric || metric = 0
6. execution metrics[0] truth = 0
7. Kernel queryModeKey routing = 0
8. Kernel/Serializer/Client data path legacy metric truth = 0
9. P7 deletion audit 已完成
10. dead code 已清理或明确列入 P8
11. internal fields 不泄漏
12. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 38. Phase 7.1 完成定义

只有全部满足才算完成：

```text
1. 最终 group transport conversion location 已明确
2. group encoder 是机械编码器
3. NapmClient 不解释 Object/Metric semantics
4. NapmClient 不 repair
5. NapmClient 不补 group argument
6. NapmClient 不决定 service
7. NapmClient 不决定 metrics/topMetric
8. production group encoder 唯一
9. production metrics comma encoder 唯一
10. topMetric || metric 生产代码为 0
11. execution metrics[0] primary truth 为 0
12. Kernel queryModeKey routing 为 0
13. Kernel legacy metric read 为 0
14. Serializer legacy metric read 为 0
15. Client data path legacy metric business read 为 0
16. P7 deletion audit 已完成
17. dead code candidates 已列出
18. internal fields 不泄漏
19. multi-metric + independent topMetric transport 正确
20. Static invalid 不到 Serializer/Client
21. Runtime unsupported 不到 Serializer/Client
22. Legacy Adapter usage 状态已明确
23. P6 Initial Contract gate 未成为第二 truth source
24. full tests/lint/runtime-contract/diff-check 全 PASS
```

---

# 39. 最终提醒

Phase 7.1 不是：

```text
再增加一个 Service
```

而是验证：

> **Phase 7 新增的 Serializer 是否真的替代了旧执行逻辑。**

我们希望最终看到的是：

```text
一个正式 Serializer
+
一个正式 group transport encoder
+
一个只做 HTTP/机械编码的 Client
-
旧 metric fallback
-
旧 metrics[0] fallback
-
旧 queryModeKey routing
-
重复 transport mapping
-
dead helper
```

如果最后只是：

```text
新 Serializer 已经存在
但旧逻辑仍在生产代码中躺着
```

则 Phase 7 不算完整完成。

完成后停止，提交 Phase 7.1 验证报告，等待 Review。
