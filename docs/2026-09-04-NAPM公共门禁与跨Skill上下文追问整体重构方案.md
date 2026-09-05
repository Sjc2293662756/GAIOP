# NAPM 公共门禁与跨 Skill 上下文追问整体重构方案

日期：2026-09-04

状态：阶段 0–2 已实施并完成准入授权复审加固；Alert 序号详情已完成第一个迁移切片；Packet/Report 等保留原领域状态并由保守边界防止错误回退

适用范围：NAPM OpenClaw Plugin、7 个生产 Tool、Query Turn、告警引用、报告来源、数据包确认和最终交付

关联问题：“看第一个的详情”被公共门禁错误识别为非 NAPM 动作，导致正确的查询 Tool 调用全部被阻断

## 1. 一句话结论

当前公共门禁同时承担“理解用户意思”和“检查调用是否安全”两项职责。只要它没有听懂一句简短追问，就会在各 Skill 处理上下文之前直接禁止 Tool。

本方案不继续为门禁增加零散关键词，也不建立一个管理所有 Skill 状态的全局大状态机，而是：

1. 在门禁之前增加统一的“本轮意图和上下文准入判断”；
2. 生成一份不可变、绑定当前 run 的通行决定；
3. 公共门禁只检查身份、route、Tool、重放和终态；
4. Query、Alert、Packet、Report 等 Skill 继续分别管理自己的业务状态；
5. 跨轮选择只能读取插件保存的权威结果，不能相信模型记忆或模型猜测。

## 2. 为什么要做整体修改

这次生产问题不是 Query Skill 不会查询，也不是上一轮业务排行错误。

现场链路是：

```text
用户：最近一小时哪些业务页面访问量最高？
  -> 查询成功
  -> WebApplication 排行正确返回

用户：看第一个的详情
  -> 模型知道第一个是“回溯238web”
  -> 公共门禁把当前轮判断为 model_owned
  -> 模型多次调用 napm-skill-query
  -> 所有调用在进入 Query Turn 和 Result Reference 解析前被阻断
```

如果只增加“看第一个的详情”这一条规则，后续仍可能出现：

- “第二个呢”；
- “这个告警怎么回事”；
- “下载刚才那个”；
- “把上面的导出”；
- “继续分析”；
- “确认”；
- “换成最近一天”；
- “看它的页面”；
- “第一个的前 20 条”。

这些问法可能属于 Query、Alert、Packet 或 Report。继续在公共门禁里补正则，会让规则越来越多、互相覆盖，并影响所有 Skill。

## 3. 生产日志已经证明的事实

### 3.1 上一轮查询是成功的

2026-09-04 17:19 的查询完成了以下流程：

- 当前对象为 `WebApplication`；
- 指标为页面访问数 `PGNPGE`；
- 时间范围为最近 1 小时；
- Query Decision 为 `EXECUTE_QUERY`；
- 南向请求成功；
- 最终结果由 Query Turn 完成交付。

### 3.2 追问在公共路由阶段被拦截

2026-09-04 17:24 收到“看第一个的详情”后，日志记录为：

```text
route=model_owned
napmRelated=false
```

模型随后多次尝试 `napm-skill-query`，其中一次已经携带：

```json
{
  "resultReference": {
    "objectType": "WebApplication",
    "ordinal": 1
  }
}
```

但 Tool 全部被 `non-action turn` 门禁拦截。

### 3.3 阻断发生在上下文解析之前

17:24 至 17:27 的日志计数：

| 检查项 | 次数 |
| --- | ---: |
| 非动作轮次门禁阻断 | 8 |
| Query 参数规范化 | 0 |
| Query 结构校验 | 0 |
| `topValues` 南向调用 | 0 |
| `pageViews` 南向调用 | 0 |

因此不能把问题描述为“Result Reference 解析失败”或“Query Turn 丢失”。Result Reference 解析器根本没有获得执行机会。

### 3.4 “确认”也没有正式待恢复状态

模型在文字中询问用户是否确认，并不等于插件生成了 `Pending Clarification`。

前一轮没有进入 Query Decision，因此没有保存正式 pending Draft。用户回复“确认”时，插件没有可以恢复的操作，只能再次判断当前短句，而“确认”又被判断为 `model_owned`。

### 3.5 不是发布覆盖

现场运行的是 rc.50，活动 Plugin、QueryTurnCoordinator、WorkflowClassifier 和 TopN 归一化文件与 rc.50 发布包一致。当前故障属于 rc.50 代码中的上下文准入覆盖不足，不是部署后文件被覆盖或混装。

## 4. 当前系统是谁在管理上下文

当前有三类上下文同时存在。

### 4.1 OpenClaw 会话上下文

OpenClaw 负责：

- 保存聊天消息；
- 让模型看到前文；
- 建立 `sessionKey`、`sessionId` 和 `runId`；
- 调度 Tool 调用。

