# GAIOP NAPM BUG-A Phase 6 实施报告

日期：2026-09-11  
分支：`codex/napm-turn-decision-phase1`  
HEAD：`e63f94ef1e8948544d77ff03488e9a0a645121f9`（Phase 6 未提交）  
Phase 6 开始状态：保留 Phase 0–5 的既有未提交修改；已创建备份 `C:\Users\20693\AppData\Local\Temp\codex-napm-phase6-pre-20260911-\HEAD-e63f94e.zip`。  
Phase 6 结束状态：实现和验证完成；工作区仍包含本分支全部未提交修改，未回滚或覆盖既有变更。
范围：Atomic Query Repair + Post-Repair Revalidation

## 结论

Phase 6 已在本地工作区完成，未进入 Serializer、Kernel Cleanup、全局 Error Contract、Legacy Cleanup 或 BUG-B。没有版本变更、提交、打包、部署、远端连接或服务重启。

## 执行链

```text
Canonical ResolvedQuery
        ↓
Initial Contract gate
        ↓
AtomicQueryRepairService.plan
        ↓
clone 上一次性 apply + fingerprint
        ↓
ResolvedQueryContract.validateShape
        ↓
ResolvedQueryExecutableValidator
        ↓
Static UNKNOWN ? ──否──> Final Admission
        │
        是
        ↓
RuntimeMetricCapabilityService（仅 METRICS_FOR_GROUP）
        ↓
Final Admission
        ↓
Kernel / NAPM data（最多一次）
```

## 改动范围

| 组件 | Phase 6 行为 |
|---|---|
| `AtomicQueryRepairService` | 新增唯一修复入口；canonical 输入、reason code allowlist、结构化审计、clone 原子应用、stale plan 检测 |
| `ResolvedQueryExecutionAdmissionService` | 修复前 Contract gate；修复后 Contract、Static、Runtime 全量重校验；Runtime 使用 repaired candidate |
| `RequirementParserService` | Gateway/Direct 共用 admission；metadata candidate 只能经 Atomic repair；prepared proof 使用对象身份 + fingerprint 的一次性 WeakMap |
| `QueryMetadataConstraintService` | 保持 clone 行为；其候选结果不再直接成为执行权威，必须经 Atomic repair 判定 |
| `scripts/verify-napm-skill-runtime-contract.js` | 增加 Phase 6 原子修复、重校验、proof 失效和 metadata 收口检查 |
| 文档与 memory | 同步 Phase 6 约束、边界、测试和未部署状态 |

## Repair Contract

输入仅为 `napm-resolved-query.v1`。状态为 `NO_REPAIR_NEEDED`、`REPAIR_APPLICABLE`、`REPAIR_REJECTED`；应用后为 `REPAIR_APPLIED` 或拒绝结果。

允许的语义中性变换：

- `NORMALIZE_METRIC_ID_CASE`
- `REMOVE_DUPLICATE_METRIC`
- `NORMALIZE_GROUP_ARGUMENT`
- `DERIVE_QUERY_MODE_KEY`
- `NORMALIZE_TIME_BOUND_FORMAT`

禁止：指标语义替换、对象类型替换、service 替换、`topMetric` 语义替换、删除请求指标、运行时自动选择其他指标、依赖 warning 文本改写 Query。

每条变更保存 `path/before/after/reasonCode/source/semanticImpact`，只接受 `semanticImpact=NONE`，并记录 `beforeFingerprint/afterFingerprint`。

## 原子性与重校验

- 原 Query：不修改。
- Repair：只在 clone 上应用，全部成功后才形成 candidate。
- partial candidate：不能流出执行链。
- 修复后 Contract：已重跑。
- 修复后 Static Validator：已重跑。
- 修复后 Static `UNKNOWN`：使用修复后的 group path/metric 重新调用 Runtime Capability；没有跨请求 evidence cache。
- prepared proof：以对象身份和 fingerprint 绑定；查询变化后失效并重新 admission。
- `NO_DATA`：不触发反向修复。

## 核心矩阵

| 输入 | Repair | Contract/Static | Runtime | 最终 |
|---|---|---|---|---|
| canonical valid | none | VALID | 不调用 | ALLOW |
| duplicate/case/format | applied | 重新校验 | 按结果 | ALLOW 或拒绝 |
| unsafe suggestion | rejected | 不进入 | 不调用 | DENY |
| static incompatible | 不替换 | KNOWN_INCOMPATIBLE | 不调用 | DENY |
| Static UNKNOWN + supported | 不换指标 | UNKNOWN | SUPPORTED | ALLOW |
| Static UNKNOWN + unsupported | 不换指标 | UNKNOWN | UNSUPPORTED | DENY |
| data 返回空数组 | 不修复 | 已通过 | 不重复确认 | NO_DATA |

## 测试

新增：

- `test/bug-a-phase6-atomic-repair.test.js`
- `test/bug-a-phase6-execution-revalidation.test.js`
- `test/bug-a-phase6-runtime-contract.test.js`

覆盖安全 plan、原对象不变、冲突/stale plan、非法指标删除建议、Gateway/Direct admission、修复后 Contract/Static/Runtime 重校验、运行时使用 repaired candidate、proof 指纹失效、NO_DATA 不修复及 runtime contract。

最终命令结果：`npm test -- --runInBand` 通过（150 suites / 1286 tests）；`npm run lint` 通过；`npm run verify:runtime-contract` 通过；`git diff --check` 通过。

## 边界确认

- Serializer：NO
- Kernel legacy fallback removal：NO
- Global Error Contract refactor：NO
- Metadata architecture refactor：NO
- BUG-B：NO
- 远端 NAPM/服务器连接：NO
- 部署、打包、重启：NO
- Git commit：NO
