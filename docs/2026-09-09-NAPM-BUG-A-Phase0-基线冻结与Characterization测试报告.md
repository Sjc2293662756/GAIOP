# NAPM BUG-A Phase 0：基线冻结与 Characterization 测试报告

## 1. 结论

Phase 0 已完成。本阶段只冻结当前真实行为、增加测试专用南向调用计数器并记录基线，没有修复 BUG-A，没有修改生产代码或生产行为。

本报告中的“通过”表示测试能够稳定复现当前行为，不表示该行为符合最终契约。明确错误的现状将在后续阶段按最终实施方案逐步替换。

## 2. Git 基线

```text
branch: codex/napm-turn-decision-phase1
HEAD: c07a652aa80dd593ecf3546fe41f8f621175491a
```

开始前 `git status --short`：

```text
 M memory/2026-09-08.md
?? docs/2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案.md
?? memory/2026-09-09.md
```

开始前已有修改：

- `memory/2026-09-08.md`
- `docs/2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案.md`
- `memory/2026-09-09.md`

这些修改来自 Phase 0 之前的设计对齐工作。本阶段没有改写它们，也没有 reset、stash 或覆盖。

结束后 `git status --short`：

```text
 M memory/2026-09-08.md
?? docs/2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案.md
?? docs/2026-09-09-NAPM-BUG-A-Phase0-基线冻结与Characterization测试报告.md
?? memory/2026-09-09.md
?? test/bug-a-phase0-execution-characterization.test.js
?? test/bug-a-phase0-metric-contract-characterization.test.js
?? test/bug-a-phase0-plugin-characterization.test.js
?? test/bug-a-phase0-semantic-characterization.test.js
?? test/bug-a-phase0-truth-source-characterization.test.js
?? test/helpers/
```

Phase 0 新增修改为本报告第 3 节列出的 7 个文件；其余 3 项仍是开始前已有修改。

修改前备份：

```text
C:\Users\20693\AppData\Local\Temp\codex-napm-bug-a-phase0-20260909
```

## 3. Phase 0 文件变更清单

| 文件 | 类型 | 修改原因 | 是否生产代码 |
|---|---|---|---|
| `test/helpers/bug-a-phase0-southbound-call-counter.js` | test helper | 统一统计 fake NapmClient 的 metadata/data 调用 | NO |
| `test/bug-a-phase0-semantic-characterization.test.js` | characterization test | 冻结 Classifier、Resolver、ownership、Policy、Constraint、BottomN | NO |
| `test/bug-a-phase0-execution-characterization.test.js` | characterization test | 冻结 metadata review、Gateway、Direct、overload、错误分类和调用次数 | NO |
| `test/bug-a-phase0-metric-contract-characterization.test.js` | characterization test | 冻结 `metric/metrics[]/topMetric` 在各层的漂移 | NO |
| `test/bug-a-phase0-plugin-characterization.test.js` | characterization test | 冻结可信 Plugin Tool 适配器到 Query Skill 的完整调用基线 | NO |
| `test/bug-a-phase0-truth-source-characterization.test.js` | characterization test | 冻结双份配置、运行时读取源和 Metric Catalog fallback | NO |
| `docs/2026-09-09-NAPM-BUG-A-Phase0-基线冻结与Characterization测试报告.md` | test report | 汇总本阶段证据和验收结果 | NO |

## 4. Characterization Result Matrix

