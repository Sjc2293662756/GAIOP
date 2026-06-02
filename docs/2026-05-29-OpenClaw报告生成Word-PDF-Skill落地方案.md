# OpenClaw 报告生成 Word/PDF Skill 落地方案

日期：2026-05-29

## 1. 背景

当前 NAPM 语义网关已经具备自然语言查询、结构化 `resolvedQuery` 构造、skill 执行、综合分析输出等能力。但项目内尚未落地“生成 Word/PDF 报告”的运行时能力。

需要明确两件事：

- Codex 当前环境里的 `documents` skill 只能用于本地辅助生成文档，不属于 OpenClaw 生产运行时能力。
- NAPM 项目如果要让用户在 OpenClaw 中说“生成报告”，必须新增一个 OpenClaw 可识别、可调用、可审计的报告生成 skill。

因此，报告能力不应塞进现有 `openclaw-napm-query` 查询 skill，也不应由 OpenClaw 模型直接拼 Word/PDF。正确方式是：查询 skill 负责产出真实、结构化的数据，报告 skill 负责确定性渲染文件。

## 2. 目标

新增独立报告生成 skill，支持将 NAPM 查询和综合分析结果生成 `.docx` 或 `.pdf` 报告，并返回文件路径或下载链接。

目标能力：

- 支持用户请求“生成报告”“导出 Word”“导出 PDF”。
- 报告内容来自真实 NAPM skill 执行结果。
- 报告结构稳定、可审计、可复现。
- 查询链路和报告渲染链路职责分离。
- OpenClaw 只做语义理解和编排，不直接生成文档内容。

## 3. 非目标

第一阶段不做以下内容：

- 不做复杂在线编辑器。
- 不做用户自定义 Word 模板上传。
- 不做定时报告调度。
- 不做邮件、企业微信附件自动分发。
- 不让报告 skill 自己绕过查询 skill 直接调用 NAPM 南向 API。
- 不让模型自由生成未经结构化校验的报告正文。

这些能力可以在基础链路稳定后作为后续阶段扩展。

## 4. 总体链路

```text
用户请求
  -> OpenClaw 判断为 report_generation
  -> OpenClaw 构造 reportPlan 和 analysisQuery
  -> napm-skill-query 执行真实 NAPM 查询
  -> napm-skill-query 返回 structuredReportData / reportData
  -> openclaw-napm-report 生成 docx/pdf
  -> 返回报告标题、文件路径、下载链接、生成状态
```

链路职责：

- `OpenClaw`：识别是否需要报告，构造 `reportPlan`，编排查询 skill 和报告 skill。
- `openclaw-napm-query`：执行 NAPM 查询和综合分析，产出结构化报告数据。
- `openclaw-napm-report`：消费结构化数据，渲染 Word/PDF 文件。
- `plugin`：提供 schema、边界校验、审计日志，不做隐藏补查。

## 5. 推荐目录结构

新增独立 skill：

```text
skills/openclaw-napm-report/
  SKILL.md
  package.json
  scripts/
    generate_napm_report.js
  services/
    ReportGenerationService.js
    ReportTemplateService.js
    ReportStorageService.js
    PdfExportService.js
  templates/
    quick_report.template.html
    diagnostic_report.template.html
    comparative_report.template.html
  output/
    .gitkeep
```

说明：

- `SKILL.md`：声明报告 skill 的职责、输入输出契约、禁止事项。
- `generate_napm_report.js`：OpenClaw 调用入口，读取 JSON 输入并输出 JSON。
- `ReportGenerationService.js`：报告生成主流程。
- `ReportTemplateService.js`：模板选择、数据绑定、HTML/DOCX 内容渲染。
- `ReportStorageService.js`：报告文件落盘、生成报告 ID、返回访问路径。
- `PdfExportService.js`：PDF 导出能力，可第二阶段实现。
- `templates/`：报告模板，不在代码里硬拼大段 HTML。
- `output/`：本地开发输出目录，生产可改为 `/home/netinside/.openclaw/reports/`。

## 6. 输入契约

报告 skill 接收结构化报告数据，不接收自然语言问题直接生成文档。

示例：

```json
{
  "reportType": "diagnostic_report",
  "format": "docx",
  "title": "最近一天丢包严重 IP 分析报告",
  "generatedAt": "2026-05-29T10:30:00+08:00",
  "sourceQuestion": "生成最近一天丢包最严重 IP 的分析报告",
  "timeRange": {
    "displayText": "最近一天",
    "start": 1779925800,
    "end": 1780012200
  },
  "dataSource": {
    "system": "NAPM",
    "queryService": "topValues",
    "objectType": "IPAddress",
    "metrics": ["PLI", "PLO"]
  },
  "sections": [
    {
      "type": "summary",
      "title": "核心结论",
      "content": "最近一天丢包最严重的 IP 为 ..."
    },
    {
      "type": "table",
      "title": "丢包 Top 10",
      "columns": ["排名", "IP", "流入丢包率", "流出丢包率"],
      "rows": []
    },
    {
      "type": "analysis",
      "title": "问题分析",
      "content": "从丢包率、持续时间、影响对象等角度分析 ..."
    },
    {
      "type": "recommendation",
      "title": "处置建议",
      "items": []
    }
  ],
  "audit": {
    "resolvedQueryId": "xxx",
    "skillRunId": "xxx",
    "apiCalls": []
  }
}
```

