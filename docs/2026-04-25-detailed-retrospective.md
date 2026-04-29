# 2026-04-25 详细修改总结与复盘（深度版）

## 0. 复盘说明

- 复盘日期：2026-04-25
- 复盘对象：NAPM Skill 决策链路（OpenClaw -> Skill -> Gateway）
- 复盘性质：以“链路核查 + 机制澄清 + 文档沉淀”为主，本次未改动主执行逻辑代码。
- 复盘目的：让后续联调和排障不再混淆 `direct_execute`、`decision_source`、`confidence` 三套语义。

## 1. 今日问题与目标

今天围绕四个问题做了逐层排查：

1. `direct_execute` 是谁决定的，哪里构建。
2. `payload.decision` 是谁传入，经过什么校验。
3. `SKILL.md` 为什么没有打分机制说明。
4. OpenClaw 侧 `confidence` 到底如何计算。

目标不是“再解释一遍概念”，而是把“代码证据 -> 行为结论 -> 风险影响 -> 下一步动作”落成可复盘文档。

## 2. 当前仓库行为（关键结论先看）

> 这一节是“今天这版代码”的事实结论。

1. 当前 `run_napm_query.js` 已是“上游 decision-only”模式：
   - 没有通过合同校验的上游 `decision`，就直接阻断；
   - 不再在执行器里走本地判定 fallback。
2. `direct_execute` 不是“模型参与证明”，而是执行态标签。
3. `decision` 合同校验入口是 `validateDecisionContract`，核心硬门槛是 `next_action` 合法性。
4. 当前置信度是规则分（rule-based），不是在线大模型直接打分。
5. `SKILL.md` 目前是流程/契约说明，不含评分公式，因此造成“分数来源不可见”。

## 3. 证据链（逐点对应）

### 3.1 Skill 执行器如何处理 decision

文件：`skills/openclaw-napm-query/scripts/run_napm_query.js`

关键证据：

- 决策透传输入：
  - `rawDecisionOverride = parseJsonArg('--decision', args.decision) || payload.decision || null`
  - 位置：`run_napm_query.js:756`
- 合同校验：
  - `validatedDecisionOverride = validateDecisionContract(rawDecisionOverride, sessionState)`
  - 位置：`run_napm_query.js:757`
- 无合法 decision 直接阻断：
  - 构造 `decision_source: 'model_decision_required'`
  - 位置：`run_napm_query.js:762`、`run_napm_query.js:787`
- 桥接优先执行条件：
  - `if (!disableGatewayBridge && !understandingOnly && enableGatewaySkillBridge)`
  - 位置：`run_napm_query.js:716`

结论：

- 当前执行器本身不再承担“本地主判”；它主要消费上游 `decision`。
- 如果你看到“未传 decision”阻断，这是当前分支的预期行为。

### 3.2 决策合同怎么校验

文件：`skills/openclaw-napm-query/scripts/decision-layer.js`

关键证据：

- 校验入口：`validateDecisionContract`
  - 位置：`decision-layer.js:161`
- 枚举白名单：`allowedNextActions`
  - 位置：`decision-layer.js:4`
- `next_action` 非法直接不通过：
  - 位置：`decision-layer.js:183`
- 安全收口（不支持动作族）：
  - 位置：`decision-layer.js:34`、`decision-layer.js:187`
- 一致性纠偏：
  - `GO_DIRECT_QUERY + NEED_CLARIFICATION -> ASK_CLARIFYING_QUESTION`
  - 位置：`decision-layer.js:214`
  - `GO_DIRECT/GO_OVERVIEW + UNMAPPABLE -> REJECT_AND_REDIRECT`
  - 位置：`decision-layer.js:218`
- 通过后来源标记：`decision_source: 'openclaw_model'`
  - 位置：`decision-layer.js:247`

结论：

- 这是“合同校验 + 安全纠偏”机制，不是简单字段校验。
- 只有通过合同的上游 decision 才会被当作 `openclaw_model`。

### 3.3 Gateway 为何大量出现 direct_execute

文件：`旧 gatewayRoutes 路由文件（现已移除）`

关键证据：

- query-only 相关默认开关：
  - `GATEWAY_ENFORCE_UPSTREAM_EXECUTION`
  - `GATEWAY_QUERY_ONLY_MODE`
  - 位置：`gatewayRoutes.js:52`、`gatewayRoutes.js:58`
- query-only 判定入口：
  - `shouldRunGatewayQueryOnly`
  - 位置：`gatewayRoutes.js:131`
- query-only 合同解析：
  - `resolveQueryOnlyExecutionContract`
  - 位置：`gatewayRoutes.js:3806`
- query-only 合同中构建执行态：
  - `assistantDecision.mode = 'direct_execute'`
  - 位置：`gatewayRoutes.js:3846`

结论：

- 该 `direct_execute` 是“可执行 contract 形态”，不是“模型完成理解”的充分条件。

### 3.4 OpenClaw 侧打分在何处计算

文件：`历史 OpenClawNapmAssistantService（现已移除）`

关键证据：

- 语义理解构建入口：
  - `buildSemanticUnderstanding(...)`
  - 位置：`OpenClawNapmAssistantService.js:817`
- 打分函数：
  - `computeUnderstandingConfidence(...)`
  - 位置：`OpenClawNapmAssistantService.js:6846`
