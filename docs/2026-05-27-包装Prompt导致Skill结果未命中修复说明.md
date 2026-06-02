# 2026-05-27 包装 Prompt 导致 Skill 结果未命中修复说明

## 问题现象

用户询问：

```text
现在丢包最严重的前10个IP都有谁？
```

系统最终多次返回：

```text
当前问题必须经 NAPM skill 执行后才能回答。
本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。
请以技能执行结果为准。
```

## 实际日志结论

远端日志显示 skill 并非未执行：

- `napm-skill-query` 最终被调用。
- resolvedQuery 为 `topValues + IPAddress + PLI/PLO + topCount=10`。
- 南向 API 请求已构造。
- `napm_metric_execution_completed rowCount=10`。
- `napm_skill_execution_completed ok=true rowCount=10`。

因此根因不是“无数据”或“skill 没查”，而是最终输出阶段没有命中已成功的 skill 结果。

## 根因

OpenClaw 在 tool 调用阶段把 prompt 包装成：

```text
Conversation info (untrusted metadata):
...
Sender (untrusted metadata):
...
现在丢包最严重的前10个IP都有谁？
```

plugin 将这整段文本作为 prompt/cache key，导致：

- skill 成功结果被记到“包装 prompt”下面。
- final 输出阶段按真实用户问题查缓存时找不到记录。
- `message_sending/before_message_write` 继续走 skill-required 保护文案。
- 多个 final/stream 事件重复经过该逻辑，造成保护文案重复发送。

## 修改内容

文件：

- `napm-openclaw-plugin.remote.js`

新增：

- `extractUserPromptFromWrappedContext(text)`
- `normalizeUserPromptText(value)`

接入位置：

- `normalizePrompt()`
- `normalizePromptKey()`
- `selectActivePromptText()`
- `rememberSkillResult()`
- `rememberDebugApi()`
- `getRememberedSkillResult()`
- `getRememberedRecordForPrompt()`

现在只要文本包含 OpenClaw 注入的 `Conversation info` / `Sender` 包装，就会提取最后的真实用户问题作为统一 prompt。

## 验证

已通过：

```bash
node --check napm-openclaw-plugin.remote.js
node --check .codex-temp/napm-openclaw-plugin.remote.js
npx jest test/napm-openclaw-plugin-hierarchy-guard.test.js --runInBand
npx jest test/napm-openclaw-plugin-hierarchy-guard.test.js test/napm-openclaw-plugin-business-inventory-guard.test.js test/napm-openclaw-plugin-composite-application-inventory-guard.test.js test/napm-openclaw-plugin-meta-followup-guard.test.js test/napm-openclaw-plugin-streaming-guard.test.js --runInBand
```

新增回归覆盖：

- wrapped prompt 能净化为真实用户问题。
- skill result 用 wrapped prompt 写入后，可以用 raw prompt 命中缓存。

## 修复后的链路

```text
用户问题
 -> OpenClaw 包装上下文
 -> plugin 提取真实用户问题
 -> napm-skill-query 成功执行
 -> skill 结果按真实用户问题写入缓存
 -> final 阶段按真实用户问题命中缓存
 -> 输出 skill displayText
```
