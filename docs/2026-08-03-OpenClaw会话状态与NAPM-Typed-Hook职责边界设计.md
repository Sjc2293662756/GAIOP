# OpenClaw 会话状态与 NAPM Typed Hook 职责边界设计

> 日期：2026-08-03  
> 状态：设计建议，尚未实施  
> 范围：NAPM OpenClaw Plugin、7 个生产 Tool、底层 NAPM Skill、报告交付与企业微信最终回包  
> 目的：明确 Tool、Typed Hook、OpenClaw 会话与 NAPM Skill 的职责，指导后续减少插件全局状态并修复生命周期契约

## 1. 背景

本项目当前同时存在以下机制：

1. OpenClaw 原生会话、Agent Run 和 Tool 调度。
2. NAPM 插件注册的 7 个生产 Tool。
3. NAPM 插件自行维护的多组进程内 `Map`。
4. 插件尝试注册的消息、Tool 和发送生命周期 Hook。
5. 底层 Query、Alert、Summary、Fault Diagnosis、Report 等 Skill。

此前为了处理企业微信最终回复错误、跨轮报告导出、失败结果保护和附件重复发送，插件逐步增加了会话缓存与 Hook 保护。但这些机制开始与 OpenClaw 原生职责重叠，并带来以下问题：

- Tool 正常调用与 Hook 生命周期保护被混为一谈。
- OpenClaw 原生会话隔离与插件自建缓存隔离被混为一谈。
- Skill、Plugin 和消息发送层的状态职责不清晰。
- 插件使用了错误的 Hook 注册入口，但基础 Tool 调用仍可能正常，导致问题难以识别。

本文给出可验证的现状结论和推荐的目标边界。

## 2. 核心结论

### 2.1 Tool 调用不依赖 Typed Hook

NAPM 的基础查询链路是：

```text
模型选择 NAPM Tool
  -> OpenClaw 调用 Tool.execute()
  -> Tool 调用对应 Skill
  -> Skill 查询 NAPM
  -> Tool 返回结构化结果或文本
```

这条链路依赖 `api.registerTool(...)`，不依赖 Typed Hook。

因此，以下现象可以同时成立：

- NAPM Tool 已成功注册。
- 单轮正常查询能够成功。
- 底层 NAPM API 能够返回数据。
- Typed Hook 注册仍然是错误的。

Typed Hook 注册错误不能直接表述为“整个 NAPM 工具链不可用”。更准确的表述是：

> 基础 Tool 执行面可以工作，但依赖生命周期 Hook 的路由、调用前保护、跨轮结果关联和最终消息交付保护没有进入正确的 Typed Hook 调度链。

### 2.2 OpenClaw 已负责基础会话隔离

OpenClaw 原生负责：

- `sessionKey`、`sessionId` 和 `runId`。
- 不同会话的消息上下文。
- 每次 Agent Run 的 Tool 调用与返回。
- 不同会话和不同 Run 的并发调度。

在插件不引入额外共享状态的情况下，正常模型是：

```text
会话 A -> Run A -> Tool A -> 结果 A
会话 B -> Run B -> Tool B -> 结果 B
```

Typed Hook 不是 OpenClaw 建立会话隔离的前提。NAPM Skill 也不需要重新实现会话隔离。

### 2.3 风险来自插件额外维护的共享状态

当前插件维护了以下进程级状态：

```javascript
const napmGuardState = new Map();
const napmConversationState = new Map();
const napmSentMediaByConversation = new Map();
const napmOperationState = new ConversationOperationState();
const napmTrustedToolContextByTraceId = new Map();
```

这些状态不属于 OpenClaw 原生会话，而是 NAPM 插件自己增加的状态。它们主要服务于：

- 记录当前或上一轮用户问题。
- 保存最近一次 NAPM Tool 结果。
- 支持“把以上导出 Word”。
- 保存告警或普通查询的最终回答依据。
- 附件发送去重。
- Tool 调用与企业微信会话关联。

一旦插件使用比 OpenClaw 更粗的键保存这些状态，就可能弱化 OpenClaw 已有的隔离。

当前插件的会话键为：

```javascript
channelId + accountId + conversationId
```

该键没有包含：

```text
userId
sessionKey
sessionId
runId
```

因此需要重点关注的不是“两个完全不同的 OpenClaw 会话是否会天然串数据”，而是：

