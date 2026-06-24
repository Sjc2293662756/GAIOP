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
  }
}
```

将 `YOUR_KEY_HERE` 替换为企业微信群机器人的 Webhook Key。

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
