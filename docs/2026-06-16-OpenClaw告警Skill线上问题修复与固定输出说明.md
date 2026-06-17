# OpenClaw 告警 Skill 线上问题修复与固定输出说明

## 1. 背景

2026-06-15 至 2026-06-16，`openclaw-napm-alert-query` 初步接入后，在企微端连续暴露出几类问题：

- 用户问“最近一小时有哪些告警”，后台浏览器接口有数据，但企微端回答“没有告警”。
- 用户追问“构建出来的 API 连接是什么”，企微端回答“没有对外 REST API 连接”，没有展示实际 NetInside WebService URL。
- 告警摘要明细默认展示了轻微告警，而不是优先展示紧急告警。
- 告警摘要回复格式不稳定，有时是表格，有时是自由文本。
- 旧的概览/安全概览链路可能截胡告警事件问题，造成“概览无告警”被误当成“告警事件无结果”。

本次修复目标：

- 告警事件问题必须走 `napm-alert-query`。
- 后台真实请求 URL 必须可核验，且必须脱敏。
- 相对时间不能被主链算错年份。
- 告警列表必须按紧急、重大、轻微排序。
- 告警摘要固定输出表格模板。

## 2. 涉及文件

### 2.1 插件层

```text
napm-openclaw-plugin.remote.js
```

主要职责：

- 注册 `napm-alert-query` 工具。
- 识别告警事件问题。
- 阻止告警问题误走 `napm-skill-query`。
- 校验当前轮是否存在真实 `napm-alert-query` 结果。
- 固定告警摘要回复模板。
- 在 `message_sending` / `before_message_write` 阶段重写自由文案，保证企微端输出稳定。

### 2.2 告警 Skill

```text
skills/openclaw-napm-alert-query/scripts/run_alert_query.js
skills/openclaw-napm-alert-query/services/AlertApiService.js
skills/openclaw-napm-alert-query/services/AlertNormalizerService.js
```

主要职责：

- 调用 NetInside 后台 `alertsSummary` / `alertsSummaryTimeLine` / `alertsDetail` / `timeValues`。
- 记录脱敏后的后台请求 URL。
- 对“最近一小时”等相对时间做运行时重算。
- 归一化告警事件。
- 按严重级别排序告警事件。

### 2.3 测试

```text
test/alert-query-services.test.js
test/alert-query-runner.test.js
test/napm-openclaw-plugin-alert-query.test.js
```

覆盖：

- 后台 URL 构造与脱敏。
- 相对时间重算。
- 告警事件排序。
- 告警工具路由边界。
- 固定表格回复。
- 最终发送阶段的固定模板重写。

## 3. 问题一：告警问题被概览链路截胡

### 3.1 现象

用户问：

```text
最近一小时有哪些告警？
```

企微端曾回答：

```text
最近一小时没有产生任何告警。
```

但直接调用 NetInside `alertsSummary` 有告警数据。

### 3.2 根因

主链没有稳定调用 `napm-alert-query`。

部分情况下，旧的 overview/security 相关链路会输出“未发现告警”，模型又把这个概览结论包装成告警事件查询结果。

后续追问“你使用的是告警查询 skill 么”时，模型还可能补写“是的，使用了 napm-alert-query”，但 audit 中没有真实 `napm_alert_query_invoked` 记录。

### 3.3 修复

插件新增告警事件识别：

```text
isAlertEventPrompt()
isAlertSkillMetaFollowUpPrompt()
```

识别范围包括：

```text
告警
告警事件
告警摘要
告警详情
告警时间线
紧急告警
重大告警
轻微告警
alertsSummary
alertsSummaryTimeLine
alertsDetail
告警查询 skill
napm-alert-query
```

新增结果校验：

```text
isAlertSkillResultRecord()
getRememberedAlertRecordForPrompt()
```

只有满足以下任一条件，才认为当前轮存在真实告警 skill 结果：

- `result.service` 是 `alertsSummary` / `alertsSummaryTimeLine` / `alertsDetail` / `explain_notification` / `explain_event_fields`。
- `result.narrationInput.schema === 'openclaw_napm_alert.v1'`。
- `result.reportData.dataSource.sourceSkill === 'openclaw-napm-alert-query'`。

### 3.4 工具边界