1. 同一个企业微信群中的多个用户是否共享插件的“最近一次结果”。
2. 同一个 conversation 内两个重叠 Run 是否覆盖插件状态。
3. “把以上导出 Word”是否错误选用了同一 conversation 中另一个 Run 的最新结果。

## 3. 远端已核验事实

本节仅记录只读核验得到的事实，不包含风险推断。

### 3.1 运行版本与插件状态

- 测试服务器实际运行 OpenClaw `2026.5.4`。
- Gateway 实际进程从 OpenClaw 全局安装目录的 `dist/index.js` 启动。
- 当前 NAPM extension 插件哈希与本地当前插件一致。
- OpenClaw 将 NAPM 插件识别为 `loaded`。
- 7 个生产 Tool 已被运行时识别：
  - `napm-skill-query`
  - `napm-report-export`
  - `napm-alert-query`
  - `napm-inspection-snapshot`
  - `napm-summary`
  - `napm-fault-diagnosis`
  - `napm-packet-analysis`

### 3.2 OpenClaw SDK 明确区分两类 Hook

远端 OpenClaw SDK 的 `OpenClawPluginApi` 定义包含：

```typescript
registerHook(
  events: string | string[],
  handler: InternalHookHandler,
  opts?: OpenClawPluginHookOptions
): void;

on<K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: { priority?: number; timeoutMs?: number }
): void;
```

远端运行实现显示：

```text
api.on(...)
  -> registerTypedHook(...)
  -> registry.typedHooks.push(...)
  -> record.hookCount += 1
```

另一条链路为：

```text
api.registerHook(...)
  -> registerHook(...)
  -> registry.hooks.push(...)
  -> registerInternalHook(...)
```

两者是不同的注册表、处理器类型和调度链。

### 3.3 当前 NAPM 插件实际注册状态

当前插件的辅助函数先检查 `api.hooks.on`，不存在时回退到 `api.registerHook`。它没有优先使用远端 SDK 声明的 `api.on`。

远端 `plugins inspect --runtime` 将当前 NAPM Hook 显示为 `Custom hooks`：

```text
napm-message-scope-detect
napm-routing-policy
napm-boundary-tool-guard
napm-out-of-scope-rewriter
napm-before-message-write-guard
```

运行时 JSON 同时显示：

```json
{
  "hookCount": 0
}
```

远端实现中 `hookCount` 只在 `registerTypedHook` 中递增。因此可以确认：

> 当前 NAPM 插件没有向 OpenClaw 注册任何 Typed Hook；现有 5 组 Hook 被登记为内部 Custom Hook。

### 3.4 `after_tool_call` 当前缺失

当前插件没有注册 `after_tool_call`。这与 2026-07-30 维护记录中“通过 `after_tool_call` 将 Tool 结果绑定到当前 Run/Session”的描述不一致。

这不是“`after_tool_call` 注册到了错误入口”，而是当前代码中该注册已经缺失。

### 3.5 日志证据的边界

当前保留的 2026-08-02 至 2026-08-03 Gateway 日志没有企业微信请求和 NAPM Tool 调用样本，因此：

- 可以确认运行时注册表中 Typed Hook 数量为 0。
- 不能仅根据现有日志断言已经发生跨会话串数据。
- 不能仅根据现有日志断言已经输出过错误健康结论。
- 不能仅根据现有日志断言已经发生推理文本泄漏。

后续结论必须区分：

| 标记 | 含义 |
|---|---|
| 远端已证实 | 由远端安装包、运行注册表、进程或日志直接证明 |
| 本地代码证实 | 当前源码中可以直接确认的行为 |
| 风险推断 | 根据状态模型推导出的可能故障，尚无现场样本 |

## 4. Typed Hook 的正确职责

Typed Hook 不应承担 NAPM 业务查询本身。它适合处理跨 Tool、跨消息阶段的横切职责。

| 生命周期 | 适合放置的职责 | 不应放置的职责 |
|---|---|---|
| `message_received` | 获取当前消息的会话标识、轻量审计 | 保存长期业务结果 |
| `before_prompt_build` | 注入稳定、简短的工具路由约束 | 解析完整 NAPM 业务语义 |
| `before_tool_call` | 安全边界、禁止旁路、关联当前 `runId` | 作为唯一参数校验入口 |
| `after_tool_call` | 记录本次 Tool 成功/失败、生成结果引用 | 修改 NAPM 原始数据 |
| `before_message_write` | 防止内部控制文本写入会话 | 重新生成业务结论 |
| `message_sending` | 最终发送策略、媒体幂等、安全兜底 | 查询 NAPM 或生成报告 |

