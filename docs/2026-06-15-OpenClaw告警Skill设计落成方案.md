# OpenClaw 告警 Skill 设计落成方案

日期：2026-06-15

## 1. 背景与目标

当前项目已经形成三类独立能力：

- `openclaw-napm-query`：负责 NAPM 指标、对象清单、指标清单、下钻目录、综合分析等结构化查询。
- `openclaw-napm-packet-analysis`：负责数据包预览、下载、DownServlet 链路、pcap/cap 文件分析。
- `openclaw-napm-report`：负责把已有结构化结果导出为 Word 报告。

告警接口文档提供了一组新的领域能力：

- 查询告警摘要：`alertsSummary`。
- 查询告警时间线：`alertsSummaryTimeLine`。
- 根据事件 ID 查询告警详情：`alertsDetail`。
- 根据告警对象和指标查询触发指标趋势：`timeValues`。
- 解释告警定义字段、通知动作字段，以及 Email / SNMP / SysLog / 快照配置关系。

这些能力不是普通指标查询的一个小分支。告警有自己的核心对象：告警事件、告警分类、严重级别、事件 ID、告警对象、告警任务、触发条件、通知动作、数据包关联方式。若直接塞进 `openclaw-napm-query`，会扩大现有 query skill 的边界，并把 `topValues` / `averageValues` / `timeValues` 的指标查询语义和告警事件查询语义混在一起。

因此，本方案建议新增独立 skill：

```text
openclaw-napm-alert-query
```

目标是让告警能力成为项目中的第四个稳定 skill：

```text
OpenClaw
  -> napm-skill-query          普通 NAPM 指标/对象查询
  -> napm-alert-query          告警事件查询与分析
  -> napm-packet-analysis      数据包预览/下载/分析
  -> napm-report-export        Word 报告导出
```

## 2. 设计原则

### 2.1 告警事件独立建模

告警查询的第一对象是“告警事件”，不是指标值。

告警 skill 应围绕这些对象建模：

- `AlertEvent`：单条告警事件。
- `AlertSummary`：指定时间范围内的告警集合与聚合统计。
- `AlertTimelineBucket`：按时间桶聚合的告警数量。
- `AlertDetail`：由 `alertsDetail` 返回的事件明细。
- `AlertMetricSeries`：告警对象在触发指标上的时间序列。
- `AlertNotificationConfig`：告警任务通知动作配置说明。
- `AlertPacketHandoff`：转交给 packet skill 的数据包分析上下文。

### 2.2 OpenClaw 仍然负责自然语言理解

OpenClaw 主链路负责：

- 判断用户问的是告警、指标、数据包还是报告。
- 解析时间范围为秒级 Unix 时间戳。
- 从上下文继承 eventId、告警对象、时间范围、严重级别。
- 判断是否需要追问。
- 在告警查询之后继续编排 packet/report skill。
- 生成最终中文回答。

告警 skill 负责：

- 校验结构化 `alertQuery`。
- 构造告警接口请求。
- 调用 NetInside / NAPM WebService。
- 归一化告警返回结构。
- 按严重级别、分类、对象、指标做聚合。
- 必要时补查告警指标趋势。
- 产出机器可读 `narrationInput`、`reportData`、`packetHandoff`。

### 2.3 不在第一阶段修改告警配置

接口文档中包含告警定义与通知动作字段，例如：

- `emailtag`
- `emailtextarea`
- `SNMPtag`
- `SysLog`
- `snapshotmark`
- `/admin/alerts.asp?m=add`
- `/admin/alerts.asp?m=update`

第一阶段只做查询、分析、解释，不做新增、修改、删除告警任务，不提交配置表单。

原因：

- 告警配置属于生产变更，风险高。
- 当前文档主要来自前端 JSP/JS 还原，不包含后端完整写入契约。
- 通知动作牵涉全局邮件、SNMP、SysLog 配置状态。

第一阶段可回答“怎么配置、字段是什么意思、当前告警事件是什么原因触发”，但不自动执行配置变更。

## 3. Skill 边界

### 3.1 使用 `openclaw-napm-alert-query` 的场景

用户问题包含以下语义时，应进入告警 skill：

- 告警列表、告警摘要、告警概览。
- 告警时间线、告警数量趋势。
- 告警详情、告警事件 ID。
- 最近有哪些紧急告警、重大告警、轻微告警。
- 某对象触发了哪些告警。
- 某条告警为什么触发。
- 告警触发指标、阈值、基线、实际值。
- 告警通知、Email、SNMP、SysLog、快照动作字段解释。
- 某条告警是否可以进一步分析数据包。

示例：

```text
最近一小时有哪些紧急告警？
192.168.1.16 最近一天触发了哪些告警？
告警 369652 的详情是什么？
这个告警为什么触发？
最近一天告警数量趋势怎么看？
这个告警有没有关联数据包？
Email 告警通知字段都是什么意思？
```

