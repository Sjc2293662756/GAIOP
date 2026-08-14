# NAPM 数据包下载分析 Skill 设计与 MVP 落地说明

日期：2026-06-04

## 1. 背景

现有 `openclaw-napm-query` skill 负责 NAPM / NetInside 的结构化指标查询，包括 Top、趋势、均值、下钻路径、元数据和指标清单。

数据包下载分析属于另一类能力：它需要调用 NetInside 数据包下载接口、保存文件流，并使用主机上的抓包分析工具进行分析。因此它不应继续塞入指标查询 skill，而应新起一个独立 skill。

本次已按独立 skill 方案落地第一版 MVP：

```text
skills/openclaw-napm-packet-analysis/
```

## 2. Skill 定位

Skill 名称：

```text
openclaw-napm-packet-analysis
```

职责边界：

```text
openclaw-napm-query
  -> 指标查询、Top、趋势、均值、元数据、下钻、指标归属

openclaw-napm-packet-analysis
  -> 数据包预览、下载 URL 构造、下载 URL 解释、数据包下载、tshark 分析
```

触发场景：

- 用户要求下载数据包。
- 用户要求分析 pcap、cap 或抓包文件。
- 用户提供 `packetsDown` URL 并要求解释或分析。
- 用户提供 `DownServlet` URL 并要求解释或分析。
- 用户基于 IP、IP 段、告警事件 ID 或 Top 条件要求下载数据包。
- 用户说“先看看有没有可下载数据包”。
- 用户从 NAPM 查询结果继续追问“下载这个对象的数据包分析”。

## 3. 总体运行链路

```text
OpenClaw 用户自然语言
  -> OpenClaw 理解意图并构造 packetQuery
  -> openclaw-napm-packet-analysis
  -> scripts/run_packet_analysis.js
  -> NetInside packetsPreview / packetsDown / DownServlet
  -> OpenClaw 运行态 artifacts 目录
  -> tshark 分析
  -> 可选 capinfos 元信息
  -> 结构化 JSON
  -> OpenClaw 生成最终中文回答
```

其中：

- OpenClaw 负责自然语言理解、上下文继承、时间范围解析和最终中文表达。
- skill 只处理结构化输入，不在脚本里做复杂中文 NLP。
- `tshark` 是核心分析工具。
- `capinfos` 只是可选元信息增强，不是硬依赖。

## 4. 当前目录结构

```text
skills/openclaw-napm-packet-analysis/
  SKILL.md
  package.json
  .env.example
  .gitignore
  agents/
    openai.yaml
  references/
    packet-download-api.md
    packet-analysis-runtime.md
  scripts/
    run_packet_analysis.js
```

第一版保持轻量，没有拆大量服务文件。后续稳定后可再拆分为：

```text
services/
  PacketQueryResolver.js
  PacketUrlBuilder.js
  PacketDownloadClient.js
  TsharkAnalyzer.js
  PacketNarrationService.js
```

## 5. 输入契约

主入口：

```bash
node scripts/run_packet_analysis.js --queryFile ./query.json
```

Windows PowerShell 下不建议使用 `--queryJson` 直接传复杂 JSON，优先使用 `--queryFile`。

按 IP 构造 URL：

```json
{
  "mode": "build_url_only",
  "host": "101.254.114.238",
  "criteria": {
    "ips": ["192.168.1.10"],
    "start": 1717200000,
    "end": 1717200600
  }
}
```

按告警事件 ID 下载：

```json
{
  "mode": "preview_download",
  "host": "101.254.114.238",
  "criteria": {
    "id": "12345",
    "start": 1717200000,
    "end": 1717200600
  }
}
```

解释 `DownServlet` URL：

```json
{
  "mode": "explain_url",
  "url": "https://101.254.114.238/webservice/DownServlet?moduleKey=Ipv&groupId=45&rtClickId=5&start=1780448460&end=1780452060&instanceId=PATH1/xxx"
}
```

分析本地文件：

```json
{
  "mode": "analyze_file",
  "file": "./capture.pcap"
}
```

## 6. 支持模式

当前 MVP 支持以下模式：

| mode | 作用 |
|---|---|
| `build_url_only` | 只构造预览和下载 URL，不发起网络请求。默认模式。 |
| `explain_url` | 解释 `packetsPreview`、`packetsDown` 或 `DownServlet` URL。 |
| `preview_only` | 调用 `packetsPreview` 判断是否有可下载数据。 |
| `download_only` | 默认先预览，有数据才下载；除非显式 `forceDownload=true`。 |
| `preview_download` | 先预览，有数据再下载。 |
| `analyze_file` | 分析本地 `.pcap` / `.cap` 文件。 |
| `download_analyze` | 默认先预览，有数据才下载并分析；除非显式 `forceDownload=true`。 |
| `preview_download_analyze` | 先预览，再下载，再分析。 |

