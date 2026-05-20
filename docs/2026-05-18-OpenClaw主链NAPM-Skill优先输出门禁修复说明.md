# 2026-05-18 OpenClaw主链 NAPM Skill 优先输出门禁修复说明

## 1. 背景

企业微信侧仅作为传输层，不承载任何 NAPM 路由、推理约束或结果改写逻辑。

本次问题出现在 OpenClaw 主链：

- 用户问的是 NAPM 相关问题或其追问
- 主链没有先稳定调用 `napm-skill-query`
- 模型先输出了自由推理、临时脚本、重试过程
- 现有插件只能在 `before_tool_call` 阶段拦工具，或在消息发出前做补救
- 当模型先输出文本、后续又没有有效 remembered skill result 时，就会出现越界答复

典型异常表现包括：

- “我写了 Node.js 脚本”
- “我直接调用 NapmMetadataService”
- “我重试了一次”
- “这次用了 8 秒，时间花在写脚本/解析 JSON 上”

这些都不属于项目允许暴露给用户的正式答复。

## 2. 修复目标

只改 OpenClaw 主链 / NAPM 路由插件，不修改企业微信传输层。

修复后需保证：

1. NAPM 相关问题必须以 `napm-skill-query` 结果或固定安全兜底文案作为最终输出来源。
2. 不允许向用户暴露主链自由推理、临时脚本、重试过程。
3. NAPM 元追问也必须继承上一轮 NAPM 上下文，而不是退化成普通闲聊或泛问答。

## 3. 本次修改范围

修改文件：

- `napm-openclaw-plugin.remote.js`
- `.codex-temp/napm-openclaw-plugin.remote.js`
- `test/napm-openclaw-plugin-streaming-guard.test.js`
- `test/napm-openclaw-plugin-meta-followup-guard.test.js`

未修改：

- 企业微信侧
- 传输层配置
- NAPM skill 执行器业务逻辑

## 4. 核心改动

### 4.1 新增 NAPM 元追问识别

新增：

- `isNapmMetaFollowUpPrompt(prompt, previousState)`

覆盖问法包括：

- “你这次用了多长时间”
- “时间都消耗在哪里了”
- “你构成 api 的思路是什么”
- “方法来源是哪里”
- “最终 api 返回给我”

规则：

- 如果当前 prompt 命中“思路 / 来源 / API / 参数 / 耗时”等元追问信号
- 且上一轮上下文已经是 NAPM / system-monitoring 相关
- 则当前轮继续按 NAPM 问题处理

### 4.2 新增越界过程文本识别

新增：

- `looksLikeNapmBypassProcessText(text)`

拦截信号包括：

- `Node.js 脚本`
- `python3`
- `grep`
- `bash`
- `NapmMetadataService`
- `单例导出`
- `重试`
- `getDrilldownPathsForGroupType`

目的：

- 阻止 OpenClaw 主链把本地排查过程、调试过程、临时脚本过程直接发给用户

### 4.3 新增统一 skill-backed 输出门禁

新增：

- `shouldRequireSkillBackedReply(activePrompt, guardState, rememberedRecord)`
- `buildSkillRequiredReply()`

门禁覆盖：

- overview
- hierarchy / drilldown catalog
- metric inventory
- business object inventory
- NAPM 元追问
- 以及任意 `napmRelated` 但当前还没有 remembered skill result 的场景

### 4.4 强化 `message_sending`

在 `message_sending` 中补充：

1. 如果命中越界过程文本：
   - 优先尝试用 remembered skill result 替换
   - 再尝试 `buildAsyncRefreshedReplyText(...)`
   - 再尝试 `buildGenericNapmSkillRefreshText(...)`
   - 仍失败则返回固定 skill-required 兜底文案

2. 如果命中 NAPM 且当前轮必须 skill-backed，但没有 remembered skill result：
   - streaming preview 直接 `cancel`
   - final message 先尝试刷新 skill 结果
   - 仍失败则返回固定 skill-required 兜底文案

### 4.5 强化 `before_message_write`

在最终 assistant 消息写入前增加第二道保险：

- 若文本命中越界过程文本，直接改写为 remembered skill result 或固定兜底文案
- 若当前 prompt 必须 skill-backed 但没有 remembered skill result，直接改写为固定兜底文案

## 5. 为什么这次修复可行

本次修复没有引入新架构，完全复用现有主链能力：

1. 已有 `runSkillExecutor(...)`
2. 已有 `rememberSkillResult(...)`
3. 已有 `buildAsyncRefreshedReplyText(...)`
4. 已有 `buildGenericNapmSkillRefreshText(...)`
5. 已有 `message_sending` 和 `before_message_write` 两层消息改写钩子

因此本次不是重构传输链路，而是在主链上把“建议先走 skill”升级成“输出必须 skill-backed”。

## 6. 验证结果

已通过以下测试：

```bash
npm test -- --runInBand test/napm-openclaw-plugin-streaming-guard.test.js test/napm-openclaw-plugin-hierarchy-guard.test.js test/napm-openclaw-plugin-meta-followup-guard.test.js test/napm-openclaw-plugin-overview-guard.test.js
```

结果：

- `test/napm-openclaw-plugin-streaming-guard.test.js` 通过
- `test/napm-openclaw-plugin-hierarchy-guard.test.js` 通过
- `test/napm-openclaw-plugin-meta-followup-guard.test.js` 通过
- `test/napm-openclaw-plugin-overview-guard.test.js` 通过

共计：

- 4 个测试套件通过
- 12 个测试用例通过

## 7. 修复后的边界

修复后系统行为应收敛为：

1. NAPM 问题：
   - 必须先依赖 skill 结果或 skill 刷新结果
   - 不能直接发主链自由推理

2. NAPM 元追问：
   - 继续按 NAPM 问题处理
   - 不允许退化成普通闲聊或普通泛问答

3. 企业微信：
   - 仅负责传输
   - 不承担任何业务判断与防线

## 8. 后续建议

虽然本次已经把主链输出门禁补齐，但仍建议后续继续完善：

1. 将 “API 构造说明 / 方法来源 / 耗时解释” 正式收口为 skill 内标准能力，而不是只靠主链门禁兜住。
2. 继续补事故回放用例：
   - `业务组都有什么下钻路径`
   - `你这次用了多长时间？时间都消耗在哪里了？`
   - `你构成api的思路是什么和方法来源是哪里 最终的api返回给我`
3. 发布前再补跑整组 NAPM 插件 guard 测试，确保无旁路回归。