所以模型可以理解“第一个”大概指上一轮第一名。

### 4.2 Plugin 运行上下文

Plugin 当前维护：

- `napmConversationState`；
- `napmGuardState`；
- `ConversationOperationState`；
- `QueryTurnCoordinator`；
- `ReportSourceStore`；
- `AlertReferenceStore`；
- trusted Tool context；
- 自动报告状态；
- 媒体发送状态；
- 数据包确认状态；
- 原生命令状态。

这些状态主要用于安全校验、跨轮引用、报告来源、附件去重和最终结果交付。

### 4.3 各 Skill 的业务上下文

不同 Skill 的业务状态不同：

| Skill | 需要保存或引用的内容 |
| --- | --- |
| Query | Query Draft、Query Decision、一次修复预算、结果集、对象序号、时间范围 |
| Alert | 告警事件、eventId、告警引用、通知字段 |
| Alert Packet | 告警候选数据包、候选选择、下载确认 |
| Packet | 查询条件、预览结果、下载确认、文件结果 |
| Report | 报告来源、报告类型、生成结果、附件 |
| Inspection | 巡检快照和报告来源 |
| Summary | 综述范围、对象、时间和报告来源 |
| Fault Diagnosis | 诊断类型、目标对象、证据链和阶段结果 |

它们不能简单合并为同一种状态机。

## 5. 当前设计的核心问题

### 5.1 公共门禁过早做语义裁决

当前流程近似为：

```text
收到消息
  -> 使用当前短句和若干正则生成 napmRelated/domainRelated
  -> 生成 route
  -> before_tool_call 先按 route 决定是否允许 Tool
  -> 通过后才进入具体 Skill 的上下文解析
```

这意味着公共门禁可以在不了解上一轮权威结果的情况下否决所有 Skill。

### 5.2 上下文事实和当前短句没有在一个地方合并

“看第一个的详情”本身信息不完整，但结合上一轮 `WebApplication` 排行就很明确。

当前分类器主要看当前文本；Query Turn 保存的权威结果由后面的 Result Reference 解析器读取。两者执行顺序相反，导致有上下文也无法使用。

### 5.3 多套 continuation 规则互相独立

当前 Plugin 中存在多类追问判断：

- 通用 NAPM 追问；
- 结果交付追问；
- 告警追问；
- 告警数据包确认；
- 数据包下载确认；
- 报告导出；
- Query Pending Clarification；
- Query Result Reference；
- timeValues 特殊追问放行。

每类规则读取的状态和关键词不同，容易出现某条链路能继续、另一条链路在公共门禁处被挡住。

### 5.4 模型理解和系统权威状态可能分离

模型可以根据聊天记录猜出“第一个”是谁，也可以自行问“是否确认”。但这些信息如果没有进入 Plugin 的正式状态，就不能安全地驱动南向查询。

这是正确的安全原则，但当前系统缺少把“模型理解”转换为“权威选择或正式澄清”的统一入口。

### 5.5 公共 Hook 代码承担过多职责

`before_tool_call` 当前同时负责：

- 生命周期身份校验；
- route 校验；
- Tool 选择；
- Prompt 业务分类；
- Query 参数改写；
- Result Reference 解析；
- Query Decision；
- 报告旁路拦截；
- 告警、数据包、巡检、综述和故障诊断的 Tool 冲突判断；
- shell/curl 等危险调用拦截。

任何修改都有可能影响多个 Skill。

## 6. 设计目标

### 6.1 必须实现

1. 所有 Skill 的上下文追问先解析，再进入公共门禁；
2. 一条用户消息只生成一个不可变的本轮准入决定；
3. 决定必须绑定当前 `runId/messageId + turnId`；
4. 公共门禁不再独立理解具体业务语义；
5. 各 Skill 继续维护自己的业务状态和失败规则；
6. 跨轮选择必须读取同一 conversation scope 内的权威结果；
7. 没有权威上下文时不得根据模型记忆直接执行；
8. 阻断时 Query Skill、领域 Client 和南向调用必须为 0；
9. 重叠 run 不得串状态；
10. `/new` 后不得引用旧结果。

### 6.2 本次不做

1. 不把所有 Skill 塞入同一个全局状态机；
2. 不让 Skill 自己保存 OpenClaw 会话；
3. 不用一个“最新结果”指针解决所有跨轮场景；
4. 不立即引入数据库或外部状态服务；
5. 不改变 Query、Alert、Packet 等现有南向业务协议；
6. 不在公共门禁中继续增加业务同义词正则；
7. 不允许模型直接提供或伪造内部 ID；
8. 不借本次修改同时重构所有报告生成和文件发送逻辑。

## 7. 目标结构：接待、业务账本、门卫

为便于理解，目标结构分为三个角色。

### 7.1 接待：统一判断本轮要做什么

建议建立 `TurnAdmissionCoordinator`。

它在 `message_received` 阶段执行，负责：

