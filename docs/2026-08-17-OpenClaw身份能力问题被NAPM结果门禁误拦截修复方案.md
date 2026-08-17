# OpenClaw 身份能力问题被 NAPM 结果门禁误拦截修复方案

日期：2026-08-17
状态：`1.1.0-rc.4` 已部署测试服务器，待企业微信真实消息验收
范围：NAPM OpenClaw 插件、Query 工作流分类器、会话追问与结果证据门禁

## 1. 问题现象

用户询问助手身份或能力：

```text
你有什么功能？
你能做些什么？
```

预期由 OpenClaw 根据 `IDENTITY.md`、`SOUL.md` 和当前完整会话上下文直接回答，不调用 NAPM Tool。

实际答案被插件改写为：

```text
当前问题必须经 NAPM skill 执行后才能回答。
本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。
请以技能执行结果为准。
```

## 2. 远端日志证据

以下结论来自 2026-08-17 对测试环境网关日志的只读核对，不是根据代码推测。

### 2.1 `/new` 后询问“你有什么功能？”

11:29 的日志显示：

```text
platformIdentity=true
napmRelated=false
before_tool_call=0
before_message_write 执行结果证据门禁
```

本轮没有 Tool 调用。`WorkflowClassifierService.hasInventoryIntent()` 仍将没有 NAPM 对象的“有什么”识别为 `object_inventory`，输出门禁继而要求存在 Skill 结果并覆盖模型答案。

### 2.2 NAPM 对话后询问“你能做些什么？”

14:01 的同一会话在此前处理过巡检报告请求。日志显示：

```text
platformIdentity=true
napmRelated=true
before_tool_call=0
before_message_write 执行结果证据门禁
```

`isContinuationPrompt()` 将所有长度不超过 12 个字符的文本都视为追问，因此能力问题错误继承上一轮 `napmRelated=true`。插件的 `napmConversationState` 是进程内 `Map`，仅在 `/new`、`/reset` 或进程重启时清理，没有 TTL。

### 2.3 已排除项

- 不是身份文件缺失；OpenClaw 已具备身份和能力上下文。
- 不是模型主动拒答；最终文本由输出 Hook 覆盖。
- 不是 Tool 执行失败；两次现场均没有进入 `before_tool_call`。
- 不是本地和远端插件文件不一致；运行版本与对应发布标签中的插件文件已核对一致。

## 3. 根因

问题由三条可独立触发的规则叠加造成：

1. 对象清单分类过宽：`有什么/有哪些` 不要求出现可识别的 NAPM 对象。
2. 追问继承过宽：任意短句都可继承上一轮 NAPM 状态。
3. 身份优先级不完整：虽然已有 `platformIdentityPrompt`，状态构造、Skill 证据判断、历史结果读取和 Tool 门禁没有统一将它视为最高优先级路由。

因此，“OpenClaw 有完整对话上下文”并不能自动修复问题。当前 JavaScript 插件没有消费一份由 OpenClaw 语义判断生成的单轮路由结果，而是在多个 Hook 中重复使用正则和进程内状态重新判断。上下文在当前插件中的合理作用应仅是：关联明确追问、当前轮次、允许的 Tool 和可信执行结果，不能用“短句”替代语义判断。

## 4. 本次短期修复

### 4.1 身份路由最高优先级

纯身份、能力和问候请求统一强制为：

```text
platformIdentityPrompt=true
napmRelated=false
domainRelated=false
alertRelated=false
不继承上一轮 NAPM continuation 状态
```

复合请求不属于纯身份请求，例如“你能帮我查一下现在系统情况吗”仍按 NAPM 请求处理。

### 4.2 Skill 证据门禁显式放行

`shouldRequireSkillBackedReply()` 和 `shouldForceSkillRecordForPrompt()` 对身份请求直接返回 `false`。两个输出 Hook 不读取上一轮 NAPM 结果，也不改写 OpenClaw 已生成的身份答案。

### 4.3 身份轮禁止 Tool 调用

