# OpenClaw 原生命令被 NAPM 边界守卫覆盖修复方案

日期：2026-08-07  
适用范围：OpenClaw 企业微信通道、NAPM OpenClaw 插件、会话级查询与报告状态

## 1. 问题现象

用户在企业微信中发送 OpenClaw 原生命令 `/new` 后，没有看到正常的：

```text
✅ New session started.
```

而是收到 NAPM 插件的通用域外回复：

```text
我当前只处理系统监控、性能分析、NAPM 查询和结果解读相关问题。
像天气、闲聊、泛问答这类内容不在当前技能范围内。
如果你是想看系统情况，可以直接问我：239web最近异常吗、某系统今天比昨天差吗、这个监控结果怎么理解。
```

这使用户误以为 OpenClaw 已不能识别 `/new`、`/reset`、`/status`、`/help` 等原生命令。

## 2. 远端证据

2026-08-07 12:45:48，企业微信通道收到：

```json
{"text":{"content":"/new"}}
```

2026-08-07 12:45:49，OpenClaw 会话存储创建了新 session：

```text
sessionId=2d64525b-af49-453c-abda-de7b8ad14b82
sessionStartedAt=1786077949377
```

该时间窗口没有创建模型会话文件，说明 `/new` 已被 OpenClaw 原生命令处理器消费，并未进入普通模型推理。

2026-08-07 12:45:50，企业微信收到的最终回复却是 NAPM 通用域外文案。使用本地钩子按以下顺序重放可 100% 复现：

1. `message_received({content: '/new'})`
2. OpenClaw 生成 `✅ New session started.`
3. `message_sending()` 返回 NAPM 域外文案

因此故障不是“命令未识别”，而是“命令执行成功后，原生回执被插件覆盖”。

## 3. 根因

### 3.1 控制命令被当作业务问句分类

NAPM 插件当前将所有 `message_received` 文本送入 `buildConversationScopedGuardState()`。

`/new` 不匹配系统监控或 NAPM 领域，因此被记录为：

```text
generalOutOfScopeRequested=true
```

插件没有“OpenClaw 控制命令”这一独立消息类型。

### 3.2 输出钩子没有命令旁路

OpenClaw 原生回执同样经过：

- `message_sending`
- `before_message_write`

两个钩子看到当前 scope 的 `generalOutOfScopeRequested=true` 后，将原生回执替换成 NAPM 域外文案。

### 3.3 OpenClaw session 与 NAPM scope 生命周期不一致

OpenClaw `/new` 会生成新的 `sessionId`，但 NAPM 插件主要使用稳定的企业微信 `sessionKey` 作为 conversation scope。

因此只依赖 OpenClaw 更换 `sessionId`，不能自动清理以下旧状态：

- conversation guard 状态
- 最近 skill 结果
- 最近 reportData 和导出结果
- report source 持久化记录
- trusted tool context
- 单轮兜底投递记录
- 已发送媒体去重记录

如果不增加 scope 级清理，`/new` 后仍可能读取重置前 90 秒内的查询结果或 5 分钟内的报告结果。

### 3.4 guard key 包含共享 agentId

当前 guard key 包含 `agentId`。企业微信多个用户可能共用 `agentId=main`，裸 agentId 不是会话身份，存在跨用户命中其他会话状态的风险。

## 4. 修复原则

1. `/...` 命名空间归 OpenClaw 核心所有，NAPM 插件不解释、不改写命令及命令回执。
2. 不能只硬编码 `/new`；应覆盖 `/reset`、`/status`、`/help`、`/model` 和未来新增命令。
3. 未知斜杠命令也由 OpenClaw 核心决定如何响应。
4. `/new`、`/reset` 必须同时重置 OpenClaw session 和 NAPM conversation scope。
5. 非重置命令只旁路当前命令轮，不破坏已有 NAPM 业务上下文。
6. 命令旁路状态必须短期有效，并在下一条普通消息到达时清除。

## 5. 代码设计

### 5.1 命令解析

新增统一解析器：

```js
function parseOpenClawControlCommand(content = '') {
  const text = String(content || '').trim();
  const match = text.match(/^\/([a-z][a-z0-9_-]*)(?:@\S+)?(?:\s|$)/i);
  if (!match) return null;

  const name = match[1].toLowerCase();
  return {
    name,
    raw: text,
    resetsSession: name === 'new' || name === 'reset'
  };
}
```

该规则不会把 `/var/log` 等路径识别为命令，因为命令名后只允许结束、`@bot` 或空白参数。

### 5.2 独立命令轮状态

新增 `nativeCommandByScope`，以 conversation scope 保存短期命令标记：

