---
name: openclaw-napm-packet-analysis
description: Standalone OpenClaw skill for NetInside / NAPM packet download and packet-file analysis. Use when OpenClaw needs to preview downloadable packets, build or explain packetsDown URLs, download packets by IP/IP range/linkType=2 event ID/top condition, explain or use DownServlet URLs, analyze local pcap/cap files, or summarize packet-level evidence with tshark/capinfos. ⚠️ ROUTING GUARD: If the user provides an alert event ID and asks for packet analysis ("告警数据包 <id>"), do NOT use this skill directly. Route to openclaw-napm-alert-query FIRST — it performs automatic IP discovery for business/app/group alerts and returns packetHandoff candidates. Only use this skill AFTER alert-query returns candidates with suggestedPacketQuery. Packet endpoints may require UserName and Password query parameters from runtime credentials; final replies must keep UserName visible when present and redact Password and other secrets.
---

# OpenClaw NAPM Packet Analysis

Use this skill for packet download and packet-file analysis. Keep natural-language understanding in OpenClaw; pass this skill a structured packet query.

Primary entry:

```bash
node scripts/run_packet_analysis.js --queryFile ./query.json
```

For detailed routing, mode selection, time-window policy, preview/download/analyze flow, authentication redaction, failure handling, and cross-skill boundary rules, load `references/packet-workflow-contract.md` when the user request requires packet workflow construction or troubleshooting.

## Routing Contract

Priority routing rules:

- Data packet, packet capture, pcap/cap, packetsPreview, packetsDown, DownServlet, pageViews, and business page packet preview requests must use this skill.
- If the user provides a Web page URL/path such as `http://101.254.114.238/SDK/webLanguage` and asks for packet preview or packet analysis, treat it as a business page packet preview.
- Business page packet preview must use `downloadType: "DownServlet"` and `mode: "preview_only"` with `criteria.page` or `criteria.pageUrl`; if known, also include `criteria.businessName` or `criteria.pageFamilyId`.
- Do not extract the IP from a Web page URL and call ordinary IP `packetsPreview` unless the user explicitly asks to query by IP.
- Business page preview means NetInside `type=pageViews&json=true&pageFamilyId=...` candidate rows. It is not ordinary `packetsPreview` and does not estimate pcap size.

Use this skill, not NAPM metric/query skills, whenever the user asks about:

- 数据包、报文、抓包、抓取包、下载包、下载数据包、包详情、原始包。
- pcap、cap、packet、packetsPreview、packetsDown、DownServlet。
- 分析某个 IP / IP 段 / 告警事件在某个时间范围内的“数据包情况”。

Do not reinterpret packet requests as `topValues`, `timeValues`, `averageValues`, `overview`, `BusinessGroup`, `DefinedApp`, or ordinary NAPM metric queries. For example, the request `分析 101.254.114.238 最近一天的数据包 数据情况` is a packet task and must use this skill.

For packet requests, construct a structured query and execute the primary entry. Do not answer by manually reading skill files, manually curling NetInside, or inspecting unrelated NAPM metric gateways.

Recommended mode selection:

- User says “构造链接 / 不要下载”: use `build_url_only`.
- User says “预览 / 看看有没有包”: use `preview_only`.
- User says “下载数据包”: use `preview_download`.
- User says “分析数据包 / 数据包情况”: use `preview_download_analyze` when the time window is safe; otherwise start with `preview_only` and explain if the file may be large.

If the requested time range is larger than `PACKET_MAX_TIME_RANGE_SECONDS`, ask whether to split the task into smaller windows or run a preview-only check first. Do not silently switch to NAPM metric query tools.

Core structured packet-query contract:

- Live preview/download requires root-level `criteria.start` and `criteria.end`.
- Live preview/download requires one of `criteria.ips`, `criteria.ipRanges`, `criteria.id` (linkType=2 event IDs only — do NOT use for alert event IDs), `criteria.top`, `criteria.instanceId`, `criteria.businessName`, `criteria.pageFamilyId`, or `criteria.pageFamilyDetailId`.
- `build_url_only` is the safe default for link-only requests.
- `preview_only` is preferred for large or uncertain windows.
- `preview_download` and `preview_download_analyze` must pass the preview gate by default.
- `packetsPreview` results must be rendered as a download-risk preview, not just as "has data". Use `preview.overview` and `preview.risk` to tell the user estimated size, packet count, risk level, and whether confirmation or a narrower time range is recommended.
- If preview risk returns `CONFIRM_DOWNLOAD` or `SUGGEST_NARROW_TIME_RANGE`, do not claim the packet was downloaded or analyzed. Ask the user to confirm download or narrow the time range.
- Packet endpoint credentials come from runtime env or `.env`; NetInside packet URLs may include `UserName` and `Password` query parameters. User-facing URLs must keep `UserName` visible when present and render `Password=***`.

