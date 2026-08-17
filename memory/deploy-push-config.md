---
name: deploy-push-config
description: 远端统一部署配置 — 单 ZIP、备份、路径映射与验证方式
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

## 唯一本地源

本地项目根目录：

`G:\my_file\项目测试\观枢·智维平台-GAIOP\NAPM_skill_unified`

分支：`integration/unified-v1`

`skill_project/NAPM_skill` 和 `project_3/NAPM_skill` 是冻结的历史目录，不再作为部署源。

## 标准发布方式

先从干净、已提交且通过测试的 Git 版本构建：

```powershell
npm run release:build
```

生成物：`dist/NAPM_skill-<version>-<commit>.zip`

只上传这一个 ZIP。认证信息从受控环境获取，不写入仓库、命令模板或文档。

```bash
pscp "dist/NAPM_skill-<version>-<commit>.zip" \
  "netinside@101.254.114.237:/home/netinside/releases/"
```

逐文件 pscp 仅限紧急诊断，不能作为常规版本发布。发生紧急单文件修补后，必须把相同修改提交回统一仓库并重新生成完整发布包。

## 服务器安装

解压后先做隔离验证和预演，再正式安装：

```bash
bash scripts/verify-staged-release.sh
bash scripts/install-release.sh --dry-run
bash scripts/install-release.sh
```

安装脚本负责：

- 备份当前 extension、将更新的 Skills、workspace 依赖和顶层配置
- 同步完整版本，而不是只覆盖本次修改文件
- 保留 `.env`、日志、输出、运行数据和 Syslog watcher 配置
- 安装锁定依赖
- 验证 8 个生产工具入口
- 清理 extension 内不属于候选版本的旧代码副本，同时保留其依赖目录
- 重启并检查 Gateway 和 Syslog watcher 原先处于活动状态的服务
- 任一步骤失败时自动恢复部署前备份

候选版本隔离验证只修改 `/home/netinside/releases/` 下的解压目录，不修改活动 workspace、extension 或服务。当前 R0 回退基线记录在 `memory/2026-08-17.md`；旧 `echarts-ai-skill` 在确认调用关系前不得删除。

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

**Why:** 逐文件推送曾导致远端同时存在不同本地目录、不同提交的混合代码。单 ZIP 让版本号、Git 提交和服务器文件保持同一来源。

**How to apply:** 当用户要求“推送”或“部署”时，先确认 Git 工作区干净、质量门禁通过、ZIP 名称中的版本和提交正确。只上传 ZIP，依次执行隔离验证和 dry-run；获得明确切换批准后才正式安装。安装失败必须使用自动回退结果，不继续手工覆盖。
