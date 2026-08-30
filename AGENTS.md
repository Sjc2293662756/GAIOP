# AGENTS.md - 观枢AI NAPM Workspace

这个 workspace 只服务观枢 GAIOP / NAPM 智能运维助手，不承载通用个人助理、闲聊机器人或社交自动化人设。

## 每次接手先读

1. `SOUL.md`：固定人设和行为边界
2. `IDENTITY.md`：对外身份卡
3. `PROJECT.md`：项目上下文、领域语义、技能列表和生产链路
4. `TOOLS.md`：本机路径、工具边界和维护命令
5. `memory/YYYY-MM-DD.md`：当天和近期重要维护记录，按需读取

## 工作原则

- 普通 NAPM 用户查询走 `napm-skill-query` 和结构化 `resolvedQuery`。
- 报告类请求走 `napm-report-export`（巡检/故障诊断/综述/Word/PDF）。
- 告警查询走 `napm-alert-query`（摘要/时间线/详情/通知字段）。
- 数据包分析走 `napm-packet-analysis`（下载/预览/业务页面）。
- 巡检快照走 `napm-inspection-snapshot`。
- 故障诊断/分析类请求走 `napm-fault-diagnosis`（BS业务慢/BS页面性能/CS应用慢/网络慢），不要拆成多次 query 调用。
- 综述报告走 `napm-summary`（全局/网络/Web/应用/业务组/告警 scope）。
- Syslog/SNMP 告警推送走 `napm-syslog-watcher`。
- 不用 shell、curl 或直接 NetInside WebService 代替生产查询链路。
- 不编造数据、对象、指标、时间范围或配置状态。
- 对外回答默认中文、简洁、运维导向。
- 不主动泄露内部路径、服务参数、公网地址、密钥、token、secret。
- 做维护操作前确认任务确实需要；修改文件前先备份或归档。

## 当前工具清单（7 个生产 Tool，另有 2 个可选诊断 Tool Contract；底层 9 个 Skill）

| 工具 | 用途 | 对应 Skill |
|---|---|---|
| `napm-skill-query` | NAPM 自然语言→结构化查询 | openclaw-napm-query |
| `napm-report-export` | 报告生成（Word/PDF） | openclaw-napm-report |
| `napm-packet-analysis` | 数据包下载与分析 | openclaw-napm-packet-analysis |
| `napm-alert-query` | 告警查询与摘要 | openclaw-napm-alert-query |
| `napm-inspection-snapshot` | 巡检快照 | openclaw-napm-inspection |
| `napm-summary` | 综述报告 | openclaw-napm-summary |
| `napm-fault-diagnosis` | 故障诊断分析（4种流程） | openclaw-napm-fault-diagnosis |
| —（守护进程） | Syslog 告警推送 | openclaw-napm-syslog-watcher |
| —（内部调用） | 图表渲染 | echarts-chart-skill |

`napm-resolve-query` 和 `napm-mainflow-query` 仅供开发诊断，只有在 `NAPM_ENABLE_DEV_RESOLVER_TOOLS=true` 时注册；生产环境默认关闭。

## 文档职责

- `SOUL.md`：我是谁、如何回答、边界在哪里。
- `IDENTITY.md`：身份卡，可被快速读取。
- `PROJECT.md`：项目事实、技能列表和 NAPM 领域规则。
- `TOOLS.md`：本部署环境的工具路径和操作提示。
- `USER.md`：使用者偏好。
- `HEARTBEAT.md`：心跳任务配置。
- `运行环境文档.md`：当前部署快照。
- `memory/`：历史上下文和重要经验。
- `docs/`：设计文档和落地说明。

## 维护习惯

- 发现文档与真实环境不一致时，优先修正文档。
- 清理临时脚本时移入 `/home/netinside/.openclaw/archive/`，不要直接删除。
- 文档中不得保存密钥、密码、token 或未脱敏认证信息。
- 重大变更追加到当天 `memory/YYYY-MM-DD.md` 和 `docs/` 目录。

## 多会话开发与统一部署强制要求

完整流程见 `docs/NAPM多会话开发与统一部署要求.md`。以下规则对所有任务强制生效：

- 唯一开发和发布仓库是 `NAPM_skill_unified`；`skill_project/NAPM_skill`、`project_3/NAPM_skill` 仅作历史备份，禁止从旧目录开发或部署。
- 一个修改任务对应一个独立 `codex/<topic>` 分支和 worktree。修改任务只负责代码、测试和提交，禁止修改发布版本号、创建标签、构建发布包、上传服务器、重启服务或合并 `main`。
- 多个修改分支只能由一个明确指定的“整合部署任务”统一盘点和合并。整合任务必须从当前 `main` 新建 `codex/integrate-rc<N>`，只合并用户确认纳入本次发布的分支。
- 版本号只允许在整合分支统一升级；已使用或已打标签的 RC 号永不复用。发布包必须由干净提交执行 `npm run release:build` 生成，一次部署只使用一个完整 ZIP，禁止逐文件上传。
- 同一时间只允许一个任务操作测试服务器部署。其他任务即使完成修改，也不得构建、上传、安装或重启服务，避免后一次部署覆盖前一次部署。
- 正式候选至少通过全量测试、lint、runtime contract、远端 staged 验证和 `install-release.sh --dry-run`。任一步失败即停止，不得跳过或手工覆盖。
- 用户说“准备/制作 rc<N>”只授权整合、测试、打包、上传、staged 和 dry-run，不授权切换服务。只有用户明确说“批准正式切换 rc<N>”或同等明确指令，才允许运行正式安装和重启。
- 正式安装前必须核对发布包 SHA-256、manifest 版本与完整 commit、远端当前活动版本，并确认可用回滚备份。安装后必须核对 Gateway、watcher、端口、双 manifest 和运行时契约。
- 部署验收完成后才固定版本标签并把整合结果合入 `main`。GitHub 推送与服务器部署是两项独立操作，未经明确授权不得推送远端 Git 仓库。
- 任何任务结束时都应报告：分支名、完整/短提交号、改动范围、测试结果、是否改版本、是否打包、是否连接服务器、是否部署，以及遗留风险。
