# 业务页面数据包 pageViews 预览链路修复说明

## 背景

用户在企业微信中先查询：

```text
在其他web应用中，有哪些页面出现400错误？
```

系统返回 `其他Web应用` 中存在 HTTP 400 的页面族，例如：

```text
http://101.254.114.238/SDK/webLanguage
```

随后用户继续问：

```text
http://101.254.114.238/SDK/webLanguage 分析这个的数据包预览
```

期望行为不是直接下载数据包，也不是走普通 `packetsPreview`，而是先查询该页面族对应的页面访问明细，让用户选择对端 IP 或具体访问行，再进一步构造/下载业务数据包。

## 问题现象

系统回答：

```text
pageViews 查询返回 0 条记录，无法获取 pageFamilyDetailId，因此无法构造 DownServlet 下载链接。
```

但用户指出正确的预览接口应为：

```text
https://101.254.114.238/webservice/NetInside?type=pageViews&start=1781488800&end=1781492400&json=true&pageFamilyId=8574581&maxLimit=undefined&{}
```

该接口实际上能返回页面访问明细。

## 根因

根因有两个：

### 1. 预览语义混淆

数据包链路中存在两类“预览”：

| 预览类型 | 接口 | 适用场景 |
|---|---|---|
| 普通数据包预览 | `packetsPreview` | 按 IP、IP 段、事件 ID 等普通条件预览是否有包、包大小、包数量 |
| 业务页面访问明细预览 | `pageViews` | 业务 `DownServlet` 链路中，先列出可选页面访问行，用于选择 `pageFamilyDetailId` |

之前代码和提示把“业务页面数据包预览”容易理解成 `packetsPreview` 或最终 `DownServlet` 下载前的预览，导致没有把 `pageViews` 明细作为用户可选列表返回。

### 2. pageViews 请求参数使用了 `csv=true`

旧代码中 `buildPageViewsUrl()` 使用：

```text
csv=true
```

但后端实际支持更适合 skill 处理的：

```text
json=true
```

使用 `json=true` 时，后端返回标准 JSON 数组，示例字段包括：

```json
{
  "clientIp": "31.59.160.12",
  "serverIp": "101.254.114.238",
  "httpStatus": 404,
  "page": "http://101.254.114.238/SDK/webLanguage",
  "startTime": "2026-06-15 10:39:30.7",
  "pageFamilyDetailId": "43425979-1781491140---1781491170.721124-1781491170.873562-31.59.160.12"
}
```

旧链路未把这些明细作为预览结果返回给用户选择。

## 正确链路

业务页面数据包预览应走：

```text
用户指定业务页面
  -> topValues(WebApplication + PageFamilies + PageFamily)
  -> 解析 pageFamilyId
  -> pageViews(json=true, pageFamilyId)
  -> 返回页面访问明细预览
  -> 用户选择 clientIp 或 pageViewIndex
  -> 使用对应 pageFamilyDetailId
  -> 构造 DownServlet instanceId=PATH1/{pageFamilyDetailId}
  -> 下载/分析数据包
```

## 修改内容

### 1. pageViews 改用 json=true

文件：

```text
skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js
```

函数：

```js
buildPageViewsUrl()
```

改动：

```diff
- url.searchParams.set('csv', 'true');
+ url.searchParams.set('json', 'true');
```

### 2. 新增 pageViews 明细预览结构

新增函数：

```js
buildPageViewsPreview(rows, context)
normalizePageViewPreviewRow(row, index)
```

输出结构：

```json
{
  "pageFamilyId": "8574581",
  "businessName": "其他Web应用",
  "rowCount": 3,
  "uniqueClientIps": [
    "31.59.160.12",
    "204.76.203.219",
    "93.123.72.183"
  ],
  "statusCounts": {
    "404": 3
  },
  "rows": [
    {
      "index": 0,
      "startTime": "2026-06-15 10:39:30.7",
      "page": "http://101.254.114.238/SDK/webLanguage",
      "clientIp": "31.59.160.12",
      "serverIp": "101.254.114.238",
      "httpStatus": 404,
      "pageFamilyDetailId": "43425979-...",
      "instanceId": "PATH1/43425979-..."
    }
  ],
  "selectionHint": "选择 clientIp 或 pageViewIndex 后，可继续构造 DownServlet 下载链接。"
}
```

### 3. preview_only 不再自动选择第一条

当业务链路使用：

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

现在返回：

```text
businessResolution.pageViewsPreview.rows
```

而不是自动选择第一条构造下载链接。

用户选择后，再传：

```json
{
  "clientIp": "31.59.160.12"
}
```

或：

```json
{
  "pageViewIndex": 0
}
```

继续构造/下载对应 `DownServlet` 数据包。

## OpenClaw 回答要求

当用户问：

```text
http://101.254.114.238/SDK/webLanguage 分析这个的数据包预览
```

正确回答应展示类似：

```text
该页面在最近 1 小时有 3 条页面访问明细可用于业务数据包下载：

| 序号 | 时间 | 对端 IP | 服务端 IP | HTTP 状态 | 页面 |
|---|---|---|---|---|---|
| 0 | 2026-06-15 10:39:30.7 | 31.59.160.12 | 101.254.114.238 | 404 | /SDK/webLanguage |
| 1 | 2026-06-15 10:32:26.1 | 204.76.203.219 | 101.254.114.238 | 404 | /SDK/webLanguage |
| 2 | 2026-06-15 10:23:53.6 | 93.123.72.183 | 101.254.114.238 | 404 | /SDK/webLanguage |

请选择一个对端 IP 或序号，我再构造对应的 DownServlet 数据包下载链接。
```

不应回答：

```text
pageViews 返回 0 条
```

也不应直接跳到普通 IP `packetsPreview/packetsDown`，除非用户明确要求按 IP 走普通包下载链路。

## 测试覆盖

已更新测试文件：

```text
test/napm-packet-business-downservlet.test.js
```

覆盖内容：

- `buildPageViewsUrl()` 使用 `json=true`。
- `buildPageViewsPreview()` 能把 pageViews JSON 行规范化为可选预览行。
- 预览行包含 `index`、`clientIp`、`serverIp`、`httpStatus`、`pageFamilyDetailId`、`instanceId`。
- 能统计 `uniqueClientIps` 和 `statusCounts`。

验证命令：

```powershell
node --check skills\openclaw-napm-packet-analysis\scripts\run_packet_analysis.js
npm test -- --runInBand --runTestsByPath test/napm-packet-business-downservlet.test.js test/napm-packet-preview-risk.test.js test/napm-packet-storage-policy.test.js test/napm-report-input-contract.test.js
```

当前验证结果：

```text
Test Suites: 4 passed, 4 total
Tests: 21 passed, 21 total
```

## 后续注意

- `pageViews` 明细预览和普通 `packetsPreview` 是两类不同预览，不应混用。
- 业务 `DownServlet` 链路仍然没有普通 `packetsPreview` 等价入口。
- `pageViewsPreview.rows` 是候选行，不代表已经下载数据包。
- 用户选择候选行后，才能使用 `pageFamilyDetailId` 构造 `DownServlet` 下载链接。
- 如果用户指定的是 `clientIp`，应在 `pageViewsPreview.rows` 中匹配对应行。
- 如果同一个 `clientIp` 有多条记录，应提示用户选择具体 `pageViewIndex` 或默认取最新一条，并在回答中说明。
