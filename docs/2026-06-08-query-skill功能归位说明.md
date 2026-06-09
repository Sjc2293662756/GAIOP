# Query Skill 功能归位说明

日期：2026-06-08

## 目标

本次改造先处理 `openclaw-napm-query`，把属于 NAPM 查询能力的语义流程、结构化查询契约和对象口径从插件编排层逐步归位到 query skill。

本阶段不删除插件中的旧保护逻辑，先让 query skill 自身具备完整能力说明，作为后续瘦插件的依据。

## 修改内容

### 1. 新增 query workflow 契约

新增文件：

```text
skills/openclaw-napm-query/references/query-workflow-contract.md
```

该文件集中承载 query skill 的流程规则，包括：

- 适用范围和非适用范围。
- `resolvedQuery` 结构化输入契约。
- 时间字段契约。
- 对象清单和应用类型口径。
- 指标清单和指标归属口径。
- 下钻层级查询口径。
- service 选择规则。
- 综合分析流程。
- 追问继承规则。
- 与 packet/report skill 的边界。
- 中文输出和失败处理契约。

### 2. 更新 query SKILL.md

修改文件：

```text
skills/openclaw-napm-query/SKILL.md
```

新增主入口提示：

```text
For detailed query construction, inventory, metric-ownership, drilldown, time, follow-up, and cross-skill boundary rules, load references/query-workflow-contract.md.
```

并补充核心结构化查询规则：

```text
Production execution requires a complete resolvedQuery.
Executable data services must use root-level start and end.
timeRange is declarative metadata only.
Object inventory uses groups + queryModeKey=metadata.
Metric inventory uses metrics + queryModeKey=metadata.
Drilldown hierarchy uses drilldownCatalog.
```

### 3. 清理 query SKILL.md 主入口文档

进一步清理：

- 修复 `数据时间�?026`、`最�?`、`数据包数量最多的�?个` 等中文乱码。
- 将 `Metric Ownership` 中的大段重复规则压缩为引用 `query-workflow-contract.md` 和 metric references。
- 将 `Semantic Mapping Guardrails` 中与新契约重复的对象、指标、service mode 规则压缩为高优先级提醒。
- 保留必要的 legacy gateway 反模式说明，但不再把旧 gateway 作为当前运行链路。

现在 `SKILL.md` 作为 query skill 主入口，`references/query-workflow-contract.md` 作为详细查询流程契约。

## 已归位到 query skill 的功能

### 1. 普通 NAPM 查询

归属 query skill：

- 吞吐、流量、丢包、重传、响应时间、连接数、失败数、告警。
- TopN、均值、趋势、时间序列、综合分析。
- 查询结果解释和诊断。

### 2. 对象清单

归属 query skill：

```text
业务 / 业务系统 / Web应用 -> WebApplication
业务组 / 工作组 -> BusinessGroup
自动识别应用 -> CompositeApplication
已定义应用 -> DefinedApp
内置应用 / 协议应用 -> BuiltinApplication
```

其中：

```text
WebApplication -> applications Type=3
DefinedApp -> applications Type=2
CompositeApplication -> applications Type=4
BuiltinApplication -> applications Type=1
```

### 3. 指标清单和指标归属

归属 query skill：

- `业务都可以查哪些指标` -> `WebApplication` 视角。
- `工作组都可以查哪些指标` -> `BusinessGroup` 视角。
- 指标分类到 metric code 的解释。
- metric 与 dimension 的兼容性判断。

### 4. 下钻层级

归属 query skill：

- `支持哪些下钻路径`
- `可以往下钻到哪里`
- `有哪些顶层对象`
- `层级结构是什么`

查询 service：

```text
drilldownCatalog
```

### 5. 时间契约

归属 query skill 文档说明，执行前仍由 OpenClaw 构造：

```text
start/end 必须在 resolvedQuery 根层级
timeRange 只作为声明式 metadata
start/end 必须是 Unix 秒级时间戳
start/end 必须 60 秒对齐
今天/昨天/最近一小时/最近一天必须动态计算
```

### 6. 追问继承

归属 query skill 文档说明，实际语义理解仍由 OpenClaw 主流程负责：

```text
最近一天呢？ -> 继承上一轮对象/指标/服务，只换时间
继续分析 -> 继承上一轮发现对象作为分析焦点
这个呢？ -> 在指代明确时继承上一轮对象
```

## 明确不属于 query skill 的功能

### 数据包能力

以下不属于 query skill：

```text
数据包
报文
抓包
pcap / cap
packetsPreview
packetsDown
DownServlet
数据包情况
```

应走：

```text
openclaw-napm-packet-analysis
```

### 报告能力

以下不属于 query skill：

```text
生成报告
导出 Word/docx/PDF
将以上整理成文档
```

应走：

```text
openclaw-napm-report
```

## 后续瘦插件依据

已开始从 `napm-openclaw-plugin.remote.js` 中迁出或弱化以下 query 语义规则：

- `业务` / `业务组` / `自动识别应用` / `已定义应用` 的口径说明。
- object inventory 的 prompt 规则。
- metric inventory 的 prompt 规则。
- drilldownCatalog 的 prompt 规则。
- 时间契约的长文本 prompt。
- packet/report 与 query 的边界说明。

本次已完成的插件瘦身：

- `buildNapmRoutingSystemContext()` 不再展开业务、业务组、自动识别应用、指标清单、下钻目录的详细构造例子。
- 插件 context 改为指向 `skills/openclaw-napm-query/references/query-workflow-contract.md`。
- 插件仍保留结构化输入、根层级时间、禁止旁路、报告导出、危险操作阻断等生产安全边界。

插件暂时仍应保留：

- `resolvedQuery` 必填校验。
- `start/end` 根层级和 60 秒对齐校验。
- 工具执行审计。
- 输出脱敏。
- 危险操作阻断。
- 防止无 skill 结果时编造答案的保护。

## 验收用例

```text
系统中有哪些业务？
系统中有哪些业务组？
系统中有哪些自动识别应用？
系统中有哪些已定义应用？
业务都可以查哪些指标？
工作组都可以查哪些指标？
BusinessGroup 可以往下钻到哪里？
最近一小时丢包最严重的前10个IP
最近一天呢？
分析 101.254.114.238 最近一天的数据包 数据情况
将以上以 Word 文档给我
```

期望：

- 前九类普通查询和元数据问题由 query skill 处理。
- 数据包问题不再被 query skill 抢走。
- 报告问题不再被 query skill 抢走。

## 总结

本次改造完成了 query 能力的第一轮归位：query skill 不再只是执行脚本说明，而是开始承载 NAPM 查询领域的语义契约和流程规则。

下一步应继续处理：

```text
1. packet skill 功能归位
2. report skill 功能归位
3. 新增 workflow skill
4. 逐步瘦插件 routing context
```
