# NAPM Syslog Watcher Skill

将 NAPM Syslog 告警实时推送到企业微信群的守护进程。

## 架构

```
NAPM → Syslog UDP 514 → rsyslog → /var/log/netinside/syslog.log
                                          ↓ tail -F
                                   SyslogWatcherService
                                          ↓
                              ┌───────────┼───────────┐
                              ↓           ↓           ↓
                     SyslogParser    AlertEnrichment   WeComPush
                     (解析行)       (NAPM API详情)    (企业微信)
```

## 文件结构

```
skills/openclaw-napm-syslog-watcher/
├── SKILL.md
├── config/
│   └── watcher.config.json       # 配置文件（Webhook URL 等）
├── scripts/
│   ├── run_syslog_watcher.js     # 入口脚本
│   └── install_syslog_watcher.sh # systemd 服务安装脚本
└── services/
    ├── SyslogWatcherService.js   # 主守护进程（tail 监听 + 编排）
    ├── SyslogParserService.js    # NAPM Syslog 行解析
    ├── AlertEnrichmentService.js # NAPM API 告警详情补充
    └── WeComPushService.js       # 企业微信 Webhook 推送
```

## 配置

编辑 `config/watcher.config.json`：

```json
{
  "wecom": {
    "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY_HERE"
  },
  "alertReference": {
    "enabled": true,
    "ttlHours": 168,
    "packetBufferSeconds": 120
  }
}
```

将 `YOUR_KEY_HERE` 替换为企业微信群机器人的 Webhook Key。

告警推送与 OpenClaw 查询通过共享告警档案跨会话关联。默认告警引用保留 7 天，数据包文件保留 24 小时。生产环境可通过环境变量覆盖：

```text
NAPM_ALERT_REFERENCE_DIR=<共享告警引用目录>
NAPM_ALERT_REFERENCE_TTL_MS=604800000
NAPM_ALERT_REFERENCE_MAX_ENTRIES=10000
ALERT_REFERENCE_PACKET_ARTIFACT_TTL_HOURS=24
```

推送正文只展示 `GJ-XXXXXX` 引用编号，不展示 `eventId`、Unix `start/end` 或内部下载参数。多候选时使用 `GJ-XXXXXX-P1` 选择具体数据包。

## 部署

1. 将本目录推送到远端服务器 `/home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/`
2. 在远端服务器上执行：
   ```bash
   sudo bash /home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/scripts/install_syslog_watcher.sh
   ```
3. 验证：
   ```bash
   sudo journalctl -u napm-syslog-watcher -f
   ```

## 前置依赖

- Node.js >= 18
- rsyslog 已配置并监听 UDP 514
- `/var/log/netinside/syslog.log` 存在
- 企业微信群机器人 Webhook URL 已获取
