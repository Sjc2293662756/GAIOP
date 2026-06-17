# Alert API Contract

## Core APIs

### alertsSummary

```text
GET /webservice/NetInside?type=alertsSummary&start=<start>&end=<end>&json=true
```

Returns nested alert events:

```text
category -> alert object -> event[]
```

### alertsSummaryTimeLine

```text
GET /webservice/NetInside?type=alertsSummaryTimeLine&start=<start>&end=<end>&json=true
```

Returns:

```text
category -> bucketStart -> counts[]
```

The current frontend reads the timeline counts as `[minor, critical, major]`. Keep `rawCounts` and return a warning until backend order is confirmed.

### alertsDetail

```text
GET /webservice/NetInside?type=alertsDetail&eventids=<id1>&eventids=<id2>&start=<start>&end=<end>&json=true
```

Important: `eventids` must be repeated query parameters, not comma-joined and not `eventids[]`.

### timeValues

```text
GET /webservice/NetInside?type=timeValues&start=<start>&end=<end>&metrics=<metric>&granularity=60&numGroups=1&groupType1=<groupType>&groupArgument1=<alertObject>&json=true
```

Use this only after alert detail reveals `metrics`, `categoryType`, and `group`.

## Mappings

Severity:

- `2`: 轻微
- `3`: 重大
- `4`: 紧急

Categories:

- `networkAlerts`: 网络性能告警
- `networkIssueAlerts`: 网络异常告警
- `appAlerts`: 应用性能告警
- `busAlerts`: 业务故障告警
- `userAlerts`: 用户体验告警
- `securityAlerts`: 安全事件告警
- `AIAlerts`: 智能分析告警

categoryType to groupType:

- `0`: `TotalTraffic`
- `3`: `IPAddress`
- `14`: `BusinessGroup`
- `25`: `Application`
- `29`: `BusinessGroupLink`
- `53`: `IPConversation`
- `58`: `Interface`
- `63`: `PageFamily`
- `67`: `User`
- `68`: `WebApplication`
- `72`: `MonInterfaceGroup`

