# 巡检报告模板与 Report Skill 落地方案

日期：2026-06-16

## 1. 结论

巡检报告不应该让 `openclaw-napm-report` 自己调用 NAPM 接口或理解自然语言。推荐设计为：

```text
巡检数据采集/查询 skill
  -> 结构化 inspection reportData
  -> 可选图表生成 skill
  -> openclaw-napm-report 专业模板渲染 docx
```

`openclaw-napm-report` 后期只负责三件事：

- 校验巡检报告输入。
- 按巡检报告专业模板生成 Word。
- 落盘 docx 和 audit JSON。

巡检接口调用、运行时认证参数注入、字段归一、巡检判断和图表准备应放在 report skill 之前。这样报告生成链路仍然符合当前项目边界：report skill 是 artifact generator，不是数据查询器。

## 2. 输入材料

本方案基于以下本地材料：

```text
C:\Users\20693\Documents\WXWork\1688856947745793\WeDrive\网深科技\临时共享区\谢尚坤\北京烟草流量分析系统巡检报告_20250214v1.0.docx
G:\my_file\公司产品\NAPM\NAPM_youhua\web\文档\巡检报告接口字段说明.md
```

当前项目相关实现：

```text
skills/openclaw-napm-report/scripts/generate_napm_report.js
skills/openclaw-napm-report/services/ReportInputContractService.js
skills/openclaw-napm-report/services/ReportGenerationService.js
skills/openclaw-napm-report/services/ReportTemplateService.js
skills/openclaw-napm-report/services/ReportStorageService.js
napm-openclaw-plugin.remote.js
```

## 3. Word 模板结构抽象

从 Word 模板抽取出的章节结构如下：

```text
封面
  网深科技流量分析系统
  健康检查报告
  报告日期

目录

1 文档说明
  1.1 流量分析系统检查项说明

2 基本信息

3 巡检信息汇总
  3.1 性能状况
  3.2 数据信息
  3.3 配置信息
  3.4 数据包存储信息
  3.5 流量分析状况
  3.6 业务性能状况

4 巡检总结
```

模板中的核心表格共有 7 张：

| 表格 | 用途 | 表头 |
|---|---|---|
| 1 | 检查项说明 | 检查项目、检查项、检查内容 |
| 2 | 基本信息 | 编号、系统名称、IP地址、软件版本、序列号、启动时长 |
| 3 | 性能状况 | 序列号、检测项、参数、备注 |
| 4 | 数据信息 | 序列号、检测项、参数、备注 |
| 5 | 配置信息 | 序列号、检测项、参数、备注 |
| 6 | 数据包存储信息 | 序列号、检测项、参数、备注 |
| 7 | 巡检总结 | 设备命名、CPU利用率、磁盘容量、丢包数、系统健康、备注 |

模板中还包含 4 个图片位置：

| 位置 | 用途 | 说明 |
|---|---|---|
| 封面 | logo 或封面图 | 固定品牌资源 |
| 3.5 最近1小时流量分布状况 | 趋势图 | 可由图表 skill 生成 PNG 后嵌入 |
| 3.5 最近1天流量分布状况 | 趋势图 | 可由图表 skill 生成 PNG 后嵌入 |
| 3.6 最近七日业务健康状况 | 业务健康图 | 可由图表 skill 或已有截图嵌入 |

因此专业模板至少要支持：

- 封面页。
- 目录或章节索引。
- 固定章节顺序。
- 固定检查说明表。
- 多个指标表。
- 图片/图表 section。
- 检查结果段落和建议段落。
- 巡检总结表与总结正文。

## 4. 接口字段模型

字段说明文档中实际涉及 3 类数据来源：

| 数据来源 | 请求 | 用途 |
|---|---|---|
| 设备综合信息 | `/webservice/NetInside?UserName={user}&Password={password}&type=applianceInfo&json=true` | 基本信息、性能、数据保留、配置 |
| 数据包存储信息 | `/webservice/NetInside?UserName={user}&Password={password}&type=packetsInfo&json=true&{}` | 原始报文保存开始/结束/时长 |
| 软件版本 | `/NetInside/About.jsp?UserName={user}&Password={password}` 的 `#sysVersion` | 报告中的软件版本 |

认证参数约定：

- 与现有 NAPM 查询 API 保持一致，不走 FORM 登录。
- `InspectionClient` 从运行时环境读取 `NETINSIDE_USERNAME` 和 `NETINSIDE_PASSWORD`。
- 请求时统一注入 `UserName` 和 `Password` query 参数。
- 对外展示、audit 摘要、错误信息和日志必须保留 `UserName` 时脱敏策略一致，`Password` 一律写成 `***`。
- 如果接口返回登录页 HTML、401、403 或明确认证失败内容，应视为运行时账号/密码不可用或权限不足。
- 原始响应可以作为受控 audit artifact 保存，但不可把真实密码写入 JSON 审计副本。

字段映射重点：

