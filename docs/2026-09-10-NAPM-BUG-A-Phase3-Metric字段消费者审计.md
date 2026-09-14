# NAPM BUG-A Phase 3：`metric / metrics[] / topMetric` 消费者审计

日期：2026-09-10  
审计范围：`skills/openclaw-napm-query`、`napm-openclaw-plugin.remote.js`  
目的：在 Phase 3 修改前区分 canonical Contract 迁移、legacy 边界、后续 Kernel/Serializer 和非执行展示用途。

## 1. 结论

执行事实最终固定为：

```text
metrics[]  = 要求 NAPM 返回的指标集合
topMetric = 仅 topValues 使用的独立排序指标
metric    = deprecated legacy input，不是 canonical/NAPM API 字段
```

Canonical Query 使用 `schemaVersion=napm-resolved-query.v1`。`topMetric` 不要求属于 `metrics[]`，也不得从 `metrics[0]` 猜测。`queryModeKey` 由 service 派生，只用于一致性校验。

## 2. 消费者分类

| 文件/函数 | 修改前读取或写入 | 当前职责 | Phase 3 处理 |
|---|---|---|---|
| `NapmResolvedQueryResolverService` | 输出 `metric/metrics/topMetric` | Semantic → Query assembly | 本轮迁移：只输出 schema、`metrics[]` 和必要的 `topMetric`；增加 average/time 映射 |
| `ResolvedQueryContract` | 不存在 | canonical shape 唯一来源 | 本轮新增：service required/optional/forbidden、schema、queryMode 派生、shape normalization |
| `LegacyMetricInputAdapter` | 不存在 | legacy `metric` 迁移 | 本轮新增：只在实际含 `metric` 的 legacy boundary 调用；成功删除 `metric` 并重验 |
| Plugin `normalizeResolvedQueryForPlugin` | 三字段互相补齐 | Tool 输入机械归一化 | 本轮迁移：不再补 `metric`、不从 `metrics[0]` 补 `topMetric`，canonical service 统一附加/验证 schema |
| Plugin `validateResolvedQueryAgainstSpec` | 依赖 Resolution Spec required，并强制 `topMetric ∈ metrics[]` | Hook/execute shape boundary | 本轮迁移：canonical service 调共享 Contract；删除包含关系；对象参数/时间新鲜度等既有策略保留 |
| Plugin `prepareSkillExecutionArgs` | 无独立 legacy 边界 | Hook/execute 参数准备 | 本轮迁移：实际出现 `metric` 时 Adapter 一次；Hook 改写后 execute 不再重复适配 |
| `QueryValidator` | `topValues` 要求单数 `metric` | Kernel 前 shape validation | 本轮迁移：canonical service 只调用共享 Contract，不再维护字段表 |
| `QueryMetadataConstraintService` | `metrics[0] → metric`，同步三字段 | 旧静态/动态约束 | 本轮收口：不生成 canonical `metric`；兼容性观察按 `topMetric` 或 `metrics[]` 读取；Phase 4 hard gate 未接 |
| `RequirementParserService` | normalize/build CSV/回退/模板多处读写 `metric` | Skill 执行准备与 Kernel 分派 | 本轮迁移：明确 legacy 输入边界；canonical validation 在 metadata 前；真实执行 Query 不再携带 `metric` |
| `run_napm_query.js` | discovery/session 续接回写 `metric`，TopN 默认互补 | Skill 输入、续接和复合流程 | 本轮迁移：不再写 canonical `metric`，不从 `metrics[0]` 猜 `topMetric` |
| `OverviewPlanCompiler` | child query 同时写 `metric/metrics/topMetric` | Overview 真实子查询编译 | 本轮迁移：child query canonical 化；旧 Candidate `metric` 在配置边界经 Adapter 转换 |
| `NapmMetadataService.reviewQuery` | 只检查 `query.metric` | 既有 runtime metadata review | 本轮字段适配：读取 `topMetric` 或 `metrics[0]`；未改变调用顺序或实现 Phase 5 capability orchestration |
| `OpenClawNarrationContractService` | 展示层优先读 `resolvedQuery.metric` | Query 结果叙述 | 本轮字段适配：返回指标读 `metrics[0]`，排序指标独立读 `topMetric` |
| `ReportDataContractService` | 报告指标集合包含 `metric` | 报告数据投影 | 本轮字段适配：只收集 `metrics[]` 和 `topMetric` |
| `MetricExecutionKernel` | `topMetric || metric` | HTTP 参数组装 | 后续 Kernel 阶段物理删除 fallback；本轮通过入口/Validator 保证 canonical path 总有 `topMetric`，不依赖 fallback |
| Plugin 历史审计读取 | 读取 audit 里的 `request.metric` | 兼容旧审计日志 | 保留；不是 canonical Query 构造或执行事实来源 |
| Resolution Spec / Overview Candidate Registry | 仍有 legacy 模板字段 | 历史模板配置与 service 目录 | 不作为 canonical shape 真源；真实 child query 编译时统一转换。Metadata overload 本轮不拆 |
| `QueryDecisionPolicy` | 不依赖单数 `metric` | 执行准入 | 本轮不修改；Object × Metric hard gate 留给 Phase 4 |

## 3. 边界调用次数

```text
Semantic Contract → Resolver → canonical Query
LegacyMetricInputAdapter calls = 0

legacy external Query（含 metric）
→ Plugin 或 Skill 输入边界 Adapter = 1
→ prepare/direct 看到已删除 metric，不再调用

Overview legacy Candidate（含 metric）
→ Candidate 编译边界 Adapter = 1
→ RequirementParser 不再调用
```

## 4. 明确保留到后续阶段

- `MetricExecutionKernel` 的 `topMetric || metric` 物理 fallback：后续 Kernel/Serializer 阶段。
- `WebApplication + TRTI` 等 Object × Metric 兼容性 hard gate：Phase 4。
- UNKNOWN runtime capability 与 `metricsForGroup` 编排：Phase 5。
- Metadata overloaded service 拆分：后续 Metadata 阶段。
- Error Contract、NO_DATA 分类：后续错误阶段。

本审计没有授权或实施以上后续工作。

