# 2026-05-13 OpenClaw LLM resolvedQuery 改造清单与可行性评审

最后更新：2026-05-13

## 一、这次改造要解决什么问题

当前项目虽然已经明确了总体职责分层：

- WeCom / 企业微信插件负责接入、发送、结果保护
- OpenClaw 主链负责理解、决策、追问、澄清、resolvedQuery 构造
- Skill 负责执行查询与输出 narration contract

但现实代码中，仍然存在一部分“语义理解”被插件和 Skill 本地规则提前接管的情况，例如：

- overview 问法由插件本地构造 resolvedQuery
- 指标清单问法由插件本地构造 resolvedQuery
- “丢包率最高的 IP 是谁”这类问法由插件本地构造 resolvedQuery
- Skill 仍保留部分 prompt fallback

这会带来四类问题：

1. 语义理解权分散，真实主链不清晰
2. 插件层特例越积越多，容易越改越乱
3. 同一问题可能被多层重复理解、重复执行，导致慢
4. LLM 实际没有稳定承担“结构化理解”职责

本次改造的目标不是“让 LLM 自由发挥”，而是：

**让 OpenClaw LLM 负责语义理解与 resolvedQuery 生成，但必须在明确规则约束下生成；插件和 Skill 只保留守卫、约束和执行能力。**

---

## 二、目标链路

目标链路应收口为：

```text
企业微信用户
  -> wecom-openclaw-plugin
  -> OpenClaw 主链 + LLM
  -> 产出 structured resolvedQuery
  -> napm-openclaw-plugin
  -> openclaw-napm-query skill
  -> NAPM / NetInside API
  -> narration contract
  -> OpenClaw / WeCom 最终中文回复
```

各层职责如下：

### 1. WeCom / napm-openclaw-plugin

负责：

- 通道接入
- 工具调用守卫
- streaming / thinking 泄露防护
- 结果回写保护
- 对 NAPM 范围问题强制走 `napm-skill-query`

不负责：

- 长期维护业务语义特例
- 从自然语言直接构造业务查询 resolvedQuery
- 替代 OpenClaw 主链做对象判断、指标判断、追问判断

### 2. OpenClaw + LLM

负责：

- 识别是否属于 NAPM 域
- 判断是否需要澄清
- 判断 follow-up / continuation
- 依据规则生成 structured resolvedQuery
- 对结果进行最终自然语言组织

### 3. Skill

负责：

- 校验 resolvedQuery 是否结构合法
- 应用静态规则约束
- 调用 NAPM API
- 处理执行期 fallback
- 输出 narration contract

不负责：

- 从裸 prompt 重新主导语义理解
- 在缺失 resolvedQuery 时长期兜底猜业务意图

---

## 三、LLM 可以并且应该被限制

答案是：**可以，而且必须限制。**

正确做法不是“相信 LLM 一定会理解对”，而是做三层控制：

### 第一层：Prompt / policy 约束

在 OpenClaw LLM 侧明确告知：

- `业务` 默认映射 `WebApplication`
- `业务组 / 工作组 / 分组` 映射 `BusinessGroup`
- `应用 / 已知应用 / 协议应用` 映射 `DefinedApp`
- `overview` 只能落到预定义 scene
- `topValues / averageValues / timeValues` 只允许合法组合
- plain “丢包率最高的 IP 是谁” 默认按 `PLI/PLO` 本身排序，不要擅自改成 `TPIO`

也就是说：

**LLM 只能在我们给定的语义边界内做结构化选择，而不是自由发明 query。**

### 第二层：代码静态校验

即便 LLM 产出了 resolvedQuery，也必须再过一层代码校验，例如：

- group type 是否在允许列表中
- metric 是否有效
- metric 与 object 是否兼容
- service 与 metric / groups / timeRange 是否匹配
- overviewScene 是否属于白名单
- topMetric 是否与用户意图或显式规则冲突

这一层应由当前已有的：

- `RequirementParserService`
- `DimensionMappingService`
- `QueryMetadataConstraintService`
- `MetricMappingService`

继续承担。

### 第三层：执行期保护

即便结构合法，也可能上游不支持，所以执行期仍要保留：

- upstream 400/403/空结果判断
- 多层路径 fallback
- clarification / executionGuard
- narration contract 输出

所以最终模式是：

**LLM 生成候选 resolvedQuery，代码决定它能不能落地执行。**

