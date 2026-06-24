# OpenClaw / Ubuntu 接收 NAPM Syslog 与 SNMP Trap 配置手册

本文档只保留本次验证中已经跑通的正确步骤，用于后续在 OpenClaw 服务器或新的 Ubuntu 服务器上复现 NAPM 告警接收链路。

## 1. 目标

让 OpenClaw/Ubuntu 服务器接收 NAPM 发出的两类告警：

- Syslog：NAPM -> 接收机 UDP `514`
- SNMP Trap：NAPM -> 接收机 UDP `162`

本次测试中还发现 NAPM 页面可能配置或实际使用非标准 Trap 端口，例如 UDP `1162`、UDP `10162`。因此本文也包含将非标准端口转发到本机 UDP `162` 的方法。

## 2. 软件包与来源

在 Ubuntu 22.04 LTS 上使用系统官方 apt 软件源安装：

| 用途 | 包名 | 官方链接 |
|---|---|---|
| Syslog 接收服务 | `rsyslog` | https://packages.ubuntu.com/jammy/rsyslog |
| SNMP Trap 接收服务 | `snmptrapd` | https://packages.ubuntu.com/jammy/snmptrapd |
| SNMP 测试工具，如 `snmptrap` | `snmp` | https://packages.ubuntu.com/jammy/snmp |
| 抓包验证 | `tcpdump` | https://packages.ubuntu.com/jammy/tcpdump |

相关官方文档：

- rsyslog UDP 输入模块 `imudp`：https://docs.rsyslog.com/doc/configuration/modules/imudp.html
- Ubuntu `snmptrapd.conf` 手册：https://manpages.ubuntu.com/manpages/jammy/man5/snmptrapd.conf.5.html
- Ubuntu `snmptrapd` 手册：https://manpages.ubuntu.com/manpages/jammy/man8/snmptrapd.8.html
- Ubuntu `tcpdump` 手册：https://manpages.ubuntu.com/manpages/jammy/man8/tcpdump.8.html

安装命令：

```bash
sudo apt update
sudo apt install -y rsyslog snmp snmptrapd tcpdump
```

如果 `apt update` 报 DNS 解析失败，先检查：

```bash
resolvectl status
ping -c 3 8.8.8.8
ping -c 3 archive.ubuntu.com
```

需要先修好 DNS、代理或公司内网软件源，再继续安装。

## 3. 变量约定

以下命令请按实际环境替换：

```bash
NAPM_IP="101.254.114.238"
RECEIVER_IP="101.254.114.236"
IFACE="ens160"
TRAP_COMMUNITY="netinside_trap"
```

在 OpenClaw 服务器上，`RECEIVER_IP` 和 `IFACE` 应改成 OpenClaw 服务器自己的 IP 和网卡名。

查看网卡名：

```bash
ip -br addr
ip route
```

## 4. 防火墙放行

建议只允许 NAPM 主机访问接收端口。

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw allow from 101.254.114.238 to any port 514 proto udp comment "NAPM Syslog UDP 514"
sudo ufw allow from 101.254.114.238 to any port 162 proto udp comment "NAPM SNMP Trap UDP 162"

# 如果 NAPM 页面使用了非标准 Trap 端口，再放行这些端口。
sudo ufw allow from 101.254.114.238 to any port 1162 proto udp comment "NAPM SNMP Trap alternate UDP 1162"
sudo ufw allow from 101.254.114.238 to any port 10162 proto udp comment "NAPM SNMP Trap alternate UDP 10162"

