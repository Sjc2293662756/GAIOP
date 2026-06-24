# Workspace .md 文件全面更新记录

**日期**: 2026-06-23  
**背景**: 远端 `/home/netinside/.openclaw/workspace/` 下的 7 个工作区定义文件（TOOLS.md / USER.md / AGENTS.md / HEARTBEAT.md / IDENTITY.md / PROJECT.md / SOUL.md）自 2026-05-27 后未维护，已过时一个月，与当前实际项目状态严重脱节。

## 远端旧状态（5月27日版本）

- 只认识 `napm-skill-query` 一个工具
- 只认识 `openclaw-napm-query` 一个 skill
- 路径全部指向旧结构：`~/.openclaw/skills/`、`~/.openclaw/extensions/`
- 服务管理引用不存在的 systemd 配置
- 无报告/巡检/综述/告警/数据包/Syslog 场景覆盖
- 无告警类型、报告类型、综述 scope 等专业语言

## 推送文件清单

共推送 13 个文件（6 个重写 + 1 个未改 + 6 个 skills/.md）：

| 文件 | 操作 | 说明 |
|---|---|---|
| `PROJECT.md` | 重写 | 新增全部 8 个 skill 列表、6 个工具契约、3 种报告类型、应用目录映射、配置文件列表 |
| `TOOLS.md` | 重写 | 新增工具边界表、6 个执行器路径、修正工作区路径、移除错误 systemd 命令 |
| `SOUL.md` | 重写 | 新增报告生成原则、告警/Syslog/巡检/综述场景、报告类型措辞 |
| `AGENTS.md` | 重写 | 新增 6 工具清单表、文档职责补充 USER.md/HEARTBEAT.md/docs/ |
| `IDENTITY.md` | 更新 | 补充告警类型、报告类型、指标代码、新场景覆盖 |
| `USER.md` | 更新 | 补充"报告优先 Word 格式"偏好 |
| `HEARTBEAT.md` | 未改 | 内容无需更新 |
| `skills/openclaw-napm-inspection/SKILL.md` | 同步 | git modified |
| `skills/openclaw-napm-query/SKILL.md` | 同步 | git modified |
| `skills/openclaw-napm-query/references/metric-dimension-ownership.md` | 同步 | git modified |
| `skills/openclaw-napm-query/references/query-workflow-contract.md` | 同步 | git modified |
| `skills/openclaw-napm-query/references/source-index.md` | 同步 | git modified |
| `skills/openclaw-napm-query/references/chinese-semantic-metric-mapping.md` | 新增 | 远端缺失，中文语义→指标映射表 |

## 关键修正

### 路径修正
- ❌ 旧: `/home/netinside/.openclaw/skills/` → ✅ 新: `/home/netinside/.openclaw/workspace/skills/`
- ❌ 旧: `/home/netinside/.openclaw/extensions/napm-openclaw-plugin` → ✅ 新: 插件即 workspace 下的 `napm-openclaw-plugin.remote.js`

### 工具契约修正（3→6）
- ❌ 旧: 只记录 `napm-skill-query` → ✅ 新: 6 个工具完整列表

### Skill 列表修正（1→8）
- ❌ 旧: 只记录 `openclaw-napm-query` → ✅ 新: 8 个 skill 完整列表含职责说明

### 服务管理修正
- ❌ 旧: 引导使用 `systemctl --user` → ✅ 新: 说明当前 PM2/直接 node 进程方式

### 场景覆盖补充
- 新增：告警查询、告警类型（7种）、巡检报告、综述报告（6种scope）、故障诊断报告、数据包分析、Syslog 推送
- 新增：报告生成原则（必须走 `napm-report-export`，不自行拼文本）
- 新增：指标代码规范化（TPIO/BYTIO/CCNI/RTTI 等）

## 推送验证

所有文件推送后通过 `plink` 确认远端时间戳为 2026-06-23 16:54~16:58，部署生效。