告警事件问题如果调用 `napm-skill-query`，插件会阻止：

```text
Alert event queries must use napm-alert-query, not napm-skill-query or overview/security summaries.
```

没有真实告警 skill 结果时，最终回复改写为：

```text
当前问题必须通过 napm-alert-query 执行后才能回答。
本轮没有拿到可核验的告警查询结果，因此不能判断“没有告警”，也不能补写告警查询过程。
请以 napm-alert-query 返回的 alertsSummary / alertsSummaryTimeLine / alertsDetail 结构化结果为准。
```

## 4. 问题二：后台 API URL 没有回传

### 4.1 现象

用户问：

```text
构建出来的 api 连接是什么？
```

企微端曾回答：

```text
这个告警查询走的是 OpenClaw 内部的 NAPM Alert Skill 工具调用链路，并不是通过 HTTP API 直接发起的，所以没有对外暴露的 REST API 连接或 URL。
```

该回答不准确。

### 4.2 正确链路

真实链路应为：

```text
用户
  -> OpenClaw
  -> napm-alert-query
  -> openclaw-napm-alert-query
  -> NetInside WebService HTTP API
```

也就是说，用户侧不直接调用 REST API，但 skill 内部一定会请求 NetInside 后台 API。

### 4.3 修复

`AlertApiService` 新增请求历史记录：

```text
requestHistory
getRequestHistory()
getLastRequestUrl()
```

每次 `getJsonByParams()` 请求前记录脱敏 URL。

脱敏规则：

```text
Password=***
password=***
passwd=***
token=***
secret=***
authorization=***
```

`run_alert_query.js` 将 URL 写入结果：

```json
{
  "requestUrl": "https://.../webservice/NetInside?UserName=GAIOP&Password=***&type=alertsSummary&start=...&end=...&json=true",
  "requestUrls": [
    "https://.../webservice/NetInside?UserName=GAIOP&Password=***&type=alertsSummary&start=...&end=...&json=true"
  ]
}
```

插件层 `buildAlertQueryReply()` 会追加：

```text
Debug API:
https://.../webservice/NetInside?UserName=GAIOP&Password=***&type=alertsSummary&start=...&end=...&json=true
```

## 5. 问题三：同一个浏览器 API 有数据，微信端说没有数据

### 5.1 现象

用户在浏览器中访问同类 `alertsSummary` URL 能看到 JSON 数据，但企微端回答无数据。

### 5.2 关键证据

企微端展示的入参：

```json
{
  "prompt": "最近一小时有哪些告警",
  "mode": "summary",
  "criteria": {
    "start": 1745328420,
    "end": 1745332020
  }
}
```

企微端口头说明是：

```text
2026-06-15 21:27 ~ 22:27
```

但实际时间戳换算为：

```text
1745328420 -> 2025-04-22 21:27:00 Asia/Shanghai
1745332020 -> 2025-04-22 22:27:00 Asia/Shanghai
```

正确的 `2026-06-15 21:27 ~ 22:27` 应为：

```text
1781530020 -> 2026-06-15 21:27:00 Asia/Shanghai
1781533620 -> 2026-06-15 22:27:00 Asia/Shanghai
```

所以这不是同一个 API 时间窗口。

### 5.3 根因

主链模型构造了错误年份的 Unix 时间戳。

嘴上说 2026，但实际传给 skill 的是 2025。

### 5.4 修复

`run_alert_query.js` 新增：

```text
applyPromptRelativeTimeRange()
resolveRelativeTimeRangeFromPrompt()
parseChineseNumber()
```

当 prompt 中包含相对时间表达时，skill 内部重新计算 `criteria.start/end`：

```text
最近一小时
近 N 小时
过去 N 分钟
最近一天
```

如果原始时间戳被覆盖，结果里写入 warning：

```json
{
  "code": "ALERT_RELATIVE_TIME_RANGE_REBUILT",
  "message": "已按用户相对时间表达重新计算告警查询窗口：最近一小时。",
  "originalStart": 1745328420,
  "originalEnd": 1745332020,
  "start": 1781570700,
  "end": 1781574300
}
```

### 5.5 远端验证

远端传入错误时间戳：

```text
start=1745328420
end=1745332020
prompt=最近一小时有哪些告警
```

skill 自动重算并返回告警：