关键业务校验必须同时位于 Tool 或 Skill 执行入口，不能只依赖 Hook。例如：

- `resolvedQuery` 结构校验。
- 执行时间范围校验。
- 必需证据失败时禁止生成健康结论。
- 报告输入契约校验。
- 不允许不安全 TLS 的生产策略。

这样即使 Hook 配置错误，Tool 也不会执行错误的业务请求。

## 5. Skill 是否需要管理会话状态

结论：不需要。

### 5.1 Skill 的推荐模型

NAPM Skill 应尽量保持无状态：

```text
结构化输入 -> 领域校验 -> NAPM 查询或报告生成 -> 结构化输出
```

Skill 不应自行判断：

- 当前用户是谁。
- 当前企业微信群是谁发起的请求。
- “以上”指的是哪个用户的哪次查询。
- 当前会话最近一次结果是什么。
- 某个附件是否已经发送过。

### 5.2 多步骤诊断的状态处理

故障诊断确实存在多步骤状态，但可以显式传递：

```json
{
  "sessionJson": "<上一轮返回的序列化诊断状态>",
  "action": "继续下一步"
}
```

Skill 接收上一轮状态并返回下一轮状态，不需要在进程内按用户保存全局会话。

### 5.3 跨轮报告导出的状态处理

“把以上导出 Word”需要跨轮关联，但它仍不应由 Skill 猜测“最近一次结果”。推荐使用显式引用：

```text
第一次查询
  -> 返回 resultId + reportData 或 reportDataRef
  -> OpenClaw 当前会话保留该引用

第二次请求“把以上导出 Word”
  -> OpenClaw 选择当前会话中的 resultId
  -> napm-report-export({ sourceResultId: resultId })
```

报告 Skill 只消费明确的 `sourceResultId` 或 `reportData`，不查找全局“最新结果”。

## 6. 当前插件状态的逐项处置建议

| 当前状态 | 当前用途 | 建议 |
|---|---|---|
| `napmConversationState` | 保存当前问题和会话级派生状态 | 原则上删除；当前消息从 OpenClaw event/ctx 获取 |
| `napmGuardState` | Tool 路由和最终回答保护 | 缩小为单 Run 临时状态，以 `runId` 为键并在 Run 结束后释放 |
| `napmOperationState` | 保存最近 Skill 结果、调试 URL、报告结果 | 拆分；报告改为显式 `resultId`，调试信息不进入用户会话缓存 |
| `napmSentMediaByConversation` | 两分钟附件去重 | 移至交付层，使用 `messageId + artifactId` 做幂等 |
| `napmTrustedToolContextByTraceId` | 将 Tool 参数与会话关联 | 优先使用 OpenClaw 直接提供的 `runId/sessionKey`；仅保留有界短期关联 |
| `ConversationOperationState` | 统一管理上述跨轮状态 | 不再承担“最新结果猜测”；如保留，仅作为有 TTL、容量限制的结果引用仓库 |

### 6.1 不建议继续使用“最新结果”语义

以下 API 语义在并发场景下天然含糊：

```text
getLatestSkillResult(scope)
getLatestDebugApi(scope)
getReportExport(scope)
```

推荐替换为：

```text
getResultById(resultId, expectedSessionKey)
getReportById(reportId, expectedSessionKey)
markArtifactDelivery(artifactId, messageId, status)
```

每次读取都应校验所属 session，而不是依赖“谁最后写入”。

## 7. 推荐目标架构

```text
企业微信 / 其他 Channel
          |
          v
OpenClaw Session + Agent Run
  - sessionKey/sessionId
  - runId
  - 消息历史与 Tool 调度
          |
          v
NAPM Plugin / Extension
  - 注册 7 个 Tool
  - 当前 Run 的安全边界
  - 参数传递与结果引用
  - 最终交付适配
          |
          +--------------------+
          |                    |
          v                    v
无状态 NAPM Skills       Result/Artifact Repository
  - Query                  - resultId/reportId
  - Alert                  - session 所属关系
  - Summary                - TTL/容量/状态
  - Fault                  - 不保存聊天语义
  - Report
          |
          v
NAPM 数据源 / 报告文件存储
```

### 7.1 各层职责

#### OpenClaw

- 会话和 Run 隔离。
- 当前消息上下文。
- Tool 调度。
- Channel 路由。

