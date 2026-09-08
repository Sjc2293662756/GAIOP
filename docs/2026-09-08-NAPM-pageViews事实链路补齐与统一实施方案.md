# NAPM pageViews 事实链路补齐与统一实施方案

> 日期：2026-09-08
>
> 状态：详细设计已落档，本文所列整改尚未实施；不能据此宣称已修复或部署。
>
> 本地核对基线：`codex/napm-turn-decision-phase1`，`22ec579ef8e20c8896888372a823896a3f5caa49`。
>
> 目标：补齐页面身份、访问实例事实、错误与证据完整性，逐步统一 Query、Fault、Packet 的数据访问。
>
> 本文更新 2026-09-03 页面访问详情方案的现状判断；历史文档保留当时实施记录。

## 1. 先用业务语言说明要解决什么

用户查询应能连续完成：

1. “哪些业务页面访问量最高？”——得到业务排行。
2. “看第一个详情”——得到该业务下的页面排行。
3. “查看第一个都访问了哪些？”——得到所选页面的逐次访问记录。

第三步的数据还可以供故障诊断分析状态码、服务器耗时、网络耗时，供数据包分析定位某次访问。但查询得到事实，不等于已经完成根因判断或数据包下载。

当前已能执行 `pageViews`，这次不是从零新增接口。需要做到：合法追问不被误拦截、接口返回的重要字段不丢失、错误不被当成数据、各 Skill 使用同一套事实获取规则。

实施分为三个交付目标：

| 目标 | 交付标准 | 优先级 |
| --- | --- | --- |
| 查询正确性 | 真实三轮话术可执行，错误响应不能变成访问记录，缺失字段不伪造为零 | P1，首先完成 |
| 身份与事实完整性 | 页面有明确身份及失败原因，标准记录保留完整字段、来源和数量限制 | P1/P2 |
| 跨 Skill 统一 | Fault、Packet 逐步复用 Query 内部服务，分析策略和报告结构保持兼容 | P2，依赖前两项 |

## 2. 证据范围与不能混淆的事实

### 2.1 本地代码与运行环境的关系

- 本文直接核对上述功能分支的运行时代码、测试和文档。
- 2026-09-08 前序只读排查记录的远端发布清单为 `1.1.0-rc.54`，提交 `36f1966b1410f84fabe741d1226fe31b28ff06e0`，来源分支 `codex/integrate-rc54`。
- 本次文档编写没有重新连接服务器；远端结论引用前序已读取的日志，不能作为将来时点的实时部署证明。
- 功能分支 package 中的版本字段不是远端活动版本。本任务不修改版本号，不生成发布包。
- 用户参考方案附带的是文字说明，未附三个原始 HAR。本地受版本管理的文件中也未找到它们对应的脱敏 fixture，不能把“与 HAR 一致”写成已验证事实。

### 2.2 第三轮失败的完整证据

以下日志时间为北京时间；前端展示时间与插件处理时间存在数秒差异，以事件关联为准。

| 时间 | 已观察事件 | 能证明什么 |
| --- | --- | --- |
| 2026-09-07 23:18:13 | `authoritative_artifact_stored`，`objectType=PageFamily`，`rowCount=10` | 第二轮已保存页面排行 |
| 23:22:58.710 | `turn_admission_decided`，`workflow=page_view_detail`，`AUTHORITATIVE_RESULT_FOLLOWUP`，序号 1 | 第三轮追问已正确识别并选择页面来源 |
| 23:23:05.323 | `authoritative_artifact_resolved`，`targetService=pageViews` | 页面引用已经成功解析 |
| 23:23:05.335 | 规范化请求包含 `pageFamilyId`、`maxLimit=20`、`start/end`、`resultReferenceValidated=true`、`resultReferenceObjectType=PageFamily` | 参数已经齐全；不是模型漏传引用或 ID |
| 23:23:05.336 | `REJECT_QUERY / VALIDATION_FAILURE / RESULT_REFERENCE_REQUIRED` | 最终语义策略误拦截 |
| 23:23:07、23:23:09 | 相同原因重复阻断 | 重试没有解决语义冲突 |
| 23:23:12 | 权威失败交付，后续重复交付被抑制 | 失败回包归当前轮交付，但原因文案不准确 |

本地把日志形状输入现有策略，得到：

```json
{
  "code": "RESULT_REFERENCE_REQUIRED",
  "details": {
    "expectedObjectType": "WebApplication",
    "actualObjectType": "PageFamily",
    "referenceValidated": true
  }
}
```

根因：`QueryDecisionPolicy` 再次脱离上下文分类原句，并把 `requiresResultReference` 的来源类型统一写死为 `WebApplication`。前面已经确定的页面详情工作流被后面的一套判断否决。这个缺陷应在代码中修复，不能靠要求用户背固定句式解决。

### 2.3 与前一天部署覆盖问题分开处理

2026-09-07 14:40 的局部覆盖曾导致旧插件入口遮蔽新实现。晚间第三轮日志已经出现新准入和权威结果事件，因此晚间错误有明确的策略逻辑根因。正式发布仍须验证实际入口与清单、文件哈希一致，但重新部署同一份有缺陷代码不能修复本问题。

## 3. 当前实际实现与复用基础

