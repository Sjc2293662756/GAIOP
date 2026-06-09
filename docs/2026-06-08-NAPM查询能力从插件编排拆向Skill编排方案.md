# NAPM 查询能力从插件编排拆向 Skill 编排方案

日期：2026-06-08

## 1. 背景

当前 NAPM 项目已经经历了多轮收口改造，核心目标一直是避免 OpenClaw 在生产查询中绕过主链路，例如直接 `curl`、`python` 过滤、手工读取静态文件、或根据会话记忆补写答案。

这些改造在短期内解决了很多 P0/P1 问题，但也带来了新的结构性问题：大量本应由 OpenClaw agent 编排的流程知识，被写进了插件、hook、resolver、routing prompt 和边界校验中。

典型例子包括：

- “业务”必须理解为 `WebApplication`，不能混成 `BusinessGroup`。
- “业务组/工作组”才走 `BusinessGroup`。
- “自动识别应用”走 `CompositeApplication`。
- “已定义应用”走 `DefinedApp`。
- “数据包/报文/pcap”必须走 packet analysis，不能走 `topValues/timeValues/overview`。
- “将以上导出 Word”应调用 report skill，不能重新查 NAPM。
- `resolvedQuery.start/end` 必须在根层级，不能放进 `timeRange.start/end`。
- 追问要继承上一轮对象、指标、时间语义。

这些规则本质上是查询流程和能力编排知识，而不是底层执行能力。继续把它们堆在插件里，会让插件越来越像手写语义路由器，和 OpenClaw 的 skill 编排模型冲突。

## 2. 当前方式：插件/代码编排

当前生产链路主要依赖 `napm-openclaw-plugin.remote.js` 显式注册工具，并在插件内维护大量规则。

当前能力大致是：

```text
OpenClaw 用户问题
  -> 插件 routing/system context/hook/resolver 做大量约束
  -> napm-skill-query / napm-report-export
  -> 对应脚本执行
  -> 插件缓存、审计、拦截、改写输出
  -> 企业微信回答
```

这种方式的优势：

- 行为可控，适合快速止血。
- 可以强制校验 `resolvedQuery`、`reportData`、时间字段等结构。
- 可以在插件内做统一审计、脱敏、缓存和错误拦截。
- 对 P0 稳定性问题有效，例如阻止“无 skill 结果却编答案”。

这种方式的问题：

- 规则越来越多，插件越来越重。
- 每加一个能力都要改插件。
- 关键词规则容易漏表达，也容易误伤正常问题。
- OpenClaw 的自主 skill 选择能力被压住。
- 容易出现“修一个问题，引入另一个路由偏移”。
- 代码里混杂业务语义、流程编排、安全边界和执行逻辑，长期维护成本高。

## 3. 目标方式：Skill 描述 + OpenClaw 编排

目标不是删除插件，而是改变职责边界。

推荐目标结构：

```text
OpenClaw
  负责理解用户意图、选择 skill、处理追问、串联多 skill 流程

openclaw-napm-query
  负责 NAPM 指标、排行、趋势、均值、清单、元数据、下钻

openclaw-napm-packet-analysis
  负责数据包链接构造、预览、下载、pcap/cap/tshark 分析

openclaw-napm-report
  负责把已有查询/分析结果导出 Word/docx/PDF

openclaw-napm-workflow
  可选，负责复合流程说明，例如“查异常 -> 下载数据包 -> 分析 -> 生成报告”

NAPM plugin
  只负责工具注册、脚本执行、输入 schema 校验、脱敏、审计、必要缓存和危险行为阻断
```

核心原则：

```text
语义和流程知识进入 Skill。
插件退回工具执行和安全边界。
OpenClaw 负责选择和编排。
```

## 4. 拆分后的能力边界

### 4.1 openclaw-napm-query

适用问题：

- 吞吐、流量、丢包、重传、响应时间、连接数、失败数等指标查询。
- TopN 排行、均值、趋势、时间序列。
- 系统中有哪些业务、应用、业务组、工作组、自动识别应用、已定义应用。
- 某对象支持哪些指标。
- 某对象支持哪些下钻路径。
- NAPM 查询结果解读。

不适用问题：

- 数据包、报文、抓包、pcap、cap。
- 下载数据包、分析数据包。
- 生成 Word/PDF 报告。

Skill 文档中需要明确的语义口径：

```text
业务 / 业务系统 / Web应用 -> WebApplication
业务组 / 工作组 -> BusinessGroup
自动识别应用 -> CompositeApplication
已定义应用 -> DefinedApp
应用若未限定，需要根据上下文区分 DefinedApp / WebApplication / CompositeApplication
```

### 4.2 openclaw-napm-packet-analysis

适用问题：

