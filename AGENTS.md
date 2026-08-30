# AGENTS.md - 观枢AI NAPM Workspace

这个 workspace 只服务观枢 GAIOP / NAPM 智能运维助手，不承载通用个人助理、闲聊机器人或社交自动化人设。

## 每次接手先读

1. `SOUL.md`：固定人设和行为边界
2. `IDENTITY.md`：对外身份卡
3. `PROJECT.md`：项目上下文、领域语义、技能列表和生产链路
4. `TOOLS.md`：本机路径、工具边界和维护命令
5. `memory/YYYY-MM-DD.md`：当天和近期重要维护记录，按需读取

## 工作原则

- 普通 NAPM 用户查询必须调用 `napm-skill-query`。上游传入结构化 `queryDraft`；只有 Query Decision 为 `EXECUTE_QUERY` 时才能形成完整 `resolvedQuery` 并进入 Query Skill 和南向接口。
- `conversationKey` 只表示会话 scope。`message_received` 为每个 run/message 创建并绑定不可变 `turnId`；Tool 和输出 Hook 必须使用当前 run/message 的可信绑定，禁止读取会话中的最新 `turnId`。缺少 run/message 身份或绑定时必须 fail-closed。
- Query Turn 的 route 在创建后不可变。普通 `NAPM_QUERY` 只允许 `napm-skill-query` 满足查询契约，错误的其他 NAPM Tool 不得把轮次改成 `OTHER_SKILL`。
- 普通查询的 Query Draft、Query Attempt、一次修复预算、pending clarification、终态 `finalContent` 和交付声明统一归 `QueryTurnCoordinator` 管理。旧 `ConversationOperationState` 不再是普通查询修复、查询结果或最终交付的权威源。
- 首次技术校验失败进入 `REPAIR_PENDING`，同一 attempt 重放保持幂等；只允许一次结构修复，第二个失败终止。执行失败立即终止，所有 `TERMINAL` 记录 write-once，流式 partial 不得终结 Query Turn；终态后的 Tool 重放只返回已有权威结果，不得再次调用 Query Skill 或南向接口。
- 澄清后用户只回复对象名时，模型必须用 `clarificationAnswer` 再次调用 `napm-skill-query`；插件恢复 Query Decision Policy 规范化后的 pending Query Draft 并补入对象参数，不由模型重建完整查询。
- `RESULT`、`NO_DATA`、澄清、拒绝、失败和 `CONTRACT_VIOLATION` 都由 Query Turn 生成权威 `finalContent` 并 exactly-once 交付。普通查询轮次最终未调用 Tool 时必须记录契约违规，不得由模型猜测数据。
- 直接调用 Tool execute 也必须经过统一高风险语义策略，包括应用与 `TotalTraffic` 范围、`CompositeApplication`/一般对象清单以及对象清单的单 group 约束；未获 `EXECUTE_QUERY` 不得调用南向接口。
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