| 能力 | 当前状态 | 代码依据 |
| --- | --- | --- |
| Query 的 `pageViews/detail` 服务契约 | 已存在 | [SKILL.md](../skills/openclaw-napm-query/SKILL.md)、[resolution spec](../skills/openclaw-napm-query/config/napm-resolution-spec.v1.json) |
| 专用详情执行分支 | 已存在，使用 Query `NapmClient`，请求 `json=true` | [PageViewsExecutionKernel](../skills/openclaw-napm-query/services/PageViewsExecutionKernel.js) |
| 时间、ID、limit 校验 | 已存在，默认 20，本地上限 200 | [共享契约](../skills/shared/NapmPageViewsContract.js) |
| ID 提取与部分字段标准化 | 已共享，但字段和响应结构校验不完整 | 同上 |
| 业务/页面排行序号引用 | 已有 scope 隔离、冻结来源、30 分钟有效期 | [QueryTurnCoordinator](../plugin/QueryTurnCoordinator.js) |
| 续查 Draft 构造 | 已能由页面排行生成 `pageViews` | [QueryContextResolver](../plugin/context-resolvers/QueryContextResolver.js) |
| Fault 请求 | 仍经 `SummaryClient`，部分分析读原始字段 | [FaultDiagnosisSteps](../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisSteps.js) |
| Packet 请求 | 仍自行构造 URL 并执行 HTTP 请求 | [run_packet_analysis](../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js) |
| 详情展示 | 已有结构化结果和表格，但字段、数量完整性说明需补齐 | [Narration Contract](../skills/openclaw-napm-query/services/OpenClawNarrationContractService.js) |

当前三条数据访问路径：

```text
Query  -> PageViewsExecutionKernel -> Query NapmClient
Fault  -> FaultDiagnosisSteps     -> SummaryClient
Packet -> run_packet_analysis    -> 独立 HTTP 请求函数
```

注意：Fault CLI 实际加载 `services/FaultDiagnosisService.js`。Skill 根目录存在历史同名文件，不能把修改历史副本当作修复生产调用链；实施时先检查真实 import 关系。

## 4. 对用户参考方案的采纳与调整

| 参考建议 | 本项目决定 |
| --- | --- |
| Query Core 统一页面事实，Fault 保留分析策略 | 采纳；Query Core 在本文表示现有 Query Skill 内可复用的事实服务，不要求创建新顶层目录 |
| 从 Fault 私有能力开始新增 pageViews | 调整；保留已实现的 Query 内核，补齐并复用 |
| 页面排行必须再请求 XML 才能得到 ID | 调整；优先使用当前 JSON 结果已有的结构化 ID/groupPath；缺失且有设备能力证据时才补查 |
| `includeEntityIdentity` | 采纳为内部执行提示；不直接成为模型可声明的授权标志 |
| `resolved-query.v2`、`operation`、`pageFamilyRef` | 本期不引入公共替代契约；沿用 `service/queryModeKey/pageFamilyId/start/end/maxLimit` |
| `limit=null` 时不发送 maxLimit | 本期保留缺省 20；“省略参数”的设备行为确认后另行变更，不能直接解除本地保护 |
| 完整 PageViewRecord | 采纳字段覆盖、空值语义和单位来源；优先兼容现有扁平字段，不强制整体改成嵌套对象 |
| Plugin 不解析 NAPM 私有格式 | 采纳职责方向；协议解析移到领域服务，Plugin 仍必须保存和验证可信会话引用 |
| 完全不修改 Plugin | 调整为不重构公共门禁；允许必要的 Query 领域适配、可信意图传递和引用投影变更 |
| 只做 Turn Scope 缓存 | 采纳为身份补查缓存；保留既有跨轮次权威结果引用及其 30 分钟有效期 |
| 8 个生产 Tool | 本地基线是 7 个生产 Tool 加 2 个可选开发诊断 Tool，保持数量和路由不变 |
| HAR 驱动等价性验收 | 采纳；取得、脱敏、核对样例前，不宣称真实协议等价性已完成 |

## 5. 问题台账与验收责任

| 编号 | 问题/缺口 | 已确认影响 | 主要修复位置 | 验收用例 |
| --- | --- | --- | --- | --- |
| PV-01 | 追问来源类型写死 WebApplication | 合法第三轮零执行 | QueryDecisionPolicy、Query 领域适配 | T01–T05 |
| PV-02 | 三套客户端及事实读取 | 规则、错误与字段可能不一致 | PageViewsQueryService、Fault、Packet | T17–T20 |
| PV-03 | 缺少身份补齐和唯一性处理 | 缺 ID 就失败/跳过，命名定位不完整 | PageFamilyIdentityResolverService | T06–T09 |
| PV-04 | 标准记录丢 6 个字段 | 共享结果不能完整支持性能和终端分析 | NapmPageViewsContract、Normalizer | T10–T11 |
| PV-05 | 异常 JSON 被转成空白记录 | 错误可能误报成功或无数据 | 响应校验、执行内核 | T12–T14 |
| PV-06 | 缺失状态码计数默认 0 | 不知道被误当作没有 | Normalizer、Fault 消费适配 | T11、T18 |
| PV-07 | Fault 缺 ID 静默跳过 | 证据未取得但标志仍可能为有数据 | Fault 步骤/ExecutionOutcome 适配 | T09、T18 |
| PV-08 | 20 条与全集边界不清晰 | 抽样结果可能被用于全量结论 | 结果 metadata、叙述、Fault | T15–T16 |
| PV-09 | 缺真实协议和跨链测试 | 单测通过不代表现场闭环 | 脱敏 fixture、生命周期测试 | T01、T21–T23 |

