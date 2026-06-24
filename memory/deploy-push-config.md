---
name: deploy-push-config
description: 远端部署推送配置 — 服务器地址、认证、路径映射与推送方式
metadata:
  type: project
---

## 远端服务器

- **地址**: `101.254.114.237`
- **用户名**: `netinside`
- **密码**: `netinside_123`
- **项目根目录**: `/home/netinside/.openclaw/workspace/`

## 推送方式

使用 `pscp`（PuTTY SCP，路径 `/d/PUTTY/pscp`）逐个文件推送，`-pw` 传入密码。

本地项目根目录 = `g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_skill`

远端目标根目录 = `/home/netinside/.openclaw/workspace/`

两者目录结构一一对应，推送时保持相同的相对路径。

## 推送命令模板

```bash
cd "g:/my_file/项目测试/观枢·智维平台-GAIOP/project_3/NAPM_skill" && pscp -pw netinside_123 "<local-relative-path>" "netinside@101.254.114.237:/home/netinside/.openclaw/workspace/<remote-relative-dir>/"
```

目标路径末尾必须带 `/` 表示目录，否则多文件推送会报 `not a directory` 错误。

## 验证命令

```bash
echo y | plink -ssh -pw netinside_123 netinside@101.254.114.237 "<command>"
```

- `plink` 路径: `/d/PUTTY/plink`
- 使用 `echo y` 绕过 host key 确认

## 服务信息

- OpenClaw Gateway 进程: `openclaw/index.js gateway --port 18789`
- 服务动态加载 skills 和 plugin，推送后一般不需要重启
- systemd 服务 `openclaw.service` 存在但当前通过 PM2/直接 node 进程运行

**Why:** 用户希望将本地修改推送到远端测试服务器时使用统一的推送方式。采用 pscp 而非 git push 是因为远端不具备 git 拉取条件，且推送只需覆盖被修改文件。

**How to apply:** 当用户要求"推送"或"部署"时，先 `git status --short` 确认修改文件，将其中涉及运行时的源文件（非 docs/test）用 pscp 逐个推送到远端对应路径。推送完成后用 plink 验证文件时间戳。
