---
name: openclaw-napm-summary
description: 生成 NAPM 综述报告——按指定范围（全局/网络/业务/应用/业务组/告警）和时间范围，聚合告警、流量、业务性能等数据，输出标准 reportData 供 openclaw-napm-report 生成 docx。
---

# NAPM 综述报告技能

## Boundary

Use this skill for:
- 用户要求生成"综述报告"或"全局报告"或"summary report"
- 用户要求查看某个业务/应用/业务组的整体状况（如"生成239web的业务综述"）
- 用户要求生成日报、周报、月报形式的全局态势总览
- 用户要求"看看最近一周的整体情况"

Do not use this skill for:
- 巡检报告（定时健康检查，使用 openclaw-napm-inspection）
- 单一告警查询（使用 openclaw-napm-alert-query）
- 单一指标查询（使用 openclaw-napm-query）
- 故障排查报告（使用 openclaw-napm-packet-analysis）

## Runtime Shape

```
OpenClaw user request
  → 解析 scope（全局/业务/应用/业务组/告警）+ timeRange
  → SummaryService.run()
    ├── plan(scope, timeRange) → 查询计划
    ├── execute(plan) → 并行查询 NAPM API
    │   ├── alertsSummary + alertsSummaryTimeLine
    │   ├── timeValues（流量趋势）
    │   └── topValues（排行/钻取）
    └── aggregate(rawData, scope) → summary 数据块
  → SummaryReportDataService.buildReportData()
  → 输出 { ok, summary, scope, timeRange, reportData, narrationInput }
  → 下游 openclaw-napm-report 消费 reportData 生成 docx
```

## Input Contract

```json
{
  "scope": {
    "type": "global | webApplication | application | businessGroup | network | alert",
    "label": "全局 | 业务 | 应用 | 业务组 | 网络 | 告警",
    "target": {
      "groupType": "WebApplication",
      "groupArgument": "239web",
      "groupLabel": "239web"
    }
  },
  "timeRange": {
    "start": 1780882620,
    "end": 1780969020,
    "displayText": "2026-06-17 00:00 ~ 2026-06-18 00:00"
  },
  "format": "docx",
  "title": "可选：自定义报告标题",
  "sourceQuestion": "可选：原始用户问题"
}
```

### scope.type 说明

| type | 含义 | target 必填 |
|------|------|------------|
| `global` | 全局综述（所有维度） | 否 |
| `webApplication` | 业务综述（指定Web应用） | 是 |
| `application` | 应用综述（指定端口级应用） | 是 |
| `businessGroup` | 业务组综述 | 是 |
| `network` | 网络综述（IP/接口/会话） | 是 |
| `alert` | 告警综述 | 否 |

## CLI

```bash
node skills/openclaw-napm-summary/scripts/run_summary.js --payload '{"scope":{"type":"global","label":"全局"},"timeRange":{"start":1780882620,"end":1780969020}}'

node skills/openclaw-napm-summary/scripts/run_summary.js --queryFile ./summary-query.json

# 生成 239web 的 7 天业务综述
node skills/openclaw-napm-summary/scripts/run_summary.js --queryJson '{"scope":{"type":"webApplication","label":"业务","target":{"groupType":"WebApplication","groupArgument":"239web","groupLabel":"239web"}},"timeRange":{"start":1780272000,"end":1780876800}}'
```

## Output Contract

```json
{
  "ok": true,
  "schema": "openclaw_napm_summary_result.v1",
  "scope": { "type": "global", "label": "全局" },
  "timeRange": { "start": 1780882620, "end": 1780969020, "displayText": "..." },
  "summary": {
    "overallStatus": "warning",
    "reportDate": "2026年06月18日",
    "deviceInfo": { "systemName": "...", "ip": "...", "softwareVersion": "...", "serialNumber": "...", "uptime": "..." },
    "alertSummary": {
      "total": 45, "critical": 3, "major": 12, "minor": 30,
      "byCategory": [{ "category": "networkAlerts", "categoryLabel": "网络性能告警", "count": 20, "critical": 2, "major": 5, "minor": 13 }],
      "timeline": [{ "bucketStart": 1780882620, "critical_total": 1, "major_total": 3, "minor_total": 5 }],
      "topObjects": [{ "group": "239web", "groupType": "WebApplication", "count": 8, "critical": 1, "major": 3, "minor": 4 }],
      "unresolvedAlerts": [{ "id": "12345", "name": "吞吐量异常", "severity": 4, "severityLabel": "紧急", "categoryLabel": "网络性能告警", "group": "239web", "start": 1780882620 }]
    },
    "trafficSummary": {
      "trend": { "dataset": { "time": [...], "TPIO": [...], "unit": "bps" }, "stats": { "max": 5000000000, "avg": 2000000000, "min": 500000000, "missingPointCount": 2, "spikeCount": 3 } },
      "topIPs": [{ "IPAddress": "192.168.1.100", "TPIO": 1500000000 }],
      "topApps": [{ "WebApplication": "239web", "TPIO": 2000000000 }],
      "drillDown": { "groupType": "IPAddress", "label": "下级维度", "items": [...] }
    },
    "businessSummary": {
      "slowAccess": [{ "businessName": "/api/order", "slowCount": 320, "ratio": "4.2%", "avgPageDelayMs": 2800 }],
      "httpErrors": [{ "businessName": "/api/login", "http400": 15, "http500": 8 }]
    },
    "conclusion": null,
    "recommendations": ["..."]
  },
  "reportData": {
    "schema": "openclaw_napm_report_data.v1",
    "reportType": "summary_report",
    "templateId": "napm_summary_overview_v1",
    "format": "docx",
    "title": "Netlnside流量分析系统_全局综述报告",
    "systemName": "Netlnside流量分析系统",
    "scope": { "type": "global", "label": "全局" },
    "summary": { ... },
    "audit": { "sourceSkill": "openclaw-napm-summary", "requestHistory": [...], "queriesPerformed": [...] }
  },
  "narrationInput": {
    "schema": "openclaw_napm_summary.v1",
    "summary": { ... },
    "scope": { ... },
    "timeRange": { ... },
    "promptHint": "请根据以下全局综述数据，撰写一份专业的NAPM全局综述报告叙述。..."
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NETINSIDE_HOST` | Yes | NAPM API base URL |
| `NETINSIDE_USERNAME` | Yes | NAPM username |
| `NETINSIDE_PASSWORD` | Yes | NAPM password |
| `NETINSIDE_TLS_INSECURE` | No | Set to `true` to skip TLS verification |
| `NAPM_SUMMARY_TIMEOUT_MS` | No | Request timeout in ms (default: 60000) |

## References

- `docs/2026-06-18-综述报告设计方案.md` — 完整设计方案
- `references/summary-api-contract.md` — API 契约详情（待补充）
