# OpenClaw 身份能力问题被 NAPM 结果门禁误拦截修复方案

日期：2026-08-17
状态：`1.1.0-rc.5` 已部署测试服务器，待企业微信真实消息验收
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

## 10. rc.4 测试验收补充：能力问句同义表达

### 10.1 现场证据

rc.4 部署后的企业微信测试中，“你有什么功能？”、“你是谁？”和“你能做些什么？”正常，“你可以干什么？”被改写为通用域外提示。远端 Gateway 日志确认失败轮的状态为：

```text
platformIdentity=false
generalOutOfScope=true
napmRelated=false
```

该轮没有 NAPM Tool 调用，最终由 `before_message_write` 域外门禁覆盖原回答。远端已部署文件与本地 rc.4 插件 SHA-256 一致，最小复现同样返回 `false`。

### 10.2 原因和修复

能力问句的整句匹配仅覆盖“做/处理/回答/提供/支持”和“什么/哪些”，漏掉了口语动词“干”以及“啥/嘛/哪些事”等变体。修复不硬编码单个完整句子，而是扩展纯能力问句的句式槽位：

- 支持“干”和“啥/嘛”等口语表达；
- 支持“哪些事/事情/工作/功能/能力”等后缀；
- 支持“你都能帮我做什么”等仍然是纯能力询问的表达；
- 继续使用整句锚定，“你可以干什么来分析 239web？”等复合请求不会进入身份旁路。

### 10.3 新增回归

新增 7 个能力同义句正例、2 个复合 NAPM 请求反例，并将“你可以干什么？”纳入 `message_received -> before_prompt_build -> message_sending/before_message_write` 完整 Hook 链路验证。

验证结果：聚焦回归 55/55 通过，完整 Jest 90 个套件、653 个测试全部通过，lint、运行时契约、Node 语法和 `git diff --check` 均通过。

## 11. rc.5 测试服务器部署记录

### 11.1 发布制品

```text
版本：1.1.0-rc.5
发布提交：85f151fcecdc0086c0ee5bd32e9226ee98994765
制品：NAPM_skill-1.1.0-rc.5-85f151fc.zip
SHA-256：3fe7aefe1cf87a1006dc2bc42cbbcd9b62e8c56091d04a94be60b5f72476516b
大小：836228 bytes
```

本地构建重新执行完整 Jest 653/653、lint 和 8 个生产 Tool 运行时契约，发布包上传后的远端哈希和大小与本地一致。

### 11.2 隔离验证和安装

- `verify-staged-release.sh` 通过：Linux 生产依赖 0 个已知漏洞，插件语法和 8 个生产 Tool 全部正常。
- `install-release.sh --dry-run` 通过：确认 Gateway 为 `active`、watcher 为 `inactive`，且保留私有配置与运行数据。
- `install-release.sh` 完成：备份、同步、Linux 依赖安装、运行时校验和服务恢复均成功，未触发回退。

自动备份：

```text
/home/netinside/.openclaw/deploy_backups/20260817_161749_napm_1.1.0-rc.5_85f151fc/runtime-before-deploy.tgz
```

`runtime-before-deploy.sha256` 校验通过。

### 11.3 部署后验收

- workspace 与 extension 的 `RELEASE-MANIFEST.json` 均为 `1.1.0-rc.5 / 85f151fc`。
- 活动 extension 的 `index.js`、`napm-openclaw-plugin.remote.js` 与 staged 发布源哈希一致。
- Gateway 为 `active`，18789 端口正常监听，日志出现 `gateway ready`。
- 企业微信 WebSocket 连接与认证成功；watcher 保持部署前的 `inactive` 状态。
- 无外发 Hook 冒烟通过：7 个能力同义句进入身份路由，2 个复合 NAPM 请求保持非身份路由，身份答案未被输出 Hook 改写，身份轮 NAPM Tool 调用被拒绝。

rc.3/rc.4 已记录的 extension 内嵌时间解析依赖问题不在本次能力问句修复范围内，rc.5 不将真实 `napm-skill-query` 视为已验收。

## 12. rc.5 人工验收暴露的架构问题

### 12.1 现场现象

rc.5 企业微信人工测试中，“你可以干什么？”已经正常，但更短的身份问法“你是？”仍被改写为通用域外提示。远端日志和活动插件最小复现一致：

```text
platformIdentity=false
generalOutOfScope=true
napmRelated=false
before_message_write: rewriting assistant message for general out-of-scope request
```

本轮没有 Tool 调用。OpenClaw 模型已经拥有完整会话以及 `SOUL.md`、`IDENTITY.md` 身份上下文，错误发生在模型生成答案之后：插件输出 Hook 用确定性文案覆盖了模型答案。