纯身份请求不需要外部数据。`before_tool_call` 对该轮任何 Tool 调用直接拒绝，防止模型误调用 NAPM Tool 或通用工具。

### 4.4 收窄对象清单分类

只有同时满足以下条件才返回 `object_inventory`：

1. 存在清单意图；
2. `inferInventoryObjectType()` 得到明确的 NAPM `targetObjectType`。

因此“你有什么功能？”不再是对象清单，“系统里有哪些业务？”仍然是 `WebApplication` 对象清单并继续要求 Skill 证据。

### 4.5 收窄追问继承

删除 `text.length <= 12`。仅保留具有明确指代或继续动作的追问表达，例如“这个”“上述”“继续”“然后呢”“改成”“换成”“怎么看”“怎么理解”。身份分类在追问继承前执行，并拥有最高优先级。

## 5. 回归测试

本次先建立失败测试，再修改实现。至少覆盖：

1. `/new -> 你有什么功能？` 在 `message_sending` 和 `before_message_write` 均保留身份答案。
2. `/new -> 你有哪些能力？` 保留身份答案。
3. NAPM/巡检请求后输入“你能做些什么？”不继承 NAPM 状态。
4. 身份请求的 `shouldRequireSkillBackedReply(..., { napmRelated: true }, null)` 返回 `false`。
5. 身份轮 Tool 调用被拒绝。
6. “你有什么功能？”和“你有哪些能力？”不分类为 `object_inventory`。
7. “系统里有哪些业务？”仍分类为 `object_inventory`，目标为 `WebApplication`，且无 Skill 结果时仍触发证据门禁。
8. 复合 NAPM 请求不被硬分类为纯身份请求。

## 6. 长期架构

短期修复只解决已证实的误判，不继续扩大正则路由。目标架构为每轮一次语义路由、后续 Hook 只消费决定：

```text
OpenClaw 完整会话上下文
  -> 单轮结构化 routingDecision
  -> Plugin 保存最小执行上下文
  -> before_tool_call 校验 allowedTools/requiresTool
  -> 可信结果账本记录本轮 Tool 结果
  -> 输出 Hook 校验 routingDecision + 本轮可信结果
```

建议的单轮契约：

```json
{
  "turnId": "...",
  "route": "platform_identity | napm_query | report | alert | packet | out_of_scope",
  "allowedTools": ["napm-skill-query"],
  "requiresTool": true,
  "continuationOfTurnId": null
}
```

插件仅保存 `turnId`、路由、允许工具、是否需要工具和明确的上轮引用，不保存整段聊天内容，也不靠文本长度猜测追问。安全边界、`resolvedQuery` 校验、报告来源、本轮可信结果以及 shell 绕过保护仍保持确定性校验。

该完整架构需要 OpenClaw 向插件提供稳定的单轮路由契约；当前仓库没有可验证的对应 API，因此本次不虚构接口、不进行大规模重构。

## 7. 验收标准

1. 两个现场输入不再被 Skill-required 文案覆盖。
2. 身份轮不调用 Tool、不读取上一轮 NAPM 记录。
3. 真实 NAPM 对象清单和明确追问保持原有能力。
4. 天气、闲聊等真正域外请求继续被边界门禁处理。
5. 聚焦回归、完整 Jest、lint 和运行时契约校验全部通过。
6. 本轮不构建发布包、不提交、不部署或重启远端服务。

## 8. 实施结果

### 8.1 修复前复现

新增回归首次执行得到 8 条失败、47 条通过，失败项与现场一致：

- 身份答案在两个输出 Hook 中被 Skill-required 文案覆盖；
- 直接证据判断对身份问题返回 `true`；
- 身份轮错误放行 `napm-skill-query`；
- 能力问句错误分类为 `object_inventory`。

复合请求边界随后新增 2 条失败用例，证明原身份分类器的非整句匹配也可能错误放行“身份问题 + NAPM 查询”。该规则已同步收紧。

### 8.2 代码结果