## 6. 目标职责与边界

```text
用户查询 -> napm-skill-query -> 可信 Query Turn / 领域续查适配 ─┐
故障诊断 -> Fault Recipe -> 页面选择策略 ────────────────────┼-> Query 内部事实服务
数据包分析 -> 页面/访问选择策略 ──────────────────────────────┘       |
                                              身份解析 + pageViews + 标准化
                                                                   |
                                                            Query NapmClient
                                                                   |
                                                                 NAPM
```

职责约束：

- OpenClaw 负责用户意图与 Tool 选择；领域适配负责解释本领域的权威对象。
- Plugin 负责 run/turn、准入、来源冻结、可信 trace、参数密封和最终交付，不新增页面协议正则。
- Query 内部服务负责数据访问、身份解析、结构与字段标准化、设备错误映射；它不自行判断根因。
- Fault 继续决定重点页面、分析步骤和证据关联；Packet 继续决定访问选择、下载确认和下载操作。
- 既有对象本体和静态 groups tree 仍是路径依据，不新建另一份路径知识库。
- 本期不迁移 Summary/Inspection 的全部请求，不新增 Tool，不调整故障阈值或报告布局。
- 本期不新增“用户只回复任意业务名称”的完整对话管理，也不新增 pageViews 结果到 Packet 的通用跨 Skill 序号交接；这些是后续独立能力，不能顺手放宽现有门禁。

## 7. 可信工作流与引用校验设计

### 7.1 来源类型必须由工作流决定

| 已冻结来源 | 本轮工作流 | 执行服务 | 目标 | 必须校验的来源类型 |
| --- | --- | --- | --- | --- |
| 业务排行 | business_page_drilldown | topValues | PageFamily | WebApplication |
| 页面排行 | page_view_detail | pageViews | PageView（访问记录语义，不是 group） | PageFamily |

Query Decision 不再用一句脱离上下文的原始问句覆盖已确认工作流。原始问句仍可用于无上下文的新查询分类，但只能复用现有分类入口，不增加同义正则。

### 7.2 可信信息如何传递

1. 入站沿用当前 Adapter、Turn Admission、Query Context Resolver，取得已签发的准入与冻结来源。
2. Query 领域适配生成内部执行语义投影：来源 artifact/turn、来源对象类型、目标工作流、服务、目标类型。
3. Hook 从当前 run/message 绑定读取这份投影，连同最终规范化参数一并密封到可信上下文。
4. direct execute 从同一可信 trace 恢复投影；不得把模型传入的 `semanticConstraints`、`sourceReference` 或 `executionBinding` 当作授权。
5. Policy 验证工作流、来源类型、已解析身份和服务一致，然后决定执行或拒绝。

上述投影是拟新增/完善的内部参数，不是当前已经存在的公共 Tool 字段。实施时优先扩展现有决策入参，不再建立另一套会话状态。

### 7.3 必须保持的约束

- 错误 Tool、缺身份、跨 scope、来源过期/越界、trace 参数被替换，仍在 Skill 和南向调用前失败。
- 缺少来源时不能仅凭 `service=pageViews` 或验证布尔值放行。
- 合法独立详情请求需先由可信对象解析获得身份；内部 Fault/Packet 请求使用明确的调用上下文，不伪造用户 Query Turn。
- `EXECUTING` 重放和终态重放不得重新执行；一次修复预算、终态 write-once 保持现有约束。
- 技术校验失败提示应区分缺参数、来源类型冲突和引用失效，不再一概称“参数未构造完整”。
- 澄清仍使用当前专用迁移；执行开始后的正常澄清通过 `recordExecutionClarification()`，不能记为执行失败。

## 8. PageFamily 身份解析设计

### 8.1 标准身份

内部页面行拟增加以下投影，现有指标字段保持兼容：

```json
{
  "entity": {
    "type": "PageFamily",
    "argument": "https://example.invalid/order",
    "opaqueId": "1234567"
  },
  "identity": {
    "status": "resolved",
    "source": "structured_field"
  }
}
```

`opaqueId` 对上层只表示不可猜测的标识。NAPM Adapter 仍根据已验证接口契约检查数字 ID，不把排行序号、URL 或普通数字字段当作页面 ID。

### 8.2 解析顺序与歧义处理

1. 优先使用有明确语义的 `pageFamilyId` 等设备字段；泛用 `id` 只有在已知 PageFamily 响应结构中才能作为兼容来源。
2. 无结构化 ID 时，在 Adapter 内按已验证 `groupPath` 格式解析。明确的结构化 ID 与路径 ID 冲突时失败，不任意取一个。
3. 仍缺 ID 且本次需要后续访问详情时，在能力已验证的前提下补查同设备、同业务、同时间、同页面范围的身份数据。
4. 返回 CSV/XML 等格式时，由 Adapter 完成解析与匹配；不能按行号拼接两个响应。匹配依据必须包含业务/父路径与完整页面标识，同名或多个候选不得自动选择第一项。
5. URL 不做未经证明的大小写折叠、查询参数删除或前缀包含匹配，避免合并不同页面。
6. 名称查询先要求业务范围；不能唯一确认时返回结构化候选并由上层澄清，不能跨业务猜测。

