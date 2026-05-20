# 2026-05-08 OpenClaw NAPM Skill 远端同步与发布操作手册

## 1. 目的

这份文档用于固定当前服务器的真实运行口径，并沉淀后续可复用的发布步骤。

适用场景：

- 本地修改了 `NAPM_Semantic_Gateway` 仓库代码
- 需要把变更同步到远端真实运行环境
- 需要确认改动是否已经被 `OpenClaw` 正式服务使用

---

## 2. 当前真实运行口径

服务器信息：

- 地址：`101.254.114.237`
- 用户：`netinside`

当前真实运行的不是旧的 PM2 `napm-gateway`，而是 `OpenClaw` 的 user service：

- 服务名：`openclaw-gateway.service`
- 启动方式：`systemctl --user`
- 真实执行器路径：`/home/netinside/.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js`

远端 `OpenClaw` 服务当前会通过环境变量 `NAPM_SKILL_EXECUTOR` 调用该 skill 执行器。

本次核实到的关键事实：

- `/opt/NAPM_Semantic_Gateway` 目录存在，但当前不是独立常驻服务
- `pm2 list` 为空
- `pm2 show napm-gateway` 不存在
- 实际在线的是 `openclaw-gateway.service`
- 真实生效 skill 目录是：
  - `/home/netinside/.openclaw/skills/openclaw-napm-query`

因此：

**本地仓库改完后，必须同步到 `/home/netinside/.openclaw/skills/openclaw-napm-query`，然后重启 `openclaw-gateway.service`，改动才会真正生效。**

---

## 3. 当前职责边界

当前主链路是：

1. 用户消息进入 OpenClaw / 企业微信插件
2. OpenClaw 主链负责：
   - 边界判断
   - 追问理解
   - 澄清判断
   - 构造 `resolvedQuery`
   - 最终中文叙述
3. OpenClaw 调用 NAPM skill 执行器
4. skill 执行器查询 NAPM / NetInside API
5. skill 返回 `summary / rows / structuredRows / narrationInput`
6. OpenClaw 组织最终回复

当前不应再按旧口径理解为：

- `/opt/NAPM_Semantic_Gateway` 自己作为独立网关常驻运行
- 改完 `/opt` 后只重启 `pm2 restart napm-gateway`

---

## 4. 两套目录的角色

### 4.1 源码树

源码树路径：

- `/opt/NAPM_Semantic_Gateway`

它当前更像：

- 远端源码工作目录
- 历史运行目录
- 本地仓库在服务器上的镜像/同步来源

### 4.2 真正运行的 skill 目录

真实运行目录：

- `/home/netinside/.openclaw/skills/openclaw-napm-query`

它当前更像：

- OpenClaw 直接调用的 skill 运行包
- 当前线上真实生效目录

---

## 5. 已确认的目录差异结论

当前 `/opt/NAPM_Semantic_Gateway/skills/openclaw-napm-query` 与 `/home/netinside/.openclaw/skills/openclaw-napm-query` 已经发生漂移，不是严格镜像关系。

### 5.1 只在 `/opt` skill 子目录存在的文件

- `scripts/decision-layer.js`
- `scripts/reference-runtime.js`
- `scripts/run_napm_query.js.bak_`
- `scripts/run_napm_query.js.bak_20260428_114432`
- `scripts/run_napm_query.js.bak_20260428_114455`
- `scripts/run_napm_query.js.synced_`
- `services/ArgumentResolutionService.js`
- `services/CandidateSpecBuilder.js`
- `services/MetricDomainStrategyService.js`
- `services/MetricResolveService.js`
- `services/MetricSemanticDisambiguationService.js`
- `services/NaturalLanguageQueryMapper.js`
- `services/ObjectTypeDisambiguationService.js`
- `services/PathResolveService.js`
- `services/ResolvedSpecBuilder.js`
- `services/ScopeContextPreservationService.js`
- `services/ServiceModeDisambiguationService.js`
- `services/TimeResolveService.js`
- `services/TimeSemanticEnhancementService.js`