输入约束：

- `reportType` 必填。
- `format` 必填，第一阶段支持 `docx`，第二阶段支持 `pdf`。
- `sections` 必填，且必须是数组。
- `timeRange` 必须来自查询链路，不能由报告 skill 自行推断。
- `audit` 应保留 skill 执行 ID、resolvedQuery ID、API 调用摘要。

## 7. 输出契约

成功输出：

```json
{
  "ok": true,
  "reportId": "napm-report-20260529-103000",
  "title": "最近一天丢包严重 IP 分析报告",
  "format": "docx",
  "filePath": "/home/netinside/.openclaw/reports/napm-report-20260529-103000.docx",
  "downloadUrl": "/reports/napm-report-20260529-103000.docx",
  "generatedAt": "2026-05-29T10:30:05+08:00"
}
```

失败输出：

```json
{
  "ok": false,
  "errorCode": "REPORT_DATA_INVALID",
  "message": "报告生成失败：缺少 sections 或查询结果为空"
}
```

错误码建议：

- `REPORT_DATA_INVALID`：输入结构不合法。
- `REPORT_FORMAT_UNSUPPORTED`：请求了暂不支持的格式。
- `REPORT_TEMPLATE_NOT_FOUND`：未找到对应报告模板。
- `REPORT_RENDER_FAILED`：渲染失败。
- `REPORT_STORAGE_FAILED`：文件保存失败。
- `REPORT_PDF_EXPORT_UNAVAILABLE`：PDF 导出环境不可用。

## 8. OpenClaw 侧改造

OpenClaw/plugin 需要新增报告意图和 schema 约束。

示例结构：

```json
{
  "intent": "report_generation",
  "reportPlan": {
    "reportType": "diagnostic_report",
    "format": "docx",
    "target": "IPAddress",
    "topic": "packet_loss",
    "timeRangeKey": "last24hours"
  },
  "analysisQuery": {
    "service": "topValues",
    "queryModeKey": "topn",
    "groups": [
      {
        "type": "IPAddress"
      }
    ],
    "metrics": ["PLI", "PLO"],
    "topMetric": "PLI",
    "topCount": 10
  }
}
```

边界约束：

- 用户请求报告时，不能只构造普通问答 resolvedQuery。
- `reportPlan` 只描述报告目标，不直接携带报告正文。
- `analysisQuery` 必须仍然满足 NAPM 查询契约。
- 如果用户只问“丢包最高是谁”，不生成报告。
- 如果用户说“导出/生成报告/Word/PDF”，才进入报告链路。

## 9. napm-skill-query 改造

现有查询 skill 需要补齐报告友好的结构化输出。

建议在执行结果中新增：

```json
{
  "displayText": "...",
  "narrationStructure": {},
  "reportData": {
    "title": "最近一天丢包严重 IP 分析",
    "summary": {},
    "tables": [],
    "findings": [],
    "recommendations": [],
    "timeRange": {},
    "dataSource": {},
    "audit": {}
  }
}
```

要求：

- `reportData` 必须由真实查询结果生成。
- `reportData.tables` 中的行数据必须与查询结果一致。
- `reportData.timeRange` 必须与实际执行的 `start/end` 一致。
- `reportData.audit` 必须记录查询服务、对象类型、指标、API 摘要。
- 不在查询 skill 中生成 Word/PDF 文件。

## 10. 报告类型

第一阶段建议只做 `diagnostic_report`。

后续扩展：

- `quick_report`：单次查询结果快速报告。
- `diagnostic_report`：针对异常对象或问题原因的诊断报告。
- `comparative_report`：多对象、多时间段对比报告。
- `operation_report`：运维巡检或周期性报告。

`diagnostic_report` 推荐结构：

```text
1. 报告标题
2. 查询背景
3. 时间范围
4. 核心结论
5. 关键数据表
6. 异常对象分析
7. 影响判断
8. 处置建议
9. 数据来源与审计信息
```

## 11. Word/PDF 技术选型

### 11.1 Word

推荐优先使用 Node.js `docx` 库直接生成 `.docx`。

优点：

- 与当前 Node.js skill 运行时匹配。
- 不依赖浏览器。
- 可控地生成标题、段落、表格、页眉页脚。

可选依赖：

```json
{
  "docx": "^8.x",
  "handlebars": "^4.x"
}
```

### 11.2 PDF

PDF 建议第二阶段支持。

推荐路线：

```text
structuredReportData -> HTML 模板 -> Playwright/Puppeteer -> PDF
```

可选依赖：

```json
{
  "playwright": "^1.x"
}
```