### 8.3 身份补齐与请求预算

- 拟采用内部 `executionHints.includeEntityIdentity` 表达下游需要身份；它不授予额外查询范围。
- 用于对话下钻的 PageFamily TopN，应由 Query 领域策略自动要求身份投影，不能依赖模型记得填写 hint。
- 已有 ID 时补查次数为 0；普通非详情用途的排行不因引入此能力额外请求。
- 首期同一个排行结果集最多一次补查，优先批量解析；找不到精确行就明确失败，不逐页无限尝试。
- 补查复用已经授权的范围和静态路径校验，不能以内部服务名绕过普通多 group 规则。
- 每次身份补查单独记录原因和调用次数。零 `pageViews` 调用不等于全过程零南向：需要明确区分 discovery/enrichment/pageViews 三类计数。
- XML 能力没有可靠样例或设备证据时保持关闭；不能以猜测的请求参数实现 fallback。

### 8.4 排行引用不能丢行或换序号

当前 Coordinator 只保存可解析 ID 的页面行，缺 ID 的行会被过滤。拟改为保留原始排序后的每一行及原 ordinal，附身份可用性和失败原因。这样用户选到缺 ID 行时应得到“页面身份未取得”，而不是“排名不存在”，更不能切换到下一个可解析页面。

Coordinator 优先消费标准投影；旧 groupPath 的兼容解析通过注入的领域服务过渡，最终协议细节不留在通用状态管理器。

## 9. pageViews 查询与结果契约

### 9.1 保留现有公共查询形状

```json
{
  "service": "pageViews",
  "queryModeKey": "detail",
  "pageFamilyId": "1234567",
  "maxLimit": 20,
  "start": 1788710400,
  "end": 1788792540,
  "format": "json"
}
```

自然语言序号追问仍传选择意图，由可信上下文补入 ID 和时间。`groups/metrics/metric/topMetric/granularity` 不得进入详情请求，`PageFamilyDetail` 不是合法 group。来源元数据可保留于内部查询上下文，但不发送给 NAPM。

南向只序列化认证配置与 `type/start/end/pageFamilyId/maxLimit/json` 等已确认字段；认证值不得进入结果、日志样例或 fixture。

### 9.2 limit 与时间

- 继续要求分钟对齐的根级 `start/end`；上下文续查继承冻结来源时间，用户明确改时间时使用现有时间契约。
- 本期缺省、`undefined/null` 的含义维持默认 20；字符串 `"undefined"`、非数、非整数、非正数必须拒绝。
- 布尔值、空白数值、无限值等类型需补边界测试，不能利用 JavaScript 隐式转换通过。
- 保留 200 作为本地保护上限，并在文档/metadata 标明不是设备官方限制。
- 暂不实现无上限请求或自动翻页。若上游返回超过请求条数，明确记录并限制展示/消费数量，不把超出部分静默计入结论。
- 未验证接口排序时，序号仅表示本次返回顺序，不表述为最新、最慢或最异常的前 N 条。

### 9.3 内部结果契约

沿用当前 `ok/service/data/error/metadata` 主形状，拟增加版本化的详情元信息，字段名可在实施时按现有规范微调：

```json
{
  "ok": true,
  "service": "pageViews",
  "data": [],
  "error": null,
  "metadata": {
    "detailSchemaVersion": "page_view_record.v1",
    "pageFamilyId": "1234567",
    "requestedLimit": 20,
    "returnedCount": 0,
    "totalCount": null,
    "completeness": "unknown",
    "limitReached": false,
    "ordering": "upstream_unspecified",
    "fieldUnits": {},
    "source": {
      "service": "pageViews",
      "start": 1788710400,
      "end": 1788792540
    }
  }
}
```

- 只有设备给出可信总数/完整标志时才能声明完整；少于 limit 也不能自动推断为全集。
- 达到 limit 表示可能受限，不等价于一定存在更多记录。
- 单位未知就保留原始数值和未知标记，不根据名字或数量级猜测秒、毫秒、字节等。
- 内部来源还应可关联设备配置标识、trace、sourceTurn/resultSet；对外答复使用业务/页面标签和时间，避免默认展示内部 ID。

## 10. 标准 PageViewRecord 字段

先保留当前扁平输出，增补缺失字段，避免所有消费者同时改成新的嵌套格式。