```text
TTL=30 秒
下一条普通消息到达时立即删除
```

该状态不得复用 `generalOutOfScopeRequested`，也不得覆盖非重置命令之前的业务上下文。

### 5.3 钩子执行顺序

`message_received` 必须先识别命令：

- 命令：记录命令轮；`/new`、`/reset` 额外清理 NAPM scope；不进入领域分类。
- 普通消息：清除命令轮标记，再执行现有 NAPM 分类。

以下钩子必须在任何 NAPM 逻辑之前检查命令轮并返回 `undefined`：

- `before_prompt_build`
- `before_agent_start`
- `before_tool_call`
- `message_sending`
- `before_message_write`

### 5.4 scope 级状态清理

新增统一入口：

```js
clearNapmConversationScope(ctx)
```

并为以下状态类增加公开的 `clearScope(scope)`：

- `ConversationOperationState`
- `TrustedToolContextStore`
- `ReportSourceStore`

清理范围包括内存记录和持久化记录。插件内的 `napmConversationState`、guard、trusted context 内存缓存、媒体去重缓存也必须同步清理。

### 5.5 guard key 收口

从会话状态 key 中移除裸 `agentId`。优先使用：

1. `sessionKey`
2. `sessionId`
3. `channelId + accountId + conversationId`
4. 当前轮 `runId/messageId`

不能使用多个用户共享的 agent 名称作为 conversation identity。

## 6. 回归测试

新增原生命令专项测试，至少覆盖：

1. `/new` 的 `✅ New session started.` 在两个输出钩子中保持不变。
2. `/reset` 原生回执保持不变。
3. `/help`、`/status`、`/model` 不进入 NAPM 域外改写。
4. 未知 `/xxx` 的 OpenClaw 原生错误保持不变。
5. `/new` 后旧 skill、report、report source、trusted context、媒体去重状态不可读取。
6. `/status` 后原有业务上下文仍可用于下一条正常追问。
7. `/new` 后第一条 NAPM 查询正常执行并属于新 turn。
8. 天气和普通闲聊仍按既有边界策略处理。
9. 两个共用 `agentId=main` 的企业微信会话互不污染。

## 7. 远端验收

部署前备份当前扩展、workspace 插件和状态模块。部署后执行无外部投递冒烟：

1. 模拟 `/new` 输入和原生确认输出，断言钩子返回 `undefined`。
2. 模拟 `/status`，断言业务上下文没有被清空。
3. 模拟 `/new` 后查询，断言旧 turn 结果不可见、新查询结果可见。
4. 确认网关 `active/running`、NAPM 插件加载、企业微信 WebSocket 已连接。
5. 检查 journal 无插件异常和连续回执改写。

## 8. 不采用的方案

- 不把 `/new` 加入 NAPM 关键词，因为它不是业务意图。
- 不只在 `buildGeneralOutOfScopeReply()` 中判断回执文本，因为回执可能本地化或变化。
- 不关闭全部域外守卫，因为天气、闲聊等边界仍需保留。
- 不只清理 `napmConversationState`，因为旧报告和可信工具上下文仍可能残留。
- 不依赖新的 OpenClaw `sessionId` 自动隔离，因为插件的稳定 scope 是企业微信 `sessionKey`。

## 9. 验收标准

1. `/new`、`/reset` 和其他 OpenClaw 命令的原生回执不被 NAPM 插件修改。
2. `/new` 后 OpenClaw sessionId 变化，NAPM scope 中的旧查询和报告状态全部失效。
3. 普通 NAPM 查询、报告、多工具链和结构化错误处理不回归。
4. 普通域外问句仍按产品边界返回统一文案。
5. 不同企业微信用户即使共用 `agentId=main`，状态也完全隔离。

## 10. 实施记录

实施时间：2026-08-07 13:00-13:14 CST  
实施状态：本地修改、回归验证、远端备份、测试服务器部署和重启后验收均已完成。

### 10.1 代码修改

主插件 `napm-openclaw-plugin.remote.js` 已完成以下修改：

1. 新增 `parseOpenClawControlCommand()`，统一识别 `/...` OpenClaw 命令命名空间，不硬编码单个 `/new` 场景。
2. 新增独立 `nativeCommandByScope` 命令轮状态，TTL 为 30 秒；下一条普通消息到达时立即清除。
3. `message_received` 优先处理原生命令，不再把命令送入 NAPM 业务分类。
4. `before_prompt_build`、`before_agent_start`、`before_tool_call`、`message_sending` 和 `before_message_write` 在命令轮开始处直接旁路。
5. `/new` 和 `/reset` 调用统一的 `clearNapmConversationScope()`，同步清理 NAPM 会话状态。
6. `/help`、`/status`、`/model` 和未知 `/xxx` 只旁路当前命令轮，不清理已有业务上下文。
7. guard key 改为带类型前缀的 session、conversation、run 和 message key，并移除共享 `agentId`。
8. 增加 `openclaw_native_command_bypassed` 与 `napm_conversation_scope_cleared` 审计事件。