- 读取当前用户原话；
- 读取当前 run/message 身份；
- 查看是否存在正式 pending 操作；
- 查看当前 scope 中是否有可引用的权威结果；
- 调用统一意图分类器；
- 让对应 Skill 的上下文解析器判断是否可继续；
- 生成一份不可变的 `TurnAdmissionDecision`。

它不执行查询、不调用南向接口，也不生成报告。

### 7.2 业务账本：各 Skill 保存自己的权威上下文

现有领域状态继续保留：

- Query 使用 `QueryTurnCoordinator`；
- Alert 使用告警引用存储；
- Report 使用报告来源存储；
- Packet 使用自己的预览、候选和确认状态；
- Inspection、Summary、Fault Diagnosis 保留各自工作流。

公共接待只询问这些业务账本：

```text
当前消息是否能根据你保存的权威上下文继续？
如果能，目标 Tool 和操作是什么？
如果不能，是需要澄清、已过期，还是与你无关？
```

### 7.3 门卫：只检查能不能安全执行

建议将现有公共门禁收窄为 `ExecutionGatePolicy`。

它只检查：

- 当前 run/message 是否有可信身份；
- 当前 Tool 是否绑定正确 `turnId`；
- Tool 是否等于本轮决定中的 `expectedTool`；
- route 是否允许这个 Tool；
- traceId 和 toolName 是否可信；
- 是否已经在执行；
- 是否已经终态；
- 是否为重复发送或重复执行；
- 是否尝试 shell、curl、重启或其他禁止操作。

它不再通过“页面、告警、第一个、确认”等关键词推断业务。

## 8. 两类 Decision 必须区分

本方案增加的是“本轮准入决定”，它不能替代 Query Skill 内已经实现的 Query Decision。

### 8.1 Turn Admission Decision

回答：本轮应该交给谁处理？

建议字段：

```json
{
  "conversationKey": "<scope>",
  "turnId": "<current-turn>",
  "runId": "<current-run>",
  "route": "NAPM_QUERY",
  "action": "EXECUTE_TOOL",
  "expectedTool": "napm-skill-query",
  "workflow": "result_drilldown",
  "sourceArtifactId": "<trusted-result-set>",
  "selection": {
    "kind": "ordinal",
    "ordinal": 1
  },
  "reasonCode": "AUTHORITATIVE_RESULT_FOLLOWUP"
}
```

### 8.2 Query Decision

回答：这个 Query Draft 是否完整、合法并允许执行？

它继续使用：

- `ASK_CLARIFYING_QUESTION`；
- `EXECUTE_QUERY`；
- `REJECT_QUERY`。

正确流程是：

```text
Turn Admission Decision 选择 napm-skill-query
  -> QueryTurnCoordinator 和 QueryDecisionPolicy 接手
  -> Query Decision 决定澄清、执行或拒绝
```

## 9. 统一上下文解析顺序

所有 Skill 共用以下优先级，避免规则互相抢占。

### 优先级 1：OpenClaw 原生命令

- `/new`、`/reset` 由 OpenClaw 命令流程处理；
- 清理当前 conversation scope 下的 Plugin 短期状态；
- 不调用任何 NAPM Tool；
- 普通文本 `new` 不等于 `/new`。

### 优先级 2：正式 Pending 操作

如果当前 scope 有正式 pending 状态：

- 用户回复对象名：恢复缺少对象的 Query Draft；
- 用户回复“确认”：只恢复明确等待确认的操作；
- 用户回复序号：只选择 pending 候选集合中的对应项；
- 输入与 pending 无关：不强行恢复，继续判断新意图。

### 优先级 3：权威结果追问

以下是目标架构最终要覆盖的通用选择表达：

- 第一个、第一名、排名第一；
- 第二个、第三条；
- 这个、它、刚才那个；
- 前 20 个、详细查看；
- 导出上面结果；
- 下载第一条。

截至当前实施阶段，公共 `ReferenceSelectionParser` 只支持“第 N 个 + 详情”、可选“前 N 条”和上下文时间变更。代词单独选择（“这个/它”）、通用确认/取消、报告导出和数据包下载尚未迁入公共解析器，仍由既有领域专用流程处理或保守澄清。本文列出它们是后续阶段范围，不表示已经全部实现。

然后结合权威结果类型决定交给哪个 Skill。

### 优先级 4：明确的新业务意图

完整问题直接通过统一意图分类器选择 Query、Alert、Report、Packet、Inspection、Summary 或 Fault Diagnosis。

### 优先级 5：无法确定

- 可能涉及 NAPM，但缺少上下文：生成正式澄清；
- 明确不属于 NAPM：`MODEL_OWNED`；
- 明确越界：`REJECT`；
- 不得默认调用某个 Skill 试错。

## 10. 各 Skill 的上下文追问规则

### 10.1 Query

权威来源：`QueryTurnCoordinator`。

支持：