### 3.2 仍使用 `openclaw-napm-query` 的场景

普通性能指标、对象清单、指标清单、下钻路径、综合分析仍走 query skill：

```text
最近一小时丢包最高的 IP 是谁？
系统中有哪些业务？
BusinessGroup 支持哪些下钻路径？
其他Web应用访问次数最多的客户端是谁？
```

### 3.3 仍使用 `openclaw-napm-packet-analysis` 的场景

只要用户明确要数据包、报文、抓包、pcap/cap、packetsPreview、packetsDown、DownServlet，应走 packet skill。

告警 skill 可以产出 `packetHandoff`，但真正预览、下载、分析数据包由 packet skill 完成。

示例链路：

```text
用户：分析这个告警相关的数据包
OpenClaw：从上轮 alert result 继承 eventId/start/end
OpenClaw -> napm-packet-analysis
```

### 3.4 仍使用 `openclaw-napm-report` 的场景

用户明确要求生成报告、导出 Word/docx/PDF 时，先查询告警，再把告警结构化结果交给 report skill。

示例：

```text
用户：查最近一天所有紧急告警，并导出 Word 报告
OpenClaw -> napm-alert-query
OpenClaw -> napm-report-export
```

## 4. 目录结构

建议新增目录：

```text
skills/openclaw-napm-alert-query/
  SKILL.md
  agents/
    openai.yaml
  references/
    alert-workflow-contract.md
    alert-api-contract.md
    alert-notification-fields.md
  scripts/
    run_alert_query.js
  services/
    AlertApiService.js
    AlertQueryValidator.js
    AlertNormalizerService.js
    AlertAnalyzerService.js
    AlertMetricSeriesService.js
    AlertNotificationExplainerService.js
    AlertNarrationContractService.js
```

### 4.1 `SKILL.md`

职责：

- 描述 skill 边界。
- 明确查询、详情、趋势、通知解释、packet/report 跨 skill 编排规则。
- 声明输入输出契约。
- 声明禁止事项：不修改告警配置、不直接下载数据包、不生成报告文件。

### 4.2 `agents/openai.yaml`

职责：

- 告诉 OpenClaw 何时调用该 skill。
- 指定告警语义触发词。
- 指定与 query/packet/report 的边界。
- 要求 OpenClaw 先构造 `alertQuery`，再调用工具。

### 4.3 `references/alert-workflow-contract.md`

职责：

- 详细描述从自然语言到 `alertQuery` 的构造规则。
- 描述多轮上下文继承规则。
- 描述缺参追问规则。
- 描述告警结果如何转 reportData / packetHandoff。

### 4.4 `references/alert-api-contract.md`

职责：

- 固化接口文档中的四个核心查询接口。
- 说明每个接口的参数、返回结构、字段含义。
- 记录 `categoryType -> groupType1` 映射。
- 记录 `alertsDetail` 的 `eventids` 重复参数要求。
- 记录 `alertsSummaryTimeLine` 严重级别数组顺序不确定的问题。

### 4.5 `references/alert-notification-fields.md`

职责：

- 固化告警任务字段、通知动作字段、全局配置依赖。
- 说明第一阶段只解释不修改配置。
- 说明 Email / SNMP / SysLog / 快照的生效条件。

### 4.6 `scripts/run_alert_query.js`

职责：

- CLI 入口。
- 加载 `.env`。
- 读取 `--queryFile` 或 `--queryJson`。
- 调用 validator / api / normalizer / analyzer。
- 输出稳定 JSON。

示例：

```bash
node skills/openclaw-napm-alert-query/scripts/run_alert_query.js --queryFile ./alert-query.json
```

### 4.7 `services/AlertApiService.js`

职责：

- 通过 `NETINSIDE_HOST`、`NETINSIDE_USERNAME`、`NETINSIDE_PASSWORD` 调用 NetInside。
- 屏蔽鉴权细节。
- 负责请求 URL 构造、重复参数、JSON 解析、错误包装。

### 4.8 `services/AlertQueryValidator.js`

职责：

- 校验 mode。
- 校验 start/end。
- 校验 eventIds。
- 校验 metrics。
- 对毫秒时间戳做安全归一。
- 生成可读错误。

### 4.9 `services/AlertNormalizerService.js`

职责：

- 将接口原始结构归一化。
- 把 `category -> object -> events[]` 压平成 `AlertEvent[]`。
- 把 severity/category/categoryType 转为可读标签。
- 统一 `metrics/value/baseline/unit` 数组形态。

### 4.10 `services/AlertAnalyzerService.js`

职责：

- 统计总数、严重级别分布、分类分布、对象 TopN。
- 识别最高严重级别。
- 识别持续时间最长的事件。
- 识别最常触发指标。
- 根据用户 criteria 做过滤。

