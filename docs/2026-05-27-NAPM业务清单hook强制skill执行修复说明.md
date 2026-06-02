# NAPM 业务清单 hook 强制 skill 执行修复说明

日期：2026-05-27

## 背景

用户在企业微信中询问：

```text
系统中有哪些业务？
```

修复前，插件已经能识别这是 NAPM 相关问题，并能拦截模型绕过主链路的错误回答。但当本轮没有拿到有效 `napm-skill-query` 执行结果时，最终只返回保护文案：

```text
当前问题必须经 NAPM skill 执行后才能回答。
本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。
请以技能执行结果为准。
```

这说明“防错”已经生效，但“补齐主链执行”没有生效。

## 问题定位

本轮问题不是 `NapmResolvedQueryResolverService` 对“业务”的语义解析错误。

本地验证：

```js
resolvePrompt('系统中有哪些业务？')
```

能够正确产出：

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "groups": [
    {
      "type": "WebApplication"
    }
  ],
  "semanticConstraints": {
    "operation": "metadata_list",
    "workflowType": "object_inventory",
    "targetObjectType": "WebApplication"
  }
}
```

正确查询口径仍是：

```text
WebApplication 业务系统清单
-> groups metadata
-> NapmMetadataService.listObjectInstances('WebApplication')
-> 南向 applications 目录
-> application Type=3
```

问题出在 OpenClaw 本轮没有让模型成功调用 `napm-skill-query`，而插件的 `message_sending` hook 在无 remembered skill record 时只做了阻断，没有主动触发项目内 skill 执行。

## 根因

当前链路存在这个缺口：

```text
用户问题
-> plugin hook 识别为 NAPM/业务清单问题
-> 模型没有成功调用 napm-skill-query
-> message_sending 发现没有 rememberedRecord
-> 返回 buildSkillRequiredReplyForPrompt()
```

因此用户看到的是保护文案，而不是查询结果。

这不是直接 API、curl、python 旁路问题，也不是需要让模型重新猜查询过程的问题。正确修复点是在插件边界内，当模型没有调到工具时，由插件用项目内已有 resolver 和 skill executor 强制完成主链执行。

## 修改方案

### 1. 新增 hook 内部 skill 执行入口

文件：

```text
napm-openclaw-plugin.remote.js
```

新增：

```js
shouldExecuteSkillFromHook(activePrompt, guardState, rememberedRecord)
executeSkillFromHook(activePrompt, ctx, api, reason)
```

执行逻辑：

```text
activePrompt
-> resolvePromptWithAudit()
-> validateResolvedQueryAgainstSpec()
-> validateObjectInventoryResolvedQuery()
-> validateCompositeApplicationInventoryResolvedQuery()
-> runSkillExecutor()
-> rememberDebugApi()
-> rememberSkillResult()
-> makeTextReplyFromSkillResult()
```

这样仍然走项目内主链：

```text
OpenClaw/plugin boundary
-> NapmResolvedQueryResolverService
-> resolvedQuery
-> NAPM skill executor
-> RequirementParserService / MetadataExecutionKernel
-> NapmMetadataService
```

不会走外部 curl、python、本地临时脚本。

### 2. 在 message_sending 中补齐执行

原逻辑：

```text
requiresSkillBackedReply && !rememberedRecord
-> 返回“必须经 NAPM skill 执行”
```

新逻辑：

```text
requiresSkillBackedReply && !rememberedRecord
-> 非流式最终消息
-> executeSkillFromHook()
-> 成功则返回 skill displayText
-> 失败才返回保护文案
```

同时对绕过过程叙述类消息也增加同样处理，避免模型说“链路不支持列表查询”“我直接 curl/python 查了”等内容时只被动拦截。

### 3. 增加执行中锁

新增：

```js
const napmSkillExecutionInFlight = new Map();
```

作用：

```text
同一 conversation + prompt 范围内，如果已有 hook 触发的 skill 执行正在进行，则复用同一个 Promise，避免重复执行。
```

### 4. 执行成功后更新 guard 状态

执行成功后设置：

```js
turnNapmToolUsed: true
```

这样后续元问题，例如：

```text
这次你是怎么查询的？
```

可以基于 remembered skill record 回答，不再编造 curl/python/drilldownCatalog/overview 等过程。

### 5. 修复远端 index.mjs 加载方式

本次部署时发现远端 OpenClaw 优先加载：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs
```

