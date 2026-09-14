# GAIOP NAPM — BUG-A Web 实际查询首轮失败：只读根因排查指令

## 0. 当前现象

当前 Web 端已验证：

```text
MODEL_OWNED：
“你是？”
“你好？”
“你可以做些什么？”
→ 已正常输出
```

说明此前 `MODEL_OWNED Output Candidate Claim` 修复至少在普通身份/问候路径上已经生效。

但一旦测试 BUG-A 的第一条真实 NAPM 查询：

```text
最近业务访问较慢的前5个业务都有谁？
```

Web 最终显示：

```text
当前回复无法确认所属的 NAPM 查询轮次，已阻止未经验证的查询内容。
请重新发起查询。
```

并且同一用户请求后重复出现多次相同阻断文案，例如：

```text
13:33:36
13:34:08
13:34:10
13:34:12
13:34:14
13:34:16
...
```

这说明：

> **BUG-A 的真实 Web 查询路径目前没有通过最终验收。**

本轮不要假设是 `PGTME/TRTI` 问题，也不要假设是 rc.61 Claim 本身的问题。

必须先查清：

```text
用户请求
→ Semantic
→ Query Draft
→ Query Skill
→ NAPM execution
→ Skill result
→ final assistant generation
→ Query Turn authority/binding
→ output Hook
→ Web final output
```

到底在哪一层断裂。

---

# 1. 本轮性质

本轮只做：

```text
READ-ONLY ROOT CAUSE INVESTIGATION
```

禁止：

```text
修改代码
修改配置
修改 BUG-A 规则
修改 rc.61 Claim 规则
修改 BUG-B
重新部署
重启服务
直接改远端 bundle
commit
```

允许：

```text
读取本地代码
读取当前远端日志
读取已部署版本信息
运行本地只读测试
运行不会修改服务器状态的诊断命令
```

完成根因报告后停止，等待 Review。

---

# 2. 先确认实际部署版本

必须先回答：

```text
Web 当前实际部署版本：
Plugin version：
Plugin commit/hash：
Skill version：
Skill commit/hash：
OpenClaw/Gateway version：
```

特别确认：

```text
当前 Web 是否已经部署 rc.61？
```

不要只看本地 Git。
必须从远端安装目录、运行时日志、package metadata、实际加载路径确认。

输出：

```markdown
| Component | Expected | Actually Loaded | Match |
|---|---|---|---:|
| Plugin | rc.61 | ... | ... |
| Query Skill | ... | ... | ... |
| OpenClaw/Gateway | ... | ... | ... |
```

如果 Plugin / Skill 版本不一致，先记录，不要修。

---

# 3. 锁定唯一一次请求做端到端追踪

使用截图中的请求：

```text
2026/09/14 13:33:36
“最近业务访问较慢的前5个业务都有谁？”
```

找到对应：

```text
conversation/session key
message id（如果有）
run id（如果有）
turn id
request id
trace id
tool-call id
skill-call id
```

如果 Web Hook 缺 `runId/messageId`，也要找到：

```text
message_received 阶段生成的 turnId
TurnAdmissionDecision
conversation scope
```

后续所有排查必须围绕这一轮。
不要混入 13:34:08 之后的重复阻断消息。

---

# 4. 第一件事：确认 Query 到底有没有真正执行

必须回答：

```text
该用户请求是否调用了 NAPM Query Skill：YES / NO
调用次数：...

是否进入 NapmQuerySerializer：YES / NO
次数：...

是否调用 NapmClient / topValues：YES / NO
次数：...

是否真实访问南向：YES / NO
次数：...
```

这是本轮最重要的分叉。

---

# 5. 如果 Query Skill 根本没有执行

则排查：

```text
TurnPolicy
Routing
Tool selection
Tool guard
Semantic lifecycle
QueryDecisionPolicy
```

必须输出：

```text
platformIdentityPrompt:
route:
expectedTool:
workflowType:
semantic status:
resolvedQuery status:
tool selection result:
tool call blocked reason:
```

原始问句理论上应最终得到：

```text
route = NAPM_QUERY
operation = rank_top
targetObjectType = WebApplication
requestedMetrics = [PGTME]
rankingMetric = PGTME
topCount = 5

service = topValues
groups = [{ type: WebApplication }]
metrics = [PGTME]
topMetric = PGTME
topCount = 5
```

