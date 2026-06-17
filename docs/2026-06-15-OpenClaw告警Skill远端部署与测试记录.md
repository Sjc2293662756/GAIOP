# OpenClaw 告警 Skill 远端部署与测试记录

日期：2026-06-15

## 1. 部署范围

本次部署初版只读告警 skill：

- `openclaw-napm-alert-query`
- 插件工具：`napm-alert-query`

本次未实现、未部署任何告警新增/修改/删除配置能力。

## 2. 远端路径

远端环境：

- 主机：`<OPENCLAW_HOST>`
- 用户：`<deploy-user>`
- OpenClaw Home：`/home/netinside/.openclaw`
- OpenClaw Skills Root：`/home/netinside/.openclaw/workspace/skills`
- OpenClaw Gateway 服务：`openclaw-gateway.service`

覆盖文件：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/openclaw.plugin.json
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/
```

## 3. 备份目录

本次部署过程产生以下远端备份：

```text
/home/netinside/.openclaw/deploy_backups/20260615_214210_alert_skill
/home/netinside/.openclaw/deploy_backups/20260615_214324_alert_skill_envfix
/home/netinside/.openclaw/deploy_backups/20260615_214805_alert_skill_minute_align
/home/netinside/.openclaw/deploy_backups/20260615_215040_alert_skill_detail_enrich
```

最终生效版本为：

```text
20260615_215040_alert_skill_detail_enrich
```

## 4. 远端语法检查

已通过：

```text
node --check /home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
node --check /home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/scripts/run_alert_query.js
node --check /home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/services/*.js
```

## 5. 真实接口 Smoke 结果

时间范围：

- 最近一小时
- `start/end` 已按分钟对齐

### 5.1 `explain_notification`

结果：

```text
EXPLAIN_OK=true
EXPLAIN_MODE=explain_notification
EXPLAIN_SERVICE=explain_notification
```

### 5.2 `summary`

调用接口：

```text
alertsSummary
```

结果：

```text
SUMMARY_OK=true
SUMMARY_MODE=summary
SUMMARY_SERVICE=alertsSummary
SUMMARY_TOTAL=5
SUMMARY_EVENTS=5
```

说明：

- 初次用未对齐秒级时间调用时，后端返回 `400`。
- 已修复为自动将 `criteria.start/end` floor 到分钟。

### 5.3 `timeline`

调用接口：

```text
alertsSummaryTimeLine
```

结果：

```text
TIMELINE_OK=true
TIMELINE_MODE=timeline
TIMELINE_SERVICE=alertsSummaryTimeLine
TIMELINE_TIMELINE=40
TIMELINE_WARNINGS=ALERT_TIMELINE_ORDER_UNCONFIRMED
```

说明：

- 时间线接口已可查询。
- 严重级别数组顺序仍按前端现有读取逻辑解释，并保留 warning。

### 5.4 `detail`

调用接口：

```text
alertsDetail
```

结果：

```text
DETAIL_OK=true
DETAIL_MODE=detail
DETAIL_SERVICE=alertsDetail
DETAIL_DETAILS=1
DETAIL_PACKET_HANDOFF=false
```

说明：

- `alertsDetail` 的重复 `eventids` 参数构造生效。
- 当前测试事件 `linkType=0`，因此没有生成 packet handoff。

### 5.5 `detail_with_timeseries`

调用链路：

```text
alertsDetail
  -> alertsSummary 补齐 detail 缺失的 metrics/unit
  -> timeValues
```

结果：

```text
SERIES_OK=true
SERIES_MODE=detail_with_timeseries
SERIES_SERVICE=alertsDetail
DETAILS=1
DETAIL_METRICS=PGNPGE
DETAIL_GROUP_TYPE=WebApplication
METRIC_SERIES=1
SERIES_ERRORS=0
PACKET_HANDOFF=false
```

说明：

- 真实 `alertsDetail` 对测试事件没有返回 `metrics/unit`。
- 已补充“详情缺指标时，从同时间范围的 `alertsSummary` 按 eventId 回填”的逻辑。
- 回填后成功调用 `timeValues`。

## 6. 插件注册验证

远端直接加载插件后，生产注册工具为：

```text
TOOLS=napm-alert-query,napm-packet-analysis,napm-report-export,napm-skill-query
COMMANDS=napm-alert-query,napm-packet-analysis,napm-report-export,napm-skill-query
HAS_ALERT_TOOL=true
```

说明：

- `napm-alert-query` 已被插件注册。
- OpenClaw gateway 已重启生效。

## 7. 服务状态

远端服务重启后状态：

```text
openclaw-gateway.service active
MainPID=2725589
ExecMainStartTimestamp=Mon 2026-06-15 21:51:18 CST
ActiveState=active
SubState=running
```

## 8. 本次发现与修复

### 8.1 `.env` 加载路径

远端 skill 实际位于：

```text
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query
```

初版只加载 workspace 相对 `.env`，直接 smoke 时无法稳定读取 `/home/netinside/.openclaw/.env`。

已修复为候选路径加载：

- workspace root `.env`
- current working directory `.env`
- `$OPENCLAW_HOME/.env`
- `$HOME/.openclaw/.env`

### 8.2 时间对齐

真实告警接口对未按分钟对齐的 `start/end` 返回 `400`。

已修复：

```text
criteria.start/end -> floor 到 60 秒边界
```

### 8.3 详情缺指标

真实 `alertsDetail` 可能缺少 `metrics/unit`。

已修复：

```text
detail_with_timeseries:
  如果 detail 缺 metrics
  则调用 alertsSummary
  按 eventId 回填 metrics/value/baseline/unit/condition/name/category
  再调用 timeValues
```

## 9. 后续建议

下一步建议验证 OpenClaw 主链自然语言调用，而不仅是 CLI：

```text
最近一小时有哪些告警？
最近一小时告警数量趋势怎么样？
告警 <eventId> 的详情是什么？
这个告警为什么触发？
把最近一小时告警导出成 Word 报告。
```

如果主链没有自动选择 `napm-alert-query`，下一步应继续加强插件 prompt routing / tool-use 指令，而不是修改 skill 查询层。