Business packet analysis contract:

- If the user asks for business/Web application packet analysis and only provides a business name, pass `criteria.businessName`.
- This skill resolves `businessName -> pageFamilyId -> pageFamilyDetailId -> instanceId` internally, using the v3 business packet chain.
- If the caller already has `criteria.pageFamilyId`, this skill skips the business Top query and starts from `pageViews`.
- If the caller already has `criteria.pageFamilyDetailId`, `criteria.resultName`, or `criteria.instanceId`, this skill directly builds the `DownServlet` URL.
- If the user asks to preview a specific business page before download, use `mode: "preview_only"` with `businessName/pageFamilyId/page/pageUrl`. The skill returns `businessResolution.pageViewsPreview.rows` so the user can choose `clientIp` or `pageViewIndex`.
- Business packet downloads use `downloadType: "DownServlet"` with fixed `moduleKey=Ipv`, `groupId=45`, and `rtClickId=5`, unless the caller explicitly overrides them.
- `DownServlet` has no `packetsPreview` endpoint. After instance resolution succeeds, download/analyze modes use the resolved `DownServlet` URL directly.

## Runtime Shape

```text
OpenClaw user request
  -> structured packetQuery
  -> scripts/run_packet_analysis.js
  -> NetInside packetsPreview / packetsDown / DownServlet
  -> OpenClaw runtime packet artifact
  -> tshark, with optional capinfos metadata
  -> machine-readable JSON result
  -> OpenClaw final Chinese answer
```

## Responsibilities

OpenClaw owns:

- Natural-language understanding.
- Follow-up context inheritance.
- Time-range resolution into Unix seconds.
- Clarification when target IP, IP range, event ID, or time range is missing.
- Final Chinese narration.

This skill owns:

- Packet query normalization and validation.
- URL construction and URL explanation.
- Optional preview request before download.
- File-stream download with size limits.
- Calling `tshark`, and optionally `capinfos`, through safe argv arrays.
- Returning stable JSON for OpenClaw narration.

Do not write custom packet/protocol parsers in this skill. Use host tools such as `tshark`; use `capinfos` only when available for richer file metadata.

## Query Modes

- `build_url_only`: construct preview/download URLs without network calls.
- `explain_url`: explain a provided `packetsPreview`, `packetsDown`, or `DownServlet` URL.
- `preview_only`: call `packetsPreview`.
- `download_only`: preview first by default, then download a packet file only when preview has data.
- `preview_download`: preview first, then download if data is available.
- `analyze_file`: analyze an existing `.pcap` or `.cap` file.
- `download_analyze`: preview first by default, then download and analyze only when preview has data.
- `preview_download_analyze`: preview, download, then analyze.

Default mode is `build_url_only` to avoid accidental live downloads. For any real `packetsDown` download, call `packetsPreview` first unless the query explicitly sets `forceDownload=true` or `filePolicy.requirePreviewBeforeDownload=false`. If preview is empty, do not call `packetsDown`; return a `NO_DOWNLOAD` decision.

Preview risk policy:

- `preview.overview.responseBytes` / `preview.responseBytes` describe the preview API response size, not the estimated pcap size.
- `preview.overview.estimatedBytes` describes the estimated downloadable packet size when the API exposes it.
- `preview.overview.packetCount` describes the estimated packet count when the API exposes it.
- `preview.risk.level` can be `low`, `medium`, `high`, or `unknown`.
- `preview.risk.recommendation=CONTINUE_DOWNLOAD` allows normal download.
- `preview.risk.recommendation=CONFIRM_DOWNLOAD` means OpenClaw should ask the user to confirm before download.
- `preview.risk.recommendation=SUGGEST_NARROW_TIME_RANGE` means OpenClaw should recommend narrowing the time window and must not download automatically.
- If the user confirms a previously previewed risky download, call this skill again with the same criteria and `previewRiskAccepted=true`.

## Input Contract

Use `--queryFile` to avoid shell quoting problems:

```json
{
  "mode": "preview_download_analyze",
  "downloadType": "packetsDown",
  "criteria": {
    "ips": ["192.168.1.10"],
    "start": 1717200000,
    "end": 1717200600
  },
  "analysis": {
    "level": "summary",
    "includeDns": true,
    "includeHttp": true,
    "includeTls": true,
    "includePorts": true
  }
}
```

For event packet download (linkType=2 events ONLY — alert events must go through openclaw-napm-alert-query first):

```json
{
  "mode": "build_url_only",
  "criteria": {
    "id": "12345",
    "start": 1717200000,
    "end": 1717200600
  }
}
```