### 4.11 `services/AlertMetricSeriesService.js`

职责：

- 对详情事件补查 `timeValues`。
- 一个 metric 一次请求。
- 使用 `categoryType -> groupType1` 映射。
- 为根因叙述提供触发前后趋势。

### 4.12 `services/AlertNotificationExplainerService.js`

职责：

- 根据文档解释告警定义与通知字段。
- 解释 Email / SNMP / SysLog / 快照的配置依赖。
- 不执行 `/admin/alerts.asp?m=add/update`。

### 4.13 `services/AlertNarrationContractService.js`

职责：

- 产出 `narrationInput`。
- 产出 `reportData`。
- 产出 `packetHandoff`。
- 约束 OpenClaw 最终中文回答的数据来源。

## 5. 工具入口设计

插件层新增工具：

```text
napm-alert-query
```

工具参数：

```json
{
  "prompt": "最近一小时有哪些紧急告警？",
  "alertQuery": {
    "mode": "summary",
    "criteria": {
      "start": 1781488800,
      "end": 1781492400,
      "severities": [4]
    }
  },
  "sessionState": {},
  "traceId": "optional"
}
```

工具输出：

```json
{
  "ok": true,
  "mode": "summary",
  "service": "alertsSummary",
  "timeRange": {
    "start": 1781488800,
    "end": 1781492400,
    "displayText": "最近一小时"
  },
  "events": [],
  "summary": {},
  "narrationInput": {},
  "reportData": {},
  "packetHandoff": null,
  "error": null
}
```

## 6. 输入契约

### 6.1 总体结构

```json
{
  "alertQuery": {
    "mode": "summary",
    "criteria": {
      "start": 1781488800,
      "end": 1781492400
    },
    "options": {
      "includeRaw": false,
      "includeTimeline": false,
      "includeDetail": false,
      "includeMetricSeries": false,
      "topObjectsLimit": 10
    }
  }
}
```

### 6.2 `mode`

支持以下模式：

```text
summary
timeline
detail
detail_with_timeseries
analysis
explain_notification
explain_event_fields
```

含义：

- `summary`：查询 `alertsSummary`，返回告警列表和聚合。
- `timeline`：查询 `alertsSummaryTimeLine`，返回告警数量趋势。
- `detail`：通过 eventId 查询 `alertsDetail`。
- `detail_with_timeseries`：查询详情后，对触发指标补查 `timeValues`。
- `analysis`：综合模式，可同时查询摘要、时间线、详情、指标趋势。
- `explain_notification`：解释通知动作字段和生效条件。
- `explain_event_fields`：解释告警事件字段。

### 6.3 `criteria`

```json
{
  "start": 1781488800,
  "end": 1781492400,
  "categories": ["networkAlerts", "AIAlerts"],
  "severities": [4, 3],
  "objects": ["192.168.1.16"],
  "eventIds": ["369652", "369653"],
  "metrics": ["TPIO", "PGTME"],
  "categoryTypes": [3, 68],
  "taskTypes": ["0", "1"],
  "linkTypes": [1, 2],
  "granularity": 60
}
```

字段规则：

- `start` / `end`：可执行查询必须提供根级时间，Unix 秒。
- `categories`：告警分类过滤。
- `severities`：严重级别过滤，`2` 轻微，`3` 重大，`4` 紧急。
- `objects`：告警对象过滤，如 IP、业务组、Web 应用、页面族。
- `eventIds`：详情查询必填。
- `metrics`：补查指标趋势时使用。
- `categoryTypes`：对象类型编码过滤。
- `taskTypes`：普通/智能/动态告警过滤。
- `linkTypes`：数据包关联方式过滤。
- `granularity`：指标趋势粒度，默认 `60` 秒。

### 6.4 `options`

```json
{
  "includeRaw": false,
  "includeTimeline": true,
  "includeDetail": true,
  "includeMetricSeries": true,
  "topObjectsLimit": 10,
  "maxEvents": 200,
  "packetHandoff": true
}
```

字段规则：

- `includeRaw`：是否返回原始接口响应。默认 false。
- `includeTimeline`：是否同时查询时间线。
- `includeDetail`：是否根据摘要结果自动补查详情。
- `includeMetricSeries`：是否补查触发指标趋势。
- `topObjectsLimit`：对象 TopN 聚合数量。
- `maxEvents`：摘要事件最大返回数量，避免超大响应。
- `packetHandoff`：是否为可关联数据包的告警生成 handoff。

## 7. 输出契约

### 7.1 总体结构

