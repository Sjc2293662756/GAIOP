---
name: openclaw-napm-fault-diagnosis
description: NAPM 故障诊断分析 Skill。按公司标准故障分析流程，分步查询 NAPM 系统指标，提供判断提示，支持流程跳转，最终生成结构化故障分析报告。覆盖网络慢/网络运行异常、B/S业务慢、C/S应用慢三类流程。
---

# NAPM 故障诊断分析 Skill

## 核心原则

**系统先查指标，指标只能说明趋势、对象和异常方向；当需要确认报文级原因时，再下载数据包进行深入分析。**

## Skill Boundary

Use this skill for:
- 用户反馈网络慢、全网卡、访问多个系统都慢
- 用户反馈 Web 系统 4xx/5xx 报错、HTTP 错误、页面级错误分析
- 用户反馈客户端软件慢、数据库访问慢、非 Web 应用慢
- 需要按标准化流程逐步诊断网络或应用故障
- 需要生成结构化的故障分析报告

Do not use this skill for:
- 单一指标查询 → use `openclaw-napm-query`
- 综述报告 → use `openclaw-napm-summary`
- 巡检报告 → use `openclaw-napm-inspection`
- 数据包下载和分析 → use `openclaw-napm-packet-analysis`
- 报告文件生成 → use `openclaw-napm-report`

## 支持的故障分析流程

| 流程 | flowType | 适用场景 |
|------|---------|---------|
| 网络慢/网络运行异常 | `network_slow` | 全网慢、整体卡顿、带宽疑似被占满、流量异常 |
| B/S 架构业务慢 | `bs_app_slow` | Web 页面 4xx/5xx 报错、页面错误分析、状态码详情 |
| C/S 架构应用慢 | `cs_app_slow` | 客户端软件慢、数据库访问慢、固定端口应用慢 |

## 分层分析原则

```
场景识别 → 系统指标查询 → 指标判断（趋势+对象+方向）
  ├─ 指标足够 → 输出初步结论
  └─ 触发数据包条件 → 建议下载数据包 → 包级验证 → 输出根因
```

### 系统指标能回答的
- 整体流量趋势、方向异常
- Top 异常对象（应用/主机/工作组/会话）
- 丢包/延时/重传率
- 连接成功/失败数和分布
- 业务慢访问、HTTP 错误统计
- 耗时阶段拆分（建连/服务器响应/数据传输/重传）

### 数据包才能回答的（系统指标不能直接判断）
- RST 来源和方向
- SYN 无响应原因
- Zero Window / Window Full / Duplicate ACK
- ARP 源 MAC、ICMP 不可达详情
- HTTP 请求/响应具体内容

### 数据包触发条件
以下任一条件满足时，系统会提示"建议下载数据包"：
- 重传率或包重传率异常高
- 失败数/失败率异常高
- 每秒数据包数异常高但字节数不高
- 连接建立时间异常高
- 系统指标无法区分应用慢还是网络慢

## 调用模式

### 标准化流程（B/S 业务慢、C/S 应用慢）— 单次调用

标准化流程不需要多轮对话。OpenClaw 一次调用，系统自动执行全部步骤并返回报告。

```
OpenClaw 调用 run({ description, flowType, target, timeRange })
  → 自动执行 Step1 → Step2 → ... → StepN
  → 返回 { ok, reportReady, reportData, steps }
  → OpenClaw 调 openclaw-napm-report 生成 docx
```

### 交互式流程（网络慢/网络运行异常）— 多轮调用

网络慢流程需要用户在步骤间做判断和跳转决策。

```
Turn 1: start({ description, timeRange })
  → 返回 { ok, sessionJson, step: { data, hints, nextOptions } }
  → OpenClaw 保存 sessionJson

Turn 2: start({ sessionJson, action: "继续下一步" })
  → 返回 { ok, sessionJson, step: {...} }
  → OpenClaw 更新 sessionJson

Turn N: start({ sessionJson, action: "生成报告" })
  → 返回 { ok, reportReady, reportData }
```

## Input Contract

### 标准化流程（B/S、C/S）— run()

```json
{
  "description": "238web 页面大量 HTTP 400/500 报错",
  "flowType": "bs_app_slow",
  "target": {
    "groupType": "WebApplication",
    "groupArgument": "238web",
    "groupLabel": "238web"
  },
  "timeRange": {
    "faultWindow": { "start": 1750000000, "end": 1750086400 }
  }
}
```

### 交互式流程（网络慢）— start()

首次启动：
```json
{
  "description": "全网慢，昨天下午2点到4点",
  "timeRange": {
    "faultWindow": { "start": 1780000000, "end": 1780007200 }
  }
}
```

继续/跳转/报告：
```json
{
  "sessionJson": "<上一轮返回的>",
  "action": "继续下一步"
}
```

## Output Contract

### 标准化流程 — run() 返回

```json
{
  "ok": true,
  "reportReady": true,
  "reportData": {
    "reportType": "diagnostic_report",
    "templateId": "napm_fault_diagnosis_v2"
  },
  "flowType": "bs_app_slow",
  "steps": [
    {
      "stepId": "step1_4xx_5xx_overview",
      "description": "第一步：查询业务 4xx/5xx 报错情况",
      "hints": [
        { "type": "judgment", "text": "HTTP 400和500同时升高，可能存在应用层全面异常" }
      ],
      "analysisFlags": { "http400Up": true, "http500Up": true }
    }
  ]
}
```

### 交互式流程 — start() 返回

```json
{
  "ok": true,
  "sessionJson": "<序列化后的 session，OpenClaw 必须透传>",
  "step": {
    "stepId": "step1_traffic_trend",
    "description": "第一步：查看总流量趋势",
    "data": {...},
    "hints": [...],
    "nextOptions": [...]
  }
}
```

## Environment Variables

复用 openclaw-napm-summary 的环境变量：
- `NETINSIDE_HOST` — NAPM API base URL
- `NETINSIDE_USERNAME` — NAPM username
- `NETINSIDE_PASSWORD` — NAPM password
- `NETINSIDE_TLS_INSECURE` — Skip TLS verification