- 对象名补充；
- TopN 序号选择；
- `WebApplication -> PageFamily` 下钻；
- `PageFamily -> pageViews` 详情；
- 继承时间范围；
- 更换时间范围后重新校验；
- 正式 Query Clarification。

禁止：

- 模型从回答文字复制业务名作为权威来源；
- 模型猜 `pageFamilyId`；
- 跨 scope 引用；
- 结果过期后继续执行。

### 10.2 Alert

权威来源：告警引用记录。

支持：

- “看第一个告警”；
- “这个告警的详情”；
- “这个告警有数据包吗”；
- eventId 继续分析。

如果上一结果不是告警集合，“第一个告警”必须澄清或重新查询，不能读取 Query 的第一名。

### 10.3 Alert Packet

权威来源：告警事件和候选数据包记录。

支持：

- “分析第一份”；
- “全部分析”；
- “确认下载”；
- “取消”。

确认只能作用于正式等待确认的候选，不能把普通“确认”解释为下载授权。

### 10.4 Packet

权威来源：数据包预览和下载操作记录。

支持：

- 选择候选包；
- 预览后下载；
- 下载后继续分析；
- 页面访问实例引用。

下载、文件写入和分析继续由 Packet Skill 自身执行安全检查。

### 10.5 Report

权威来源：`ReportSourceStore` 或明确 `sourceResultId`。

支持：

- “导出上面结果”；
- “改成 Word”；
- “重新生成”；
- 从 Query、Alert、Inspection、Summary 或 Fault 结果生成报告。

如果同一 scope 有多个可导出结果且无法唯一选择，应询问用户，不得默认取“最新一次”。

### 10.6 Inspection 和 Summary

权威来源：当前巡检/综述结果及报告来源。

普通追问可以解释现有结果；请求新的时间或 scope 时重新执行对应 Skill；请求导出时进入 Report。

### 10.7 Fault Diagnosis

权威来源：明确诊断目标、诊断类型和结构化证据。

“为什么”“继续分析”“看错误详情”等追问只有在目标明确时才能继续；缺少目标必须正式澄清，不能从无关的最近查询中猜测。

## 11. “第一个的详情”如何确定含义

通用选择解析器只负责识别：

```text
选择序号：1
动作：查看详情
```

它不直接决定具体 Skill。接待层根据来源结果类型处理：

| 上一权威结果 | “看第一个的详情”的含义 |
| --- | --- |
| `WebApplication` 排行 | 查询第一名业务访问的 `PageFamily` 排行 |
| `PageFamily` 排行 | 查询第一名页面的 `pageViews` 详情 |
| 告警列表 | 查询第一条告警详情 |
| 数据包候选列表 | 查看第一份候选；下载仍需正式确认 |
| 可导出报告来源列表 | 选择第一份来源，但有风险动作时继续确认 |
| 没有权威结果 | 询问“您指的是哪一份结果？” |

如果同一会话存在多个不同类型的可引用结果，应优先使用当前 Query Turn 创建时冻结的来源；无法唯一确定时必须澄清。

## 12. 正确的三轮 Query 示例

### 第一轮：业务排行

```text
用户：最近一小时哪些业务页面访问量最高？
```

执行：

```text
topValues + WebApplication + PGNPGE + last1hour
```

保存权威 `WebApplication` 排行结果集。

### 第二轮：业务下钻

```text
用户：看第一个的详情
```

处理：

```text
通用选择 = ordinal 1 + detail
来源结果 = WebApplication ranking
目标操作 = WebApplication -> PageFamily
expectedTool = napm-skill-query
```

Plugin 从权威结果取得业务名，执行页面族排行。

### 第三轮：页面访问实例

```text
用户：详细看第一个的前 20 条
```

处理：

```text
通用选择 = ordinal 1 + detail + limit 20
来源结果 = PageFamily ranking
目标操作 = pageViews
```

Plugin 从权威结果取得 `pageFamilyId`，继承可信时间范围并执行一次 `pageViews`。

## 13. 澄清和确认的正式流程

### 13.1 正确流程

```text
领域处理器发现缺少信息
  -> 生成 ASK_CLARIFYING_QUESTION
  -> 保存 pending operation / pending Query Draft
  -> 由系统输出权威澄清内容
  -> 用户回复对象名、序号或确认
  -> 接待层发现正式 pending
  -> 创建新的 run-bound turn
  -> 恢复并消费 pending
```

### 13.2 禁止流程

```text
模型自行问“是否确认”
  -> Plugin 没有 pending
  -> 用户回复“确认”
  -> 模型假装可以恢复上一轮操作
```

没有正式 pending 时，“确认”只能被视为缺少对象的普通短句，不能触发查询、下载、报告或其他有副作用的操作。

## 14. 建议代码结构

以下为目标职责，不要求一次性完成全部文件迁移。

### 14.1 `plugin/TurnAdmissionCoordinator.js`