```json
{
  "ok": true,
  "mode": "analysis",
  "service": "alertsSummary",
  "timeRange": {
    "start": 1781488800,
    "end": 1781492400,
    "displayText": "最近一小时"
  },
  "summary": {
    "total": 12,
    "bySeverity": {
      "minor": 3,
      "major": 4,
      "critical": 5
    },
    "byCategory": {
      "networkAlerts": 8,
      "AIAlerts": 4
    },
    "topObjects": [
      {
        "group": "192.168.1.16",
        "count": 4,
        "maxSeverity": 4
      }
    ],
    "topMetrics": [
      {
        "metric": "TPIO",
        "count": 3
      }
    ]
  },
  "events": [],
  "details": [],
  "timeline": [],
  "metricSeries": [],
  "packetHandoff": null,
  "narrationInput": {},
  "reportData": {},
  "warnings": [],
  "error": null
}
```

### 7.2 `AlertEvent`

```json
{
  "id": "369652",
  "category": "networkAlerts",
  "categoryLabel": "网络性能告警",
  "group": "192.168.1.16",
  "severity": 4,
  "severityLabel": "紧急",
  "period": 60,
  "start": 1586880000,
  "end": 1586880060,
  "name": "告警名称",
  "metrics": ["TPIO"],
  "value": [123.45],
  "baseline": [100],
  "unit": ["Kbps"],
  "categoryType": 3,
  "groupType": "IPAddress",
  "condition": "if TPIO > 100 then Major else None",
  "operation": "...",
  "tasktype": "0",
  "taskTypeLabel": "静态/普通告警",
  "linkType": 2,
  "linkTypeLabel": "按事件 ID 关联数据包"
}
```

### 7.3 `AlertTimelineBucket`

```json
{
  "category": "networkAlerts",
  "categoryLabel": "网络性能告警",
  "bucketStart": 1586880000,
  "minor": 1,
  "critical": 2,
  "major": 3,
  "rawCounts": [1, 2, 3],
  "orderWarning": "alertsSummaryTimeLine severity array order follows current frontend reading: [minor, critical, major]. Confirm with backend if exact order matters."
}
```

### 7.4 `AlertMetricSeries`

```json
{
  "eventId": "369652",
  "metric": "TPIO",
  "group": "192.168.1.16",
  "categoryType": 3,
  "groupType": "IPAddress",
  "granularity": 60,
  "intervalStart": 1586880000,
  "values": [10.1, 11.2, 9.8],
  "unit": "Kbps"
}
```

### 7.5 `packetHandoff`

```json
{
  "available": true,
  "reason": "ALERT_LINK_TYPE_EVENT_ID",
  "eventId": "369652",
  "linkType": 2,
  "suggestedPacketQuery": {
    "mode": "build_url_only",
    "criteria": {
      "id": "369652",
      "start": 1781488800,
      "end": 1781492400
    }
  }
}
```

linkType 处理建议：

- `linkType=1`：按对象/IP 关联，优先生成 `criteria.ips`。
- `linkType=2`：按事件 ID 关联，优先生成 `criteria.id`。
- 其他或缺失：不生成自动 handoff，只提示用户可按对象或时间范围进一步查包。

### 7.6 `narrationInput`

```json
{
  "schema": "openclaw_napm_alert.v1",
  "language": "zh-CN",
  "mode": "analysis",
  "timeRange": {
    "displayText": "最近一小时",
    "start": 1781488800,
    "end": 1781492400
  },
  "summary": {},
  "events": [],
  "details": [],
  "timeline": [],
  "metricSeries": [],
  "packetHandoff": null,
  "renderPolicy": {
    "target": "final_user_reply",
    "includeRawApiResponse": false,
    "includeSensitiveUrls": false
  }
}
```

### 7.7 `reportData`

```json
{
  "reportType": "diagnostic_report",
  "format": "docx",
  "title": "最近一小时告警分析报告",
  "sourceQuestion": "最近一小时有哪些紧急告警？",
  "timeRange": {
    "displayText": "最近一小时",
    "start": 1781488800,
    "end": 1781492400
  },
  "dataSource": {
    "system": "NAPM",
    "sourceSkill": "openclaw-napm-alert-query",
    "queryService": "alertsSummary"
  },
  "sections": [
    {
      "type": "summary",
      "title": "核心结论",
      "content": "最近一小时共发现 12 条告警，其中紧急 5 条、重大 4 条、轻微 3 条。"
    },
    {
      "type": "table",
      "title": "告警事件列表",
      "rows": []
    }
  ],
  "audit": {
    "traceId": "xxx",
    "apiCalls": []
  }
}
```

## 8. NetInside API 构造

### 8.1 `alertsSummary`

用途：

```text
查询某个时间范围内的告警事件集合。
```

请求：

```text
GET /webservice/NetInside?type=alertsSummary&start=<start>&end=<end>&json=true
```

service 方法：

```js
async getSummary({ start, end }) {
  return this.client.getJson({
    type: 'alertsSummary',
    start,
    end,
    json: 'true'
  });
}
```

返回处理：

