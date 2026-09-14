# GAIOP NAPM BUG-A Phase 7 实施报告

日期：2026-09-11  
分支：`codex/napm-turn-decision-phase1`  
HEAD：`e63f94ef1e8948544d77ff03488e9a0a645121f9`（Phase 7 未提交）  
Phase 7 开始状态：保留 Phase 0–6 全部未提交修改；已创建备份：  
`C:\Users\20693\AppData\Local\Temp\codex-napm-phase7-pre-20260911-150721\working-tree.zip`  
Phase 7 结束状态：本地实现和验证完成；未回滚、未覆盖既有修改，工作区仍包含全部未提交变更。

## 结论

Phase 7 已完成：最终准入后的 canonical Query 现在通过唯一 `NapmQuerySerializer` 显式转换为 NAPM transport params；MetricExecutionKernel 不再读取 legacy `metric`、从 `metrics[0]` 推导、拼接 metrics 或补默认 `topCount`；PageViews 保持独立 detail contract。未进入 Phase 8、全局 Error Contract、完整 Legacy Cleanup、BUG-B 或真实部署。

## 执行链

```text
Canonical ResolvedQuery
        ↓
Atomic Repair / Contract / Static / Runtime Gate
        ↓  Final Admission = ALLOW
NapmQuerySerializer
        ↓
Explicit NAPM transport params
        ↓
MetricExecutionKernel（按 service dispatch）
        ↓
NapmClient（HTTP transport only）
        ↓
NAPM
```

## Execution Consumer Audit

| Consumer | 读取 canonical Query | 是否重新推导语义 | 是否发送 NAPM 参数 | Phase 7 处理 |
|---|---:|---:|---:|---|
| `NapmQuerySerializer` | 是 | 否 | 构造 transport DTO | 新增唯一映射入口 |
| `MetricExecutionKernel` | 是 | 否 | 调 Client | 只校验、序列化、执行、收口 |
| `PageViewsExecutionKernel` | 是 | 否 | 调 Client | 复用 Serializer 的独立 pageViews contract |
| `NapmClient` | 否 | 否 | HTTP | 仅接收 transport-ready params |
| `RequirementParserService` | 是 | 否 | 不直接拼 metric transport | 通过 Serializer 的 Kernel 执行 |

## Serializer Contract

输入：仅 `napm-resolved-query.v1`；只能在最终 admission 允许后使用。  
输出：`{ service, params }`，其中 `params` 是明确构造的 NAPM 请求参数。

| Service | 输出字段 |
|---|---|
| `topValues` | `type/start/end/json/metrics/topMetric/topCount/groups` |
| `averageValues` | `type/start/end/json/metrics/groups` |
| `timeValues` | `type/start/end/json/metrics/granularity/groups` |
| `pageViews` | 现有 `pageViews` detail 参数：`type/start/end/json/pageFamilyId/maxLimit` |

`metrics[]` 只在 Serializer 中按原顺序执行 `join(',')`；`topMetric` 独立序列化，不要求属于 `metrics[]`。Serializer 不读取 raw prompt、legacy `metric`、metadata、repair、Runtime evidence、LLM 或 Metric Catalog，不修改输入，也不补默认值。

## Kernel Contract

| 检查项 | 结果 |
|---|---|
| 读取 `metric` | NO |
| `topMetric || metric` 回退 | NO |
| `metrics[0]` 作为业务真相 | NO |
| 从 `metrics[]` 重新拼接 transport | NO |
| 默认/Clamp `topCount` | NO |
| 按 `service` 路由 | YES |
| 按 `queryModeKey` 路由 | NO |
| 修改 canonical Query | NO |

Kernel 只调用 Serializer、构造审计信息、调用 NapmClient 和解析结果。Serializer 出错时在 NapmClient 前终止。

## Internal Field Leakage

显式 DTO 不包含：`schemaVersion`、`queryModeKey`、`repairApplied`、`repairAudit`、fingerprint、`staticValidation`、`runtimeCapability`、`finalAdmission`、`preparedProof`、`reasonCode`、`issues`、`warnings`、legacy 标记。

## 调用矩阵

| 场景 | Serializer | metricsForGroup | Kernel/Data |
|---|---:|---:|---:|
| Static VALID | 1 | 0 | 1 |
| Static invalid | 0 | 0 | 0 |
| Runtime SUPPORTED | 1 | 1 | 1 |
| Runtime UNSUPPORTED | 0 | 1 | 0 |
| Runtime INDETERMINATE | 0 | 1 | 0 |
| Repair rejected | 0 | 0 | 0 |
| Serializer invariant failure | 1 | 0 | 0 |
| Legacy input | Adapter 1，然后 Serializer 1 | 按 admission | 最多一次 |

## 测试

新增：

- `test/bug-a-phase7-napm-serializer.test.js`：top/average/time/pageViews Golden、内部字段隔离、输入不可变、非法输入 fail-closed、Kernel 只使用 Serializer。
- `test/bug-a-phase7-runtime-contract.test.js`：唯一 Serializer、显式 allowlist、Kernel/Client 边界、metrics 顺序和 transport shape。

最终验证：

- `npm test -- --runInBand`：PASS，152 suites / 1295 tests
- `npm run lint`：PASS
- `npm run verify:runtime-contract`：PASS
- `git diff --check`：PASS

## Phase 4–6 非回归

- Phase 4 Static Validator 仍先于 metadata、Kernel、南向调用。
- Phase 5 仍只对 provider=`METRICS_FOR_GROUP` 的 Static UNKNOWN 做运行时确认。
- Phase 6 Atomic Repair、post-repair Contract/Static/Runtime revalidation、proof fingerprint 失效和 NO_DATA 不修复规则保持不变。
- LegacyMetricInputAdapter 仍保留在兼容边界；canonical data path 不包含 `metric`。

## 边界确认

- Global Error Contract：NO
- NO_DATA classifier refactor：NO
- Legacy Adapter removal：NO
- Metadata architecture refactor：NO
- BUG-B：NO
- 远端 NAPM/服务器连接：NO
- 打包、部署、服务重启：NO
- Git commit：NO
