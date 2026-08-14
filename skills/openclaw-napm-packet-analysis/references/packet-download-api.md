# Packet Download API

NetInside packet download normally follows:

```text
packetsPreview -> packetsDown
```

`packetsPreview` checks whether matching packets exist:

```text
GET /webservice/NetInside?type=packetsPreview
```

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

## Runtime authentication

Some NetInside deployments reject HTTP Basic authentication for `packetsPreview` and `packetsDown` but accept the configured `UserName` and `Password` query parameters. The runtime may attach credentials from `.env` only to the private request URL. Generated URLs, masked URLs, logs, structured results, and final replies must remain credential-free.

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
