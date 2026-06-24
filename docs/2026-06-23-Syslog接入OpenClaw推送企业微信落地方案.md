# Syslog 远端部署 + 接入 OpenClaw + 推送企业微信 落地方案

> 基于 [openclaw_napm_syslog_snmp_receiver_runbook.md](./openclaw_napm_syslog_snmp_receiver_runbook.md) 扩展，
> 在已有的 NAPM Syslog 接收链路之上，新增 **Syslog 消费守护进程** 和 **企业微信 Bot 推送**，
> 实现 NAPM 告警从 Syslog 到企业微信的端到端主动推送。

## 1. 总体架构

```
NAPM (101.254.114.238)
  │
  │  Syslog UDP 514
  ▼
┌─────────────────────────────────────────┐
│ Ubuntu 接收服务器 (如 101.254.114.237)    │
│                                         │
│  rsyslog (UDP 514)                      │
│    → /var/log/netinside/syslog.log      │
│                                         │
│  napm-syslog-watcher (新增)              │
│    tail -f syslog.log                   │
│    → 解析 NAPM 告警行                   │
│    → 调 NAPM API 获取告警详情            │
│    → 格式化为企业微信消息                │
│    → POST 企业微信 Webhook              │
└─────────────────────────────────────────┘
  │
  │  HTTPS POST (webhook)
  ▼
┌─────────────────────────────────────────┐
│ 企业微信机器人                            │
│   → 群聊中收到格式化告警卡片              │
└─────────────────────────────────────────┘
```

## 2. 前置条件

| 条件 | 说明 |
|---|---|
| 接收服务器 | Ubuntu 22.04+，与 OpenClaw 服务器可以是同一台（当前是 `101.254.114.237`）|
| Syslog 接收已配置 | 按照 runbook 第 1-5 节完成 rsyslog + 防火墙配置 |
| 企业微信机器人 Webhook Key | 在企业微信群中添加机器人，获取 Webhook URL |
| NAPM API 可达 | 接收服务器能访问 `https://101.254.114.238/webservice/NetInside` |
| Node.js | >= 18（接收服务器上已有，OpenClaw 运行依赖） |

### 2.1 获取企业微信机器人 Webhook URL

1. 打开目标企业微信群 → 群设置 → 群机器人 → 添加机器人
2. 复制 Webhook 地址，例如：
   ```
   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
3. 记录 `key` 参数值，后续配置需要。

## 3. Syslog 接收层配置

严格按照 [openclaw_napm_syslog_snmp_receiver_runbook.md](./openclaw_napm_syslog_snmp_receiver_runbook.md) 第 1-5 节执行：

```bash
# 1. 安装 rsyslog（通常已装）
sudo apt update && sudo apt install -y rsyslog

# 2. 创建日志目录
sudo install -d -o syslog -g adm -m 0755 /var/log/netinside
sudo touch /var/log/netinside/syslog.log
sudo chown syslog:adm /var/log/netinside/syslog.log
sudo chmod 0640 /var/log/netinside/syslog.log

# 3. 配置 rsyslog
sudo tee /etc/rsyslog.d/10-netinside.conf >/dev/null <<'EOF'
module(load="imudp")

template(name="NetinsideSyslogRaw" type="string"
         string="%timegenerated:::date-rfc3339% from=%fromhost-ip% host=%HOSTNAME% facility=%syslogfacility-text% severity=%syslogseverity-text% tag=%syslogtag%%msg%\n")

ruleset(name="netinside_udp514") {
    action(type="omfile" file="/var/log/netinside/syslog.log" template="NetinsideSyslogRaw")
    stop
}

input(type="imudp" port="514" ruleset="netinside_udp514")
EOF

# 4. 防火墙放行（只允许 NAPM 主机）
sudo ufw allow from 101.254.114.238 to any port 514 proto udp comment "NAPM Syslog UDP 514"

# 5. 重启 rsyslog
sudo systemctl restart rsyslog
sudo systemctl enable rsyslog

