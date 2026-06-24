#!/bin/bash
# ============================================================================
# install_syslog_watcher.sh
#   在接收服务器上安装 NAPM Syslog Watcher 为 systemd 服务。
#
# 使用方式（在远端服务器上以 root 或 sudo 权限执行）：
#   sudo bash /home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher/scripts/install_syslog_watcher.sh
#
# 前置条件：
#   1. Node.js >= 18 已安装
#   2. watcher.config.json 中的企业微信 Webhook URL 已配置
#   3. rsyslog 已配置并正常运行（/var/log/netinside/syslog.log 存在）
# ============================================================================

set -e

SERVICE_NAME="napm-syslog-watcher"
INSTALL_DIR="/home/netinside/.openclaw/workspace/skills/openclaw-napm-syslog-watcher"
USER="netinside"
GROUP="netinside"
NODE_BIN="/usr/local/bin/node"
SYSLOG_DIR="/var/log/netinside"

echo "=== NAPM Syslog Watcher systemd 服务安装 ==="
echo ""

# ---- 前置检查 ----
echo "[1/4] 前置检查..."

if [ ! -f "${INSTALL_DIR}/scripts/run_syslog_watcher.js" ]; then
    echo "错误: 找不到入口脚本 ${INSTALL_DIR}/scripts/run_syslog_watcher.js"
    echo "请确认 skill 代码已推送到正确路径。"
    exit 1
fi

if [ ! -f "${INSTALL_DIR}/config/watcher.config.json" ]; then
    echo "错误: 找不到配置文件 ${INSTALL_DIR}/config/watcher.config.json"
    exit 1
fi

if ! grep -q "YOUR_KEY_HERE" "${INSTALL_DIR}/config/watcher.config.json"; then
    echo "  ✓ 企业微信 Webhook URL 已配置"
else
    echo "  ⚠ 警告: 企业微信 Webhook URL 似乎未配置（含 YOUR_KEY_HERE 占位符）"
    echo "  推送功能将不可用，请编辑配置文件后重启服务。"
fi

if [ -x "${NODE_BIN}" ]; then
    NODE_VERSION=$(${NODE_BIN} --version 2>/dev/null || echo "unknown")
    echo "  ✓ Node.js: ${NODE_VERSION}"
else
    echo "错误: 找不到 ${NODE_BIN}"
    exit 1
fi

# 确保 syslog 目录存在（rsyslog 可能尚未创建）
if [ -d "${SYSLOG_DIR}" ]; then
    echo "  ✓ Syslog 目录存在: ${SYSLOG_DIR}"
else
    echo "  ⚠ Syslog 目录不存在，将创建: ${SYSLOG_DIR}"
    sudo install -d -o syslog -g adm -m 0755 "${SYSLOG_DIR}"
fi

echo ""

# ---- 创建 systemd service 文件 ----
echo "[2/4] 创建 systemd service 文件..."

sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<SVC_EOF
[Unit]
Description=NAPM Syslog Alert Watcher - 监听 Syslog 并推送企业微信告警
Documentation=https://github.com/your-org/napm-skill
After=network-online.target rsyslog.service
Wants=network-online.target rsyslog.service

[Service]
Type=simple
User=${USER}
Group=${GROUP}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/scripts/run_syslog_watcher.js ${INSTALL_DIR}/config/watcher.config.json
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10

# 日志输出到 journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${SYSLOG_DIR}
ReadOnlyPaths=${INSTALL_DIR}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
SVC_EOF

echo "  ✓ 服务文件已创建: /etc/systemd/system/${SERVICE_NAME}.service"
echo ""

# ---- 重载 systemd 并启用 ----
echo "[3/4] 启用并启动服务..."

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}.service
sudo systemctl restart ${SERVICE_NAME}.service

echo "  ✓ 服务已启用（开机自启）"
echo ""

# ---- 显示状态 ----
echo "[4/4] 服务状态"
echo "----------------------------------------"
sudo systemctl status ${SERVICE_NAME}.service --no-pager -l || true
echo "----------------------------------------"
echo ""

echo "=== 安装完成 ==="
echo ""
echo "常用命令："
echo "  查看实时日志:  sudo journalctl -u ${SERVICE_NAME} -f"
echo "  查看最近日志:  sudo journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
echo "  重启服务:      sudo systemctl restart ${SERVICE_NAME}"
echo "  停止服务:      sudo systemctl stop ${SERVICE_NAME}"
echo "  查看状态:      sudo systemctl status ${SERVICE_NAME}"
echo ""
echo "配置文件: ${INSTALL_DIR}/config/watcher.config.json"
echo "修改配置后请执行: sudo systemctl restart ${SERVICE_NAME}"
