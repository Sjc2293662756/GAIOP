# NAPM 查询能力 Skill 第一阶段拆分实施说明

日期：2026-06-08

## 本次目标

按照《2026-06-08-NAPM查询能力从插件编排拆向Skill编排方案.md》的第一阶段，先把 NAPM 能力拆成清晰的独立 skill 文件夹，并在各自 `SKILL.md` 中明确边界。

本阶段不大改插件、不新增复杂 workflow 执行器，优先让 OpenClaw 能从 skill 说明中区分：

- 普通 NAPM 查询该走 query skill。
- 数据包/报文/pcap 该走 packet skill。
- 报告导出该走 report skill。

## 当前目录结构

当前项目目录：

```text
G:\my_file\项目测试\观枢·智维平台-GAIOP\project_3\NAPM_skill
```

当前 skill 目录：

```text
skills/
  openclaw-napm-query/
  openclaw-napm-report/
  openclaw-napm-packet-analysis/
```

其中：

- `openclaw-napm-query`：原有 NAPM 查询 skill。
- `openclaw-napm-report`：原有报告生成 skill。
- `openclaw-napm-packet-analysis`：从独立目录 `project_3/openclaw-napm-packet-analysis` 纳入当前项目。

## 已完成修改

### 1. 纳入 packet analysis skill

新增当前项目目录：

```text
skills/openclaw-napm-packet-analysis
```

包含：

```text
SKILL.md
package.json
.env.example
agents/openai.yaml
references/packet-download-api.md
references/packet-analysis-runtime.md
scripts/run_packet_analysis.js
```

该 skill 已包含数据包路由契约：

```text
出现 数据包 / 报文 / 抓包 / pcap / packetsPreview / packetsDown / 数据包情况 时，
必须使用 openclaw-napm-packet-analysis，
不能转成 topValues/timeValues/averageValues/overview/BusinessGroup/DefinedApp。
```

### 2. 强化 query skill 边界

修改：

```text
skills/openclaw-napm-query/SKILL.md
```

新增 `Skill Boundary`，明确：

- 指标、排行、趋势、均值、清单、元数据、下钻、结果解释走 query skill。
- 数据包/报文/pcap/packetsPreview/packetsDown 不走 query skill。
- 报告导出不走 query skill。
- `业务`、`业务组`、`自动识别应用`、`已定义应用` 的对象口径。

关键对象口径：

```text
业务 / 业务系统 / Web应用 -> WebApplication
业务组 / 工作组 -> BusinessGroup
自动识别应用 -> CompositeApplication
已定义应用 -> DefinedApp
```

### 3. 强化 report skill 边界

修改：

```text
skills/openclaw-napm-report/SKILL.md
```

新增 `Skill Boundary`，明确：

- 只有生成报告、导出 Word/docx/PDF、将以上整理成文档时才走 report skill。
- report skill 不自行查询 NAPM。
- report skill 不自行下载/分析数据包。
- 如果用户说“将以上导出”，应复用上一轮有效结构化结果。
- 如果用户提出新数据问题并要求报告，应先调用 query 或 packet skill，再调用 report skill。

## 第一阶段验收用例

建议在企业微信中验证以下问题：

```text
系统中有哪些业务？
系统中有哪些业务组？
系统中有哪些自动识别应用？
最近一小时丢包最严重的前10个IP
分析 101.254.114.238 最近一天的数据包 数据情况
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
预览 101.254.114.238 最近一小时有没有可下载数据包
将以上以 Word 文档给我
```

期望：

- 普通 NAPM 查询仍走 `openclaw-napm-query`。
- 数据包问题走 `openclaw-napm-packet-analysis`，不再转成 `topValues/timeValues/overview`。
- 报告导出走 `openclaw-napm-report`，不重新查询。

## 尚未完成

本阶段尚未做：

- 新增 `openclaw-napm-workflow`。
- 瘦身 `napm-openclaw-plugin.remote.js`。
- 将 packet skill 注册成插件工具入口。
- 删除插件内旧的语义规则。

这些属于后续阶段。

## 下一步建议

下一阶段建议新增：

```text
skills/openclaw-napm-workflow/SKILL.md
```

用于描述复合流程，例如：

```text
查异常 -> 定位对象 -> 数据包预览/下载/分析 -> 生成报告
查询结果 -> Word/docx 导出
上一轮对象/时间/指标 -> 本轮追问继承
```

同时开始逐步压缩插件里的 routing prompt，只保留工具执行、安全校验、审计、脱敏和危险操作阻断。