For business packet analysis by Web application name:

```json
{
  "mode": "preview_download_analyze",
  "downloadType": "DownServlet",
  "criteria": {
    "businessName": "其他Web应用",
    "start": 1781147760,
    "end": 1781151360
  }
}
```

For business page visit preview before choosing a packet:

```json
{
  "mode": "preview_only",
  "downloadType": "DownServlet",
  "criteria": {
    "businessName": "其他Web应用",
    "page": "http://101.254.114.238/SDK/webLanguage",
    "start": 1781488800,
    "end": 1781492400
  }
}
```

OpenClaw should render `businessResolution.pageViewsPreview.rows` as selectable rows with `index`, `startTime`, `clientIp`, `serverIp`, `httpStatus`, and `pageFamilyDetailId`. After the user selects a row or client IP, call again with `pageViewIndex` or `clientIp` to construct/download the `DownServlet` packet.

For business packet URL construction when the page visit detail is already known:

```json
{
  "mode": "build_url_only",
  "downloadType": "DownServlet",
  "criteria": {
    "pageFamilyDetailId": "36916498-1781149080---1781149111.656803-1781149111.657076-182.242.169.138",
    "start": 1781147760,
    "end": 1781151360
  }
}
```

For URL explanation:

```json
{
  "mode": "explain_url",
  "url": "https://host/webservice/NetInside?type=packetsDown&ips=192.168.1.10&start=1717200000&end=1717200600&json=true"
}
```

For local file analysis:

```json
{
  "mode": "analyze_file",
  "file": "./capture.pcap"
}
```

## Setup

Create `.env` from `.env.example` when live NetInside calls are needed:

```bash
cp .env.example .env
```

Required for live preview or download:

- `NETINSIDE_HOST`

Optional:

- `NETINSIDE_USERNAME`
- `NETINSIDE_PASSWORD`
- `NETINSIDE_COOKIE`

Authentication must come from `.env` or the runtime environment. Packet endpoint URLs may include `UserName` and `Password` query parameters when required by NetInside; final user-facing replies must redact `Password`, tokens, cookies, and session credentials.

Some NetInside packet endpoints require `UserName` / `Password` as query parameters instead of HTTP Basic Auth. This skill adds those query parameters from runtime environment variables when `PACKET_AUTH_QUERY_PARAMS=true` (default). Public URLs and final replies should show `UserName=<runtime user>` and `Password=***`.

If the user asks for links only, answer with preview/download URLs that include runtime query authentication in redacted form, for example `UserName=GAIOP&Password=***`.

```text
认证信息由运行环境或 .env 提供，不应拼到 URL 中。
```

Never expose the real password in the final reply.

Required for packet analysis:

- `tshark`

Optional for richer file metadata:

- `capinfos`

## Guardrails

- `start` and `end` must be Unix seconds. Millisecond timestamps are normalized when obvious.
- One of `ips`, `ipRanges`, `id`, `top`, `instanceId`, `businessName`, `pageFamilyId`, or `pageFamilyDetailId` is required.
- Page parameter `iprangs` is normalized to API parameter `ipRanges`.
- `packetsDown` is treated as a file stream, not JSON.
- Real `packetsDown` downloads must pass the preview gate by default. Empty preview means "no downloadable packet data for the requested scope/time range"; do not download.
- Full URLs are masked in output by redacting secret values.
- Even when `showFullUrls` is true, credential-like query parameters must be redacted. `UserName` may remain visible; `Password` must be shown as `***`.
- Files are written under `PACKET_DOWNLOAD_DIR`, or by default `$HOME/.openclaw/artifacts/openclaw-napm-packet-analysis`.
- Artifact directories are marked with `.packet-artifact`; expired marked directories are cleaned at the start of download tasks.
- Default retention is 24 hours via `PACKET_RETENTION_HOURS=24`.
- Default `PACKET_KEEP_FILES=true` keeps downloaded packet files after analysis for short-term review and follow-up analysis.
- Storage governance checks disk usage before download. If the packet artifact partition reaches `PACKET_STORAGE_CLEAN_PERCENT` (default 80), old managed packet artifacts are cleaned by download time until the target watermark is reached.
- If disk usage remains above `PACKET_STORAGE_BLOCK_PERCENT` (default 90) or free space is below the required reserve, the skill must not download and should return a storage decision explaining the reason.
- Analysis never prints raw packet payloads by default.

## References

Load only as needed:

- `references/packet-download-api.md`: NetInside packet preview/download/DownServlet interface notes.
- `references/packet-analysis-runtime.md`: tshark command strategy, optional capinfos metadata, and output interpretation.