```json
{
  "ok": true,
  "service": "alertsSummary",
  "total": 5,
  "timeRange": {
    "start": 1781570700,
    "end": 1781574300,
    "displayText": "最近一小时"
  }
}
```

## 6. 问题四：明细默认展示轻微告警

### 6.1 现象

摘要显示：

```text
紧急 5 条
重大 9 条
轻微 12 条
```

但前 5 条明细展示的是轻微告警。

### 6.2 根因

后台 `alertsSummary` 返回的事件顺序不保证按严重级别排序。

原实现直接按后端返回顺序做 `slice(0, maxEvents)`，导致轻微告警可能占掉前 5 条展示位。

### 6.3 修复

`AlertNormalizerService.js` 新增：

```text
sortAlertEvents()
```

排序规则：

1. `severity` 降序：紧急 `4` > 重大 `3` > 轻微 `2`。
2. 同级别按 `start` 降序。
3. 再按 `end` 降序。
4. 再按 `id` 降序。

`run_alert_query.js` 在 `slice(maxEvents)` 前排序：

```text
sortAlertEvents(filterEvents(normalizeSummary(...)))
  .slice(0, maxEvents)
```

### 6.4 远端验证

远端最近一小时，前 8 条排序：

```text
紧急
紧急
紧急
紧急
紧急
重大
重大
重大
```

## 7. 问题五：告警摘要回复格式不稳定

### 7.1 现象

同样问：

```text
最近一小时有哪些告警
```

企微端可能输出：

- 表格。
- 自由文本。
- 时间解释。
- 只给统计不展示明细。

### 7.2 修复

插件层固定 `buildAlertQueryReply()` 输出模板。

固定模板：

```text
最近一小时告警概况：

告警总数：N 条

- 🔴 紧急：x 条
- 🟠 重大：y 条
- 🟢 轻微：z 条

前 5 条告警摘要：

| 级别 | 类型 | 对象 | 描述 |
| --- | --- | --- | --- |
| 🔴 紧急 | 应用性能 | HTTPS | 外部应用性能下降 |

初步判断：告警主要集中在...

需要查看某条告警的详情，或继续查看告警时间线吗？
```

### 7.3 最终回复保护

在两个发送阶段强制重写：

```text
message_sending
before_message_write
```

只要当前 prompt 属于告警范围，并且有真实 `napm-alert-query` 结果：

```text
alertScopedPrompt && isAlertSkillResultRecord(rememberedRecord)
```

就不使用主链自由文案，改用：

```text
buildAlertQueryReply(rememberedRecord.result)
```

这样可以保证企微端固定输出表格。

## 8. 当前能力边界

### 8.1 已支持

- 最近一小时/近 N 小时/过去 N 分钟/最近一天告警摘要。
- 告警严重级别统计。
- 前 5 条告警表格展示。
- 紧急优先排序。
- 后台 Debug API 脱敏展示。
- 告警详情查询 `alertsDetail`。
- 告警时间线查询 `alertsSummaryTimeLine`。
- 告警触发指标趋势 `timeValues`。
- 告警到报告的 `reportData`。
- 告警到数据包分析的 `packetHandoff`。
- 告警通知字段解释。

### 8.2 暂不支持

- 自动新增告警规则。
- 自动修改告警规则。
- 自动删除告警规则。
- 自动提交 `/admin/alerts.asp?m=add/update`。
- 在没有真实告警 skill 结果时输出“无告警”。

## 9. 远端部署记录

### 9.1 远端路径

插件：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
```

告警 skill：

```text
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/
```

关键文件：

```text
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/scripts/run_alert_query.js
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/services/AlertApiService.js
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/services/AlertNormalizerService.js
```

### 9.2 本轮远端备份

```text
index.js.bak-api-url-20260616093430
run_alert_query.js.bak-api-url-20260616093430
AlertApiService.js.bak-api-url-20260616093430

run_alert_query.js.bak-relative-time-20260616094422

run_alert_query.js.bak-severity-sort-20260616104222
AlertNormalizerService.js.bak-severity-sort-20260616104222

