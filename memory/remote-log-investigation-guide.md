---
name: remote-log-investigation-guide
description: 远端OpenClaw日志排查完整流程（SSH连接、日志位置、多日志关联、Agent内部阶段追踪、Prompt分析、耗时诊断）
metadata:
  type: reference
---

# 远端 OpenClaw 日志排查指南

## 远端服务器

| 项目 | 值 |
|------|-----|
| 地址 | `101.254.114.237` |
| 用户名 | `netinside` |
| 密码 | `netinside_123` |
| SSH 方式 | plink（`/d/PUTTY/plink`） |

## 日志文件体系

### 文件位置与角色

```
┌─ /tmp/openclaw/openclaw-YYYY-MM-DD.log ───────────────────┐
│  频道层事件（★ 主时间线来源）                              │
│  · 消息收发（aibot_msg_callback / Reply message sent）     │
│  · NAPM 边界检测（napm-boundary）                          │
│  · 动态路由（dynamic-routing）                             │
│  · LLM 回复（kind=final）                                  │
│  · 流式输出（streamId=... finish=false/true）              │
│  · WebSocket ack（Reply ack）                              │
│  · 模板卡片处理（template-card）                           │
└───────────────────────────────────────────────────────────┘

┌─ /home/netinside/.openclaw/logs/audit.log ────────────────┐
│  Plugin 审计事件（★ 插件层事件来源）                       │
│  · Tool 调用/完成（napm_plugin_skill_executor_invoked/     │
│    completed — 注意：新架构已移除此事件）                   │
│  · resolvedQuery 校验（napm_plugin_tool_execute_resolved_  │
│    query_blocked）                                         │
│  · resolvedQuery 自动修复（napm_plugin_resolved_query_     │
│    auto_repaired / auto_repair_failed）                    │
│  · API 请求构建（napm_api_request_built）                  │
│  · 执行成功/失败（napm_execution_completed / _failed）     │
│  · 告警查询调用/完成（napm_alert_query_invoked / _completed│
└───────────────────────────────────────────────────────────┘

┌─ /home/netinside/.openclaw/logs/combined.log ─────────────┐
│  Skill 内部日志（★ NAPM API 调用详情来源）                 │
│  · NapmClient 初始化                                       │
│  · Gateway request 验证（passed / failed）                 │
│  · NAPM API 请求（Making NAPM API request）                │
│  · NAPM API 响应（response received, status=200）          │
│  · NAPM API 失败（Request failed with status code 400/500）│
│  · 数据解析（解析数据、数据长度）                           │
└───────────────────────────────────────────────────────────┘

┌─ /home/netinside/.openclaw/logs/gateway.out.log ──────────┐
│  Gateway 启动日志（★ 部署/启动问题排查）                   │
│  · 插件加载（plugins: napm-openclaw-plugin, wecom-...)     │
│  · 合约检查（plugin must declare contracts.tools for: ...） │
│  · HTTP 监听（http server listening）                      │
│  · 频道连接（WebSocket connected / Authenticated）         │
│  · 启动耗时（...; 3.5s）                                   │
└───────────────────────────────────────────────────────────┘
```

### 各日志的"最佳用途"

| 想查什么 | 去哪个日志 |
|---------|-----------|
| 端到端耗时（消息到→回复出） | 主日志 |
| NAPM 边界检测是否通过 | 主日志 |
| LLM 什么时候开始/结束推理 | 主日志（streamId + kind=final） |
| NAPM API 调了什么、返回了什么 | combined.log + audit.log |
| NAPM API 是否报错（400/500） | combined.log |
| resolvedQuery 校验是否通过 | audit.log |
| before_tool_call Hook 是否执行 | audit.log（无直接日志，需从 resolvedQuery 的 start/end 推断） |
| Plugin 是否加载成功 | gateway.out.log |
| 合约声明是否完整 | gateway.out.log（搜索 `contracts.tools`） |
| 企业微信连接状态 | 主日志（WebSocket connected / Authenticated） |

## 命令模板

### 通用 SSH 命令格式
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "<远程命令>" 2>&1
```

### 按时间窗口查主日志
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'HH:MM' /tmp/openclaw/openclaw-YYYY-MM-DD.log | head -N" 2>&1
```

### 查用户消息到达
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'aibot_msg_callback.*content' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'" 2>&1
```

### 查 NAPM 边界检测
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'napm-boundary' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'" 2>&1
```

### 查 LLM 回复内容
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'openclaw.*plugin.*kind=final' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'" 2>&1
```

### 查 Agent 工具调用（API 层）
```bash
# audit.log — Plugin 审计事件
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'HH:MM' /home/netinside/.openclaw/logs/audit.log | grep -v 'napm_api_request_built'" 2>&1

