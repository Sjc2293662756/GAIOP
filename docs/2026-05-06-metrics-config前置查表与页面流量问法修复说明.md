# 2026-05-06 metrics-config前置查表与页面流量问法修复说明

## 一、问题背景

本次修复针对两个实际问题：

1. `config/metrics-config.yml` 虽然维护了较完整的指标元数据，但此前并不是语义识别链路中的前置事实源，更多只是用于校验和兜底。
2. 类似“页面流量最大的前三个业务是哪些”这类问法，语义链路会把“页面流量”误吸附到更泛化的指标上，最终跑偏到 `HTTP 100` 或普通吞吐量类指标，导致结果错误。

## 二、本次调整目标

本次改动的目标很明确：

- 让 `config/metrics-config.yml` 成为指标识别时的前置查表来源；
- 让“页面流量”“请求流量”“页面大小”“请求大小”等问法优先命中明确指标；
- 让“前三个业务/哪些业务”这类明显排名问法优先进入 TopN 查询，而不是误判成对象列表查询；
- 在应用语境下，普通“业务”问法优先保持为 `WebApplication`，避免又被拉回 `BusinessGroup`。

## 三、核心改动

### 1. 指标识别改为先查 `metrics-config.yml`

调整文件：

- [skills/openclaw-napm-query/services/MetricMappingService.js](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/skills/openclaw-napm-query/services/MetricMappingService.js)
- [skills/openclaw-napm-query/services/NaturalLanguageQueryMapper.js](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/skills/openclaw-napm-query/services/NaturalLanguageQueryMapper.js)

现在的处理顺序变为：

1. 先从 `metrics-config.yml` 加载指标定义；
2. 将指标描述做规范化；
3. 在用户原始问句中直接做配置表匹配；
4. 命中后优先采用该指标编码；
5. 只有未命中时，才继续走别名族、歧义消解、兜底规则。

也就是说，`metrics-config.yml` 现在不再只是“后验验证表”，而是正式进入“前置识别链路”。

### 2. 页面流量类问法固定映射

新增或加强了以下映射：

- `页面流量` -> `PGBYTO`
- `请求流量` -> `PGBYTI`
- `页面大小` -> `PGSIZEO`
- `请求大小` -> `PGSIZEI`

调整文件：

- [config/nl-query-mapping.v1.json](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/config/nl-query-mapping.v1.json)
- [config/metric-semantic-disambiguation.v1.json](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/config/metric-semantic-disambiguation.v1.json)
- [skills/openclaw-napm-query/services/MetricSemanticDisambiguationService.js](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/skills/openclaw-napm-query/services/MetricSemanticDisambiguationService.js)

这样做的结果是：即便后续还会经过歧义消解，页面流量类指标也不会再轻易漂移到吞吐量、HTTP状态码等别的指标上。

### 3. 排名意图优先于列表意图

此前“哪些业务”“前三个业务”这类文本，容易被 `哪些` 带偏，进入对象列表查询。

现在改为：

- 先判断是否为排名问法；
- 只有不是排名问法时，才继续按 inventory/list 语义走。

因此：

- “系统中有哪些 web 应用” 仍然是列表查询；
- “页面流量最大的前三个业务是哪些” 会稳定进入 TopN 排名查询。

### 4. 应用语境下保护 `业务 -> WebApplication`

在应用/页面流量语境里，如果当前对象已经推断到 `WebApplication`，则普通“业务”表述不再被轻易覆盖成 `BusinessGroup`，除非用户明确说的是“业务组”“业务分组”。

这一步主要是防止对象维度再次跑偏。

## 四、修复后的目标效果

对于问句：

`页面流量最大的前三个业务是哪些`

当前期望解析结果为：

- service: `topValues`
- metric: `PGBYTO`
- group type: `WebApplication`
- topCount: `3`

也就是会走：

`topValues + PGBYTO + WebApplication + top3`

而不再出现：

- 错用 `PGHTTP100` / HTTP 100 类指标；
- 错走普通吞吐量 `TPIO`；
- 错走业务组 `BusinessGroup`；
- 错走“系统中有哪些对象”的列表查询。

## 五、验证情况

本次已补充并通过相关测试：

- 历史本地解析测试 `page-traffic-mapping.test.js`、`packet-metric-mapping.test.js` 已在当前架构收口后移除
- [test/openclaw-narration-contract.test.js](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/test/openclaw-narration-contract.test.js)
- [test/overview-module.test.js](/g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_Semantic_Gateway/test/overview-module.test.js)

重点验证点包括：

- `页面流量` 是否稳定识别为 `PGBYTO`
- `数据包数量` 是否稳定识别为 `PKIO`
- 排名问法是否优先进入 TopN
- 叙述契约与概览模块是否未被这次改动破坏

## 六、结论

这次改完后，`config/metrics-config.yml` 的角色已经被扶正：

- 它现在是指标识别链路中的前置事实源；
- 不是只在最后阶段做合法性校验；
- 对后续扩充指标、补充中文别名、修语义漂移会更稳。

同时，“页面流量最大的前三个业务是哪些”这类实际业务问法，也已经从链路上被修正到了正确的指标与对象维度。