### 12.2 根本原因

rc.4/rc.5 的短期修复仍然依赖封闭式身份正则。插件在两个位置使用以下补集规则：

```text
有文本 && !domainRelated && !platformIdentity
=> generalOutOfScopeRequested=true
```

这相当于要求所有合法自然语言表达都必须先被 JavaScript 正则枚举。任何尚未枚举的身份、能力、称呼、问候或省略追问，都会被当作明确域外问题。因此继续添加“你是？”等单句只能延后下一次漏判，不能根治。

### 12.3 目标职责

采用“模型理解语义，插件约束动作”的混合架构：

- OpenClaw 模型使用完整 `messages`、`SOUL.md` 和 `IDENTITY.md` 理解身份、能力、问候、省略句和澄清对话。
- 插件不再尝试用正则完整替代自然语言理解，只保留高置信度快速路径和安全执行校验。
- 语义不确定时允许模型直接文本回答或提出澄清问题。
- 动作不确定时禁止外部 Tool；NAPM Tool 只有在本轮被确定为 NAPM 候选后才能执行。

### 12.4 单轮三态策略

`message_received` 每轮只生成一次不可变 `TurnPolicy`，后续 Hook 只消费该策略：

| route | 含义 | 输出处理 | Tool 处理 |
|---|---|---|---|
| `napm_candidate` | 高置信度 NAPM/监控请求 | 继续执行现有 Skill 结果证据门禁 | 仅允许现有白名单并继续校验 `resolvedQuery`、报告来源等契约 |
| `explicit_out_of_scope` | 明确天气、娱乐、泛闲聊等域外请求 | 固定软引导回 NAPM | 禁止 Tool |
| `model_owned` | 未被高置信度规则归类的自然语言 | 不覆盖模型答案；允许模型回答或澄清 | 禁止 Tool |

身份正则命中时仍可快速标记 `platformIdentityPrompt=true`，用于注入更具体的身份提示和提前禁止 Tool；但未命中身份正则不再成为输出正确性的必要条件。“你是？”、“怎么称呼？”和“简单介绍下？”会进入 `model_owned`，由模型结合上下文回答。

### 12.5 Hook 调整

1. `message_received` 是策略所有者：基于当前用户文本和受控的明确追问关系创建 `TurnPolicy`。
2. `before_prompt_build` / `before_agent_start` 复用本轮策略，不再通过补集重新分类；只有缺少 `message_received` 状态时才创建兼容性策略。
3. `message_sending` / `before_message_write` 仅在 `explicit_out_of_scope` 或既有 NAPM 安全门禁命中时改写；`model_owned` 原样保留模型回答。
4. `before_tool_call` 对 `model_owned` 和 `explicit_out_of_scope` 都拒绝 Tool；`napm_candidate` 继续执行 Tool 白名单、专用路由、`resolvedQuery`、时间和可信结果关联校验。
5. 现有 NAPM 业务正则暂时保留，因为它们用于确定性工具路由和参数校验；本次移除的是“未命中正则即域外”的错误补集语义。

### 12.6 当前能力边界

OpenClaw 2026.3.7 当前 Hook 没有提供可验证的结构化语义路由字段，因此本次不虚构 `routingDecision` API，也不在插件内额外调用一个模型。`TurnPolicy` 是保守的本地执行策略：模型负责无动作语义回答，插件只对高置信度 NAPM 请求开放动作。

未来如果 OpenClaw 提供受信任的结构化路由结果，可将其作为 `TurnPolicy` 的输入，使模型识别出的新 NAPM 表达直接进入 `napm_candidate`；在此之前，未知表达先回答或澄清，不直接执行外部动作。

### 12.7 本轮验收标准

1. “你是？”、“您是？”、“怎么称呼？”、“简单介绍下？”无需新增身份正则也能保留模型答案。
2. NAPM 对话后的“那你呢？”不继承 NAPM 结果证据门禁。
3. “你是谁，帮我看看 239web 最近情况？”等复合请求仍为 `napm_candidate`，不能借身份表达绕过 Skill。
4. 明确天气和娱乐请求仍进入 `explicit_out_of_scope` 并由两个输出 Hook 软引导。
5. `model_owned` 与 `explicit_out_of_scope` 轮均禁止 Tool 动作。
6. 真实 NAPM 查询、对象清单、告警、报告、故障诊断及结果证据门禁保持原行为。
7. 聚焦测试、完整 Jest、lint、运行时契约、Node 语法和 `git diff --check` 全部通过。

### 12.8 本地实施结果

实现已在 `codex/model-owned-turn-routing` 分支完成，未提交、未打包、未部署：

