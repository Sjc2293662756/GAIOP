# NAPM BUG-A Phase 4.1：Static Gate Verification 实施报告

## 1. 结论

Phase 4.1 验证通过，Phase 4 保持 PASS，Phase 5 可以 GO。本轮只补测试、调用计数、执行顺序证明和 runtime contract，没有连接真实 NAPM，没有进入 Phase 5。

## 2. Git 基线

branch: codex/napm-turn-decision-phase1

HEAD at start: e63f94ef1e8948544d77ff03488e9a0a645121f9

backup: C:\Users\20693\AppData\Local\Temp\codex-napm-phase41-pre-20260911-\HEAD-e63f94e.zip

production code changed in Phase 4.1: NO

Phase 4.1 工作区开始时干净；本轮没有 reset、stash 或覆盖既有修改。

## 3. 验证链

Plugin construction → allow declarative relative time → Plugin execution applies time override → full canonical validation → QueryDecisionPolicy / Shared Executable Validator → Query Skill。

Gateway → Shared Executable Validator → metadata review → Kernel / NapmClient。

Direct → trusted internal WeakSet proof once → otherwise Shared Executable Validator → Kernel / NapmClient。

Plugin construction 阶段允许声明式 timeRange.key 没有根级 start/end；execution 阶段的完整校验拿到的 Query 已经完成分钟对齐的时间物化。

## 4. 三入口调用矩阵

| 场景 | 入口 | Validator | Query Skill | Metadata | Kernel | metricsForGroup | Data | NapmClient |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| KNOWN_INCOMPATIBLE | Plugin | 1 | 0 | 0 | n/a | 0 | 0 | 0 |
| KNOWN_INCOMPATIBLE | Gateway | 1 | n/a | 0 | 0 | 0 | 0 | 0 |
| KNOWN_INCOMPATIBLE | Direct | 1 | n/a | 0 | 0 | 0 | 0 | 0 |
| METRIC_UNKNOWN | Plugin | 1 | 0 | 0 | n/a | 0 | 0 | 0 |
| METRIC_UNKNOWN | Direct | 1 | n/a | 0 | 0 | 0 | 0 | 0 |
| UNKNOWN | Plugin | 1 | 0 | 0 | n/a | 0 | 0 | 0 |
| UNKNOWN | Gateway | 1 | n/a | 0 | 0 | 0 | 0 | 0 |

证据来自 Phase 4 static/plugin-static 测试和本轮 bug-a-phase41-static-gate-verification.test.js。Validator 本身不访问 NapmClient、metadata 或 metricsForGroup。

## 5. 状态矩阵

| Query | Baseline | Metric existence | Ownership | Validator | Policy | Southbound |
|---|---|---|---|---|---|---:|
| WebApplication + PGTME | verified | exists | compatible | VALID | EXECUTE_QUERY | existing path |
| WebApplication + TRTI | verified | exists | incompatible | KNOWN_INCOMPATIBLE | VALIDATION_FAILURE | 0 |
| WebApplication + PGTME | no trusted baseline | exists | UNKNOWN | UNKNOWN | RUNTIME_CAPABILITY_REQUIRED | 0 |
| WebApplication + PGSUPERFAST | any | missing | not evaluated | METRIC_UNKNOWN | VALIDATION_FAILURE | 0 |
| topValues without topMetric | any | n/a | n/a | CONTRACT_INVALID | VALIDATION_FAILURE | 0 |

METRIC_UNKNOWN 在 ownership classifier 之前确定；本轮用 spy 验证 ownership 调用次数为 0。

## 6. Prepared Proof

| Case | Expected | Result |
|---|---|---|
| 同一实例首次执行 | proof accepted once | PASS |
| 同一实例重放 | proof 已消费，重新验证 | PASS |
| 外部 prepared/proof 字段伪造 | 不信任，重新验证 | PASS |
| 跨实例复用 | WeakSet 不共享，重新验证并阻断非法 Query | PASS |

实现使用实例级 WeakSet，不依赖可序列化字段，不接受普通 JSON 伪造，也不会重复消费同一 proof。

## 7. 多指标与 topMetric

metrics[] every item checked: YES

topMetric checked independently: YES

metrics[0]-only shortcut: NO

topMetric membership required: NO

已验证：

- Case A：metrics=[PGNPGE,TRTI] 在 metrics[1] 返回 KNOWN_INCOMPATIBLE；
- Case B：只有 topMetric=TRTI 不兼容时返回 RANKING_METRIC issue；
- Case C：topMetric 不在 metrics[] 仍可 VALID；
- Case D：metrics[1]=PGSUPERFAST 返回 METRIC_UNKNOWN；
- Case E：topMetric=PGSUPERFAST 返回 METRIC_UNKNOWN；
- UNKNOWN 场景对同一指标合并 RETURN_METRIC 与 RANKING_METRIC roles。

## 8. Overview / Child Query

Overview child query 通过 executeGatewayRequest 进入同一 Gateway gate。本轮构造合法 root 与非法 child：root 产生一次数据调用，child 返回 OBJECT_METRIC_INCOMPATIBLE，Kernel 和数据接口没有第二次调用。不存在 Overview child bypass。

## 9. Validator 纯度与 Policy 边界

Validator NapmClient dependency: NO

Validator metadata dependency: NO

Validator raw prompt parsing: NO

Validator repair: NO

QueryDecisionPolicy 仍保留应用/TotalTraffic 的高风险语义一致性判断；这属于语义范围门禁，不是 Object × Metric ownership 的重复实现。ownership 执行准入仍统一调用 ResolvedQueryExecutableValidator。

## 10. 测试矩阵

| Test Group | Suites | Tests | PASS | FAIL | SKIP |
|---|---:|---:|---:|---:|---:|
| Phase 0 relevant | 5 | 67 | 67 | 0 | 0 |
| Phase 1 | 2 | 19 | 19 | 0 | 0 |
| Phase 2 | 5 | 45 | 45 | 0 | 0 |
| Phase 2.1 | 1 | 9 | 9 | 0 | 0 |
| Phase 3 | 7 | 43 | 43 | 0 | 0 |
| Phase 4 | 4 | 17 | 17 | 0 | 0 |
| Phase 4.1 | 3 | 7 | 7 | 0 | 0 |
| Full repo | 143 | 1250 | 1250 | 0 | 0 |

Phase 4.1 新增或补充：

- test/bug-a-phase41-static-gate-verification.test.js
- test/bug-a-phase41-plugin-time-order.test.js
- test/bug-a-phase41-runtime-contract.test.js
- Phase 4 executable validator 的 Case D/E；
- Phase 4 Plugin static gate 的 UNKNOWN 调用计数。

## 11. 命令结果

npm test -- --runInBand: PASS, 143 suites / 1250 tests

npm run lint: PASS

npm run verify:runtime-contract: PASS

git diff --check: PASS

## 12. 最终状态

Phase 4: PASS

Phase 4.1: PASS

Phase 5: GO

Remote NAPM: NO

Deploy: NO

Restart: NO

Commit: NO

Phase 5 started: NO
