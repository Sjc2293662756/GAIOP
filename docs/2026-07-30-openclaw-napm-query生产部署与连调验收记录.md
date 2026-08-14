# openclaw-napm-query 生产部署与连调验收记录

日期：2026-07-30  
范围：生产输入契约整改、Gateway 部署、生产 Tool 路由与企业微信通道回执验证

## 1. 部署内容

本次部署将生产查询链路收敛为：

```text
OpenClaw 构造 resolvedQuery
  -> 插件机械规范化并物化执行时间
  -> openclaw-napm-query 校验和执行
```

生产 `napm-skill-query` 不再根据 `prompt/userQuery` 调用本地 Resolver，也不再用二次自然语言解析覆盖显式结构化语义。开发 Resolver Tool 默认关闭。

部署过程执行了以下保护：

- 本地和远端修改前文件分别归档。
- 部署文件逐项校验 SHA-256。
- JavaScript 执行 `node --check`，JSON 执行解析校验。
- 通过 `systemctl --user restart openclaw-gateway.service` 受控重启。

当前插件部署文件 SHA-256：

```text
4324364bc30af8aad13d5cc522127a4c1e466f3c25beede9da6de499feb4b754
```

## 2. Gateway 与通道状态

- Gateway：`active`
- 最新重启 PID：`933130`
- 监听端口：`0.0.0.0:18789`
- 已加载插件：5 个
- 插件错误：0
- 企业微信：已配置、已认证、`running=true`、`lastError=null`

在会话存储中核对最近活跃的企业微信单聊 `deliveryContext` 后，选取该已存在目标执行一次明确标注的连调消息投递。未猜测联系人或群聊，未操作桌面企业微信客户端。

投递过程与证据：

- 先执行 `--dry-run`，确认 `channel=wecom`、目标格式和 Gateway 路由均可识别。
- 正式发送仅执行 1 次；CLI 返回 `channel=wecom`、`via=gateway`、发送 `runId=f91f5f01-ecba-484a-9575-f063784c70a6`。
- 企业微信消息标识：`aibot_send_msg_1785348080870_deae87b9`。
- Gateway 于 `2026-07-30 02:01:20.872+08:00` 记录 WebSocket 发送，于 `02:01:21.158+08:00` 收到同一消息标识的 `Reply ack`。
- 投递后 Gateway 保持 `active/running`，企业微信保持 `running=true`、`lastError=null`。

上述证据完成了“CLI 接受发送 -> Gateway WebSocket 出站 -> 企业微信通道 ack”的真实投递闭环。联系人标识未写入本文档。

## 3. 生产 Tool 验收

### 3.1 prompt-only 严格失败

只提供自然语言、不提供 `resolvedQuery` 时：

- 错误码：`UPSTREAM_RESOLVED_QUERY_INVALID`
- 原因：`missing_resolved_query`
- `resolvedQuery=null`
- 未调用 NAPM 后端

### 3.2 相对时间 Top5

“查询过去1小时总流量最高的5个IP”一次构造 canonical 查询：

- `service=topValues`
- `queryModeKey=topn`
- `metric/topMetric=BYTIO`
- `groups=[IPAddress]`
- `topCount=5`
- `end-start=3600`

后端返回 5 条，但顺序不满足 `BYTIO desc`。Tool 已输出“排序校验”和“返回顺序（非可信排名）”，没有生成可信排名结论。

### 3.3 固定时间多指标 Top5

以下显式语义均被保留：

- `start=1785310980`
- `end=1785314580`
- `metrics=[BYTI,BYTO,BYTIO]`
- `topMetric=BYTIO`
- `topCount=5`
- `timeMode=fixed`

返回 5 条，每条保留三项指标；没有重新计算时间、缩减指标或改写 TopN。

### 3.4 告警路由

告警摘要请求只调用 1 次 `napm-alert-query`，没有进入 Query Tool。

### 3.5 故障诊断失败路由

请求：

```text
分析“回溯238web”的 HTTP 报错根因，最近1小时
```

最终生产轨迹：

- 只调用 1 次 `napm-fault-diagnosis`
- 未调用 `napm-skill-query`
- 未执行 exec/read/memory 等旁路工具
- Tool 返回 `FAULT_DIAGNOSIS_REQUIRED_DATA_UNAVAILABLE`
- 失败步骤：`step1_4xx_5xx_overview`
- 南向错误：`NAPM averageValues request failed with HTTP 400`

最终会话文本被强制收敛为：

```text
故障分析执行失败：Required diagnostic queries failed for step1_4xx_5xx_overview.
本次未获得足以判断根因的数据，不能据此推断对象不存在、无数据或具体故障原因。
```

## 4. 连调发现与修复

### 4.1 Typed Hook 注册接口错误

原插件用 `registerHook` 注册 `before_tool_call` 等 Agent 运行期 Hook。当前 OpenClaw 中 `registerHook` 属于内部事件 Hook；Agent Typed Hooks 必须使用 `api.on`。因此旧本地模拟测试通过，但生产 Hook 没有执行。

整改：

