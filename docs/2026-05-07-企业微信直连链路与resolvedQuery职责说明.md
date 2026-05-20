# 2026-05-07 企业微信直连链路与 resolvedQuery 职责说明

## 一、当前结论

当前项目已经明确采用如下职责边界：

- OpenClaw 负责自然语言理解
- OpenClaw 负责产出结构化 `resolvedQuery`
- Skill 只负责消费 `resolvedQuery` 并执行 NAPM 查询
- Skill 不再承担本地 prompt 解析职责

本次排查的核心结论是：

**当前企业微信入口中的 NAPM 直连链路，没有把 OpenClaw 产出的 `resolvedQuery` 传给 Skill。**

## 二、为什么会出现这个问题

### 1. 设计上的理想链路

理想链路应为：

1. 企业微信收到用户消息
2. OpenClaw 理解问句
3. OpenClaw 产出结构化 `resolvedQuery`
4. 企业微信插件把 `resolvedQuery` 传给 `run_napm_query.js`
5. Skill 执行 NAPM 查询并返回结构化结果
6. 企业微信插件把结构化结果整理成最终用户回复

### 2. 当前实际链路

当前远端企业微信插件中存在一段 NAPM 直连逻辑：

- 识别消息像 NAPM 问题
- 直接走 `NAPM direct-skill route`
- 调用 `requestNapmSkillQuery(...)`

但当前传入参数只有：

```json
{
  "userQuery": "...",
  "clarificationContext": "...",
  "chatId": "...",
  "sessionKey": "...",
  "conversationId": "..."
}
```

没有：

```json
{
  "resolvedQuery": { ... }
}
```

这意味着：

- 直连逻辑把自然语言原文直接塞给了 Skill
- 跳过了“OpenClaw 先理解并产出 `resolvedQuery`”这一步

## 三、这和企业微信插件是什么关系

这里要区分两件事：

### 1. 谁负责理解语义

按当前架构，负责理解语义的是 OpenClaw，而不是企业微信插件。

### 2. 谁负责把结构化结果带给 Skill

当前实际调用 Skill 的是企业微信插件中的 `requestNapmSkillQuery(...)`。

因此企业微信插件必须负责把以下内容一并透传给 Skill：

- `resolvedQuery`
- 可选的 `decision`
- 可选的 `intent`
- 可选的 `session`

所以企业微信插件**不是语义所有者**，但它是**执行入参透传者**。

## 四、为什么不能让 Skill 自己补做 prompt 解析

本项目当前已经明确不走这个方向，原因有三：

1. 责任边界会重新混乱
   - OpenClaw 与 Skill 都在做自然语言理解，职责重叠

2. 运行结果会不稳定
   - 企业微信链路和其他链路可能产生两套不同的 query 解析逻辑

3. 不符合当前项目的收口方向
   - 当前正式口径已经是“OpenClaw 输出结构化 `resolvedQuery`，Skill 只执行”

因此本次排查中，已明确不恢复 Skill 本地 prompt 解析链路。

## 五、为什么会出现“思考过程外露”

出现如下内容：

- 我先试试
- 让我看看
- 根据 skill 文档
- 密码需要 URL 编码
- 返回 400 / 403

并不是正常 NAPM 最终回答，而是异常回退产物。

根因链路如下：

1. 企业微信插件把裸 `userQuery` 直接传给 Skill
2. Skill 按当前契约要求，缺少 `resolvedQuery`，执行失败
3. 插件失败后回退到通用 agent / 自由回答链路
4. 通用链路把中间思考和试探过程直接输出给了用户

## 六、本次已经完成的止血措施

虽然结构化 `resolvedQuery` 透传链路还未完全补齐，但本次已经先完成一层止血：

### 1. 企业微信插件失败时不再直接回退到自由思考输出

已在远端插件中增加保护：

- Skill 执行失败时，返回固定失败说明
- 不再把通用推理过程直接暴露给用户

### 2. 结果润色时增加“过程泄漏”识别

若 OpenClaw 结果润色返回中出现明显过程性表达，例如：

- 我先
- 让我
- 试试
- 看起来
- URL 编码
- 返回 400 / 403
- 密码是

则插件放弃使用该润色文本，退回确定性结果输出。

## 七、当前真正待修的点

当前真正需要修的是：

### 1. 企业微信插件在 NAPM 直连链路中，必须先拿到 `resolvedQuery`

也就是：

- 不能直接 `requestNapmSkillQuery({ userQuery })`
- 必须先得到结构化 `resolvedQuery`
- 再调用 `requestNapmSkillQuery({ resolvedQuery, ... })`

### 2. 当前插件中只有“自然语言回复桥”，没有“结构化 resolvedQuery 桥”

当前插件可见能力是：

- `runOpenClawPrompt(prompt)`  
  这个桥返回的是文本回复，不是结构化对象

这说明当前企业微信插件虽然能让 OpenClaw“说一句话”，但还没有一个现成桥可以稳定拿到：

- `resolvedQuery`
- `decision`
- `intent`

因此当前问题不是“参数漏传一行”这么简单，而是：

**企业微信插件侧还缺一个结构化 NAPM 调用前置桥。**

## 八、下一步建议方向

后续应按以下方向继续收口：

### 方案 A：补企业微信插件的结构化桥

在企业微信插件里新增一条专门能力：

1. 用户问句进入 NAPM 直连逻辑
2. 先向 OpenClaw 请求结构化 NAPM 结果
3. 取回 `resolvedQuery`
4. 再调用 Skill

这是最符合当前架构设计的方案。

### 方案 B：取消企业微信插件中的 NAPM 直连特判

如果不想在企业微信插件层继续维护 NAPM 特殊链路，也可以考虑：

1. 移除 NAPM 直连逻辑
2. 全部回到 OpenClaw 主链统一调度
3. 由 OpenClaw 主链决定何时生成 `resolvedQuery`、何时调用 Skill

此方案更干净，但改动面更大。

## 九、最终结论

本次排查的最终结论如下：

1. `resolvedQuery` 的确应该由 OpenClaw 理解后产生
2. Skill 不应再恢复本地 prompt 解析
3. 当前异常的根因，是企业微信插件中的 NAPM 直连逻辑跳过了 `resolvedQuery` 生成步骤
4. 当前企业微信插件只是把裸 `userQuery` 传给 Skill，导致 Skill 按契约失败
5. “思考过程外露”是失败后的回退副作用，不是正常回答路径
6. 当前最正确的修法，是补企业微信插件侧的结构化 `resolvedQuery` 透传桥，而不是回退 Skill 职责边界
