# NAPM Packet Workflow Contract

This document contains packet-specific workflow rules that belong to `openclaw-napm-packet-analysis`.

OpenClaw owns natural-language understanding, follow-up inheritance, time resolution, and final Chinese narration. This skill owns packet query validation, URL construction, preview, download, tshark analysis, artifact handling, and machine-readable result output.

## 1. Accepted Scope

Use this skill for:

- 数据包、报文、抓包、抓取包、原始包、包详情。
- pcap / cap / packet capture / packet file.
- packetsPreview / packetsDown / DownServlet.
- Constructing packet preview/download URLs.
- Previewing whether packets exist for an IP, IP range, top condition, or event ID.
- Downloading packet files after preview.
- Analyzing downloaded or local `.pcap` / `.cap` files with `tshark`.

Do not use this skill for:

- Ordinary NAPM metric, ranking, trend, inventory, or drilldown questions. Use `openclaw-napm-query`.
- Report file generation. Use `openclaw-napm-report` after this skill returns structured analysis/report data.
- General shell/curl exploration outside the skill runtime.

Hard boundary:

```text
If the user says 数据包 / 报文 / 抓包 / pcap / cap / packetsPreview / packetsDown / 数据包情况,
do not reinterpret the request as topValues, timeValues, averageValues, overview, BusinessGroup, DefinedApp, or other ordinary metric query.
```

## 2. Primary Execution Contract

Use a structured packet query and execute:

```bash
node scripts/run_packet_analysis.js --queryFile ./query.json
```

Accepted query shape:

```json
{
  "mode": "preview_download_analyze",
  "downloadType": "packetsDown",
  "criteria": {
    "ips": ["101.254.114.238"],
    "start": 1780882620,
    "end": 1780886220
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

Required criteria for live preview/download:

- `start`
- `end`
- One of `ips`, `ipRanges`, `id`, `top`, `instanceId`, `businessName`, `pageFamilyId`, or `pageFamilyDetailId`

Rules:

- `start` and `end` must be Unix seconds.
- Millisecond timestamps may be normalized when obvious.
- `end` must be greater than `start`.
- `iprangs` is a page spelling and must be normalized to API `ipRanges`.
- Never put credentials in user-provided `criteria`; credentials come from runtime env or `.env`.

Business packet criteria:

- `businessName`: WebApplication/business display name. The skill will query business Top values, then page family Top values, then pageViews to resolve a concrete `pageFamilyDetailId`.
- `pageFamilyId`: skip the business/page-family selection and query pageViews directly.
- `pageFamilyDetailId` / `resultName`: skip multi-step resolution and build `DownServlet` directly with `instanceId=PATH1/{pageFamilyDetailId}`.
- Optional selectors: `page`, `pageUrl`, `clientIp`, `serverIp`, `httpStatus`, `pageViewIndex`.

## 3. Mode Selection

Use these modes:

- `build_url_only`: user asks to construct links, says “不要下载”, or only wants preview/download URLs.
- `explain_url`: user provides a `packetsPreview`, `packetsDown`, or `DownServlet` URL and asks what it means.
- `preview_only`: user asks whether packet data exists, or requests a large/uncertain time range.
- `preview_download`: user explicitly asks to download packet data.
- `preview_download_analyze`: user asks to analyze packet data and the time window is safe.
- `analyze_file`: user provides an existing local `.pcap` or `.cap` file.
- `download_analyze`: only when the caller intentionally skips explicit preview mode but still wants download and analysis; preview is still required by default.

Default:

```text
build_url_only
```

Default is intentionally conservative to avoid accidental large downloads.

## 4. Time Window Policy

OpenClaw should resolve time before calling this skill.

Common mappings:

- `最近一小时` -> last 1 hour.
- `最近一天` / `最近24小时` -> last 24 hours.
- `今天` -> local-day start to current or local-day end according to user intent.
- `昨天` -> previous local-day window.

Safety policy:

- If the requested window is within `PACKET_MAX_TIME_RANGE_SECONDS`, `preview_download_analyze` is allowed when the user asks for analysis.
- If the requested window exceeds `PACKET_MAX_TIME_RANGE_SECONDS`, do not silently switch to NAPM metric query.
- For large windows, first use `preview_only` or ask whether to split into smaller windows.
- If splitting, each sub-window must satisfy `PACKET_MAX_TIME_RANGE_SECONDS`.

Recommended response when range is too large:

```text
该请求是数据包分析任务，但时间范围超过当前单次 packet 限制。建议先做 preview_only 判断是否有包，或按 1 小时窗口拆分后下载分析。
```

## 5. Preview / Download / Analyze Flow

Standard live flow:

```text
packetQuery
  -> packetsPreview
  -> normalize preview overview
  -> assess preview risk
  -> if risk requires confirmation: stop and ask user
  -> if preview has data: packetsDown
  -> if analysis requested: tshark
  -> JSON result
  -> OpenClaw Chinese answer