| 报告区域 | 字段 |
|---|---|
| 基本信息 | 系统名称、IP地址、软件版本、序列号、设备时间、启动时长 |
| 性能状况 | 每秒数据包个数、每秒连接数、每分钟IP地址数、丢包数、数据包重复率、磁盘使用、CPU使用 |
| 数据信息 | 最新数据采集时间、1分钟数据、5分钟数据、1小时数据、1天数据 |
| 配置信息 | 所有应用数量、端口应用数量、服务器应用数量、Web应用数量、URL数量、业务组数量 |
| 数据包存储信息 | 开始时间、结束时间、共计时长 |

关键校验：

- `applianceInfo` 必须存在 `properties` 数组。
- `properties[]` 每项必须包含 `key` 和 `value`。
- 关键字段建议非空：`hostname`、`ipAddress`、`SerialNumber`、`cpuUsage`、`diskusage`、`datainfo`。
- `packetsInfo.rbRange` 必须存在，长度至少为 2，两个值为正整数，且结束时间不小于开始时间。
- 软件版本以 `About.jsp #sysVersion` 为准，不要把 `mktVersion`、`uiVersion`、`dbVersion` 混成一个软件版本。

## 5. 推荐数据契约

建议新增一个专业巡检报告输入契约，但继续包在现有 `reportData` 外壳下：

```json
{
  "schema": "openclaw_napm_report_data.v1",
  "reportType": "inspection_report",
  "templateId": "napm_traffic_health_inspection_v1",
  "format": "docx",
  "title": "流量分析系统健康检查报告",
  "sourceQuestion": "生成流量分析系统巡检报告",
  "inspection": {
    "schema": "openclaw_napm_inspection.v1",
    "customerName": "北京烟草",
    "projectName": "流量分析系统",
    "reportDate": "2025-02-14",
    "timezone": "Asia/Shanghai",
    "devices": [],
    "performance": {},
    "dataRetention": {},
    "configuration": {},
    "packetStorage": {},
    "trafficAnalysis": {},
    "businessPerformance": {},
    "summary": {}
  },
  "sections": [
    {
      "type": "inspection",
      "title": "巡检报告",
      "dataPath": "inspection"
    }
  ],
  "audit": {
    "sourceSkill": "openclaw-napm-inspection",
    "apiCalls": [],
    "rawArtifactPaths": []
  }
}
```

说明：

- `reportType=inspection_report` 用于选择专业报告类型。
- `templateId=napm_traffic_health_inspection_v1` 用于选择具体 Word 版式。
- `inspection` 是强类型巡检数据，供专业模板渲染。
- `sections` 继续保留，是为了兼容现有 report skill 校验；专业模板实际读取 `inspection`。
- `audit` 保留原始接口、采集时间、认证模式、脱敏后的请求 URL、原始响应文件路径。

## 6. inspection 字段结构

### 6.1 基本信息

```json
{
  "devices": [
    {
      "index": 1,
      "systemName": "BJYC",
      "ipAddress": "10.115.245.14",
      "softwareVersion": "4.0.4",
      "serialNumber": "NetInside NAPM 4.0-F935B44BF0843BFE",
      "applianceTime": "2025-02-14 13:52:00",
      "uptime": "1239天2小时16分钟26秒",
      "raw": {
        "address": "101.254.114.238",
        "boxName": "napm",
        "model": "ARX-VXA",
        "mktVersion": "9.5.3",
        "uiVersion": "12.0.0"
      }
    }
  ]
}
```

### 6.2 性能状况

```json
{
  "performance": {
    "status": "warning",
    "items": [
      { "index": 1, "name": "每秒数据包个数", "value": "140115", "remark": "" },
      { "index": 2, "name": "每秒连接数", "value": "1491", "remark": "" },
      { "index": 3, "name": "每分钟IP地址数", "value": "9267", "remark": "" },
      { "index": 4, "name": "丢包数", "value": "0", "remark": "" },
      { "index": 5, "name": "数据包重复率", "value": "66%", "remark": "偏高" },
      { "index": 6, "name": "磁盘使用", "value": "56035381/97499910MB", "remark": "" },
      { "index": 7, "name": "CPU使用", "value": "2%", "remark": "" }
    ],
    "findings": [
      "数据包重复率偏高，占比达到66%。"
    ],
    "recommendations": [
      "建议检查镜像策略、链路聚合、重复流量和采集口配置。"
    ]
  }
}
```

### 6.3 数据信息

```json
{
  "dataRetention": {
    "status": "ok",
    "latestDataTime": "2025-02-14 13:52:00",
    "items": [
      { "index": 1, "name": "最新数据采集时间", "value": "2025-02-14 13:52:00", "remark": "" },
      { "index": 2, "name": "1分钟数据", "value": "30/30天", "remark": "" },
      { "index": 3, "name": "5分钟数据", "value": "60/60天", "remark": "" },
      { "index": 4, "name": "1小时数据", "value": "183/183天", "remark": "" },
      { "index": 5, "name": "1天数据", "value": "1125/1125天", "remark": "" }
    ],
    "findings": ["正常。"]
  }
}
```

### 6.4 配置信息

