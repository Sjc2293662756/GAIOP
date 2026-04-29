# 2026-04-23 元数据驱动解析链改造记录

## 目标

将“基于语义模板直接猜 groupType”的路径，收口为“候选语义 -> 元数据校验 -> 唯一执行 spec”的解析链，避免出现“吞吐量 + top10 + IP 就默认 IPAddress”的误判。

## 本次落地内容

### 1) 判定层改为候选集，不再一步锁死

文件：`skills/openclaw-napm-query/services/NaturalLanguageQueryMapper.js`

- 在 `map()` 主流程中统一透传：
  - `intent`
  - `objectCandidates`
  - `metricCandidates`
  - `scopeHints`
- `resolveObjectCandidates()` 增强为候选集评分：
  - 显式对象优先（如 `IP会话`、`客户端IP`、`服务端IP`、`业务组`、`业务系统`、`应用`）
  - `IP会话` 出现时对 `IPAddress` 降分，避免“IP字样误导”
  - 新增 `extractNamedBusinessAnchor()`：识别“X 的 ...”中的业务锚点（如 `HIS`），并回灌到业务对象候选（BusinessGroup/WebApplication/Application/DefinedApp）
- `resolveSemanticConstraints()` 与 `buildResolvedQuery()` 输出保留候选与约束，供后续元数据链路使用。

### 2) 路径选择改为元数据树主导

文件：`历史 GroupPathPlannerService（现已移除，相关能力已并入 skill 直查链）`

- 路径规划入口 `plan()` 优先读取 `objectCandidates/scopeHints`
- `pickTargetGroup()` 使用 `selectTargetGroupFromObjectCandidates()` 优先显式对象
- 候选路径构建 `buildCandidate()` 引入元数据节点打分：
  - `exists`
  - `hasArgument`
  - `canQuery`
- 仅对元数据合法路径进行高分选择；并保留 `pathMeta` 证据用于解释。

### 3) 模板绑定后置 + 对象一致性守卫

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

- 在主链路中将模板绑定放到 metadata constrain 之后
- 新增并接入 `applyMetadataDrivenFinalization()`：
  - 回灌 `pathPlan.plannedGroups`
  - 使用 `groupArguments + scopeHints` 补参数
  - 使用 `metricsForGroup` 做 metric 支持性校验与替换
- 保留 `enforceTemplateTargetConsistency()`：
  - 若模板目标对象与最终对象不一致，则清除模板绑定，避免冲突执行。

### 4) CandidateSpec 输出增强

文件：`skills/openclaw-napm-query/services/CandidateSpecBuilder.js`

- `candidate_inputs` 新增：
  - `intent`
  - `metric_candidates`
  - `scope_hints`
  - `object_candidates`

## 乱码与稳定性修复

本次同步修复了关键链路中的历史编码损坏问题（坏正则、坏引号、注释吞代码），确保：

- `NaturalLanguageQueryMapper.js` 可正常加载与执行
- `GroupPathPlannerService.js` 路径评分代码真实生效
- `RequirementParserService.js` 元数据后处理链路可正常执行

## 回归测试

新增文件：`__tests__/metadata-driven-resolution.test.js`

覆盖 3 个核心用例：

1. `HTTP 的 IP 会话吞吐量 Top10 是哪些？`
   - `IPConversation` 候选分高于 `IPAddress`
   - `HTTP` 作为 `scopeHints`
   - 最终 `targetObjectType` 不落回 `IPAddress`

2. `昨天 HIS 的 HTTP500 Top10 是哪些？`
   - `HIS` 被识别为业务对象锚点候选
   - `HTTP500` 识别为指标候选
   - 时间范围识别为昨天

3. `看 HTTP 的客户端IP吞吐量 Top10`
   - 候选优先 `IPAddress`
   - 不误判为 `IPConversation`
   - `HTTP` 保持为约束提示

执行命令：

```bash
npm test -- metadata-driven-resolution.test.js
```

结果：3/3 通过。