# combined.log — Skill 内部 API 调用
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'HH:MM' /home/netinside/.openclaw/logs/combined.log | grep -E 'request|response|error|failed'" 2>&1
```

### 查 Gateway 启动/加载状态
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "tail -30 /home/netinside/.openclaw/logs/gateway.out.log" 2>&1
```

### 查日志文件基本信息
```bash
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "ls -la /tmp/openclaw/ && echo '---' && ls -la /home/netinside/.openclaw/logs/" 2>&1
```

### 【新增】按 reqId 追踪完整请求链路
```bash
# Step 1: 从用户消息中提取 reqId
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'aibot_msg_callback.*content.*<关键词>' /tmp/openclaw/openclaw-YYYY-MM-DD.log" 2>&1
# → 从输出的 JSON 中提取 reqId（如 lB0uXUrQRVCyaP4XKivM_AAA）

# Step 2: 按 reqId 追踪该请求的所有频道层事件
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep '<reqId>' /tmp/openclaw/openclaw-YYYY-MM-DD.log" 2>&1

# Step 3: 提取该请求的关键生命周期事件
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep '<reqId>' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep -E 'aibot_msg_callback|kind=final|streamId|napm-boundary|dynamic-routing|Reply message sent|Reply ack'" 2>&1
```

### 【新增】多日志关联查询（同一时间窗口）
```bash
# 并行拉取三个日志源，交叉对照
# 1. 主日志 — 频道层事件
grep '09:4[0-5]' /tmp/openclaw/openclaw-2026-07-08.log | head -30

# 2. 审计日志 — Plugin 事件（排除大量 API 构建事件）
grep '09:4[0-5]' /home/netinside/.openclaw/logs/audit.log | grep -v 'napm_api_request_built' | head -20

# 3. 合并日志 — API 调用详情
grep '09:4[0-5]' /home/netinside/.openclaw/logs/combined.log | grep -E 'request|response|error|failed|validation' | head -20
```

### 【新增】查 NAPM API 调用成功/失败
```bash
# 查所有 API 请求
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'Making NAPM API request' /home/netinside/.openclaw/logs/combined.log | grep 'HH:MM'" 2>&1

# 查所有 API 失败（400/500）
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'NAPM API request failed' /home/netinside/.openclaw/logs/combined.log | grep 'HH:MM'" 2>&1

# 查所有 API 成功
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'NAPM API response received' /home/netinside/.openclaw/logs/combined.log | grep 'HH:MM'" 2>&1
```

### 【新增】查 Gateway 合约/加载问题
```bash
# 合约声明检查
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'contracts.tools\|failed to load\|plugin must declare' /home/netinside/.openclaw/logs/gateway.out.log" 2>&1

# 插件加载状态
echo y | /d/PUTTY/plink -ssh -pw netinside_123 netinside@101.254.114.237 "grep 'listening.*plugins\|plugin(s) failed' /home/netinside/.openclaw/logs/gateway.out.log | tail -5" 2>&1
```

## 日志字段解读

主日志每行是一个 JSON，关键字段：

| 字段 | 含义 |
|------|------|
| `time` | 本地时间（+08:00），如 `2026-07-08T09:40:44.768+08:00` |
| `hostname` | `netinsideopenclaw` |
| `message` | 事件描述，格式：`[子系统] 事件详情` |
| `reqId` | 请求追踪 ID（在 message 中），同一请求的所有事件共享此 ID |

### 【扩展】message 关键事件类型

| message 特征 | 含义 | 耗时标记 |
|-------------|------|---------|
| `[server -> plugin] cmd=aibot_msg_callback` | 企业微信用户消息到达 | **T0** 起点 |
| `[wecom][napm-boundary] NAPM prompt detected` | NAPM 边界识别通过，进入 Agent | T0 + ~5ms |
| `[dynamic-routing] matchedBy=default` | 路由到默认 main agent | T0 + ~7ms |
| `[dynamic-routing] useDynamicAgent=false` | 未使用动态路由，走固定 agent | — |
| `[openclaw -> plugin] kind=final` | LLM 最终回复内容（`payload.text`） | **T1** 终点 |
| `[plugin -> server] streamId=... finish=false` | LLM 流式输出开始/进行中 | **首次出现 = LLM 开始推理** |
| `[plugin -> server] streamId=... finish=true` | LLM 流式输出结束 | 推理完成 |
| `Reply message sent via WebSocket` | 回复已发送到企业微信 | T1 + ~5ms |
| `Reply ack received` | 企业微信确认收到 | T1 + ~200ms |
| `[wecom][template-card] visibleText exists, length=N` | 模板卡片处理 | 回复发送后 |
| `[template-card-parser] Extraction done: N card(s) found` | 模板卡片提取结果 | — |

