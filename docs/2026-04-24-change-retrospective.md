# 2026-04-24 当日改动复盘（OpenClaw 判定/评分上收）

## 1. 复盘目的
- 记录 2026-04-24 当天围绕「判定与评分上收 OpenClaw、网关只负责查询执行」的核心改造。
- 明确哪些链路已下线、哪些错误码用于硬阻断、当前请求路径如何流转。
- 给后续排障和迭代提供统一事实基线，避免重复回滚和职责混淆。

## 2. 当日目标（与你确认后的最终口径）
- 所有问题的判定与评分都在 OpenClaw/上游完成。
- 网关侧不做本地 regex 判定、不做本地 parse/postProcess 打分收敛。
- 网关仅消费上游给定的结构化元数据，拼装并执行 NAPM API。
- 本地兜底判定/打分链路全部移除或硬禁用，避免再次“抢判”。

## 3. 关键提交（按时间）

1. `d682275`（2026-04-24 13:06:34 +0800）  
   `refactor(decision-layer): disable local hard-boundary dictionary matching`
2. `ea56828`（2026-04-24 13:41:03 +0800）  
   `refactor(decision-layer): remove legacy local regex judging`
3. `1c03406`（2026-04-24 18:20:19 +0800）  
   `chore: disable local parse/postProcess and enforce upstream resolvedQuery`

## 4. 代码改动总览（核心）

### 4.1 Skill 判定层去本地规则化
- 文件: `skills/openclaw-napm-query/scripts/decision-layer.js`
- 动作:
  - 删除/下线本地硬边界词典匹配和本地 regex 判定主链。
  - 仅保留最小契约能力:
    - `createDefaultSessionState`
    - `validateDecisionContract`
    - `buildIntent`
- 效果:
  - Skill 判定层不再做“词典驱动的强判定”，转为只消费上游 decision contract。

### 4.2 Skill 执行器强制结构化 query 输入
- 文件: `skills/openclaw-napm-query/scripts/run_napm_query.js`
- 动作:
  - `resolveResolvedQuery` 只接受结构化对象来源（`resolvedQuery` / `resolvedQuerySeed` / JSON query）。
  - 移除本地 `RequirementParserService.parseToGatewayRequest(...)` 兜底调用。
  - 无结构化入参时直接报错:
    - `Structured resolvedQuery is required in upstream-execution mode; local parse/postProcess is disabled.`
- 效果:
  - Skill 不再从自然语言本地重建请求，杜绝“执行器偷偷再判一次”。

### 4.3 Gateway skill.query 路由去 parse fallback
- 文件: `旧 gatewayRoutes 路由文件（现已移除）`
- 关键点:
  - `resolveQueryOnlyExecutionContract(...)` 要求上游结构化执行契约。
  - 缺失结构化 seed 时统一 400:
    - `code: UPSTREAM_RESOLVED_QUERY_REQUIRED`
  - 不再调用本地 parse fallback 生成 query。
- 效果:
  - 旧 skill.query 网关接口彻底改成“查询执行器”，不是“查询理解器”。

### 4.4 Requirement API 入口硬禁用本地 parse
- 文件: `旧 requirementRoutes 路由文件（现已移除）`
- 动作:
  - `POST /api/requirement/parse` -> 返回 `410`，错误码 `LOCAL_PARSE_DISABLED`
  - `POST /api/requirement/parse-and-execute` -> 返回 `410`，错误码 `LOCAL_PARSE_DISABLED`
- 效果:
  - 明确对外宣布本地 parse 链路下线，避免外部继续调用旧接口。

### 4.5 RequirementParserService 本体硬禁用
- 文件: `skills/openclaw-napm-query/services/RequirementParserService.js`
- 动作:
  - 在以下方法入口直接抛错:
    - `parseToGatewayRequest`（约 938 行）
    - `parseAndExecute`（约 1074 行）
    - `postProcessGatewayRequest`（约 1444 行）
  - 抛错文案:
    - `Local parse/postProcess chain is disabled. Please provide upstream structured resolvedQuery.`
  - 错误码:
    - `LOCAL_PARSE_DISABLED`
- 效果:
  - 即便历史路径误调用到 service，也会立刻阻断，不会隐式继续旧逻辑。

### 4.6 删除遗留语义服务文件
- 删除文件: `历史 NapmSemanticGatewayService（已删除）`
- 同步处理:
  - 移除旧 gatewayRoutes 中对应 import/路由引用。
- 效果:
  - 减少旧语义入口干扰，避免与“上游判定、网关执行”模型冲突。

