---
name: openclaw-napm-inspection
description: OpenClaw NAPM inspection snapshot skill. Use when the user asks to collect NetInside/NAPM health inspection data or generate a traffic analysis system inspection report. The skill queries NetInside with runtime UserName/Password query parameters, normalizes inspection fields, computes evidence-backed findings, and returns inspection reportData for openclaw-napm-report.
---

# openclaw-napm-inspection

This skill collects structured data for the NetInside/NAPM traffic analysis system health inspection report.

## Boundary

Use this skill for:

- 巡检报告数据采集。
- 流量分析系统健康检查报告。
- 设备基本信息、性能状况、数据信息、配置信息、原始数据包存储信息。
- 巡检报告中的总流量趋势和业务性能数据查询。

Do not use this skill to:

- Download packet files.
- Answer ordinary ad-hoc TopN or trend questions that are not part of an inspection snapshot.

## Inspection → Report Auto-Pipeline

When the user asks for an inspection report (巡检报告), **automatically generate and deliver the Word document without asking for confirmation**:

1. Run this skill (`openclaw-napm-inspection`) to collect data.
2. If `ok: true`, **immediately call `openclaw-napm-report`** with the returned `reportData` to generate a `.docx` file.
3. Return the generated docx file to the user directly.

Do NOT ask "是否需要生成Word文档" or "需要导出为Word吗" — the answer is always yes for inspection reports. The default output format is `docx`.

## Runtime Auth

The skill follows the existing NetInside API style:

```text
/webservice/NetInside?UserName={runtime user}&Password={runtime password}&type=...
```

Runtime values come from:

```text
NETINSIDE_HOST
NETINSIDE_USERNAME
NETINSIDE_PASSWORD
```

User-facing output and audit summaries must redact password values as `Password=***`.

## Data Query Contract

The skill collects:

- `applianceInfo`, `packetsInfo`, `About.jsp` for device and retention sections.
- `timeValues` with `TotalTraffic` and metrics `TPIO,TPI,TPO` for recent 1 hour and recent 1 day traffic analysis.
- `topValues` with `WebApplication` and metrics `PGSLPCT,PGNSLPGE,PGTME`, `PGHTTP400`, `PGHTTP500` for business performance.

Traffic analysis and business performance findings must come from query rows and must include `evidenceRefs` or query evidence. The report skill must only render this data; it must not re-query NAPM or invent conclusions.

## CLI

```bash
node skills/openclaw-napm-inspection/scripts/run_inspection_snapshot.js --payload '{}'
```

The CLI can also consume fixture source data:

```json
{
  "customerName": "北京烟草",
  "source": {
    "applianceInfo": {},
    "packetsInfo": {},
    "aboutHtml": "...",
    "trafficAnalysis": {},
    "businessPerformance": {}
  }
}
```

## Output

The skill returns:

```json
{
  "ok": true,
  "schema": "openclaw_napm_inspection_result.v1",
  "inspection": {},
  "reportData": {
    "schema": "openclaw_napm_report_data.v1",
    "reportType": "inspection_report",
    "templateId": "napm_traffic_health_inspection_v1",
    "format": "docx",
    "inspection": {},
    "sections": [
      { "type": "inspection", "title": "巡检报告", "dataPath": "inspection" }
    ]
  }
}
```