如果在这之前失败，明确指出具体层。

---

# 6. 如果 Query Skill 已执行

必须继续区分：

```text
A. Skill 执行失败
B. Skill 执行成功但 result 没绑定到 Query Turn
C. result 已绑定，但 final assistant output 无可信 current-turn authority
D. final assistant 已生成，但 output Guard 无法确认 Query Turn
E. 同一请求产生重复 final-output attempts / retry
```

不要把 B/C/D 都统称为 `LIFECYCLE_BINDING_REQUIRED`。

---

# 7. 先确认 BUG-A 核心 Query 是否正确

即使最终输出被阻断，也必须确认内部 Query。

记录本次真实 Semantic：

```text
operation:
targetObjectType:
metric semantic:
requestedMetrics:
rankingMetric:
topCount:
```

记录 Canonical Query：

```json
{
  "service": "...",
  "groups": [],
  "metrics": [],
  "topMetric": "...",
  "topCount": 0
}
```

BUG-A 第一条正确期望：

```text
service = topValues
groups = [{ type: WebApplication }]
metrics = [PGTME]
topMetric = PGTME
topCount = 5
```

必须明确：

```text
是否出现 TRTI：YES / NO
是否存在 legacy metric 作为 execution truth：YES / NO
```

如果 Query 本身正确，则不要再修改 Semantic / PGTME 映射。

---

# 8. 确认 Static / Runtime Gate

记录：

```text
Static Validator result:
VALID / UNKNOWN / INCOMPATIBLE / METRIC_UNKNOWN

Runtime provider:
...

metricsForGroup calls:
...

Final Admission:
ALLOW / DENY
```

对于 `WebApplication + PGTME`，如果当前 baseline 已知兼容，通常不应无故触发 runtime capability。

---

# 9. 确认南向结果

如果已执行，记录：

```text
NAPM service:
serialized metrics:
serialized topMetric:
serialized topCount:
serialized group params:

HTTP status:
parse status:
rowCount:
execution outcome:
```

明确属于：

```text
SUCCESS
NO_DATA
EXECUTION_FAILURE
```

哪一种。

注意：即使南向 SUCCESS，最终 Web 仍可能因为 Query Turn authority 失败被 Guard 阻断。

---

# 10. 确认 Skill Result 是否产生

找到 Query Skill 返回对象。

记录：

```text
ok:
outcome:
reasonCode:
rowCount:
finalContent/result:
turnId:
queryTurnId:
runId:
messageId:
toolCallId:
execution proof:
prepared proof:
result authority:
```

字段名不同则使用项目实际字段。

重点回答：

```text
Skill result 是否携带可关联当前 Query Turn 的可信身份？
```

---

# 11. 重点：QueryTurnCoordinator 生命周期

完整输出该请求的 Query Turn 状态变化：

```text
turn created
→ route assigned
→ expectedTool assigned
→ tool call admitted
→ execution started
→ result accepted
→ finalContent stored
→ delivery/result authority established
→ output guard
```

给真实状态和函数。

```markdown
| Step | QueryTurn State | Evidence |
|---|---|---|
| message_received | ... | ... |
| tool call | ... | ... |
| skill result | ... | ... |
| before final model output | ... | ... |
| output hook | ... | ... |
```

---

# 12. 核查 TurnAdmissionDecision

确认该轮 immutable Decision：

```text
turnId:
route:
action:
expectedTool:
source:
conversationScope:
```

对于 BUG-A Query 应是：

```text
route = NAPM_QUERY
expectedTool = NAPM query skill（项目真实名称）
```

如果 route 不是 NAPM_QUERY，立即标为主根因候选。

---

# 13. 核查 Tool Call 与 Turn 的绑定

追踪：

```text
MODEL
→ tool call
→ Skill
```

到底是否被当前 `turnId` 领取。

回答：

```text
toolCallId 是否绑定到 turnId：YES / NO
Skill result 是否绑定到同一 turnId：YES / NO
存在 cross-turn / stale turn：YES / NO
```

禁止用 `latest turn` 或 `conversation current turn` 补证据。

---

# 14. 核查 Final Assistant Generation

确认：

```text
NAPM Skill 返回后
模型是否已经生成了包含真实查询结果的最终文本：YES / NO
```

如果 YES，记录 `model raw final output`。