# 6. 验证监听
sudo ss -lunp | grep ':514'
```

## 4. Syslog 消费守护进程（napm-syslog-watcher）

### 4.1 设计思路

- 使用 `tail -f` 方式持续监听 `/var/log/netinside/syslog.log`
- 解析 NAPM Syslog 行，提取关键字段（告警名称、严重级别、alertId、指标值等）
- 对每条新告警调用 NAPM `alertsDetail` API 获取完整信息
- 格式化为企业微信 Markdown 消息并推送
- 内置去重：同一 alertId 在 N 秒内不重复推送
- 提供 heartbeat 日志、错误重试、优雅退出

### 4.2 文件结构

```
skills/openclaw-napm-syslog-watcher/
├── SKILL.md                          # 说明文档
├── scripts/
│   ├── run_syslog_watcher.js         # 入口（守护进程启动）
│   └── install_syslog_watcher.sh     # systemd 服务安装脚本
├── services/
│   ├── SyslogWatcherService.js       # tail -f + 行解析
│   ├── SyslogParserService.js        # NAPM Syslog 行解析器
│   ├── AlertEnrichmentService.js     # 调 NAPM API 获取详情
│   └── WeComPushService.js           # 企业微信 Webhook 推送
└── config/
    └── watcher.config.json           # 配置文件
```

### 4.3 配置文件 `watcher.config.json`

```json
{
  "syslog": {
    "path": "/var/log/netinside/syslog.log",
    "encoding": "utf-8"
  },
  "napm": {
    "baseUrl": "https://101.254.114.238/webservice/NetInside",
    "username": "GAIOP",
    "password": "GAIOP123",
    "tlsInsecure": true,
    "requestTimeoutMs": 15000
  },
  "wecom": {
    "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY_HERE",
    "mentionedList": [],
    "mentionedMobileList": []
  },
  "dedup": {
    "windowSeconds": 300,
    "maxCacheSize": 500
  },
  "watcher": {
    "pollIntervalMs": 2000,
    "maxRetries": 3,
    "retryDelayMs": 5000
  }
}
```

### 4.4 核心服务实现

#### SyslogParserService.js —— NAPM Syslog 行解析

NAPM 发出的 Syslog 行格式（来自 runbook 第 10 节样例）：

```
from=101.254.114.238 host=101.254.114.238 facility=local0 severity=notice tag=紧急:
userAlerts severity=紧急 name=SNMP测试 alertid=113 ...
metric1=流量（流入和流出） value1=... units1=兆字节
```

解析逻辑：

```javascript
// SyslogParserService.js
class SyslogParserService {
  /**
   * 解析单行 NAPM Syslog
   * @param {string} line - raw syslog line
   * @returns {object|null} - 结构化告警对象，或 null（非告警行）
   */
  parse(line) {
    // 匹配 rsyslog 模板前缀
    const headerMatch = line.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\s+from=([^\s]+)\s+host=([^\s]+)\s+facility=([^\s]+)\s+severity=([^\s]+)\s+tag=([^:]+):\s*(.*)$/
    );
    if (!headerMatch) return null;

    const [, timestamp, fromHost, host, facility, severity, tag, body] = headerMatch;

    // 从 body 中提取 NAPM 告警字段
    const alertMatch = body.match(
      /(\w+Alerts)\s+severity=([^\s]+)\s+name=([^\s]+?)\s+alertid=(\d+)/
    );
    if (!alertMatch) return null;

    // 提取所有 key=value 对
    const kvPairs = {};
    const kvRegex = /(\w+)=("[^"]*"|\S+)/g;
    let m;
    while ((m = kvRegex.exec(body)) !== null) {
      kvPairs[m[1]] = m[2].replace(/^"|"$/g, '');
    }

