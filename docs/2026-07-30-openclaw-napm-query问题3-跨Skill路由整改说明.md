# openclaw-napm-query 问题 3：跨 Skill 路由整改说明

日期：2026-07-30  
状态：本地整改和回归已完成，未执行远端部署。

## 问题与影响

Query Skill 曾把告警查询列为自身能力，并只在“故障分析并出报告”时路由故障诊断。这与工作区的专用 Tool 边界不一致，可能让告警详情或具体对象诊断绕过对应生产流程。

## 最终路由规则

- 告警摘要、时间线、详情和通知字段：`napm-alert-query`。
- 数据包下载、预览和业务页面分析：`napm-packet-analysis`。
- 具体命名对象 + 分析/诊断/排查/根因意图：`napm-fault-diagnosis`，不以是否要求报告为条件。
- 全局排行、统计发现和单指标读取：`napm-skill-query`。
- 报告文件生成：`napm-report-export`。

## 修改内容

- 更新 Query Skill、OpenClaw 接入说明和查询工作流契约。
- 从 Query Skill 能力说明中移除告警事件查询。
- 收紧插件故障诊断守卫，要求诊断意图和具体对象同时成立。
- 保留排行/统计及单指标读取的 Query 快速放行。
- 明确告警数据包仍按告警到数据包专用链路处理。

## 回归验证

- `test/napm-openclaw-plugin-routing-contract.test.js`：具体对象诊断、排行和单指标边界。
- `test/napm-openclaw-plugin-alert-query.test.js`：告警 Tool 路由。
- `test/napm-openclaw-plugin-packet-loss-guard.test.js`：丢包指标查询不误判为数据包分析。
- `test/napm-openclaw-plugin-comprehensive-analysis-guard.test.js`：综合发现流程保持可执行。
- 全量 Jest：73 个 suite、496 个测试全部通过。

## 验收结论

Query Skill 与告警、数据包、故障诊断和报告 Tool 的边界已与工作区规则一致，常见排行和指标读取不会被过度路由。
