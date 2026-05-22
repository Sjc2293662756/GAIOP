# 2026-05-21 丢包 Top IP resolvedQuery 与执行链路幻觉修复说明

## 1. 背景

用户在企业微信中连续测试：

```text
丢包最大的IP地址是谁？
这次你怎么查的？
resolvedQuery 不是openclaw构造么？为什么不构造？
```

模型曾回复：

- 没有走 `napm-skill-query`
- 没有走 `napm-topn`
- 直接 `curl` 调 NetInside 底层 API
- 用 Python 解析 JSON
- 因为 OpenClaw 没有构造 `resolvedQuery`

远端日志复核后确认，这些执行链路描述在对应时间窗口没有运行时证据支撑。

## 2. 复核结论

检查时间窗口：

```text
2026-05-21 15:47:38 / 15:48:28 / 15:48:55
2026-05-21 16:05:12 / 16:05:40 / 16:06:41
```

复核对象：

```text
journalctl --user -u openclaw-gateway.service
<OPENCLAW_HOME>/logs/audit.log
/tmp/openclaw/openclaw-2026-05-21.log
```

结论：

- 这些窗口里只看到企业微信入站消息与最终出站回答。
- 没有看到新的 `napm-skill-query` 执行记录。
- 没有看到 `before_tool_call` / plugin hook 执行记录。
- 没有看到直接 `curl`、Python 解析或底层 API 调用证据。
- 因此“直接调 API / skill 被拒 / 没构造 resolvedQuery”是模型生成的不可核验叙事。

更准确的判定：

```text
回答可能来自历史上下文、缓存印象或模型自由生成；
后续“怎么查的”说明不应被视为真实执行日志。
```

## 3. 同时发现的真实问题

### 3.1 远端插件清单仍暴露旧工具

远端文件：

```text
<OPENCLAW_HOME>/extensions/napm-openclaw-plugin/openclaw.plugin.json
```

修复前仍声明：

```json
{
  "contracts": {
    "tools": [
      "napm-skill-query",
      "napm-topn",
      "napm-average",
      "napm-timeseries"
    ]
  }
}
```

这会继续向 OpenClaw 暴露旧工具契约，容易干扰模型选择和解释。

### 3.2 丢包 Top IP 的 resolvedQuery 缺字段

