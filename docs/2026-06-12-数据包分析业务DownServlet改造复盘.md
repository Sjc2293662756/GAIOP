# 数据包分析业务 DownServlet 改造复盘

## 背景

用户在业务数据包分析场景中指出：业务数据包下载不是简单的 `packetsPreview / packetsDown` 链路，而是需要按照 `数据包下载接口文档v3-0611.md` 先逐级查询得到 `instanceId`，再通过 `/webservice/DownServlet` 下载。

此前数据包分析存在两个核心问题：

- OpenClaw/模型容易把“分析业务数据包”误理解成普通 NAPM 指标查询，转去查 `topValues`、`overview` 等指标结果，导致回答偏离数据包链路。
- 业务数据包下载链接里的 `instanceId` 不是用户天然提供的参数，需要通过 `WebApplication -> PageFamily -> pageViews` 多级查询获得，旧实现没有完整收口这条链路。

本次改造目标是：把业务数据包解析逻辑放回 `openclaw-napm-packet-analysis` skill 内部，让 packet skill 自己完成 `businessName/pageFamilyId/pageFamilyDetailId -> DownServlet URL` 的确定性链路。

## 本次修改原则

- 不在 `napm-openclaw-plugin.remote.js` 中继续堆业务逻辑。
- 不让 OpenClaw 手写 curl 或 Python 过滤作为生产查询链路。
- 不把业务数据包分析回退成普通 NAPM query skill 查询。
- packet skill 内部可以调用 `topValues` 和 `pageViews`，但它们只是解析 `instanceId` 的中间步骤，不是最终用户查询语义。
- 所有中间步骤都通过结构化字段 `businessResolution.steps` 返回，便于排查。
- URL 对外展示时保留 `UserName`，隐藏 `Password`。

## 涉及文件

### 代码文件

```text
skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js
```

主要新增能力：

- 新增业务数据包解析入口判断：`shouldResolveBusinessPacketInstance`。
- 新增业务解析主流程：`resolveBusinessPacketInstance`。
- 新增 v3 文档对应的 URL 构造函数：
  - `buildBusinessTopValuesUrl`
  - `buildPageFamilyTopValuesUrl`
  - `buildPageViewsUrl`
- 新增选择/解析函数：
  - `selectBusinessRow`
  - `selectPageFamilyRow`
  - `selectPageViewRow`
  - `extractBusinessName`
  - `extractPageFamilyId`
  - `extractPageFamilyDetailId`
- `DownServlet` 默认补齐：
  - `moduleKey=Ipv`
  - `groupId=45`
  - `rtClickId=5`
- 修复敏感参数判断，避免把 `moduleKey=Ipv` 错误脱敏。
- 支持 `pageFamilyDetailId` 自动规范化为 `instanceId=PATH1/{pageFamilyDetailId}`。
- 仅在存在 `packetsPreview` URL 时才走预览；`DownServlet` 不强行调用 `packetsPreview`。

### Skill 文档

```text
skills/openclaw-napm-packet-analysis/SKILL.md
```

补充内容：

- 业务数据包分析仍然属于 packet skill。
- 支持输入 `businessName`、`pageFamilyId`、`pageFamilyDetailId`。
- 明确 `DownServlet` 链路没有 `packetsPreview`。
- 明确业务场景固定使用 `moduleKey=Ipv`、`groupId=45`、`rtClickId=5`。

### Workflow 契约

```text
skills/openclaw-napm-packet-analysis/references/packet-workflow-contract.md
```

补充内容：

- 业务数据包标准流程图。
- 不允许把业务 packet 请求路由到普通 query skill。
- 失败时必须返回 `businessResolution.steps`，不能编造 `instanceId`。
- 补充业务解析失败码。

### API 参考

```text
skills/openclaw-napm-packet-analysis/references/packet-download-api.md
```

补充内容：

- v3 文档中的业务 `DownServlet` 解析链路。
- 三步解析接口：
  - `topValues(WebApplication)`
  - `topValues(WebApplication + PageFamilies + PageFamily)`
  - `pageViews(csv=true, pageFamilyId)`
- `groupPath` 中 `pageFamilyId` 的解析规则：`page\s+(\d+)/`。
- 最终下载接口：
  - `/webservice/DownServlet?moduleKey=Ipv&groupId=45&rtClickId=5&instanceId=PATH1/{pageFamilyDetailId}`

### 实现说明文档

```text
docs/2026-06-12-packet-business-downservlet-instance-resolution.md
```

这份文档偏实现说明，描述整体流程、输入契约、审计输出和验证方式。

### 本复盘文档

```text
docs/2026-06-12-数据包分析业务DownServlet改造复盘.md
```

这份文档偏复盘和交接，记录为什么改、改了哪里、如何验证、后续注意什么。

### 测试文件

```text
test/napm-packet-business-downservlet.test.js
```

覆盖内容：

- `businessName` 会触发业务实例多级解析。
- 从 `groupPath` 解析 `pageFamilyId`。
- 从 `pageViews` 记录提取 `pageFamilyDetailId`。
- `pageFamilyDetailId` 规范化为 `PATH1/{id}`。
- 构造 v3 要求的 `topValues`、`pageViews`、`DownServlet` URL。
- `DownServlet` 默认包含 `moduleKey=Ipv`、`groupId=45`、`rtClickId=5`。

