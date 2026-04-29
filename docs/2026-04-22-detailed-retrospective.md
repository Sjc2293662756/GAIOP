# 2026-04-22 详细复盘记录（可交接版）

## 1. 复盘范围
- 复盘日期：2026-04-22
- 复盘目标：
  - 把 `references` 中 3 份文档真正接入“服务选择 + 路径评分”。
  - 修复“企微入口本应只返回理解流程，但实际执行了查询”的线上问题。
  - 完成远端排查、发布、验证闭环。
- 影响链路：
  - `skills/openclaw-napm-query/scripts/reference-runtime.js`
  - `skills/openclaw-napm-query/scripts/metadata-clarification.js`
  - `skills/openclaw-napm-query/scripts/run_napm_query.js`
  - 远端配置：`/opt/NAPM_Semantic_Gateway/.env`

---

## 2. 问题现象与触发条件

### 2.1 用户侧现象
- 问句：`现在都有哪些业务系统`
- 实际返回（异常）：直接返回“业务系统列表”查询结果，而不是“Skill理解全流程（未执行查询）”。

### 2.2 预期行为
- 在配置为流程模式时，应该返回：
  - decision-layer 输出
  - intent 输出
  - resolvedQuery 输出
  - 明确说明“未向 NAPM 发起真实查询”

---

## 3. 根因分析

### 根因 A：远端配置被回滚
- 远端 `.env` 缺失：
  - `SKILL_UNDERSTANDING_ONLY=true`
  - `SKILL_DISABLE_GATEWAY_BRIDGE=true`
- 导致默认路径回到“执行查询”。

### 根因 B：strict-mode 优先级与流程模式冲突
- `run_napm_query.js` 中 strict-mode 判断会在 understanding-only 前触发。
- 结果：未传 `decision` 时先进入“模型决策必需”阻断分支，干扰理解流程展示。

### 根因 C：发布过程中文件编码风险
- Windows 上传过程中一度把 `run_napm_query.js` 带入 BOM。
- Linux 下 shebang 脚本可能直接报错（`Invalid or unexpected token`）。
- 后续又出现过一次传输异常导致语法损坏（`Unexpected token '}'`），需要强制重新覆盖。

---

## 4. 代码改动详解

## 4.1 `reference-runtime.js`（核心增强）
- 文件：
  - `skills/openclaw-napm-query/scripts/reference-runtime.js`
- 改动目的：
  - 让 `service-modes.md / query-construction.md / runtime-lookup-notes.md` 真正参与可计算逻辑。

### 新增/增强能力
1. 服务候选评分（可解释）
- 新输出：`execution_hint.serviceCandidates`
- 结构：`[{ service, score, reasons[] }]`

2. 路径偏好提示（可解释）
- 新输出：`execution_hint.pathHints`
- 结构包含：
  - `preferredChains`
  - `preferredAnchorType`
  - `preferredTargetType`
  - `preferredIntermediates`
  - `preferredDepth`
  - `confidence`
  - `reasons`

3. 运行时查询优先级
- 新输出：`execution_hint.runtimeLookupPriority`
- 与 `lookupServices` 对齐，提供执行顺序解释。

4. 构建清单增强
- 在 `constructionChecklist` 中按服务类型补充必检项：
  - `topValues` 补 `topMetric/topCount`
  - `timeValues` 补 `granularity`
  - 有 anchor 时补 `anchor object argument`

---

## 4.2 `metadata-clarification.js`（路径收口增强）
- 文件：
  - `skills/openclaw-napm-query/scripts/metadata-clarification.js`
- 改动目的：
  - 把 execution hint（尤其 pathHints）下沉到澄清层评分，减少“无必要路径反问”。

### 关键改动点
1. 接入执行提示
- 新增依赖：`buildExecutionHints`
- 在 `buildClarificationFromMetadata` 中生成/消费 `executionHint`。

2. 候选类型加权
- `inferCandidateTypes(...)` 增加 `executionHint` 参与：
  - `preferredTargetType` 加权
  - `preferredAnchorType` 加权

3. 路径评分加权
- `scorePathDefinition(...)` 增加 `executionHint` 参与：
  - 优先链路命中加分
  - anchor/target 命中加分
  - 中间层命中加分
  - 深度接近加分

4. 自动收口逻辑
- 新函数：
  - `collapseConfidentPathCandidates`
  - `isPathAmbiguous`
- 行为：
  - 高置信第一路径时自动只保留一条候选；
  - 只有分差不明显才触发“路径选择澄清”。

---

## 4.3 `run_napm_query.js`（流程模式优先级修复）
- 文件：
  - `skills/openclaw-napm-query/scripts/run_napm_query.js`

### 关键改动
- strict-mode 判断改为：
```js
if (!understandingOnly && requireModelDecision && !validatedDecisionOverride) {
  ...
}
```