### 【新增】跨日志事件对照表

| 阶段 | 主日志事件 | audit.log 事件 | combined.log 事件 |
|------|-----------|---------------|------------------|
| 消息入站 | `aibot_msg_callback` | — | — |
| NAPM 检测 | `napm-boundary` | — | — |
| LLM 开始推理 | `streamId=... finish=false` | — | — |
| Hook 执行 | — | `napm_plugin_tool_execute_resolved_query_blocked`(如被拒) | — |
| Tool 调用 | — | `napm_plugin_skill_executor_invoked`(旧架构) | — |
| API 请求 | — | `napm_api_request_built` | `Making NAPM API request` |
| API 响应 | — | `napm_execution_completed` | `NAPM API response received` |
| API 失败 | — | `napm_execution_failed` | `NAPM API request failed` |
| Tool 完成 | — | `napm_plugin_skill_executor_completed`(旧架构) | — |
| LLM 回复 | `kind=final` | — | — |
| 回复发送 | `Reply message sent` | — | — |

## 完整排查流程（5 层分析法）

### Layer 1：频道层 — 端到端时间线

**目标**：获取 T0（消息到达）→ T1（LLM 回复）→ T2（WeCom ack）

```bash
# 1. 找到用户消息，获取 reqId
grep 'aibot_msg_callback.*"content"' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'
# → 记录 T0，提取 reqId

# 2. 按 reqId 追踪全部事件
grep '<reqId>' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep -E 'aibot_msg_callback|napm-boundary|dynamic-routing|streamId|kind=final|Reply message sent|Reply ack'

# 3. 计算耗时
# T0 = 第一个 aibot_msg_callback 的时间
# T1 = kind=final 的时间
# T2 = 最后一个 Reply ack 的时间
# 端到端 = T1 - T0
# 完整闭环 = T2 - T0
```

**判断标准**：
| 端到端耗时 | 诊断 |
|-----------|------|
| < 5s | ✅ 正常 |
| 5-10s | ⚠️ LLM 推理为主，观察 streamId 首次出现时间 |
| 10-20s | ⚠️ 可能存在纠错/重试，检查 combined.log 中是否有 400 错误 |
| > 20s | 🔴 严重，检查 NAPM API 超时或 LLM 循环 |

### Layer 2：Agent 层 — 内部阶段拆解

**目标**：拆解 LLM 推理、Tool 调用、API 调用各自的耗时

从主日志中提取以下关键节点：

| 节点 | 事件特征 | 含义 |
|------|---------|------|
| A | `aibot_msg_callback` | 消息到达 |
| B | `napm-boundary` | 边界检测通过 (A + ~5ms) |
| C | 第一个 `streamId=... finish=false` | LLM 开始流式输出 (A + ~900-2,000ms) |
| D | `kind=final` | LLM 最终回复 (A + N ms) |

**阶段耗时计算**：

```
阶段1: Agent 启动     = B → C  (首次 LLM 调用 prefill + first token)
阶段2: LLM 推理+格式化 = C → D  (LLM 思考 + Tool Call + API等待 + 格式化回答)
阶段3: 回复发送        = D → Reply ack
```

**正常范围**：
| 阶段 | 正常 | 偏慢 | 异常 |
|------|------|------|------|
| Agent 启动 (B→C) | 500-1,500ms | 1,500-3,000ms | > 3,000ms |
| LLM 推理 (C→D) | 3-8s | 8-15s | > 15s |
| 回复发送 | 100-300ms | — | > 500ms |

### Layer 3：Hook 层 — Plugin 拦截链

**目标**：确认 Hook 是否正确执行

```bash
# 查 resolvedQuery 是否被校验拦截
grep 'HH:MM' /home/netinside/.openclaw/logs/audit.log | grep 'napm_plugin_tool_execute_resolved_query_blocked'

# 查 resolvedQuery 是否被自动修复
grep 'HH:MM' /home/netinside/.openclaw/logs/audit.log | grep 'napm_plugin_resolved_query_auto'

# 查 resolvedQuery 校验失败的具体原因
grep 'HH:MM' /home/netinside/.openclaw/logs/audit.log | grep -E 'incomplete_resolved_query|missing_resolved_query|invalid_time_boundary|invalid_query_mode'
```

**常见拦截原因**：