职责：

- 在当前 run 上生成一次准入决定；
- 调度上下文解析器；
- 固化 route、expectedTool、来源引用和原因码；
- 不调用 Skill；
- 不保存各 Skill 的业务状态。

### 14.2 `plugin/ReferenceSelectionParser.js`

目标职责：

- 解析序号、代词、数量、确认、取消和导出等通用选择表达；
- 输出结构化选择；
- 不决定目标 Skill；
- 不读取业务结果。

当前落地切片只实现序号详情、请求条数和时间变更。`确认/取消/导出/下载/这个/它` 未在通用解析器中实现，避免在对应领域 pending、风险确认和 artifact 契约迁移前误放行。

### 14.3 `plugin/context-resolvers/`

建议按业务提供适配器：

- `QueryContextResolver`；
- `AlertContextResolver`；
- `PacketContextResolver`；
- `ReportContextResolver`；
- 后续按需要增加 Inspection、Summary 和 Fault。

每个适配器只读取自己的权威状态，并返回：可处理、需要澄清、已过期或不相关。

### 14.4 `plugin/ExecutionGatePolicy.js`

职责：

- 校验可信生命周期身份；
- 校验本轮准入决定；
- 校验 expectedTool；
- 拦截重复执行、终态重放和危险系统调用；
- 不再解析中文业务语义。

### 14.5 保留的现有模块

- `QueryTurnCoordinator`；
- `QueryDecisionPolicy`；
- `ReportSourceStore`；
- `AlertReferenceStore`；
- 各 Skill 自身执行和参数校验。

## 15. 状态和身份规则

### 15.1 Conversation Scope

只表示上下文可见范围，不表示“当前最新 turn”。所有引用必须校验所属 scope。

群聊场景还需要确认 conversation scope 是否包含用户身份；如果多个用户共享同一 scope，必须升级为包含发送用户的稳定身份，避免用户 A 引用用户 B 的结果。

### 15.2 Run Binding

每个 `message_received` 创建新的 `turnId`，并与当前 run/message 绑定。后续 Hook 和 Tool 只能读取这个绑定，禁止读取会话最新 turnId。

### 15.3 Result/Artifact Reference

跨轮结果使用明确引用，至少包含：

- 来源 Skill；
- 来源 turn；
- conversation scope；
- 结果类型；
- 对象类型；
- 创建时间与过期时间；
- 最小必要数据；
- 可执行的后续动作。

第一阶段不要求把所有引用合并到一个存储中。应先让各 Skill 通过统一解析接口暴露自己的权威引用，确认需求稳定后再评估是否提取共享 Repository。

### 15.4 TTL 和重启

当前 Query 结果引用保存在 Gateway 内存中并有 TTL。Gateway 重启后失效是可接受的保守行为，但必须明确告诉用户重新执行上一查询，不能回退到模型聊天记忆。

## 16. 门禁改造后的处理原则

### 16.1 允许

- 本轮准入决定明确指定了 Tool；
- Tool 与 expectedTool 一致；
- 当前 trace、turn、run 和 scope 一致；
- 领域处理器再次校验参数通过；
- 当前操作没有执行中或终态冲突。

### 16.2 阻断

- 无可信 run/message 身份；
- route 或 Tool 不匹配；
- 结果引用跨 scope、过期或类型错误；
- 用户没有正式确认风险操作；
- 重复 Tool 可能产生第二次南向调用；
- 模型尝试使用 shell、curl 或直接接口绕过 Skill；
- `/new` 后引用旧结果；
- 当前语义仍有歧义。

### 16.3 关键要求

阻断结果必须说明真实原因，例如：

- `TURN_ADMISSION_UNRESOLVED`；
- `EXPECTED_TOOL_MISMATCH`；
- `RESULT_REFERENCE_NOT_FOUND`；
- `RESULT_REFERENCE_EXPIRED`；
- `PENDING_CONFIRMATION_NOT_FOUND`；
- `QUERY_EXECUTION_IN_PROGRESS`。

不能把所有问题统一回答成“当前轮应由模型直接回答或澄清”。

## 17. 审计日志要求

当前日志能看到 Tool 被拦截，但缺少完整的上下文选择证据。建议增加：

### 17.1 准入决定

```text
turn_admission_decided
```

记录：

- scope 哈希；
- turnId/runId；
- route；
- action；
- expectedTool；
- workflow；
- reasonCode；
- 是否使用 pending 或 result reference。

### 17.2 权威引用保存

```text
authoritative_artifact_stored
```

只记录最小摘要、类型、行数、来源 turn 和过期时间，不记录完整业务数据和敏感字段。

### 17.3 引用解析

```text
authoritative_artifact_resolved
authoritative_artifact_resolution_failed
```

记录来源类型、序号、目标操作和失败原因。

### 17.4 门禁决定

```text
execution_gate_allowed
execution_gate_blocked
```

