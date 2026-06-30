---
name: openclaw-napm-alert-query
description: OpenClaw NAPM alert query skill for NetInside alert summary, timeline, detail, trigger metric series, alert notification explanation, packet handoff, and reportData generation. Use for 告警/告警事件/告警详情/告警时间线/告警通知/告警数据包 questions. When the user says "告警数据包 <eventId>" or "分析告警的数据包", this skill MUST be called FIRST — it performs automatic indirect IP discovery for business/app/group alerts and returns packetHandoff with download candidates. Only after this skill returns should openclaw-napm-packet-analysis be called. This skill is read-only and must not add, update, or delete alert rules.
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
- 业务/应用/工作组告警的间接数据包发现（自动查询嫌疑 IP 会话）。
- 某条告警触发时，哪些 IP 的会话导致了指标异常。

Do not use this skill for:

- 普通指标、排行、均值、趋势、对象清单、指标清单、下钻目录：use `openclaw-napm-query`.
- 纯数据包预览、下载、pcap/cap 分析（不涉及告警事件 ID）：use `openclaw-napm-packet-analysis`.
- Word/docx/PDF 报告文件生成：use `openclaw-napm-report` after this skill returns `reportData`.
- 新增、修改、删除告警任务或通知配置。This stage is read-only.

### ⚠ "告警数据包" Cross-Skill Sequencing

When the user says "告警数据包" or "分析告警 <eventId> 的数据包"，this is a **sequenced two-step flow**:

```
Step 1: THIS skill (alert-query) FIRST
  → mode=detail, eventIds=[<id>]
  → get alert detail + packetHandoff (including indirect discovery if applicable)

Step 2: openclaw-napm-packet-analysis SECOND
  → use resolved IPs/event IDs from packetHandoff.candidates
```

DO NOT skip Step 1. The packet skill's `criteria.id` only works for `linkType=2` alerts.
For `linkType=1` business/app/group alerts, this skill performs automatic indirect IP
discovery before handing off to packet-analysis.

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
      "packetHandoff": true,
      "discoveryEnabled": true,
      "discoveryTopCount": 10,
      "packetBufferSeconds": 120
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

## Indirect Packet Discovery（间接数据包发现）

当告警的 `categoryType` 属于业务(68)/应用(25)/工作组(14)/页面(63)时，告警的 `group` 是业务名而非 IP，无法直接下载数据包。此时 skill 自动执行 **indirect packet discovery**：

1. 根据 `categoryType` 选择下钻路径
2. 用告警的 trigger metric 作为排序指标
3. 调用 `topValues` 查询告警时段内嫌疑 IP 会话 TopN
4. 返回每个嫌疑 IP 的数据包下载链接（告警时间 ± bufferSeconds）

### 下钻路径映射

| categoryType | group chain | 默认 topMetric | 结果格式 |
|---|---|---|---|
| 68 (WebApplication) | WebApplication→ClientIPs→IPAddress | PGNPGE | 单个 IP |
| 25 (Application) | DefinedApp→IPConversations→IPConversation | TPIO | IP\|IP |
| 14 (BusinessGroup) | BusinessGroup→IPConversations→IPConversation | TPIO | IP\|IP |
| 63 (PageFamily) | PageFamily→ClientIPs→IPAddress | PGNPGE | 单个 IP |

### 输出结构

```json
{
  "available": true,
  "reason": "ALERT_INDIRECT_PACKET_VIA_DISCOVERY",
  "eventId": "369652",
  "discoveryMethod": {
    "type": "topValues",
    "groupChain": "WebApplication→ClientIPs→IPAddress",
    "topMetric": "PGNPGE",
    "topCount": 10
  },
  "candidates": [
    {
      "rank": 1,
      "ip": "10.1.1.5",
      "metricValue": { "PGNPGE": 1560 },
      "suggestedPacketQuery": {
        "mode": "build_url_only",
        "criteria": {
          "ips": ["10.1.1.5"],
          "start": 1782443940,
          "end": 1782447780
        }
      }
    }
  ],
  "bufferSeconds": 120
}
```

### 配置项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `options.discoveryEnabled` | `true` | 间接发现子开关 |
| `options.discoveryTopCount` | `10` | 返回的 TopN 嫌疑 IP 数量 |
| `options.packetBufferSeconds` | `120` | 数据包下载的前后扩展秒数 |

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
- `packetInstruction`    ← **AI 必须遵循的直接指令**（action + message + callPacketAnalysis）
- `narrationInput`
- `reportData`
- `warnings`
- `error`

`packetInstruction` 是 narrationInput 中的关键字段，直接告诉 AI 下一步操作：

| action | callPacketAnalysis | 含义 |
|--------|-------------------|------|
| `STOP_NO_PACKET` | false | 无数据包，不得调 packet-analysis |
| `STOP_DISCOVERY_EMPTY` | false | 间接发现为空 |
| `STOP_DISCOVERY_FAILED` | false | 间接发现失败 |
| `USE_CANDIDATES` | true | 逐条展示候选 IP，用 suggestedPacketQuery 调 packet-analysis |
| `USE_DIRECT_QUERY` | true | 直接路径，用 suggestedPacketQuery 调 packet-analysis |

AI 必须读取 `packetInstruction.action` 和 `packetInstruction.callPacketAnalysis`，
不得自行判断是否调用 packet-analysis。

OpenClaw should render the final answer in Chinese from `narrationInput`, not from stale memory.

## References

- `references/alert-workflow-contract.md`
- `references/alert-api-contract.md`
- `references/alert-notification-fields.md`

