---
name: openclaw-napm-report
description: OpenClaw NAPM report generation skill. Use when the user explicitly asks to generate or export a report, Word/docx, or PDF from existing NAPM query or packet-analysis results. The skill consumes structured reportData or structured sourceResult and generates audited docx artifacts; it does not query NAPM or download packets.
---

# openclaw-napm-report

OpenClaw NAPM 报告生成 skill。该 skill 只消费已经由 NAPM 查询链路产出的结构化报告数据，并生成 Word/PDF 报告文件。

详细的导出触发、数据来源、输入校验、格式策略、重复发送边界和跨 skill 编排规则见：

```text
references/report-workflow-contract.md
```

## Skill Boundary

Use this skill only when the user explicitly asks to generate or export a report file, including:

- 生成报告。
- 导出 Word / docx / PDF。
- 将以上以 Word 文档给我。
- 把刚才结果整理成报告。
- 输出诊断报告文件。

Do not use this skill to query or analyze fresh NAPM data by itself:

- 指标、排行、趋势、业务清单、下钻路径 -> use `openclaw-napm-query` first.
- 数据包、报文、抓包、pcap/cap、packetsPreview、packetsDown -> use `openclaw-napm-packet-analysis` first.

Follow-up export contract:

- If the user says `将以上导出` / `把刚才结果导出成 Word`, reuse the latest valid structured result from the previous query or packet analysis.
- If the user asks a new data question and asks for a report in the same turn, OpenClaw should first call the relevant query/packet skill, then call this report skill with the returned structured report data.
- This skill must not silently re-query NAPM, invent sections, or generate a report without structured `sections`.

Core report-data contract:

- `reportData` must come from explicit tool args, latest fresh query result, or packet analysis converted into structured sections.
- `sections` is required and must not be empty.
- Current supported output format is `docx`.
- `pdf` must return `REPORT_PDF_EXPORT_UNAVAILABLE`; do not silently generate Word for a PDF request.
- Duplicate file delivery is an OpenClaw/plugin media dedupe concern, not a reason to regenerate the report.

## 职责

- 接收 `reportType`、`format`、`title`、`timeRange`、`sections`、`audit` 等结构化输入。
- 第一阶段支持生成 `.docx`。
- 保存报告文件和审计 JSON 副本。
- 返回 `reportId`、`filePath`、`downloadUrl`、`generatedAt` 等结构化结果。

## 禁止事项

- 不接收自然语言问题后自行理解查询意图。
- 不直接调用 NAPM 南向 API。
- 不绕过 `openclaw-napm-query` 查询真实数据。
- 不在 PDF 不可用时静默降级为 Word。
- 不生成没有结构化 `sections` 的报告。
- 不为了解决重复发送问题重复生成同一份报告。

## 输入契约

```json
{
  "reportType": "diagnostic_report",
  "format": "docx",
  "title": "最近一天丢包严重 IP 分析报告",
  "sourceQuestion": "生成最近一天丢包最严重 IP 的分析报告",
  "timeRange": {
    "displayText": "最近一天",
    "start": 1779925800,
    "end": 1780012200
  },
  "dataSource": {
    "system": "NAPM",
    "queryService": "topValues",
    "objectType": "IPAddress",
    "metrics": ["PLI", "PLO"]
  },
  "sections": [
    {
      "type": "summary",
      "title": "核心结论",
      "content": "最近一天丢包最严重的 IP 为 ..."
    }
  ],
  "audit": {
    "resolvedQueryId": "xxx",
    "skillRunId": "xxx",
    "apiCalls": []
  }
}
```

## 输出契约

成功：

```json
{
  "ok": true,
  "reportId": "napm-report-20260601-103000-abc123",
  "title": "最近一天丢包严重 IP 分析报告",
  "format": "docx",
  "filePath": "/home/netinside/.openclaw/reports/napm-report-20260601-103000-abc123.docx",
  "downloadUrl": "/reports/napm-report-20260601-103000-abc123.docx",
  "generatedAt": "2026-06-01T10:30:05.000+08:00"
}
```

失败：

```json
{
  "ok": false,
  "errorCode": "REPORT_DATA_INVALID",
  "message": "报告生成失败：缺少 sections 或查询结果为空"
}
```

## Inspection Report

`openclaw-napm-report` now supports `reportType: "inspection_report"` with `templateId: "napm_traffic_health_inspection_v1"`.

This report type must consume `inspection` data produced by `openclaw-napm-inspection`. The report skill renders device status, data retention, configuration, packet storage, traffic trend datasets, business performance findings, and query evidence. It must not call NetInside APIs or create traffic/business conclusions without evidence from the inspection payload.

## CLI

```bash
node skills/openclaw-napm-report/scripts/generate_napm_report.js --input report-input.json
```

也支持从 stdin 读取 JSON：

```bash
cat report-input.json | node skills/openclaw-napm-report/scripts/generate_napm_report.js
```