```text
category -> group -> event[]
```

归一化为：

```text
AlertEvent[]
```

### 8.2 `alertsSummaryTimeLine`

用途：

```text
按时间桶、告警分类、严重级别聚合告警数量。
```

请求：

```text
GET /webservice/NetInside?type=alertsSummaryTimeLine&start=<start>&end=<end>&json=true
```

service 方法：

```js
async getTimeline({ start, end }) {
  return this.client.getJson({
    type: 'alertsSummaryTimeLine',
    start,
    end,
    json: 'true'
  });
}
```

注意：

当前文档来自前端读取逻辑，数组顺序按 `[轻微, 紧急, 重大]` 或类似方式取值。落地时应：

- 保留 `rawCounts`。
- 输出 `orderWarning`。
- 后续如拿到后端权威说明，再固化顺序。

### 8.3 `alertsDetail`

用途：

```text
根据一个或多个告警事件 ID 查询事件明细。
```

请求：

```text
GET /webservice/NetInside?type=alertsDetail&eventids=<id1>&eventids=<id2>&start=<start>&end=<end>&json=true
```

关键点：

`eventids` 必须使用重复参数：

```text
eventids=369652&eventids=369653
```

不应生成：

```text
eventids[]=369652&eventids[]=369653
```

也不应生成：

```text
eventids=369652,369653
```

service 方法建议单独实现参数序列化：

```js
async getDetail({ eventIds, start, end }) {
  const params = new URLSearchParams();
  params.set('UserName', this.username);
  params.set('Password', this.password);
  params.set('type', 'alertsDetail');
  for (const id of eventIds) {
    params.append('eventids', String(id));
  }
  params.set('start', String(start));
  params.set('end', String(end));
  params.set('json', 'true');
  return this.getJsonBySearchParams(params);
}
```

### 8.4 `timeValues`

用途：

```text
查询告警对象在触发指标上的时间序列。
```

请求：

```text
GET /webservice/NetInside?type=timeValues&start=<start>&end=<end>&metrics=<metric>&granularity=60&numGroups=1&groupType1=<groupType>&groupArgument1=<alertObject>&json=true
```

service 方法：

```js
async getMetricSeries({ metric, groupType, group, start, end, granularity = 60 }) {
  return this.client.getJson({
    type: 'timeValues',
    start,
    end,
    metrics: metric,
    granularity,
    numGroups: 1,
    groupType1: groupType,
    groupArgument1: group,
    json: 'true'
  });
}
```

`groupType` 来自 `categoryType` 映射。

## 9. 映射表

### 9.1 告警分类

```js
const ALERT_CATEGORY_LABELS = {
  networkAlerts: '网络性能告警',
  networkIssueAlerts: '网络异常告警',
  appAlerts: '应用性能告警',
  busAlerts: '业务故障告警',
  userAlerts: '用户体验告警',
  securityAlerts: '安全事件告警',
  AIAlerts: '智能分析告警'
};
```

### 9.2 严重级别

```js
const ALERT_SEVERITY_LABELS = {
  2: '轻微',
  3: '重大',
  4: '紧急'
};
```

### 9.3 `categoryType -> groupType1`

```js
const CATEGORY_TYPE_TO_GROUP_TYPE = {
  0: 'TotalTraffic',
  3: 'IPAddress',
  14: 'BusinessGroup',
  25: 'Application',
  29: 'BusinessGroupLink',
  53: 'IPConversation',
  58: 'Interface',
  63: 'PageFamily',
  67: 'User',
  68: 'WebApplication',
  72: 'MonInterfaceGroup'
};
```

### 9.4 告警任务类型

```js
const ALERT_TASK_TYPE_LABELS = {
  0: '静态/普通告警',
  1: '智能告警',
  3: '动态告警'
};
```

注意：

接口中的 `tasktype` 可能是字符串或数字，归一化时应先转为字符串，再做宽松匹配。

### 9.5 数据包关联类型

```js
const ALERT_LINK_TYPE_LABELS = {
  1: '按对象/IP 关联数据包',
  2: '按事件 ID 关联数据包'
};
```

## 10. 执行链路

### 10.1 告警摘要查询链路

```text
用户：最近一小时有哪些紧急告警？
  |
  v
OpenClaw
  - 判断为 alert summary
  - 解析时间：最近一小时 -> start/end
  - 解析严重级别：紧急 -> severity=4
  - 构造 alertQuery
  |
  v
napm-alert-query
  - validate(mode=summary, start/end)
  - call alertsSummary
  - flatten category/object/events
  - filter severity=4
  - aggregate summary
  - build narrationInput/reportData
  |
  v
OpenClaw
  - 根据 narrationInput 输出中文结果
```

### 10.2 告警详情链路

