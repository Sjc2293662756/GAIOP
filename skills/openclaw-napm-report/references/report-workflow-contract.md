# NAPM Report Workflow Contract

This document contains report-specific workflow rules that belong to `openclaw-napm-report`.

## GAIOP formal archive adaptation (2026-07-16)

- New report artifacts are written as a pair beneath `GAIOP_REPORTS_DIR/<sourceUserId or _unattributed>/<reportType>/`.
- Audit JSON carries `relativeFilePath` and `relativeAuditPath`; absolute host paths are not an Admin integration field.
- `sourceUserId`, `sourceSessionId`, and `dataSourceId` may only enter a Web-generated report through a verified GAIOP provenance envelope. Missing trusted user ownership uses `_unattributed` and remains administrator-only in Admin.
- The Admin BFF signs v2 provenance with the active data-source ID. The plugin accepts v1 only for compatibility and must not infer ownership from a channel account, filename, or process user.
- The deployment template defines `GAIOP_REPORTS_DIR` plus the provenance enable flag and signing-key placeholder. The directory is controlled by deployment; the key is injected only through the secret store and never committed.
- Shared-volume deployment, signature-key provisioning, and real Gateway metadata propagation remain deployment-stage work; this document does not authorize a server change.

OpenClaw owns natural-language understanding, follow-up inheritance, deciding whether a report is requested, and sequencing query/packet skills before report export. This skill owns report input validation, docx generation, file storage, audit JSON storage, and machine-readable export result output.

## 1. Accepted Scope

Use this skill only when the user explicitly asks for a report artifact:

- 生成报告
- 输出报告
- 导出报告
- 导出 Word / docx
- 导出 PDF
- 将以上以 Word 文档给我
- 把刚才结果整理成报告
- 形成诊断报告 / 运维报告 / 对比报告

Do not use this skill for:

- Fresh NAPM metric/query execution. Use `openclaw-napm-query` first.
- Packet preview/download/analysis. Use `openclaw-napm-packet-analysis` first.
- Natural-language-only summaries when the user did not ask for a file.
- Inventing report sections without structured source data.

Hard boundary:

```text
This skill does not query NAPM and does not download packets.
It only converts structured reportData into a file artifact.
```

## 2. Source Data Contract

The report input must come from one of:

- Explicit `reportData` passed by OpenClaw/tool args.
- Latest fresh `reportData` from `openclaw-napm-query`.
- Structured packet analysis output converted by OpenClaw into report sections.

If no valid source data exists:

```text
Return REPORT_DATA_NOT_FOUND or ask the user to complete a query/packet analysis first.
Do not create an empty report.
```

Follow-up export:

```text
User: 将以上以 Word 文档给我
Expected: reuse the latest valid structured result; do not re-query unless the user changed data scope.
```

New data + report in one request:

```text
User: 查最近一天丢包最严重的 IP，并导出 Word 报告
Expected:
  1. OpenClaw calls openclaw-napm-query.
  2. OpenClaw passes returned reportData to openclaw-napm-report.
```

Packet analysis + report:

```text
User: 分析 101.254.114.238 最近一小时的数据包，并导出报告
Expected:
  1. OpenClaw calls openclaw-napm-packet-analysis.
  2. OpenClaw converts packet result into reportData.sections.
  3. OpenClaw calls openclaw-napm-report.
```

## 3. Input Contract