- 评分结果输出到：
  - `confidence / confidenceBand / confidenceReason`
- 策略动作封装：
  - `buildPolicyEnvelopeFromUnderstanding(...)`
  - 位置：`OpenClawNapmAssistantService.js:7044`

结论：

- 当前是规则评分链路，不是模型直接给分。

### 3.5 Normalizer 与 AI scorer 状态

- `历史 SemanticNormalizerService（现已移除）` 当前注释明确：确定性归一化，不依赖 AI scorer 主链。
- `历史 AiSemanticScoringService（现已移除）` 存在，但未在主链路中发现接入调用。

## 4. 当前行为 vs 历史日志差异（避免复盘误判）

### 4.1 当前分支（今天核查）

- Skill 执行器：上游决策强依赖，不合法就阻断。
- 本地 fallback：执行器中已关闭。

### 4.2 历史日志中出现 `skill_fallback_rules` 的可能来源

- 远端仍在跑旧脚本版本。
- 测试路径走的是旧入口或未同步分支。
- 不是当前本地仓库这版 `run_napm_query.js` 的行为。

结论：

- 复盘时必须区分“本地当前代码行为”和“历史现网日志行为”，不能混用结论。

## 5. decision 合同（复盘用字段清单）

### 5.1 关键字段

- `next_action`：执行动作（硬门槛）。
- `task_type`：任务类型。
- `information_sufficiency`：信息充分度。
- `in_scope`：是否在边界内。
- `need_clarification` + `clarifying_question`：澄清控制。
- `action_family`：安全动作族。

### 5.2 失败/拦截典型场景

1. `next_action` 非法 -> 合同失败。
2. 请求动作族命中不支持类别 -> 强制拒绝。
3. `ASK_CLARIFYING_QUESTION` 但无 `clarifying_question` -> 合同失败。
4. 动作与充分度冲突 -> 自动纠偏。

## 6. 置信度规则拆解（便于后续做阈值调优）

### 6.1 计算流程

1. 根据 `semanticGoal` 设基础分。
2. 根据 `problem/scope/object/time` 等信号加分。
3. 根据 `ranking/trend/compare/diagnose` 结构化命中加分。
4. 语义未知且无结构化信号时减分。
5. 裁剪到 `[0.1, 0.99]`。
6. 按阈值映射 `high/medium/low`。

### 6.2 阈值来源

文件：`config/openclaw-napm-assistant.v1.json`

- `semanticUnderstanding.confidenceHints.highThreshold`
- `semanticUnderstanding.confidenceHints.mediumThreshold`

## 7. 今日产出

### 7.1 文档产出

- 新增：`docs/2026-04-25-detailed-retrospective.md`（本文件）

### 7.2 机制澄清产出

- 澄清了 `direct_execute` 的语义边界。
- 澄清了 decision 校验与执行器阻断逻辑。
- 澄清了打分属于规则评分而非模型在线评分。
- 澄清了“当前代码行为”和“历史日志表现”存在版本差异。

### 7.3 代码改动

- 本次未改动主链路业务代码。
- 仅新增/更新复盘文档。

## 8. 当前风险与影响

1. 团队容易把 `direct_execute` 误读为“模型已完成理解”。
2. 若上游不稳定透传 `payload.decision`，当前分支会持续阻断执行。
3. `SKILL.md` 缺评分机制说明，导致协作理解成本高。
4. `OpenClawNapmAssistantService.js` 存在重复定义段（历史遗留），维护复杂度高。

## 9. 建议动作（落地优先级）

### P0（必须先做）

1. 在上游 OpenClaw 提示词和插件层强制：先产出结构化 `decision`，再调用 skill。
2. 在请求/响应日志中增加统一字段：
   - `decision_origin = upstream_model | gateway_query_only | gateway_prebuilt | blocked_no_decision`

### P1（本周完成）

1. 更新 `SKILL.md`：增加“合同字段 + 打分机制 + 常见误区”章节。
2. 增加联调回归集，覆盖：
   - 合同通过
   - 合同失败
   - query-only 合同
   - understanding-only 展示路径

### P2（结构优化）

1. 清理 `OpenClawNapmAssistantService.js` 重复定义段，保留单一生效实现。
2. 将 `confidenceReason` 拆分为“结构化原因码 + 面向用户文案”。

## 10. 回归用例清单（复盘后可直接执行）

1. 不传 `decision`，验证 `decision_source=model_decision_required`。
2. 传合法 `decision`，验证 `decision_source=openclaw_model`。
3. 传非法 `next_action`，验证合同失败并阻断。
4. `GO_DIRECT_QUERY + NEED_CLARIFICATION`，验证自动纠偏。
5. `GO_OVERVIEW_QUERY + UNMAPPABLE`，验证自动纠偏。
6. query-only 下传 `mode!=direct_execute`，验证网关拒绝。
7. query-only 合同通过，验证网关构建 `mode=direct_execute`。
8. 同一问句对比“有 decision / 无 decision”两条链路输出差异。

## 11. 复盘结语

今天最核心的价值是“拆清责任边界”：

- 执行态是谁定义的（`direct_execute`）
- 决策是谁给的（上游 `decision`）
- 入口在什么条件下会阻断
- 置信度由哪里计算

这套结论会直接影响后续联调策略：先保证上游稳定传 `decision`，再谈查询准确率收口与表达优化。
