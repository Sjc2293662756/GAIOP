# 2026-05-12 References 资料分层与主链接入清单

## 1. 这份文档解决什么问题

当前 `skills/openclaw-napm-query/references/` 下已经积累了不少 NAPM 领域资料，但这些资料并不等于已经“接入主链”。

当前真实情况是：

- 一部分资料只是文档
- 一部分资料会通过 `SKILL.md` / `openai.yaml` 间接影响 OpenClaw / skill 提示
- 一部分资料应该继续下沉为代码规则或配置文件

所以这份文档的目标不是评价“资料有没有价值”，而是明确：

**每一份 reference 资料，应该留在什么层，以及如果要真正生效，下一步该接到哪里。**

---

## 2. 当前主链如何消费信息

先固定一个判断前提。

当前主链真正直接消费的信息主要来自：

### 2.1 代码

- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- `skills/openclaw-napm-query/services/*.js`
- `src/constants/*.js`

### 2.2 配置

当前代码明确直接读取的配置包括：

- `config/groups-tree.static.json`
- `config/stable-query-templates.v1.json`
- 以及其他 `config/*.json / *.yml` 中的运行时配置

### 2.3 提示/技能说明

当前会间接影响 OpenClaw / skill 行为的包括：

- `skills/openclaw-napm-query/agents/openai.yaml`
- `skills/openclaw-napm-query/SKILL.md`

### 2.4 当前大多数 `references/*.md` 的真实状态

当前大多数 reference 文档：

- **不会被运行时代码直接 `readFileSync()` 读取**
- **不会像配置文件那样自动参与线上执行**
- 主要作用是：
  - 供提示词引用
  - 供开发者理解和维护
  - 供后续把规则下沉到代码/配置时使用

因此：

**如果某份资料想“真正进入主链”，必须明确接入到提示词层，或者下沉到代码/配置层。**

---

## 3. 分层判断标准

以后判断一份资料该放哪层，建议统一按下面标准：

### 3.1 留在文档层

适合保留在 `references/*.md` 的内容：

- 长篇背景知识
- 原理解释
- 维护说明
- 来源索引
- 需要人阅读理解，但不适合硬编码进主链的说明

### 3.2 提炼到提示词层

适合进入 `SKILL.md` 或 `openai.yaml` 的内容：

- 必须让 OpenClaw 或 skill 遵守的语义口径
- 调用策略
- 领域边界提醒
- 必须影响主判或生成 `resolvedQuery` 的短规则

### 3.3 下沉到代码/配置层

适合做成代码或配置的内容：

- 会影响执行正确性的稳定规则
- 对象归属规则
- 指标归属规则
- metric alias / ownership / compatibility
- path 约束
- 必须可测试的确定性规则

判断口诀：

**能执行的规则，不要只停在 md。**

---

## 4. 当前 references 逐项分类

下面按当前仓库里的每个文件逐项判断。

## 4.1 `source-index.md`

当前定位：

- 索引文档
- 说明每份 reference 的来源和用途

建议归属：

- **保留在文档层**

原因：

- 它的价值是导航，不是规则本身
- 不适合进入代码
- 不需要进入 `openai.yaml`

建议动作：

- 保留
- 继续作为维护者入口索引

不建议：

- 下沉到运行时代码

---

## 4.2 `metric-definitions.md`

当前内容类型：

- 指标定义
- 指标解释
- 指标语义说明

建议归属：

- **主归属：文档层**
- **部分规则：提炼到提示词层**

应该提炼到提示词层的内容：

- `服务器响应时间 -> TRTI`
- `RTT / 延迟 -> RTTI 类`
- `数据包数量 -> PKIO`
- `页面访问 -> PGNPGE`

这些已经有一部分进入了：

- `SKILL.md`
- `openai.yaml`

后续建议：

- 继续只把“高频、必须稳定”的指标语义短规则提炼到提示词
- 其余长解释仍保留在文档层

不建议：

- 把整份指标定义 md 直接塞进 prompt

---

## 4.3 `group-hierarchy.md`

当前内容类型：

- 顶层对象
- drill-down 层级
- group path 说明

建议归属：

- **主归属：文档层**
- **执行真正规则：下沉到配置/代码层**

当前实际更适合承载这类规则的地方：

- `config/groups-tree.static.json`
- `NapmMetadataService`
- `GroupPathPlannerService`

判断：

- 层级解释本身适合留文档
- 真正用于执行/校验的层级规则，不应该只停在 md

建议动作：

1. 保留 `group-hierarchy.md` 作为解释文档
2. 以 `groups-tree.static.json` 为结构型主事实源
3. 若文档里存在比静态树更明确的层级规则，应整理进静态树或 path planner