```text
用户：告警 369652 的详情是什么？
  |
  v
OpenClaw
  - 判断为 alert detail
  - 解析 eventId=369652
  - 如果缺少时间范围，从上下文继承；没有上下文则追问或默认最近一小时
  |
  v
napm-alert-query
  - validate(eventIds/start/end)
  - call alertsDetail
  - normalize detail rows
  - map severity/categoryType/linkType
  - build packetHandoff if possible
  |
  v
OpenClaw
  - 输出告警详情
  - 若 linkType 可关联，提示可继续分析数据包
```

### 10.3 告警触发原因链路

```text
用户：这个告警为什么触发？
  |
  v
OpenClaw
  - 从上轮继承 eventId/start/end
  - mode=detail_with_timeseries
  |
  v
napm-alert-query
  - call alertsDetail
  - 读取 metrics/value/baseline/unit/categoryType/group
  - categoryType -> groupType1
  - 对每个 metric 调 timeValues
  - 组合事件详情 + 指标趋势
  |
  v
OpenClaw
  - 输出：触发指标、实际值、基线、阈值条件、趋势变化
```

### 10.4 告警时间线链路

```text
用户：最近一天告警数量趋势怎么样？
  |
  v
OpenClaw
  - mode=timeline
  - start/end=最近一天
  |
  v
napm-alert-query
  - call alertsSummaryTimeLine
  - normalize buckets
  - aggregate by category/severity/time
  - attach orderWarning
  |
  v
OpenClaw
  - 输出高峰时间段、分类分布、严重级别变化
```

### 10.5 告警到数据包链路

```text
用户：分析这个告警相关的数据包
  |
  v
OpenClaw
  - 从上轮 alert result 继承 eventId/linkType/start/end/group
  - 如果没有详情，先调用 napm-alert-query detail
  |
  v
napm-alert-query
  - 返回 packetHandoff
  |
  v
OpenClaw
  - 构造 packetQuery
  |
  v
napm-packet-analysis
  - build_url_only / preview_only / preview_download_analyze
  |
  v
OpenClaw
  - 输出数据包预览/下载/分析结果
```

`linkType=2` 推荐 packet query：

```json
{
  "mode": "build_url_only",
  "criteria": {
    "id": "369652",
    "start": 1781488800,
    "end": 1781492400
  }
}
```

`linkType=1` 且 group 是 IP 时推荐 packet query：

```json
{
  "mode": "build_url_only",
  "criteria": {
    "ips": ["192.168.1.16"],
    "start": 1781488800,
    "end": 1781492400
  }
}
```

### 10.6 告警到报告链路

```text
用户：把最近一天紧急告警导出成 Word 报告
  |
  v
OpenClaw
  - 先调用 napm-alert-query
  |
  v
napm-alert-query
  - 返回 reportData
  |
  v
OpenClaw
  - 调用 napm-report-export
  |
  v
openclaw-napm-report
  - 生成 docx
  |
  v
OpenClaw
  - 返回文件路径/下载信息
```

## 11. 插件接入点

### 11.1 `openclaw.plugin.json`

新增工具名：

```json
{
  "contracts": {
    "tools": [
      "napm-skill-query",
      "napm-report-export",
      "napm-packet-analysis",
      "napm-alert-query"
    ]
  }
}
```

### 11.2 `napm-openclaw-plugin.remote.js`

新增常量：

```js
const ALERT_SKILL_SCRIPT = process.env.NAPM_ALERT_SKILL_SCRIPT
  || path.join(OPENCLAW_SKILLS_ROOT, 'openclaw-napm-alert-query/scripts/run_alert_query.js');
```

安全工具集合增加：

```js
const SAFE_NAPM_TOOL_NAMES = new Set([
  'napm-skill-query',
  'napm-report-export',
  'napm-packet-analysis',
  'napm-alert-query'
]);
```

新增工具定义：

```js
{
  name: 'napm-alert-query',
  description: 'Query and analyze NetInside/NAPM alert events, alert details, alert timeline, trigger metric series, and alert notification field explanations.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string' },
      alertQuery: { type: 'object', additionalProperties: true },
      sessionState: { type: 'object', additionalProperties: true },
      traceId: { type: 'string' }
    },
    required: ['alertQuery']
  }
}
```

执行方式：

```text
node skills/openclaw-napm-alert-query/scripts/run_alert_query.js --queryJson '<payload>'
```

### 11.3 hook 边界规则

新增告警意图识别：

```text
告警、告警事件、告警详情、告警摘要、告警时间线、紧急告警、重大告警、轻微告警、
alertsSummary、alertsSummaryTimeLine、alertsDetail、
Email 告警、SNMP 告警、SysLog 告警、快照动作
```

边界优先级建议：