明确区分身份失败、route 失败、Tool 不匹配、重复执行和领域校验失败。

## 18. 分阶段实施方案

### 阶段 0：建立真实回放测试

把本次生产日志转换为不连接服务器的本地生命周期测试：

1. 第一轮执行 `WebApplication` TopN；
2. 第二轮原文使用“看第一个的详情”；
3. 断言当前代码在公共门禁处失败；
4. 记录所有 Tool、Query Skill、Client 和南向调用计数；
5. 该测试必须先稳定复现，再开始修改。

退出条件：测试准确复现 `model_owned -> Tool blocked`。

### 阶段 1：引入准入决定，不改变现有执行

1. 新增 Turn Admission 数据结构；
2. 在 `message_received` 生成并绑定决定；
3. 接入 Query Pending 和 Query Result Reference 上下文；
4. 旧门禁继续执行，但同时记录新旧决定差异；
5. 使用 shadow 模式验证，不立即放开执行。

退出条件：真实回放中，新决定能识别 Query 追问，其他行为不变。

### 阶段 2：Query 首先切换

1. Query Tool 门禁改为消费 Turn Admission Decision；
2. Result Reference 解析提前到语义准入之后、执行门禁之前；
3. 保留 QueryDecisionPolicy 二次领域校验；
4. 保留 QueryTurnCoordinator 状态机和 exactly-once；
5. 删除 `authorizeContextualTimeValuesFollowUp` 等 Query 特殊旁路。

退出条件：业务排行、页面排行、pageViews、应用名称澄清和时间追问全部通过真实生命周期测试。

### 阶段 3：迁移 Alert 和 Packet

1. 将告警追问和告警引用接入统一准入；
2. 将告警数据包候选和确认接入；
3. 将 Packet 预览、下载确认和继续分析接入；
4. 删除公共门禁内相应语义特判；
5. 所有下载类操作继续保持正式确认要求。

退出条件：告警与数据包全链路无错误跨 Skill 调用。

### 阶段 4：迁移 Report、Inspection 和 Summary

1. 报告导出只消费明确报告来源；
2. “导出上面结果”通过来源引用解析；
3. 巡检和综述报告链保持自身执行顺序；
4. 删除通用门禁中的报告语义分支。

退出条件：报告来源无歧义，附件交付保持幂等。

### 阶段 5：收窄公共门禁和清理旧状态

1. 公共门禁只保留身份、安全、Tool 一致性和重放控制；
2. 清理不再使用的 continuation 正则；
3. 清理按 prompt 或 scope 获取“最新结果”的旧方法；
4. 评估 `ConversationOperationState` 中可删除或拆分的 Map；
5. 更新所有设计和运行文档。

退出条件：公共门禁不再决定具体业务语义。

## 19. 自动化测试矩阵

### 19.1 通用准入测试

- 完整 NAPM 问题选择正确 Tool；
- 普通聊天保持 `MODEL_OWNED`；
- `/new` 清理上下文且不调用 Tool；
- 普通文本 `new` 不执行会话重置；
- “确认”仅恢复正式 pending；
- 无 pending 的“确认”不执行任何 Tool；
- `第一个/第一名/第二个/这个/它/刚才那个`产生结构化选择；
- 结果过期、跨 scope 和类型不匹配均零执行。

### 19.2 Query 测试

- `WebApplication` TopN 后“看第一个的详情”进入 PageFamily TopN；
- PageFamily TopN 后同样问法进入 `pageViews`；
- “详细看第一个的前 20 条”设置 `maxLimit=20`；
- 没有上一排行时生成正式澄清；
- 应用流量、总流量和多 group 校验不回归；
- Query Skill、NapmClient 和南向调用次数准确；
- 执行中重放不产生第二次请求；
- 终态结果 exactly-once。

### 19.3 Alert 测试

- 告警列表后“看第一个详情”；
- 明确 eventId 详情；
- 告警数据包候选选择；
- 非告警结果不能被当成告警引用；
- 跨 scope 引用失败。

### 19.4 Packet 测试

- 预览后“下载第一个”；
- 没有正式确认时不下载；
- “确认”恢复正确下载目标；
- 同一确认重复发送只下载一次；
- Query 页面访问实例到 Packet 的引用需要明确对象类型。

### 19.5 Report 测试

- Query 结果后“导出上面结果”；
- Alert、Inspection、Summary 和 Fault 结果分别能正确导出；
- 多个候选来源时澄清；
- 过期来源失败；
- 附件只发送一次。

### 19.6 并发和生命周期测试

- 同一 conversation 两个重叠 run 不串 turn；
- Tool 和输出 Hook 始终使用当前 run 绑定；
- 不同会话不共享 pending 或 artifact；
- 同群不同用户不互相引用；
- Gateway 重启后的过期上下文安全失败；
- 模型调用错误 Tool 时不改变原 route。

## 20. 现场验收用例