| 原始字段 | 标准字段 | 本地现状 | 拟处理 |
| --- | --- | --- | --- |
| StartTime | startTime | 已有 | 保留原始精度；时区不明确时不擅自转换 |
| Page | page | 已有 | 保留完整页面值 |
| User | user | 缺失 | 新增，可空 |
| OriginatingIp / ClientIp / ServerIp | originatingIp / clientIp / serverIp | 已有 | 不无依据混同三个角色 |
| HttpStatus | httpStatus | 已有 | 合法数值或 null；未知不转零 |
| Http100S | http100S | 缺失 | 新增 |
| Http200S | http200S | 已有但缺省零 | 缺失改为 null |
| Http300S | http300S | 缺失 | 新增 |
| Http400S / Http500S | http400S / http500S | 已有但缺省零 | 缺失改为 null |
| HttpResponses | httpResponses | 已有 | 校验数值，不臆造总和 |
| PageTime | pageTime | 已有 | 保留数值与单位来源 |
| ServBusyTime / NetBusyTime | servBusyTime / netBusyTime | 缺失 | 新增，迁移性能分析前必须具备 |
| PageTraffic / RequestTraffic | pageTraffic / requestTraffic | 已有 | 不预设单位 |
| Referrer | referrer | 缺失 | 新增，可空 |
| UserAgent | userAgent | 已有 | 原样保留并限制显示长度 |
| pageFamilyDetailId | pageFamilyDetailId | 已有 | 只在确有标识时用于下游；无标识记录仍可展示，但不可下载 |
| 派生序号/引用 | index / rowRef / instanceId | 已有 | 保留会话内顺序和兼容形式，不作为设备主键 |

数值字段缺失为 null，真实 0 保持 0；非法数值返回明确解析错误，不把任意字符串当作标准数字。原始可选字段缺失可接受，缺少足以识别访问记录的全部核心字段则为非法行。具体最小有效行规则须由真实响应样例锁定，不能要求所有字段必填。

HTTP 主状态与子响应计数是不同事实。不能仅因为主状态是 200 就丢弃具有 4xx/5xx 子响应证据的记录。是否筛选异常仍由 Fault Recipe 决定，但字段完整性必须先保留。

## 11. 响应验证和错误传播

### 11.1 校验顺序

1. 检查 HTTP 成功与网络错误，保留稳定错误码、状态及可脱敏原因。
2. 按已确认协议解析 JSON；如后续支持 CSV/XML，使用对应 Adapter，不在 Fault/Packet 各写解析器。
3. 检查业务错误 envelope，`ok=false/error` 不得作为记录。
4. 验证外层容器和行结构，区分合法空数组与非法 null/布尔值/空对象。
5. 标准化字段、数值和空值，形成有来源的事实结果。

本地已复现的反例必须成为回归用例：`{ok:false,error:{...}}`、`{rows:null}`、`{rows:[null]}` 当前会生成空白记录；`false` 当前会变成零行。首期采用严格模式：畸形结果失败，不静默过滤后冒充完整成功。确需接受部分坏行时，应另有经审查的 partial 语义。

### 11.2 错误分类与现有状态机映射

下列为领域错误分类，具体 code 沿用已有可用错误码；新增码需列入契约和测试，不新增平行 Query Turn 状态机。

| 情况 | 事实服务分类 | Query Turn 对外状态/行为 |
| --- | --- | --- |
| 已执行 PageFamily/访问查询，合法零行 | NO_DATA | NO_DATA |
| 明确名称不存在 | NOT_FOUND | 明确说明对象未找到；不执行 pageViews |
| 多个同名候选 | AMBIGUOUS | 正常 CLARIFICATION；不执行 pageViews |
| 缺/非法 ID、limit、时间 | INVALID | VALIDATION_FAILURE，零 pageViews |
| 已选页面无法取得可信 ID | IDENTITY_RESOLUTION_FAILED | 执行前校验失败；若补查已开始则执行失败，并保留阶段原因 |
| 网络、超时、HTTP、业务错误 | UPSTREAM_ERROR | EXECUTION_FAILURE，不展示为 NO_DATA |
| 非法 JSON/CSV/XML/行结构 | RESPONSE_PARSE_ERROR | EXECUTION_FAILURE，不生成空白记录 |
| 无可信 run/route/Tool/参数授权 | 既有契约错误 | 按当前准入与 Query Turn 规则终止，零 Skill/Client/南向 |

`recordResult/recordFailure` 仍仅允许从 EXECUTING 迁移。身份补查纳入一个明确的执行 attempt；前置失败、补查失败和 pageViews 失败要可区分。修复终态后重放不得产生新请求。

Fault 缺身份/请求失败必须通过现有 `ExecutionOutcome` 适配成失败或 partial，保留候选页数量、成功页数量和失败原因；不能继续把“跳过所有页”标为有访问数据。保留阈值和算法，对缺失证据只降低可作出的结论，不推断正常。

## 12. 缓存与结果来源

- 身份补查缓存限定于本次执行上下文，键至少包含设备配置标识、业务/父路径、完整页面标识、时间范围与必要的权限范围。
- Query、Fault、Packet 使用各自 run/执行上下文；不能共享无 scope 的全局最新页面 ID。
- 同一轮并发请求可复用同一个未完成 Promise，失败也应正确清除/记录，不能重复发起补查。
- 跨轮次排行引用保留现有 30 分钟 TTL；来源在消息到达时冻结，后续新结果不得更换它。
- `/new`、会话清理、来源过期等沿用原有语义；进程重启后没有持久权威证据就澄清，不从模型历史文本重建 ID。
- 不引入长期全局页面 ID 缓存。设备重建模/配置变化后的 ID 生命周期尚未验证。

## 13. 跨 Skill 接入及兼容策略

### 13.1 统一内部入口

