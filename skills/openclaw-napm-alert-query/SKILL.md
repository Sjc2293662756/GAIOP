---
name: openclaw-napm-alert-query
description: OpenClaw NAPM alert query primitive for NetInside alert summary, timeline, detail, trigger metric series, notification explanation, packet handoff, and reportData generation. Use directly for ordinary alert questions. Combined 告警数据包 requests with eventId must use openclaw-napm-alert-packet-analysis, which calls this Skill internally with mode=detail and bounded retries. This Skill is read-only and must not add, update, or delete alert rules.
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
- 告警事件关联的数据包诊断：use `openclaw-napm-alert-packet-analysis`; do not manually sequence tools.
- Word/docx/PDF 报告文件生成：use `openclaw-napm-report` after this skill returns `reportData`.
- 新增、修改、删除告警任务或通知配置。This stage is read-only.

### "告警数据包" Internal Primitive Boundary

When the user says "告警数据包" or "分析告警 <eventId> 的数据包", OpenClaw must call `openclaw-napm-alert-packet-analysis` once:

```
OpenClaw -> openclaw-napm-alert-packet-analysis
  -> this Skill internally with mode=detail and fixed eventId/start/end
  -> bounded detail visibility retry
  -> existing openclaw-napm-packet-analysis internally with suggestedPacketQuery
```

Do not call this Skill directly from the model for the combined workflow, and do not ask the model to perform the second step. The composite runtime consumes `packetHandoff` itself. The packet Skill's `criteria.id` only works for trusted `linkType=2` handoffs.

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
      "discoveryTopCount": 5,
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

当告警的 `categoryType` 在下表中时，告警的 `group` 是对象名而非 IP，无法直接下载数据包。此时 skill 自动执行 **indirect packet discovery**：

1. 根据 `categoryType` 选择下钻路径
2. 用告警的 trigger metric 作为排序指标（空时用默认 topMetric）
3. 调用 `topValues` 查询告警时段内嫌疑 IP 会话 Top5
4. 返回每个嫌疑 IP 的数据包下载链接（告警时间 ± bufferSeconds）

### 下钻路径映射（完整）

| categoryType | 对象类型 | group chain | 默认 topMetric | 结果格式 |
|---|---|---|---|---|
| 68 | WebApplication | WebApplication→ClientIPs→IPAddress | PGNPGE | 单个 IP |
| 63 | PageFamily | PageFamily→ClientIPs→IPAddress | PGNPGE | 单个 IP |
| 51 | DefinedApp (原OtherApp) | DefinedApp→IPConversations→IPConversation | TPIO | IP\|IP |
| 25 | Application/DefinedApp | DefinedApp→IPConversations→IPConversation | TPIO | IP\|IP |
| 56 | OtherApp | OtherApp→IPConversations→IPConversation | TPIO | IP\|IP |
| 14 | BusinessGroup | BusinessGroup→IPConversations→IPConversation | TPIO | IP\|IP |
| 27 | ConnectedBusinessGroup | ConnectedBusinessGroup→IPConversations→IPConversation | TPIO | IP\|IP |
| 29 | BusinessGroupLink | BusinessGroupLink→IPConversations→IPConversation | TPIO | IP\|IP |

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
    "topCount": 5
  },
  "candidates": [
    {
      "rank": 1,
      "ip": "10.1.1.5",
      "metricValue": { "PGNPGE": 1560 },
      "suggestedPacketQuery": {
        "mode": "preview_download_analyze",
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
| `options.discoveryTopCount` | `5` | 返回的 TopN 嫌疑 IP 数量 |
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
- `displayText`          ← ★ **最终输出文本，原样使用，禁止修改、总结、重排**
- `narrationInput`
- `reportData`
- `warnings`
- `error`

### ⚠️ displayText — 最终展示文本（skill 生成的格式化输出）

`narrationInput.displayText` 是 skill 预生成的完整展示文本。**AI 必须将其作为最终回复原样输出，禁止修改、总结、重排、翻译或添加额外内容**。

格式示例（summary 模式）：
```
2026/7/9 12:08:00 至 2026/7/9 16:55:00 告警查询结果

告警总数：3308 条
  🔴 紧急 2194 条  |  🟠 重大 461 条  |  🟢 轻微 653 条

**① 网络告警 — 93 条（🔴 34 / 🟠 12 / 🟢 47）**

# 网络工作组延时增大触发（🔴 紧急）

对象 **NetInsideNAPM** 触发了 **26** 次告警，持续时长为 **34** 分钟，开始时间为 **2026-07-09 16:40**。

---

# 网络工作组延时增大触发（🟠 重大）

对象 **Windows** 系统触发了 **1** 次告警，持续时长为 **1** 分钟，开始时间为 **2026-07-09 12:08**。

**② 异常告警 — 15 条（🔴 0 / 🟠 0 / 🟢 15）**

# 数据库上传数据异常监控触发（🟢 轻微）

对象 **101.254.114.237** 触发了 **15** 次告警，持续时长为 **1360** 分钟，开始时间为 **2026-07-09 16:30**。

**③ 应用告警 — 3200 条（🔴 2160 / 🟠 449 / 🟢 591）**
   ...

**④ 业务告警 — 0 条（🔴 0 / 🟠 0 / 🟢 0）**
   无告警记录
   ...

告警查询完成。
```

**格式规则**：
- 全 7 类别展示，空类别显式标注"无告警记录"
- 类别汇总行（序号、类别、总数和严重程度统计）整体使用 Markdown 加粗
- 同类下按"告警名称 + 严重级别"分组聚合，组间 `---` 分隔
- 每组显示：对象、触发次数、总持续时长、首次开始时间
- 🟢 用于轻微级别

AI 收到 `displayText` 后的行为：**直接返回给用户，一字不改**。不要生成自己的摘要、表格或列表。

### packetInstruction 动作指令

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

## References

- `references/alert-workflow-contract.md`
- `references/alert-api-contract.md`
- `references/alert-notification-fields.md`