```

Business packet flow:

```text
packetQuery(criteria.businessName)
  -> NetInside topValues(WebApplication)
  -> NetInside topValues(WebApplication + PageFamilies + PageFamily)
  -> parse pageFamilyId from selected row groupPath
  -> NetInside pageViews(json=true, pageFamilyId)
  -> read pageFamilyDetailId from selected page visit row
  -> DownServlet(moduleKey=Ipv, groupId=45, rtClickId=5, instanceId=PATH1/{pageFamilyDetailId})
  -> if analysis requested: tshark
  -> JSON result
  -> OpenClaw Chinese answer
```

Rules for business packet flow:

- Do not route business packet tasks to `openclaw-napm-query` just because the resolver uses `topValues` internally. Those `topValues` calls are implementation steps inside this packet skill.
- `DownServlet` has no `packetsPreview` equivalent. Do not call `packetsPreview` for the resolved `DownServlet` URL.
- When the user asks to preview a business page packet before choosing a peer IP, use `pageViews(json=true)` and return `businessResolution.pageViewsPreview.rows`.
- The pageViews preview rows are user-selectable candidates; do not auto-select the first row when `mode=preview_only`.
- If no row can be selected at any step, return `CLARIFICATION_REQUIRED` with the executed `businessResolution.steps`; do not invent an `instanceId`.
- The default page-family ranking metric is `PGHTTP500`, matching the v3 packet-download document.
- The default business ranking metric is `PGNPGE`, matching the v3 packet-download document.

Rules:

- Real `packetsDown` download must pass preview by default.
- Empty preview means no download.
- Non-empty preview must expose `preview.overview` and `preview.risk` in the JSON result.
- Do not summarize preview as only "has data"; include estimated size, packet count, and risk level when available.
- `preview.responseBytes` is the preview API response size, not the estimated pcap size.
- `preview.overview.estimatedBytes` is the estimated pcap/download size when the API returns it.
- `preview.risk.recommendation=CONFIRM_DOWNLOAD` stops automatic download until the user confirms.
- `preview.risk.recommendation=SUGGEST_NARROW_TIME_RANGE` stops automatic download and recommends a smaller time window.
- To continue after user confirmation, reuse the same criteria and set `previewRiskAccepted=true`.
- `packetsDown` returns a file stream, not JSON.
- Do not parse downloaded packet stream as JSON.
- `tshark` is the primary analysis tool.
- `capinfos` is optional and only enriches file metadata.
- Never print raw packet payloads by default.

## 6. Authentication and URL Redaction

Runtime credentials:

- `NETINSIDE_HOST`
- `NETINSIDE_USERNAME`
- `NETINSIDE_PASSWORD`
- `NETINSIDE_COOKIE`

Packet endpoint authentication:

- Some NetInside packet endpoints require `UserName` / `Password` query parameters.
- Internal request URLs add these parameters from runtime env when `PACKET_AUTH_QUERY_PARAMS=true`.
- Public URLs, summaries, logs intended for users, and final replies must keep `UserName` visible when present and render `Password=***`.

Internal raw URL may look like:

```text
https://host/webservice/NetInside?UserName=GAIOP&Password=secret&type=packetsPreview...
```

User-facing URL must look like:

```text
https://host/webservice/NetInside?UserName=GAIOP&Password=***&type=packetsPreview...
```

Never tell the user to append credentials manually. The URL returned by the skill already includes runtime query authentication in redacted form. Say:

```text
认证信息由运行环境或 .env 提供；最终展示会脱敏。
```

## 7. Output Contract

The script returns stable JSON.

Important fields:

- `ok`
- `mode`
- `downloadType`
- `criteria`
- `urls`
- `preview`
- `preview.overview`
- `preview.risk`
- `download`
- `analysis`
- `decision`
- `summary`
- `narrationInput`

OpenClaw final answer should:

- Be Chinese.
- State the time range and target scope.
- State whether preview found data, and include `packetCount`, `estimatedSizeText`, and `risk.level` when available.
- If downloaded, state artifact path or download reference when safe.
- If analyzed, summarize protocol distribution, endpoints, conversations, DNS/HTTP/TLS findings when present.
- If preview risk asks for confirmation or narrowing the time range, do not say the packet was downloaded or analyzed.
- Never expose raw packet payloads or plaintext credentials.
- Do not claim “permission denied” when `preview.statusCode=200`.

## 8. Failure Handling

Common decisions:

- `CLARIFICATION_REQUIRED`: missing IP/range/event/time or unsupported mode.
- `NO_DOWNLOAD`: preview empty or preview failed.
- `CONFIRM_DOWNLOAD`: preview found data but download requires user confirmation.
- `SUGGEST_NARROW_TIME_RANGE`: preview found data but estimated size/packet count is too risky for automatic download.
- `PACKET_TIME_RANGE_TOO_LARGE`: requested range exceeds configured max.
- `PACKET_PREVIEW_FAILED`: preview HTTP/API failed.
- `PACKET_DOWNLOAD_FAILED`: file stream download failed.
- `PACKET_TSHARK_FAILED`: tshark analysis failed.
- `PACKET_STORAGE_NOT_ENOUGH_SPACE`: download was blocked by storage governance before file download.
- `BUSINESS_PACKET_BUSINESS_QUERY_FAILED`: business Top query failed.
- `BUSINESS_PACKET_PAGE_FAMILY_QUERY_FAILED`: page-family Top query failed.
- `BUSINESS_PACKET_PAGE_VIEWS_QUERY_FAILED`: pageViews query failed.
- `BUSINESS_PACKET_PAGE_VIEW_NOT_FOUND`: pageViews returned no row with `pageFamilyDetailId`.

Distinguish:

- No packet data: preview succeeds but is empty.
- Permission/auth failure: preview status is 401/403.
- Tooling failure: `tshark` missing or exits non-zero.
- Time-range violation: validation fails before network call.
- Storage pressure: disk usage/free-space preflight blocks download before `packetsDown`.

Do not fall back to `openclaw-napm-query` when packet download/analysis fails. Report the packet failure and next action.

## 8.1 Storage Governance

Packet artifacts are stored under `PACKET_DOWNLOAD_DIR`, defaulting to:

```text
$HOME/.openclaw/artifacts/openclaw-napm-packet-analysis
```

Rules:

- Downloaded packet files are kept by default after analysis via `PACKET_KEEP_FILES=true`.
- Old packet artifacts are still governed by `PACKET_RETENTION_HOURS`.
- Before download, the skill checks disk usage for the artifact partition.
- If disk usage reaches `PACKET_STORAGE_CLEAN_PERCENT` (default 80), the skill cleans old managed artifacts by download time.
- Cleanup only touches directories with `.packet-artifact`.
- Cleanup first deletes packet payload files (`.pcap`, `.cap`, `.pcapng`, `.zip`) and keeps metadata where possible.
- If disk usage reaches `PACKET_STORAGE_BLOCK_PERCENT` (default 90), or free space is below the required reserve, the skill blocks download.

Storage-related result fields:

```text
download.storage.before
download.storage.afterCleanup
download.storage.cleanup
download.storage.decision
```

## 9. Follow-up Contract

OpenClaw owns follow-up understanding.

Expected inheritance:

- `最近一天呢？` after a packet preview/download should inherit IP/range/event and change only time.
- `下载它` after preview should reuse the previous packet criteria and switch mode to `preview_download`.
- `分析一下` after download should use the downloaded artifact or rerun `preview_download_analyze` if needed.
- `导出报告` after packet analysis should call `openclaw-napm-report` with structured packet analysis/report data.

If the referent is unclear, ask a clarification question.

## 10. Boundary With Other Skills

Query boundary:

- Metrics, ranking, inventory, drilldown, and NAPM result interpretation belong to `openclaw-napm-query`.
- Packet wording belongs here even if the request also mentions IP, time range, “分析”, or “数据情况”.

Report boundary:

- Report generation belongs to `openclaw-napm-report`.
- If the user asks for packet analysis and report in one request, run packet analysis first, then report export.

Workflow boundary:

- Multi-step orchestration belongs to future `openclaw-napm-workflow`; until then, OpenClaw should sequence this skill with query/report skills based on the user request.