- 身份、能力和问候改为独立的最高优先级状态，不继承 NAPM、告警或指标清单上下文。
- 两个 Skill 证据判断显式放行身份请求，历史结果读取对身份请求直接返回空。
- `before_tool_call` 在创建可信调用上下文前拒绝身份轮 Tool 调用。
- 身份分类改为整句匹配，复合 NAPM 请求不会进入身份旁路。
- 对象清单要求存在明确 `targetObjectType`。
- 追问不再按文本长度判断；指标清单细节继续由专用分类器承接。

### 8.3 验证结果

```text
聚焦回归：3 suites、68 tests 全部通过
完整 Jest：90 suites、643 tests 全部通过
npm run lint：通过
npm run verify:runtime-contract：8 个生产 Tool 全部通过
Node 语法检查：通过
git diff --check：通过
```

本地仅按现有锁文件安装测试依赖。上述结果完成后，已按统一发布流程提交、构建并部署 `1.1.0-rc.4`，部署记录见下一节。

## 9. rc.4 测试服务器部署记录

### 9.1 发布制品

```text
版本：1.1.0-rc.4
发布提交：be7dba7b6f250487fec75f2aa3f03cd8070f9439
制品：NAPM_skill-1.1.0-rc.4-be7dba7b.zip
SHA-256：40eace457703c29fc0a36d7b41f00b6a14d1c4dc04eac8fc1dd370187d432e66
大小：836202 bytes
```

本地构建从 Git 提交归档，重新执行完整 Jest、lint 和运行时契约校验后生成唯一 ZIP。远端上传副本的 SHA-256 与本地一致。

### 9.2 隔离验证与安装

远端候选版本先在独立 release 目录完成：

1. `verify-staged-release.sh`：生产依赖 0 个已知漏洞，插件语法和 8 个生产 Tool 入口全部通过。
2. `install-release.sh --dry-run`：确认活动 workspace、extension、Gateway 与 watcher 原状态，未修改文件。
3. `install-release.sh`：自动备份、安装依赖、同步插件与 Skills、验证运行时并恢复服务。

自动备份：

```text
/home/netinside/.openclaw/deploy_backups/20260817_153820_napm_1.1.0-rc.4_be7dba7b/runtime-before-deploy.tgz
```

备份的 `runtime-before-deploy.sha256` 已执行校验并通过。

### 9.3 部署后核验

- workspace 与 extension 的 `RELEASE-MANIFEST.json` 均为 `1.1.0-rc.4 / be7dba7b`。
- 活动 extension 两个插件入口与本地插件 SHA-256 一致。
- workspace Query 分类器与本地 SHA-256 一致。
- Gateway 恢复为 `active`，端口监听正常，日志出现 `gateway ready`。
- 企业微信 WebSocket 已重新连接并认证成功。
- watcher 保持部署前的 `inactive` 状态。
- 无外部消息投递的 Hook 冒烟共 9 项通过：身份分类、能力问句非对象清单、身份不要求 Skill、两个输出 Hook 保留答案、身份轮 Tool 拒绝、NAPM 后身份问答保留、真实业务清单分类保留。

### 9.4 已知独立问题

部署核验时发现 rc.3 历史日志曾出现 extension 内嵌 `timeResolver` 缺少 `ResolvedQueryTimeRangeService` 的错误。rc.4 没有修改该打包路径；统一运行时契约当前只验证 workspace Skill，没有覆盖 extension 内嵌模块的传递依赖。

该问题不影响本次纯身份/能力问答，因为身份轮禁止 Tool 调用；但在单独修复和发布前，不能把真实 `napm-skill-query` 执行视为已由本次部署验收。企业微信本轮先验收身份问题和 NAPM 后切回身份问题，普通查询运行时缺口另行处理。

### 9.5 待人工验收

服务器侧没有主动发送企业微信消息。由测试人员真实发送以下问题完成最终验收：

```text
/new
你有什么功能？

/new
你有哪些能力？

在一次已有 NAPM 对话后发送：
你能做些什么？
```