---

## 4.4 `service-modes.md`

当前内容类型：

- `topValues / averageValues / timeValues / overview`
- 元数据服务与数据服务的语义边界

建议归属：

- **主归属：提示词层 + 文档层**
- **部分稳定规则：下沉到代码**

为什么：

- “这是排行、均值、趋势还是概览”本身强依赖问句语义
- 这更接近 OpenClaw / skill 的判定提示

应该进入提示词层的：

- `有哪些 / 列表 -> metadata listing`
- `最多 / topN -> ranking`
- `平均 / 整体 -> average / overview`
- `趋势 / 曲线 -> time series`

这些已经部分在：

- `SKILL.md`
- `openai.yaml`

应该下沉到代码层的：

- overview 模式下的执行分流标准
- `queryModeKey` 与 runtime service 的映射

对应代码位置：

- `run_napm_query.js`
- `overview-module.js`
- `RequirementParserService.js`

---

## 4.5 `query-construction.md`

当前内容类型：

- NAPM 查询参数结构
- `type / start / end / groupType / groupArgument / topMetric / topCount`
- URL 构造逻辑

建议归属：

- **主归属：代码/配置层**
- **文档层保留说明**

这是最典型“不该只停在 md”的资料。

因为它描述的是：

- 可执行 query 的结构
- 参数拼装规则
- service 的参数要求

这些应该主要落在：

- `RequirementParserService.js`
- `NapmClient.js`
- 相关 query validator / finalize service

建议动作：

1. 保留 `query-construction.md` 作为开发者说明
2. 抽取其中稳定规则，转成：
   - 代码逻辑
   - 校验规则
   - 单元测试

一句话：

**凡是会影响 API 拼装正确性的规则，最终都应该可测试，不要只写在文档里。**

---

## 4.6 `runtime-lookup-notes.md`

当前内容类型：

- 什么时候该优先查运行时 metadata
- 什么时候不能只靠静态文档

建议归属：

- **主归属：文档层**
- **关键策略：下沉到代码实现**

这份文档最值钱的不是具体措辞，而是策略：

- metrics 要看 `metrics`
- group path 要看 `groups`
- argument 候选要看 `groupArguments`
- metric 兼容性要看 `metricsForGroup`

这些其实已经部分进入代码：

- `NapmMetadataService`
- `RequirementParserService`
- `QueryMetadataConstraintService`

建议动作：

- 文档保留
- 不需要进 prompt 太多
- 但若还有“运行时应优先查询 metadata”的规则没落到代码，应继续下沉

---

## 4.7 `openclaw-integration.md`

当前内容类型：

- OpenClaw 如何调用 skill
- `resolvedQuery` 契约
- 输入输出约定
- 工具命名建议

建议归属：

- **主归属：提示词层 + 接入文档层**

这份文档是当前最接近“主链接入规则”的 reference。

它最适合的落点：

- `SKILL.md`
- `openai.yaml`
- 接入说明文档

不适合：

- 直接做运行时代码

因为它主要描述的是：

- 谁负责什么
- OpenClaw 应该怎么调
- 结果应该怎么回

建议动作：

- 继续保留
- 作为 `SKILL.md` / `openai.yaml` 的上游来源
- 后续若提示词里有重要接入口径缺失，应先回看这份文档再补 prompt

---

## 4.8 `capability-mapping.md`

当前内容类型：

- 当前模块分工说明
- 哪些模块负责 input normalization / metadata / execution / narration

建议归属：

- **保留在文档层**

原因：

- 它是架构说明
- 不适合直接进代码
- 不需要直接进 prompt

但它对重构很有帮助，因为它能帮助你把“哪些能力应该在哪层”讲清楚。

建议动作：

- 保留
- 配合重构文档一起维护

---

## 4.9 `metric-category-mapping.md`

当前内容类型：

- 指标分类 -> metric code
- 指标分类说明

建议归属：

- **主归属：代码/配置层**
- **文档保留说明**

这是当前最值得下沉的 reference 之一。

因为这份资料不是纯解释，它包含的是：

- 分类到 code 的映射
- 很多内容具有稳定性
- 适合被测试

当前更适合承载它的地方：

- `src/constants/metricDomains.js`
- `src/constants/objectMetricOwnership.js`
- 新增或扩展 `config/*.json`

建议动作：

1. 保留文档版，作为人工说明
2. 把其中稳定映射整理成：
   - 配置表
   - 常量映射
   - 单元测试

结论：

**这份资料如果一直只停在 md，就会显得“像没用”；一旦下沉到配置/常量，它就会真正进入主链。**

