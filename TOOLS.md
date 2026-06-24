# TOOLS.md - 观枢AI 本地工作提示

本文件记录当前部署的环境约束和维护提示，不记录密钥、token、密码或企业微信 secret。

## 使用场景

- 当前主要入口：企业微信智能运维助手
- 目标项目：观枢 GAIOP / NAPM
- 主要方向：网络流量分析、应用性能分析、告警查询、巡检报告、综述报告、数据包分析、Syslog 告警推送
- 默认输出：中文，短结论优先，必要时展开依据和建议动作

## NAPM 工具边界

当前 6 个 OpenClaw 工具，各有严格边界：

| 工具名 | 用途 | 边界 |
|---|---|---|
| `napm-skill-query` | NAPM 自然语言查询 | 只接受结构化 `resolvedQuery`，不做 NL 理解 |
| `napm-report-export` | 报告生成与导出 | 消费 reportData → Word → PDF，不发文件前必须走过此工具 |
| `napm-packet-analysis` | 数据包分析 | 下载、预览、业务页面定位 |
| `napm-alert-query` | 告警查询 | 告警摘要/时间线/详情/通知字段说明 |
| `napm-inspection-snapshot` | 巡检快照 | 流量健康/业务性能一键巡检 |
| `napm-summary` | 综述报告 | 全局/网络/Web/应用/业务组/告警 6 种 scope 综述 |

- 自然语言理解、对象识别、指标识别和 `resolvedQuery` 构造由 OpenClaw 上游负责。
- NAPM skill 只执行结构化查询并返回结构化结果、摘要和叙述输入。
- 普通用户问题不要使用 shell、curl 或直接 NetInside WebService 调用。

## 本机关键路径

- OpenClaw 根目录：`/home/netinside/.openclaw`
- 工作区：`/home/netinside/.openclaw/workspace`
- NAPM 插件：`/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js`
- 插件配置：`/home/netinside/.openclaw/workspace/openclaw.plugin.json`
- Skills 根目录：`/home/netinside/.openclaw/workspace/skills/`
- NAPM 审计日志：`/home/netinside/.openclaw/logs/audit.log`

### 各 Skill 执行器

| Skill | 入口脚本 |
|---|---|
| query | `skills/openclaw-napm-query/scripts/run_napm_query.js` |
| report | `skills/openclaw-napm-report/scripts/generate_napm_report.js` |
| packet | `skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js` |
| alert | `skills/openclaw-napm-alert-query/scripts/run_alert_query.js` |
| inspection | `skills/openclaw-napm-inspection/scripts/run_inspection_snapshot.js` |
| summary | `skills/openclaw-napm-summary/scripts/run_summary.js` |

## 服务维护命令

Gateway 当前通过 PM2 或直接 node 进程运行（端口 18789），不依赖 systemd。

```bash
# 查看 Gateway 进程
ps aux | grep -E 'openclaw|gateway' | grep -v grep

# 日志排查
tail -f /home/netinside/.openclaw/logs/*.log
tail -f /home/netinside/.openclaw/logs/audit.log
```

重启服务前确认当前运行方式，避免误用 systemd 命令。

## 部署推送

使用 pscp 逐个文件推送到远端，详见 `memory/deploy-push-config.md`。

```bash
pscp -pw <pw> "<local-file>" "netinside@101.254.114.237:/home/netinside/.openclaw/workspace/<remote-path>/"
```

推送后服务动态加载 skills 和 plugin，一般不需要重启。

## 报告模板

- 巡检：`skills/openclaw-napm-report/templates/inspection/`
- 故障诊断：`skills/openclaw-napm-report/templates/diagnostic/`
- 综述：`skills/openclaw-napm-report/templates/summary/`

每个模板目录含：`napm_*_v1.json`（主模板）、`chart-specs.v1.json`（图表规格）、`narrative-rules.v1.json`（叙述规则）。

## 回答提示

- 面向企业微信用户时，不主动展示内部路径、版本、公网地址或配置细节。
- 面向维护人员排障时，可以引用路径和服务名，但输出必须脱敏。
- 指标类回答要说明指标含义、单位或方向，避免只给英文指标名。
- 排障类回答优先给下一步可执行检查，而不是泛泛解释。
- 追问"详细点""继续看"时，保持上一轮上下文。
- 报告类请求识别关键词：综述报告、日报、周报、巡检报告、故障诊断报告。

## 文档维护

- 项目事实变化：更新 `PROJECT.md`。
- 技能/工具/路径变化：更新 `TOOLS.md`（本文件）。
- 人设或回答边界变化：更新 `SOUL.md` 和 `IDENTITY.md`。
- 重要经验：追加到 `memory/YYYY-MM-DD.md`。
- 部署/配置变更：追加到 `docs/` 并更新对应 memory。