```json
{
  "configuration": {
    "status": "ok",
    "items": [
      { "index": 1, "name": "所有应用数量", "value": "130", "remark": "" },
      { "index": 2, "name": "端口应用数量", "value": "105", "remark": "" },
      { "index": 3, "name": "服务器应用数量", "value": "5", "remark": "" },
      { "index": 4, "name": "Web应用数量", "value": "20", "remark": "" },
      { "index": 5, "name": "URL数量", "value": "36", "remark": "" },
      { "index": 6, "name": "业务组数量", "value": "30", "remark": "" }
    ],
    "findings": ["正常。"]
  }
}
```

### 6.5 数据包存储信息

```json
{
  "packetStorage": {
    "status": "ok",
    "startTime": "2024-12-24 03:22",
    "endTime": "2025-02-14 13:53",
    "durationText": "52天10小时31分",
    "items": [
      { "index": 1, "name": "开始时间", "value": "2024-12-24 03:22", "remark": "" },
      { "index": 2, "name": "结束时间", "value": "2025-02-14 13:53", "remark": "" },
      { "index": 3, "name": "共计时长", "value": "52天10小时31分", "remark": "" }
    ],
    "findings": ["正常。"]
  }
}
```

### 6.6 流量分析状况

这部分不是静态图片占位，必须先查询真实时序数据，再基于数据生成图表和检查结果。

推荐查询：

| 目标 | service | group | metrics | 时间窗 | granularity |
|---|---|---|---|---|---|
| 最近1小时流量分布 | `timeValues` | `TotalTraffic` | `TPIO,TPI,TPO` | 最近1小时 | `60` 或运行时自适应 |
| 最近1天流量分布 | `timeValues` | `TotalTraffic` | `TPIO,TPI,TPO` | 最近1天 | `3600` 或运行时自适应 |

数据处理要求：

- `inspection` 或上游 query skill 必须保留脱敏后的查询证据。
- 图表必须由 `dataset.points` 生成，不能手工截图占位。
- 检查结果必须由 `InspectionTrafficAnalysisService` 根据时序点计算，不能让 LLM 自由写“正常”。
- 如果查询失败或无数据，应标记 `status=unknown`，并在报告中说明“未获取到流量趋势数据”。

```json
{
  "trafficAnalysis": {
    "status": "ok",
    "recentHour": {
      "title": "最近1小时流量分布状况",
      "queryEvidence": {
        "service": "timeValues",
        "groups": [{ "type": "TotalTraffic" }],
        "metrics": ["TPIO", "TPI", "TPO"],
        "granularity": 60,
        "requestUrlRedacted": "https://host/webservice/NetInside?UserName=GAIOP&Password=***&type=timeValues&..."
      },
      "dataset": {
        "unit": "Kbps",
        "points": [
          { "time": "2025-02-14 13:00:00", "TPIO": 12345, "TPI": 6000, "TPO": 6345 }
        ],
        "stats": {
          "max": 12345,
          "min": 0,
          "avg": 6789,
          "missingPointCount": 0,
          "zeroSegmentCount": 0,
          "spikeCount": 0
        }
      },
      "chart": {
        "type": "image",
        "path": "artifacts/charts/traffic-last-hour.png",
        "mimeType": "image/png",
        "width": 620,
        "height": 120
      }
    },
    "recentDay": {
      "title": "最近1天流量分布状况",
      "queryEvidence": {
        "service": "timeValues",
        "groups": [{ "type": "TotalTraffic" }],
        "metrics": ["TPIO", "TPI", "TPO"],
        "granularity": 3600,
        "requestUrlRedacted": "https://host/webservice/NetInside?UserName=GAIOP&Password=***&type=timeValues&..."
      },
      "dataset": {
        "unit": "Kbps",
        "points": [
          { "time": "2025-02-14 00:00:00", "TPIO": 10000, "TPI": 4500, "TPO": 5500 }
        ],
        "stats": {
          "max": 10000,
          "min": 3000,
          "avg": 6800,
          "missingPointCount": 0,
          "zeroSegmentCount": 0,
          "spikeCount": 0
        }
      },
      "chart": {
        "type": "image",
        "path": "artifacts/charts/traffic-last-day.png",
        "mimeType": "image/png",
        "width": 620,
        "height": 120
      }
    },
    "findings": [
      {
        "level": "ok",
        "text": "最近1小时和最近1天总流量曲线连续，未发现明显中断或异常尖峰。",
        "evidenceRefs": ["trafficAnalysis.recentHour.dataset.stats", "trafficAnalysis.recentDay.dataset.stats"]
      }
    ]
  }
}
```

### 6.7 业务性能状况

业务性能状况也必须先查数据。模板里的“OA系统慢访问”“营销v6 HTTP 500 报错”这类句子，必须来自 `WebApplication` 维度查询结果。

推荐查询：