- 新增不可变三态 `TurnPolicy`，`message_received` 每轮创建一次，后续 Prompt 与 Tool Hook 复用同一策略。
- 删除两个“非 NAPM 且非身份即域外”的补集判断；`generalOutOfScopeRequested` 现在只由明确域外分类产生。
- 未修改身份正则来适配“你是？”。回归测试明确断言该文本仍未命中 `isPlatformIdentityPrompt()`，但会进入 `model_owned` 并保留模型答案。
- `model_owned` Prompt 注入完整上下文语义提示，允许模型直接回答身份、能力、称呼、问候、省略追问或提出澄清问题。
- `model_owned` 和 `explicit_out_of_scope` 在 `before_tool_call` 均禁止所有 Tool；`napm_candidate` 继续使用既有专用 Tool 路由和结构化参数校验。
- 两个输出 Hook 对 `model_owned` 不再执行 NAPM 结果证据或域外文案覆盖；明确天气/娱乐请求仍固定软引导。
- 日志新增 `route=model_owned|explicit_out_of_scope|napm_candidate`，便于远端验收直接核对单轮策略。

测试先在 rc.5 代码上稳定得到 6 条失败，证明复现了未枚举身份表达和模型托管轮错误放行 Tool；实现后结果为：

```text
身份/域外聚焦回归：64/64 通过
NAPM 插件专项回归：28 suites、221/221 通过
完整 Jest：90 suites、662/662 通过
npm run lint：通过
npm run verify:runtime-contract：8 个生产 Tool 全部通过
Node 语法检查：通过
补集规则静态检索：0 处
git diff --check：通过
```

## 13. rc.6 测试服务器部署记录

### 13.1 发布制品

```text
版本：1.1.0-rc.6
发布提交：1a9a0c0747e27b6067cd179d8752493aa2c5279c
制品：NAPM_skill-1.1.0-rc.6-1a9a0c07.zip
SHA-256：c85126dd530b86a5fb01d736f4c7c6d14273fb612a9c597104972a0bfd1fc003
大小：837645 bytes
```

构建从已 fast-forward 合入 `main` 的干净提交归档，自动重新执行完整 Jest 662/662、lint 和 8 个生产 Tool 运行时契约。上传到测试服务器后的 SHA-256 与本地完全一致。

### 13.2 隔离验证和安装

- 候选版本解压到独立 release 目录，`verify-staged-release.sh` 验证通过：Linux 生产依赖 0 个已知漏洞，插件语法和 8 个生产 Tool 均正常。
- `install-release.sh --dry-run` 确认 Gateway 为 `active`、watcher 为 `inactive`，部署目标和受保护运行文件符合预期，未修改活动目录。
- `install-release.sh` 完成自动备份、全量同步、Linux 依赖安装、活动运行时校验和服务恢复，未触发回退。

自动回滚备份：

```text
/home/netinside/.openclaw/deploy_backups/20260817_170120_napm_1.1.0-rc.6_1a9a0c07/runtime-before-deploy.tgz
SHA-256：b9e979be8200a1e867913a1bd9260a505b015d8c483cd22632d9bef9e82db3a7
```

备份实算哈希与 `runtime-before-deploy.sha256` 记录一致。

### 13.3 部署后核验

- workspace 与 extension 的 `RELEASE-MANIFEST.json` 均为 `1.1.0-rc.6 / 1a9a0c07`。
- 活动 extension 的 `index.js` 和 `napm-openclaw-plugin.remote.js` SHA-256 均为 `5a13522b8f3e88f8d6d8da3bfe8959358acbb2c9f903406671c24a0ae302a33e`，与 staged 发布源一致，并包含三态 `TurnPolicy`。
- Gateway 为 `active`，18789 在本机 IPv4/IPv6 正常监听，启动日志出现 `gateway ready`。
- 企业微信 WebSocket 已连接并显示 `Authentication successful` / `Authenticated`。
- watcher 保持部署前的 `inactive` 状态。

活动 extension 无外发 Hook 冒烟通过：

1. “你是？”进入 `MODEL-OWNED NON-ACTION TURN`，`message_sending` 和 `before_message_write` 均保留模型答案。
2. “今天天气怎么样？”进入 `EXPLICIT OUT-OF-SCOPE NON-ACTION TURN`，两个输出 Hook 均返回固定软引导。
3. “你是？顺便看看 239web 最近情况。”进入 NAPM Tool 路由，无本轮结果时继续返回 Skill-required 提示。
4. `model_owned` 轮尝试调用 `napm-skill-query` 被 `before_tool_call` 拒绝。

服务器侧未主动发送企业微信消息。`v1.1.0-rc.6` 标签等待真实企业微信人工验收通过后创建。
