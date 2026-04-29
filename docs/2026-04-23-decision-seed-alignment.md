# 2026-04-23 判定语义种子对齐修复记录

## 背景问题

在 `understanding-only` / fallback 执行链中，前置 `decision-layer` 可能已经识别出：

- `recognized_subject_hint = IPConversation`

但后续 `parseToGatewayRequest` 仍会仅按原始问句重跑一轮映射，导致最终 `groups` 又回到 `IPAddress`，出现“前后判定不一致”。

## 本次修复

### 1) 将 decision/intent 透传到解析层

文件：`skills/openclaw-napm-query/scripts/run_napm_query.js`

- 新增 `buildRequirementParserContext(payload, decision, intent)`：
  - 透传 `decision`、`intent`
  - 透传 `semanticSeedHints`（`recognized_subject_hint` / `intent.subject_hint` / `intent.constraints.object_scope_type`）
- `resolveResolvedQuery(...)` 新增 `requestContext` 参数
- 调用 `RequirementParserService.parseToGatewayRequest(...)` 时传入该上下文

### 2) 解析层接入“请求上下文语义种子”

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

- `mapNaturalLanguage(...)` 与 `mapNaturalLanguageWithDisambiguation(...)` 新增 `requestContext` 入参
- 在 mapper 结果后新增 `applyRequestContextSemanticSeed(...)`：
  - 从 `decision/intent/semanticSeedHints` 提取目标对象类型
  - 以高置信候选（`score=0.99`）注入 `objectCandidates`
  - 回灌到：
    - `resolvedQuery.semanticConstraints`
    - `resolvedQuery.candidateSpec.semantic_constraints`
    - `resolvedQuery.candidateSpec.candidate_inputs.object_candidates`
    - `resolutionHints.group.type`
  - 触发 `alignGroupsWithSemanticTarget(...)`，保证最终 `groups` 与目标对象一致

## 同步修复（本轮同时完成）

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

- 将 `buildUpstreamPathGuard(...)` 从“硬编码路径分支”改为“通用路径守卫”：
  - 不再写死 `ClientIPs/PageFamilies`
  - 按真实请求 `groups` 生成 path 文案
  - 从 `pathResolve/pathPlanning/executionBinding/stableTemplate` 收集 `candidatePaths`
- 错误详情中回传 `candidatePaths`，便于回放定位

### 3) decision-layer 主体识别去噪（避免 Top10 误入 subject）

文件：`skills/openclaw-napm-query/scripts/decision-layer.js`

- 新增 `IPConversation` 对象范围匹配（`IP会话/session`）并提升优先级
- 新增 `isInvalidSubjectToken(...)`，过滤：
  - `Top10/Top5/...`
  - 纯数字、`N/A`、`null` 等噪声 token
  - `HTTP/IP/TCP/UDP/JSON` 这类泛词
- 修正 `extractExplicitSubject(...)`，不再把 `Top10` 当作主体

效果：`HTTP 的 IP 会话吞吐量 Top10 是哪些？` 现在可稳定得到  
`recognized_subject_hint = IPConversation`（而不是 `Top10`）

## 测试

- `__tests__/semantic-target-alignment.test.js`
  - 新增：`request context decision hint should seed target object before post-process`
- `__tests__/upstream-path-guard.test.js`
  - 覆盖通用路径守卫构造与忽略场景
- `__tests__/decision-layer-subject-hint.test.js`
  - 覆盖 `IP会话` 优先于 `Top10` 的主体识别规则

执行结果：

- `semantic-target-alignment.test.js` 通过
- `metadata-driven-resolution.test.js` 通过
- `ranking-target-priority.test.js` 通过
- `upstream-path-guard.test.js` 通过

## 预期收益

- 前置判定与后置请求构建保持一致，减少“识别是 IPConversation、执行却是 IPAddress”。
- 上游路径拒绝提示更可解释，排障信息由“写死分支”升级为“真实路径 + 候选路径”。