#### NAPM Plugin

- Tool 注册与领域边界。
- 将 OpenClaw 上下文转换为明确的 Tool 输入。
- 仅维护必要、短期、可追踪的结果引用。
- 不复制完整聊天会话。

#### NAPM Skill

- 领域输入校验。
- NAPM 查询、分析和报告数据生成。
- 返回确定性的结构化结果。
- 不保存用户会话。

#### Result/Artifact Repository

- 以 `resultId/reportId/artifactId` 保存对象。
- 记录所属 `sessionKey` 和创建 `runId`。
- TTL、容量和清理策略。
- 报告发送状态和幂等键。
- 不使用用户自然语言作为主键。

#### Channel 交付层

- 文本和 MEDIA 发送。
- 下载鉴权或签名 URL。
- `queued/sending/sent/failed` 状态。
- 以 `artifactId + messageId` 防重复发送。

## 8. 方案比较

### 8.1 方案 A：只修复 Typed Hook

内容：

- 将 Typed Hook 改为 `api.on(...)`。
- 恢复 `after_tool_call`。
- 保留现有全局缓存。

优点：

- 改动小。
- 能快速恢复原设计中的生命周期保护。

缺点：

- 继续重复 OpenClaw 会话职责。
- “最新结果”语义和粗粒度 conversation key 仍然存在。
- 插件继续承担过多状态管理。

适用：短期恢复测试环境保护能力。

### 8.2 方案 B：修复 Hook 并减少共享状态

内容：

- Typed Hook 使用 `api.on(...)`。
- Tool 内保留全部关键业务校验。
- 删除 `napmConversationState`。
- `napmGuardState` 改为 `runId` 级临时状态。
- 报告改用显式 `resultId`。
- 附件去重移至交付层。

优点：

- 保留必要生命周期能力。
- 减少与 OpenClaw 的职责重叠。
- 能支持跨轮报告和最终发送保护。

缺点：

- 需要调整报告 Tool 契约和测试。

适用：当前项目的推荐目标方案。

### 8.3 方案 C：完全不依赖 Typed Hook

内容：

- 所有参数、结果和交付契约显式化。
- Tool 直接返回最终文本和结果引用。
- 不做最终消息改写。
- Channel 层独立完成交付。

优点：

- Tool 行为最容易独立测试。
- 生命周期耦合最少。

缺点：

- 无法统一拦截模型旁路调用和不安全最终回复。
- 需要更大范围重构 OpenClaw 集成方式。

适用：未来重构，不建议作为当前快速整改方案。

## 9. 推荐实施顺序

### 阶段 1：确认并恢复正确生命周期契约

1. Typed Hook 仅通过 `api.on(...)` 注册。
2. 不再将 Typed Hook 回退到 `registerHook(...)`。
3. 恢复或重新设计 `after_tool_call`。
4. 使用远端 OpenClaw `plugins inspect --runtime --json` 验证 `hookCount > 0`。
5. 保留 Tool 内已有的参数和时间校验，不将其迁回 Hook。

### 阶段 2：收缩插件状态

1. 列出每个 `Map` 的读写点和保存数据。
2. 删除仅复制 OpenClaw 当前消息的信息。
3. 临时状态统一按 `runId` 分区。
4. 跨轮状态统一转换为显式引用。
5. 增加 Run 完成后的释放和异常清理。

### 阶段 3：改造报告关联

1. Query、Alert、Summary、Fault 返回 `resultId`。
2. Report Tool 接收 `sourceResultId` 或显式 `reportData`。
3. 禁止默认读取“当前 scope 最近一次结果”。
4. Repository 校验 `expectedSessionKey`。
5. 报告生成使用不会碰撞的 `reportId`。

### 阶段 4：改造附件交付

1. 报告文件迁出源码目录。
2. 返回标准 `artifactId/media` 契约。
3. 增加下载鉴权或短期签名 URL。
4. 增加发送状态与失败重试。
5. 使用 `artifactId + messageId` 做幂等，不按 URL 和 conversation 猜测。

### 阶段 5：删除兼容代码

1. 删除不再使用的“最新结果”方法。
2. 删除错误的 `registerHook` Typed Hook 回退。
3. 删除过期文档中“热加载即可生效”的表述。
4. 更新 Tool 契约、运行文档和现场测试手册。

## 10. 必须补充的自动化测试

### 10.1 Tool 与 Hook 解耦测试