| 目标 | service | group | metrics | topMetric | 时间窗 |
|---|---|---|---|---|---|
| 慢访问比例/数量 | `topValues` | `WebApplication` | `PGSLPCT,PGNSLPGE,PGTME` | `PGSLPCT` 或 `PGNSLPGE` | 最近7天 |
| HTTP 400 报错 | `topValues` | `WebApplication` | `PGHTTP400` | `PGHTTP400` | 最近7天 |
| HTTP 500 报错 | `topValues` | `WebApplication` | `PGHTTP500` | `PGHTTP500` | 最近7天 |

可选增强：

- 对 Top 异常业务再查 `timeValues`，生成最近七日趋势图。
- 如果只做第一版，最近七日业务健康图可以先由 TopN 结果生成柱状图或组合柱图。

数据处理要求：

- `slowAccess` 和 `httpErrors` 必须来自 query rows。
- `findings` 必须由阈值和查询结果生成，并带 `evidenceRefs`。
- 没有查询结果时不能写“正常”，只能写“未获取到业务性能数据”。
- report skill 只渲染上游给出的结构化结论，不负责解释业务性能是否异常。

```json
{
  "businessPerformance": {
    "status": "warning",
    "queryEvidence": [
      {
        "id": "business-slow-access-top",
        "service": "topValues",
        "groups": [{ "type": "WebApplication" }],
        "metrics": ["PGSLPCT", "PGNSLPGE", "PGTME"],
        "topMetric": "PGSLPCT",
        "topCount": 20,
        "requestUrlRedacted": "https://host/webservice/NetInside?UserName=GAIOP&Password=***&type=topValues&..."
      },
      {
        "id": "business-http400-top",
        "service": "topValues",
        "groups": [{ "type": "WebApplication" }],
        "metrics": ["PGHTTP400"],
        "topMetric": "PGHTTP400",
        "topCount": 20,
        "requestUrlRedacted": "https://host/webservice/NetInside?UserName=GAIOP&Password=***&type=topValues&..."
      },
      {
        "id": "business-http500-top",
        "service": "topValues",
        "groups": [{ "type": "WebApplication" }],
        "metrics": ["PGHTTP500"],
        "topMetric": "PGHTTP500",
        "topCount": 20,
        "requestUrlRedacted": "https://host/webservice/NetInside?UserName=GAIOP&Password=***&type=topValues&..."
      }
    ],
    "healthChart": {
      "type": "image",
      "path": "artifacts/charts/business-health-7d.png",
      "mimeType": "image/png",
      "width": 620,
      "height": 220
    },
    "slowAccess": [
      {
        "businessName": "OA系统",
        "ratio": "2.760%",
        "slowCount": 120,
        "avgPageDelayMs": 860,
        "evidenceRef": "business-slow-access-top.rows[0]"
      }
    ],
    "httpErrors": [
      {
        "businessName": "营销v6",
        "http400": 7536,
        "http500": 180,
        "evidenceRefs": ["business-http400-top.rows[0]", "business-http500-top.rows[2]"]
      },
      {
        "businessName": "用友v6",
        "http400": 7232,
        "http500": 1589,
        "evidenceRefs": ["business-http400-top.rows[1]", "business-http500-top.rows[0]"]
      }
    ],
    "findings": [
      {
        "level": "warning",
        "text": "OA系统出现2.760%慢访问。",
        "evidenceRefs": ["business-slow-access-top.rows[0]"]
      },
      {
        "level": "warning",
        "text": "多个平台存在较多 HTTP 400/500 报错。",
        "evidenceRefs": ["business-http400-top.rows", "business-http500-top.rows"]
      }
    ],
    "recommendations": [
      {
        "text": "建议进一步定位慢访问和 HTTP 报错原因。",
        "basedOn": ["businessPerformance.findings"]
      }
    ]
  }
}
```

### 6.8 巡检总结

```json
{
  "summary": {
    "overallStatus": "warning",
    "devices": [
      {
        "deviceName": "BJYC",
        "cpuUsage": "2%",
        "diskUsage": "56039999/97499910MB",
        "packetDrops": "0",
        "health": "良好",
        "remark": ""
      }
    ],
    "abnormalItems": [
      "数据包重复率偏高。",
      "OA系统慢访问现象较严重。",
      "多个平台 HTTP 报错次数较多。"
    ],
    "conclusion": "其它指标参数在正常范围内，各指标在峰值期间的增长比较平滑，预期增长值在可控范围内。"
  }
}
```

## 7. 模块设计

### 7.1 新增巡检数据采集 skill

建议新增独立 skill：

```text
skills/openclaw-napm-inspection/
  SKILL.md
  scripts/run_inspection_snapshot.js
  services/InspectionClient.js
  services/InspectionFieldMapperService.js
  services/InspectionRuleService.js
  services/InspectionTrafficAnalysisService.js
  services/InspectionBusinessPerformanceService.js
  services/InspectionReportDataService.js
  references/inspection-api-contract.md
```

职责：