- 数据包、报文、抓包、原始包。
- pcap、cap、packet。
- packetsPreview、packetsDown、DownServlet。
- 构造数据包下载链接。
- 预览某 IP / IP 段 / 告警事件是否有可下载数据包。
- 下载并分析某段时间的数据包。

不适用问题：

- 普通 NAPM 指标查询。
- 业务清单、应用清单、指标清单。
- Word/PDF 报告导出。

当前已经补充的关键约束：

```text
出现“数据包/报文/pcap/packetsPreview/packetsDown/数据包情况”时，不能转成 topValues/timeValues/overview。
```

执行契约：

```json
{
  "mode": "preview_download_analyze",
  "criteria": {
    "ips": ["101.254.114.238"],
    "start": 1780882620,
    "end": 1780886220
  }
}
```

时间范围策略：

- `build_url_only` 可以直接构造链接。
- `preview_only` 用于大范围或不确定是否有包的请求。
- `preview_download` 必须先预览，有数据再下载。
- `preview_download_analyze` 用于安全时间窗口内的下载后分析。
- 如果时间范围超过 `PACKET_MAX_TIME_RANGE_SECONDS`，优先询问是否拆分窗口或先做 preview，不要切到指标查询。

认证策略：

- NetInside packet endpoint 内部请求可使用 `UserName/Password` query 参数。
- 对外展示 URL 必须脱敏为 `UserName=***&Password=***`。
- 不允许把明文密码发到企业微信。

### 4.3 openclaw-napm-report

适用问题：

- 生成报告。
- 导出 Word/docx/PDF。
- “将以上以 Word 文档给我”。
- “把刚才结果整理成报告”。

不适用问题：

- 自己重新查询 NAPM。
- 自己下载数据包。
- 自己补写数据结论。

执行契约：

```text
如果用户说“将以上导出”，优先使用最新一次有效结果的 reportData。
如果用户提出新的数据问题并要求报告，先调用 query 或 packet skill，再调用 report skill。
```

### 4.4 openclaw-napm-workflow

这是建议新增的“流程说明型 skill”，不一定直接执行 API。

适用问题：

- “查一下这个异常并生成报告”。
- “这个 IP 丢包严重，下载包分析一下”。
- “分析某业务问题，最后导出 Word”。
- 多步骤诊断任务。

它的职责是告诉 OpenClaw 如何串联已有 skill：

```text
指标异常诊断：
  1. openclaw-napm-query
  2. 解释异常
  3. 如用户要求报告，openclaw-napm-report

数据包诊断：
  1. openclaw-napm-packet-analysis preview_only
  2. 有数据且用户确认后 preview_download_analyze
  3. 如用户要求报告，openclaw-napm-report

查询后导出：
  1. 复用最近有效查询结果
  2. openclaw-napm-report
```

## 5. 插件应该保留什么

拆分后插件仍然有价值，但职责要收窄。

插件保留：

- 工具注册。
- 脚本执行。
- 输入 schema 校验。
- `resolvedQuery` 必填和结构校验。
- `packetQuery` 必填和结构校验。
- `reportData` 来源校验。
- 明文账号密码脱敏。
- 审计日志和 traceId。
- 最近一次有效结果缓存。
- 阻断危险系统操作。
- 将工具结果稳定返回给 OpenClaw。

插件逐步移除或弱化：

- 大量自然语言关键词判断。
- 业务/应用/工作组等语义规则散落在代码中。
- 数据包问题和指标问题的硬编码抢路由。
- 报告生成的自然语言重写逻辑。
- 追问语义的代码兜底。
- “没有 skill 结果就统一保护提示”的大段输出改写。

## 6. 分阶段实施方案

### 阶段一：明确 skill 边界

目标：

```text
先不大改插件，把三个已有/独立 skill 的 SKILL.md 写清楚。
```

任务：

- 更新 `openclaw-napm-query/SKILL.md`，写清指标、清单、下钻、元数据范围。
- 更新 `openclaw-napm-packet-analysis/SKILL.md`，写清数据包触发规则和禁止转指标查询。
- 更新 `openclaw-napm-report/SKILL.md`，写清只做导出，不做查询。
- 统一各 skill 的输入输出示例。

验收：

- 企业微信问“数据包情况”不再走 `topValues/timeValues/overview`。
- 企业微信问“系统中有哪些业务”仍走 query。
- 企业微信问“将以上导出 Word”仍走 report。

### 阶段二：新增 workflow skill

目标：

```text
把复杂流程从插件 routing prompt 迁到 openclaw-napm-workflow。
```

任务：

- 新建 `skills/openclaw-napm-workflow/SKILL.md`。
- 写清多 skill 编排策略。
- 写清追问继承策略。
- 写清何时先 query、何时直接 packet、何时 report。

验收：