- 不注册任何 Hook 时，7 个 Tool 的 `execute()` 仍能独立完成输入校验。
- 缺少 `resolvedQuery` 时 Query Tool 自身拒绝执行。
- 必需证据失败时 Summary/Fault Tool 自身禁止健康结论。

### 10.2 运行时 Hook 契约测试

- Harness 必须提供真实 `api.on`。
- Typed Hook 错误调用 `registerHook` 时测试立即失败。
- 断言 `message_received`、`before_tool_call`、`after_tool_call`、`before_message_write`、`message_sending` 的注册数量和名称。
- 断言处理器接收真实 `(event, ctx)` 结构。

### 10.3 状态隔离测试

- 两个不同 `sessionKey` 同时查询，结果引用不能互相读取。
- 同一 `sessionKey` 下两个不同 `runId` 重叠执行，最终结果按 Run 关联。
- 同一企业微信群两个用户同时查询，不使用模糊“最新结果”。
- 过期 resultId、错误 sessionKey 和不存在 resultId 均明确失败。

### 10.4 报告和交付测试

- “把以上导出 Word”必须携带明确 `sourceResultId`。
- 同一秒并发生成相同类型报告时文件名不碰撞。
- 同一 artifact 重复发送只产生一次实际投递。
- 发送失败保留 `failed` 状态并允许重试。

## 11. 企业微信现场验收建议

### 场景 1：普通单轮查询

目标：证明 Tool 基础执行不依赖 Hook。

```text
用户 A：查询最近一小时流量最高的前 5 个业务
```

检查：

- 只调用 `napm-skill-query`。
- Tool 结果和最终回复数据一致。
- 不出现内部路由、JSON 或推理文本。

### 场景 2：不同私聊并发

```text
会话 A：查询普通业务指标
会话 B：查询告警摘要
```

检查：

- 两个 OpenClaw session 和 run 独立。
- 最终回复分别对应各自 Tool 结果。

### 场景 3：同群多用户与跨轮导出

```text
用户 A：查询业务 A
用户 B：查询业务 B
用户 A：把我刚才的结果导出 Word
```

检查：

- 必须依据用户 A 的明确 resultId。
- 不允许以群聊“最近一次结果”选择用户 B 的数据。

### 场景 4：同一会话重叠请求

在第一条请求尚未结束时发送第二条请求。

检查：

- 两次请求有不同 `runId`。
- Tool 结果、最终回复和报告引用均按 Run 对应。

### 场景 5：失败保护

使用可控测试桩模拟必要数据源失败，不直接破坏生产数据源。

检查：

- Tool 返回明确失败。
- 最终回复不输出“正常、健康、无异常”。
- 不生成正式报告或标记 `reportReady: true`。

## 12. 不应继续采用的做法

- 不让 Skill 保存用户会话或“最近一次查询”。
- 不使用自然语言 prompt 作为跨轮结果的唯一主键。
- 不按 conversation 选择全局最新结果。
- 不把关键业务校验只放在 Hook。
- 不用 `registerHook` 兼容 Typed Hook。
- 不通过最终消息改写掩盖 Tool 本身的错误输出。
- 不让报告 Skill 负责企业微信发送幂等。

## 13. 待确认决策

实施前需要明确以下产品与技术决策：

1. 企业微信群内是否支持多个用户并发使用同一个机器人会话。
2. “把以上导出”是否必须支持；是否可以要求用户明确指定查询结果。
3. Tool 返回的完整 `reportData` 是否允许进入 OpenClaw 会话上下文。
4. Result Repository 使用内存、文件、SQLite 还是外部存储。
5. 结果引用的 TTL 和最大容量。
6. 报告附件由 OpenClaw 媒体层还是独立下载服务交付。
7. 最终消息是否必须完全使用 Tool 的 `displayText/finalAnswer`，还是允许模型重新叙述。

## 14. 最终建议

采用方案 B：修复 Typed Hook，同时减少插件共享状态。

目标边界为：

```text
OpenClaw：管理会话和 Run
Plugin：注册 Tool、当前 Run 安全边界、结果引用和交付适配
Skill：无状态领域执行
Repository：按 resultId/reportId 保存结果和文件
Channel：负责 MEDIA 发送、鉴权、状态与幂等
```

这一路径既不否定当前已经可以工作的 Tool 基础链路，也不会继续让 NAPM Plugin 和 Skill 重复实现 OpenClaw 的会话系统。