- 从运行时环境读取 `NETINSIDE_HOST`、`NETINSIDE_USERNAME`、`NETINSIDE_PASSWORD`。
- 构造带 `UserName` / `Password` query 参数的 NetInside/NAPM 请求。
- 调用 `applianceInfo`、`packetsInfo`、`About.jsp`。
- 查询总流量最近1小时和最近1天时序数据。
- 查询最近7天业务慢访问、HTTP 400、HTTP 500 数据。
- 保存原始响应。
- 按字段说明归一为 `inspection`。
- 执行巡检规则，产出 `status/findings/recommendations`。
- 基于查询数据产出 `trafficAnalysis` 和 `businessPerformance` 的图表数据集、发现和建议。
- 返回 `reportData`，让 report skill 直接消费。

不建议放在 `openclaw-napm-report` 中，因为 report skill 不能查询真实数据。

如果暂时不想新增 skill，也可以先在 `openclaw-napm-query` 中增加一个 `inspectionSnapshot` service，并复用现有 `NapmClient` 的 `UserName` / `Password` 参数注入方式。但长期更推荐独立 skill，因为巡检包含设备信息接口、页面 DOM 解析、多次指标查询、图表数据集生成和巡检规则，和当前单次指标查询链路不是一类能力。

### 7.2 report skill 模板注册机制

当前 `ReportTemplateService` 是一个通用渲染器。建议改为模板注册器：

```text
skills/openclaw-napm-report/services/ReportTemplateRegistry.js
skills/openclaw-napm-report/templates/shared/DocxPrimitives.js
skills/openclaw-napm-report/templates/shared/DocxTableBuilder.js
skills/openclaw-napm-report/templates/shared/DocxImageBuilder.js
skills/openclaw-napm-report/templates/inspection/TrafficHealthInspectionTemplate.js
skills/openclaw-napm-report/templates/generic/GenericReportTemplate.js
```

调用关系：

```text
ReportGenerationService.generate()
  -> ReportTemplateService.renderDocx()
  -> ReportTemplateRegistry.resolve(report.templateId, report.reportType)
  -> TrafficHealthInspectionTemplate.render(report)
```

分发规则：

| 条件 | 模板 |
|---|---|
| `templateId=napm_traffic_health_inspection_v1` | 巡检报告专业模板 |
| `reportType=inspection_report` 且未传 templateId | 默认巡检模板 |
| 其他 reportType | 现有通用模板 |

### 7.3 report skill 输入归一

建议在 `ReportInputContractService` 增加：

```text
normalizeInspectionReportInput()
isInspectionSourceResult()
buildInspectionReportData()
```

支持输入形态：

```json
{ "reportData": { "reportType": "inspection_report", "inspection": {} } }
```

```json
{ "sourceResult": { "inspection": {}, "reportData": {} } }
```

```json
{ "inspection": {}, "templateId": "napm_traffic_health_inspection_v1" }
```

注意：第三种只做输入归一，不做接口采集。

### 7.4 ReportGenerationService 校验

当前支持的 `reportType` 为：

```text
quick_report
diagnostic_report
comparative_report
operation_report
```

需要增加：

```text
inspection_report
```

巡检专业校验建议：

- `reportType` 必须为 `inspection_report`。
- `templateId` 推荐为 `napm_traffic_health_inspection_v1`。
- `inspection.devices` 至少 1 条。
- `inspection.performance.items`、`inspection.dataRetention.items`、`inspection.configuration.items`、`inspection.packetStorage.items` 必须存在。
- 如果缺少关键接口字段，返回 `REPORT_DATA_INVALID` 或 `INSPECTION_SOURCE_INVALID`。
- 如果只是图表缺失，不阻断报告生成，在对应章节写明“未获取到图表数据”，并记录 audit。

### 7.5 图片与图表渲染

需要扩展 `ReportTemplateService` 支持 `ImageRun`。

建议支持两类图片：

```json
{
  "type": "image",
  "path": "absolute/or/workspace/relative/path.png",
  "mimeType": "image/png",
  "width": 620,
  "height": 120,
  "alt": "最近1小时流量分布状况"
}
```

```json
{
  "type": "chart",
  "artifact": {
    "pngPath": "artifacts/charts/traffic-last-hour.png",
    "optionPath": "artifacts/charts/traffic-last-hour.option.json",
    "htmlPath": "artifacts/charts/traffic-last-hour.preview.html"
  }
}
```

巡检模板中，`trafficAnalysis.recentHour.chart`、`trafficAnalysis.recentDay.chart`、`businessPerformance.healthChart` 都应走统一图片构建器。

这与现有 `docs/2026-06-15-图表化报告调用关系设计方案.md` 保持一致：图表在 report skill 之前生成，report skill 只嵌入已有 PNG。

## 8. 字段映射服务

建议新增配置文件：

```text
config/inspection-report-field-map.v1.json
config/inspection-report-rules.v1.json
```

字段映射配置示例：

