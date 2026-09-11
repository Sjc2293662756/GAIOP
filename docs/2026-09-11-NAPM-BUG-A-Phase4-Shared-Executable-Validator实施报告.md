# NAPM BUG-A Phase 4：Shared Executable Validator 与静态硬门禁实施报告

## 1. 目标

Phase 4 把“查询能不能真正执行”从分散的 Gateway、Direct、Plugin 判断收口为一个共享执行校验器。校验器只处理已经进入 napm-resolved-query.v1 的结构化查询，不重新解释用户语义。

本阶段不连接服务器、不部署、不打包、不修改版本号，也不把运行时元数据探测当成静态兼容性的替代品。

## 2. 实际执行链

流程：Canonical Resolved Query → ResolvedQueryContract shape → Metric Catalog existence → Object × Metric ownership → Gateway/Direct/Plugin static gate → Metadata / Query Skill / Southbound。

- shape、未知指标或已知不兼容：VALIDATION_FAILURE，零 Skill 和南向调用。
- ownership 证据不足：RUNTIME_CAPABILITY_REQUIRED，零南向调用。
- 只有 KNOWN_COMPATIBLE 才能进入后续动态 metadata 和执行链。

同一校验器由以下入口共同使用：

- RequirementParserService.prepareGatewayExecution：在动态 metadata、Kernel 和 NapmClient 之前校验。
- RequirementParserService.executeDirectGatewayRequest：外部直调不能绕过校验；内部 prepared proof 只允许由同一实例的准备阶段消费一次。
- Plugin Query Tool construction/execution gate：在恢复 pending、物化时间和调用 Query Skill 前执行共享 Query Decision Policy 与 canonical 校验。

## 3. 校验规则

### 3.1 指标存在性优先

MetricMappingService.isValidMetricCode 先检查 Metric Catalog。不存在的 ID 返回 METRIC_UNKNOWN，不会进入 ownership 分类。

### 3.2 Object × Metric 三态

classifyObjectMetricCompatibility 返回：

- KNOWN_COMPATIBLE：已核验产品基线下明确允许；
- KNOWN_INCOMPATIBLE：明确不允许，返回 OBJECT_METRIC_INCOMPATIBLE；
- UNKNOWN：没有可信产品基线或路径覆盖不完整，返回 RUNTIME_CAPABILITY_REQUIRED，必须在执行前停止。

当前精确覆盖为 topValues、averageValues、timeValues 与 WebApplication、IPAddress、TotalTraffic、DefinedApp 的单层路径。WebApplication > PageFamily 仍是非 exhaustive 覆盖，不能被静态校验器猜测为可执行。

### 3.3 参数契约仍由 canonical Contract 负责

metrics[] 是返回指标，topMetric 只表示 TopN 排序指标。pageViews 独立走 detail contract，不参与指标 ownership 判断。旧 metric 只允许在 legacy boundary 适配一次并删除。

## 4. 回归与运行时契约

新增或补齐：

- test/bug-a-phase4-executable-validator.test.js
- test/bug-a-phase4-static-gate.test.js
- test/bug-a-phase4-plugin-static-gate.test.js
- test/bug-a-phase4-runtime-contract.test.js

覆盖内容：

- 已知不兼容指标在 metadata、Kernel、NapmClient 之前失败；
- 未知指标在 Metric Catalog 阶段失败；
- 无可信产品基线的兼容候选返回 RUNTIME_CAPABILITY_REQUIRED；
- Gateway 和 Direct 入口均执行共享静态门禁；
- Plugin 入口的高风险查询在 Query Skill 前被阻断；
- ownership 覆盖、唯一 Validator 入口、未知能力确定性阻断纳入 verify:runtime-contract。

## 5. 遗留边界

1. UNKNOWN 只表示本地静态证据不足，不等于上游一定不支持；本阶段选择 fail closed。
2. 多级 WebApplication > PageFamily 仍要求后续可信下钻授权和运行时能力确认。
3. 动态 metadata 的对象存在性和参数合法性仍属于后续执行阶段；它不能绕过 Phase 4 静态门禁。

## 6. 验证状态

本报告对应修改完成后必须运行：

    npm test -- --runInBand
    npm run lint
    npm run verify:runtime-contract
    git diff --check

本阶段不执行发布包构建、远端连接、部署或服务重启。