sudo ufw enable
sudo ufw status numbered
```

如果需要 SSH 管理，不建议对公网开放 TCP `22`。应只允许办公出口 IP：

```bash
sudo ufw allow from <办公机或堡垒机IP> to any port 22 proto tcp comment "admin SSH"
```

## 5. 配置 Syslog 接收

创建日志目录：

```bash
sudo install -d -o syslog -g adm -m 0755 /var/log/netinside
sudo touch /var/log/netinside/syslog.log
sudo chown syslog:adm /var/log/netinside/syslog.log
sudo chmod 0640 /var/log/netinside/syslog.log
```

创建 rsyslog 配置：

```bash
sudo tee /etc/rsyslog.d/10-netinside.conf >/dev/null <<'EOF'
# Temporary NAPM Syslog receiving configuration.
# NAPM sends Syslog alarms to UDP/514.
# Capture all UDP/514 messages into a dedicated file so facility/severity
# mismatches do not hide test alarms during discovery.
module(load="imudp")

template(name="NetinsideSyslogRaw" type="string"
         string="%timegenerated:::date-rfc3339% from=%fromhost-ip% host=%HOSTNAME% facility=%syslogfacility-text% severity=%syslogseverity-text% tag=%syslogtag%%msg%\n")

ruleset(name="netinside_udp514") {
    action(type="omfile" file="/var/log/netinside/syslog.log" template="NetinsideSyslogRaw")
    stop
}

input(type="imudp" port="514" ruleset="netinside_udp514")
EOF
```

重启并启用：

```bash
sudo systemctl restart rsyslog
sudo systemctl enable rsyslog
sudo ss -lunp | grep ':514'
```

查看日志：

```bash
sudo tail -f /var/log/netinside/syslog.log
```

## 6. 配置 SNMP Trap 接收

创建日志目录和日志文件。注意 `snmptrapd` 在 Ubuntu 上通常以 `Debian-snmp` 用户运行，所以日志文件必须允许该用户写入。

```bash
sudo install -d -o Debian-snmp -g adm -m 0775 /var/log/netinside
sudo touch /var/log/netinside/snmptrapd.log
sudo chown Debian-snmp:adm /var/log/netinside/snmptrapd.log
sudo chmod 0664 /var/log/netinside/snmptrapd.log
```

创建 Trap 记录脚本：

```bash
sudo tee /usr/local/sbin/netinside-trap-logger.sh >/dev/null <<'EOF'
#!/bin/sh
{
  printf "\n===== %s =====\n" "$(date -Is)"
  cat
} >> /var/log/netinside/snmptrapd.log
EOF

sudo chmod 0755 /usr/local/sbin/netinside-trap-logger.sh
```

配置 `snmptrapd`：

```bash
sudo tee /etc/snmp/snmptrapd.conf >/dev/null <<'EOF'
# NAPM SNMP Trap receiving configuration.
# During initial integration, disableAuthorization helps capture packets even
# if the sender uses SNMPv1/v2c community variants.
disableAuthorization yes

authCommunity log,execute,net public
authCommunity log,execute,net netinside_trap

# Write every received trap to a dedicated file for migration evidence.
traphandle default /usr/local/sbin/netinside-trap-logger.sh
EOF
```

启动服务：

```bash
sudo systemctl enable --now snmptrapd
sudo systemctl enable --now snmptrapd.socket
sudo systemctl restart snmptrapd
sudo ss -lunp | grep ':162'
```

本机自测：

```bash
snmptrap -v 2c -c netinside_trap 127.0.0.1 '' 1.3.6.1.6.3.1.1.5.1
sudo tail -n 30 /var/log/netinside/snmptrapd.log
```

如果能看到类似下面内容，说明 `snmptrapd` 和日志脚本正常：

```text
UDP: [127.0.0.1]:xxxxx->[127.0.0.1]:162
iso.3.6.1.6.3.1.1.4.1.0 iso.3.6.1.6.3.1.1.5.1
```

## 7. 非标准 SNMP Trap 端口转发

标准 SNMP Trap 端口是 UDP `162`。如果 NAPM 页面配置了 UDP `1162` 或 UDP `10162`，有两种做法：

- 推荐做法：让 NAPM 直接发到接收机 UDP `162`。
- 兼容做法：接收机放行并把 UDP `1162` / `10162` 转发到本机 UDP `162`。

本次测试中，NAPM 实际发送心跳到 UDP `10162`。接收机使用 NAT REDIRECT 转到本机 `162` 后，`snmptrapd` 成功记录 Trap。

临时生效命令：

```bash
sudo iptables -t nat -C PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 1162 -j REDIRECT --to-ports 162 2>/dev/null || \
sudo iptables -t nat -A PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 1162 -j REDIRECT --to-ports 162