### 用例 A：Query 三轮下钻

```text
最近一小时哪些业务页面访问量最高？
看第一个的详情
详细看第一个页面的前20条
```

预期：

```text
WebApplication TopN
  -> PageFamily TopN
  -> pageViews(maxLimit=20)
```

### 用例 B：无上下文选择

```text
/new
看第一个的详情
```

预期：询问用户要查看哪一份排行，不调用任何南向接口。

### 用例 C：正式澄清

```text
最近 7 天应用流量趋势如何？
HTTP
```

预期：第一轮询问应用名；第二轮恢复 `DefinedApp.argument=HTTP` 并执行一次。

### 用例 D：告警追问

```text
最近有哪些严重告警？
看第一个的详情
```

预期：进入 Alert，不得进入 Query 页面下钻。

### 用例 E：报告导出

```text
最近一小时业务访问量排行
把上面的结果导出 Word
```

预期：使用明确 Query 结果来源进入 Report，不重新查询，不选择其他 Skill 的最新结果。

### 用例 F：数据包确认

```text
预览该告警的数据包
下载第一个
确认
```

预期：确认只绑定该候选和当前 scope；实际下载一次。

## 21. 风险与控制措施

### 风险 1：公共准入修改影响所有 Skill

控制：先 shadow 对比，不立即替换旧门禁；按 Query、Alert/Packet、Report 顺序迁移。

### 风险 2：新旧状态同时存在造成双权威

控制：每个阶段明确唯一权威来源；新决定只读旧状态，不能同时写两套终态。

### 风险 3：短句本身存在真实歧义

控制：结合来源类型仍无法唯一判断时正式澄清，不靠模型猜测。

### 风险 4：群聊不同用户串结果

控制：确认 scope 是否包含发送者身份；引用必须校验 source scope 和 owner。

### 风险 5：Gateway 重启导致引用丢失

控制：返回上下文已过期并要求重查；第一阶段不回退到聊天文本猜测。

### 风险 6：公共门禁收窄后出现工具旁路

控制：身份、expectedTool、route、危险工具和 Tool/Skill 内部校验全部保留；只移除业务语义猜测。

## 22. 回滚方案

每个迁移阶段必须可独立关闭：

1. 新准入判断通过配置保持 shadow；
2. 每个 Skill 单独切换是否消费新决定；
3. 出现问题时只回退对应 Skill 的准入适配，不回退 QueryTurnCoordinator 等已验证状态机；
4. 回滚不恢复不安全的 scope-latest turnId 读取；
5. 回滚后保留审计差异，便于复现。

## 23. 工程质量门禁

每个实施阶段至少运行：

```text
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

还必须单独检查：

- 真实 Plugin 生命周期测试；
- Query Skill、NapmClient 和南向调用计数；
- 7 个生产 Tool 的 direct execute 契约；
- 重叠 run；
- exactly-once；
- `/new` 清理；
- 审计日志脱敏；
- 发布包是否包含新模块。

## 24. 完成标准

满足以下条件后，才能认为整体问题解决：

1. “看第一个的详情”不再依赖特定固定句式；
2. 相同短句能根据 Query、Alert 或 Packet 的权威来源选择正确 Skill；
3. 公共门禁不再解析具体 NAPM 业务语义；
4. 没有权威上下文时确定性澄清且零南向调用；
5. “确认”只恢复正式 pending；
6. 所有 Tool 使用当前 run-bound turn；
7. 错误 Tool、伪造引用、跨 scope 和过期引用全部 fail-closed；
8. 成功、空数据、澄清和失败均只交付一次；
9. 现有 Query、Alert、Packet、Report、Inspection、Summary 和 Fault 主流程没有回归；
10. 完整自动化测试和现场验收通过。

## 25. 最终建议

采用“统一准入、领域分治、门禁收窄”的方案：

```text
OpenClaw 管聊天会话和 Run
  -> Plugin 接待层结合权威上下文决定本轮 route 和 Tool
  -> 各 Skill 的领域协调器管理自己的业务状态
  -> 公共门禁只做安全和执行一致性检查
  -> Skill 执行后由各自权威流程交付结果
