# NAPM Semantic Gateway 当日详细复盘（2026-04-27）

## 1. 复盘范围与目标

本文档复盘 2026-04-27 当天围绕网关职责收口（只查不判）所做的改动，重点回答三个问题：

1. 今天到底改了什么（代码与文件级）
2. 这些改动解决了什么问题（链路口径与行为）
3. 是否完成验证与发布（本地+远端）

---

## 2. 当日最终架构口径（统一结论）

### 2.1 职责分工

- OpenClaw/Skill 侧负责：
  - 语义理解
  - 边界判定
  - 打分/决策
  - 请求 JSON 的结构化构建
  - 结果叙述
- Gateway 侧负责：
  - 接收上游结构化查询请求
  - 参数拼装
  - 调用 NAPM API
  - 返回查询结果（含必要执行信息）

### 2.2 网关原则

- 网关不再承担“本地判定/本地打分/本地追问编排”职责。
- 网关主链路保持 query-only，避免本地策略与 OpenClaw 判定冲突。

---

## 3. 今日代码改动详单（按影响面）

## 3.1 RequirementParserService 持续瘦身（核心）

文件：`skills/openclaw-napm-query/services/RequirementParserService.js`

### A. 本地 parse/postProcess 链路明确禁用（保留占位，防误调用）

以下方法保留但直接抛出 `LOCAL_PARSE_DISABLED`：

- `parseToGatewayRequest`（行号约 964）
- `parseAndExecute`（行号约 976）
- `postProcessGatewayRequest`（行号约 1310）

目的：显式阻断本地“自然语言->结构化请求”旧链路，避免绕过 OpenClaw 侧结构化能力。

### B. 清理遗留重复与死代码

- 移除重复的 `buildTopnQueryFromAssistantState` 定义，仅保留一份生效实现。
- 删除多段已无外部调用的旧本地判定辅助逻辑（包括有限动作路由、旧模板收敛辅助等）。
- 减少“后定义覆盖前定义”与历史遗留分支导致的行为不确定性。

### C. 删除 GroupPathPlannerService 依赖，改为直通 pathPlan

- 原先 `mapNaturalLanguageWithMetadata` 调 `groupPathPlannerService.plan(...)`
- 现改为 `buildPassThroughPathPlan(...)`（行号约 859）：
  - `shouldApply: false`
  - `reason: gateway_query_only_mode`
  - 保留 `plannedGroups` 为当前 groups 的镜像

目的：在不影响执行链路的前提下，彻底移除本地路径规划器依赖。

### D. 保留必要执行能力

下列方法仍是当前主链路必要能力，继续保留：

- `executeGatewayRequest`（行号约 991）
- `isSingularTopResultQuestion`（行号约 2429）
- `applyDefaultTopMetricForPacketLossRanking`（行号约 2535）

---

## 3.2 GroupPathPlannerService 物理移除

文件：`历史 GroupPathPlannerService（现已移除）`

- 今日已物理删除（本地与远端均删除）。

目的：避免无用本地路径规划器继续“隐性参与”链路，减少冲突面与维护成本。

---

## 3.3 GroupBuilder 保留（明确仍在主链路）

文件：`skills/openclaw-napm-query/services/GroupBuilder.js`

结论：**仍然有作用，不可删除**。当前用于将 `groups` 转成 NAPM 所需 `groupTypeN/groupArgumentN/numGroups` 参数。

已确认调用点：

- `skills/openclaw-napm-query/services/RequirementParserService.js`（`executeGatewayRequest` 内）
- `旧 gatewayRoutes 路由入口（现已移除，历史上用于参数预览与直接查询接口）`
- `历史 NapmToolService（现已移除）`

---

## 3.4 历史本地判定组件状态（当日确认）

以下文件已不存在（`Test-Path=False`）：

- `旧 requirementRoutes 路由入口（现已移除）`
- `历史 ExecutionAlignmentGuard（现已移除）`
- `历史 FollowUpActionResolver（现已移除）`
- `历史 FollowUpPlanBuilder（现已移除）`
- `历史 ResultNarrationService（现已移除）`
- `历史 OpenClawNapmAssistantService（现已移除）`
- `历史 GroupPathPlannerService（现已移除）`

这与“网关只查不判”目标一致。

---

## 4. 测试与验证记录

## 4.1 本地验证

今日执行并通过：

- `node --check skills/openclaw-napm-query/services/RequirementParserService.js`
- `node --check` 旧 gatewayRoutes 路由文件
- 旧 gatewayRoutes 路由加载校验：`gatewayRoutes-load-ok`
- `npm test -- test/overview-module.test.js`

结果：语法通过、路由加载通过、概览模块单测通过（3/3）。

## 4.2 远端发布验证（101.254.114.237）

发布目标：

- 主机：`101.254.114.237`
- 用户：`netinside`
- 部署目录：`/opt/NAPM_Semantic_Gateway`
- PM2 进程：`napm-gateway`

本轮发布动作：

1. 远端备份：
   - `/opt/NAPM_Semantic_Gateway/.codex-backup-20260427_224748/` 下的旧 services 备份目录
2. 上传并替换：
   - `RequirementParserService.js`
3. 删除远端文件：
   - 远端历史 `GroupPathPlannerService.js`
4. 重启服务：
   - `pm2 restart napm-gateway`

远端验证结果：

- `pm2 status napm-gateway`：`online`
- 旧 gatewayRoutes 路由远端加载校验：`remote-load-ok`
- `RequirementParserService.js` 本地/远端 `sha256` 一致（`match=True`）
- `GroupPathPlannerService.js` 远端存在性检查：`absent`

---

## 5. 今日问题与修复收益

## 5.1 问题类型

- 历史本地解析/判定代码残留较多，容易与上游 OpenClaw 判定冲突。
- 同一服务内存在重复方法定义与不可达代码，增加行为不确定性。
- 已废弃能力仍“可见可调”，给联调和排障带来噪音。

## 5.2 修复收益

- 网关职责边界更清晰：执行层单一职责。
- 冲突面缩小：减少本地兜底判定误触发。
- 维护成本降低：删除无用文件与重复实现。
- 发布可回滚：远端已按文件级做好备份。

---

## 6. 当前风险与后续建议

## 6.1 风险

- 仓库当前仍是大工作区（存在大量历史改动），后续提交时需避免把不相关改动打包。
- 若未来再次引入本地判定逻辑，可能破坏当前“OpenClaw主判、网关只查”的一致性。

## 6.2 建议

1. 以“链路开关+最小文件集合”方式继续清理，避免一次性大范围改动难回归。
2. 增加一组 gateway-only 回归用例（无 decision、有 resolvedQuery、异常路径）做发布前门禁。
3. 固化远端发布脚本（备份、替换、重启、hash 校验、健康检查）为标准 SOP。

---

## 7. 回滚预案（本次发布）

如需回滚本次改动，可在远端执行：

1. 恢复解析器文件：
   - 从 `/opt/NAPM_Semantic_Gateway/.codex-backup-20260427_224748/` 下的旧 services 备份目录恢复 `RequirementParserService.js`
2. 恢复路径规划器文件（若需要）：
   - 从同目录备份恢复 `GroupPathPlannerService.js`
3. 重启服务：
   - `pm2 restart napm-gateway`

---

## 8. 一句话结论

2026-04-27 的核心成果是：把网关进一步收口为“只查不判”的执行层，清掉本地路径规划与判定残留，完成本地验证与远端发布，链路边界较昨日更稳定可控。