| reason | 含义 | 典型触发场景 |
|--------|------|------------|
| `missing_resolved_query` | LLM 未构造 resolvedQuery | LLM 直接调用 napm-skill-query 但没传参数 |
| `incomplete_resolved_query` | 缺少必填字段 | 缺少 `metrics`、`queryModeKey`、`topMetric` 等 |
| `invalid_time_boundary_alignment` | start/end 未对齐到分钟 | LLM 自己算了时间戳但精度不对 |
| `invalid_query_mode` | queryModeKey 不合法 | LLM 传了非标准的 queryModeKey |
| `unknown_service` | service 字段不在 spec 中 | LLM 传了未注册的 service 名称 |

### Layer 4：API 层 — NAPM 调用详情

**目标**：确认 NAPM API 调了什么、是否成功、耗时多少

```bash
# 查 API 请求（combined.log — Skill 内部视角）
grep 'Making NAPM API request' /home/netinside/.openclaw/logs/combined.log | grep 'HH:MM'
# → 提取 URL、查询参数、时间戳

# 查 API 成功/失败
grep 'HH:MM' /home/netinside/.openclaw/logs/combined.log | grep -E 'NAPM API response received|NAPM API request failed'

# 查 API 请求构建（audit.log — Plugin 视角）
grep 'HH:MM' /home/netinside/.openclaw/logs/audit.log | grep 'napm_api_request_built'
# → 提取 gatewayRequest（service、metrics、groups、start、end）
```

**从 API URL 中反查的关键信息**：
```
URL 参数          含义            如何判断
────────────────────────────────────────────
type=topValues    NAPM 服务类型    是否匹配预期
groupType1=...    查询维度         IPAddress/BusinessGroup/DefinedApp
metrics=...       查询指标         TPIO/BYTIO/CCNI 等
start=...         起始时间戳       end-start 是否匹配 timeRange.key
end=...           结束时间戳       Date.now() 验证时间覆盖是否生效
topCount=10       Top N 数量      是否匹配用户请求
```

### Layer 5：Prompt 层 — 上下文大小分析

**目标**：分析 LLM 每轮看到的 Prompt 大小，判断是否有膨胀

**本地分析命令**：
```bash
cd "<project>" && node -e "
const fs = require('fs');
const content = fs.readFileSync('napm-openclaw-plugin.remote.js', 'utf8');

// 提取路由上下文
// 在 buildNapmRoutingSystemContext() 函数体内
// 估算字符数和 Token 数（中英文混合约 0.4 token/字符）

// 提取每个 Tool 定义
// createSkillToolDefinition / createAlertQueryToolDefinition 等
// 统计各定义的字符数
"
```

**正常范围**：
| 组成部分 | 正常范围 | 当前值 | 状态 |
|---------|---------|--------|------|
| 路由上下文 | 2,000-4,000 token | ~5,000 | ⚠️ 偏大 |
| 单个 Tool 定义 | 500-1,500 token | 1,500-2,200 | ⚠️ 偏大 |
| 7 个 Tool 合计 | 5,000-10,000 token | ~10,300 | ⚠️ 偏大 |
| 总输入 Token | 8,000-15,000 | ~16,000 | ⚠️ 偏大 |

## 完整排查案例速查

参考文档：[docs/2026-07-08-查询流程耗时排查-吞吐量前10IP.md](../docs/2026-07-08-查询流程耗时排查-吞吐量前10IP.md)

### 典型案例：吞吐量前 10 IP（10.3s 端到端）

```
09:40:44.768  消息到达     ─── T0
09:40:44.773  NAPM 检测    +5ms
09:40:44.778  路由完成      +10ms
09:40:45.680  思考中回复    +912ms    ← Agent 启动 (阶段1)
09:40:46.775  流式开始      +1,095ms  ← LLM 开始推理 (阶段2 开始)
    ↓
    LLM 推理 → Tool 决策 → before_tool_call Hook (<5ms)
    → handleSkillCall (<10ms) → NAPM API (~200ms)
    → LLM 格式化回答
    ↓
09:40:55.108  最终回复      +10,340ms ← LLM 推理结束 (阶段2 结束)
09:40:55.317  WeCom ack     +10,549ms ← 完整闭环
```

### Agent 内部阶段耗时参考值（基于实测）

```
阶段                     正常范围      本次实测    占比
─────────────────────────────────────────────────────
Agent 启动 (prefill)      500-1,500ms   902ms      8.7%
LLM 思考 + Tool 决策      500-2,000ms   1,095ms    10.6%
Hook + Skill + API        50-500ms      <300ms     ~2%
LLM 结果处理 + 格式化     3,000-8,000ms ~8,000ms   77.4%  ← 主瓶颈
回复发送 + ack            100-300ms     209ms      2.0%
─────────────────────────────────────────────────────
端到端合计                5,000-12,000ms 10,549ms  100%
```

