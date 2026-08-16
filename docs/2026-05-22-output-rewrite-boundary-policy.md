# NAPM 输出纠偏边界收口记录

日期：2026-05-22

## 背景

本次处理的问题是：NAPM 查询结果已经由 skill 生成 `displayText` / `narrationStructure`，但企业微信 plugin 仍会在 `message_sending`、`before_message_write` 等 hook 中再次组织、刷新或替换业务答案。

这种结构会导致三类问题：

- skill 查到的数据和最终用户看到的答案可能不是同一个层直接产出的。
- 同一个问题可能被 skill、OpenClaw、plugin 多次解释和改写。
- 排查时难以判断是 resolvedQuery、skill 查询、narration contract，还是 plugin hook 出了问题。

## 修改原则

新的边界策略是：

- skill / OpenClaw 负责业务答案产出。
- plugin 不再根据 `narrationStructure`、缓存结果或 prompt 自行拼接业务答案。
- plugin 只保留安全保护能力，例如越界拦截、内部推理泄露拦截、缺少有效 skill 结果时的保护提示。

## 本次修改

### 1. plugin 不再二次组织 skill 业务答案

`buildUserFacingSkillText()` 现在只透传以下已成型文本：

- `result.displayText`
- `result.summary.displayText`
- `result.replyText`

如果 skill 只返回 `narrationStructure`，plugin 不再基于它拼接 TopN、指标清单、丢包结论或通用摘要。

这意味着 `narrationStructure` 应作为 OpenClaw narration 输入，而不是 plugin 的二次模板输入。

### 2. message_sending 不再异步刷新并替换最终回复

`message_sending` 中移除了对以下刷新路径的实际调用：

- `buildAsyncRefreshedReplyText()`
- `buildGenericNapmSkillRefreshText()`

之前这些路径会在模型输出看起来不理想时，重新执行 overview、hierarchy、metric inventory、business inventory 等查询，并用 plugin 生成的新文本替换最终回复。

现在该 hook 不再补查、不再补写业务答案。若检测到内部推理泄露或 NAPM 问题缺少有效 skill 结果，只返回保护提示：

```text
当前问题必须经 NAPM skill 执行后才能回答。
本轮未拿到有效 skill 结果，因此不展示主链推理、临时脚本或排查过程。
请以技能执行结果为准。
```

### 3. before_message_write 不再做业务纠偏

`before_message_write` 中关闭了两类业务改写：

- 不再用 remembered skill result 重新生成 prompt-scoped 回复。
- 不再识别错误的 BusinessGroup 指标清单后，用 plugin 内置分类模板替换答案。

保留的能力只包括：

- NAPM 越界问题重定向。
- 通用越界问题重定向。
- 内部推理 / 绕 skill 过程泄露时，优先回填已记录的 skill displayText；没有可核验 skill 结果时返回保护提示。
- “你刚才怎么查的”这类链路追问只基于已记录 skill 结果回答，不补写未被日志证明的过程。

### 4. 测试契约同步

已将相关测试从“plugin 应该重写业务答案”调整为“plugin 不应覆盖最终答案”：

- `test/napm-openclaw-plugin-metric-inventory-guard.test.js`
- `test/napm-openclaw-plugin-overview-guard.test.js`
- `test/napm-openclaw-plugin-hierarchy-guard.test.js`

## 修改后的正确链路

```text
用户问题
  -> OpenClaw / mainflow 构造 resolvedQuery
  -> napm-skill-query 执行查询
  -> skill 返回 displayText 或 narrationStructure
  -> OpenClaw 基于 skill 数据生成最终叙述
  -> plugin 只做安全守卫，不再二次改写业务答案
```

## 验证结果

已执行全量测试：

```bash
npm test -- --runInBand
```

结果：

```text
Test Suites: 28 passed, 28 total
Tests:       169 passed, 169 total
```

## 后续建议

- 后续若仍出现“skill 查到的数据和用户看到的答案不一致”，优先检查 OpenClaw narration 层，而不是 plugin。
- 可以继续做物理清理，将已停用的旧刷新函数和旧输出模板函数从 plugin 文件中删除，减少误用风险。
- 建议增加一条链路日志：记录最终回复使用的是 `displayText`、`summary.displayText`、`replyText`，还是 OpenClaw narration 生成文本，方便定位最终答案来源。