index.js.bak-fixed-alert-table-20260616110601
```

### 9.3 服务重启

每次远端同步后执行：

```text
systemctl --user restart openclaw-gateway.service
systemctl --user is-active openclaw-gateway.service
```

最终状态：

```text
active
```

## 10. 验证命令

### 10.1 本地语法检查

```bash
node --check napm-openclaw-plugin.remote.js
node --check skills/openclaw-napm-alert-query/scripts/run_alert_query.js
node --check skills/openclaw-napm-alert-query/services/AlertApiService.js
node --check skills/openclaw-napm-alert-query/services/AlertNormalizerService.js
```

### 10.2 本地测试

```bash
npx jest test/alert-query-services.test.js test/alert-query-runner.test.js test/napm-openclaw-plugin-alert-query.test.js --runInBand
```

当前结果：

```text
3 passed
22 passed
```

### 10.3 远端语法检查

```bash
node --check /home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
node --check /home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/scripts/run_alert_query.js
node --check /home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/services/AlertApiService.js
node --check /home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/services/AlertNormalizerService.js
```

## 11. 企微回归测试建议

### 11.1 告警摘要

```text
/new
最近一小时有哪些告警
```

期望：

- 使用固定表格模板。
- 展示总数。
- 展示紧急/重大/轻微数量。
- 前 5 条优先展示紧急。

### 11.2 API 链路

```text
把你构建的请求 api 给我看看
```

期望：

- 回答中包含 `napm-alert-query`。
- 回答中包含 `alertsSummary`。
- 展示脱敏 `Debug API`。
- 不出现真实密码。

### 11.3 相对时间

```text
最近30分钟有哪些告警
最近2小时有哪些告警
最近一天有哪些告警
```

期望：

- `start/end` 与当前日期一致。
- 不再出现 2025 年错误时间戳。
- 如主链传错，skill 输出 `ALERT_RELATIVE_TIME_RANGE_REBUILT` warning。

### 11.4 严重级别过滤

```text
最近一小时有哪些紧急告警
最近一小时有哪些重大告警
最近一小时有哪些轻微告警
```

期望：

- 过滤条件正确。
- 表格只展示对应级别。

### 11.5 告警详情

```text
告警 669613 的详情是什么？
```

期望：

- 走 `alertsDetail`。
- Debug API 中包含 `type=alertsDetail`。
- 包含 `eventids=669613`。

### 11.6 时间线

```text
最近一小时告警数量趋势怎么样？
```

期望：

- 走 `alertsSummaryTimeLine`。
- 不误用摘要表格。

### 11.7 防回退

```text
最近一小时系统整体情况怎么样？
最近一小时有哪些告警？
```

期望：

- 第一问可走 overview。
- 第二问必须走 `napm-alert-query`。
- 不能被 overview/security 的“无告警”截胡。

## 12. 重要结论

### 12.1 告警事件必须独立于概览

“系统整体情况”可以包含概览里的告警模块，但“有哪些告警/告警详情/告警时间线”必须走 `napm-alert-query`。

### 12.2 相对时间必须由执行层兜底

主链模型可以构造时间范围，但执行层不能完全相信模型生成的 Unix 时间戳。

只要用户说的是“最近/近/过去”这类相对时间，告警 skill 必须按运行时重新计算。

### 12.3 告警摘要输出必须由结构化结果驱动

企微最终回复不能只靠模型自由组织。告警摘要必须由 `buildAlertQueryReply()` 从结构化结果渲染。

### 12.4 用户可复查链路必须保留

告警结果必须保留脱敏 Debug API，让用户能够用浏览器或后台接口复查同一时间窗口。

## 13. 后续建议

### 13.1 告警详情固定模板

摘要已固定表格。下一步建议把 `alertsDetail` 也固定成模板：

```text
告警 ID
级别
类型
对象
指标
触发条件
开始/结束时间
是否可转数据包分析
```

### 13.2 时间线固定模板

`alertsSummaryTimeLine` 建议固定输出：

```text
时间桶
紧急数量
重大数量
轻微数量
峰值时间段
```

### 13.3 告警根因分析

后续可在 `detail_with_timeseries` 基础上扩展：

- 拉取触发指标趋势。
- 对比阈值/基线。
- 判断持续时间。
- 给出根因候选。

### 13.4 与 packet/report 联动

后续重点测试：

```text
这个告警有没有关联数据包？
把最近一小时紧急告警导出成 Word 报告。
```

确保 alert -> packet / alert -> report 的上下文继承稳定。