---

## 4.10 `metric-dimension-ownership.md`

当前内容类型：

- 不同对象维度下默认该用哪些指标族
- plain 问法落点规则

建议归属：

- **主归属：代码/配置层**
- **少量高频规则：提示词层**

为什么：

- 这份资料决定“对象与指标的归属关系”
- 这会直接影响执行正确性
- 属于强规则，不应只留在文档里

当前已经部分下沉的相关位置：

- `src/constants/objectMetricOwnership.js`
- `QueryMetadataConstraintService`
- `RequirementParserService`

建议动作：

1. 继续把稳定 ownership 规则固化进常量/配置
2. 只把特别高频、需要 OpenClaw 主判就先守住的规则，提炼进 prompt

例如：

- plain `业务` 默认 `WebApplication`
- plain `业务都可以查哪些指标` 不应默认外扩到 `BusinessGroup`

---

## 4.11 `top-level-metric-ownership.md`

当前内容类型：

- 顶层对象属于业务类还是非业务类指标口径

建议归属：

- **主归属：代码/配置层**
- **文档保留**

这份资料和 `metric-dimension-ownership.md` 一样，也属于：

- 稳定
- 可结构化
- 应直接影响主链

当前对应位置：

- `src/constants/objectMetricOwnership.js`
- `src/constants/metricDomains.js`

建议动作：

- 把文档当说明
- 把规则当配置/常量
- 用测试锁住

---

## 5. 当前最需要下沉的资料

如果只按“优先级最高”来排，最值得从文档层继续下沉的，是下面三份：

### 第一优先级

- `metric-category-mapping.md`
- `metric-dimension-ownership.md`
- `top-level-metric-ownership.md`

原因：

- 这些资料会直接影响：
  - 对象归属
  - metric 候选
  - query 是否正确

它们最不应该长期只停在 md。

### 第二优先级

- `query-construction.md`
- `group-hierarchy.md`

原因：

- 会直接影响 query 结构和 path 合法性
- 应继续下沉到：
  - config
  - validator
  - execution service

### 第三优先级

- `service-modes.md`
- `openclaw-integration.md`

原因：

- 这两份更像提示词与接入契约来源
- 更适合持续提炼到 `SKILL.md` / `openai.yaml`

---

## 6. 当前最应该保留为文档的资料

如果只按“保留为文档最合理”的排序：

- `source-index.md`
- `capability-mapping.md`
- `metric-definitions.md`
- `runtime-lookup-notes.md`

这些文档很有价值，但不应该强求它们“直接跑进主链”。

它们的主要价值是：

- 帮人理解
- 帮你改提示词
- 帮你重构时找到规则来源

---

## 7. 建议的下一步落地顺序

不要一次全部迁。

建议按下面顺序落地：

### 第一步

先把这三份资料彻底作为“代码/配置主事实源候选”来处理：

- `metric-category-mapping.md`
- `metric-dimension-ownership.md`
- `top-level-metric-ownership.md`

做法：

1. 提炼稳定映射
2. 放进 `src/constants/` 或 `config/`
3. 补测试

### 第二步

把 `query-construction.md` 中稳定规则抽成代码校验：

- service 参数约束
- groupType / groupArgument 结构
- topMetric / topCount / granularity 校验

### 第三步

把 `service-modes.md` 和 `openclaw-integration.md` 中真正高频的主判规则再压缩进：

- `skills/openclaw-napm-query/agents/openai.yaml`
- `skills/openclaw-napm-query/SKILL.md`

注意：

- 只提炼短规则
- 不把整份长文档塞进 prompt

---

## 8. 最终判断

如果你问：

**“我现在 skill 里写的 references 资料，是不是很多都没有用到？”**

答案是：

**是的，当前很多 reference 资料还没有被当前主链直接消费。**

但更准确的说法是：

- 它们不是没价值
- 而是还停留在“知识文档层”
- 没有充分下沉到：
  - 提示词层
  - 代码层
  - 配置层

这也是你现在会强烈感觉“流程有问题”的根本原因。

因为你写的很多东西，**还没有真正接上电。**

---

## 9. 最小可执行建议

如果现在只做一件事，最推荐做的是：

### 把三份 ownership / category 资料正式下沉

- `references/metric-category-mapping.md`
- `references/metric-dimension-ownership.md`
- `references/top-level-metric-ownership.md`

目标：

- 让它们不再只是文档
- 而是变成当前 skill 真正可执行、可测试、可复用的 NAPM 领域规则底座

这是当前最能解决“资料写了但像没用”的第一步。
