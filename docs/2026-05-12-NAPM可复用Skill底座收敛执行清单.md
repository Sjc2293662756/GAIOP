# 2026-05-12 NAPM 可复用 Skill 底座收敛执行清单

## 1. 这份清单怎么用

这份清单不是新的架构讨论稿，而是基于当前仓库现状，给后续收敛工作提供一份：

- 能排优先级
- 能逐步推进
- 能逐项验收
- 尽量不影响现有主链

的执行清单。

适用前提：

- 当前主链已经是 `OpenClaw 主判 + NAPM skill 执行`
- 企业微信插件不再做 NAPM 主判断
- 目标不是恢复旧 gateway，而是把当前 skill 收敛成 NAPM 领域可复用底座

---

## 2. 总体目标

后续收敛完成后，项目应达到下面这个状态：

1. OpenClaw 负责主判断、追问、澄清、`resolvedQuery` 构造和最终回复
2. skill 负责 NAPM 领域执行、规则校验、API 调用、结构化结果输出
3. 企业微信只保留消息接入和少量硬安全拦截
4. `references/` 继续保留，但不再承载主链唯一硬规则
5. 影响执行正确性的规则，都能在代码或配置里找到唯一真相源

---

## 3. 收敛原则

整次收敛统一遵守下面三条原则：

### 3.1 不影响当前主链

- 不为了“看起来更优雅”去重写已稳定运行的主入口
- 不恢复旧 gateway 时代的绕行链路
- 不让企业微信重新接管主判

### 3.2 先固规则，再调结构

优先把核心 NAPM 规则固化成硬规则，再做类拆分、命名优化和目录整理。

否则很容易出现：

- 文件改漂亮了
- 规则仍然漂
- 主链行为还是不稳

### 3.3 文档、提示词、代码三层分工明确

- `references/`：知识补充层
- `SKILL.md` / `openai.yaml`：行为口径层
- `src/constants` / `config` / `services`：可执行硬规则层

---

## 4. 执行阶段划分

建议分成四个阶段推进，每个阶段都可以单独验收。

### 阶段 A：冻结主链职责边界

目标：

- 明确谁负责判断，谁负责执行
- 防止历史逻辑回流

本阶段要做的事：

1. 继续坚持 `OpenClaw 主判 + skill 执行` 口径
2. 禁止把企业微信历史本地判断逻辑重新接回主链
3. 禁止把大段“自然语言主解析职责”重新塞回 skill 执行器
4. `run_napm_query.js` 只作为 skill 单一执行入口保留

本阶段验收标准：

- 团队内部对当前主链没有“到底谁在主判”的分歧
- 新增需求不会默认要求“先在企业微信里补一段判断”
- skill 的定位明确为 NAPM 执行内核

---

### 阶段 B：收口 NAPM 领域硬规则

目标：

- 把最关键、最容易漂移的 NAPM 规则沉淀成统一真相源

本阶段优先处理的规则：

1. 顶层对象归属
2. 指标分类归属
3. metric category 到 metric code 的映射
4. 业务口径与非业务口径默认过滤
5. 默认对象候选与兼容性修正

当前最该作为源材料的文档：

- `skills/openclaw-napm-query/references/top-level-metric-ownership.md`
- `skills/openclaw-napm-query/references/metric-dimension-ownership.md`
- `skills/openclaw-napm-query/references/metric-category-mapping.md`

建议落点：

- `src/constants/objectMetricOwnership.js`
- `src/constants/metricDomains.js`
- 必要时新增更细的 config / constant 文件

本阶段验收标准：

- plain `业务` 与 `业务组` 的口径稳定
- `WebApplication` 默认不再漏出 `TPIO / PLI / RTTI / CONI` 一类网络指标
- `BusinessGroup` 默认不再混入 `PG*` 页面指标
- 相关规则可以被单测直接验证

---

### 阶段 C：收敛 skill 内部职责

目标：

- 让 skill 更像“领域执行底座”，而不是“半解析器 + 半执行器 + 半对话层”

本阶段要做的事：

1. 保留 `run_napm_query.js` 作为薄入口
2. 逐步减少入口文件中的轻理解逻辑和历史兼容 shortcut
3. 继续把 `RequirementParserService` 中混杂的职责拆小
4. 保留真正有复用价值的执行服务：
   - `MetricMappingService`
   - `DimensionMappingService`
   - `NapmMetadataService`
   - `GroupPathPlannerService`
   - `QueryMetadataConstraintService`
   - `OpenClawNarrationContractService`