```text
1. 报告导出词：报告 / Word / docx / PDF
   -> 若同时含告警数据问题，先 napm-alert-query，再 napm-report-export

2. 数据包词：数据包 / 报文 / 抓包 / pcap / packetsDown / DownServlet
   -> napm-packet-analysis
   -> 若用户说“这个告警相关的数据包”，先从 alert 上下文拿 packetHandoff

3. 告警词：告警事件 / alertsDetail / 告警时间线 / 通知动作
   -> napm-alert-query

4. 普通指标/对象/下钻问题
   -> napm-skill-query
```

## 12. 多轮上下文

建议 session state：

```json
{
  "active_domain": "NAPM_ALERT",
  "last_alert_time_range": null,
  "last_alert_event_ids": [],
  "last_alert_events": [],
  "last_alert_group": null,
  "last_alert_category": null,
  "last_alert_severity": null,
  "last_packet_handoff": null,
  "last_result_available": false,
  "turn_expiry": 3
}
```

继承规则：

- 用户说“这个告警”：继承最近一条或当前选中的 `eventId`。
- 用户说“详情呢”：继承上轮摘要中的事件 ID；若多条事件且未选择，应追问。
- 用户说“为什么”：走 `detail_with_timeseries`。
- 用户说“相关数据包”：使用 `last_packet_handoff`。
- 用户说“导出报告”：使用上轮 `reportData`，不重新查询，除非用户改变时间或过滤条件。
- 用户只改时间，如“最近一天呢”：继承分类、严重级别、对象过滤，只替换 start/end。

## 13. 错误与追问策略

### 13.1 缺时间

对于可执行查询：

- 若上下文有时间，继承。
- 若没有上下文，OpenClaw 可默认最近一小时，或在高风险场景追问。

推荐默认：

```text
告警摘要、时间线：默认最近一小时。
告警详情：如果只有 eventId 但缺时间，优先从上轮继承；没有上下文则追问。
```

### 13.2 缺 eventId

详情类问题必须有 eventId。

如果用户说“这个告警”，但上下文中有多条候选事件，应追问：

```text
你想看哪一条告警详情？可以回复事件 ID，或选择第 1/2/3 条。
```

### 13.3 无数据

空结果不等于失败。

输出应包含：

- 查询时间范围。
- 查询过滤条件。
- 明确说明未查到告警。

### 13.4 接口失败

区分：

- 参数校验失败。
- 鉴权/连接失败。
- 后端返回非 JSON。
- JSON 解析失败。
- timeValues 补查失败但详情成功。

如果详情成功、趋势失败，应返回部分成功：

```json
{
  "ok": true,
  "warnings": [
    {
      "code": "ALERT_METRIC_SERIES_FAILED",
      "message": "告警详情已查询成功，但触发指标趋势查询失败。"
    }
  ]
}
```

## 14. 安全与审计

### 14.1 凭证处理

读取：

```text
NETINSIDE_HOST
NETINSIDE_USERNAME
NETINSIDE_PASSWORD
```

最终回答不得暴露：

- Password
- token
- cookie
- authorization
- secret

URL 中允许展示用户名时，也必须隐藏密码：

```text
UserName=GAIOP&Password=***
```

### 14.2 审计日志

每次执行记录：

- traceId
- mode
- criteria 摘要
- 调用接口类型
- 脱敏 request URL
- rowCount / eventCount
- warnings / error code

建议事件名：

```text
napm_alert_query_received
napm_alert_query_started
napm_alert_api_called
napm_alert_query_completed
napm_alert_query_failed
```

## 15. 测试方案

### 15.1 单元测试

新增测试文件：

```text
test/alert-query-validator.test.js
test/alert-normalizer-service.test.js
test/alert-analyzer-service.test.js
test/alert-api-url-builder.test.js
test/alert-narration-contract.test.js
test/alert-packet-handoff.test.js
test/alert-report-data-contract.test.js
```

重点测试：

- `alertsSummary` 嵌套结构 flatten。
- severity 映射。
- category 映射。
- categoryType -> groupType。
- eventids 重复参数构造。
- timeline rawCounts 保留。
- linkType -> packetHandoff。
- detail_with_timeseries 多 metric 查询计划。
- 缺 eventId 报错。
- 缺 start/end 报错或继承策略。

### 15.2 契约测试样例

摘要输入：

```json
{
  "alertQuery": {
    "mode": "summary",
    "criteria": {
      "start": 1781488800,
      "end": 1781492400,
      "severities": [4]
    }
  }
}
```

预期：

- 调用 `type=alertsSummary`。
- 返回 `events[]`。
- 所有 events severity 均为 4。
- `summary.bySeverity.critical` 正确。

详情输入：

```json
{
  "alertQuery": {
    "mode": "detail",
    "criteria": {
      "eventIds": ["369652", "369653"],
      "start": 1781488800,
      "end": 1781492400
    }
  }
}
```

预期 URL 包含：

```text
eventids=369652&eventids=369653
```

趋势输入：