如果 raw final 已经正确生成，则问题明显位于：

```text
post-generation output admission
```

而不是 Query Skill。

---

# 15. 精确查找阻断文案生成函数

搜索：

```bash
rg "当前回复无法确认所属的 NAPM 查询轮次|已阻止未经验证的查询内容|请重新发起查询" .
```

输出：

```text
function:
file:
hook:
reasonCode:
trigger condition:
```

确认是 `message_sending`、`before_message_write` 还是其他 output hook 触发。

---

# 16. 精确记录 OutputTurnContextResolver 的结果

对于 13:33:36 这一轮，分别记录：

## before_message_write

```text
scope:
runId:
messageId:
turn token:
strong binding result:
claim binding result:
eligible candidate count:
candidate turnIds:
resolution status:
provenance:
resolved turnId:
resolved route:
```

## message_sending

同样记录。

不要只写 `binding failed`，必须看到 resolver 为什么失败。

---

# 17. 重点区分：MODEL_OWNED Claim 修复是否误伤 NAPM_QUERY

rc.61 的设计是：

```text
MODEL_OWNED
→ 可以 UNIQUE_SCOPE_RESOLUTION
→ CLAIMED
```

同时：

```text
NAPM_QUERY
→ scope-only Claim 不能交付查询结果
→ 必须有 execution/result authority
```

这条原则本身不能放松。

但必须排查：

> **Web NAPM_QUERY 的最终输出是否事实上也没有 runId/messageId，而系统目前又没有任何其它可信 OutputTurnContext token？**

如果答案是 YES，则可能是：

```text
MODEL_OWNED
→ 有受限 scope compatibility path

NAPM_QUERY
→ Web output hook 缺 strong identity
→ 无法证明 final result 属于当前 Query Turn
→ 正确 fail-closed
```

这属于：

```text
Web NAPM_QUERY 缺失可信 output-turn identity/authority transport
```

必须用日志证明。

---

# 18. 不允许用以下方式修复 NAPM Query

禁止：

```text
❌ NAPM_QUERY + UNIQUE_SCOPE_RESOLUTION → 直接放行
❌ candidateCount=1 → 直接相信 Query result
❌ conversation latest query turn → 直接绑定
❌ latest claim → Query result authority
❌ 看到回答中有 NAPM 数据 → 判断属于 NAPM_QUERY
❌ 重新跑 prompt classifier → 推断 output route
❌ 因为用户刚问的是 NAPM → 直接 bypass Guard
```

BUG-A 的 fail-closed 不能因为 Web 缺 identity 而拆掉。

---

# 19. 查清 NAPM Query 是否已有可复用的强证据

重点搜索：

```text
toolCallId
skillCallId
queryTurnId
executionAttemptId
preparedProof
resultProof
finalContent owner
run binding
message binding
assistant output id
```

看能否形成：

```text
当前 final assistant output
↔ 当前 tool call
↔ 当前 skill result
↔ 当前 query turn
```

的不可混淆链。

如果已有，只是没有传给 output hook：

```text
根因 = identity propagation 缺口
```

而不是 Guard 本身。

---

# 20. 核查 OpenClaw Web 输出 Hook 身份能力

确认真实 Web：

```text
before_message_write:
runId?
messageId?
assistant output id?
toolCall relationship?
sessionKey?
conversationId?

message_sending:
runId?
messageId?
assistant output id?
toolCall relationship?
```

如果 Web NAPM_QUERY 与 MODEL_OWNED 都缺 run/message，必须说明为何 MODEL_OWNED 可安全 fallback，而 NAPM_QUERY 不可。

正确边界应是：

```text
MODEL_OWNED 不携带外部查询事实，唯一 turn 时可受限兼容；
NAPM_QUERY 携带外部系统事实，必须具有更强 result authority。
```

---

# 21. 重点调查重复阻断消息

同一请求之后出现多条相同阻断回复：

```text
13:33:36
13:34:08
13:34:10
13:34:12
13:34:14
13:34:16
...
```

必须单独排查。

判断属于：

```text
A. 同一模型回复的重复 delivery retry
B. OpenClaw 自动重试
C. watcher/worker 重试
D. message queue redelivery
E. 多个 final output attempts
F. 多个 Hook 各自写入 failure reply
G. 其他
```