默认使用 `build_url_only`，避免自然语言误触发真实下载。

真实 `packetsDown` 下载前默认必须经过 `packetsPreview` 门禁：

```text
packetsPreview 有数据 -> packetsDown 下载
packetsPreview 空结果 -> 不下载，直接返回 NO_DOWNLOAD
```

只有在用户明确要求强制下载时，才允许传：

```json
{
  "forceDownload": true
}
```

或：

```json
{
  "filePolicy": {
    "requirePreviewBeforeDownload": false
  }
}
```

## 7. NetInside 接口适配

标准流程：

```text
packetsPreview -> packetsDown
```

预览接口：

```text
GET /webservice/NetInside?type=packetsPreview
```

下载接口：

```text
GET /webservice/NetInside?type=packetsDown
```

常用参数：

| 参数 | 含义 |
|---|---|
| `ips` | 单个或多个 IP，多个 IP 使用重复参数。 |
| `ipRanges` | IP 范围，例如 `192.168.1.1-192.168.1.100`。 |
| `id` | 告警事件记录 ID。 |
| `top` | Top 数量条件。 |
| `start` | Unix 秒级开始时间。 |
| `end` | Unix 秒级结束时间。 |
| `json` | 固定传 `true`。 |

规则：

- 至少需要 `ips`、`ipRanges`、`id`、`top` 之一。
- `start` / `end` 必须存在。
- 毫秒级时间戳会在明显时归一化为秒级。
- 页面参数 `iprangs` 会归一化为接口参数 `ipRanges`。
- `packetsDown` 是文件流，不按 JSON 解析。

## 8. DownServlet 适配

右键菜单或表格对象下载使用：

```text
GET /webservice/DownServlet?moduleKey=Ipv&groupId=45&rtClickId={downloadId}&start={start}&end={end}&instanceId=PATH1/{resultName}
```

当前默认：

```text
moduleKey=Ipv
groupId=45
```

`instanceId` 规则：

- 如果用户给完整 `PATH1/...`，直接使用。
- 如果用户给 `resultName`，拼成 `PATH1/{resultName}`。
- 如果用户给表格值 `xxx##abc`，取 `##` 后的 `abc`，再拼成 `PATH1/abc`。
- 如果用户给完整 `DownServlet` URL，直接解析参数。

## 9. 分析工具要求

Linux 目标主机要求：

```text
tshark
```

可选增强：

```text
capinfos
```

说明：

- `tshark` 是核心分析工具。
- `capinfos` 只用于文件级元信息，例如包数、抓包时长、文件格式。
- 如果 `capinfos` 不存在，分析不会中断。
- 当前实现不会写自定义 pcap 协议解析器。
- 所有工具调用使用 argv 数组，不拼 shell 字符串。

当前会调用的典型命令：

```bash
tshark -r capture.pcap -q -z io,phs
tshark -r capture.pcap -q -z endpoints,ip
tshark -r capture.pcap -q -z conv,ip
tshark -r capture.pcap -Y dns.qry.name -T fields -e dns.qry.name
tshark -r capture.pcap -Y http -T fields -E separator=| -e http.host -e http.request.uri -e http.response.code
tshark -r capture.pcap -Y tls.handshake.extensions_server_name -T fields -e tls.handshake.extensions_server_name
```

## 10. 环境变量

`.env.example` 已提供：

```env
NETINSIDE_HOST=https://101.254.114.238
NETINSIDE_USERNAME=
NETINSIDE_PASSWORD=
NETINSIDE_COOKIE=
NETINSIDE_TLS_REJECT_UNAUTHORIZED=true

# 默认空值时使用 $HOME/.openclaw/artifacts/openclaw-napm-packet-analysis
PACKET_DOWNLOAD_DIR=
PACKET_MAX_BYTES=524288000
PACKET_MAX_TIME_RANGE_SECONDS=3600
PACKET_KEEP_FILES=false
PACKET_RETENTION_HOURS=24
PACKET_REQUIRE_PREVIEW_BEFORE_DOWNLOAD=true

PACKET_TSHARK_BIN=tshark
PACKET_CAPINFOS_BIN=capinfos
PACKET_ANALYSIS_TIMEOUT_MS=60000
PACKET_HTTP_TIMEOUT_MS=60000

SHOW_PACKET_FULL_URLS=false
```

生产部署时不要提交 `.env`。

认证策略：

- 真实请求使用 `.env` 或运行环境中的 `NETINSIDE_USERNAME` / `NETINSIDE_PASSWORD` 生成请求头。
- 如系统依赖 Cookie，则使用 `NETINSIDE_COOKIE`。
- 不在生成的 URL 中拼接 `UserName` / `Password`。
- 不在最终用户答复中展示账号、密码、Cookie、Token、Session 等凭据。
- 如果用户提供的 URL 本身带有凭据参数，skill 解释 URL 时必须脱敏并提示改用 `.env`。

