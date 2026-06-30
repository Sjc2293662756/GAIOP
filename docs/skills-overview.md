# NAPM Skills 目录说明

`skills/` 目录下共有 **9 个 skill**，按功能分为通用工具和 NAPM 业务两大类。

---

## 1. echarts-chart-skill — ECharts 图表生成 Skill

**用途**：将结构化数据转换为 ECharts 图表（折线图、饼图、柱状图、雷达图、桑基图等 18+ 种图表），支持导出 HTML（交互预览）和 SVG（静态图片）。这是一个通用工具 skill，不是 NAPM 专用的。

**支持图表类型**：`line`（折线图）、`bar`（柱状图）、`pie`（饼图）、`scatter`（散点图）、`effectScatter`（涟漪散点图）、`radar`（雷达图）、`funnel`（漏斗图）、`gauge`（仪表盘）、`heatmap`（热力图）、`treemap`（矩形树图）、`sunburst`（旭日图）、`sankey`（桑基图）、`graph`（关系图）、`candlestick`（K 线图）、`boxplot`（箱线图）、`parallel`（平行坐标图）、`map`（地图）、`lines`（线路图）

---

## 2. openclaw-napm-alert-query — 告警查询 Skill

**用途**：查询 NAPM/NetInside 系统中的告警事件：

- 告警列表、告警摘要、告警概览
- 告警时间线、告警数量趋势
- 告警详情、触发指标、触发条件（阈值/基线）
- 告警通知字段解释（Email / SNMP / Syslog / 快照）

**只读**，不新增/修改/删除告警规则。

**支持模式**：`summary`、`timeline`、`detail`、`detail_with_timeseries`、`analysis`、`explain_notification`、`explain_event_fields`

---

## 3. openclaw-napm-fault-diagnosis — 故障诊断 Skill

**用途**：按标准故障分析流程，逐步诊断网络或应用故障，支持三条诊断路径：

| 流程 | flowType | 适用场景 |
|------|---------|---------|
| 网络慢/网络运行异常 | `network_slow` | 全网慢、整体卡顿、带宽疑似被占满、流量异常 |
| B/S 架构业务慢 | `bs_app_slow` | Web 页面慢、登录慢、接口慢、HTTP 400/500 |
| C/S 架构应用慢 | `cs_app_slow` | 客户端软件慢、数据库访问慢、固定端口应用慢 |

**核心原则**：系统先查指标，指标只能说明趋势、对象和异常方向；当需要确认报文级原因时，再下载数据包进行深入分析。

**交互模式**：用户描述问题 → 系统识别流程类型 → 逐步执行诊断（每步查询 NAPM 指标 → 呈现数据 + 判断提示 + 下一步选项）→ 用户选择继续/跳转/生成报告 → 最终生成 §8 结构故障分析报告

---

## 4. openclaw-napm-inspection — 巡检报告 Skill

**用途**：采集流量分析系统的健康巡检数据：

- 设备基本信息、性能状况
- 数据信息、配置信息
- 原始数据包存储信息
- 总流量趋势（最近 1 小时 + 最近 1 天）
- 业务性能数据

产出 `reportData` 供 report skill 生成 Word 巡检报告。采集后**自动触发 docx 生成**，无需用户额外确认。

---

## 5. openclaw-napm-packet-analysis — 数据包分析 Skill

**用途**：NAPM 数据包的预览、下载和分析：

- 预览可下载的数据包（按 IP / IP 段 / 告警事件 ID / Top 条件）
- 构造/解释 `packetsDown` / `DownServlet` URL
- 下载 pcap/cap 文件并用 `tshark` 分析
- 支持业务页面数据包分析（DownServlet 链路：`businessName → pageFamilyId → pageFamilyDetailId → instanceId`）
- 包含存储管理、大小风险提示、认证信息脱敏等安全策略

**支持模式**：`build_url_only`、`explain_url`、`preview_only`、`download_only`、`preview_download`、`analyze_file`、`download_analyze`、`preview_download_analyze`