## 5. “现在评分与构建 JSON”的实际流程（改后）

1. 上游/OpenClaw 侧完成语义理解、判定、评分（confidence、mode、action 等）。
2. 上游输出结构化执行信息（`assistantDecision + resolvedQuerySeed/resolvedQuery`）。
3. 网关 `skill.query` 只做:
   - 合同校验
   - 参数组装
   - NAPM API 执行
   - 结果整形返回
4. 若缺失结构化执行种子:
   - 直接 400 `UPSTREAM_RESOLVED_QUERY_REQUIRED`
   - 不会再本地 parse 自然语言。

## 6. 你今天反馈的线上现象，对应根因映射

### 6.1 “AI语义服务不可用”
- 现象: 问题本身是有效的，但回复“当前 AI 语义服务不可用”。
- 典型根因:
  - 上游判定链路失败/未返回有效 decision；
  - 或网关在 query-only 模式下拿不到结构化 seed，被硬阻断。
- 当前改造后行为:
  - 这类问题应通过明确错误码快速定位（`UPSTREAM_RESOLVED_QUERY_REQUIRED` / `LOCAL_PARSE_DISABLED`），避免模糊提示。

### 6.2 “信息完整却进入诊断澄清”
- 现象: 类似“系统中的业务系统有哪些”仍进入澄清/诊断话术。
- 根因方向:
  - 上游语义目标分类未稳定命中 inventory/list；
  - 或未生成可执行 resolvedQuery seed，导致执行器只能走澄清分支。
- 当前改造价值:
  - 网关不再二次判定，问题可聚焦到上游判定配置，不再出现“谁在改写意图”。

### 6.3 “预期只输出 JSON，却仍查出数据”
- 历史原因:
  - 旧链路存在本地 fallback，会在某些路径自行补 query 并执行。
- 改造后:
  - 无 seed 不执行；有 seed 才执行。职责边界可控且可预测。

## 7. 验证与测试记录（当日）

### 7.1 语法检查（本地）
- 已通过:
  - `node --check skills/openclaw-napm-query/scripts/decision-layer.js`
  - `node --check skills/openclaw-napm-query/scripts/run_napm_query.js`
  - `node --check` 旧 gatewayRoutes 路由文件
  - `node --check` 旧 requirementRoutes 路由文件
  - `node --check skills/openclaw-napm-query/services/RequirementParserService.js`

### 7.2 行为验证（当日联调口径）
- `POST /api/requirement/parse`:
  - 预期 `410` + `LOCAL_PARSE_DISABLED`
- `POST` 旧 skill.query 网关接口（无结构化 seed）:
  - 预期 `400` + `UPSTREAM_RESOLVED_QUERY_REQUIRED`
- 同接口（带结构化 seed）:
  - 可进入执行链路并请求 NAPM（是否成功由后端/参数有效性决定）

## 8. 远端同步记录（当日执行）
- 目标服务器: `101.254.114.237`
- 账户: `netinside`
- 部署目录: `/opt/NAPM_Semantic_Gateway`
- 动作:
  - 上传核心改动文件（decision-layer、run_napm_query、旧 gateway/requirement routes、RequirementParserService）
  - 删除远端历史 NapmSemanticGatewayService
  - 重启服务: `pm2 restart napm-gateway`
  - 健康检查: `GET http://127.0.0.1:8083/health` 返回正常

## 9. 本次改造的边界与已知风险
- 当前已明确收口的是:
  - Skill 执行链路
  - requirement parse 入口链路
  - skill.query 的本地 parse fallback
- 仍建议下一步继续做一次“全路由清单审计”:
  - 确认没有其他入口在隐式消费自然语言并做本地意图重判。
- `RequirementParserService` 目前是“硬禁用”而非物理删除:
  - 优点: 回滚可控、排障有迹可循；
  - 风险: 未来开发者误以为可用，建议在 README/架构图标记“deprecated-disabled”。

## 10. 给后续复盘的建议关注点
- 上游 decision 的契约完整性（mode/action/confidence/seed）。
- 上游语义分类配置是否稳定覆盖高频问法（尤其 inventory 与 topn 的分流）。
- 网关侧只保留执行器职责，不再引入任何“本地理解自然语言”的新增逻辑。
- 联调必须带 requestId 与错误码留痕，避免再次出现“不可用但无定位信息”。

---

本文件只覆盖 2026-04-24 当天围绕“判定/评分上收 + 网关查询执行化”的主线改造，不覆盖仓库中其他历史并行改动。