## 11. 输出结构

执行输出为 JSON，核心字段：

```json
{
  "ok": true,
  "mode": "build_url_only",
  "downloadType": "packetsDown",
  "criteria": {},
  "urls": {},
  "preview": null,
  "download": null,
  "analysis": null,
  "summary": {},
  "narrationInput": {}
}
```

OpenClaw 应优先读取：

```text
narrationInput
summary
download
analysis
error
```

并最终生成中文回答。

## 12. 安全边界

已落地的边界：

- 默认不真实下载，只构造 URL。
- 真实 `packetsDown` 下载前默认调用 `packetsPreview`；预览为空时不发起下载请求。
- 下载文件默认保存到 `$HOME/.openclaw/artifacts/openclaw-napm-packet-analysis`，不放在 skill 代码目录。
- `.gitignore` 忽略 `.env` 和抓包文件。
- 限制下载文件大小，默认 500MB。
- 限制时间范围，默认 3600 秒。
- 默认保留 24 小时，配置项为 `PACKET_RETENTION_HOURS=24`。
- 每次下载任务开始前清理超过保留时间的标记目录。
- `download_analyze` / `preview_download_analyze` 默认分析完成后删除原始抓包文件，只保留 `download.meta.json` 和 `analysis.json`；如需保留原文件，设置 `PACKET_KEEP_FILES=true` 或在请求中传 `filePolicy.keepFiles=true`。
- 默认不输出原始包内容。
- 默认不暴露内部 raw URL。
- 默认不在 URL 或最终回答里暴露认证信息；真实请求从 `.env` 读取认证信息。
- `tshark` / `capinfos` 使用 argv 调用，不经过 shell 拼接。

后续可增强：

- 对 `zip` 包进行解压和多文件汇总分析。
- 增加更细的 TCP 异常统计。
- 增加会话级风险摘要。

## 13. 当前 MVP 验证结果

已完成：

- 新建 skill 目录。
- 写入 `SKILL.md`。
- 写入 `package.json`。
- 写入 `.env.example`。
- 写入接口参考文档。
- 写入 tshark runtime 参考文档。
- 实现 `scripts/run_packet_analysis.js`。
- 通过 `npm run check`。
- 通过 `quick_validate.py`。
- 通过 URL 构造烟测。
- 通过 `DownServlet` URL 解释烟测。
- 通过缺参错误分类烟测。

未在本地完成：

- 真实 pcap 分析烟测。

原因：

```text
本地 Windows 当前没有 tshark / capinfos。
```

该项应在目标 Linux 主机部署后验证。

## 14. 部署建议

目标 OpenClaw workspace 目录应使用运行 OpenClaw 的用户路径，例如：

```text
/home/ubuntu/.openclaw/workspace/skills/openclaw-napm-packet-analysis
```

部署步骤：

```bash
cp -R skills/openclaw-napm-packet-analysis /home/ubuntu/.openclaw/workspace/skills/openclaw-napm-packet-analysis
cd /home/ubuntu/.openclaw/workspace/skills/openclaw-napm-packet-analysis
cp .env.example .env
```

检查：

```bash
openclaw skills info openclaw-napm-packet-analysis --json
node scripts/run_packet_analysis.js --queryFile ./query.json
```

确认目标主机：

```bash
command -v tshark
```

`capinfos` 可选：

```bash
command -v capinfos || true
```

## 15. 后续迭代计划

第一阶段已经完成 MVP。

第二阶段建议：

- 部署到 Linux OpenClaw workspace。
- 用真实 `packetsPreview` 验证预览。
- 用小时间范围验证 `packetsDown` 文件流下载。
- 用目标主机 `tshark` 验证 `analyze_file`。

第三阶段建议：

- 拆分服务文件，降低主脚本复杂度。
- 增加 zip 解压和多 pcap 汇总。
- 增加 HTTP / DNS / TLS / TCP 异常的结构化摘要。
- 增加从上一轮 `openclaw-napm-query` 查询结果继承 IP 和时间范围的 OpenClaw 使用说明。

## 16. 结论

数据包下载分析应作为独立 skill 建设，当前 MVP 已落地为：

```text
skills/openclaw-napm-packet-analysis
```

它与 `openclaw-napm-query` 的关系是互补而非替代：

- 查询 skill 负责发现异常对象、指标和时间范围。
- 数据包 skill 负责下载和分析 packet 文件。

目标 Linux 主机只需保证 `tshark` 可用即可完成核心分析；`capinfos` 只是可选增强。