必须查清每一条对应：

```text
同一 turnId 还是不同 turnId？
同一 run 还是不同 run？
同一 message/toolCall 还是不同？
```

---

# 22. 重复失败消息绝不能忽略

即使最终解决 Query Turn Binding，还必须确保：

```text
一个用户请求
→ 最多一个最终 failure reply
```

检查：

```text
buildLifecycleBindingFailureReply()
生成的 replacement
是否又被后续 pipeline 当成新的 assistant output
```

---

# 23. 检查是否存在递归/自触发

重点查：

```text
failure replacement
→ before_message_write
→ transcript
→ watcher
→ assistant event
→ 再进 output guard
```

以及：

```text
cancel/retry
→ model rerun
→ 同一失败
```

输出真实因果链。

---

# 24. 调用次数必须给真实数字

对于 13:33:36 请求输出：

```markdown
| Component | Calls |
|---|---:|
| message_received | ... |
| TurnAdmissionDecision | ... |
| Query Skill | ... |
| Static Validator | ... |
| metricsForGroup | ... |
| Serializer | ... |
| NapmClient/topValues | ... |
| Skill Result | ... |
| final model generation | ... |
| before_message_write | ... |
| message_sending | ... |
| Lifecycle failure replacement | ... |
```

这是判断“查询失败”还是“只在输出层失败”的核心证据。

---

# 25. 必须验证原始 BUG-A Query 真相

本次排查最终一定要回答：

```text
“最近业务访问较慢的前5个业务都有谁？”
```

在当前已部署系统中，是否成功形成：

```text
WebApplication
+
PGTME
+
topValues
+
topCount=5
```

只能选：

```text
YES
NO
NOT REACHED
```

如果 YES：

```text
BUG-A semantic/query fix 本身正常，
当前失败属于 output authority/lifecycle。
```

如果 NO：

```text
BUG-A 本体仍有回归。
```

---

# 26. 建议做对照请求

同一 Web 会话中只读观察：

```text
页面响应时间最高的前5个业务
```

以及：

```text
服务器响应时间最高的前5个已定义应用
```

如果所有 NAPM_QUERY 都是：

```text
Query 成功执行
→ final output binding failure
```

则是通用 Web NAPM final-output authority 问题。

如果只有“业务访问较慢”失败，才继续查 BUG-A semantic path。

---

# 27. 对照 MODEL_OWNED

同一个会话立即发：

```text
你好
```

确认：

```text
MODEL_OWNED → 正常
```

证明 Plugin 并未整体失效，而是 NAPM_QUERY route-specific final output 出问题。

---

# 28. 根因分类

最终从以下选择主要根因，可附次因：

```text
A. BUG-A Semantic/Canonical Query 回归
B. Query Skill 未执行
C. Query execution/result 失败
D. QueryTurn tool/result binding 丢失
E. Web NAPM final-output 缺 strong identity
F. Query execution authority 没有传播到 final output
G. OutputTurnContextResolver 对 NAPM_QUERY 解析错误
H. Output Guard 顺序/条件错误
I. failure-reply 重试/递归导致重复消息
J. 部署版本不一致
K. 其他
```

必须提供代码 + 远端日志证据。

---

# 29. 如果主因是 E/F：不要立即放宽 Guard

如果结论是：

```text
Web NAPM_QUERY 已执行成功
但 final output 无法拿到 query turn/result authority
```

正确方向优先研究：

```text
tool/result authority
→ trusted OutputTurnContext
→ final assistant output
```

的传播。

可能包括：

```text
runId/messageId
trusted output token
queryTurnId-bound output token
toolCallId/result proof propagation
```

而不是：

```text
scope candidate 唯一就放行 NAPM。
```

---

# 30. 如果主因是 G/H

如果已有可信 binding/proof，只是 resolver/guard 没消费：

```text
最小修复 resolver/guard
```

不要改：

```text
Semantic
Metric
Query Contract
Object ownership
Runtime Capability
Serializer
NapmClient
```

---

# 31. 如果主因是 A

如果真实 Query 仍是：

```text
WebApplication + TRTI
```

或 `PGTME` / TopN 未识别，则优先排查：

```text
实际加载 Skill 是否是新版本
Resolution Spec 是否是新版本
Plugin/Skill 是否版本错配
```

不要马上重新写 Semantic。