**风险策略**：
- `low` → `CONTINUE_DOWNLOAD`：正常下载
- `medium/high` → `CONFIRM_DOWNLOAD`：需用户确认
- `high` → `SUGGEST_NARROW_TIME_RANGE`：建议缩小时间窗口

---

## 6. openclaw-napm-query — NAPM 指标查询 Skill

**用途**：NAPM/NetInside 的通用指标查询能力：

- 指标排行（TopN）、均值趋势、总量趋势
- 对象清单查询、下钻目录
- 中文语义 → 指标映射、维度解析
- 多模式查询（overview / timeValues / topValues / averageValues 等）

与告警查询分离：普通指标用这个，告警事件用 `alert-query`。

---

## 7. openclaw-napm-report — 报告生成 Skill

**用途**：消费结构化 `reportData` 生成 Word（docx）报告文件。支持三种报告类型：

| 模板 | reportType | 来源 Skill |
|------|-----------|-----------|
| 故障诊断报告 | `diagnostic_report` | `openclaw-napm-fault-diagnosis` |
| 巡检报告 | `inspection_report` | `openclaw-napm-inspection` |
| 综述报告 | `summary_report` | `openclaw-napm-summary` |

**不直接查询 NAPM**，只渲染已有数据，附带审计 JSON 副本。PDF 导出暂不可用（返回 `REPORT_PDF_EXPORT_UNAVAILABLE`）。

**禁止事项**：
- 不接收自然语言问题后自行理解查询意图
- 不直接调用 NAPM 南向 API
- 不生成没有结构化 `sections` 的报告

---

## 8. openclaw-napm-summary — 综述报告 Skill

**用途**：生成 NAPM 综述报告，按指定范围和时间聚合多维度数据：

| scope.type | 含义 | target 必填 |
|-----------|------|------------|
| `global` | 全局综述（所有维度） | 否 |
| `webApplication` | 业务综述（指定 Web 应用） | 是 |
| `application` | 应用综述（指定端口级应用） | 是 |
| `businessGroup` | 业务组综述 | 是 |
| `network` | 网络综述（IP/接口/会话） | 是 |
| `alert` | 告警综述 | 否 |

**聚合内容**：告警摘要 + 时间线、流量趋势 + Top IP/应用、业务性能（慢访问、HTTP 错误）、未解决告警列表。

产出的 `reportData` 直接传给 `openclaw-napm-report` 生成 docx。

---

## 9. openclaw-napm-syslog-watcher — Syslog 告警企业微信推送 Skill

**用途**：独立守护进程（systemd），实时监听 NAPM Syslog 日志，解析告警 → 补充 NAPM API 详情 → 推送企业微信群机器人。**不依赖 OpenClaw 网关**，独立运行。

### 9.1 架构数据流

```
NAPM (101.254.114.238)
  │  Syslog UDP 514 (GBK 编码)
  ▼
┌──────────────────────────────────────────────┐
│ 接收服务器 101.254.114.237                     │
│                                              │
│  rsyslog (UDP 514)                           │
│    └─ /var/log/netinside/syslog.log          │
│                                              │
│  napm-syslog-watcher.service (systemd)       │
│    │                                         │
│    ├─ tail -F -n 0 syslog.log                │
│    │   └─ 编码自适应 (UTF-8 → 含乱码回退GBK)  │
│    │                                         │
│    ├─ SyslogParserService                    │
│    │   ├─ 解析 rsyslog 模板行 (含微秒时间戳)    │
│    │   ├─ 提取 alertid / elogid / severity    │
│    │   ├─ 提取 condition / canongrouppath     │
│    │   └─ 提取 metric1~N (name/value/unit)    │
│    │                                         │
│    ├─ [N/D 过滤] 指标值全为 N/D → 跳过(已恢复)  │
│    │                                         │
│    ├─ AlertEnrichmentService                 │
│    │   └─ 复用 AlertApiService (alert-query)  │
│    │       └─ GET /webservice/NetInside       │
│    │          ?UserName=xxx&Password=xxx      │
│    │          &type=alertsDetail              │
│    │          &eventids=<elogid>              │
│    │          &start=...&end=...&json=true    │
│    │                                         │
│    └─ WeComPushService                       │
│        └─ POST 企业微信群机器人 Webhook        │
│           msgtype: markdown_v2                │
│           └─ 卡片 + 代码块(带复制按钮)          │
└──────────────────────────────────────────────┘
  │  HTTPS Webhook
  ▼
┌──────────────────────────────────────────────┐
│ 企业微信群 → Markdown 告警卡片                 │
│   ├─ 告警名称 / 严重级别(中文化) / 类别(中文化)  │
│   ├─ 触发条件(英文级别词→中文替换)              │
│   ├─ 监控对象 / 指标值                         │
│   ├─ Alert ID / Event ID / 告警窗口           │
│   ├─ 💬 深入分析: `代码块指令` (可一键复制)      │
│   └─ 📅 接收时间                               │
└──────────────────────────────────────────────┘
```