如果直接把 CommonJS 主体覆盖为 `.mjs`，会报错：

```text
ReferenceError: require is not defined
```

因此新增：

```text
napm-openclaw-plugin.index.mjs
```

作为 ESM wrapper：

```text
index.mjs
-> createRequire()
-> require('./index.js')
-> export default plugin
-> export register/id/name/description
```

远端保持：

```text
index.js   = CommonJS 插件主体
index.mjs  = ESM wrapper
package.json type = commonjs
```

## 修改文件

```text
napm-openclaw-plugin.remote.js
napm-openclaw-plugin.index.mjs
test/napm-openclaw-plugin-business-inventory-guard.test.js
openclaw.plugin.json
```

说明：

```text
openclaw.plugin.json 中移除了 activation.onStartup，仅保留 onCapabilities: ["tool", "hook"]。
这是前一轮为修复插件 hook 注册/激活链路做的调整，本次部署一并保留。
```

## 回归测试

本地执行：

```powershell
node --check napm-openclaw-plugin.remote.js
npx jest test/napm-openclaw-plugin-business-inventory-guard.test.js test/napm-openclaw-plugin-composite-application-inventory-guard.test.js test/napm-openclaw-plugin-meta-followup-guard.test.js test/napm-openclaw-plugin-streaming-guard.test.js --runInBand
```

结果：

```text
Test Suites: 4 passed, 4 total
Tests:       24 passed, 24 total
```

新增测试覆盖：

```text
当“系统中有哪些业务？”没有 remembered skill result，且模型输出“当前链路不支持列表查询”等错误内容时，message_sending 会主动执行 resolver + skill，并返回 skill 结果，而不是返回保护文案。
```

## 远端部署

远端主机：

```text
101.254.114.237
```

部署路径：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/package.json
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/openclaw.plugin.json
```

部署后执行：

```bash
openclaw plugins registry --refresh --json
systemctl --user restart openclaw-gateway.service
```

服务状态：

```text
openclaw-gateway.service: active
```

远端启动日志确认：

```text
http server listening (2 plugins: napm-openclaw-plugin, wecom-openclaw-plugin; ...)
```

说明插件已恢复加载。

## 预期效果

用户询问：

```text
系统中有哪些业务？
```

预期链路：

```text
message_received
-> before_prompt_build 注入 NAPM routing policy
-> message_sending 发现必须 skill-backed 且无 rememberedRecord
-> executeSkillFromHook()
-> resolvePromptWithAudit()
-> runSkillExecutor()
-> rememberSkillResult()
-> 返回 skill displayText
```

预期回答应为 WebApplication 业务系统清单，并包含类似口径：

```text
系统中目前有 N 个业务系统（WebApplication，applications Type=3）
查询口径：南向 applications 目录，按 Type=3 识别 WebApplication/业务系统；
这不是按流量活跃度过滤，也不是中文名称过滤。
```

不应再出现：

```text
当前问题必须经 NAPM skill 执行后才能回答。
本轮未拿到有效 skill 结果。
```

除非 resolver 或 skill executor 本身执行失败。

## 后续观察点

测试时可关注远端 audit 日志是否出现：

```text
napm_plugin_hook_forced_skill_execution_started
napm_resolver_resolved_query_created
napm_plugin_skill_executor_invoked
napm_plugin_skill_executor_completed
napm_plugin_hook_forced_skill_execution_completed
```

如果仍然没有返回业务清单，应优先看：

```text
1. hook 是否命中 message_sending
2. resolver 是否产出 groups/WebApplication
3. runSkillExecutor 是否报错
4. skill 返回 displayText 是否为空
5. before_message_write 是否又把结果改写掉
```

