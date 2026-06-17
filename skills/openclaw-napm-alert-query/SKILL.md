---
name: openclaw-napm-alert-query
description: OpenClaw NAPM alert query skill for NetInside alert summary, timeline, detail, trigger metric series, alert notification explanation, packet handoff, and reportData generation. Use for 告警/告警事件/告警详情/告警时间线/告警通知 questions. This skill is read-only and must not add, update, or delete alert rules.
---

# OpenClaw NAPM Alert Query

Use this skill for NetInside / NAPM alert event questions.

This skill is separate from `openclaw-napm-query` because alert events have their own event model: categories, severities, event IDs, alert objects, task types, trigger conditions, notification actions, and packet handoff.

## Boundary

Use this skill for:

- 告警列表、告警摘要、告警概览。
- 告警时间线、告警数量趋势。
- 告警详情、告警事件 ID。
- 最近有哪些紧急/重大/轻微告警。
- 某对象触发了哪些告警。
- 某条告警为什么触发。
- 告警触发指标、实际值、基线、阈值条件。
- Email / SNMP / SysLog / 快照动作字段解释。
- 某条告警是否可以转数据包分析。

Do not use this skill for:

- 普通指标、排行、均值、趋势、对象清单、指标清单、下钻目录：use `openclaw-napm-query`.
- 数据包预览、下载、pcap/cap 分析：use `openclaw-napm-packet-analysis`.
- Word/docx/PDF 报告文件生成：use `openclaw-napm-report` after this skill returns `reportData`.
- 新增、修改、删除告警任务或通知配置。This stage is read-only.

## Runtime Shape

```text
OpenClaw user request
  -> structured alertQuery
  -> scripts/run_alert_query.js
  -> NetInside alertsSummary / alertsSummaryTimeLine / alertsDetail / timeValues
  -> normalized alert events
  -> narrationInput / reportData / packetHandoff
  -> OpenClaw final Chinese answer
```

## Input Contract

```json
{
  "alertQuery": {
    "mode": "summary",
    "criteria": {
      "start": 1781488800,
      "end": 1781492400,
      "severities": [4],
      "categories": ["networkAlerts"],
      "objects": ["192.168.1.16"],
      "eventIds": ["369652"],
      "metrics": ["TPIO"]
    },
    "options": {
      "includeTimeline": false,
      "includeDetail": false,
      "includeMetricSeries": false,
      "packetHandoff": true
    }
  }
}
```

Supported modes:

- `summary`: query `alertsSummary`.
- `timeline`: query `alertsSummaryTimeLine`.
- `detail`: query `alertsDetail`.
- `detail_with_timeseries`: query `alertsDetail`, then `timeValues` for trigger metrics.
- `analysis`: summary with optional timeline/detail/series.
- `explain_notification`: explain notification fields only.
- `explain_event_fields`: explain alert event fields only.

## CLI

```bash
node skills/openclaw-napm-alert-query/scripts/run_alert_query.js --queryFile ./alert-query.json
```

or:

```bash
node skills/openclaw-napm-alert-query/scripts/run_alert_query.js --queryJson "{\"alertQuery\":{\"mode\":\"summary\",\"criteria\":{\"start\":1781488800,\"end\":1781492400}}}"
```

## Output Contract

The skill returns JSON with:

- `ok`
- `mode`
- `service`
- `timeRange`
- `summary`
- `events`
- `details`
- `timeline`
- `metricSeries`
- `packetHandoff`
- `narrationInput`
- `reportData`
- `warnings`
- `error`

OpenClaw should render the final answer in Chinese from `narrationInput`, not from stale memory.

## References

- `references/alert-workflow-contract.md`
- `references/alert-api-contract.md`
- `references/alert-notification-fields.md`

