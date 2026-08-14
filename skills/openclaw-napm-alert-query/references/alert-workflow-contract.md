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
- **Indirect discovery**: if `linkType=1` but the alert group is a business/application/group name (not an IP), the skill automatically performs indirect packet discovery:
  1. Queries `topValues` with the alert's categoryType group chain to find suspicious IP conversations
  2. Returns `ALERT_INDIRECT_PACKET_VIA_DISCOVERY` with candidates containing `suggestedPacketQuery`
  3. Each candidate includes IP(s), metric values, and ±bufferSeconds packet download URL

Alert to report:

- This skill returns `reportData`.
- `openclaw-napm-report` consumes `reportData`.

This skill must not download packets or generate docx files.

## Indirect Packet Discovery Contract

### Trigger conditions

- Alert `linkType` is not 2 (not event-ID-linked)
- Alert `group` is not an IP address
- Alert `categoryType` ∈ {14, 25, 63, 68} (BusinessGroup, Application, PageFamily, WebApplication)

### Discovery flow

```
alert event → shouldDiscover() → buildDiscoveryParams() → api.getJsonByParams('topValues')
  → parseTopValuesResult() → buildIndirectCandidates()
  → { available, reason: "ALERT_INDIRECT_PACKET_VIA_DISCOVERY", candidates: [...] }
```

### Packet time window

```
packetStart = alert.start - packetBufferSeconds (default 120)
packetEnd   = alert.end   + packetBufferSeconds (default 120)
```

### Options

- `discoveryEnabled` (default `true`): enable/disable indirect discovery
- `discoveryTopCount` (default `10`): number of suspicious IPs to return
- `packetBufferSeconds` (default `120`): seconds to expand before/after alert time for packet download