    return {
      timestamp,
      fromHost,
      facility,
      severity,
      tag,
      category: alertMatch[1],        // e.g. "userAlerts"
      alertSeverity: alertMatch[2],    // e.g. "紧急"
      alertName: alertMatch[3],
      alertId: parseInt(alertMatch[4]),
      metrics: this._extractMetrics(kvPairs),
      rawBody: body,
    };
  }

  _extractMetrics(kvPairs) {
    const metrics = [];
    for (let i = 1; ; i++) {
      const nameKey = `metric${i}`;
      const valueKey = `value${i}`;
      const unitKey = `units${i}`;
      if (!kvPairs[nameKey]) break;
      metrics.push({
        name: kvPairs[nameKey],
        value: kvPairs[valueKey] || '',
        unit: kvPairs[unitKey] || '',
      });
    }
    return metrics;
  }
}
```

#### AlertEnrichmentService.js —— 补充告警详情

```javascript
// AlertEnrichmentService.js
const axios = require('axios');
const https = require('https');

class AlertEnrichmentService {
  constructor(config) {
    this.baseUrl = config.napm.baseUrl;
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: config.napm.requestTimeoutMs,
      httpsAgent: new https.Agent({ rejectUnauthorized: !config.napm.tlsInsecure }),
    });
    this.username = config.napm.username;
    this.password = config.napm.password;
  }

  /**
   * 根据 alertId 获取告警详细信息
   */
  async getAlertDetail(alertId, category) {
    try {
      const response = await this.axios.post('/alertsDetail', {
        username: this.username,
        password: this.password,
        alertIds: [alertId],
        category,
      });
      if (response.data?.data?.alerts?.length > 0) {
        return response.data.data.alerts[0];
      }
      return null;
    } catch (err) {
      console.error(`[AlertEnrichment] 获取告警详情失败 alertId=${alertId}:`, err.message);
      return null;
    }
  }
}
```

#### WeComPushService.js —— 企业微信推送

```javascript
// WeComPushService.js
const axios = require('axios');

class WeComPushService {
  constructor(config) {
    this.webhookUrl = config.wecom.webhookUrl;
    this.mentionedList = config.wecom.mentionedList || [];
    this.mentionedMobileList = config.wecom.mentionedMobileList || [];
  }