```json
{
  "applianceInfo": {
    "systemName": ["properties.hostname", "properties.BoxName", "boxName"],
    "ipAddress": ["properties.ipAddress", "properties.IpAddress", "address"],
    "serialNumber": ["properties.SerialNumber", "properties.serialNumber", "serialNumber"],
    "applianceTime": ["properties.appliance_time"],
    "uptime": ["properties.uptime"],
    "packetPerSecond": ["properties.packetPerSecond"],
    "connPerSecond": ["properties.connPerSecond"],
    "ipsPerMinute": ["properties.ipsPerMinute"],
    "packetDrops": ["properties.packetDrops"],
    "packetDupRate": ["properties.packetDupRate"],
    "diskusage": ["properties.diskusage"],
    "cpuUsage": ["properties.cpuUsage"],
    "datainfo": ["properties.datainfo"],
    "applicationCnt": ["properties.applicationCnt"],
    "applStandardCnt": ["properties.applStandardCnt"],
    "applServerCnt": ["properties.applServerCnt"],
    "applWebCnt": ["properties.applWebCnt"],
    "applUrlCnt": ["properties.applUrlCnt"],
    "busGroupCnt": ["properties.busGroupCnt"]
  },
  "aboutPage": {
    "softwareVersion": "#sysVersion"
  },
  "packetsInfo": {
    "packetStorageStart": "rbRange[0]",
    "packetStorageEnd": "rbRange[1]"
  }
}
```

规则配置示例：

```json
{
  "timezone": "Asia/Shanghai",
  "thresholds": {
    "minOneMinuteRetentionDays": 7,
    "packetDropsWarningGreaterThan": 0,
    "packetDupRateWarningGreaterThan": null,
    "diskUsageWarningPercent": 85,
    "cpuUsageWarningPercent": 85,
    "dataLagWarningMinutes": 30,
    "defaultBusinessGroupCount": 4,
    "minPacketStorageDays": null
  }
}
```

规则不要写死在接口解析层。不同客户现场阈值可能不同，应允许按项目覆盖。

## 9. 专业模板渲染细节

### 9.1 封面

封面内容来自：

```text
title = 流量分析系统健康检查报告
brandName = 网深科技流量分析系统
reportDate = inspection.reportDate
customerName = inspection.customerName
```

品牌图片建议放在：

```text
skills/openclaw-napm-report/assets/inspection/
```

如果后续需要完全复刻原 Word 封面，可把封面 logo 或背景图作为固定 PNG 资源嵌入。

### 9.2 目录

第一阶段可生成固定章节目录，不强依赖 Word 自动页码：

```text
1 文档说明
2 基本信息
3 巡检信息汇总
  3.1 性能状况
  3.2 数据信息
  3.3 配置信息
  3.4 数据包存储信息
  3.5 流量分析状况
  3.6 业务性能状况
4 巡检总结
```

当前已采用 Word 原生 TOC 字段实现真实页码：目录由 `Heading 1` / `Heading 2` 自动生成，文档写入 `updateFields` 并将 TOC 字段标记为 dirty，打开 Word 后按真实分页刷新页码。

### 9.3 检查项说明

检查项说明表是固定内容，不应从接口返回中生成。可作为模板常量保存：

```text
TrafficHealthInspectionTemplate.CHECK_ITEMS
```

### 9.4 基本信息表

从 `inspection.devices` 渲染：

```text
编号、系统名称、IP地址、软件版本、序列号、启动时长
```

支持多设备。模板样例是 1 台设备，但数据契约不应限制为单设备。

### 9.5 巡检信息表

性能、数据、配置、数据包存储四类表都使用统一结构：

```json
{
  "items": [
    { "index": 1, "name": "检测项", "value": "参数", "remark": "备注" }
  ],
  "findings": [],
  "recommendations": []
}
```

渲染为：

```text
序列号 | 检测项 | 参数 | 备注
```

### 9.6 流量分析和业务性能

这两节必须由查询数据驱动，图表只是最终展示形式之一：

- 最近1小时流量分布。
- 最近1天流量分布。
- 最近七日业务健康。

渲染规则：

- report skill 优先渲染 `chart.path` 指向的 PNG。
- 如果图表 PNG 不存在，但 `dataset` 存在，可以渲染数据表和文字发现。
- 如果查询数据不存在，写占位说明：

```text
未获取到最近1小时流量分布图，详见审计信息。
```

不要因为图表缺失而生成空白页，也不要在没有 `dataset/queryEvidence` 的情况下写“正常”。

叙述规则：

- `trafficAnalysis.findings` 只能来自流量时序统计，例如缺点、零流量段、尖峰、连续性。
- `businessPerformance.findings` 只能来自 `WebApplication` 查询结果，例如慢访问比例、慢页面数、HTTP 400/500 数。
- 每条发现建议带 `evidenceRefs`，指向具体 query rows 或 dataset stats。

### 9.7 巡检总结

总结表来自 `inspection.summary.devices`。

总结正文由 `inspection.summary.abnormalItems` 和 `inspection.summary.conclusion` 生成。建议不要让 LLM 在 report skill 内自由发挥总结。上游巡检数据 skill 负责把发现和建议结构化。

## 10. OpenClaw / 插件编排

新增巡检能力后，推荐流程如下。

### 10.1 新巡检报告请求