### 5.2 只在 `~/.openclaw` skill 目录存在的文件

- `package.json`
- `package-lock.json`
- `node_modules/...`
- `scripts/.backup_20260507_153007/overview-module.js`
- `scripts/.backup_20260507_overview_planner/overview-module.js`
- `scripts/.backup_probe/overview-module.js`
- `scripts/OverviewBudget.js`
- `scripts/OverviewCandidateRegistry.js`
- `scripts/OverviewExecution.js`
- `scripts/OverviewPlanCompiler.js`
- `scripts/OverviewPlanner.js`
- `scripts/OverviewResultReducer.js`
- `scripts/metadata-clarification.js`
- `scripts/overview-module.js.try1`
- `scripts/overview-module.js.uploading`

### 5.3 两边都存在但内容不同的文件

- `SKILL.md`
- `agents/openai.yaml`
- `references/capability-mapping.md`
- `references/openclaw-integration.md`
- `scripts/overview-module.js`
- `scripts/run_napm_query.js`
- `services/DimensionMappingService.js`
- `services/MetricMappingService.js`
- `services/NapmClient.js`
- `services/NapmMetadataService.js`
- `services/OpenClawNarrationContractService.js`
- `services/QueryMetadataConstraintService.js`
- `services/RequirementParserService.js`

### 5.4 风险结论

这意味着：

- 不能默认认为 `/opt` 与 `~/.openclaw/skills/openclaw-napm-query` 完全一致
- 不能直接把 `/opt` 整个目录粗暴覆盖到 `~/.openclaw/...`
- 发布时必须按“明确文件范围”同步

---

## 6. 发布原则

以后推送时遵循下面几条原则：

1. 以 `~/.openclaw/skills/openclaw-napm-query` 作为真实发布目标目录
2. 以 `openclaw-gateway.service` 作为真实重启目标
3. 小改动优先按文件同步
4. 中等改动可同步整个 `skills/openclaw-napm-query/` 子树，但要排除线上专有依赖和备份文件
5. 大改动发布前先检查是否新增了 `require()` 依赖文件
6. 不再把 `pm2 restart napm-gateway` 当作当前主流程发布动作

---

## 7. 推荐发布流程

## 7.1 本地修改与检查

本地完成改动后，至少先检查：

- 目标文件是否位于 `skills/openclaw-napm-query/`
- 是否新增了新的 service / script 依赖
- 是否改动了 `agents/openai.yaml` 或 `SKILL.md`
- 是否需要同时同步多个互相依赖的文件

可选本地检查：

```bash
node --check skills/openclaw-napm-query/scripts/run_napm_query.js
npm test
```

---

## 7.2 小改动发布：按文件同步

适用场景：

- 只改了 1~5 个文件
- 文件依赖关系清晰
- 不想碰远端已有 `node_modules/package*.json`

示例：

```bash
scp skills/openclaw-napm-query/scripts/run_napm_query.js netinside@101.254.114.237:/home/netinside/.openclaw/skills/openclaw-napm-query/scripts/
scp skills/openclaw-napm-query/services/RequirementParserService.js netinside@101.254.114.237:/home/netinside/.openclaw/skills/openclaw-napm-query/services/
scp skills/openclaw-napm-query/agents/openai.yaml netinside@101.254.114.237:/home/netinside/.openclaw/skills/openclaw-napm-query/agents/
```

如果改了多个相关文件，务必一并同步，不要只传入口脚本。

---

## 7.3 中等改动发布：同步整个 skill 子树

适用场景：

- 本次改动横跨多个脚本和 services
- 希望减少逐个传文件的漏传风险
- 但又不希望覆盖远端专有运行时文件

推荐命令：

```bash
rsync -av \
  --exclude 'node_modules' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  --exclude '.backup*' \
  skills/openclaw-napm-query/ \
  netinside@101.254.114.237:/home/netinside/.openclaw/skills/openclaw-napm-query/
```

这个方式会保留远端 skill 目录自己的：

- `node_modules`
- `package.json`
- `package-lock.json`
- 备份目录