`丢包最大的IP地址是谁？` 应构造成：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 1,
  "format": "json"
}
```

此前 helper 能构造大部分字段，但缺少 `queryModeKey=topn`。

由于 `config/napm-resolution-spec.v1.json` 中 `topValues.required` 包含：

```json
[
  "service",
  "queryModeKey",
  "metrics",
  "topMetric",
  "timeRange"
]
```

所以 strict 边界会阻断该请求，提示：

```text
resolvedQuery is missing required fields for service=topValues: queryModeKey.
```

### 3.3 元追问缺少硬收口

对下面这类问题：

```text
这次你怎么查的？
你也没有走 skill 么？
resolvedQuery 不是 openclaw 构造么？为什么不构造？
```

如果没有可核验的 skill 记录，系统不应让模型自由解释执行过程。

## 4. 本次代码修改

### 4.1 移除旧工具契约暴露

新增本地插件清单：

```text
openclaw.plugin.json
```

内容只保留：

```json
{
  "contracts": {
    "tools": [
      "napm-skill-query"
    ]
  }
}
```

远端同名文件已覆盖。

### 4.2 丢包 Top IP 加入极窄 resolvedQuery 构造例外

修改文件：

```text
napm-openclaw-plugin.remote.js
```

关键行为：

- 仅对明确的“客户端/IP 丢包最高/最大/Top/谁/哪个”类问法生效。
- 自动补出 `topValues + queryModeKey=topn + PLI/PLO + IPAddress + topCount=1`。
- 默认流入丢包使用 `PLI`。
- 出现“流出/出向/outbound/uplink”时使用 `PLO`。
- 时间范围按过去 24 小时分钟对齐。

这是一个窄口例外，原因是该问法已经在生产中多次出现，且字段映射确定、无对象歧义。

### 4.3 元追问只允许基于可核验记录回答

新增函数：

```text
hasVerifiableSkillRecord()
buildExecutionTraceReplyFromRememberedRecord()
```

行为：

- 如果有真实 skill 记录，回答只展示：
  - `napm-skill-query`
  - `service`
  - `metric`
  - `groups`
  - `Debug API`
- 如果没有真实 skill 记录，回答：

```text
当前没有可核验的 NAPM skill 执行记录，不能确认刚才实际走了哪条查询链路。
因此我不会补写任何未被日志证明的执行过程。
需要以本轮真实的 napm-skill-query 记录和 audit 日志为准。
```

不再允许输出“直接 curl / Python 解析 / 没走 skill / skill 被拒”等不可核验叙事。

### 4.4 扩展绕行叙事识别

`looksLikeNapmBypassProcessText()` 增加识别：

- `curl` / `cURL`
- `Python 解析`
- `NetInside 底层`
- `底层 API`
- `原始 API`
- `直接调`
- `绕过`
- `跨过`
- `没走 skill`
- `napm-skill-query ... 拒绝`
- `resolvedQuery ... 没/未/没有 构造`

一旦出站文本匹配，且没有可核验记录，会被替换为安全说明。

### 4.5 默认 executor 路径修正

原默认值：

```text
/opt/NAPM_Semantic_Gateway/skills/openclaw-napm-query/scripts/run_napm_query.js
```

远端实际路径：

```text
<OPENCLAW_HOME>/skills/openclaw-napm-query/scripts/run_napm_query.js
```

本次改为：

```js
process.env.NAPM_SKILL_EXECUTOR
  || path.join(process.env.HOME || '<REMOTE_HOME>', '.openclaw/skills/openclaw-napm-query/scripts/run_napm_query.js')
```

说明：

- systemd 服务环境已经配置了正确的 `NAPM_SKILL_EXECUTOR`。
- 该修改主要保证手工验证和兜底默认路径也能跑通。

## 5. 测试覆盖

修改/新增测试：

```text
test/napm-openclaw-plugin-packet-loss-guard.test.js
test/napm-openclaw-plugin-meta-followup-guard.test.js
test/napm-openclaw-plugin-direct-tool-removal.test.js
```

覆盖行为：

- `哪个客户端IP丢包最高？` 能识别为 packet loss top prompt。
- `丢包最大的IP地址是谁？` 能识别为 packet loss top prompt。
- packet loss prompt 会注入：
  - `service=topValues`
  - `queryModeKey=topn`
  - `metric=PLI`
  - `topMetric=PLI`
  - `groups=[{type:"IPAddress"}]`
  - `topCount=1`
- `napm-topn` 旧工具被阻断。
- “这次怎么查的？”没有真实记录时，不会输出 `curl`、`Python 解析`、`没有走 skill` 等叙事。

验证命令：

```bash
node --check napm-openclaw-plugin.remote.js
npx jest test/napm-openclaw-plugin-packet-loss-guard.test.js test/napm-openclaw-plugin-meta-followup-guard.test.js test/napm-openclaw-plugin-direct-tool-removal.test.js --runInBand
```

验证结果：

```text
Test Suites: 3 passed, 3 total
Tests: 10 passed, 10 total
```

## 6. 远端部署

远端：

```text
<OPENCLAW_HOST>
user: <deploy-user>
```

部署文件：

```text
<OPENCLAW_HOME>/extensions/napm-openclaw-plugin/index.js
<OPENCLAW_HOME>/extensions/napm-openclaw-plugin/openclaw.plugin.json
```

备份目录：

```text
<OPENCLAW_HOME>/deploy_backups/20260521_165127_napm_openclaw_fix
<OPENCLAW_HOME>/deploy_backups/20260521_165452_napm_executor_path_fix
```

重启服务：

```bash
systemctl --user restart openclaw-gateway.service
```

服务状态：

```text
active
```

启动日志确认：

```text
http server listening (2 plugins: napm-openclaw-plugin, wecom-openclaw-plugin; 3.6s)
WebSocket connected
Authenticated
```

远端清单确认：

```json
{
  "tools": [
    "napm-skill-query"
  ]
}
```

## 7. 远端真实执行验证

验证问法：

```text
丢包最大的IP地址是谁？
```

插件自动改写后的 `resolvedQuery`：

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 1,
  "start": 1779253680,
  "end": 1779340080,
  "format": "json",
  "userRequirement": "丢包最大的IP地址是谁？"
}
```

