---
name: deploy-push-config
description: 远端部署推送配置 — 服务器地址、认证、路径映射与推送方式
metadata:
  type: project
---

## 远端服务器

- **地址**: `101.254.114.237`
- **用户名**: `netinside`
- **认证**: 使用当前受控凭据，不在仓库中保存口令
- **项目根目录**: `/home/netinside/.openclaw/workspace/`
- **Plugin 实际加载目录**: `/home/netinside/.openclaw/extensions/napm-openclaw-plugin/`
  - `index.mjs` 是 ESM wrapper，先尝试 `require('./index.js')`，失败后回退到 `require('./napm-openclaw-plugin.remote.js')`
  - **推送 Plugin 必须同时覆盖 extensions 目录**，仅推送到 workspace 无效（gateway 不从 workspace 加载 Plugin）
  - `openclaw.plugin.json` 在 extensions 目录中，contracts.tools 需要在 extensions 目录中的文件更新

## 推送方式

使用 `pscp`（PuTTY SCP，路径 `/d/PUTTY/pscp`）逐个文件推送，认证信息从受控环境获取，不写入命令模板或文档。

本地项目根目录 = `g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_skill`

远端目标根目录 = `/home/netinside/.openclaw/workspace/`

两者目录结构一一对应，推送时保持相同的相对路径。

## 推送命令模板

```bash
# Skill 脚本 → workspace/skills/
cd "<project>" && pscp "<local-relative-path>" "netinside@101.254.114.237:/home/netinside/.openclaw/workspace/<remote-relative-dir>/"

# Plugin + manifest + timeResolver → extensions 目录 (Gateway 实际加载位置)
cd "<project>" && pscp "napm-openclaw-plugin.remote.js" "netinside@101.254.114.237:/home/netinside/.openclaw/extensions/napm-openclaw-plugin/"
cd "<project>" && pscp "openclaw.plugin.json" "netinside@101.254.114.237:/home/netinside/.openclaw/extensions/napm-openclaw-plugin/"
cd "<project>" && pscp "skills/openclaw-napm-query/src/shared/timeResolver.js" "netinside@101.254.114.237:/home/netinside/.openclaw/extensions/napm-openclaw-plugin/skills/openclaw-napm-query/src/shared/"
```

目标路径末尾必须带 `/` 表示目录，否则多文件推送会报 `not a directory` 错误。

## 验证命令

```bash
plink -ssh netinside@101.254.114.237 "<command>"
```

- `plink` 路径: `/d/PUTTY/plink`
- 首次连接应人工核对并接受 host key，不使用自动确认绕过校验

## 服务信息

- OpenClaw Gateway 进程: `openclaw/index.js gateway --port 18789`
- Gateway 由用户级 systemd 服务 `openclaw-gateway.service` 管理
- extension 插件、共享运行时或查询执行链变更后，使用 `systemctl --user restart openclaw-gateway.service` 受控重启
- 重启后检查服务状态、18789 端口、插件加载和企业微信认证，再执行生产 Skill 验收

**Why:** 用户希望将本地修改推送到远端测试服务器时使用统一的推送方式。采用 pscp 而非 git push 是因为远端不具备 git 拉取条件，且推送只需覆盖被修改文件。

**How to apply:** 当用户要求"推送"或"部署"时，先 `git status --short` 确认修改文件，将其中涉及运行时的源文件（非 docs/test）用 pscp 逐个推送到远端对应路径。推送完成后用 plink 验证文件时间戳。