### 9.2 文件结构与职责

```
skills/openclaw-napm-syslog-watcher/
├── SKILL.md                             # Skill 概述
├── config/
│   └── watcher.config.json              # 运行配置（唯一运维入口）
│       ├── syslog.path                  # Syslog 日志文件路径
│       ├── napm.host/username/password  # NAPM API 连接
│       ├── wecom.webhookUrl             # 企业微信 Webhook
│       ├── dedup.windowSeconds          # 去重窗口 (0=关闭)
│       └── watcher.maxRetries           # API 重试次数
├── scripts/
│   ├── run_syslog_watcher.js            # 守护进程入口 (Node.js CLI)
│   ├── install_syslog_watcher.sh        # systemd 服务安装 (sudo bash)
│   ├── napm-syslog-watcher.service      # systemd unit 文件
│   ├── test_codeblock.js               # 企业微信 markdown 格式测试工具
│   └── test_codeblock.sh               # (同上, bash 版)
└── services/
    ├── SyslogWatcherService.js          # 主守护进程
    │   ├── tail -F 监听 + 编码自适应    # iconv-lite: UTF-8 → GBK
    │   ├── 逐行 → SyslogParser          # 行解析
    │   ├── N/D 过滤 → 去重 → 补充详情    # 编排逻辑
    │   └── 统计: 总行/解析/推送/去重/失败  # SIGTERM 优雅退出
    ├── SyslogParserService.js           # Syslog 行解析器
    │   ├── rsyslog 模板行正则匹配        # 含微秒时间戳 (?:\\.\\d+)?
    │   ├── key=value 对提取             # 含引号值: condition="..."
    │   └── metric1~N 指标提取
    ├── AlertEnrichmentService.js        # NAPM API 详情补充
    │   ├── 复用 AlertApiService         # 与 alert-query 技能共用
    │   ├── 优先用 elogid (非 alertid)    # 事件唯一ID
    │   ├── 时间窗口: starttime±30min     # endtime=0 时 ±1h
    │   └── 时间戳分钟对齐: floor(ts/60)*60
    └── WeComPushService.js             # 企业微信推送
        ├── markdown_v2 格式             # 代码块带复制按钮
        ├── 严重级别: 🔴紧急 🟠重大 轻微   # 🟡 企业微信不支持
        ├── 告警类别: 中文映射           # userAlerts→用户体验告警
        ├── 触发条件: 英文级别词→中文     # Critical→紧急
        ├── 快捷指令: 代码块(可复制)      # 含 elogid + 时间窗口
        └── endtime=0: 显示"持续中"      # 告警未恢复
```

### 9.3 关键设计决策