  /**
   * 推送告警通知到企业微信群
   */
  async pushAlert(alert) {
    const message = this._buildMarkdownMessage(alert);
    try {
      const response = await axios.post(this.webhookUrl, message, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      if (response.data?.errcode !== 0) {
        console.error(`[WeComPush] 推送失败: ${response.data?.errmsg}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[WeComPush] 推送异常:`, err.message);
      return false;
    }
  }

  /**
   * 构建企业微信 Markdown 消息
   * 企业微信机器人支持 markdown 类型消息
   */
  _buildMarkdownMessage(alert) {
    const severityColor = {
      '紧急': 'warning',
      '重大': 'comment',
      '轻微': 'info',
    };

    const severityLabel = {
      '紧急': '🔴 紧急',
      '重大': '🟠 重大',
      '轻微': '🟡 轻微',
    };

    const severity = alert.severity || alert.alertSeverity || '未知';
    const sevDisplay = severityLabel[severity] || severity;

    let markdown = `## ⚠️ NAPM 告警通知\n`;
    markdown += `> **告警名称**：${alert.alertName || alert.name}\n`;
    markdown += `> **严重级别**：${sevDisplay}\n`;
    markdown += `> **告警类别**：${alert.category || ''}\n`;
    markdown += `> **告警时间**：${alert.timestamp || ''}\n`;
    markdown += `> **来源主机**：${alert.fromHost || alert.sourceHost || ''}\n`;

    if (alert.metrics && alert.metrics.length > 0) {
      markdown += `> **指标**：\n`;
      alert.metrics.forEach((m) => {
        markdown += `> - ${m.name}: ${m.value} ${m.unit}\n`;
      });
    }

    // 如果有 API 补充的详细信息
    if (alert.detail) {
      const d = alert.detail;
      if (d.triggerCondition) {
        markdown += `> **触发条件**：${d.triggerCondition}\n`;
      }
      if (d.description) {
        markdown += `> **描述**：${d.description}\n`;
      }
      if (d.objectName) {
        markdown += `> **监控对象**：${d.objectName}\n`;
      }
    }

    markdown += `\n> 📅 接收时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

    return {
      msgtype: 'markdown',
      markdown: {
        content: markdown,
        mentioned_list: this.mentionedList,
        mentioned_mobile_list: this.mentionedMobileList,
      },
    };
  }

  /**
   * 推送纯文本消息（用于测试/心跳）
   */
  async pushText(text) {
    try {
      await axios.post(this.webhookUrl, {
        msgtype: 'text',
        text: {
          content: text,
          mentioned_list: this.mentionedList,
        },
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
    } catch (err) {
      console.error(`[WeComPush] 文本推送异常:`, err.message);
    }
  }
}
```

#### SyslogWatcherService.js —— 主守护进程

```javascript
// SyslogWatcherService.js
const { spawn } = require('child_process');
const SyslogParserService = require('./SyslogParserService');
const AlertEnrichmentService = require('./AlertEnrichmentService');
const WeComPushService = require('./WeComPushService');

class SyslogWatcherService {
  constructor(config) {
    this.config = config;
    this.parser = new SyslogParserService();
    this.enrichment = new AlertEnrichmentService(config);
    this.wecom = new WeComPushService(config);
    this.seenAlerts = new Map();   // alertId -> firstSeenTimestamp
    this.isRunning = false;
    this.tailProcess = null;
  }

  start() {
    this.isRunning = true;
    console.log('[SyslogWatcher] 启动，监听:', this.config.syslog.path);

    // 使用 tail -F 持续监听（-F 会在文件被 rotate 后重新打开）
    this.tailProcess = spawn('tail', ['-F', '-n', '0', this.config.syslog.path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 逐行读取（处理不完整行）
    let buffer = '';
    this.tailProcess.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整行
      for (const line of lines) {
        if (line.trim()) this._handleLine(line.trim());
      }
    });

    this.tailProcess.stderr.on('data', (data) => {
      console.error('[SyslogWatcher] tail stderr:', data.toString());
    });

    this.tailProcess.on('close', (code) => {
      console.log(`[SyslogWatcher] tail 进程退出，code=${code}`);
      if (this.isRunning) {
        console.log('[SyslogWatcher] 5秒后重连...');
        setTimeout(() => this.start(), 5000);
      }
    });

    // 发送启动通知
    this.wecom.pushText('✅ NAPM Syslog 告警监听已启动').catch(() => {});
  }

  async _handleLine(line) {
    const alert = this.parser.parse(line);
    if (!alert) return; // 非 NAPM 告警行，跳过

    // 去重检查
    const now = Date.now();
    const dedupKey = `${alert.category}_${alert.alertId}`;
    const lastSeen = this.seenAlerts.get(dedupKey);
    if (lastSeen && (now - lastSeen) < this.config.dedup.windowSeconds * 1000) {
      console.log(`[SyslogWatcher] 去重跳过: ${dedupKey}`);
      return;
    }
    this.seenAlerts.set(dedupKey, now);

    // 清理过期缓存
    if (this.seenAlerts.size > this.config.dedup.maxCacheSize) {
      const cutoff = now - this.config.dedup.windowSeconds * 1000 * 2;
      for (const [key, ts] of this.seenAlerts) {
        if (ts < cutoff) this.seenAlerts.delete(key);
      }
    }

    console.log(`[SyslogWatcher] 新告警: ${alert.alertName} (id=${alert.alertId}, severity=${alert.alertSeverity})`);

    // 尝试获取详细告警信息
    let retries = 0;
    while (retries < this.config.watcher.maxRetries) {
      try {
        alert.detail = await this.enrichment.getAlertDetail(alert.alertId, alert.category);
        break;
      } catch (err) {
        retries++;
        if (retries < this.config.watcher.maxRetries) {
          await this._sleep(this.config.watcher.retryDelayMs);
        }
      }
    }

    // 推送到企业微信
    const pushed = await this.wecom.pushAlert(alert);
    if (pushed) {
      console.log(`[SyslogWatcher] 已推送企业微信: ${alert.alertName}`);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop() {
    this.isRunning = false;
    if (this.tailProcess) {
      this.tailProcess.kill('SIGTERM');
      this.tailProcess = null;
    }
    console.log('[SyslogWatcher] 已停止');
  }
}

module.exports = SyslogWatcherService;
```

#### 入口脚本 `run_syslog_watcher.js`

```javascript
#!/usr/bin/env node
// run_syslog_watcher.js

const path = require('path');
const fs = require('fs');
const SyslogWatcherService = require('../services/SyslogWatcherService');

// 加载配置
const configPath = process.argv[2] || path.join(__dirname, '..', 'config', 'watcher.config.json');

if (!fs.existsSync(configPath)) {
  console.error(`配置文件不存在: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// 校验必要配置
if (!config.wecom?.webhookUrl || config.wecom.webhookUrl.includes('YOUR_KEY_HERE')) {
  console.error('请先在 watcher.config.json 中配置正确的企业微信 Webhook URL');
  process.exit(1);
}

const watcher = new SyslogWatcherService(config);

// 优雅退出
process.on('SIGINT', async () => {
  console.log('\n[SyslogWatcher] 收到 SIGINT，正在退出...');
  await watcher.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[SyslogWatcher] 收到 SIGTERM，正在退出...');
  await watcher.stop();
  process.exit(0);
});

watcher.start();
```

### 4.5 systemd 服务安装脚本 `install_syslog_watcher.sh`

```bash
#!/bin/bash
# install_syslog_watcher.sh
# 在接收服务器上以 root 执行

set -e

SERVICE_NAME="napm-syslog-watcher"
INSTALL_DIR="/home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher"
USER="netinside"
GROUP="netinside"

echo "=== 安装 NAPM Syslog Watcher systemd 服务 ==="

# 创建 systemd service 文件
sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<EOF
[Unit]
Description=NAPM Syslog Alert Watcher - 监听 Syslog 并推送企业微信
After=network-online.target rsyslog.service
Wants=network-online.target rsyslog.service
Documentation=https://github.com/your-org/napm-skill

[Service]
Type=simple
User=${USER}
Group=${GROUP}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/scripts/run_syslog_watcher.js ${INSTALL_DIR}/config/watcher.config.json
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/netinside
ReadOnlyPaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}.service
sudo systemctl start ${SERVICE_NAME}.service

echo "=== 服务状态 ==="
sudo systemctl status ${SERVICE_NAME}.service --no-pager -l

echo ""
echo "=== 安装完成 ==="
echo "查看日志: sudo journalctl -u ${SERVICE_NAME} -f"
echo "重启服务: sudo systemctl restart ${SERVICE_NAME}"
echo "停止服务: sudo systemctl stop ${SERVICE_NAME}"
```

## 5. 部署步骤

### 5.1 在远端服务器上部署 Syslog Watcher

```bash
# 1. SSH 到远端服务器
ssh netinside@101.254.114.237

# 2. 创建目录结构
mkdir -p /home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/{scripts,services,config}

# 3. 将本地的 syslog-watcher 代码推送到远端
#    （在本地执行，通过 pscp 或其他方式）
#    pscp -r skills/openclaw-napm-syslog-watcher/* \
#          netinside@101.254.114.237:/home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/

# 4. 在远端编辑配置文件，填入实际企业微信 Webhook Key
vi /home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/config/watcher.config.json

# 5. 确保 Node.js 可用
node --version  # 应 >= 18

# 6. 手动测试（前台运行）
cd /home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher
node scripts/run_syslog_watcher.js config/watcher.config.json

# 如果输出 "[SyslogWatcher] 启动，监听: /var/log/netinside/syslog.log"
# 且企业微信群收到 "✅ NAPM Syslog 告警监听已启动"，则测试通过

# 7. Ctrl+C 停止前台进程，安装为 systemd 服务
sudo bash scripts/install_syslog_watcher.sh
```

### 5.2 验证端到端链路

1. **触发 NAPM 告警** —— 在 NAPM 管理页面手动触发一条测试告警，或降低告警阈值
2. **检查 Syslog 落盘**：
   ```bash
   sudo tail -f /var/log/netinside/syslog.log
   ```
3. **检查 watcher 日志**：
   ```bash
   sudo journalctl -u napm-syslog-watcher -f
   ```
4. **检查企业微信群** —— 应收到格式化的告警卡片消息

### 5.3 日常运维命令

```bash
# 查看服务状态
sudo systemctl status napm-syslog-watcher

# 查看实时日志
sudo journalctl -u napm-syslog-watcher -f

# 重启服务
sudo systemctl restart napm-syslog-watcher

# 停止服务
sudo systemctl stop napm-syslog-watcher

# 查看最近 100 行日志
sudo journalctl -u napm-syslog-watcher -n 100 --no-pager
```

## 6. 进阶方案（可选）

### 6.1 SNMP Trap 也接入推送

参照 Syslog Watcher 模式，新增 `SnmpTrapWatcherService`，监听 `/var/log/netinside/snmptrapd.log`，解析 NAPM SNMP Trap 行（OID 映射），复用 `WeComPushService` 推送。

### 6.2 告警分级推送策略

在配置中增加规则：

```json
{
  "routing": {
    "紧急": {
      "webhookUrl": "https://qyapi.weixin.qq.com/...key=CRITICAL_GROUP_KEY",
      "mentionedMobileList": ["13800138000"]
    },
    "重大": {
      "webhookUrl": "https://qyapi.weixin.qq.com/...key=WARNING_GROUP_KEY"
    },
    "轻微": {
      "webhookUrl": "https://qyapi.weixin.qq.com/...key=INFO_GROUP_KEY"
    }
  }
}
```

不同严重级别的告警推送到不同的企业微信群，紧急告警可 @ 指定人员。

### 6.3 接入 OpenClaw Skill 体系

将 `napm-syslog-watcher` 注册为 OpenClaw 的一个 Skill，通过 OpenClaw 的 `napm-skill-query` 工具触发手动查询 + 推送：

```json
// openclaw.plugin.json 新增
{
  "name": "napm-syslog-watch",
  "description": "手动启动/停止/查看 Syslog 告警监听状态",
  "parameters": {
    "action": "status | start | stop | test"
  }
}
```

### 6.4 使用 rsyslog omprog 模块替代 tail -f

如果不想依赖 `tail -f`，可以直接在 rsyslog 配置中使用 `omprog` 模块，将每条 Syslog 实时喂给 Node.js 脚本：

```
# /etc/rsyslog.d/10-netinside.conf 增强版
module(load="omprog")

ruleset(name="netinside_udp514") {
    action(type="omfile" file="/var/log/netinside/syslog.log" template="NetinsideSyslogRaw")
    action(type="omprog"
           binary="/usr/bin/node /home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/scripts/handle_syslog_line.js"
           template="NetinsideSyslogRaw")
    stop
}
```

优点：无需 tail -f，消息延迟更低。缺点：需要处理 stdin 输入、Node.js 进程生命周期管理、rsyslog 重启时子进程状态。

**建议先用 tail -f 方案验证，稳定后再考虑切换 omprog。**

## 7. 安全注意事项

| 项目 | 建议 |
|---|---|
| Webhook Key | 不要提交到 Git 仓库，使用 `.env` 或远端配置文件管理 |
| NAPM 凭据 | 沿用 `.env` 文件，与 OpenClaw 共用 |
| 网络 | Syslog 接收端口 UDP 514 仅对 NAPM 主机开放 |
| 日志 | 告警日志不要包含 Webhook Key 和密码 |
| systemd 加固 | `ProtectSystem=strict` 限制 watcher 进程的文件系统访问范围 |

## 8. 方案总结

| 组件 | 部署位置 | 用途 |
|---|---|---|
| rsyslog (UDP 514) | 接收服务器 | 接收 NAPM Syslog，落盘 |
| napm-syslog-watcher (systemd) | 接收服务器 | tail syslog → 解析 → 补充详情 → 推送企业微信 |
| 企业微信机器人 | 企业微信群 | 接收 Webhook 消息，展示告警卡片 |

**最小可行部署时间估计**：约 30 分钟（前提：Syslog 接收已配通 + 企业微信机器人 Webhook 已获取）

**依赖关系**：
```
rsyslog 运行 → syslog.log 有数据 → watcher 可工作 → 企业微信收到推送
```