sudo iptables -t nat -C PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 10162 -j REDIRECT --to-ports 162 2>/dev/null || \
sudo iptables -t nat -A PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 10162 -j REDIRECT --to-ports 162
```

查看命中计数：

```bash
sudo iptables -t nat -vnL PREROUTING --line-numbers | grep -E '1162|10162'
```

如需重启后保持，创建 systemd 服务：

```bash
sudo tee /etc/systemd/system/napm-snmptrap-redirect.service >/dev/null <<'EOF'
[Unit]
Description=Redirect NAPM alternate SNMP Trap ports to local UDP 162
After=network-online.target ufw.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -t nat -C PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 1162 -j REDIRECT --to-ports 162 2>/dev/null || /usr/sbin/iptables -t nat -A PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 1162 -j REDIRECT --to-ports 162'
ExecStart=/bin/sh -c '/usr/sbin/iptables -t nat -C PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 10162 -j REDIRECT --to-ports 162 2>/dev/null || /usr/sbin/iptables -t nat -A PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 10162 -j REDIRECT --to-ports 162'
ExecStop=/bin/sh -c '/usr/sbin/iptables -t nat -D PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 1162 -j REDIRECT --to-ports 162 2>/dev/null || true'
ExecStop=/bin/sh -c '/usr/sbin/iptables -t nat -D PREROUTING -i ens160 -p udp -s 101.254.114.238 --dport 10162 -j REDIRECT --to-ports 162 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now napm-snmptrap-redirect.service
sudo systemctl status napm-snmptrap-redirect.service --no-pager
```

在 OpenClaw 服务器上要把 `ens160`、`101.254.114.238` 替换成实际网卡和 NAPM IP。

## 8. NAPM 页面配置建议

Syslog：

- 主机名 / Syslog 目标：OpenClaw/Ubuntu 接收机 IP
- 设备 / Facility：`local0`
- 最小安全级别：测试阶段建议 `Normal`

SNMP Trap：

- SNMP 警告设置：打开
- SNMP 版本：优先按 NAPM 页面支持选择，老版本可用 `1`，也可测试 `2c`
- 主机：OpenClaw/Ubuntu 接收机 IP
- 端口：优先 `162`；如页面或环境需要，可用 `1162` / `10162` 并在接收端转发
- 团体字：`netinside_trap`
- 心跳告警：测试阶段建议打开，间隔 `100` 秒，便于证明链路通

单条告警规则：

- 状态：激活
- 动作：勾选 `SNMP` 和 `SysLog`
- 测试阶段：使用容易触发的阈值
- 测试阶段：建议触发“新告警 / 恢复 / 状态变化”，不要只依赖持续重复发送

## 9. 验证命令

确认监听：

```bash
sudo ss -lunp | grep -E ':(514|162)'
```

抓 Syslog：

```bash
sudo tcpdump -ni ens160 host 101.254.114.238 and udp port 514 -A
```

抓 SNMP Trap 标准端口：

```bash
sudo tcpdump -ni ens160 host 101.254.114.238 and udp port 162 -vv -A
```

抓 SNMP Trap 标准端口和非标准端口：

```bash
sudo tcpdump -ni ens160 host 101.254.114.238 and udp and '(port 162 or port 1162 or port 10162)' -vv -A
```

查看 Syslog 落盘：

```bash
sudo tail -f /var/log/netinside/syslog.log
```

查看 Trap 落盘：

```bash
sudo tail -f /var/log/netinside/snmptrapd.log
```

查看 `snmptrapd` 服务日志：

```bash
sudo journalctl -u snmptrapd -f
```

## 10. 本次跑通样例

Syslog 业务告警样例：

```text
from=101.254.114.238 host=101.254.114.238 facility=local0 severity=notice tag=紧急:
userAlerts severity=紧急 name=SNMP测试 alertid=113 ...
metric1=流量（流入和流出） value1=... units1=兆字节
```

SNMP 心跳 Trap 样例：

```text
UDP: [101.254.114.238]:34050->[101.254.114.236]:162
iso.3.6.1.6.3.1.1.4.1.0 iso.3.6.1.4.1.7119.2.1.491.0.6
iso.3.6.1.4.1.7119.2.491.10.3 "NORMAL"
iso.3.6.1.4.1.7119.2.491.10.67 "HEARTBEAT"
iso.3.6.1.4.1.11.2.17.2.5.0 "4"
iso.3.6.1.4.1.7119.2.491.10.14 0
```

SNMP Agent 重启 / coldStart Trap 样例：

```text
iso.3.6.1.6.3.1.1.4.1.0 iso.3.6.1.6.3.1.1.5.1
iso.3.6.1.6.3.1.1.4.3.0 iso.3.6.1.4.1.8072.3.2.8
```

说明：

- `1.3.6.1.4.1.7119` 是 NetInside / NAPM 相关企业 OID。
- `HEARTBEAT` 证明 NAPM 到接收机的 SNMP Trap 链路通。
- `1.3.6.1.6.3.1.1.5.1` 是标准 SNMP `coldStart`。
- `1.3.6.1.4.1.8072` 是 Net-SNMP 相关 OID。

## 11. 故障分层判断

| 现象 | 说明 | 下一步 |
|---|---|---|
| `ss` 看不到 UDP `514` | rsyslog 未监听 | 检查 `/etc/rsyslog.d/10-netinside.conf` 并重启 rsyslog |
| `ss` 看不到 UDP `162` | snmptrapd 未监听 | 检查 `snmptrapd` 服务和 socket |
| tcpdump 看不到 UDP `514` | NAPM 没发 Syslog 或网络未到达 | 查 NAPM Syslog 目标、路由、防火墙 |
| tcpdump 看到 UDP `514`，日志文件无内容 | rsyslog 规则或权限问题 | 查 rsyslog 配置和 `/var/log/netinside/syslog.log` 权限 |
| tcpdump 看不到 UDP `162/1162/10162` | NAPM 没发 Trap 或目标端口不对 | 查 NAPM Trap 目标地址/端口/开关 |
| tcpdump 看到 Trap，日志文件无内容 | snmptrapd 配置或脚本权限问题 | 查 `/etc/snmp/snmptrapd.conf`、`journalctl -u snmptrapd`、日志文件权限 |
| 能收到 HEARTBEAT，但收不到业务 Trap | SNMP 链路通，业务告警触发/规则/产品逻辑待查 | 查单条告警是否勾选 SNMP、是否产生新事件/恢复事件 |
| 只显示数字 OID | MIB 未导入 | 导入 NetInside MIB，或在上层平台做 OID 映射 |

## 12. OpenClaw 接入建议

OpenClaw 侧建议先按以下顺序接入：

1. 先接 Syslog UDP `514`，因为本次测试已确认 NAPM 业务告警 Syslog 稳定到达。
2. 再接 SNMP Trap UDP `162`。
3. 如果 NAPM 必须使用 UDP `1162` 或 `10162`，在 OpenClaw 所在服务器上做端口转发到 UDP `162`，或让 OpenClaw/Trap 接收组件直接监听这些端口。
4. 导入 NetInside MIB 或按 OID 手工映射字段。
5. 用 NAPM 心跳 Trap 验证链路，用业务告警新建/恢复事件验证业务 Trap。