## 业务数据包链路

```text
用户问题：分析某业务的数据包
  -> OpenClaw 识别为 packet task
  -> 构造 packetQuery
     mode=preview_download_analyze 或 build_url_only
     downloadType=DownServlet
     criteria.businessName/pageFamilyId/pageFamilyDetailId
  -> openclaw-napm-packet-analysis
  -> resolveBusinessPacketInstance
  -> topValues(WebApplication)
  -> topValues(WebApplication + PageFamilies + PageFamily)
  -> 从 groupPath 解析 pageFamilyId
  -> pageViews(csv=true, pageFamilyId)
  -> 读取 pageFamilyDetailId
  -> instanceId=PATH1/{pageFamilyDetailId}
  -> DownServlet(moduleKey=Ipv, groupId=45, rtClickId=5)
  -> 如需分析，下载后调用 tshark
  -> 返回结构化 JSON
  -> OpenClaw 最终中文回答
```

## 输入场景

### 1. 只有业务名

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

执行完整链路：

```text
businessName -> pageFamilyId -> pageFamilyDetailId -> DownServlet
```

### 2. 已有 pageFamilyId

```json
{
  "mode": "preview_download_analyze",
  "downloadType": "DownServlet",
  "criteria": {
    "pageFamilyId": "8573007",
    "start": 1781147760,
    "end": 1781151360
  }
}
```

跳过业务和页面族选择，直接查：

```text
pageViews(pageFamilyId) -> pageFamilyDetailId -> DownServlet
```

### 3. 已有 pageFamilyDetailId

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

直接构造：

```text
instanceId=PATH1/{pageFamilyDetailId}
```

## 鉴权和 URL 展示

NetInside 接口可能要求 URL 查询参数中包含：

```text
UserName={runtime user}
Password={runtime password}
```

本次确认：

- skill 内部通过运行时环境变量或 `.env` 注入鉴权参数。
- 用户可见 URL 展示为：

```text
UserName=GAIOP&Password=***
```

- 不再回答“认证信息不应拼到 URL 中”这类误导说法。
- 真实密码不会出现在最终回答、summary 或 narrationInput 中。

## 验证记录

语法检查：

```powershell
node --check skills\openclaw-napm-packet-analysis\scripts\run_packet_analysis.js
```

相关测试：

```powershell
npm test -- --runInBand --runTestsByPath test/napm-packet-business-downservlet.test.js test/napm-report-input-contract.test.js test/packet-loss-default-sort-metric.test.js test/napm-openclaw-plugin-packet-loss-guard.test.js
```

结果：

```text
Test Suites: 4 passed, 4 total
Tests: 24 passed, 24 total
```

Smoke 验证：

```json
{
  "mode": "build_url_only",
  "host": "https://101.254.114.238",
  "downloadType": "DownServlet",
  "criteria": {
    "start": 1781147760,
    "end": 1781151360,
    "pageFamilyDetailId": "36916498-1781149080---1781149111.656803-1781149111.657076-182.242.169.138"
  }
}
```

返回结果中下载 URL 符合预期：

```text
https://101.254.114.238/webservice/DownServlet?UserName=GAIOP&Password=***&moduleKey=Ipv&groupId=45&rtClickId=5&start=1781147760&end=1781151360&instanceId=PATH1%2F36916498-...
```

## 后续部署注意

如果要部署到远端 OpenClaw，应同步以下内容：

```text
skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js
skills/openclaw-napm-packet-analysis/SKILL.md
skills/openclaw-napm-packet-analysis/references/packet-workflow-contract.md
skills/openclaw-napm-packet-analysis/references/packet-download-api.md
```

远端技能目录通常为：

```text
/home/netinside/.openclaw/workspace/skills/openclaw-napm-packet-analysis
```

部署后建议执行：

```bash
systemctl --user restart openclaw-gateway.service
openclaw skills list
journalctl --user -u openclaw-gateway.service -n 100 --no-pager
```

## 后续风险

- `pageViews(csv=true)` 虽然文档说明按 JSON 数组处理，但实际返回格式仍需以生产接口为准。
- 页面族选择目前默认取可解析 `pageFamilyId` 的第一条，可通过 `page`、`pageUrl`、`httpStatus`、`clientIp`、`pageViewIndex` 进一步指定。
- 如果业务名不唯一，建议 OpenClaw 在最终回答中暴露 `businessResolution.steps` 的 selected 信息，便于用户确认。
- `PACKET_MAX_TIME_RANGE_SECONDS` 仍会限制大时间窗数据包任务；超过限制时应拆分窗口，而不是转成普通指标查询。

## 本次结论

业务数据包分析现在已经从“模型临时拼流程”改为“packet skill 内部确定性执行链路”：

```text
OpenClaw 负责识别 packet 意图和构造结构化输入
packet skill 负责业务 instanceId 解析、DownServlet URL、下载和 tshark 分析
report skill 负责后续报告导出
```

这符合当前项目“以 skill 为中心承载能力”的拆分方向。