### 耗时分布速查

```
< 5s    ✅ 正常
5-10s   ⚠️ LLM 推理为主，关注 Prompt 大小
10-20s  ⚠️ 可能存在 API 400 错误 + LLM 纠错重试
> 20s   🔴 严重，检查 NAPM API 超时或 LLM 循环
```

## 已知问题与注意事项

### 日志相关

1. **Agent 侧日志（audit.log / combined.log）的时区问题**：`audit.log` 和 `combined.log` 中的 `timestamp` 字段显示的是 NAPM API 服务器的时间，该服务器时钟偏移约 61 天（当前显示 `2026-05-08` 而非实际日期）。**时分秒是准确的，日期需忽略**。但 API 请求中的 `start/end` Unix 时间戳使用的是 Plugin 侧 `Date.now()` 计算的值（准确）。

2. **主日志（/tmp/openclaw/）只记录频道层事件**：不含 LLM 思考过程、tool call 的 request/response 详情。Agent 内部阶段需要通过 `streamId` 事件和 `kind=final` 事件推断。

3. **新架构（2026-07-07 重构后）缺失部分审计事件**：删除 `execFileAsync` executor 后，`napm_plugin_skill_executor_invoked` 和 `napm_plugin_skill_executor_completed` 事件不再输出。排查时需转而依赖 `combined.log` 中的 API 调用日志和 `audit.log` 中的 `napm_api_request_built` 事件。

4. **plink 连接不稳定**：复杂 grep 或大文件读取时连接可能被 reset，建议每次查少量行（head 限制）或使用 `grep 'HH:MM' | head -N` 缩小范围。

### 架构相关

5. **Plugin 实际加载路径**：Gateway 从 `/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs` 加载 Plugin，**不是** workspace 目录。`index.mjs` 优先加载 `./index.js`（编译版），回退到 `./napm-openclaw-plugin.remote.js`。推送 Plugin 必须覆盖 extensions 目录。

6. **`openclaw.plugin.json` 的 contracts 声明必需**：Gateway 对每个注册的 Tool 检查 contracts 声明，缺失会输出 warning（不影响功能，但生产环境应消除）。

7. **NAPM API 服务器时钟偏移**：`combined.log` 中的 API 调用时间戳由 NAPM API 服务器（`101.254.114.238`）生成，偏移约 61 天。该偏移可能导致 API 响应中的时间相关字段异常，但不影响数据内容本身。

### 排查相关

8. **Agent 内部阶段无法直接观测**：OpenClaw 目前不在主日志中记录 LLM API 调用、Tool Call 决策、Tool Result 返回等 Agent 内部事件。排查时需通过以下间接方式推断：
   - `streamId=... finish=false` 的**首次出现时间** ≈ LLM 开始推理
   - `kind=final` 的时间 ≈ LLM 推理结束
   - `combined.log` 中的 API 调用时间 ≈ NAPM API 往返
   - 主日志中两个 `streamId` 事件之间的间隔 = LLM 推理 + Tool 调用 + API 等待

9. **审计日志可能有大量旧数据**：`audit.log` 是追加写入的，行数可能非常多。务必用 `grep 'HH:MM'` 过滤时间窗口，否则 plink 会超时。

## 本地 vs 远端日志对比

| | 本地项目日志 | 远端 OpenClaw 日志 |
|--|-----------|----------------|
| 位置 | `项目/logs/audit.log` | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` |
| 内容 | 直接调用 skill 的审计记录 | 频道层事件（消息收发、路由） |
| 覆盖 | 本地开发/测试 | 生产环境（企业微信用户请求） |
| 访问 | 直接读 | 需 SSH |

## 相关文档

- [架构重构实施记录](../docs/2026-07-07-架构重构实施记录-消除子进程统一时间覆盖.md) — 2026-07-07 重构详细记录
- [查询流程耗时排查案例](../docs/2026-07-08-查询流程耗时排查-吞吐量前10IP.md) — 本文档的实战案例
- [LLM 推理耗时根因分析](../docs/2026-06-23-LLM推理耗时根因分析.md) — 历史数据分析
- [架构重构方案](../docs/2026-07-06-架构重构方案-消除子进程边界统一时间覆盖.md) — 重构设计文档
- [项目时间处理分析](../docs/2026-07-06-项目时间处理全面分析文档.md) — 时间处理全链路
