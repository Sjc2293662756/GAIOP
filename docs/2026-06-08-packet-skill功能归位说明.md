# Packet Skill 功能归位说明

日期：2026-06-08

## 目标

本次改造处理 `openclaw-napm-packet-analysis`，把数据包下载、预览、分析相关的流程知识沉淀到 packet skill 内，避免数据包问题继续被 `openclaw-napm-query` 或插件 routing context 抢走。

本阶段不新增插件工具入口，不删除插件校验，只先完成 packet skill 的能力归位。

## 修改内容

### 1. 新增 packet workflow 契约

新增文件：

```text
skills/openclaw-napm-packet-analysis/references/packet-workflow-contract.md
```

该文件集中承载 packet skill 的流程规则，包括：

- 适用范围和非适用范围。
- 结构化 `packetQuery` 输入契约。
- mode 选择规则。
- 时间窗口策略。
- preview -> download -> analyze 标准流程。
- `UserName` / `Password` 内部认证和对外脱敏。
- 输出契约。
- 失败处理。
- 追问继承。
- 与 query/report/workflow skill 的边界。

### 2. 更新 packet SKILL.md

修改文件：

```text
skills/openclaw-napm-packet-analysis/SKILL.md
```

新增主入口提示：

```text
For detailed routing, mode selection, time-window policy, preview/download/analyze flow, authentication redaction, failure handling, and cross-skill boundary rules, load references/packet-workflow-contract.md.
```

并补充核心结构化 packet 查询规则：

```text
Live preview/download requires criteria.start and criteria.end.
Live preview/download requires ips/ipRanges/id/top/instanceId.
build_url_only is safe default for link-only requests.
preview_only is preferred for large or uncertain windows.
preview_download and preview_download_analyze must pass preview gate by default.
Packet endpoint credentials come from runtime env or .env; user-facing URLs must mask UserName and Password.
```

## 已归位到 packet skill 的功能

### 1. 数据包触发边界

归属 packet skill：

```text
数据包
报文
抓包
抓取包
原始包
包详情
pcap / cap
packet
packetsPreview
packetsDown
DownServlet
数据包情况
```

明确禁止：

```text
不能把数据包问题转成 topValues / timeValues / averageValues / overview。
不能转成 BusinessGroup / DefinedApp 普通指标查询。
不能在 packet 失败后自动兜底到 query skill。
```

### 2. mode 选择

归属 packet skill：

```text
构造链接 / 不要下载 -> build_url_only
预览 / 看看有没有包 -> preview_only
下载数据包 -> preview_download
分析数据包 / 数据包情况 -> preview_download_analyze
已有 pcap/cap 文件 -> analyze_file
解释数据包 URL -> explain_url
```

### 3. 时间窗口策略

归属 packet skill：

```text
最近一小时 -> 直接构造 1 小时窗口
最近一天 / 最近24小时 -> 先判断 PACKET_MAX_TIME_RANGE_SECONDS
超过限制 -> 先 preview_only 或询问是否拆分小窗口
不能静默切换到 NAPM 指标查询
```

### 4. 预览、下载、分析流程

归属 packet skill：

```text
packetQuery
  -> packetsPreview
  -> preview 有数据才 packetsDown
  -> 若需要分析，再用 tshark
  -> 返回 JSON result / narrationInput
```

约束：

```text
packetsDown 是文件流，不是 JSON。
默认必须先 preview。
preview 空则不下载。
tshark 是主分析工具。
capinfos 只是可选增强。
默认不输出原始 packet payload。
```

### 5. 认证和脱敏

归属 packet skill：

```text
NETINSIDE_HOST
NETINSIDE_USERNAME
NETINSIDE_PASSWORD
NETINSIDE_COOKIE
PACKET_AUTH_QUERY_PARAMS
```

当前已确认：

```text
NetInside packet endpoint 可要求 UserName / Password query 参数。
内部 raw URL 可以从运行环境注入 UserName / Password。
最终展示给用户必须脱敏为 UserName=***&Password=***。
```

### 6. 失败处理

归属 packet skill：

```text
CLARIFICATION_REQUIRED
NO_DOWNLOAD
PACKET_TIME_RANGE_TOO_LARGE
PACKET_PREVIEW_FAILED
PACKET_DOWNLOAD_FAILED
PACKET_TSHARK_FAILED
```

必须区分：

```text
没有数据：preview 成功但为空。
权限/认证问题：preview 401/403。
工具问题：tshark 缺失或执行失败。
时间窗口问题：超过 PACKET_MAX_TIME_RANGE_SECONDS。
```

## 明确不属于 packet skill 的功能

### 普通 NAPM 查询

以下不属于 packet skill：

```text
吞吐
流量
丢包
重传
响应时间
TopN
趋势
均值
业务清单
应用清单
下钻路径
指标清单
```

应走：

```text
openclaw-napm-query
```

### 报告生成

以下不属于 packet skill：

```text
生成报告
导出 Word/docx/PDF
将以上整理成文档
```

应走：

```text
openclaw-napm-report
```

## 验收用例

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
预览 101.254.114.238 最近一小时有没有可下载数据包
下载 101.254.114.238 最近一小时的数据包
分析 101.254.114.238 最近一小时的数据包 数据情况
分析 101.254.114.238 最近一天的数据包 数据情况
解释这个 packetsDown URL
分析这个本地 pcap 文件
```

期望：

- 以上问题都归 packet skill。
- `最近一天` 这类大窗口不会切换到 query skill。
- URL 对外展示必须脱敏。
- 如果 preview 返回 200，不得再回答“GAIOP 没权限”。

## 后续建议

下一步可以继续：

```text
1. report skill 功能归位。
2. 新增 workflow skill，描述 query -> packet -> report 的复合流程。
3. 如 OpenClaw 仍无法稳定自动选择 packet skill，再考虑为 packet 增加插件工具入口。
4. 部署当前项目内的 packet skill 到远端 OpenClaw skills 目录，替换临时独立部署版本。
```
