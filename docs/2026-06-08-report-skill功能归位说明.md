# Report Skill 功能归位说明

日期：2026-06-08

## 目标

本次改造处理 `openclaw-napm-report`，把报告导出、数据来源、格式策略、重复发送边界等流程知识沉淀到 report skill 内。

本阶段不改报告生成实现，不删除插件中的导出执行逻辑，先完成 report skill 的能力归位。

## 修改内容

### 1. 新增 report workflow 契约

新增文件：

```text
skills/openclaw-napm-report/references/report-workflow-contract.md
```

该文件集中承载 report skill 的流程规则，包括：

- 报告触发边界。
- source data / reportData 来源契约。
- 输入结构和校验规则。
- docx / pdf 格式策略。
- section 类型建议。
- 输出契约。
- 存储和审计。
- 重复文件发送边界。
- 与 query / packet / workflow skill 的边界。

### 2. 更新 report SKILL.md

修改文件：

```text
skills/openclaw-napm-report/SKILL.md
```

新增主入口提示：

```text
references/report-workflow-contract.md
```

并补充核心 reportData 规则：

```text
reportData must come from explicit tool args, latest fresh query result, or packet analysis converted into structured sections.
sections is required and must not be empty.
Current supported output format is docx.
pdf must return REPORT_PDF_EXPORT_UNAVAILABLE.
Duplicate file delivery is an OpenClaw/plugin media dedupe concern.
```

## 已归位到 report skill 的功能

### 1. 报告触发边界

归属 report skill：

```text
生成报告
输出报告
导出报告
导出 Word / docx
导出 PDF
将以上以 Word 文档给我
把刚才结果整理成报告
形成诊断报告 / 运维报告 / 对比报告
```

### 2. 数据来源

归属 report skill 文档说明：

```text
显式 reportData
上一轮 openclaw-napm-query 返回的 reportData
openclaw-napm-packet-analysis 结果转换出的 sections
```

如果没有有效来源：

```text
返回 REPORT_DATA_NOT_FOUND
不能生成空报告
不能自己重新查询 NAPM
```

### 3. 新查询 + 报告流程

归属 report workflow 契约：

```text
用户：查最近一天丢包最严重的 IP，并导出 Word 报告
流程：
1. openclaw-napm-query
2. openclaw-napm-report
```

### 4. 数据包分析 + 报告流程

归属 report workflow 契约：

```text
用户：分析某 IP 最近一小时的数据包，并导出报告
流程：
1. openclaw-napm-packet-analysis
2. 将 packet result 转换为 reportData.sections
3. openclaw-napm-report
```

### 5. 格式策略

当前阶段：

```text
docx 支持
pdf 不启用
```

约束：

```text
word / doc 可由调用方归一为 docx
pdf 必须返回 REPORT_PDF_EXPORT_UNAVAILABLE
不能静默降级为 Word
```

### 6. 重复发送边界

归属 report workflow 契约：

```text
report skill 每次调用只生成一个报告 artifact。
同一文件重复发送是 OpenClaw/plugin 媒体发送去重问题。
不要为了解决重复发送而重复生成报告。
```

## 明确不属于 report skill 的功能

### 普通 NAPM 查询

以下不属于 report skill：

```text
指标查询
排行
趋势
均值
业务清单
应用清单
下钻路径
指标清单
```

应先走：

```text
openclaw-napm-query
```

### 数据包能力

以下不属于 report skill：

```text
数据包
报文
抓包
pcap / cap
packetsPreview
packetsDown
```

应先走：

```text
openclaw-napm-packet-analysis
```

## 验收用例

```text
将以上以 Word 文档给我
把刚才结果整理成报告
查最近一天丢包最严重的 IP，并导出 Word 报告
分析 101.254.114.238 最近一小时的数据包，并导出报告
将以上导出 PDF
```

期望：

- follow-up 导出复用上一轮有效结构化结果。
- 新数据 + 报告请求先 query/packet，再 report。
- PDF 请求返回不可用错误，不静默生成 Word。
- 同一个报告文件不应重复发送。

## 后续建议

下一步可以继续：

```text
1. 新增 openclaw-napm-workflow。
2. 将 query -> report、packet -> report 的复合流程写入 workflow skill。
3. 继续瘦插件中 report 相关长提示，只保留 reportData 校验、执行、审计和媒体去重。
```