| 决策 | 原因 |
|---|---|
| `markdown_v2` 而非 `markdown` | `v2` 代码块带**一键复制按钮** |
| `mentioned_list` 字段不传 | `v2` 不兼容，会导致静默回退 v1 |
| 优先用 `elogid` 而非 `alertid` | `alertid` 是规则ID（一对多），`elogid` 是事件唯一ID |
| 编码自适应（UTF-8 → GBK） | NAPM 是中国厂商产品，Syslog 输出 GBK 编码 |
| 复用 `AlertApiService` | 与 alert-query 技能共用同一套 API 客户端，保持一致 |
| 独立 systemd 服务 | 不依赖 OpenClaw 网关，互不影响 |
| 去重用 `??` 而非 `\|\|` | `windowSeconds: 0` 会被 `\|\|` 误判为 falsy |
| endtime=0 兜底 | NAPM 对持续中告警发 endtime=0 |
| N/D 指标值过滤 | 全部指标为 N/D 表示告警已恢复，跳过不推送 |

### 9.4 配置与运维

**唯一配置文件**：`config/watcher.config.json`，改完执行 `sudo systemctl restart napm-syslog-watcher` 生效。

```bash
# 服务管理
sudo systemctl status napm-syslog-watcher     # 状态
sudo systemctl restart napm-syslog-watcher    # 重启
sudo journalctl -u napm-syslog-watcher -f     # 实时日志

# 验证 Syslog 接收
sudo tcpdump -ni any host 101.254.114.238 and udp port 514 -A
sudo tail -f /var/log/netinside/syslog.log
```

### 9.5 前置依赖

| 依赖 | 说明 |
|---|---|
| Node.js >= 18 | 运行环境 (`/usr/local/bin/node`) |
| rsyslog | UDP 514 接收 NAPM Syslog |
| `iconv-lite` | GBK 编码解码 (`npm install iconv-lite`) |
| `axios` | HTTP 客户端（复用项目已有依赖） |
| 企业微信群机器人 Webhook | 推送目标 (markdown_v2) |
| NAPM API 可达 | 补充告警详情 (`alertsDetail` 接口) |

---

## Skill 协作关系图

```
用户输入
  ├─ 查指标/排行/趋势 → openclaw-napm-query
  ├─ 查告警 → openclaw-napm-alert-query
  ├─ 查数据包 → openclaw-napm-packet-analysis
  ├─ 故障诊断 → openclaw-napm-fault-diagnosis → openclaw-napm-report
  ├─ 巡检 → openclaw-napm-inspection → openclaw-napm-report
  ├─ 综述 → openclaw-napm-summary → openclaw-napm-report
  └─ Syslog 推送 → openclaw-napm-syslog-watcher (守护进程)
```

## 数据流总览

```
                      ┌──────────────────────────────┐
                      │      openclaw-napm-report     │
                      │      (docx 报告生成)           │
                      └──────────────┬───────────────┘
                             ↑       ↑       ↑
                    reportData  reportData  reportData
                             ↑       ↑       ↑
              ┌──────────────┴───┐ ┌─┴───────────┴──┐ ┌───────────────────┐
              │ fault-diagnosis  │ │  inspection    │ │     summary       │
              │ (故障诊断分析)    │ │  (巡检采集)    │ │   (综述聚合)      │
              └──────────────────┘ └───────────────┘ └───────────────────┘
                      ↓                   ↓                   ↓
              ┌──────────────────────────────────────────────────────────┐
              │                     openclaw-napm-query                  │
              │                   (NAPM 南向指标查询)                     │
              └──────────────────────────────────────────────────────────┘
              ┌──────────────────────────────────────────────────────────┐
              │                 openclaw-napm-alert-query                │
              │                   (NAPM 告警查询)                         │
              └──────────────────────────────────────────────────────────┘
              ┌──────────────────────────────────────────────────────────┐
              │              openclaw-napm-packet-analysis               │
              │                (数据包预览/下载/分析)                      │
              └──────────────────────────────────────────────────────────┘

  echarts-chart-skill: 独立通用工具，生成 ECharts 图表
  syslog-watcher: 独立守护进程，Syslog → 企业微信推送
```