| 场景 | 当前实际行为 | 测试位置 | 结果 |
|---|---|---|---|
| 慢业务 Top5 | Workflow 为 `workflow_unresolved`；Resolver 为 `unsupported_prompt` | semantic characterization | PASS |
| 页面响应时间 Top5 | Workflow 只识别排行和 `WebApplication`，无 metricSemantic；Resolver 生成 `WebApplication + PGTME` | semantic characterization | PASS |
| 慢页面数量 Top5 | Workflow 识别排行但无 metricSemantic；Resolver 为 `missing_metric` | semantic characterization | PASS |
| 已定义应用服务器响应时间 Top5 | Resolver 生成 `DefinedApp + TRTI` | semantic characterization | PASS |
| IP 网络时延 Top5 | Workflow 未识别 IP 对象；Resolver 生成 `IPAddress + RTTI` | semantic characterization | PASS |
| “最低/最少的5个业务” | Workflow 识别排行；Resolver 因无指标而 `missing_metric` | semantic characterization | PASS |
| `WebApplication + TRTI` ownership | 静态判断为 incompatible / not owned | semantic characterization | PASS |
| 其他对象指标样本 | `WebApplication + PGTME/PGNSLPGE`、`DefinedApp + TRTI`、`IPAddress + RTTI/PLI` 为 compatible | semantic characterization | PASS |
| Policy `WebApplication + TRTI` | `EXECUTE_QUERY / QUERY_READY / southboundAllowed=true` | semantic characterization | PASS |
| Constraint `WebApplication + TRTI` | 产生 ownership incompatible warning，但保留原对象和指标 | semantic characterization | PASS |
| Metadata review | 静态已知不兼容后仍调用 `applications` 和 `metricsForGroup` | execution characterization | PASS |
| `executeGatewayRequest` | 不调用 Policy；执行 metadata review 后仍调用 `topValues` | execution characterization | PASS |
| `executeDirectGatewayRequest` | 不调用 Policy、Constraint、metadata review，直接进入 Validator 和 Metric Kernel | execution characterization | PASS |
| BottomN asc | 对 NAPM 已返回的 `100,90,80,70,60` 本地重排成 `60,70,80,90,100` | semantic characterization | PASS |
| 官方 `TPI/TPO + topMetric=TPIO` | Plugin 拒绝；QueryValidator 原始形态也因缺 `metric` 拒绝；Gateway 经 Constraint 后仍执行 | metric contract characterization | PASS |
| legacy-only `metric=TPIO` | Plugin 补齐三字段；Constraint 补 `metrics[]`；Kernel 以 `metric` fallback 发送 `topMetric/metrics` | metric contract characterization | PASS |
| 三字段冲突 | Plugin、Constraint、Validator 均接受；Kernel 发送 `metrics/topMetric=PGTME`，单数 `metric=TRTI` 未进入请求参数 | metric contract characterization | PASS |
| 多指标 | Plugin 把单数 `metric` 设为 `topMetric`；Constraint 把单数 `metric` 设为 `metrics[0]`；原始 QueryValidator 拒绝；Gateway 可执行 | metric contract characterization | PASS |
| metadata `metrics` 无 groups | 调用 `type=metrics` | execution characterization | PASS |
| metadata `metrics` 有 groups | 改为调用 `type=metricsForGroup` | execution characterization | PASS |
| metadata `groups` 无 groups | 调用 `type=groups` | execution characterization | PASS |
| metadata `groups` 单 WebApplication group | 改为调用 `type=applications` | execution characterization | PASS |
| 成功 `rows=[]` | RequirementParser 返回 `ok=true/data=[]/error=null` 且自身无 outcome；Plugin Query Turn 归为 `NO_DATA` | execution/plugin characterization | PASS |
| error message=`empty` | 通过错误文本猜为 `METRIC_EMPTY` | execution characterization | PASS |
| error message=`no data` | 通过错误文本猜为 `METRIC_EMPTY` | execution characterization | PASS |
| HTTP 400 + `no data` | HTTP 状态优先，分类为 `NAPM_UPSTREAM_400` | execution characterization | PASS |
| parse error | 分类为通用 `NAPM_UPSTREAM_ERROR` | execution characterization | PASS |
| Resolution Spec 双份 | root 与 Skill-local SHA 不同；root 缺 `pageViews` 和 `queryArgumentPolicies` | truth-source characterization | PASS |
| Object Ontology 双份 | root 与 Skill-local SHA 不同；root 缺 `TotalTraffic` 对象 | truth-source characterization | PASS |
| ownership / metrics-config 双份 | 两份物理文件当前 SHA 相同，但仍是重复真相源 | truth-source characterization | PASS |
| Metric Catalog 缺失/无效/读取失败 | 均加载 42 个内置默认指标并继续运行 | truth-source characterization | PASS |
| LegacyMetricInputAdapter | 当前不存在，各入口仍自行 normalize/infer | truth-source/metric contract characterization | PASS |

## 5. Southbound Baseline

所有调用均由本地 `FakeNapmClient` 完成；host 使用 `example.invalid`，没有连接真实 NAPM。

### 5.1 `WebApplication + TRTI`：可信 Plugin Tool 适配器路径

说明：此项使用插件签发的可信 trace 和测试准入 Decision，覆盖 Plugin Tool adapter → Query Skill → RequirementParser。它不是自然语言 `message_received` 自动选 Tool 的证明；该问句在当前 WorkflowClassifier 中仍为 unresolved。

```text
QueryDecisionPolicy calls = 1
Query Skill calls = 1
QueryMetadataConstraint calls = 1（Skill/Gateway 内）
metadata review calls = 1

applications = 1
businessGroups = 0
groups = 0
groupArguments = 0
metrics = 0
metricsForGroup = 1
granularities = 0

topValues = 1
averageValues = 0
timeValues = 0
pageViews = 0

NapmClient total = 3
最终结果 = ok=true，rows=[]；Query Turn outcome=NO_DATA
```

### 5.2 Metadata review only

