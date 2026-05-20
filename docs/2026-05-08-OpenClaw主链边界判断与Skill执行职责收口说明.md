# 2026-05-08 OpenClaw 主链边界判断与 Skill 执行职责收口说明

## 一、本次继续收口的目标

在上一轮处理中，企业微信插件已经从“本地判断 + 本地直查”退化为以传输为主的薄接入层。

但仅仅把企微插件退下去还不够。

如果 NAPM skill 自己仍然保留下面这些模糊职责：

- 自己判断是不是边界内问题
- 自己决定是否拒答并引导
- 自己在没有 `resolvedQuery` 时继续从 raw prompt 乱猜
- 自己承接 OpenClaw 还没理解完成的问题

那么判断权仍然没有真正稳定收回到 OpenClaw 主链。

所以本次继续完成第二段收口：

**OpenClaw 主链负责边界判断 / 追问理解 / 澄清判定 / resolvedQuery 构造；Skill 只负责执行与结果契约输出。**

## 二、调整后的职责边界

### 1. OpenClaw 主链负责

- 是否属于 NAPM 领域
- 是否属于边界外问题
- 是否拒答并引导
- 是否是追问
- 是否继承上一轮上下文
- 是否需要澄清
- 形成结构化 `resolvedQuery`
- 最终中文回答组织

### 2. NAPM skill 负责

- 接收结构化 `resolvedQuery`
- 做执行前验证
- 调用 NAPM / NetInside API
- 汇总结果
- 输出 `OpenClawNarrationContract`

### 3. 企业微信插件负责

- 接消息
- 发消息
- 上下文透传
- 凭证安全拦截

## 三、本次实际修改内容

### 1. 更新 NAPM skill agent prompt

文件：

- `skills/openclaw-napm-query/agents/openai.yaml`

核心变化：

- 明确声明 **OpenClaw 是唯一的边界判断拥有者**
- 明确声明 **OpenClaw 是 follow-up / clarification / resolvedQuery 的唯一拥有者**
- 明确声明 skill 不再承担：
  - out-of-scope refusal
  - redirect guidance
  - 本地 prompt-to-query 主判

新增约束的核心意思是：

> OpenClaw 才能决定这是不是 NAPM 问题、是否要拒绝、是否是追问、是否要澄清；skill 只消费结构化结果并执行。

### 2. 更新 SKILL.md 说明

文件：

- `skills/openclaw-napm-query/SKILL.md`

补充的重点有三条：

1. OpenClaw 负责：
   - domain boundary judgment
   - follow-up understanding
   - clarification policy
   - resolvedQuery construction

2. skill 不负责：
   - 决定是否属于 NAPM 范围
   - 决定是否要拒答并引导
   - 决定短句追问是否承接上下文

3. 当 `resolvedQuery` 缺失时：
   - skill 必须返回中文决策型 fallback
   - 不能把英文技术错误直接暴露给用户
   - 不能自己偷偷从 raw prompt 再猜一轮

### 3. 更新执行器缺少 `resolvedQuery` 时的兜底行为

文件：

- `skills/openclaw-napm-query/scripts/run_napm_query.js`

新增：

- `buildMissingResolvedQueryContract(...)`

作用：

当 OpenClaw 还没有给出可执行的 `resolvedQuery` 时，skill 不再抛出英文技术错误：

原先类似：

- `Structured resolvedQuery is required in upstream-execution mode; local prompt parsing is disabled.`

现在改为统一输出中文决策结果：

- `当前这个问题还没有形成可执行的 NAPM 查询条件。`
- `请先由 OpenClaw 主链完成意图判定、范围确认或必要的澄清后，再下发 structured resolvedQuery 给 NAPM skill 执行。`

这会返回：

- `responseType = decision_result`
- `responseMode = verbatim_display_text`
- 同时保留完整 `narrationInput`

也就是说：

**就算 OpenClaw 当前轮没完成结构化理解，skill 也不会再直接吐英文底层异常给用户。**

## 四、远端真实生效位置

这次不是只改本地仓库。

由于远端实际运行的 skill 目录是：

- `/home/netinside/.openclaw/skills/openclaw-napm-query`

所以本次已同步以下真实生效文件到远端：

- `/home/netinside/.openclaw/skills/openclaw-napm-query/agents/openai.yaml`
- `/home/netinside/.openclaw/skills/openclaw-napm-query/SKILL.md`
- `/home/netinside/.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js`

## 五、远端服务处理情况

本次已执行：

```bash
systemctl --user restart openclaw-gateway.service
```

并验证：

- `openclaw-gateway.service` 已恢复 `active (running)`
- gateway 正常监听
- wecom websocket 已重新认证成功

## 六、远端实测验证结果

直接在远端运行：

```bash
node /home/netinside/.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js --prompt '什么是玫瑰'
```

返回结果不再是英文异常，而是中文决策契约：

- `error.code = UPSTREAM_RESOLVED_QUERY_REQUIRED`
- `summary.title = 还需要 OpenClaw 先完成理解`
- 中文提示 OpenClaw 需要先完成意图判定 / 范围确认 / 澄清

这说明：

**skill 已经不再尝试自己接管边界判断，而是把决策权显式还给 OpenClaw 主链。**

## 七、当前链路状态总结

截至本次收口后：

### 企业微信插件

- 不再本地语义判断
- 不再本地直连 NAPM
- 只保留凭证安全拦截

### NAPM skill

- 不再承担边界主判
- 不再承担 follow-up 主判
- 不再在 `resolvedQuery` 缺失时自行乱猜
- 专注执行与结果契约输出

### OpenClaw 主链

已经成为唯一应当负责的地方：

- 边界判断
- 拒答与引导
- 追问承接
- 澄清策略
- `resolvedQuery` 形成
- 最终叙述

## 八、这次修改解决了什么

这次不是直接“让所有边界问题都答对了”。

它解决的是更基础的结构性问题：

### 1. 避免职责继续打架

以前是：

- 企微插件判断一轮
- skill 又判断一轮
- OpenClaw 可能再判断一轮

现在继续收成：

- 企微插件不判断
- skill 不主判
- OpenClaw 主链统一判断

### 2. 避免英文技术错误直接露给用户

以前缺少 `resolvedQuery` 时，skill 会报英文执行错误；
现在改成中文决策结果，可直接被 OpenClaw 接住。

### 3. 为后续修真正的边界能力扫清入口

后续如果还出现：

- `什么是玫瑰` 还能被回答
- `需要` 没接上上文
- 泛问答没有被正确拒绝

那么排查重点就该集中在：

- OpenClaw 主链提示词
- OpenClaw 的领域边界策略
- OpenClaw 的 follow-up / clarification 策略

而不应该再优先怀疑企微插件或 skill 本地解析。

## 九、结论

本次完成的是“第二段职责回收”：

**企微插件已经退回传输层，NAPM skill 也进一步退回执行层，边界判断与会话承接权继续向 OpenClaw 主链收口。**

这意味着后面再修“边界为什么还不准”“追问为什么没接上”，终于可以在正确的层上动手了。
