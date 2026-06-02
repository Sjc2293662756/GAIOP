# openclaw-napm-report

OpenClaw NAPM 报告生成 skill。该 skill 只消费已经由 NAPM 查询链路产出的结构化报告数据，并生成 Word/PDF 报告文件。

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

## CLI

```bash
node skills/openclaw-napm-report/scripts/generate_napm_report.js --input report-input.json
```

也支持从 stdin 读取 JSON：

```bash
cat report-input.json | node skills/openclaw-napm-report/scripts/generate_napm_report.js
```
