# Packet Download API

NetInside packet download normally follows:

```text
packetsPreview -> packetsDown
```

`packetsPreview` checks whether matching packets exist:

```text
GET /webservice/NetInside?type=packetsPreview
```

The skill also treats this response as a download-risk preview. When the response exposes packet count, estimated packet size, endpoint distribution, or traffic distribution, the skill normalizes those fields into:

```text
preview.overview
preview.risk
```

Important distinction:

| Field | Meaning |
|---|---|
| `preview.responseBytes` | Size of the preview API response body. This is not the pcap size. |
| `preview.overview.estimatedBytes` | Estimated downloadable packet size, only when the API returns a compatible field. |
| `preview.overview.packetCount` | Estimated packet count, only when the API returns a compatible field. |
| `preview.risk.level` | `low`, `medium`, `high`, or `unknown`. |
| `preview.risk.recommendation` | `CONTINUE_DOWNLOAD`, `CONFIRM_DOWNLOAD`, or `SUGGEST_NARROW_TIME_RANGE`. |

If risk recommendation is not `CONTINUE_DOWNLOAD`, the caller should not download automatically.

`packetsDown` downloads the packet file:

```text
GET /webservice/NetInside?type=packetsDown
```

Common parameters:

| Parameter | Meaning |
|---|---|
| `ips` | One or more IP conditions. Repeat the parameter for multiple IPs. |
| `ipRanges` | IP range such as `192.168.1.1-192.168.1.100`. |
| `id` | Alert event record ID. |
| `top` | Top count condition. |
| `start` | Unix seconds. |
| `end` | Unix seconds. |
| `json` | Always `true` for frontend-compatible URLs. |

At least one of `ips`, `ipRanges`, `id`, or `top` is normally required. `start` and `end` are normally required.

The page parameter `iprangs` is not the API parameter. Normalize it to `ipRanges` when calling the API directly.

`packetsDown` returns a file stream. Do not parse it as JSON even when `json=true` is present.

## Authentication Query Parameters

Direct NetInside packet and analysis requests may require query authentication:

```text
UserName={runtime user}
Password={runtime password}
```

The skill injects these from `NETINSIDE_USERNAME` and `NETINSIDE_PASSWORD` when `PACKET_AUTH_QUERY_PARAMS=true` (default). User-facing URLs must keep `UserName` visible when present and redact `Password` as `***`.

## DownServlet

Some right-click downloads use:

```text
GET /webservice/DownServlet?moduleKey=Ipv&groupId=45&rtClickId={downloadId}&start={start}&end={end}&instanceId=PATH1/{resultName}
```

Defaults from the current frontend:

| Parameter | Default |
|---|---|
| `moduleKey` | `Ipv` |
| `groupId` | `45` |

`rtClickId` can be obtained from:

```text
GET /webservice/NetInside?type=downloadId&json=true
```

`instanceId` usually has the form `PATH1/{resultName}`. If the user provides a table-cell value like `xxx##abc`, use the part after `##` and prefix it with `PATH1/`.

For current business packet analysis, use fixed defaults unless the caller explicitly provides different values:

| Parameter | Default |
|---|---|
| `moduleKey` | `Ipv` |
| `groupId` | `45` |
| `rtClickId` | `5` |

## Business Packet DownServlet Resolution

Business packet analysis does not usually start with `ips`, `ipRanges`, or a complete `instanceId`. It starts from a Web application/business object, then resolves the exact page visit object to download.

The deterministic v3 chain is:

```text
topValues(WebApplication)
  -> topValues(WebApplication + PageFamilies + PageFamily)
  -> pageViews(pageFamilyId)
  -> DownServlet(instanceId=PATH1/{pageFamilyDetailId})
```

Step 1, list/select business objects:

```text
GET https://{host}/webservice/NetInside?UserName={userName}&Password={password}&type=topValues&numGroups=1&groupType1=WebApplication&start={start}&end={end}&metrics=PGNPGE,PGTME,PGNSLPGE,PGSLPCT,PGHTTP400,PGHTTP500&topMetric=PGNPGE&topCount=20&json=true
```

Step 2, query page-family/page error analysis for the selected business:

```text
GET https://{host}/webservice/NetInside?UserName={userName}&Password={password}&type=topValues&numGroups=3&groupType1=WebApplication&groupArgument1={businessName}&groupType2=PageFamilies&groupType3=PageFamily&metrics=PGNPGE,PGNOBJE,PGHTTP200,PGHTTP300,PGHTTP400,PGHTTP500&start={start}&end={end}&topMetric=PGHTTP500&topCount=5&json=true
```

Read the selected row's `groupPath`, then parse the page-family ID from the `page` segment:

```text
...>pages>page 8573007/http://...
```

Use:

```text
page\s+(\d+)/
```

Step 3, query page visit details:

```text
GET https://{host}/webservice/NetInside?UserName={userName}&Password={password}&type=pageViews&start={start}&end={end}&csv=true&pageFamilyId={pageFamilyId}&maxLimit=undefined
```

Although `csv=true` is used, the endpoint may return JSON arrays in this workflow. Select a page visit row and read `pageFamilyDetailId`.

Step 4, build the direct download URL:

```text
GET https://{host}/webservice/DownServlet?moduleKey=Ipv&groupId=45&rtClickId=5&start={start}&end={end}&instanceId=PATH1/{pageFamilyDetailId}
```

Supported shortcuts:

| Caller provides | Skill behavior |
|---|---|
| `businessName` | Run the full four-step resolution chain. |
| `pageFamilyId` | Skip business/page-family selection and start from `pageViews`. |
| `pageFamilyDetailId` or `resultName` | Build `instanceId=PATH1/{value}` directly. |
| Full `instanceId` | Use it directly, preserving the `PATH1/` prefix. |