```text
用户：生成北京烟草流量分析系统巡检报告

OpenClaw / 插件：
  1. 判断为巡检报告请求。
  2. 调用 openclaw-napm-inspection。
  3. inspection 内部或编排层完成总流量、业务性能查询。
  4. 基于查询数据生成 findings/recommendations。
  5. 调用 echarts-chart-skill 生成 PNG。
  6. 将 queryEvidence、dataset、PNG artifact 写入 reportData.inspection。
  7. 调用 napm-report-export。
  8. 发送 docx。
```

### 10.2 已有巡检数据，追问导出

```text
用户：将以上巡检结果导出 Word

OpenClaw / 插件：
  1. 复用最近一次 fresh inspection reportData。
  2. 调用 napm-report-export。
  3. 不重新采集，除非用户改变设备、时间或现场范围。
```

### 10.3 插件需要调整的点

如果新增 `napm-inspection-snapshot` 工具：

- 加入安全工具白名单。
- 注册工具 schema。
- 执行后调用 `rememberSkillResult()` 缓存结果。
- `napm-report-export` 不需要理解巡检内容，只要能消费最新 `result.reportData`。

如果暂时复用 `napm-skill-query`：

- 增加 `resolvedQuery.service=inspectionSnapshot`。
- query skill 返回 `reportData.reportType=inspection_report`。
- 插件现有 latest result 逻辑基本可复用。

## 11. 本地文件落点

建议按以下文件落地实现：

```text
config/inspection-report-field-map.v1.json
config/inspection-report-rules.v1.json

skills/openclaw-napm-inspection/SKILL.md
skills/openclaw-napm-inspection/scripts/run_inspection_snapshot.js
skills/openclaw-napm-inspection/services/InspectionClient.js
skills/openclaw-napm-inspection/services/InspectionFieldMapperService.js
skills/openclaw-napm-inspection/services/InspectionRuleService.js
skills/openclaw-napm-inspection/services/InspectionTrafficAnalysisService.js
skills/openclaw-napm-inspection/services/InspectionBusinessPerformanceService.js
skills/openclaw-napm-inspection/services/InspectionReportDataService.js
skills/openclaw-napm-inspection/references/inspection-api-contract.md

skills/openclaw-napm-report/services/ReportTemplateRegistry.js
skills/openclaw-napm-report/services/InspectionReportInputService.js
skills/openclaw-napm-report/templates/shared/DocxPrimitives.js
skills/openclaw-napm-report/templates/shared/DocxTableBuilder.js
skills/openclaw-napm-report/templates/shared/DocxImageBuilder.js
skills/openclaw-napm-report/templates/generic/GenericReportTemplate.js
skills/openclaw-napm-report/templates/inspection/TrafficHealthInspectionTemplate.js
skills/openclaw-napm-report/assets/inspection/
skills/openclaw-napm-report/references/inspection-report-template-contract.md

test/inspection-field-mapper-service.test.js
test/inspection-rule-service.test.js
test/inspection-traffic-analysis-service.test.js
test/inspection-business-performance-service.test.js
test/inspection-report-data-service.test.js
test/inspection-report-template.test.js
test/napm-report-inspection-export.test.js
```

## 12. 实施阶段

### 阶段一：只做静态巡检报告渲染

目标：给定一份 `inspection reportData` JSON，可以生成接近模板结构的 docx。

改动：

- 增加 `inspection_report` reportType。
- 增加模板注册器。
- 增加 `TrafficHealthInspectionTemplate`。
- 增加图片嵌入支持。
- 增加 sample JSON 和模板单测。

验收：

```bash
node skills/openclaw-napm-report/scripts/generate_napm_report.js \
  --input test/fixtures/inspection-report-input.json \
  --outputDir .codex-temp/inspection-report-smoke
```

预期：

- 生成 docx。
- 生成 audit JSON。
- docx 至少包含 7 张业务表。
- 图表缺失时有占位说明，不空白。

### 阶段二：巡检接口采集与字段归一

目标：从真实 NAPM 设备采集字段，生成 `inspection`。

改动：

- 新增 `openclaw-napm-inspection`。
- 实现 `NETINSIDE_HOST`、`NETINSIDE_USERNAME`、`NETINSIDE_PASSWORD` 读取。
- 实现 `UserName` / `Password` query 参数注入。
- 实现请求 URL 脱敏和 audit 脱敏。
- 实现接口请求。
- 实现 `properties[]` 转字典。
- 实现 `About.jsp #sysVersion` 解析。
- 实现 `rbRange` 解析。
- 保存原始响应和 audit。

验收：

- 账号/密码缺失、认证失败或权限不足时返回明确错误。
- applianceInfo 结构异常时不生成正式巡检报告。
- packetsInfo 缺失时报告中标记“未获取到原始数据包存储范围”。

### 阶段三：巡检规则

目标：把接口字段转换成检查结果、异常发现和建议。

改动：

- 增加 `InspectionRuleService`。
- 阈值放在 `config/inspection-report-rules.v1.json`。
- 生成 `status/findings/recommendations`。

验收：

- 丢包数大于 0 能产生关注提示。
- 1 分钟数据小于 7 天能产生说明。
- 业务组数量为 4 能提示可能是默认配置。
- 数据包重复率、CPU、磁盘阈值可通过配置调整。

