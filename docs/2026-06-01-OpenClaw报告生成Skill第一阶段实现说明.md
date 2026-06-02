# OpenClaw 报告生成 Skill 第一阶段实现说明

日期：2026-06-01

## 本阶段目标

根据 `2026-05-29-OpenClaw报告生成Word-PDF-Skill落地方案.md`，先落地独立报告生成 skill 的最小闭环。

本阶段只做“结构化报告数据 -> Word 文件”的确定性渲染，不接入 OpenClaw 主编排，也不修改 NAPM 查询主链。

## 已实现内容

新增目录：

```text
skills/openclaw-napm-report/
```

新增文件：

```text
skills/openclaw-napm-report/SKILL.md
skills/openclaw-napm-report/scripts/generate_napm_report.js
skills/openclaw-napm-report/services/ReportGenerationService.js
skills/openclaw-napm-report/services/ReportTemplateService.js
skills/openclaw-napm-report/services/ReportStorageService.js
skills/openclaw-napm-report/services/PdfExportService.js
skills/openclaw-napm-report/output/.gitkeep
```

新增测试：

```text
test/napm-report-generation-service.test.js
```

新增依赖：

```text
docx
```

## 当前能力

报告 skill 现在支持：

- 从 JSON 文件或 stdin 读取结构化报告数据。
- 校验 `reportType`、`format`、`sections`。
- 生成 `.docx` 报告。
- 保存报告文件。
- 保存报告审计 JSON 副本。
- 返回结构化执行结果。
- 对 PDF 请求返回明确错误 `REPORT_PDF_EXPORT_UNAVAILABLE`，不静默降级。

## 当前不做的事

本阶段明确不做：

- 不让 report skill 调 NAPM 南向 API。
- 不让 report skill 理解自然语言。
- 不接入 plugin 工具注册。
- 不接入 OpenClaw `reportPlan` 编排。
- 不修改 `openclaw-napm-query` 的 `reportData` 输出。
- 不支持 PDF。
- 不支持用户上传 Word 模板。

## CLI 调用方式

从文件读取：

```bash
node skills/openclaw-napm-report/scripts/generate_napm_report.js --input report-input.json
```

从 stdin 读取：

```bash
cat report-input.json | node skills/openclaw-napm-report/scripts/generate_napm_report.js
```

可指定输出目录：

```bash
node skills/openclaw-napm-report/scripts/generate_napm_report.js \
  --input report-input.json \
  --outputDir ./tmp/reports \
  --downloadBaseUrl /reports
```

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
    },
    {
      "type": "table",
      "title": "丢包 Top 10",
      "columns": ["排名", "IP", "流入丢包率", "流出丢包率"],
      "rows": [[1, "192.0.2.10", "83.37%", "12.10%"]]
    }
  ],
  "audit": {
    "resolvedQueryId": "rq-test",
    "skillRunId": "skill-test",
    "apiCalls": []
  }
}
```

## 输出契约

成功：

```json
{
  "ok": true,
  "reportId": "napm-diagnostic_report-20260601-103000-abc123",
  "title": "最近一天丢包严重 IP 分析报告",
  "format": "docx",
  "filePath": ".../napm-diagnostic_report-20260601-103000-abc123.docx",
  "auditPath": ".../napm-diagnostic_report-20260601-103000-abc123.json",
  "downloadUrl": "/reports/napm-diagnostic_report-20260601-103000-abc123.docx",
  "generatedAt": "2026-06-01T10:30:00.000Z"
}
```

失败：

```json
{
  "ok": false,
  "errorCode": "REPORT_DATA_INVALID",
  "message": "报告生成失败：缺少 sections 或查询结果为空。"
}
```

## 下一阶段

下一阶段建议做 `openclaw-napm-query` 到 `reportData` 的结构化输出，而不是直接接 plugin。

推荐顺序：

1. 在 `openclaw-napm-query` 的 TopN 和综合分析结果中补齐 `reportData`。
2. 增加测试，确保 `reportData` 与真实查询结果一致。
3. 再修改 plugin schema，让 OpenClaw 在用户明确要求“生成报告/导出 Word/PDF”时构造 `reportPlan`。
4. 最后做 OpenClaw 编排：先执行 `napm-skill-query`，再调用 `openclaw-napm-report`。

这样可以避免 report skill 反向污染当前已经收口的查询主链。
