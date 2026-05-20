# 2026-05-11 NAPM 可复用 Skill 底座收敛重构建议

## 1. 文档目标

这份文档不是泛泛而谈的架构建议，而是针对当前仓库 `NAPM_Semantic_Gateway` 的实际现状，给出一份可执行、可验收、可分阶段推进的重构建议。

目标不是把它改造成“通用大模型平台”，而是把它收敛成：

**一个在 NAPM / NetInside 领域内可复用的 Skill Runtime 底座。**

也就是说，后续无论入口是：

- 企业微信
- OpenClaw 主链
- 本地调试脚本
- 将来的 Web/API 入口

都应该尽量共用同一套：

- NAPM 领域语义规则
- 查询结构模型
- 执行保护
- API 调用能力
- 结构化结果输出契约

---

## 2. 当前结论

截至 2026-05-11，项目的整体方向是对的，但分层还不够纯，导致“看起来哪里都在管一点”。

当前真实运行链路已经基本确定为：

1. 企业微信插件接入消息
2. OpenClaw 主链负责：
   - 领域边界判断
   - 追问判断
   - 澄清判断
   - `resolvedQuery` 构造
   - 最终中文叙述
3. NAPM skill 执行器负责：
   - 消费结构化 `resolvedQuery`
   - 查询 NAPM / NetInside
   - 输出结构化结果
4. OpenClaw 将 skill 返回结果组织成最终回复

当前远端真实运行方式：

- 真实服务：`openclaw-gateway.service`
- 真实执行器：`/home/netinside/.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js`
- 真实挂载方式：环境变量 `NAPM_SKILL_EXECUTOR`

这说明：

**本项目当前最适合的收敛方向，不是“恢复成独立 gateway 服务”，而是“强化 skill 作为领域执行内核”的定位。**

---

## 3. 这次重构要解决什么问题

当前混乱感主要来自以下四类问题。

### 3.1 职责边界虽有文档，但实现未完全收干净

文档中已经明确：

- OpenClaw 负责自然语言理解和 `resolvedQuery`
- skill 负责执行
- 企业微信插件退化为传输层

但代码和远端运行包里仍残留：

- 企业微信插件历史直连 skill 的逻辑痕迹
- skill 内部的部分 prompt shortcut / fallback 逻辑
- `RequirementParserService` 中大量“执行 + 语义 + 结构整理”耦合逻辑

结果就是：

- OpenClaw 像大脑
- skill 又保留了半个领域判断层
- 企微插件历史上也做过抢答和前置判断

这会让维护者长期怀疑“真正主判到底在谁那里”。

### 3.2 Skill 已经具备复用价值，但定位还不够单一

当前 skill 并不是没价值，恰恰相反，它已经沉淀了最值钱的 NAPM 领域资产：

- 对象类型映射
- 指标语义映射
- group path 规划
- 时间范围归一
- overview 聚合执行
- NAPM API 访问
- narration contract 输出

但现在 skill 的对外定位还不够纯：

- 像执行器
- 又像半个解析器
- 又像半个运行时编排器

这种“能干很多事”短期很方便，长期会削弱复用性和可维护性。

### 3.3 命名和历史实现残留，持续制造认知噪音

典型例子：

- `RequirementParserService`
- `executeGatewayRequest`
- `gatewayRequest`
- `Gateway stable templates`

这些名字会不断把团队认知拉回“旧网关时代”，哪怕当前真实运行方式已经不是旧网关。

### 3.4 本地仓库与远端真实 skill 目录漂移

当前已确认：

- 本地仓库 skill 子树
- `/opt/NAPM_Semantic_Gateway`
- `~/.openclaw/skills/openclaw-napm-query`

并不是严格同构。

这会放大一切架构问题，因为维护者很难立刻确认：

- 当前看到的代码是不是线上实际运行代码
- 当前观察到的问题出在源码、远端 skill，还是插件层

---

## 4. 这次重构的总体方向

建议把项目明确收敛成三层：

### 4.1 入口层

代表：

- 企业微信插件
- 其他消息入口

职责：

- 接消息
- 传上下文
- 调 OpenClaw
- 回消息
- 做少量硬安全拦截

不负责：

- NAPM 领域判断
- `resolvedQuery` 主构造
- 本地语义抢答
- NAPM 查询参数组装

### 4.2 会话与主判层

代表：

- OpenClaw 主链

职责：

- 判断是否属于 NAPM
- 是否追问
- 是否需要澄清
- 是否拒答/引导
- 构造结构化 `resolvedQuery`
- 最终自然语言回复