Required input shape:

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
    "sourceSkill": "openclaw-napm-query",
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
    "traceId": "xxx",
    "sourceSkillRunId": "xxx",
    "apiCalls": []
  }
}
```

Validation rules:

- `reportType` is required.
- Supported report types: `quick_report`, `diagnostic_report`, `comparative_report`, `operation_report`.
- `format` is required.
- Currently supported format: `docx`.
- `sections` is required and must not be empty.
- Each section must be an object.
- Each section must include `type`.
- `table` sections must include array `rows`.

## 4. Format Policy

Current stage:

```text
docx is supported.
pdf is not enabled.
```

Rules:

- `word` and `doc` may be normalized to `docx` by the caller/plugin.
- If the user asks for `pdf`, return `REPORT_PDF_EXPORT_UNAVAILABLE`.
- Do not silently generate Word when the user asked for PDF.
- Do not claim PDF was generated unless `format=pdf` is actually supported.

### Template coverage note (2026-07-18)

`quick_report` does not use a dedicated business template. It is exported through a lightweight DOCX renderer that writes the supplied structured context as a title, optional question/time-range metadata, section paragraphs, simple tables, and lists. This is intentionally distinct from fixed inspection, summary, and diagnostic layouts, while still producing the same paired formal archive artifacts.

`comparative_report` and `operation_report` do not yet have a verified renderer. They must not be presented as producible Word report types until a renderer and archive test are added.

Product scope decision (2026-07-18): defer both report types. `comparative_report` needs a confirmed multi-object or multi-time-range comparison workflow; `operation_report` overlaps with the existing inspection report and needs a separate business definition before implementation. Do not start either implementation or expose a new user action until that later confirmation.

## 5. Report Sections

Recommended section types:

- `summary`: human-readable conclusion.
- `table`: tabular result rows.
- `finding`: anomaly or key observation.
- `analysis`: longer diagnostic explanation.
- `recommendation`: operational advice.
- `metadata`: query/runtime context.

Query result report should include:

- Source question.
- Time range.
- Object scope.
- Metrics.
- Key rows or top values.
- Interpretation.
- Limitations or empty-data explanation when applicable.

Packet analysis report should include:

- Source question.
- Time range.
- Target IP/IP range/event.
- Preview status.
- Download status or artifact reference.
- Protocol distribution.
- Endpoints/conversations.
- DNS/HTTP/TLS highlights when present.
- Tooling notes such as tshark availability.

## 6. Output Contract

Successful output:

```json
{
  "ok": true,
  "reportId": "napm-report-20260601-103000-abc123",
  "title": "最近一天丢包严重 IP 分析报告",
  "format": "docx",
  "fileName": "napm-report-20260601-103000-abc123.docx",
  "relativeFilePath": "user-id/quick_report/napm-report-20260601-103000-abc123.docx",
  "relativeAuditPath": "user-id/quick_report/napm-report-20260601-103000-abc123.json",
  "generatedAt": "2026-06-01T10:30:05.000+08:00"
}
```

Failure output:

```json
{
  "ok": false,
  "errorCode": "REPORT_DATA_INVALID",
  "message": "报告生成失败：缺少 sections 或查询结果为空"
}
```

## 7. Storage and Audit

The skill should:

- Write the report file.
- Write an audit JSON copy beside the report.
- Keep absolute `filePath` and `auditPath` only inside the server process when needed for file I/O. Return a public result with report identity, title, format, and file name; the browser downloads through Admin report management.

The report audit JSON should preserve:

- Original report input.
- `reportId`.
- `fileName`, `relativeFilePath`, and `relativeAuditPath`.
- `generatedAt`.

## 8. Duplicate File Sending

The report skill generates one report artifact per invocation.

OpenClaw/plugin should avoid sending the same media/file twice in the same conversation turn or within a short dedupe window.

If duplicate file sends occur:

- Treat it as an OpenClaw/plugin media delivery concern, not a report generation concern.
- Do not regenerate the same report to fix duplicate sending.
- Use outgoing media dedupe in the runtime layer.

## 9. Boundary With Other Skills

Query boundary:

- If the user asks a data question and report export in the same turn, query first with `openclaw-napm-query`.
- This report skill receives query result data, not raw user intent.

Packet boundary:

- If the user asks packet analysis and report export in the same turn, packet analysis first with `openclaw-napm-packet-analysis`.
- This report skill receives packet analysis sections, not raw packet criteria.

Workflow boundary:

- Multi-step orchestration belongs to OpenClaw or future `openclaw-napm-workflow`.
- This report skill should remain a pure artifact generator.

## 10. Anti-Patterns

- Do not call NetInside APIs from this skill.
- Do not download packet files from this skill.
- Do not generate reports from raw prompt only.
- Do not create an empty report when `sections` is missing.
- Do not silently downgrade PDF to Word.
- Do not send the same file twice to compensate for runtime delivery issues.
