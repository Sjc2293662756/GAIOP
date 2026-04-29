# 2026-04-22 参考文档接入路径评分与服务选择

## 背景
- 目标：把 `service-modes.md`、`query-construction.md`、`runtime-lookup-notes.md` 从“仅加载”变为“可计算、可解释”的运行时信号。
- 重点问题：路径候选过度澄清、服务选择解释性弱、lookup 服务优先级不透明。

## 本次改动
- 文件：`skills/openclaw-napm-query/scripts/reference-runtime.js`
  - 重构为 UTF-8 可读实现，保留原导出接口：
    - `loadKnowledge`
    - `getReferenceSignals`
    - `buildConceptualAnswer`
    - `buildExecutionHints`
  - 新增“文档驱动信号”：
    - 服务候选评分：`serviceCandidates`（含分数和原因）
    - 路径偏好提示：`pathHints`
      - `preferredChains`
      - `preferredAnchorType`
      - `preferredTargetType`
      - `preferredIntermediates`
      - `preferredDepth`
      - `confidence`
    - 运行时查验优先级：`runtimeLookupPriority`
  - `buildExecutionHints` 现在会基于三个参考文档共同产出：
    - `preferredService`
    - `serviceCandidates`
    - `lookupServices`
    - `pathHints`
    - `constructionChecklist`

- 文件：`skills/openclaw-napm-query/scripts/metadata-clarification.js`
  - 接入 `buildExecutionHints`，让澄清层消费 `execution_hint.pathHints`。
  - 候选类型评分新增执行提示加权：
    - `preferredTargetType`、`preferredAnchorType` 参与类型分数。
  - 路径评分新增执行提示加权：
    - 优先链路、锚点类型、目标类型、中间层、层级深度参与分数。
  - 新增自动收口逻辑：
    - `collapseConfidentPathCandidates`：当第一候选明显领先时只保留一条路径。
    - `isPathAmbiguous`：仅在分差不足时保留“路径澄清”。
  - `buildClarifyingQuestion` 调整为仅在路径确实歧义时才问“选路径”。

## 验证结果
- 本地语法校验通过：
  - `reference-runtime.js`
  - `decision-layer.js`
  - `metadata-clarification.js`
- 本地决策快照（`访问 其他web应用次数最多的IP是谁`）：
  - `next_action=GO_DIRECT_QUERY`
  - `preferredService=topValues`
  - `pathHints.preferredChains[0]=WebApplication -> ClientIPs -> IPAddress`

## 远端排查与发布
- 目标机器：`101.254.114.237`（`netinside`）
- 运行目录：`/opt/NAPM_Semantic_Gateway`
- PM2 进程：`napm-gateway`
- 远端一致性检查（SHA256）：
  - 一致：`decision-layer.js`、`run_napm_query.js`、旧 `gatewayRoutes.js` 路由文件
  - 不一致并已更新：
    - `skills/openclaw-napm-query/scripts/reference-runtime.js`
    - `skills/openclaw-napm-query/scripts/metadata-clarification.js`
- 发布前备份：
  - `/opt/NAPM_Semantic_Gateway/.codex-backup-20260422_145823/...`
- 发布后操作：
  - `pm2 restart napm-gateway`
  - 进程状态：`online`

## 备注
- 在裸 shell 下直连元数据服务仍可能遇到证书链问题（`self-signed certificate`）；PM2 运行环境与线上调用链不受本次改动影响。