---

## 四、这次改造的实施清单

### 阶段 A：收口插件侧业务特例

目标：

- 去掉插件长期维护的业务语义 resolvedQuery 特例
- 保留工具守卫与结果保护

本阶段处理项：

1. 下掉 `buildPacketLossClientTopResolvedQuery()` 对自然语言特例的主路径依赖
2. 去掉插件对“丢包最高 IP”问题的消息发送前二次强制刷新
3. 保留 overview / metric inventory 的临时兜底，但标记为后续继续收口对象
4. 插件继续保留：
   - `before_tool_call` 守卫
   - streaming preview cancel
   - before_message_write 保护

### 阶段 B：收口 Skill 本地 prompt fallback

目标：

- Skill 不再承担长期 prompt 理解职责

本阶段处理项：

1. 审查并缩减 `run_napm_query.js` 中的 prompt fallback
2. 保留必要的安全拒绝与极少量执行型 fallback
3. 没有上游 structured resolvedQuery 时，优先返回决策式 contract，而不是自行猜查询

### 阶段 C：增强 OpenClaw LLM 规则化理解

目标：

- 让 LLM 成为主语义入口，但输出被规则约束

本阶段处理项：

1. 更新 `skills/openclaw-napm-query/agents/openai.yaml`
2. 将当前已经验证稳定的对象映射、指标归属、scene 规则写成更强约束
3. 明确禁止某些错误生成，例如：
   - plain 业务 -> BusinessGroup
   - packet loss question -> implicit TPIO ranking
   - raw natural-language direct tool misuse

### 阶段 D：补齐可观测性

目标：

- 后续可以快速看出是 LLM 理解错了，还是代码校验拦了，还是上游执行失败了

本阶段处理项：

1. 记录原始 prompt
2. 记录 LLM 产出的 resolvedQuery
3. 记录 Skill 归一化后的 resolvedQuery
4. 记录最终请求参数
5. 区分：
   - semantic_generation
   - static_validation
   - upstream_execution
   - final_render

---

## 五、可行性评审

## 5.1 技术可行性

结论：**可行，而且与当前项目方向一致。**

原因：

1. 现有文档已经把主职责定义为“OpenClaw 主链负责 resolvedQuery 构造”
2. 现有 Skill 已具备较完整的执行期校验能力
3. 当前插件中的语义特例是局部增生，不是系统必需能力
4. 已有测试体系可以承接这次收口

## 5.2 风险点

### 风险一：一下子删太多 prompt fallback，导致现网问法掉成功率

应对：

- 分阶段下掉
- 先收口最明显跑偏的 packet-loss 特例
- overview / metric inventory 类兜底后续再收

### 风险二：LLM 输出不稳定

应对：

- 用更硬的 prompt 约束
- 保留代码校验层
- 对关键对象、关键 metric 建白名单与兼容矩阵

### 风险三：重复执行仍存在于其他问法

应对：

- 先定位 packet-loss 重复刷新
- 后续再全面梳理 `buildAsyncRefreshedReplyText()` 的刷新条件

## 5.3 收益评估

本次收口完成后，预期收益：

1. 主链职责更清晰
2. 插件改动频率下降
3. 问法扩展时不再优先写插件特例
4. 响应速度提升，至少减少一类重复执行
5. 线上问题更容易定位

---

## 六、本次建议先做的最小闭环

为了控制风险，这一轮建议只先做下面三件事：

1. 去掉“丢包率最高 IP”默认按 `TPIO` 排序的隐式规则
2. 去掉插件对这类问法的二次强制刷新
3. 补强 OpenClaw LLM 提示词中的对象/指标/排序约束

这一轮先不做：

1. 全量移除 overview fallback
2. 全量移除 metric inventory fallback
3. 全面重写所有 prompt-only 入口

原因：

这样可以先验证方向正确，再继续扩大战果。

---

## 七、结论

这次改造方向是可行的，而且应当坚持两个原则：

1. **让 LLM 负责语义理解，但不能让它脱离规则自由生成**
2. **让代码负责约束、校验和执行，而不是继续在插件层堆语义特例**

当前最合适的落地方式不是“全量推翻重来”，而是：

**先收掉最明显跑偏的插件特例和错误隐式规则，再逐步把 resolvedQuery 主导权收回到 OpenClaw LLM + 规则约束这条主链上。**