拟新增 `PageViewsQueryService`：接受完整详情查询与内部请求上下文，提供校验、一次请求、响应解析和标准化。现有 `PageViewsExecutionKernel` 作为 Query 网关适配器委托此服务。Fault/Packet 调用内部服务，不伪造 OpenClaw Tool trace，也不从内部服务再次调用面向用户的 Tool。

内部请求上下文应明确调用者、设备配置标识、run/trace、来源页面身份及时间；凭据通过配置/Client 注入，不能混入业务参数。服务不管理会话，不自行选择对象或扩大时间。

### 13.2 Fault 迁移

1. 保留业务页和慢页面选择策略、页数预算、分析顺序。
2. 页面发现结果交给共享身份服务；必要的 PageFamily TopN 迁移到现有 Query metric 内核适配，不迁移全部 Fault 指标请求。
3. `_bsStep3`、`_perfStep3` 改为通过内部事实服务获取访问记录。
4. 状态码判断、性能分解、`_extractStep3Data` 和报告数据提取统一消费标准记录，不再各自处理 PascalCase/camelCase 或响应 envelope。
5. 兼容适配保留 reportData 的结构。由“误当无数据”改为明确错误等预期修正，必须列出差异，不能要求保留错误结论来实现字面等价。
6. 本期不新增按每条 StartTime 自动 fan-out 查询 RTT/Loss 的根因流程；如要落地，应作为后续 Recipe 能力单列预算、关联窗口和验收。

### 13.3 Packet 迁移

先替换页面发现/身份与 pageViews 事实读取，保留现有访问选择、预览、确认和 DownServlet 下载流程。服务返回 `pageFamilyDetailId` 不等于已经取得用户下载确认。没有 ID 时返回不可下载原因，不选择其他访问代替。

### 13.4 开关与回退

拟增加独立的内部配置项，例如 `NAPM_FAULT_PAGE_VIEWS_BACKEND=legacy|query`、`NAPM_PACKET_PAGE_VIEWS_BACKEND=legacy|query`；名称在实施时与配置规范统一。迁移初期缺省 legacy，非法值报配置错误，不能静默切换。

- Query 的正确性修复不受迁移开关控制；不能通过开关绕过引用、类型或失败校验。
- 切换使用统一发布流程。单个 run 固定读取一次开关，执行中不能混用两套数据源。
- 本期 shadow 指离线双实现处理同一份脱敏响应；默认不在远端同时发送两次查询。
- new 路径失败时不得自动重试 legacy，避免重复查询和掩盖错误。
- 回退时保留错误校验和完整字段修复。legacy 最多保留一个完整验收周期，满足退役标准后再删除，不永久维护三条链。

## 14. 计划修改文件与新增模块

文件名是实施建议；职责相同的现有模块应优先复用，不为凑目录重复建设。

| 文件/范围 | 计划变化 | 阶段 |
| --- | --- | --- |
| QueryDecisionPolicy.js | 消费可信上下文工作流，按来源/目标矩阵校验 | A |
| plugin/context-resolvers/QueryContextResolver.js、remote.js 的 Query 适配 | 传递并密封可信语义，保持 Hook/direct 一致 | A |
| plugin/QueryTurnCoordinator.js | 标准身份投影、保留缺 ID 行的原序号；不改变状态机规则 | C |
| skills/shared/NapmPageViewsContract.js | 完整字段、严格空值与响应校验、兼容导出 | B |
| services/PageViewsExecutionKernel.js、RequirementParserService.js | 委托内部服务，保留请求审计、错误阶段 | B/D |
| 拟新增 services/PageViewResponseNormalizer.js | 完整记录验证/标准化；共享契约可保留兼容 facade | B |
| 拟新增 services/PageViewsQueryService.js | 内部统一详情事实入口和 Client 注入 | B/D |
| 拟新增 services/PageFamilyIdentityResolverService.js | 身份解析、唯一匹配、受预算约束的补齐 | C |
| 拟新增/复用 PageFamily 响应适配模块 | 设备私有 groupPath/JSON 解析；XML/CSV 仅在证据充分后启用 | C |
| MetricExecutionKernel / TopValuesNormalizer | 身份 enrichment 与排序后投影，普通查询无额外调用 | C |
| FaultDiagnosisSteps / FaultDiagnosisService | 事实服务接入、完整性传播、报告兼容 | D |
| run_packet_analysis.js 的页面事实段 | 复用服务，下载动作保持原流程 | E |
| OpenClawNarrationContractService.js、run_napm_query.js | 完整字段、未知单位、有限记录说明、准确失败文案 | B/D |
| runtime contract、安装/暂存依赖验证 | 登记新增模块及依赖，验证完整包内可加载 | 各代码阶段 |
| AGENTS/SOUL/CLAUDE/CONTEXT/PROJECT/TOOLS、Query/Fault/Packet SKILL 文档 | 随实现更新真实职责；不能提前写已实施 | 各代码阶段 |

跨 Skill 导入必须通过明确模块接口和安装后的 Skill 根路径；防止循环依赖和读取历史副本。共享模块优先保持纯函数，不能在导入时发请求或初始化带凭据的客户端。

## 15. 分阶段实施与退出条件

