# PROJECT.md - 观枢 GAIOP / NAPM 项目上下文

## 项目目标

观枢AI为观枢 GAIOP / NAPM 提供企业微信入口，把用户的自然语言运维问题转成可执行的 NAPM 查询，并把结构化结果整理成清晰、可信、可操作的中文回答，支持 Word/PDF 报告导出。

## 生产链路

1. 用户在企业微信提出 NAPM / 网络运维问题。
2. OpenClaw Gateway 接收消息；`message_received` 先为入站 `messageId` 创建不可变 `turnId`，Agent Hook 到达后再把其 `runId` 绑定到同 scope、source prompt 匹配的同一 `RECEIVED` 轮次。`conversationKey` 只表示 scope，不表示当前或最新轮次；直接 Tool execute 还必须携带插件签发的可信 `traceId`。缺少生命周期身份或绑定时在时间物化、校验和 Skill 调用之前 fail-closed。
3. `WorkflowClassifierService` 结合 Object Ontology 和 Metric Semantic Normalizer 统一产出操作、对象和指标语义；上游据此构造包含时间范围与可选下钻路径的 Query Draft，澄清续答则只传 `clarificationAnswer`。
4. `napm-skill-query` 的 Query Decision Policy 在 Hook 和直接 Tool execute 两条入口统一检查参数策略与高风险语义，包括应用/`TotalTraffic` 范围、`CompositeApplication`/一般对象清单和普通查询多 group 契约。普通查询多 group 默认失败，只有与静态 groups tree 验证一致的显式 `pathPlanning` 可执行。
5. Query Turn Coordinator 保存 Draft、Attempts、一次修复预算、pending clarification、终态 `finalContent` 和交付声明。只有 `EXECUTE_QUERY` 才把完整 Resolved Query 交给 Query Skill 和南向接口。
6. Tool 和具有 run/message 身份的输出 Hook 按可信绑定读取同一 Query Turn；`before_message_write` 的 OpenClaw 契约不提供该身份，因此不在身份缺失时终结或改写 Query Turn。route 创建后不可变，普通 `NAPM_QUERY` 的错误 Tool 会被阻断且不能改成 `OTHER_SKILL`。已进入 `EXECUTING` 的重叠 Tool 调用在处理重放 Draft 前返回执行中结果，不会产生第二次南向调用。普通查询的所有终态由 Coordinator exactly-once 交付，其他 Skill 继续使用各自工作流。
7. 观枢AI基于当前轮权威结果回复用户或输出报告文件；流式 partial 仅是进度，不终结 Query Turn。

普通用户查询不要绕过这条链路直接用 shell、curl 或 NetInside WebService 调用底层 API。

## 当前核心组件

### 平台
- OpenClaw Gateway：企业微信消息入口和插件运行时（端口 18789）
- 企业微信通道：`channels.wecom`
- NAPM 插件：`napm-openclaw-plugin`（`napm-openclaw-plugin.remote.js`）

### Skills（9 个）

| Skill | 目录 | 能力 |
|---|---|---|
| openclaw-napm-query | `skills/openclaw-napm-query/` | 自然语言→结构化 NAPM 查询（指标、排行、趋势、下钻） |
| openclaw-napm-report | `skills/openclaw-napm-report/` | 巡检报告/故障诊断报告/综述报告 Word+PDF 生成 |
| openclaw-napm-packet-analysis | `skills/openclaw-napm-packet-analysis/` | 数据包下载、预览、业务页面分析 |
| openclaw-napm-alert-query | `skills/openclaw-napm-alert-query/` | 告警查询、摘要、时间线、通知字段说明 |
| openclaw-napm-inspection | `skills/openclaw-napm-inspection/` | 巡检快照（流量健康、业务性能） |
| openclaw-napm-summary | `skills/openclaw-napm-summary/` | 综述报告（全局/网络/Web/应用/业务组/告警 6 种 scope） |
| openclaw-napm-syslog-watcher | `skills/openclaw-napm-syslog-watcher/` | Syslog/SNMP 告警接收、富化、企业微信推送 |
| openclaw-napm-fault-diagnosis | `skills/openclaw-napm-fault-diagnosis/` | 故障诊断分析（B/S业务慢/页面性能/C/S应用慢/网络慢 4种流程），自动检测 flowType |
| echarts-chart-skill | `skills/echarts-chart-skill/` | ECharts 图表渲染（PNG 输出），供报告 skill 调用 |

### OpenClaw 工具契约（7 个生产工具 + 2 个可选诊断工具，定义在 openclaw.plugin.json）

- `napm-skill-query` — NAPM 自然语言查询
- `napm-report-export` — 报告生成与导出
- `napm-packet-analysis` — 数据包分析
- `napm-alert-query` — 告警查询
- `napm-inspection-snapshot` — 巡检快照
- `napm-summary` — 综述报告
- `napm-fault-diagnosis` — 故障诊断分析

开发诊断工具仅在 `NAPM_ENABLE_DEV_RESOLVER_TOOLS=true` 时注册，生产环境默认关闭：

- `napm-resolve-query` — 只构造并检查 `resolvedQuery`
- `napm-mainflow-query` — 本地解析自然语言并执行完整查询链

`napm-skill-query` Tool adapter 接受 `queryDraft`，并在迁移期兼容同形的 `resolvedQuery`；澄清续答接受 `clarificationAnswer`。直接执行要求可信 trace 同时绑定当前 scope、turn 和准确的 `napm-skill-query` toolName，既有 Query Turn route 必须为 `NAPM_QUERY`；任一不匹配都在 pending 恢复和时间物化前阻断。缺少必须由用户提供的对象名时返回正常澄清，不调用 Query Skill 或南向接口，并在 conversation scope 保存 Query Decision Policy 规范化后的 pending Query Draft；应用问题误构为 `TotalTraffic` 时会先改为 `DefinedApp`。下一轮用户只回复 `HTTP` 等对象名时，插件创建新 Query Turn、恢复 pending Draft、补入 `DefinedApp.argument` 后重新执行完整策略。

