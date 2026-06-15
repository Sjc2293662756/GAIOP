# 业务数据包 DownServlet 实例解析落地说明

## 背景

业务数据包分析不是普通 `packetsPreview -> packetsDown` 链路。根据 `数据包下载接口文档v3-0611.md`，业务场景最终下载入口是 `/webservice/DownServlet`，但关键参数 `instanceId` 通常不能由用户直接给出，需要通过 NetInside 业务分析接口逐级查询获得。

本次改造将这条链路收口到 `openclaw-napm-packet-analysis` skill 内部，避免 OpenClaw 把“业务数据包分析”误路由到普通 NAPM 指标查询。

## 目标

- 用户说“分析某业务的数据包”时，仍然使用 packet skill。
- packet skill 内部负责 `businessName -> pageFamilyId -> pageFamilyDetailId -> instanceId`。
- OpenClaw 不需要手写 curl、python 过滤或跳到 query skill。
- 所有中间步骤写入 `businessResolution.steps`，便于审计和排查。
- 对外展示 URL 时保留 `UserName`，隐藏 `Password`。

## 查询流程

```text
用户问题
  -> OpenClaw 识别为数据包任务
  -> 构造 packetQuery
     mode: preview_download_analyze / build_url_only
     downloadType: DownServlet
     criteria.businessName 或 pageFamilyId/pageFamilyDetailId
  -> openclaw-napm-packet-analysis
  -> resolveBusinessPacketInstance
  -> topValues(WebApplication)
  -> topValues(WebApplication + PageFamilies + PageFamily)
  -> 从 groupPath 解析 pageFamilyId
  -> pageViews(csv=true, pageFamilyId)
  -> 读取 pageFamilyDetailId
  -> instanceId = PATH1/{pageFamilyDetailId}
  -> DownServlet(moduleKey=Ipv, groupId=45, rtClickId=5)
  -> 如需分析，下载后调用 tshark
  -> 返回结构化 JSON
  -> OpenClaw 生成中文回答
```

## v3 接口链路

第一步，查询业务 Top：

```text
GET /webservice/NetInside?UserName={userName}&Password={password}&type=topValues&numGroups=1&groupType1=WebApplication&start={start}&end={end}&metrics=PGNPGE,PGTME,PGNSLPGE,PGSLPCT,PGHTTP400,PGHTTP500&topMetric=PGNPGE&topCount=20&json=true
```

第二步，查询页面族错误分析：

```text
GET /webservice/NetInside?UserName={userName}&Password={password}&type=topValues&numGroups=3&groupType1=WebApplication&groupArgument1={businessName}&groupType2=PageFamilies&groupType3=PageFamily&metrics=PGNPGE,PGNOBJE,PGHTTP200,PGHTTP300,PGHTTP400,PGHTTP500&start={start}&end={end}&topMetric=PGHTTP500&topCount=5&json=true
```

第三步，从第二步返回行的 `groupPath` 解析：

```text
...>pages>page 8573007/http://...
```

解析规则：

```text
page\s+(\d+)/
```

第四步，查询页面访问明细：

```text
GET /webservice/NetInside?UserName={userName}&Password={password}&type=pageViews&start={start}&end={end}&csv=true&pageFamilyId={pageFamilyId}&maxLimit=undefined
```

第五步，拼接下载链接：

```text
GET /webservice/DownServlet?moduleKey=Ipv&groupId=45&rtClickId=5&start={start}&end={end}&instanceId=PATH1/{pageFamilyDetailId}
```

## 输入契约

完整业务名解析：

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

已有页面族 ID：

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

已有页面访问明细 ID：

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

## 审计输出

成功时返回：

- `businessResolution.ok=true`
- `businessResolution.businessName`
- `businessResolution.pageFamilyId`
- `businessResolution.pageFamilyDetailId`
- `businessResolution.instanceId`
- `businessResolution.steps`

失败时返回：

- `ok=false`
- `decision.next_action=CLARIFICATION_REQUIRED`
- `businessResolution.error.code`
- `businessResolution.steps`

常见失败码：

- `BUSINESS_PACKET_BUSINESS_QUERY_FAILED`
- `BUSINESS_PACKET_BUSINESS_NOT_FOUND`
- `BUSINESS_PACKET_PAGE_FAMILY_QUERY_FAILED`
- `BUSINESS_PACKET_PAGE_FAMILY_NOT_FOUND`
- `BUSINESS_PACKET_PAGE_VIEWS_QUERY_FAILED`
- `BUSINESS_PACKET_PAGE_VIEW_NOT_FOUND`

## 边界规则

- 业务数据包分析仍然是 packet skill 的职责，不是 query skill 的普通指标查询。
- `topValues` 和 `pageViews` 只是 packet skill 内部解析 `instanceId` 的步骤。
- `DownServlet` 没有 `packetsPreview` 对应入口，不应强行调用 `packetsPreview`。
- 用户只要求构造链接时使用 `build_url_only`，不得下载。
- 用户要求分析时，先解析 `instanceId`，再下载并调用 `tshark`。
- 不得暴露真实密码；最终 URL 应展示 `Password=***`。

## 验证

已新增测试：

```text
test/napm-packet-business-downservlet.test.js
```

覆盖内容：

- `businessName` 会触发业务实例多级解析。
- 从 `groupPath` 解析 `pageFamilyId`。
- 从 `pageViews` 记录读取 `pageFamilyDetailId` 并拼接 `PATH1/`。
- 构造 v3 文档要求的 `topValues`、`pageViews`、`DownServlet` URL。
- `DownServlet` 默认包含 `moduleKey=Ipv`、`groupId=45`、`rtClickId=5`。
