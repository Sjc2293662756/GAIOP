---
name: remote-log-investigation-guide
description: 远端OpenClaw日志排查完整流程（SSH连接、日志位置、命令模板、时间线分析）
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
| SSH 方式 | plink（Windows 自带 Putty 工具） |

## 日志文件位置

| 文件 | 路径 | 内容 |
|------|------|------|
| **主日志**（频道层） | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | 用户消息接收、NAPM边界检测、动态路由、回复发送、WebSocket ack |
| Agent audit | `/home/netinside/.openclaw/logs/audit.log` | 工具调用事件 |
| Agent combined | `/home/netinside/.openclaw/logs/combined.log` | NapmClient 初始化、API请求详情 |
| Workspace audit | `/home/netinside/.openclaw/workspace/logs/audit.log` | 同上（workspace副本） |
| Workspace combined | `/home/netinside/.openclaw/workspace/logs/combined.log` | 同上 |
| Plugin audit | `/home/netinside/.openclaw/logs/audit.log` | napm-skill-query 工具执行审计 |

## 命令模板

### 通用 SSH 命令格式
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "<远程命令>" 2>&1
```

### 按时间窗口查主日志
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "grep 'HH:MM' /tmp/openclaw/openclaw-YYYY-MM-DD.log | head -N" 2>&1
```

### 查用户消息到达
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "grep 'aibot_msg_callback.*content' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'" 2>&1
```

### 查 NAPM 边界检测
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "grep 'napm-boundary' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'" 2>&1
```

### 查 LLM 回复内容
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "grep 'openclaw.*plugin.*kind=final' /tmp/openclaw/openclaw-YYYY-MM-DD.log | grep 'HH:MM'" 2>&1
```

### 查 Agent 工具调用（需先确认 agent 日志有当天数据）
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "grep 'HH:MM' /home/netinside/.openclaw/logs/combined.log" 2>&1
```

### 查日志文件基本信息
```bash
echo y | "D:\PUTTY\plink.exe" -pw netinside_123 netinside@101.254.114.237 "ls -la /tmp/openclaw/ && echo '---' && ls -la /home/netinside/.openclaw/logs/" 2>&1
```

## 日志字段解读

主日志每行是一个 JSON，关键字段：

| 字段 | 含义 |
|------|------|
| `time` | 本地时间（+08:00），如 `2026-06-23T17:08:02.999+08:00` |
| `hostname` | `netinsideopenclaw` |
| `message` | 事件描述，格式：`[子系统] 事件详情` |

### message 关键事件类型

| message 特征 | 含义 |
|-------------|------|
| `[server -> plugin] cmd=aibot_msg_callback` | 企业微信用户消息到达 |
| `[wecom][napm-boundary] NAPM prompt detected` | NAPM 边界识别通过，进入 Agent |
| `[dynamic-routing]` | Agent 路由选择 |
| `[openclaw -> plugin] kind=final` | LLM 最终回复内容（payload.text） |
| `[plugin -> server] streamId=... finish=false` | 流式输出开始 |
| `[plugin -> server] streamId=... finish=true` | 流式输出结束 |
| `Reply message sent via WebSocket` | 回复已发送到企业微信 |
| `Reply ack received` | 企业微信确认收到 |

## 时间线分析模板

对于一个查询，按以下步骤分析：

### Step 1：找到用户消息
```
grep 'aibot_msg_callback.*"content"' → 得到 T0（用户消息时间）
提取 content 字段 → 确认用户原话
```

### Step 2：找到最终回复
```
grep 'openclaw.*plugin.*kind=final' → 得到 T1（最终回复时间）
提取 payload.text → 确认回答内容
```

### Step 3：计算总耗时
```
T1 - T0 = 端到端耗时
```

### Step 4：分析中间过程
```
T0 到 T1 之间：
  - 是否有多个 kind=final？→ LLM 发了多轮思考（如"刚才查询的是 PLI"→"换 HTTP 错误码重查"）
  - 是否有长时间无日志？→ LLM 推理或等待 API 返回
  - 第一个 kind=final 和最后一个之间的时间差？→ LLM 纠错/重试耗时
```

### Step 5：诊断瓶颈
```
< 5s：正常
5-10s：LLM 推理为主，观察是否有多轮 tool call
10-30s：存在纠错/重试，查看是否有指标映射错误
> 30s：严重问题，检查 NAPM API 超时或 LLM 循环
```

## 已知问题

1. **Agent 侧日志（audit.log / combined.log）不一定有当天数据**：Agent 的 `combined.log` 和 `audit.log` 由 napm-openclaw-plugin 写入，但如果插件进程的日志没刷新到磁盘或使用了不同的日志路径，这些文件可能滞后或为空。

2. **主日志（/tmp/openclaw/）只记录频道层事件**：不含 LLM 思考过程、tool call 的 request/response 详情、NAP API 调用详情。

3. **plink 连接不稳定**：复杂 grep 或大文件读取时连接可能被 reset，建议每次查少量行（head 限制行数）。

## 本地 vs 远端日志对比

| | 本地项目日志 | 远端 OpenClaw 日志 |
|--|-----------|----------------|
| 位置 | `项目/logs/audit.log` | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` |
| 内容 | 直接调用 skill 的审计记录 | 频道层事件（消息收发、路由） |
| 覆盖 | 本地开发/测试 | 生产环境（企业微信用户请求） |
| 访问 | 直接读 | 需 SSH |
