# Alert Workflow Contract

OpenClaw constructs `alertQuery`; this skill executes it.

## Modes

- `summary`: list and aggregate alert events.
- `timeline`: aggregate alert counts over time.
- `detail`: fetch one or more alert event details.
- `detail_with_timeseries`: fetch details and trigger metric series.
- `analysis`: summary plus optional timeline/detail/series.
- `explain_notification`: explain notification configuration fields.
- `explain_event_fields`: explain alert event fields.

## Time Contract

Executable modes require root-level `criteria.start` and `criteria.end` Unix-second timestamps.

`criteria.start` and `criteria.end` may be millisecond timestamps; the skill normalizes obvious milliseconds to seconds.

## Follow-up Contract

OpenClaw should inherit:

- event ID for “这个告警 / 详情 / 为什么”.
- time range for follow-up detail and packet analysis.
- packetHandoff for “相关数据包”.
- reportData for “导出报告”.

If multiple alert events are plausible and the user asks “这个告警”, OpenClaw should ask the user to choose an event ID.

## Cross-Skill Contract

Alert to packet:

- `linkType=2`: hand off `criteria.id=<eventId>`.
- `linkType=1`: if the alert group is an IP, hand off `criteria.ips=[group]`.

Alert to report:

- This skill returns `reportData`.
- `openclaw-napm-report` consumes `reportData`.

This skill must not download packets or generate docx files.

