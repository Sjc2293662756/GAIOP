# 2026-05-12 NAPM Skill 按需加载与硬规则设计原则

## 1. 这份文档回答什么问题

这份文档专门回答一个很容易混淆的问题：

**既然 `skills/openclaw-napm-query/references/` 可以按需加载，为什么还需要把一部分规则迁移成代码或配置？**

结论先写在前面：

**按需加载可以继续保留，但只能作为知识补充层；不能作为 NAPM 可复用底座的唯一规则来源。**

---

## 2. 先分清两种“加载”

在当前项目里，`skill` 里其实同时存在两种完全不同的“加载”：

### 2.1 提示词 / 知识层的按需加载

这类加载发生在：

- `skills/openclaw-napm-query/SKILL.md`
- `skills/openclaw-napm-query/agents/openai.yaml`
- `skills/openclaw-napm-query/references/*.md`

它的特点是：

- 给 OpenClaw 或 skill 提供领域知识
- 让模型在当前问题需要时去读某份 reference
- 帮助模型形成更接近 NAPM 口径的理解和表达

这是一种：

**模型推理时的软约束。**

### 2.2 运行时代码层的硬加载

这类加载发生在：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`
- `skills/openclaw-napm-query/services/*.js`
- `src/constants/*.js`
- `config/*.json / *.yml`

它的特点是：

- 真正决定线上执行走哪条逻辑
- 真正决定默认对象、指标、路径、兼容性校验怎么跑
- 可以被代码显式调用、校验、测试

这是一种：

**系统执行时的硬约束。**

---

## 3. 为什么“按需加载”不能单独作为底座

如果只是做解释类 skill，按需加载已经足够。

但当前项目不是单纯的说明型 skill，而是：

**一个要在 NAPM / NetInside 领域内稳定复用的执行型 skill。**

这时只靠按需加载，会有几个天然问题。

### 3.1 它不是必然执行

reference 被按需读取，本质上依赖模型本轮是否真的去读、是否读到了关键段落、是否正确理解。

也就是说：

- 这次可能读到了
- 下次可能没读到
- 不同上下文下可能抓的重点不同

所以它不能保证每次都完全一致。

### 3.2 它不是强校验

例如：

- `业务` 默认到底是 `WebApplication` 还是 `BusinessGroup`
- `业务都可以查哪些指标` 能不能带出 `TPIO`
- `ClientBusinessGroup` 算业务口径还是网络口径

这些都不是“参考建议”，而是必须稳定一致的执行规则。

如果这些规则只写在 md 里，那么系统并没有真正被强制约束。

### 3.3 它不利于测试和回归

文档可以被阅读，但文档本身不能直接做单测。

而代码/配置可以：

- 写断言
- 防止回归
- 在 refactor 后快速验证主链没漂

对可复用底座来说，这一点非常关键。

### 3.4 它不适合作为多入口统一真相源

你的目标不是只让某一次 OpenClaw 对话答对，
而是让下面这些入口尽量共用同一套 NAPM 规则：

- OpenClaw 主链
- 企业微信接入链
- 本地调试脚本
- 将来可能新增的接口或入口

如果核心规则只存在于 reference 文档里，那么不同入口很容易出现：

- 有的入口依赖提示词
- 有的入口依赖本地经验逻辑
- 有的入口依赖运行时 fallback

最后就会重新变乱。

---

## 4. 正确的分层原则

以后判断某条 NAPM 规则应该放在哪层，统一按下面原则。

### 4.1 留在 `references/` 的内容

适合继续按需加载，不必硬迁移的内容：

- 背景知识
- 指标定义说明
- 历史来源索引
- 领域概念解释
- 需要人阅读理解的维护文档

一句话：

**解释性知识，放文档层。**

### 4.2 放进 `SKILL.md` / `openai.yaml` 的内容

适合保留为提示词规则的内容：

- OpenClaw 和 skill 的职责边界
- 领域边界提醒
- 回答口径提醒
- `resolvedQuery` 的输入输出契约
- 需要模型优先遵守的短规则

一句话：

**行为口径，放提示词层。**

### 4.3 下沉到代码 / 配置的内容

必须迁移为硬规则的内容：

- 对象归属规则
- 指标归属规则
- metric category 到 metric code 的稳定映射
- groupPath / hierarchy 约束
- metric compatibility 约束
- 默认候选与过滤逻辑

一句话：

**会影响执行结果正确性的规则，必须放可执行层。**

---

## 5. 结合当前项目的直接结论

对当前 `openclaw-napm-query` 来说，可以直接采用下面这个判断口径。

### 5.1 `references/` 不是没用

它仍然有价值，主要价值是：

- 让 skill / OpenClaw 在解释类问题上有资料可查
- 给后续维护者保留领域上下文
- 作为硬规则沉淀前的知识来源

所以：

**不要把 `references/` 理解成“没用文件夹”。**

### 5.2 但 `references/` 也不是主链硬规则本身

当前真正稳定参与执行的主链，还是：

- 运行时代码
- `src/constants`
- `config/*`
- metadata 校验逻辑

所以：

**reference 可以参与理解，但不能代替执行约束。**

### 5.3 当前最应该迁移的三类资料

最适合从文档层下沉为统一硬规则的，就是这三份：

- `references/top-level-metric-ownership.md`
- `references/metric-dimension-ownership.md`
- `references/metric-category-mapping.md`

因为它们决定的是：

- 顶层对象属于业务口径还是非业务口径
- 某类对象默认优先用哪些指标
- 某个指标分类具体落哪些 metric code

这三类规则一旦漂移，就会直接影响：

- `resolvedQuery` 合法性
- 指标清单回答
- 默认候选选择
- 最终查询正确性

---

## 6. 一句话设计原则

以后团队讨论这个 skill 时，统一使用下面这句话：

**NAPM skill 可以按需加载 reference 作为知识补充，但凡是会影响执行正确性、默认归属、指标过滤、路径合法性和主链一致性的规则，都必须沉淀为代码或配置，而不能只停留在 md。**

---

## 7. 下一步建议

后续收敛时，建议按以下顺序推进：

1. 保留 `references/` 作为文档层，不删
2. 将三份 ownership / category 资料收口为统一常量或配置
3. 让 `RequirementParserService`、`DimensionMappingService`、`QueryMetadataConstraintService` 只依赖这一套硬规则
4. 用测试把业务口径、非业务口径、默认过滤逻辑锁死
5. `SKILL.md` 只保留短规则和调用边界，避免再次把大量执行规则堆回文档层

最终目标不是“让模型多看资料”，而是：

**让 skill 在 NAPM 领域内形成一套可解释、可执行、可测试、可复用的稳定底座。**