---

# 32. 重复阻断消息必须单独给结论

最终报告必须写：

```text
Repeated failure replies root cause:
...
```

并回答：

```text
是否同一个用户请求导致：YES / NO
是否同一个 turn：YES / NO
是否有多次南向查询：YES / NO
是否有多次模型 final generation：YES / NO
是否由 failure reply 自己触发：YES / NO
```

---

# 33. 默认冻结 rc.61 MODEL_OWNED Claim

当前身份/问候已实际通过。

因此本轮默认：

```text
rc.61 MODEL_OWNED consumption logic = FROZEN
```

只有证据明确证明其 candidate/claim 行为直接导致 NAPM_QUERY binding 丢失，才提出修改。

不能因为 NAPM_QUERY 失败就回滚整个 rc.61。

---

# 34. BUG-B 仍不处理

不要修改：

```text
PageFamily
pageViews
ResultReference
第一个/第二个
多轮 drilldown
```

本轮只排 BUG-A Web NAPM 查询输出。

---

# 35. 最终报告格式

完成排查后停止。

## 35.1 Version / Runtime

```text
local branch:
local HEAD:
deployed Plugin version:
deployed Plugin hash:
deployed Skill version/hash:
OpenClaw version:
version match:
```

## 35.2 Request Identity

```text
user prompt:
timestamp:
conversation scope:
turnId:
runId:
messageId:
toolCallId:
skillCallId:
```

## 35.3 Semantic / Query

```text
route:
operation:
targetObjectType:
requestedMetrics:
rankingMetric:
topCount:

canonical service:
groups:
metrics:
topMetric:
topCount:

TRTI appeared:
YES / NO
```

## 35.4 Admission

```text
static:
runtime:
final admission:
```

## 35.5 Execution

```text
Query Skill calls:
Serializer calls:
metricsForGroup calls:
NapmClient/data calls:
HTTP status:
rowCount:
outcome:
```

## 35.6 QueryTurn Lifecycle

按时间列所有状态。

## 35.7 Raw Model Final Output

```text
generated:
YES / NO

raw content summary:
...
```

## 35.8 Output Hook Resolution

### before_message_write

```text
ctx identities:
candidates:
resolution:
provenance:
resolved turn:
route:
authority:
block reason:
```

### message_sending

同样输出。

## 35.9 Final Replacement

```text
replacement function:
reasonCode:
trigger:
```

## 35.10 Repeated Replies

```text
count:
same turn:
same run:
same tool call:
same execution:
cause:
```

## 35.11 Call Count Matrix

输出第 24 节表。

## 35.12 Root Cause

```text
primary:
secondary:
```

从第 28 节分类中选择。

## 35.13 BUG-A Status

必须分开回答：

```text
BUG-A semantic/query construction:
PASS / FAIL / NOT REACHED

BUG-A static/runtime gate:
PASS / FAIL / NOT REACHED

BUG-A southbound execution:
PASS / FAIL / NOT REACHED

BUG-A Web final-result delivery:
PASS / FAIL
```

禁止只写 `BUG-A PASS/FAIL` 而不区分层。

## 35.14 Recommended Fix Boundary

只写：

```text
需要修改：
...

明确不修改：
...
```

不要实施。

## 35.15 Code / Deployment

必须：

```text
runtime code modified: NO
deployed: NO
restarted: NO
BUG-B modified: NO
```

---

# 36. 本轮验收目标

排查结束时必须能回答：

> 对于“最近业务访问较慢的前5个业务都有谁？”，
> 是 **Query 根本没正确执行**，
> 还是 **Query 已正确执行但 Web 最终无法证明该结果属于当前 NAPM Query Turn**？

这是当前最重要的分界。

---

# 37. 最重要的安全原则

不要为了让查询“显示出来”而做：

```text
NAPM_QUERY
+ candidateCount=1
→ 直接放行
```

正确方向必须是：

```text
NAPM Query result
↓
可信地绑定到当前 Query Turn
↓
可信地传播到 current final output
↓
Output Guard 验证 authority
↓
才允许展示
```

当前 fail-closed 原则本身不要拆。

---

# 38. 本轮结束

完成只读根因报告后：

```text
STOP
```

不要修改代码。

提交：

```text
BUG-A Web NAPM Query Final Output Root Cause Report
```

等待 Review。
