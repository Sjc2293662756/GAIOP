---
name: openclaw-napm-packet-analysis
description: Standalone OpenClaw skill for NetInside / NAPM packet download and packet-file analysis. Use when OpenClaw needs to preview downloadable packets, build or explain packetsDown URLs, download packets by IP/IP range/event ID/top condition, explain or use DownServlet URLs, analyze local pcap/cap files, or summarize packet-level evidence with tshark/capinfos. Never append or recommend UserName, Password, token, cookie, or session parameters in generated URLs or final replies; authentication must come from .env/runtime credentials.
---

# OpenClaw NAPM Packet Analysis

Use this skill for packet download and packet-file analysis. Keep natural-language understanding in OpenClaw; pass this skill a structured packet query.

Primary entry:

```bash
node scripts/run_packet_analysis.js --queryFile ./query.json
```

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

For event packet download:

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

Authentication must come from `.env` or the runtime environment. Do not put `UserName`, `Password`, tokens, cookies, or session credentials into generated URLs or final user-facing replies.

The HTTP transport may apply `NETINSIDE_USERNAME` and `NETINSIDE_PASSWORD` to its private request URL when the NetInside endpoint requires query-parameter authentication. That authenticated URL is execution-only: never return it from `urls`, logs, narration input, reports, or errors. Public preview/download URLs remain credential-free.

If the user asks for links only, answer with unauthenticated preview/download URLs and add this note only:

```text
认证信息由运行环境或 .env 提供，不应拼到 URL 中。
```

Never write wording such as "append UserName/Password", "注入 UserName/Password", or "附加账号密码参数".

Required for packet analysis:

- `tshark`

Optional for richer file metadata:

- `capinfos`

## Guardrails

- `start` and `end` must be Unix seconds. Millisecond timestamps are normalized when obvious.
- One of `ips`, `ipRanges`, `id`, or `top` is required for `packetsDown`.
- Page parameter `iprangs` is normalized to API parameter `ipRanges`.
- `packetsDown` is treated as a file stream, not JSON.
- Real `packetsDown` downloads must pass the preview gate by default. Empty preview means "no downloadable packet data for the requested scope/time range"; do not download.
- Full URLs are masked in output unless `showFullUrls` is true.
- Even when `showFullUrls` is true, credential-like query parameters must be redacted. Never suggest appending `UserName` or `Password` to packet URLs.
- Files are written under `PACKET_DOWNLOAD_DIR`, or by default `$HOME/.openclaw/artifacts/openclaw-napm-packet-analysis`.
- Artifact directories are marked with `.packet-artifact`; expired marked directories are cleaned at the start of download tasks.
- Default retention is 24 hours via `PACKET_RETENTION_HOURS=24`.
- Default `PACKET_KEEP_FILES=false` removes the downloaded packet file after `download_analyze` or `preview_download_analyze`, while keeping `download.meta.json` and `analysis.json`.
- Analysis never prints raw packet payloads by default.

## References

Load only as needed:

- `references/packet-download-api.md`: NetInside packet preview/download/DownServlet interface notes.
- `references/packet-analysis-runtime.md`: tshark command strategy, optional capinfos metadata, and output interpretation.