---

## 7.4 发布后重启

同步完成后，在服务器执行：

```bash
systemctl --user restart openclaw-gateway.service
```

说明：

- 当前真实生效服务是 `openclaw-gateway.service`
- 不是 `pm2 restart napm-gateway`

---

## 7.5 发布后验活

至少做下面几步：

### 1. 检查服务状态

```bash
systemctl --user status openclaw-gateway.service --no-pager
```

期望看到：

- `active (running)`

### 2. 看最近日志

```bash
journalctl --user -u openclaw-gateway.service -n 50 --no-pager
```

重点关注：

- 是否有 `syntax error`
- 是否有 `Cannot find module`
- 是否有插件加载失败
- 是否有 NAPM skill 执行器相关报错

### 3. 直接跑 skill 脚本做冒烟

```bash
node /home/netinside/.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js --prompt '什么是玫瑰'
```

这个用例当前的预期不是查数据，而是返回“需要 OpenClaw 先完成理解”的中文决策结果。

如果能正常返回结构化结果，说明至少：

- 脚本能启动
- 依赖能加载
- 当前 skill 目录没有明显缺文件

### 4. 必要时检查服务配置

```bash
systemctl --user cat openclaw-gateway.service
```

重点确认：

- `NAPM_SKILL_EXECUTOR=/home/netinside/.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js`

---

## 8. 什么时候不能直接全量覆盖

以下情况不要直接把 `/opt/NAPM_Semantic_Gateway/skills/openclaw-napm-query` 全量覆盖到远端运行目录：

1. 本地没有远端的 `package.json/node_modules`
2. 本地缺失远端还在运行时使用的 `Overview*.js` 或 `metadata-clarification.js`
3. 本地存在较多备份文件，可能把线上目录搞脏
4. 只同步了入口脚本，但漏掉了新增的 `services/*.js`
5. 本地和远端都各自演化过，尚未重新做一次完整收敛

---

## 9. 最小发布清单

每次发布至少确认下面四件事：

1. 我改的是不是 `skills/openclaw-napm-query/` 这条真实运行链
2. 我传的目标是不是 `/home/netinside/.openclaw/skills/openclaw-napm-query`
3. 我重启的是不是 `openclaw-gateway.service`
4. 我有没有做一次 `status + journal + 脚本冒烟`

---

## 10. 推荐回滚思路

如果发布后发现问题，优先按下面方式回滚：

### 10.1 文件级回滚

如果只改了少量文件，优先把发布前备份文件传回去，然后重启服务。

建议发布前先自行保留一份本次同步文件列表和本地备份。

### 10.2 目录级回滚

如果是较大范围同步，建议发布前先在远端做一个时间戳备份，例如：

```bash
cp -r /home/netinside/.openclaw/skills/openclaw-napm-query /home/netinside/.openclaw/skills/openclaw-napm-query.bak_$(date +%Y%m%d_%H%M%S)
```

出问题后可恢复备份目录，再执行：

```bash
systemctl --user restart openclaw-gateway.service
```

---

## 11. 当前标准口径

以后如果再有人问“为什么改了 `/opt/NAPM_Semantic_Gateway` 但线上没生效”，标准回答应是：

> 因为当前真实运行的是 `OpenClaw` 的 skill 执行目录 `/home/netinside/.openclaw/skills/openclaw-napm-query`，不是旧的 `/opt/NAPM_Semantic_Gateway` 独立服务目录。改完源码后还需要同步到真实 skill 目录，并重启 `openclaw-gateway.service`。

---

## 12. 推荐后续优化

当前最值得补的不是继续手工记命令，而是做自动化发布脚本。

建议后续补一个：

- Windows 本地发布脚本：`deploy-openclaw-skill.ps1`

目标能力：

- 自动同步 `skills/openclaw-napm-query/`
- 自动排除 `node_modules/package*.json/.backup*`
- 自动重启 `openclaw-gateway.service`
- 自动做 `status + journal + smoke test`

在自动化脚本落地前，当前文档就是默认发布操作手册。