| 阶段 | 工作内容 | 必须满足的退出条件 |
| --- | --- | --- |
| A：恢复查询闭环 | 真实三轮失败测试；可信工作流/来源矩阵；准确原因码 | 原句通过，错误引用零 Skill/Client/南向，重放只执行一次 |
| B：完整事实与错误 | 完整字段、严格响应验证、limit/completeness、内部服务基础 | 6 个字段不丢失，错误对象不变记录，合法零行仍 NO_DATA |
| C：身份规范化 | 现有 JSON 身份、投影、缺 ID/歧义；有证据时再启用补查 | 原 ordinal 不变，有 ID 零补查，缺失/冲突无错误 pageViews 调用 |
| D：Fault 接入 | 离线等价性、有限记录说明、失败/partial、迁移开关 | 两种 B/S 场景不丢字段，报告结构兼容，new 只走 Query Client |
| E：Packet 接入 | 事实获取复用，预览/选择/确认/下载回归 | 不额外下载、不改变确认边界，不重复 pageViews |
| F：整合与交付 | 运行门禁、完整发布依赖、隔离验收、退役条件 | 所有已实施阶段测试通过，未完成能力和证据缺口明确记录 |

建议按 A、B、C、D、E 分别提交可审查的小提交；每个提交包含相应测试和记录。阶段完成不等于已部署。缺 HAR 不阻止 A/B 的确定性修复，但阻止宣布 CSV/XML 兼容和新旧真实设备等价性验收通过。

## 16. 回归测试矩阵

所有本地执行测试 mock 南向，并显式统计 Query Skill、Query Client、SummaryClient、独立 HTTP 及 pageViews 请求次数，不能只断言返回文案。

| ID | 场景 | 核心断言 |
| --- | --- | --- |
| T01 | 三轮原句：业务排行→看第一个详情→查看第一个都访问了哪些 | 不手工预填第三轮 ID；按真实结果解析；两次 topValues、一次 pageViews；时间继承 |
| T02 | 同语义不同问法、前 20/前 50 条 | 同一冻结页面，limit 正确；不会再按 WebApplication 拒绝 |
| T03 | 缺 trace/错误 Tool/route/参数替换/伪造验证标志 | Hook/direct 都阻断，Skill/Client/南向全部为 0 |
| T04 | 引用过期/跨 scope/越界/来源被新排行覆盖 | 合理失败或使用冻结来源，不读会话最新值 |
| T05 | 同会话重叠 run、执行中重放、终态重放、一次修复预算 | 不回退状态、不再次查询、exactly-once 交付 |
| T06 | JSON 自带 ID/groupPath | 身份正确，无 XML 额外请求 |
| T07 | 身份补查和多个响应行顺序不同 | 精确按身份范围匹配，不按 ordinal 合并；最多一次补查 |
| T08 | 同 URL 跨业务、同名候选、结构化 ID 与路径冲突 | 明确 AMBIGUOUS/IDENTITY_RESOLUTION_FAILED，pageViews=0 |
| T09 | 首行/中间行/全部行缺 ID | 序号不变、失败原因准确，Fault 不伪造 hasPageViewData |
| T10 | 完整字段，PascalCase/camelCase，同记录重复标准化 | 新增 6 字段保留，既有字段兼容，ID 不变 |
| T11 | null/真实零/空白/非法数值/无单位 | unknown 不等于零，单位不猜，非法数字不成为有效事实 |
| T12 | HTTP 超时/非 2xx/200 内业务错误/HTML | 执行失败，保留原因，不变成 NO_DATA 或空白访问 |
| T13 | rows:null、rows:[null]、false、空错误对象、畸形/循环包装 | 拒绝结构；合法空包装须由已确认协议明确区分 |
| T14 | 合法空数组、支持的 JSON envelope | Query NO_DATA；Fault 可识别空结果与失败的差异 |
| T15 | limit 缺省、null、字符串 undefined、0、负数、小数、布尔、超过上限 | 请求不出现 undefined；合法值一次请求，非法值零请求 |
| T16 | 达到 limit、上游超量、未知排序/总数 | 有限结果说明准确，不从样本推断全集 |
| T17 | Fault legacy/new 使用同一脱敏响应 | new 只走 Query Client；不改变页面选择、阈值、报告结构 |
| T18 | Fault 性能/状态分析及报告提取 | ServBusy/NetBusy 不丢；错误、缺失字段、主 200 子 5xx 的差异有记录 |
| T19 | Packet 预览/显式访问选择/缺 detailId/确认下载 | 不自动替换访问或提前下载，pageViews 只请求一次 |
| T20 | 开关 legacy/query/非法值、执行中配置变化、新路径失败 | 每轮路径固定；不自动 fallback 重复南向 |
| T21 | 页面错误 HAR 脱敏 fixture | 身份、状态主码/类别计数与事实一致 |
| T22 | 性能 HAR 脱敏 fixture | 完整耗时字段、空值及单位来源一致 |
| T23 | 终端 HAR 脱敏 fixture | User/OriginatingIp/ClientIp/UserAgent/Referrer 保留 |
| T24 | 暂存安装树、真实 index.mjs 加载、依赖清单 | 新服务可从完整包加载，活动入口与清单哈希一致 |
| T25 | Alert/Report/Inspection/Summary/Fault/Packet 原有生命周期 | Tool 路由、上下文边界、报告和确认交付无非预期变化 |

### 16.1 HAR fixture 要求