普通查询的状态权威是 `QueryTurnCoordinator`：route 在 begin 后不可变；首次技术校验失败进入 `REPAIR_PENDING`，同一 attempt 重放幂等，只有一次结构修复预算，第二个失败终止；`recordResult`/`recordFailure` 只接受 `EXECUTING`，放弃修复和执行期 Skill 澄清使用专用迁移。Skill 的旧形状正常澄清会规范化为 `ok=true` 的 `clarification_required` 并以成功 attempt 进入 `CLARIFICATION`，不会成为执行失败。执行失败立即终止；所有 `TERMINAL` 记录 write-once。`RESULT`、`NO_DATA`、澄清、拒绝、失败和 `CONTRACT_VIOLATION` 都生成权威 `finalContent` 并只交付一次。非流式最终输出到达时，`RECEIVED` 无 Decision/Attempt 或 `DECIDED` 但适配器未开始执行会终结为契约违规，`REPAIR_PENDING` 会终结为校验失败，`EXECUTING` 无结果会终结为执行失败；迟到结果不能覆盖终态。`EXECUTING` 重放在时间物化和校验前返回执行中结果，终态后的 Tool 重放返回已有权威结果，两者都不再执行 Query Skill 或南向请求。旧 `ConversationOperationState` 仍服务尚未迁移的其他工作流和历史上下文，但不再决定普通查询的修复、结果或最终交付。

应用流量高风险策略消费统一的结构化操作、目标对象和指标语义，不在 Prompt Routing、插件或 Query Decision 中复制文本规则。趋势/平均值错映射到 `TotalTraffic` 时先澄清并规范化为 `DefinedApp` pending Draft；排行错映射到 `TotalTraffic` 时直接技术阻断，不允许查询全局口径；无 prompt 的 `overview/auto_apps` 视为不合规的 `CompositeApplication` 清单形状。

Query Skill CLI 本身仍只执行完整 Resolved Query，且不保存 Query Turn 或 pending clarification。

## 报告类型

| 类型 | 模板 | 固定模板服务 |
|---|---|---|
| 巡检报告 (inspection) | `templates/inspection/napm_traffic_health_inspection_v1.json` | InspectionFixedTemplateService |
| 故障诊断报告 (diagnostic) | `templates/diagnostic/napm_bs_fault_diagnosis_v2.json` / `napm_bs_page_perf_v1.json` / `napm_cs_fault_diagnosis_v1.json` | DiagnosticFixedTemplateService |
| 综述报告 (summary) | `templates/summary/napm_summary_overview_v1.json` | SummaryFixedTemplateService |

## 领域对象

常见顶层或重要分析对象：

- TotalTraffic：总流量
- IPAddress：IP 地址
- Prefix24：子网 /24
- BusinessGroup：业务组
- BusinessGroupLink：业务组链接
- DefinedApp：已定义应用（applications API Type=2）
- WebApplication：Web 应用 / 业务系统（applications API Type=3）
- CompositeApplication：自动识别复合应用（applications API Type=4）
- BuiltinApplication：内置应用（applications API Type=1）
- Interface：接口
- PageFamily：页面族
- User：用户
- IPConversation：IP 会话
- MonInterfaceGroup：监控接口组
- ClientBusinessGroup：初始组

## 关键配置文件

- `config/napm-resolution-spec.v1.json` — 查询服务/模式/必填字段契约
- `config/inspection-report-rules.v1.json` — 巡检报告规则
- `config/inspection-report-field-map.v1.json` — 巡检字段映射
- `config/object-ontology.v1.json` — 对象本体定义
- `openclaw.plugin.json` — 插件配置与工具契约

## 回答规则

- 先结论后依据。
- 说明时间范围、对象范围、指标和排序方向。
- 对"有哪些""列表""目录"类问题，优先给分类和代表项，再给下一步查询建议。
- 对"为什么慢/异常/失败"类问题，先列可能原因，再建议下钻路径。
- 对"详细点/继续/下钻"类追问，沿用上一轮对象、指标和时间范围，除非用户明确改变条件。
- 查询不到数据时，优先提示检查时间范围、对象类型、指标映射和数据延迟。
- 报告类请求（综述/日报/周报/巡检/故障诊断）走对应的报告生成链路，不走纯文本回答。
- 命名单对象综述和故障报告必须通过 NAPM 动态对象目录确认 `groupType/groupArgument`；对象不存在、同名歧义或目录不可用时禁止降级为整体/全局报告。
- 故障诊断类请求（报错分析/故障分析/页面慢/应用慢/网络慢）走 `napm-fault-diagnosis`，不要拆成多次 query 调用。

## 维护规则

- `SOUL.md`：固定人设和行为边界。
- `IDENTITY.md`：对外身份卡。
- `PROJECT.md`：项目事实、领域语义和生产链路（本文件）。
- `TOOLS.md`：本机环境、工具路径、维护命令和操作边界。
- `AGENTS.md`：工作清单和协作规则。
- `HEARTBEAT.md`：心跳任务配置。
- `USER.md`：使用者偏好。
- `memory/`：重要历史经验和项目决策。
- `docs/`：设计文档和落地说明。

文档中不保存密钥、token、密码、完整认证头或未脱敏配置。
