# 2026-06-08 packet analysis 插件工具入口修复说明

## 背景

企业微信测试中，用户输入：

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
分析 101.254.114.238 最近一天的数据包 数据情况
```

系统仍出现两类错误：

1. 构造链接时只是基于文档和记忆拼 URL，没有稳定留下 packet skill 执行记录。
2. 分析数据包时漂移到 `napm-skill-query` 的 overview / topValues 指标查询，并复用了旧的 “GAIOP 无下载权限 403” 记忆。

这说明仅把 `openclaw-napm-packet-analysis` 放到 OpenClaw skills 目录，并不能保证生产对话稳定选择该 skill。OpenClaw 可以看到 skill 描述，但没有一个插件级、可审计、可阻断错误路由的 packet 执行入口。

## 根因

当前生产插件原来只注册了两个工具：

```json
[
  "napm-skill-query",
  "napm-report-export"
]
```

其中 `napm-skill-query` 是指标、元数据、清单、趋势、排行等 NAPM 查询入口，不适合执行数据包下载或 pcap 分析。

当用户说“数据包情况”时，OpenClaw 虽然可能读到 packet skill 文档，但没有正式工具可调用，于是容易自由发挥：

- 读取文档后手工拼 URL。
- 误把“数据包情况”转成 NAPM 指标查询。
- 在 packet 失败或未执行时兜底到 overview / topValues。
- 复用历史 403 记忆，而不是执行当前 packet skill。

## 本次修改

### 1. 新增插件工具 `napm-packet-analysis`

文件：

```text
napm-openclaw-plugin.remote.js
openclaw.plugin.json
```

新增工具：

```text
napm-packet-analysis
```

该工具调用：

```text
/home/netinside/.openclaw/skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js
```

执行方式：

```text
node run_packet_analysis.js --queryFile <packet.json>
```

### 2. 新增 packet executor

新增函数：

```text
buildPacketExecutorPayload()
runPacketExecutor()
buildPacketAnalysisReply()
createPacketAnalysisToolDefinition()
```

职责：

- 接收 OpenClaw 构造好的结构化 `packetQuery` / `criteria`。
- 写入临时 JSON 文件，避免 shell 引号污染。
- 调用 packet skill 脚本。
- 解析稳定 JSON 输出。
- 写入 audit 事件：
  - `napm_packet_analysis_invoked`
  - `napm_packet_analysis_completed`
  - `napm_packet_analysis_failed`

### 3. 更新工具契约

`openclaw.plugin.json` 新增：

```json
"napm-packet-analysis"
```

### 4. 更新路由约束

新增 packet 边界说明：

```text
数据包/报文/抓包/原始包/pcap/cap/packetsPreview/packetsDown/DownServlet
必须调用 napm-packet-analysis。
```

禁止行为：

- 不允许数据包请求调用 `napm-skill-query`。
- 不允许数据包请求兜底到 overview / topValues。
- 不允许从旧记忆回答 403。
- 不允许只读文档后手工拼接为最终答案。

### 5. 更新 guard

新增：

```text
isPacketCapturePrompt()
```

并在 `before_tool_call` 中增加阻断：

```text
packet prompt + napm-skill-query -> block
packet prompt + 非 napm-packet-analysis 工具 -> block
```

这样如果 OpenClaw 又试图把 packet 请求送到 query 工具，会被插件边界直接挡住。

## 当前正确链路

### 构造下载链接

用户：

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
```

正确链路：

```text
OpenClaw 识别 packet link-only 请求
  -> 构造 packetQuery
  -> 调用 napm-packet-analysis
  -> mode=build_url_only
  -> openclaw-napm-packet-analysis/scripts/run_packet_analysis.js
  -> 返回 packetsPreview / packetsDown URL
  -> 最终回复用户
```

### 分析数据包

用户：

```text
分析 101.254.114.238 最近一天的数据包 数据情况
```

正确链路：

```text
OpenClaw 识别 packet analysis 请求
  -> 判断时间范围是否超过单次 packet 限制
  -> 大时间范围优先调用 napm-packet-analysis mode=preview_only
  -> 如需下载分析，再按窗口拆分或要求用户确认
  -> 不得改走 napm-skill-query 指标概览
```

## 远端部署与验证

远端文件：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/openclaw.plugin.json
```

远端服务：

```text
systemctl --user restart openclaw-gateway.service
systemctl --user is-active openclaw-gateway.service
```

验证结果：

```json
{
  "ok": true,
  "mode": "build_url_only",
  "hasPreview": true,
  "hasDownload": true,
  "error": null
}
```

说明插件工具 `napm-packet-analysis` 已能通过插件入口调用 packet skill，并返回 preview/download URL。

## 企业微信验收用例

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
```

期望：

- 调用 `napm-packet-analysis`。
- 返回 preview/download URL。
- 不再说 “GAIOP 没权限 403”。
- 不再说 “根据 packet-download-api.md” 手工构造。

```text
分析 101.254.114.238 最近一天的数据包 数据情况
```

期望：

- 识别为 packet analysis。
- 不调用 `napm-skill-query`。
- 不转 overview / topValues。
- 若一天超过单次限制，应先 preview 或提示拆分窗口，而不是用指标数据替代数据包分析。

## 后续注意

当前修复是给 packet 能力补正式执行入口，不是重新堆自然语言关键词编排。关键词只用于边界保护：防止 packet 请求被错误工具抢走。

如果后续 OpenClaw 支持更稳定的多 skill 自动编排，可以继续保留该工具入口作为审计和执行边界。