取得参考中的页面错误、性能、终端三个 HAR 后，只提取必要请求/响应。去除 Cookie、Authorization、凭据和 token；业务名、地址、用户信息脱敏，关联 ID 用一致映射替换，固定时间并保留行关联。不要把完整 HAR 原样提交。

拟放置 `test/fixtures/pageviews/`，包括 JSON、确实使用的 CSV/XML、必要请求参数和字段元信息。每份 fixture 标注真实采集来源类别与脱敏方式；合成样例不能冒充 HAR。

### 16.2 每个代码阶段的门禁

```bash
npm test -- --runInBand
npm run lint
npm run verify:runtime-contract
git diff --check
```

新增模块不一定被现有 lint glob 覆盖，必须确认覆盖范围；必要时增加针对 shared/plugin/Fault/Packet 文件的现有风格检查。报告与安装入口变更时运行相关专项回归和暂存运行时验证。

本次文档任务仅执行文档与差异检查；前序诊断的 3 套/22 条专项测试通过是基线证据，不是本文整改验收。

## 17. 日志与可复查记录

保留既有 `turn_admission_decided`、`authoritative_artifact_stored/resolved`、`napm_plugin_query_decision_evaluated`、`napm_page_views_api_request_built` 和完成事件。补充日志应围绕边界，至少能关联：

- 当前 scopeHash、turn/run/trace，冻结 sourceArtifact/sourceTurn。
- 已裁定工作流、期望来源对象、实际来源对象、执行服务与拒绝原因。
- 身份来源、是否补查、候选数量、解析成功/缺失/歧义数量。
- requestedLimit、returnedCount、有效性、completeness、失败阶段及客户端路径。
- discovery/enrichment/pageViews 各自调用次数与重放抑制结果。

日志不保存完整访问记录、凭据或完整敏感 URL；详细原始响应只作为受控脱敏 fixture。每个实施阶段在当天 memory 记录提交、测试数量、实际改动、预期差异和遗留项，更新本文件阶段状态。

## 18. 发布、回滚与防覆盖

代码工作继续在独立功能分支完成，由整合任务纳入正式发布。不得直接修改 main、其他整合分支或远端活动文件。

发布前必须：

1. 将需要保留的报告、Packet 等其他修复整合到同一清洁提交，不能用过旧的整包覆盖它们。
2. 执行完整质量门禁、暂存依赖检查，并通过实际 `index.mjs` 加载路径验证。
3. 校验入口包装器、主插件、兼容副本和 manifest 的一致性；不能只校验没有被实际加载的 `index.js`。
4. 使用统一发布包、installer、dry-run 和可验证备份，确认发布权限后再安装；本方案文档不是部署授权。
5. 在隔离测试会话执行三轮话术，核对真实 pageViews 参数、次数、日志和返回内容。

回滚按提交/完整发布回滚执行，保留运行配置、数据和其他已整合修复。迁移开关用于回退消费者路径，不用于跳过失败校验。禁止单文件上传或在活动目录内修改 wrapper 加载顺序。

## 19. 本次文档节点备份与验证记录

- 编写前功能分支工作区干净，HEAD：`22ec579ef8e20c8896888372a823896a3f5caa49`。
- 本地备份目录：`C:\Users\20693\AppData\Local\Temp\codex-napm-pageviews-plan-20260908-102300`。
- `tracked-head-backup.zip` 为 Git 已跟踪节点备份，不是发布包；同时单独备份两份 2026-09-03 相关文档。
- 备份 SHA-256：`F60E808244AEA921A1308704CAB90295758B35E295C16DDE82C7D0BFD8612A30`。
- 前序本地专项：`page-views-contract`、`page-views-execution-kernel`、`fault-diagnosis-page-views-contract`，3 套/22 条通过。
- 前序只读探针已复现：错误来源类型拒绝、6 个字段缺失、异常响应空白行、Fault 缺 ID 静默跳过。
- 本次只新增方案、维护记录，并给历史方案补充现状链接；无运行时代码变更。
- 文档校验：四份文档的 12 个相对链接均可解析，代码围栏闭合，新文档 4 个 JSON 示例均可解析。文档提交前检查全部新增/修改内容的 Git 空白差异。
- 如需撤回本次文档，在独立提交后对该文档提交执行可审查的 revert；不要对整个工作区做破坏性回退。

## 20. 最终完成判定

不能只以测试总数或“pageViews 返回过数据”判定完成。最终须同时满足：

- 三轮真实问法闭环、可信来源正确、一次 pageViews 请求、结果仅交付一次。
- 标准字段完整，缺失/零/错误清晰区分，未知单位和有限记录不会被过度解释。
- 身份获取有明确来源与失败原因，不丢排行序号、不猜 ID、不跨业务选页面。
- Fault 与 Packet 的已声明迁移范围只经统一内部服务获取事实，未迁移项明确列出。
- 新旧事实与报告兼容性由真实脱敏样例和生命周期测试证明；预期修正有逐项说明。
- 其他 Tool 的准入、报告、下载确认和上下文隔离无回归。
- 所有新增依赖被正式运行时与完整发布覆盖，远端验收和本地测试分开记录。
- 分支、提交、测试、备份和回滚信息齐全，未完成阶段不得标记为已实施。
