---
name: summary-report-implementation
description: 综述报告完整实现状态（2026-06-18）——模板、渲染服务、数据聚合技能、测试
metadata:
  type: project
---

综述报告（summary_report）已完成 Phase 1-3 实现：

**模板层**（templates/summary/）：
- `napm_summary_overview_v1.json` — 统一模板，46个 section，通过 `scopes` 字段驱动 6 种综述类型的章节显隐
- `chart-specs.v1.json` — 4 个图表槽位（告警趋势折线/流量趋势折线/慢访问柱状/HTTP错误柱状）
- `narrative-rules.v1.json` — 5 组条件叙述，支持 scopes 过滤（全局/分类各不同措辞）

**渲染引擎**：`SummaryFixedTemplateService.js` 继承 `InspectionFixedTemplateService`，新增 scope 过滤、10 个 rowBuilder、scope-aware 叙述渲染

**数据聚合技能**：`skills/openclaw-napm-summary/` — 完整的 NAPM 技能，包括 SummaryClient（API 调用）、SummaryService（编排/聚合）、SummaryReportDataService（标准化 reportData）、CLI 入口

**关键设计**：scope 系统统一 6 种综述类型（global/network/webApplication/application/businessGroup/alert），一份模板覆盖全部

**测试状态**：61 个测试全部通过（含 35 个集成测试，8 个 Phase）

**Why:** 设计了 [docs/2026-06-18-综述报告设计方案.md] 后，用户要求逐步落实。按照设计方案的三层架构（数据契约→渲染引擎→数据聚合）顺序实现。测试全部通过验证了完整链路正确性。

**How to apply:** 
- 生成综述报告：`node skills/openclaw-napm-summary/scripts/run_summary.js --payload '{"scope":{"type":"global"},"timeRange":{...}}'`
- 修改模板章节：编辑 `templates/summary/napm_summary_overview_v1.json`，每个 section 的 `scopes` 字段控制适用范围
- 新增 scope 类型：在 `SummaryService._plan*` 中增加查询计划方法，在模板中标记新 scopes
- 见 [[2026-06-18-综述报告设计方案]] 和 [[2026-06-18-综述报告实现说明]]