- “查最近丢包最严重 IP，并导出报告”能按 query -> report。
- “分析这个 IP 最近一小时数据包，并生成报告”能按 packet -> report。
- “最近一天呢？”能继承上一轮对象和指标/packet 意图。

### 阶段三：瘦插件 routing context

目标：

```text
插件不再写大量业务语义规则，只写高层边界。
```

任务：

- 缩短 `buildNapmRoutingSystemContext()`。
- 删除重复且过细的关键词规则。
- 保留“必须结构化输入”“不能绕过工具”“不能泄露凭据”等安全规则。
- 将业务口径迁入 query skill。
- 将 packet 口径迁入 packet skill。
- 将 report 口径迁入 report skill。

验收：

- 插件仍能注册和执行工具。
- 旧的 P0 问题不复发：无数据和执行异常可区分、时间字段仍正确、业务/业务组不混淆。
- OpenClaw 不再频繁输出内部推理过程。

### 阶段四：工具入口标准化

目标：

```text
所有能力用清晰工具入口执行，OpenClaw 负责编排，不直接 curl/python。
```

建议工具：

```text
napm-skill-query
napm-packet-analysis
napm-report-export
```

每个工具只接受结构化输入：

```text
napm-skill-query -> resolvedQuery
napm-packet-analysis -> packetQuery
napm-report-export -> reportData / latest result reference
```

验收：

- “不用 skill 请求呢？”这类追问不会诱导 OpenClaw 直接 curl。
- 审计日志能看到当前调用的是哪个工具。
- 最终回答能说明真实调用链路，而不是编造。

### 阶段五：灰度删除旧规则

目标：

```text
等 skill 编排稳定后，再删除插件里的旧兜底规则。
```

任务：

- 建立企业微信回归用例集。
- 每删一类插件规则，跑一轮回归。
- 保留可回滚分支或备份。

推荐回归用例：

```text
系统中有哪些业务？
系统中有哪些业务组？
系统中有哪些自动识别应用？
系统中有哪些已定义应用？
最近一小时丢包最严重的前10个IP
最近一天呢？
分析 101.254.114.238 最近一天的数据包 数据情况
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
预览 101.254.114.238 最近一小时有没有可下载数据包
将以上以 Word 文档给我
查这个异常并生成报告
```

## 7. 风险与处理

### 风险一：OpenClaw 仍然不稳定选 skill

处理：

- 强化 skill 的 `description` 和 `Routing Contract`。
- 必要时保留最小插件规则：数据包关键词只允许 packet skill。
- 如果 OpenClaw 不支持稳定自动 skill 工具化，再补插件工具入口。

### 风险二：skill 文档太多导致模型读不准

处理：

- 每个 SKILL.md 开头放最关键的触发条件和反例。
- 长参考文档放到 `references/`，不要堆在主文档。
- 输入输出示例保持短、准、可复制。

### 风险三：生产审计变弱

处理：

- 插件保留 traceId 和工具调用日志。
- OpenClaw 原生日志记录 skill 调用。
- report/packet/query 脚本输出稳定 JSON。

### 风险四：拆分过程中旧问题复发

处理：

- 不一次性删除旧插件逻辑。
- 先增强 skill，再灰度瘦插件。
- 每阶段跑固定回归用例。

## 8. 推荐实施顺序

```text
1. 完成三个现有 skill 的边界文档强化。
2. 将 openclaw-napm-packet-analysis 纳入当前项目 skills 目录，保持远端同步。
3. 新建 openclaw-napm-workflow。
4. 在 OpenClaw 企业微信环境跑回归用例。
5. 确认自动 skill 编排稳定后，开始瘦插件 routing context。
6. 如自动 skill 编排仍不稳定，再给 packet/report/query 做轻量插件工具入口，而不是继续堆自然语言规则。
```

## 9. 判断标准

拆分是否成功，不看代码删了多少，而看以下行为是否稳定：

- 数据包问题只走 packet skill。
- 指标/清单/下钻问题只走 query skill。
- 报告导出只走 report skill。
- 复合问题由 OpenClaw 串联多个 skill，而不是插件硬编码流程。
- 最终回答来自真实工具结果，不来自手工 curl、python 或会话记忆。
- 账号密码不泄露。
- 每轮能从 OpenClaw/插件日志追踪真实调用链路。

## 10. 总结

当前项目不是简单“插件方式错了”或“skill 方式一定更好”，而是职责边界需要重新划清。

短期：

```text
保留插件安全边界，强化 skill 路由说明。
```

中期：

```text
新增 workflow skill，把复杂流程迁出插件。
```

长期：

```text
插件只做工具执行和治理，OpenClaw + Skill 负责语义编排。
```

这样既能保留生产稳定性，又能避免继续把 OpenClaw 的编排层手写成越来越大的规则引擎。