### 修复效果
- 当 `understandingOnly=true` 时：
  - 一定优先走理解流程输出；
  - 不会被 strict-mode 先拦截成“缺 decision”。

---

## 5. 远端排查与发布记录

## 5.1 环境信息
- 主机：`101.254.114.237`
- 用户：`netinside`
- 服务目录：`/opt/NAPM_Semantic_Gateway`
- 进程：`pm2 / napm-gateway`

## 5.2 关键操作（按顺序）
1. 确认线上目录与进程状态
- `pm2 show napm-gateway` 显示 `exec cwd=/opt/NAPM_Semantic_Gateway`

2. 远端哈希对比（发现差异）
- 差异文件：
  - `reference-runtime.js`
  - `metadata-clarification.js`
- 一致文件：
  - `decision-layer.js`
  - `run_napm_query.js`（早期阶段）
  - 旧 `gatewayRoutes.js` 路由文件

3. 发布前备份
- 备份目录：
  - `.codex-backup-20260422_145823`

4. 上传覆盖并重启
- 覆盖：
  - `reference-runtime.js`
  - `metadata-clarification.js`
  - 后续补丁：`run_napm_query.js`
- 重启：
  - `pm2 restart napm-gateway`

5. 修复配置回滚
- 远端 `.env` 明确写入：
  - `SKILL_UNDERSTANDING_ONLY=true`
  - `SKILL_DISABLE_GATEWAY_BRIDGE=true`
  - 保留：`SHOW_UPSTREAM_API_IN_REPLY=true`

6. 处理发布中断事件
- 事件 1：BOM 导致 shebang 报错。
- 事件 2：一次上传内容损坏导致语法错误。
- 处理：强制以无 BOM 文件重新覆盖 + `node --check`。

---

## 6. 验证证据

## 6.1 本地验证
- `node --check` 通过：
  - `reference-runtime.js`
  - `metadata-clarification.js`
  - `run_napm_query.js`
- 用例验证（本地）：
  - 问句：`访问 其他web应用次数最多的IP是谁？`
  - 输出要点：
    - `next_action=GO_DIRECT_QUERY`
    - `preferredService=topValues`
    - `pathHints.preferredChains[0]=WebApplication -> ClientIPs -> IPAddress`

## 6.2 远端验证
- `node --check` 通过：
  - `/opt/NAPM_Semantic_Gateway/skills/openclaw-napm-query/scripts/run_napm_query.js`
- 远端脚本直测（同目录运行）出现：
  - `executionSkipped: true`
  - `skipReason: SKILL_UNDERSTANDING_ONLY`
  - `Skill understanding only (gateway disconnected)`
- 说明：
  - 已回到“只返回流程，不执行查询”。

---

## 7. 关键哈希记录（用于后续比对）

### 本地（最终）
- `decision-layer.js`  
  `E18B25C1D842A6450ADD6C0200A9749D2EF5DBC9B4A8E84F0806BC561F51CF45`
- `metadata-clarification.js`  
  `FE0C122C166506AD7FF16C9869EB590A6797353F6A72D1002B6D79ACE4FBB4C2`
- `reference-runtime.js`  
  `0DB9238F40969090DCE6C75B980EDCE576E54A78FA1499BA7B96CD3D78785EA7`
- `run_napm_query.js`  
  `16E5449810560B804A97FA30756695F516DBDC540F20AC7956D291879B4EF931`

### 远端（最终目标值）
- `reference-runtime.js`  
  `0db9238f40969090dce6c75b980edce576e54a78fa1499ba7b96cd3d78785ea7`
- `metadata-clarification.js`  
  `fe0c122c166506ad7ff16c9869eb590a6797353f6a72d1002b6d79ace4fbb4c2`
- `run_napm_query.js`  
  `16e5449810560b804a97fa30756695f516dbdc540f20ac7956d291879b4ef931`

---

## 8. 当前状态结论
- 参考文档三件套已进入评分链路，不再是“只加载”。
- 路径评分已具备基于 hint 的自动收口能力。
- 企业微信入口已恢复“流程模式”行为（未执行查询）。
- 远端已完成配置修复、代码修复、重启与验证。

---

## 9. 遗留问题与后续建议
- 遗留 1：远端目录非 git 仓库，无法直接用 commit 追踪发布历史。
  - 建议：补一个轻量发布清单（hash + 时间 + 操作人）。
- 遗留 2：仍存在中文编码观测差异（终端显示乱码风险）。
  - 建议：统一 UTF-8 + 禁 BOM + 上传后 `node --check` 作为发布前置。
- 遗留 3：入口 HTTP 调试若缺 payload 关键字段会 400，容易误判业务逻辑。
  - 建议：固定一份最小可用调试 payload 模板。

---

## 10. 关联文档
- `docs/2026-04-22-daily-change-summary.md`（当日简版）
- `docs/2026-04-22-reference-path-service-hints.md`（参考信号接入详版）
