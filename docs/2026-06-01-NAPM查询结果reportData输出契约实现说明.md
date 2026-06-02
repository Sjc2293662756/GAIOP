# NAPM 查询结果 reportData 输出契约实现说明

日期：2026-06-01

## 背景

报告生成 skill 第一阶段已经可以消费结构化报告数据并生成 `.docx`。第二阶段需要让 `openclaw-napm-query` 在真实查询结果中输出 `reportData`，作为后续报告 skill 的输入。

本阶段仍不接 OpenClaw/plugin 编排，不生成 Word/PDF，只补齐查询结果到报告素材的结构化契约。

## 设计原则

- `reportData` 必须来自真实 skill 执行结果。
- `reportData` 与即时回答使用同一份 `summary / narrationStructure / rows / overview`。
- 不在执行内核各分支里分散拼报告数据。
- 不让 reportData 生成逻辑调用 NAPM API。
- 不让 reportData 生成逻辑理解自然语言。

## 实现位置

新增：

```text
skills/openclaw-napm-query/services/ReportDataContractService.js
```

修改：

```text
skills/openclaw-napm-query/services/OpenClawNarrationContractService.js
```

测试：

```text
test/napm-report-data-contract.test.js
```

## 为什么接在 narration contract 后面

`OpenClawNarrationContractService` 已经统一收口：

- `summary`
- `displayText`
- `timeRange`
- `narrationStructure`
- `rows`
- `overview`
- `requestUrl`

报告数据如果在这里生成，就能保证即时回答和报告素材同源。后续报告 skill 只消费 `reportData`，不会再重新解释查询结果，也不会出现“回答一套、报告一套”的问题。

## 输出结构

`buildOpenClawReplyContract()` 现在会在返回值中追加：

```json
{
  "reportData": {
    "schema": "openclaw_napm_report_data.v1",
    "reportType": "quick_report",
    "format": "docx",
    "defaultFormat": "docx",
    "title": "丢包 Top 10",
    "sourceQuestion": "生成最近一天丢包最严重 IP 的分析报告",
    "timeRange": {
      "displayText": "数据时间：...",
      "start": 1779925800,
      "end": 1780012200,
      "timezone": "Asia/Shanghai"
    },
    "dataSource": {
      "system": "NAPM",
      "queryService": "topValues",
      "responseType": "topn",
      "objectType": "IPAddress",
      "metrics": ["PLI", "PLO"],
      "requestUrl": null
    },
    "sections": [],
    "audit": {
      "traceId": null,
      "resolvedQueryId": null,
      "skillRunId": null,
      "service": "topValues",
      "responseType": "topn",
      "requestUrl": null,
      "resolvedQuery": {}
    }
  }
}
```

## 已支持类型

当前支持：

- `topn` -> `quick_report`
- `comprehensive_analysis` -> `diagnostic_report`
- `comprehensive_analysis_with_discovery` -> `diagnostic_report`
- `overview` -> `quick_report`

当前不为以下类型生成 `reportData`：

- `decision_result`
- `security_refusal`
- `clarification_required`
- 其他非查询结果

## TopN 映射

TopN 会生成：

- `summary` 章节：核心结论
- `table` 章节：排行明细
- `recommendation` 章节：后续建议，如果存在 followUp

表格列：

```text
排名 / 对象 / 指标 / 数值 / 单位
```

## 综合分析映射

综合分析会生成：

- `summary` 章节：核心结论
- `table` 章节：分析模块结果
- `finding` 章节：关键发现
- `recommendation` 章节：后续建议，如果存在 followUp

模块表格列：

```text
模块 / 摘要 / 状态
```

## 下一阶段

第三阶段才接 OpenClaw/plugin：

1. plugin schema 增加 `reportPlan`。
2. OpenClaw 识别“生成报告/导出 Word/PDF”时，先调用 `napm-skill-query`。
3. 从 skill 结果中读取 `reportData`。
4. 再调用 `openclaw-napm-report` 生成 `.docx`。
5. 返回报告路径或下载链接。

这样可以继续保持查询主链稳定，避免报告能力反向污染 resolvedQuery 构造。