### 阶段四：流量与业务性能数据查询、图表和叙述接入

目标：先查出最近1小时、最近1天、最近七日业务健康数据，再由数据生成图表和叙述，最后插入巡检报告。

改动：

- `InspectionTrafficAnalysisService` 查询 `timeValues + TotalTraffic + TPIO/TPI/TPO`。
- `InspectionTrafficAnalysisService` 计算缺点、零流量段、尖峰和连续性结论。
- `InspectionBusinessPerformanceService` 查询 `WebApplication` 维度慢访问、HTTP 400、HTTP 500。
- `InspectionBusinessPerformanceService` 根据查询结果生成 `slowAccess/httpErrors/findings/recommendations`。
- 上游编排层或 inspection skill 调用 `echarts-chart-skill`。
- 图表 PNG 路径、queryEvidence 和 dataset 写入 `inspection.trafficAnalysis` 和 `inspection.businessPerformance`。
- report skill 使用 `ImageRun` 嵌图。

验收：

- 没有真实 query rows 时，不允许输出“OA系统出现慢访问”这类结论。
- `businessPerformance.findings[*].evidenceRefs` 能指向具体查询结果。
- `trafficAnalysis.findings[*].evidenceRefs` 能指向具体时序统计。
- PNG 存在时正确嵌入。
- PNG 缺失但 dataset 存在时，报告仍渲染数据表和文字结论。
- 查询失败时给出文字占位和 audit。
- audit 保留 option.json、pngPath、htmlPath。

### 阶段五：插件/远端编排

目标：企业微信里可以说“生成巡检报告”，最终返回 docx。

改动：

- 注册巡检工具或扩展 query service。
- 让巡检结果进入 `rememberSkillResult()`。
- report export 复用最新巡检 `reportData`。
- 保持直接 docx claim 拦截，禁止绕过 `napm-report-export`。

验收：

- 新请求：采集 -> 图表 -> report export。
- 追问导出：复用最新巡检结果，不重复采集。
- PDF 请求：继续明确失败，不静默降级。

## 13. 测试清单

新增测试建议：

| 测试文件 | 覆盖点 |
|---|---|
| `inspection-field-mapper-service.test.js` | `properties[]` 转字典、字段 fallback、单位格式化 |
| `inspection-rule-service.test.js` | 阈值规则、异常发现、建议生成 |
| `inspection-traffic-analysis-service.test.js` | timeValues 结果转流量 dataset、图表数据、连续性/尖峰/中断发现 |
| `inspection-business-performance-service.test.js` | WebApplication 查询结果转慢访问、HTTP 400/500、findings/evidenceRefs |
| `inspection-report-data-service.test.js` | 采集结果转 `inspection reportData` |
| `inspection-report-template.test.js` | 巡检模板能生成 docx，含 7 张核心表 |
| `napm-report-inspection-export.test.js` | 插件能导出最新巡检 reportData |

本地验证命令：

```bash
node --check skills/openclaw-napm-report/services/ReportTemplateService.js
node --check skills/openclaw-napm-report/services/ReportGenerationService.js
npm test -- --runInBand test/inspection-report-template.test.js test/napm-report-inspection-export.test.js
```

如果新增巡检 skill：

```bash
node --check skills/openclaw-napm-inspection/scripts/run_inspection_snapshot.js
npm test -- --runInBand test/inspection-field-mapper-service.test.js test/inspection-rule-service.test.js test/inspection-traffic-analysis-service.test.js test/inspection-business-performance-service.test.js test/inspection-report-data-service.test.js
```

## 14. 风险与决策

### 14.1 不建议直接套 Word 模板占位

可以用 `docxtemplater` 一类方案做 Word 占位填充，但当前项目已经使用 `docx` 包生成报告，且报告要动态插入多张图表、动态多设备表格和审计信息。第一阶段更推荐用代码复刻专业版式，而不是把 `.docx` 当模板引擎。

保留原 Word 模板作为视觉参考即可。

### 14.2 不要把巡检接口调用塞进 report skill

巡检接口需要运行时认证参数、页面 DOM 解析、内部 API 校验和原始响应审计。把这些放入 report skill 会破坏当前边界，后续也难以审计。

### 14.3 图表不是 report skill 的推荐职责

report skill 只嵌入图表 artifact。图表生成和推荐属于编排层或 `echarts-chart-skill`。

### 14.4 阈值必须可配置

字段说明中明确提到部分阈值要按现场标准配置。不要把客户现场规则写死在字段解析函数中。

## 15. 最小可交付定义

第一版可以先不接真实接口，只要求：

- 输入一份 `inspection reportData` JSON。
- 使用 `templateId=napm_traffic_health_inspection_v1`。
- 生成包含封面、目录、文档说明、基本信息、巡检信息汇总、巡检总结的 docx。
- 支持 7 张核心表。
- 支持 3 个图表图片占位。
- 生成 audit JSON。

这个版本完成后，后续再接真实巡检接口和图表生成，风险最小。
