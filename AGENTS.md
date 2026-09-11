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
- `conversationKey` 只表示会话 scope。`message_received` 为每个 run/message 创建并绑定不可变 `turnId`；Tool 和输出 Hook 必须使用当前 run/message 的可信绑定，禁止读取会话中的最新 `turnId`。直接 Tool execute 必须携带插件签发的可信 `traceId`，并解析出 scope、turn 和与当前适配器一致的可信 `toolName`；Query Turn route 还必须是 `NAPM_QUERY`。Hook 必须把最终规范化后的 Query 参数摘要与本轮 Turn Admission Decision 一起密封到可信上下文；execute 收到缺少准入授权或参数被替换的 trace 时 fail-closed。任一条件不满足都必须在 pending Draft 恢复、时间物化、校验和 Query Skill 之前停止。
- `message_received` 还必须生成一份绑定当前 run/message 的不可变 Turn Admission Decision，包括平台身份/能力等 `MODEL_OWNED` 轮次，不得以快路径跳过。`DomainIntentClassificationAdapter` 是公共门禁唯一的 prompt-facing 领域分类入口：它只适配和投影既有分类器/判断器，不新增同义正则，并输出带 schemaVersion/source 的不可变结构；`TurnIntentResolver` 只接受同一进程中由该 Adapter 实际签发且 schema、source、外层和嵌套结构均验证通过的分类，其他对象一律 fail-closed 为不选 Tool。Resolver 不直接解析 prompt，也不接受临时拼装的 signals。通用选择解析器当前只解析“第 N 个/详情/前 N 条/更换时间”，Query、Alert 等领域解析器只暴露自己的权威结果。公共门禁消费 Decision 中的 route 和 `expectedTool`，不从模型文字复制对象名或内部 ID。
- Query 排行、Query 时间追问和 Alert 序号详情已接入统一准入。准入可以在 `message_received` 时读取 scope 下当时最新的权威候选，但必须立即把 `sourceArtifactId/sourceTurnId` 冻结到本轮 Decision 和 Query Turn；后续同会话产生新结果也不能改变追问来源。时间追问必须按冻结的来源 turn 读取查询上下文。当最近权威结果来自尚未接入序号下钻的 Skill 时，必须正式澄清，不得回退使用更早的 Query 排行。
- Query Turn 的 route 在创建后不可变。普通 `NAPM_QUERY` 只允许 `napm-skill-query` 满足查询契约，错误的其他 NAPM Tool 不得把轮次改成 `OTHER_SKILL`。
- 普通查询的 Query Draft、Query Attempt、一次修复预算、pending clarification、终态 `finalContent` 和交付声明统一归 `QueryTurnCoordinator` 管理。旧 `ConversationOperationState` 不再是普通查询修复、查询结果或最终交付的权威源。
- 首次技术校验失败进入 `REPAIR_PENDING`，同一 attempt 重放保持幂等；只允许一次结构修复，第二个失败终止。`recordResult` 和 `recordFailure` 只允许从 `EXECUTING` 迁移；放弃修复和执行期 Skill 澄清分别使用专用迁移。执行失败立即终止，所有 `TERMINAL` 记录 write-once，流式 partial 不得终结 Query Turn；`EXECUTING` 中的重叠 Tool 调用必须在时间物化和校验前返回执行中结果，终态后的 Tool 重放只返回已有权威结果，两者都不得再次调用 Query Skill 或南向接口。
- 澄清后用户只回复对象名时，模型必须用 `clarificationAnswer` 再次调用 `napm-skill-query`；只有 `QueryTurnCoordinator.resumePending()` 成功恢复正式 pending Query 后，插件才把本轮 Turn Admission Decision 重建为 `EXECUTE_TOOL + napm-skill-query`，绑定新的 run/message，补入对象参数并执行。对象名是否命中 NAPM 关键词不能决定准入；没有正式 pending 的同名短句仍为 `MODEL_OWNED` 且零南向调用，不由模型重建完整查询。
- `RESULT`、`NO_DATA`、澄清、拒绝、失败和 `CONTRACT_VIOLATION` 都由 Query Turn 生成权威 `finalContent` 并 exactly-once 交付。普通查询到达非流式最终输出时不得停留在非终态：`RECEIVED` 无 Decision/Attempt 或 `DECIDED` 但适配器未开始执行，终结为契约违规；`REPAIR_PENDING` 终结为校验失败；`EXECUTING` 无结果终结为执行失败。不得由模型猜测数据。
- 直接调用 Tool execute 也必须经过统一高风险语义策略，包括应用趋势/平均值/排行与 `TotalTraffic` 范围错配、`CompositeApplication`/一般对象清单以及普通查询多 group 契约；无 prompt 的 `overview/auto_apps` 也不得绕过清单契约。普通查询包含多个 groups 时默认 `VALIDATION_FAILURE`，只有 `pathPlanning` 与静态 groups tree 验证一致、终端对象与结构化语义一致且获得可信下钻引用授权的显式多级路径可执行。未获 `EXECUTE_QUERY` 不得调用 Query Skill 或南向接口。
- `WorkflowClassifierService` 只组合统一解析结果并产出不可变 `napm-query-semantic.v1`：对象来自 Object Ontology，指标来自 Resolution Spec 的 `metricSemanticRules`，排行操作/方向/数量来自同一 Spec 的 `rankingGrammar`，时间沿用统一时间解析器。契约生命周期只允许 `RESOLVED/AMBIGUOUS/UNRESOLVED/UNSUPPORTED`，并正式携带 `ambiguities[]`、`unresolvedSlots[]`、`reasonCode`；只有 `RESOLVED` 可进入 Query Draft assembly。`primaryMetric` 始终可空，`requestedMetrics[]` 表示返回指标，`rankingMetric` 是排行依据。Resolver 只消费该契约且不得用默认对象补槽；raw prompt 兼容入口也只能先走这条统一语义链。不得在 Resolver、`PromptRoutingService`、插件或 `QueryDecisionPolicy` 中另建指标/排行同义正则。
- 可执行指标查询统一使用 `schemaVersion=napm-resolved-query.v1`。`metrics[]` 是返回指标，`topMetric` 只用于 `topValues` 排序且不要求属于 `metrics[]`；`averageValues/timeValues` 禁止 `topMetric/topCount`，`timeValues` 必须有 `granularity`。`queryModeKey` 只能由 service 派生并校验一致，不能成为第二个操作真源。单数 `metric` 不是 canonical/NAPM API 字段，只能在 legacy 输入边界由 `LegacyMetricInputAdapter` 运行一次后删除；Resolver、新 Semantic 路径、QueryMetadataConstraint 和实际子查询不得生成 `metric`。
- Query 的 Resolution Spec、Object Ontology、Metric Catalog 和 Object × Metric ownership 唯一维护源均位于 `skills/openclaw-napm-query/` 内；根目录不得保留前三类配置副本，根 `src/constants/objectMetricOwnership.js` 只能薄转发。Metric Catalog 加载失败必须 fail closed。ownership 三态 API 需要精确 service、group path 和可信产品基线；Phase 5 只通过 RuntimeMetricCapabilityService 为明确 provider 的 Static UNKNOWN 做当前请求确认。
- Phase 5 对 Static `UNKNOWN` 增加共享 `ResolvedQueryExecutionAdmissionService` 和 `RuntimeMetricCapabilityService`。只有 `type=METRIC_CAPABILITY` 且 `provider=METRICS_FOR_GROUP` 的未知项才可调用一次 `metricsForGroup`；运行时 `SUPPORTED` 才能继续数据执行，`UNSUPPORTED` 或 `INDETERMINATE` 均在 Kernel 前停止。运行时证据只属于当前 Query，不回写静态 ownership，也不形成跨请求缓存。
- Phase 6 的 Query 修复统一由 `AtomicQueryRepairService` 收口：只接受 canonical Query 和 `semanticImpact=NONE` 的确定性格式修复，先生成可审计 plan、在 clone 上原子应用，再重新执行 `ResolvedQueryContract`、Static Validator 和（若仍 UNKNOWN）Runtime Capability。禁止改指标语义、对象、service、排行指标或删除请求指标；旧 prepared proof 和 capability evidence 在查询指纹/能力作用域变化后不得复用。
- Phase 7 的数据执行只能由 `NapmQuerySerializer` 把 admitted canonical Query 显式映射为 NAPM transport params。Serializer 不读取 legacy `metric`、不 repair、不做 admission、不解析语义；`MetricExecutionKernel` 按 `service` dispatch，不能读取 `metric`、用 `metrics[0]` 推导或按 `queryModeKey` 路由。NapmClient 只接收 transport-ready params，内部修复/运行时/语义字段不得外发；`pageViews` 保持独立 detail contract。
- Phase 7.1 已验证 Transport Boundary：`GroupBuilder.buildGroupParams()` 是唯一生产 group flatten 编码器，Serializer 复用它，NapmClient 不解释对象/指标。metrics 逗号编码只有 Serializer 一处；Kernel 的旧 fallback 和无生产调用的 `buildMetricCsv`、`validateExecutableQueryAtBoundary`、`buildUrl` 已删除。语义/展示层仍可读取 metrics[0] 作为提示，但不参与 data transport truth；LegacyMetricInputAdapter 暂保留到后续清理阶段。
- Phase 8 的执行结果统一使用 `ExecutionOutcomeContract` / `ExecutionOutcomeMapper`：`SUCCESS`、`NO_DATA`、`VALIDATION_FAILURE`、`RUNTIME_CAPABILITY_FAILURE`、`SERIALIZATION_FAILURE`、`EXECUTION_FAILURE` 与 Semantic Lifecycle 分层。只有真实 data request 成功、响应解析成功且 rowCount=0 才能是 `NO_DATA`；校验、能力、序列化或南向失败不得伪装为空数据。Gateway/Direct/Plugin/Narration 消费同一结构化 outcome，错误 reasonCode 保留在统一 stage 下。
- 页面访问实例详情使用 `service=pageViews`、`queryModeKey=detail`，输入为分钟对齐的 `start/end`、可信 `pageFamilyId` 和正整数 `maxLimit`（本地缺省 20、保护上限 200；该上限不是已确认的上游限制）。`PageFamilyDetail` 不是 group，metrics、groups、topMetric 和 granularity 不得出现在详情请求中。
- “哪些业务页面访问量最高”先执行 `topValues + WebApplication + PGNPGE`，不得因“页面访问量”自动扩展到 `PageFamily`。只有“排名第 N 的业务访问了什么”等明确追问，才可用权威 `WebApplication` 结果引用补入业务名并执行 `WebApplication > PageFamilies > PageFamily`。
- Query Turn 对 `WebApplication` 和 `PageFamily` TopN 都保存最小权威结果投影。当前仅支持 `rank_top/desc`：TopN 行按 `topMetric` 数值降序归一化、重排 rank，空白或缺失值保持在末尾，再保存序号引用和生成叙述。完整且唯一理解的 `rank_bottom/asc` 为 `UNSUPPORTED/RANK_BOTTOM_UNSUPPORTED`；缺排行指标的 BottomN 仍为 `UNRESOLVED`。两者都不得生成 Query Draft，也不得靠本地反转 TopN 伪造 BottomN。
- “排名第 N 的业务”与“详细查看排名第 N 个页面”等追问必须通过当前 Query Turn 冻结的对应对象结果投影解析 `resultReference`；结果集按 conversation scope 隔离并单独保留 30 分钟。缺失、过期、跨 scope、对象类型错误或序号越界均在时间物化和 Skill 调用前失败，Query Skill、`NapmClient` 和南向调用次数必须为 0。
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

## Phase 4 执行门禁

- ResolvedQueryExecutableValidator 统一处理 Metric Catalog 存在性和 Object × Metric 三态 ownership。
- KNOWN_INCOMPATIBLE、METRIC_UNKNOWN 立即失败；Phase 4 静态阶段的 UNKNOWN 返回 RUNTIME_CAPABILITY_REQUIRED，Phase 5 仅对带 METRICS_FOR_GROUP provider 的 UNKNOWN 进入 RuntimeMetricCapabilityService；其他 UNKNOWN 仍不进入 metadata、Query Skill、Kernel 或南向接口。
- Gateway、Direct、Plugin 必须共用该门禁；Plugin 只消费确定性结果。

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