状态模块已增加 scope 级清理接口：

- `plugin/ConversationOperationState.js`：清理 skill、debug API、报告导出和单轮兜底投递记录。
- `plugin/TrustedToolContextStore.js`：清理指定 scope 的持久化可信 trace。
- `plugin/ReportSourceStore.js`：清理指定 scope 的持久化报告源。

插件统一清理入口还会同步清理：

- `napmConversationState`
- 与 scope 匹配的 `napmGuardState`
- 内存可信工具上下文
- `napmSentMediaByConversation`
- 原生命令短期标记

### 10.2 回归测试

新增 `test/napm-openclaw-plugin-native-command.test.js`，覆盖：

- `/new`、`/reset`、`/help`、`/status`、`/model` 和未来未知命令的原生回执保留。
- 五个插件钩子的命令轮旁路。
- 30 秒 TTL 自动失效。
- `/new`、`/reset` 后旧查询、报告、可信 trace 和媒体去重状态失效。
- `/status` 后业务上下文保留。
- 下一条普通消息恢复 NAPM 边界守卫。
- 共享 `agentId=main` 不再造成跨会话污染。

同时扩展：

- `test/napm-turn-state.test.js`
- `test/report-source-store.test.js`
- `test/napm-openclaw-plugin-streaming-guard.test.js`：将审计、报告源和可信上下文隔离到测试临时目录，防止回归测试触碰真实 OpenClaw 状态。
- `scripts/remote-turn-lifecycle-smoke.js`

本地验证结果：

- 原生命令专项：14 项通过。
- 状态仓库专项：9 项通过。
- 全量 Jest：46 个测试套件、281 项测试全部通过。
- NAPM skill 运行时契约：7 个 skill 全部通过。
- `node --check`：主插件、状态模块和远端冒烟脚本全部通过。
- `git diff --check`：无空白错误。

## 11. 远端备份与部署

### 11.1 部署前基线

服务器：`101.254.114.237`  
服务：`openclaw-gateway.service`  
部署前状态：`active`  
部署前两份主插件 SHA-256：

```text
bc9fd665bfc7f841fa06074347ac8dd3f802107ce3084cb02ae11477eb45d47a
```

### 11.2 备份

备份目录：

```text
/home/netinside/.openclaw/backups/napm-native-command-20260807-131046
```

备份共 169 个文件，包含：

- 完整扩展目录 `extensions/napm-openclaw-plugin`
- workspace 主插件和 `plugin` 状态模块
- `openclaw.json`
- `openclaw-gateway.service`
- SHA-256 清单 `manifest.sha256`

备份中的扩展和 workspace 主插件哈希均已复核为部署前基线哈希 `bc9fd665...`。

### 11.3 Staging 验证

上传目录：

```text
/home/netinside/.openclaw/staging/napm-native-command-20260807-131200
```

上传后逐文件哈希与本地完全一致，并在 staging 中完成语法检查和 10 项无实际消息投递冒烟。冒烟覆盖原生命令旁路、重置状态清理、共享 agent 隔离，以及此前的查询生命周期、流式预览和重复兜底保护。

### 11.4 部署结果

修改文件通过临时文件加同文件系统 `mv` 的方式原子替换到：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin
/home/netinside/.openclaw/workspace
```

部署后两份主插件 SHA-256：

```text
1b6a6731712d73a907dd0293e8d8acd281edd65189075d53f91ac70225885ef4
```

部署后状态：

- 网关：`active`
- 新进程 PID：`1415243`
- 启动时间：`2026-08-07 13:12:27 CST`
- 已安装扩展无投递冒烟：10 项全部通过
- 插件加载：`napm-openclaw-plugin` 已包含在 6 个已加载插件中
- 网关：进入 `ready`
- 企业微信：WebSocket connected、Authentication successful、Authenticated
- 重启后 journal：未发现本次插件修改引入的 error、exception、failed 或 fatal

### 11.5 回滚点

如后续验收发现问题，应使用以下备份恢复扩展目录、workspace 副本和对应配置，然后重启 `openclaw-gateway.service`：

```text
/home/netinside/.openclaw/backups/napm-native-command-20260807-131046
```

恢复后应复核主插件哈希回到 `bc9fd665...`，并重新执行安装目录上的无投递冒烟。
