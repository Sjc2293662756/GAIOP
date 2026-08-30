# PROJECT.md - 观枢 GAIOP / NAPM 项目上下文

## 项目目标

观枢AI为观枢 GAIOP / NAPM 提供企业微信入口，把用户的自然语言运维问题转成可执行的 NAPM 查询，并把结构化结果整理成清晰、可信、可操作的中文回答，支持 Word/PDF 报告导出。

## 生产链路

1. 用户在企业微信提出 NAPM / 网络运维问题。
2. OpenClaw Gateway 接收消息并维护会话上下文。
3. 上游语义层识别意图、对象、指标、时间范围和下钻路径，构造结构化 Query Draft。
4. `napm-skill-query` 的 Query Decision Policy 决定追问、执行或拒绝；只有完整 Resolved Query 才进入 Query Skill 和南向接口。
5. Query Turn Coordinator 记录本轮终态，输出 Hook 从同一终态完成一次最终交付。
6. 观枢AI基于结果、摘要和叙述结构回复用户或输出报告文件。

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

`napm-skill-query` Tool adapter 接受 `queryDraft`，并在迁移期兼容同形的 `resolvedQuery`。缺少必须由用户提供的对象名时返回正常澄清，不调用 Query Skill 或南向接口。Query Skill CLI 本身仍只执行完整 Resolved Query，且不保存会话状态。

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
