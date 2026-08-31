# NAPM 查询轮次 messageId/runId 断层修复说明

日期：2026-08-31
基线：`v1.1.0-rc.38` / `a4e5376a1d7ed46eb0f72c0c1f99f1e9492f12ed`
状态：本地修复与回归已完成，未部署

## 1. 现象

企业微信输入“最近 7 天应用流量趋势如何？”后，用户收到通用门禁文案：

```text
当前问题必须经 NAPM skill 执行后才能回答。
本轮未拿到有效 skill 结果……
```

但审计记录显示 `napm-skill-query` 已经正确执行，Query Decision 返回 `CLARIFICATION / GROUP_ARGUMENT_REQUIRED`，本应询问具体应用名称。

## 2. 根因

OpenClaw 各 Hook 提供的身份字段不同：

- `message_received` 和 `message_sending` 使用入站 `messageId`；
- `before_prompt_build`、`before_agent_start` 和 Tool Hook 使用 Agent `runId`；
- `before_message_write` 的类型契约只保证 `agentId/sessionKey`，不保证 `runId/messageId`。

rc.38 没有把同一请求的 `messageId` 和 `runId` 桥接到同一 Query Turn，因此产生两个轮次：Tool 把正确澄清结果写入 run 轮次，最终发送却读取空的 message 轮次，并误记录 `MODEL_OMITTED_REQUIRED_TOOL`。

`before_message_write` 还会因缺少身份将 Assistant 消息替换为通用失败文案，导致 transcript 中的 `toolCall` 结构被删除。

## 3. 修复

1. `QueryTurnCoordinator` 保存入站 `sourcePrompt`。
2. Agent Hook 获得新 `runId` 时，只领取同会话、`RECEIVED`、未被 Agent 领取且 source prompt 匹配的轮次。
3. 将 `messageId` 和 `runId` 绑定到同一 `turnId`，后续 Tool 和发送链路复用该轮次。
4. `before_message_write` 缺少生命周期身份时不再改写 Assistant 消息；最终对外交付继续由有 `messageId/runId` 的 `message_sending` 安全门禁负责。

## 4. 验证要求

- 生产 Hook 身份形状回放：`messageId -> runId -> identityless transcript -> messageId delivery`。
- 应用趋势缺名时交付确定性澄清文案，不得进入南向请求。
- `messageId` 和 `runId` 必须解析到同一 `turnId`。
- `before_message_write` 不得删除身份不完整消息中的 `toolCall`。
- 重叠会话、澄清续问、查询成功、空数据、参数失败和非 NAPM 路由必须继续通过全量回归。

## 5. 发布边界

本修复不直接覆盖 rc.38。全量测试、发布包验证和 staged 远端冒烟通过后，由唯一整合部署会话制作新版本，建议版本号 `1.1.0-rc.39`。未经明确批准不切换正式服务。