不负责：

- NAPM 具体 API 执行细节
- 细粒度对象/指标运行时校验

### 4.3 领域执行层

代表：

- `skills/openclaw-napm-query/`

职责：

- 消费 `resolvedQuery`
- 做执行前验证与最小补全
- 处理 NAPM 领域规则
- 调用 NAPM API
- 输出结构化结果和 narration contract

不负责：

- 领域边界判断
- 泛问答拒答
- 主会话承接
- 最终对用户的自然语言策略

---

## 5. 当前仓库里哪些部分应该被保留

这次重构不是推倒重来。下面这些能力应该被视为 NAPM 底座资产，优先保留并围绕它们收敛。

### 5.1 保留 `run_napm_query.js` 作为单一执行入口

文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`

理由：

- 它已经是 OpenClaw 当前真实挂载的 skill 执行器入口
- 远端运行配置也是围绕它建立的
- 后续最适合把它收敛成“薄入口 + 明确 orchestration”

但不建议继续把更多领域规则和历史兼容逻辑堆到这个文件里。

### 5.2 保留 `RequirementParserService` 中真正属于领域执行的部分

文件：

- `skills/openclaw-napm-query/services/RequirementParserService.js`

应保留的核心能力：

- 结构化 query 到 NAPM 请求的最终转换
- NAPM 请求执行
- 上游路径/对象/指标合法性保护
- 返回结果解析
- 执行级补救与 metadata 驱动修正

不建议长期继续把它当成“既管解析、又管语义、又管执行、又管摘要”的超级类。

### 5.3 保留领域映射和 metadata 相关服务

包括：

- `MetricMappingService`
- `DimensionMappingService`
- `NapmMetadataService`
- `GroupPathPlannerService`
- `QueryMetadataConstraintService`
- `OpenClawNarrationContractService`
- `overview-module.js` 及 Overview 相关脚本

这些是 NAPM 领域内最强的复用资产。

---

## 6. 当前仓库里哪些部分应该继续收敛或拆分

### 6.1 收敛 `run_napm_query.js` 中的“轻理解型逻辑”

当前文件中仍包含以下非纯执行职责：

- `isSensitiveCredentialPrompt`
- `buildHierarchyCatalogPayload`
- prompt-based hierarchy catalog shortcut
- 缺少 `resolvedQuery` 时的决策性 fallback
- 会话续接补入 `session`
- 一些 prompt 级别特判

这里要分两类看：

#### 可以保留的

- 缺少 `resolvedQuery` 时，返回结构化错误契约
- 安全红线拦截
- 结构化会话上下文的最小续接

理由：

- 这些更像运行时 guardrail
- 不属于“重新理解用户自然语言”

#### 应逐步弱化的

- 直接基于 prompt 做新的 query 构造捷径
- 继续扩展各类 prompt shortcut
- 继续在 skill 层积累“会话判断式”逻辑

理由：

- 这会重新把 skill 拉回“半 agent”状态
- 会削弱 OpenClaw 作为唯一主判的清晰度

### 6.2 拆解 `RequirementParserService`

当前它过于庞大，长期应至少拆成下面几类能力：

1. `NapmExecutionService`
   - 真正负责执行请求
   - 包括请求构造、调用、响应解析

2. `NapmQueryFinalizeService`
   - 负责在 `resolvedQuery` 基础上做执行前 finalization
   - 如 metadata 驱动路径修正、metric 支持校验等

3. `NapmQuerySummaryService`
   - 负责 `intentResult`、`semanticResolutionResult`、调试摘要等生成

4. `NapmExecutionGuardService`
   - 负责执行阻断、clarification gate、路径保护等

不要求一次性拆完，但至少要先把“职责边界”在代码层显式化。

### 6.3 清理历史命名

建议逐步把以下命名替换为更符合当前架构的表达：

- `gatewayRequest` -> `runtimeQuery` 或 `executionQuery`
- `executeGatewayRequest` -> `executeNapmQuery`
- `RequirementParserService` -> 可逐步过渡为 `NapmRuntimeService` 或拆分后更细的服务名

注意：

- 这类重命名不能一次全量硬改
- 要配合测试和调用链一起做

但这一步非常值得做，因为它会显著降低团队认知噪音。

---

## 7. 推荐的目标形态

建议将 `skills/openclaw-napm-query/` 最终收敛为下面这种结构。

### 7.1 目标职责结构

- `scripts/run_napm_query.js`
  - 只负责读取输入、调用 runtime、输出 contract

- `services/runtime/`
  - `NapmRuntimeOrchestrator.js`
  - `NapmExecutionService.js`
  - `NapmExecutionGuardService.js`
  - `NapmQueryFinalizeService.js`
  - `NapmQuerySummaryService.js`

- `services/domain/`
  - `MetricMappingService.js`
  - `DimensionMappingService.js`
  - `GroupPathPlannerService.js`
  - `QueryMetadataConstraintService.js`

- `services/infrastructure/`
  - `NapmClient.js`
  - `NapmMetadataService.js`

- `services/output/`
  - `OpenClawNarrationContractService.js`

- `scripts/overview-*`
  - 保留为 overview 专项执行模块

### 7.2 目标输入输出契约

输入：

```json
{
  "resolvedQuery": {},
  "session": {},
  "decision": {},
  "intent": {}
}
```

输出：

```json
{
  "ok": true,
  "resolvedQuery": {},
  "summary": {},
  "data": [],
  "rows": [],
  "structuredRows": [],
  "narrationInput": {},
  "error": null
}
```

注意：

- 标准路径必须要求 `resolvedQuery`
- 可以允许 skill 做“执行前必要补全”
- 但不能恢复为“从裸 prompt 自己推完整 query”

---

## 8. 分阶段重构建议

不要一口气大改。建议分四个阶段。

## 第 0 阶段：先冻结边界，不再继续扩散

目标：

- 不再新增新的多头主判逻辑
- 不再继续往 skill 里塞新的自然语言主判规则
- 不再让企微插件恢复本地 NAPM 判断

这阶段的要求：

1. 新需求若涉及：
   - 领域边界
   - 追问承接
   - 澄清策略
   - 拒答与引导
   统一优先落在 OpenClaw 主链，不落在企微插件和 skill。

2. skill 内新增逻辑，必须自问一句：
   - 这是“执行保护”，还是“重新理解用户”？

若是后者，原则上不进 skill。

验收标准：

- 近期新增代码中，不再出现新的 prompt-to-query 主判捷径
- 企微插件不新增任何本地 NAPM 语义判断

---

## 第 1 阶段：把 `run_napm_query.js` 收成薄入口

目标：

- 保留当前对外兼容
- 但把内部 orchestration 拆清楚

建议动作：

1. 在 `services/` 下新增一个中间层，例如：
   - `NapmRuntimeOrchestrator.js`

2. 把 `run_napm_query.js` 中以下逻辑迁出：
   - 输入解析与 payload 规范化
   - 缺少 `resolvedQuery` 的标准错误契约
   - 概览执行分流
   - 结构化输出组装

3. `run_napm_query.js` 最终保留：
   - 读参数
   - 调 orchestrator
   - 输出 JSON

建议影响文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- 新增 `skills/openclaw-napm-query/services/NapmRuntimeOrchestrator.js`

验收标准：

- `run_napm_query.js` 明显变短
- 主流程更像“入口文件”，而不是“大杂烩脚本”
- 对外输入输出不变

---

## 第 2 阶段：拆 `RequirementParserService`

目标：

- 从“万能类”改为“几个明确的小服务”

建议拆分顺序：

### 2.1 先抽执行层

从 `RequirementParserService` 中抽出：

- 真正对 NAPM 发请求的逻辑
- 请求参数装配
- 响应解析

形成：

- `NapmExecutionService.js`

### 2.2 再抽执行前收口层

把这类逻辑抽出去：

- metadata 驱动修正
- path candidate 归并
- metric 支持修正
- finalization

形成：

- `NapmQueryFinalizeService.js`

### 2.3 最后抽摘要层

把：

- `buildIntentResult`
- `buildSemanticResolutionResult`
- 执行摘要/调试摘要

抽成：

- `NapmQuerySummaryService.js`

验收标准：

- `RequirementParserService.js` 体量明显下降
- 执行、摘要、finalization 不再缠在一个类里
- Overview 模块仍能复用执行服务

---

## 第 3 阶段：统一命名和认知模型

目标：

- 从“旧 gateway 词汇”切到“NAPM runtime 词汇”

建议优先替换的命名：

- `gatewayRequest` -> `runtimeQuery`
- `executeGatewayRequest` -> `executeNapmQuery`
- `gatewayTemplatesDisabled` -> `runtimeTemplatesDisabled` 或更准确命名

注意事项：

- 先保留兼容 wrapper，再逐步替换调用方
- 先改新增代码，再反向改老调用

验收标准：

- 新代码不再继续扩散 `gateway*` 命名
- 项目文档与代码主命名趋于一致

---

## 第 4 阶段：把 skill 收成“NAPM 领域底座”

目标：

- 明确这是领域执行 runtime，而不是半个对话系统

这一阶段要产出的不是单一代码改动，而是一套稳定标准：

1. 固定 `resolvedQuery` 结构
2. 固定 execution guard 行为
3. 固定 narration contract
4. 固定 metadata / metric / path 的领域规则归属
5. 固定入口层、OpenClaw、skill 的边界

建议补齐的文档：

- `resolvedQuery` 字段说明
- `narrationInput` 契约说明
- NAPM 领域对象与指标词典
- 错误码与执行保护清单

验收标准：

- 新入口接入 NAPM 时，不需要复制粘贴业务逻辑
- 只要能产出标准 `resolvedQuery`，就能复用 skill 底座

---

## 9. 这次重构明确“不建议做”的事

以下方向当前不建议走。

### 9.1 不建议恢复 skill 的完整 prompt 解析主判

原因：

- 会重新和 OpenClaw 主链职责重叠
- 会制造两套语义系统
- 会让企业微信入口和其他入口表现不一致

### 9.2 不建议恢复旧项目级 gateway 为主入口

原因：

- 当前真实运行链已经切到 OpenClaw + skill 执行器
- 回退会让部署、维护和职责边界更乱

### 9.3 不建议在企微插件继续堆领域逻辑

原因：

- 插件应该是薄接入层
- 一旦在插件里堆规则，未来每个入口都会产生分叉

---

## 10. 这次重构建议优先修改的文件

如果按最小风险推进，建议优先从下面这些文件入手：

### 第一批

- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- `skills/openclaw-napm-query/services/RequirementParserService.js`
- `skills/openclaw-napm-query/services/OpenClawNarrationContractService.js`

### 第二批

- `skills/openclaw-napm-query/scripts/overview-module.js`
- `skills/openclaw-napm-query/scripts/OverviewExecution.js`
- `skills/openclaw-napm-query/services/GroupPathPlannerService.js`
- `skills/openclaw-napm-query/services/QueryMetadataConstraintService.js`

### 第三批

- `skills/openclaw-napm-query/SKILL.md`
- `skills/openclaw-napm-query/agents/openai.yaml`
- 相关 `docs/` 中的架构说明

---

## 11. 建议的验收方式

这次重构不能只看“代码更漂亮”，必须配一套回归方式。

建议至少保留下面这组验收矩阵：

### 11.1 元数据类

- `系统中有哪些web应用`
- `有哪些业务组`
- `IPAddress 支持哪些下钻路径`

### 11.2 单值查询类

- `101.254.114.238 的服务器响应时间是多少`
- `某业务最近1小时丢包率是多少`

### 11.3 排行类

- `访问其他web应用次数最多的客户端是谁`
- `数据包数量最多的前5个应用分别是谁`

### 11.4 趋势类

- `某业务最近24小时 RTT 趋势`

### 11.5 Overview 类

- `最近情况怎么样`
- `为什么最近慢`

### 11.6 边界类

- `什么是玫瑰`
- `继续`
- `需要`

每条用例建议同时记录：

- OpenClaw 产出的 `resolvedQuery`
- skill 最终执行 query
- NAPM 原始返回
- narration contract
- OpenClaw 最终回复

---

## 12. 我对这个项目的最终判断

如果目标是：

**“在 NAPM 领域内做一个可复用 skill 底座”**

那么当前项目不是方向错了，而是：

- 已经沉淀了大量正确资产
- 但还处在“旧网关遗留 + OpenClaw 主链收口 + skill 执行层强化”三股力量交织的阶段

因此正确做法不是推翻，而是收敛：

1. 冻结多头主判扩散
2. 把 `run_napm_query.js` 收成薄入口
3. 拆 `RequirementParserService`
4. 统一 runtime 命名
5. 最终把 skill 固化为 NAPM 领域执行底座

---

## 13. 最小可执行建议

如果现在只允许做最小一步，最推荐你先做的是：

### 第一步

新增：

- `skills/openclaw-napm-query/services/NapmRuntimeOrchestrator.js`

并把：

- `run_napm_query.js` 的主流程组织逻辑
- 缺少 `resolvedQuery` 的 fallback 组织
- overview 与普通查询分流
- narration contract 输出装配

迁进去。

### 第二步

在不改外部接口的前提下，把 `RequirementParserService` 里的执行逻辑先抽成：

- `NapmExecutionService.js`

这样你就完成了从“超级脚本 + 超级类”到“入口 + 编排 + 执行”的第一轮收敛。

这是当前最小、最稳、收益最大的切入点。