- 优先使用 `api.on` 逐项注册 Typed Hook。
- 测试 Harness 改为生产接口形态，若误用 `registerHook` 立即失败。
- 增加诊断失败后禁止降级的生产式回归。

### 4.2 失败结果归属与终止回复

只在 `before_tool_call` 记录“已尝试”不足以得到 Tool 结果。现通过 `after_tool_call` 使用真实 `ctx + result` 将失败绑定到当前 run/session，再由：

- `before_tool_call` 阻止所有后续 Tool；
- `before_message_write` 改写会话落盘内容；
- `message_sending` 改写企业微信发送内容。

即使模型原始草稿仍出现推测，生产落盘和发送边界也只允许确切失败事实。

### 4.3 Query 成功结果被兜底覆盖

企业微信原始会话中，Top5 IP 与业务清单查询的 `napm-skill-query` 均已成功执行，但 Tool 调用前的助手帧被 `before_message_write` 写成“未拿到有效 skill 结果”的固定文案；该文案随后成为最终回复。

整改：

- 剥离运行时会话元数据，只以实际用户问题参与 prompt 匹配。
- Tool 调用前的助手帧直接放行，避免过早写入无结果兜底。
- 在 `after_tool_call` 将 Query 成功结果绑定到当前 run/session。
- 在最终写入和发送边界优先使用已绑定的真实 Query 结果。

生产复测“查询过去1小时总流量最高的5个IP”只调用 1 次 `napm-skill-query` 并输出真实结果，未再出现固定兜底文案。

### 4.4 业务清单对象契约归一

首次修复后，“系统中有哪些业务？”仍可能失败。根因是 `buildBusinessObjectInventoryResolvedQuery()` 被保留为空实现：请求虽被识别为 `WebApplication` 清单，插件却未生成结构化参数；严格契约于是拒绝模型手工构造的参数，形成重复调用循环。

整改仅覆盖两种封闭目录语义：

- `WebApplication` 业务清单；
- `BusinessGroup` 工作组清单。

这两类请求在 `before_tool_call` 被确定性改写为 `groups + metadata + metadata_list`。不会恢复通用 prompt-to-query 解析，也不会改变 `CompositeApplication` 的独立保护规则。

生产复测“系统中有哪些业务？”只调用 1 次 `napm-skill-query`，成功返回 10 个 `WebApplication` 业务系统；最终文本未出现“必须重构 resolvedQuery”或“未拿到有效 skill 结果”。

## 5. 本地质量门禁

- Jest：73/73 suites、501/501 tests 通过
- ESLint：0 error、18 个既有 warning
- 修改的 JavaScript：`node --check` 全部通过
- `git diff --check`：通过

## 6. 遗留问题

1. `napm-fault-diagnosis` 第一阶段请求仍返回 HTTP 400。该问题属于故障诊断 Skill 或南向参数契约，不属于 Query 输入契约。
2. TopN 返回顺序仍与 `BYTIO desc` 不一致。当前已做可信度保护，尚需继续定位是南向接口排序还是结果规范化造成。

## 7. 企业微信出站结果 scope 修复

### 7.1 根因

企业微信中 `napm-skill-query` 已成功返回真实数据，但结果保存和最终回复读取使用了不同的会话 scope：

- Tool 执行阶段持有完整企业微信上下文，按完整会话 scope 保存成功结果。
- `before_message_write` 阶段只持有精简 session 上下文，按该精简 scope 查找结果时返回空。
- 原 Guard 因而把已成功执行的查询误判为“未拿到有效 skill 结果”，改写为固定兜底，并被企业微信重复投递。

这不是 Query Skill、NAPM 南向接口或企业微信鉴权失败。线上审计记录确认 Top5 查询成功完成并返回 5 条数据。

### 7.2 整改

- 在入站阶段把完整结果 scope 固化到 NAPM Guard 状态。
- 在 Tool 调用、消息写入和出站发送阶段优先使用该已固化 scope 查找结果。
- 企业微信存在 pending Tool 且尚无成功结果时，`before_message_write` 返回 `{ block: true }`，阻止固定兜底进入会话和出站链路。
- 测试 Harness 改为优先使用生产实际的 `api.on` Typed Hook 注册方式。
- 新增回归：完整入站上下文保存结果后，即使最终写入阶段只保留精简会话上下文，也必须取回真实 Skill 结果。

### 7.3 部署与验收

- 部署前远端插件已归档到 `/home/netinside/.openclaw/archive/2026-07-30-wecom-result-scope-bridge-predeploy/`。
- 部署后插件 SHA-256：`99374b42c20b78e5fd1a4708e1c1cb42db9955cc0369a9a88d9478215e8faf7e`。
- Gateway 已受控重启，企业微信通道 `running=true`、`lastError=null`。
- 本地质量门禁：73/73 Jest suites、505/505 tests 通过；`node --check` 与 `git diff --check` 通过；lint 为 0 error、18 条既有 warning。
- 生产复测：企业微信真实入站的“查询过去1小时总流量最高的5个IP”触发一次 `napm-skill-query`，最终出站为真实 Top5 数据并收到企业微信回执；未再出现固定兜底文本。