```text
reviewGatewayRequestMetadata calls = 1
applications = 1
metricsForGroup = 1
data calls = 0
NapmClient total = 2
```

### 5.3 `executeGatewayRequest`

```text
QueryDecisionPolicy = 0
QueryMetadataConstraint = 1
metadata review = 1

applications = 1
businessGroups = 0
groups = 0
groupArguments = 0
metrics = 0
metricsForGroup = 1
granularities = 0

topValues = 1
NapmClient total = 3
最终结果 = ok=true，data=[]，error=null
```

### 5.4 `executeDirectGatewayRequest`

```text
QueryDecisionPolicy = 0
QueryMetadataConstraint = 0
metadata review = 0
QueryValidator = 1
MetricExecutionKernel = 1

topValues = 1
NapmClient total = 1
最终结果 = ok=true，data=[]，error=null
```

## 6. 当前确认的错误或漂移行为

以下只记录事实，本阶段未修复：

1. “最近业务访问较慢的前5个业务都有谁？”在 WorkflowClassifier 中 unresolved，在 Resolver 中 unsupported。
2. WorkflowClassifier 对本阶段 7 个排行样本均没有输出 `operation/direction/topCount`，也没有识别任何 `metricSemantic`；对 IP 样本还未识别目标对象。
3. 静态 ownership 已知 `WebApplication + TRTI` 不兼容，但 QueryDecisionPolicy 仍放行。
4. QueryMetadataConstraint 只记录 warning，仍保留并执行 `WebApplication + TRTI`。
5. 可信 Plugin Tool 路径当前会执行上述错误组合，并产生 2 次 metadata 和 1 次 data southbound。
6. `RequirementParserService.executeGatewayRequest()` 不经过 QueryDecisionPolicy。
7. `executeDirectGatewayRequest()` 同时绕过 QueryDecisionPolicy、Constraint 和 metadata review。
8. 静态已知不兼容并未阻止 metadata review；仍调用 `applications` 和 `metricsForGroup`。
9. 当前所谓 BottomN 只是把上游已返回的 TopN 在本地升序重排，不构成真实 BottomN。
10. Plugin 当前要求 `topMetric` 必须包含在 `metrics[]`，因此拒绝正式可表达的 `metrics=[TPI,TPO], topMetric=TPIO`。
11. QueryValidator 对 `topValues` 仍要求 legacy 单数 `metric`。
12. Plugin 与 QueryMetadataConstraint 对多指标输入派生单数 `metric` 的规则不同：前者取 `topMetric`，后者取 `metrics[0]`。
13. 三字段冲突目前不被拒绝；不同字段在不同层被忽略或继续传播。
14. MetricExecutionKernel 仍使用 `topMetric || metric` 和 metric CSV fallback。
15. `service=metrics/groups` 根据 groups 是否存在动态切换 provider，metadata service 语义仍重载。
16. ExecutionFailureClassifier 会根据异常 message 中的 `empty/no data` 猜测 NO_DATA 类别。
17. root 与 Skill-local Resolution Spec、Object Ontology 已发生内容漂移；运行时实际读取 Skill-local 文件。
18. root 与 Skill-local ownership、metrics-config 当前内容相同但仍是重复维护点。
19. Metric Catalog 在配置缺失、解析失败或读取失败时静默加载 42 个内置默认指标并继续运行。
20. 当前尚无统一 Legacy Metric Adapter；Plugin、Constraint、Validator 和 Kernel 各自兼容、补齐或 fallback。

## 7. 测试结果

### 7.1 Phase 0 专项测试

```text
Test Suites: 5 passed, 5 total
Tests: 65 passed, 65 total
FAIL: 0
SKIP/TODO: 0
```

命令：

```text
npx jest --runInBand --testPathPattern=bug-a-phase0
```

### 7.2 全仓测试

```text
Test Suites: 121 passed, 121 total
Tests: 1108 passed, 1108 total
Snapshots: 0
```

由此可区分：

```text
Phase 0 新增：5 suites / 65 tests
原有测试：116 suites / 1043 tests
```

### 7.3 质量门

```text
npm test -- --runInBand = PASS
npm run lint = PASS
npm run verify:runtime-contract = PASS（8 个运行时 Tool contract 均 ok）
git diff --check = PASS
```

## 8. 明确声明

```text
是否修改生产行为：NO
是否修改生产代码：NO
是否修改版本号：NO
是否制作发布包：NO
是否连接远端 NAPM：NO
是否连接、修改或重启服务器：NO
是否部署：NO
是否提交 commit：NO
是否进入 Phase 1：NO
```

## 9. Phase 0 完成状态

```text
Phase 0 是否完成：YES
```

本阶段到此停止，等待 Phase 0 Review。只有审查通过后才进入 Phase 1：Truth Source 收口。