如果远端安装 Playwright 成本较高，也可以使用：

```text
DOCX -> LibreOffice headless -> PDF
```

但这种方式依赖系统环境，部署时需要单独验证。

## 12. 文件落点

本地开发：

```text
skills/openclaw-napm-report/output/
```

远端生产：

```text
/home/netinside/.openclaw/reports/
```

每份报告建议保存三个文件：

```text
napm-report-20260529-103000.docx
napm-report-20260529-103000.pdf
napm-report-20260529-103000.json
```

其中 `.json` 保存生成报告时的结构化输入，便于审计、复现和问题排查。

## 13. 审计要求

报告生成必须记录：

- `reportId`
- `reportType`
- `format`
- `sourceQuestion`
- `resolvedQueryId`
- `skillRunId`
- `timeRange`
- `queryService`
- `objectType`
- `metrics`
- `filePath`
- `downloadUrl`
- `generatedAt`
- `errorCode`

审计日志建议事件名：

- `napm_report_generation_requested`
- `napm_report_generation_started`
- `napm_report_generation_completed`
- `napm_report_generation_failed`

## 14. 测试用例

必须覆盖：

- 最小 `diagnostic_report` 输入可以生成 `.docx`。
- 缺少 `sections` 返回 `REPORT_DATA_INVALID`。
- 不支持的 `format` 返回 `REPORT_FORMAT_UNSUPPORTED`。
- 报告文件名包含稳定 `reportId`，不会覆盖旧文件。
- 报告中的时间范围与输入 `timeRange` 一致。
- 报告中的表格数据与输入 rows 一致。
- `openclaw-napm-report` 不调用 NAPM 南向 API。
- 用户未请求报告时，不触发报告生成。
- 用户请求 Word 时，返回 `.docx`。
- 用户请求 PDF 且 PDF 未启用时，返回明确错误，不静默降级。

## 15. 最小可落地版本

第一版只做：

```text
用户：生成最近一天丢包最严重 IP 的分析报告
  -> OpenClaw 构造 reportPlan + topValues 查询
  -> napm-skill-query 查询 IPAddress + PLI/PLO
  -> 形成 reportData
  -> openclaw-napm-report 生成 diagnostic_report.docx
  -> 返回 docx 文件路径
```

第一版范围：

- 只支持 `diagnostic_report`。
- 只支持 `docx`。
- 只支持结构化输入生成报告。
- 不支持 PDF。
- 不支持定时报告。
- 不支持用户上传模板。

## 16. 分阶段实施计划

### 阶段一：报告 skill 骨架

- 新增 `skills/openclaw-napm-report/`。
- 编写 `SKILL.md`。
- 新增 `generate_napm_report.js`。
- 实现输入校验和 JSON 输出。
- 实现 `.docx` 文件落盘。

### 阶段二：查询结果到 reportData

- 在 `openclaw-napm-query` 输出中补充 `reportData`。
- 先覆盖 TopN 查询和综合分析结果。
- 保证 `reportData` 与真实查询结果一致。

### 阶段三：OpenClaw 编排

- 在 plugin schema 中增加 `reportPlan`。
- 约束“生成报告/导出 Word/PDF”才进入报告链路。
- 编排顺序固定为：先查询，再生成报告。
- 禁止报告 skill 直接查询 NAPM。

### 阶段四：远端部署与验收

- 部署 `openclaw-napm-report` skill 到远端。
- 创建 `/home/netinside/.openclaw/reports/`。
- 重启 OpenClaw gateway。
- 使用真实问题验证报告生成。
- 检查 audit log 确认链路没有旁路。

### 阶段五：PDF 和模板增强

- 增加 HTML 模板。
- 增加 PDF 导出。
- 增加更多报告类型。
- 增加封面、页眉页脚、审计附录。

## 17. 验收标准

通过标准：

- 用户请求生成 Word 报告时，OpenClaw 触发 report_generation。
- 查询仍由 `openclaw-napm-query` 执行。
- 报告由 `openclaw-napm-report` 生成。
- 报告文件真实存在。
- 报告内容和查询结果一致。
- 返回中包含报告标题、格式、文件路径或下载链接。
- 审计日志能还原完整链路。

不通过标准：

- OpenClaw 直接编报告正文。
- report skill 自己调用 NAPM API。
- 没有查询结果也生成看似正常的报告。
- 用户没要求报告却自动生成报告。
- PDF 不可用时静默改成 Word。
- 报告数据和即时回答数据不一致。

## 18. 结论

报告生成应该作为独立 OpenClaw skill 落地，而不是复用 Codex 本地 `documents` skill，也不是塞进现有 NAPM 查询 skill。

最稳妥的产品形态是：

```text
查询 skill 产出可信结构化数据
报告 skill 负责确定性文件渲染
OpenClaw 负责语义编排
plugin 负责契约和边界审计
```

这样既能支持 Word/PDF 报告交付，又不会破坏当前正在收口的 NAPM 主查询链路。