```json
{
  "alertQuery": {
    "mode": "detail_with_timeseries",
    "criteria": {
      "eventIds": ["369652"],
      "start": 1781488800,
      "end": 1781492400
    },
    "options": {
      "includeMetricSeries": true
    }
  }
}
```

预期：

- 先调用 `alertsDetail`。
- 从 detail 读取 `metrics`、`categoryType`、`group`。
- 再调用 `timeValues`。

### 15.3 插件集成测试

新增测试：

```text
test/napm-openclaw-plugin-alert-routing.test.js
test/napm-openclaw-plugin-alert-report-boundary.test.js
test/napm-openclaw-plugin-alert-packet-boundary.test.js
```

测试目标：

- 告警问题不能被 `napm-skill-query` 截胡。
- 告警数据包问题最终走 `napm-packet-analysis`。
- 告警报告问题先 alert，再 report。
- 普通指标问题仍走 `napm-skill-query`。

## 16. 分阶段落地计划

### 阶段一：只读告警查询

交付：

- `openclaw-napm-alert-query` 目录。
- `summary` / `timeline` / `detail` 三种模式。
- 基础归一化、聚合、narrationInput。
- 插件工具 `napm-alert-query`。
- 基础测试。

不做：

- 自动补查趋势。
- packet handoff。
- reportData。
- 告警配置变更。

### 阶段二：触发原因分析

交付：

- `detail_with_timeseries`。
- categoryType -> groupType 映射。
- 多指标 timeValues 查询。
- 告警原因叙述结构。
- timeline 高峰分析。

### 阶段三：跨 skill 编排

交付：

- `packetHandoff`。
- `reportData`。
- 插件 hook 边界。
- 告警到 packet/report 的集成测试。

### 阶段四：通知机制解释

交付：

- `explain_notification`。
- Email / SNMP / SysLog / 快照字段解释。
- 生效条件检查清单。

仍不做：

- 自动提交 `/admin/alerts.asp?m=add/update`。

### 阶段五：可选配置变更能力

只有在拿到完整后端写入契约、权限边界、审批机制后才考虑。

若实现，必须是独立工具或独立 mode，并要求显式确认：

```text
napm-alert-config-change
```

不应混入查询 skill。

## 17. 验收标准

### 17.1 功能验收

- 能查询指定时间范围内告警摘要。
- 能按严重级别过滤告警。
- 能按告警对象过滤告警。
- 能查询单个或多个 eventId 的详情。
- 能查询告警时间线。
- 能归一化字段并输出中文标签。
- 能识别可转数据包分析的告警。
- 能生成 reportData 供报告 skill 使用。

### 17.2 边界验收

- 普通指标查询不进入 alert skill。
- 数据包请求不由 alert skill 直接下载。
- 报告导出不由 alert skill 直接生成 docx。
- 告警配置修改请求不自动提交生产配置。

### 17.3 安全验收

- 日志和最终回答不暴露密码。
- URL 脱敏。
- 配置变更类请求只解释，不执行。

### 17.4 可复查验收

- 所有调用都有 traceId。
- 审计日志能看到接口类型、参数摘要、结果数量。
- 输出 JSON 包含原始模式、归一化结果、warnings。
- timeline 严重级别数组顺序不确定时明确 warning。

## 18. 推荐最终形态

最终推荐链路如下：

```text
                        +--------------------------+
                        |        OpenClaw          |
                        |  NLU / time / context    |
                        +------------+-------------+
                                     |
       +-----------------------------+-----------------------------+
       |                             |                             |
       v                             v                             v
+--------------+            +----------------+            +------------------+
| napm-query   |            | napm-alert     |            | napm-packet      |
| metrics/meta |            | alert events   |            | packets/pcap     |
+------+-------+            +-------+--------+            +--------+---------+
       |                            |                              |
       v                            v                              v
+--------------+            +----------------+            +------------------+
| NetInside    |            | NetInside      |            | NetInside        |
| top/time/avg |            | alerts* APIs   |            | packet APIs      |
+--------------+            +----------------+            +------------------+
                                    |
                                    v
                            +----------------+
                            | reportData     |
                            | packetHandoff  |
                            +-------+--------+
                                    |
                +-------------------+-------------------+
                |                                       |
                v                                       v
        +---------------+                       +----------------+
        | napm-report   |                       | napm-packet    |
        | docx export   |                       | follow-up      |
        +---------------+                       +----------------+
```

这个形态的核心价值是：

- 告警事件独立建模，查询边界清晰。
- 不破坏现有 `napm-skill-query` 的指标查询契约。
- 告警可以自然衔接数据包和报告。
- 通知机制先解释不修改，避免生产风险。
- 后续如果要做“告警根因分析工作流”，可以在 alert skill 的结构化输出上继续扩展，而不需要推倒现有 query/packet/report 三条链路。