真实执行结果：

```text
ok: true
service: topValues
rowCount: 1
IP: <TOP_PACKET_LOSS_IP>
PLI: 87.5%
```

真实返回文本：

```text
数据时间：2026-05-20 13:08:00 至 2026-05-21 13:08:00
当前按 PLI 排序，丢包最大的地址是 <TOP_PACKET_LOSS_IP>，流入丢包率 87.5%。
```

脱敏 Debug API 示例：

```text
https://<napm-host>/webservice/NetInside?UserName=<NETINSIDE_USERNAME>&Password=[masked]&type=topValues&numGroups=1&groupType1=IPAddress&start=<start>&end=<end>&metrics=PLI&topMetric=PLI&topCount=1&json=true
```

## 8. 后续判责口径

### 8.1 用户问“丢包最大的IP地址是谁？”

预期链路：

```text
WeCom
-> OpenClaw
-> napm-skill-query
-> plugin 自动补齐 packet loss resolvedQuery
-> openclaw-napm-query skill
-> NetInside topValues
```

必须能在 audit 或 plugin 日志中看到：

```text
service=topValues
queryModeKey=topn
metric=PLI
topMetric=PLI
groups=[IPAddress]
```

### 8.2 用户问“这次你怎么查的？”

如果有本轮 skill 记录：

- 回答真实工具链路。
- 只引用记录里的 `resolvedQuery` / `requestUrl` / `result`。

如果没有本轮 skill 记录：

- 必须回答“当前没有可核验的 NAPM skill 执行记录”。
- 不允许声称走了 `curl`、Python、底层 API、旧 `napm-topn` 或 skill 拒绝。

### 8.3 如果再次出现“直接调 NetInside 底层 API”

优先检查：

```bash
journalctl --user -u openclaw-gateway.service --since "YYYY-MM-DD HH:mm:ss" --until "YYYY-MM-DD HH:mm:ss" --no-pager
grep -n "napm_plugin_skill_call_received\|napm_plugin_resolved_query_forwarded\|napm_plugin_skill_executor_completed" <OPENCLAW_HOME>/logs/audit.log
grep -n "before_tool_call\|napm-skill-query\|curl\|exec" /tmp/openclaw/openclaw-YYYY-MM-DD.log
```

判断：

- 有 skill 记录：按真实 `resolvedQuery` 和 `requestUrl` 判断。
- 没有 skill 记录：回答属于不可核验叙事，应由元追问 guard 拦截。
- 仍看到旧工具：检查远端 `openclaw.plugin.json` 是否被旧版本覆盖。

## 9. 与 strict 边界的关系

本次不是重新开放通用 prompt fallback。

保持不变：

- metadata inventory
- hierarchy catalog
- overview
- average/trend/topn 泛化查询

这些仍应由上游 OpenClaw mainflow 构造完整 `resolvedQuery`。

本次只对生产高频且语义确定的 packet loss top IP 问法保留窄口构造：

```text
丢包 + IP/客户端/地址 + 最大/最高/top/谁/哪个
```

这样既能保证用户高频查询可用，又不会重新打开 plugin 作为通用自然语言解析器的边界。