本阶段不要求一次性大拆分。

更合适的做法是：

- 先抽稳定规则
- 再逐步拆出 execution / normalize / guard / finalize 之类的小层

本阶段验收标准：

- skill 内部主要职责可读
- 新人看代码时，能分清“哪个负责规则、哪个负责执行、哪个负责结果契约”
- 不再明显残留旧 gateway 时代的认知噪音命名

---

### 阶段 D：测试锁边界，文档锁口径

目标：

- 把这次收敛真正锁住，避免过一段时间又回乱

本阶段要做的事：

1. 为对象归属和指标归属补齐测试
2. 为默认过滤逻辑补齐测试
3. 为兼容性修正补齐测试
4. 为 group hierarchy / drilldown 路径能力补齐测试
5. 更新 `SKILL.md`，只保留高价值短规则
6. 保留 `references/`，但避免继续向里面堆“本应进入代码的硬规则”

本阶段验收标准：

- 回归测试能挡住主要口径漂移
- 文档、提示词、代码三层分工清楚
- 后续新增规则时，团队知道应该加到哪一层

---

## 5. 当前仓库的优先级建议

如果按你当前仓库状态来排，建议优先级如下。

### P0：先不动主链入口

当前先不要做这些事：

- 不恢复独立 gateway 主链
- 不让企业微信重新做 NAPM 主判断
- 不大改 `run_napm_query.js` 入口协议

理由：

- 这些动作风险大
- 对“NAPM 领域复用底座”帮助不如规则收口直接

### P1：先锁指标归属和对象归属

这是当前收益最高的一步。

原因：

- 它最直接影响查询正确性
- 它最直接影响“references 看起来没用”的体感
- 它最容易被测试锁住

当前仓库已经有这方面的基础：

- `src/constants/objectMetricOwnership.js`
- `src/constants/metricDomains.js`
- `test/business-metric-ownership.test.js`

所以这一步不是从零开始，而是继续收口成唯一真相源。

### P2：再锁 hierarchy / path / drilldown 规则

原因：

- 多层路径和钻取是 NAPM skill 很容易继续变乱的地方
- 一旦 hierarchy 规则散落在 prompt、临时逻辑、metadata fallback 里，维护成本会很高

建议重点围绕：

- `groups-tree.static.json`
- `NapmMetadataService`
- `GroupPathPlannerService`

收敛“结构可达”和“运行时可执行”的边界。

### P3：最后再做服务拆分与命名收口

原因：

- 这是长期收益项
- 但优先级低于硬规则收口

先有正确规则，再谈漂亮结构，会更稳。

---

## 6. 每一步具体怎么判断“做完了”

为了避免“看起来改了很多，实际没有收住”，后面每一步都建议按下面方式判断完成度。

### 6.1 规则是否有唯一真相源

判断方式：

- 同一条规则不能同时散落在 md、prompt、service fallback 三处互相打架
- 关键归属规则能在一个 constant / config 层找到

### 6.2 规则是否可测试

判断方式：

- 至少有一条直接单测覆盖该规则
- 改动后可以靠测试发现口径漂移

### 6.3 新入口是否能复用

判断方式：

- 如果未来换一个入口调用这个 skill，核心规则不需要重写
- 不依赖“某个人记得去读 reference”

### 6.4 是否未破坏当前主链

判断方式：

- 当前 skill 调用协议不变
- 当前 OpenClaw 主判职责不变
- 当前主要查询场景不因结构整理而退化

---

## 7. 推荐的下一步动作

如果只做一件最值得做的事，建议就是：

**把 `top-level-metric-ownership`、`metric-dimension-ownership`、`metric-category-mapping` 三份资料彻底收口成统一硬规则，并让相关服务只依赖这套规则。**

这是因为它会同时解决：

- `references` 看起来“有写但没真接主链”
- `业务` / `业务组` 口径容易飘
- 不同服务里默认指标选择不一致
- 新入口难复用

---

## 8. 最终执行口号

后续整个项目收敛时，统一按下面这句执行：

**先锁 NAPM 硬规则，再收 skill 结构；先保证主链稳定复用，再追求实现优雅。**