```

第一步应从本次真实问题建立回放测试开始，再引入通用 Turn Admission Decision。不得先在公共门禁中增加“第一个/详情”的临时正则，也不得一次性把全部 Skill 状态迁入新的全局协调器。

## 26. 原始方案边界

本文最初只形成设计和实施计划；后续实际落地情况以第 27 节为准。整个过程始终遵守以下边界：

- 不修改版本号；
- 不制作发布包；
- 不部署或重启服务；
- 不连接或修改远端服务器。

## 27. 2026-09-05 实施记录

### 27.1 已实施的公共层

- 新增 `ReferenceSelectionParser`，只识别序号、详情动作、请求条数和时间变更，不选择 Skill。
- 新增 `TurnAdmissionCoordinator`，在 `message_received` 生成不可变、run-bound 的 route、action、`expectedTool`、来源 artifact 和 reasonCode。
- 新增 `TurnIntentResolver`，只消费既有 Alert、Packet、Report、Fault 和 Query workflow 分类信号，输出单 Tool 或领域编排；它不读取原始 prompt、不新增一套业务正则。故障诊断获得明确 `expectedTool`，Summary/Inspection 因为是“来源 Tool + export”的多阶段链而继续标记为领域编排。
- `before_tool_call` 优先校验准入澄清、`expectedTool` 和可信轮次身份；错误 Tool 不会进入领域解析或南向调用。
- 新增准入、权威 artifact 保存/解析/失败及门禁阻断审计事件，日志只保存最小摘要。

### 27.2 Query 已切换的能力

- 真实三轮链路的第二、三轮只需传原始 prompt；Plugin 从权威结果构建 `WebApplication -> PageFamily` 和 `PageFamily -> pageViews` 续查 Draft。
- “看第一个的详情”已纳入生产原文回放，不再依赖 `WorkflowClassifierService` 对这个短句单独命中。
- `timeValues` 的“那最近 7 天的呢”不再使用旧的 model-owned 特殊放行。准入时冻结来源 turn，Tool 执行时按 `conversationKey + sourceTurnId` 取原查询上下文，重叠 run 不会改读更新的 Query。
- 排行序号追问也在 `message_received` 冻结当时选中的 `resultSetId/sourceTurnId`。新增生命周期回归覆盖：追问消息到达后，即使同 scope 又完成一份更新排行，原追问仍解析旧的冻结第一名，不读取新的 scope-latest 结果。
- 无上下文、跨 scope、过期、序号越界或参数修改超出准入范围时都在 Query Skill、`NapmClient` 和南向接口之前停止。

### 27.3 Query execute 准入加固

- `before_tool_call` 在 Result Reference 解析、Query Decision 和参数规范化完成后，才把 Turn Admission Decision 与最终参数稳定摘要绑定到可信 `traceId`。
- `napm-skill-query.execute()` 必须重新校验该准入授权。只有 trace、scope、turn、可信 toolName、Query route、Decision 和参数摘要同时一致才可进入执行。
- 同一 trace 下替换对象、指标、时间、Query Draft 或结果引用会返回 `QUERY_TOOL_PARAMETERS_MISMATCH`；缺少准入授权会返回 `TURN_ADMISSION_AUTHORIZATION_REQUIRED`。两类失败的 Query Skill、`NapmClient` 和南向调用均为 0。
- 参数摘要递归按对象键排序，避免 JSON 键顺序变化产生无意义的不一致；数组顺序保留，因为 groups/path 本身有序。
- 已处于 `EXECUTING` 或 `TERMINAL` 的同一授权重放仍优先返回执行中/既有权威结果，保持 exactly-once，不因重放参数损坏产生第二次调用。

### 27.4 跨 Skill 已实施的保护

- Alert 列表的“看第 N 个的详情”由 Alert Context Resolver 从权威事件投影构建 `napm-alert-query` detail 参数，不进入 Query。
- 如果最近成功结果来自 Packet、Report、Inspection、Summary 或 Fault，但该领域尚未对通用序号下钻暴露安全续操作，Context Boundary 会要求澄清。它不会回退选择更早的 Query 第一名。
- Packet 下载确认、Report 来源、Inspection/Summary/Fault 阶段结果仍由现有专用状态与门禁管理；本阶段没有把它们迁入一个全局大状态机。

### 27.5 回滚点

实施前已创建备份分支 `codex/backup-napm-turn-admission-prechange-20260904-2058`，对应 HEAD `a5dd3fb48be7ae3455840faaa17f75b0bf525556`；同时保留了包含未提交文档的完整工作树快照。

### 27.6 验证结果与当前边界

- `npm test -- --runInBand`：115 个测试套件、1034 项测试全部通过；覆盖 Query、Alert、Packet、Report、Inspection、Summary、Fault 等既有流程及新增准入生命周期、重叠 run、错误 Tool、参数篡改和无上下文零执行回归。
- `npm run lint`、`npm run verify:runtime-contract`、`git diff --check` 和新增运行时文件语法检查全部通过。
- 当前不是“所有 Skill 的序号续操作均已迁移完成”。Query 已完成本阶段迁移，Alert 完成事件序号详情切片；Packet、Report、Inspection、Summary、Fault 继续使用现有领域状态。对于这些尚未迁移的结果，公共层只做保守澄清，禁止错误回退到更早的 Query 排行。
- 当前公共解析器也不是完整自然语言指代系统；`这个/它/确认/取消/导出/下载` 的通用化仍属于阶段 3–5，必须随领域 pending、风险确认和 artifact 契约一起迁移，不能只加关键词。
- 本阶段没有修改版本号、制作发布包、部署、连接或修改服务器，也没有重启服务。
