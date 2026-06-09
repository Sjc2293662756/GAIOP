# OpenClaw 会话与 Skill 扫描复盘及管理建议

日期：2026-06-08

## 背景

本轮排查围绕 NAPM packet skill 的调用漂移展开：

- 用户询问“构造 101.254.114.238 最近一小时的数据包下载链接，不要下载”。
- 期望链路：OpenClaw 识别为数据包任务，调用 `napm-packet-analysis`，由 `openclaw-napm-packet-analysis` skill 构造链接。
- 实际一度出现：模型没有调用 packet tool，而是直接手写 `packetsPreview/packetsDown` URL，并复用了旧结论“GAIOP 没有数据包下载权限”。

最终确认：这不是 NetInside 权限判断结果，而是 OpenClaw 会话上下文、skill 扫描路径、工具注册可见性共同导致的回答漂移。

## 关键结论

### 1. `openclaw skills list` 与运行时 skill 路径要区分

OpenClaw 当前能识别的 workspace skill 来源包括：

- `~/.openclaw/skills`
- OpenClaw agent workspace 下的 skills
- `~/.openclaw/plugin-skills`
- 内置 bundled skills

本项目原先将 NAPM skills 放在：

```text
/home/netinside/.openclaw/workspace/skills
```

并通过 systemd 环境变量指定执行器路径：

```text
OPENCLAW_SKILLS_ROOT=/home/netinside/.openclaw/workspace/skills
NAPM_PACKET_EXECUTOR=/home/netinside/.openclaw/workspace/skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js
```

这保证插件执行器可以找到脚本，但不一定保证 `openclaw skills list` 或 OpenClaw prompt skill 扫描能看到该 skill。

### 2. 不能用逃逸到 workspace 的软链接

曾尝试：

```text
/home/netinside/.openclaw/skills/openclaw-napm-packet-analysis
  -> /home/netinside/.openclaw/workspace/skills/openclaw-napm-packet-analysis
```

OpenClaw 日志拒绝该路径：

```text
Skipping escaped skill path outside its configured root
reason=symlink-escape
```

因此，若要让 `openclaw skills list` 和模型技能扫描稳定看到 NAPM skill，需要在 `~/.openclaw/skills` 下放真实目录，而不是指向 workspace 的软链接。

### 3. 当前正确状态

当前已经将 packet skill 复制为真实目录：

```text
/home/netinside/.openclaw/skills/openclaw-napm-packet-analysis
```

并保留 workspace 侧执行器目录：

```text
/home/netinside/.openclaw/workspace/skills/openclaw-napm-packet-analysis
```

验证命令：

```bash
/home/netinside/.npm-global/bin/openclaw skills list | grep openclaw-napm
```

当前可见结果应包含：

```text
openclaw-napm-packet-analysis  ready  openclaw-workspace
openclaw-napm-query            ready  openclaw-workspace
```

### 4. 为什么会继续说“无权限”

16:34 那轮日志显示：

- 没有 `napm_packet_analysis_invoked`
- 没有 `napm_packet_analysis_completed`
- 模型 `stopReason=stop`
- 最终文本由模型直接生成，不是工具结果

因此“GAIOP 没有权限”不是本轮真实查询结论，而是旧会话上下文里错误判断被复用。

已补充保护：

- packet prompt 没有拿到 `napm-packet-analysis` 结果时，不允许模型手写 `packetsPreview/packetsDown` 链接。
- packet prompt 没有工具结果时，不允许判断账号权限。
- 链接构造结果必须来自 packet skill。

## 会话管理建议

### 0. 一个会话的生命周期是多久

当前 OpenClaw 配置里没有固定的“会话 TTL”或“多少小时自动销毁”规则。

当前配置：

```json
{
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

这意味着企业微信私聊会话会按“渠道 + 用户”生成稳定 session key，例如：

```text
agent:main:wecom:direct:shijc
```

只要同一个用户继续在同一个企业微信私聊里发消息，OpenClaw 就会复用同一个 session。这个 session 会持续存在，直到发生以下情况之一：

- 用户显式执行 `/new` 或 `/reset` 这类新会话/重置动作。
- 管理员执行 session cleanup，并且配置允许清理旧会话。
- session store 或 transcript 文件被人工归档、删除或迁移。
- agent 配置变化导致旧 session key 不再匹配。

所以在当前部署下，一个会话不是“15 分钟/24 小时后自动失效”，而是“按会话 key 长期持久化”。

需要区分两个概念：

```text
存储生命周期：session 文件和 sessions.json 记录可以保存很多天甚至更久。
上下文生命周期：模型每轮能读入的上下文受 token 窗口限制，当前列表里显示约 131k tokens。
```

当会话越来越长时，OpenClaw 会通过上下文窗口、compaction/checkpoint 等机制控制模型实际看到的内容，但 session 本身仍然存在。因此，一个老会话即使没有被删除，也不代表模型每轮都能完整看到全部历史；但旧摘要、旧结论和近期上下文仍可能影响回答。

查看当前会话：

```bash
/home/netinside/.npm-global/bin/openclaw sessions
```

预览清理动作：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --dry-run
```

真正执行清理：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --enforce
```

如果只是要做一次干净验收，优先使用 `/new` 或 `/reset` 开新 session，而不是直接删除历史文件。

### 1. 什么时候保留当前会话

适合保留当前会话的情况：

- 正在连续排查同一个部署问题。
- 需要利用刚才的日志、路径、命令结果。
- 用户还在追问“刚才为什么这样”“这次链路是什么”。

当前会话包含大量有价值的排查上下文，但也包含旧错误结论，因此只能用于复盘，不适合继续作为业务测试会话。

### 2. 什么时候新开会话

以下情况建议新开会话：

- 部署完成后做业务功能验收。
- 测试 packet/query/report 三类 skill 的真实效果。
- 验证模型是否会按新 skill 契约调用工具。
- 旧会话已经出现过多错误链路、旧结论、手动 curl/python/权限误判。

本轮修复后，建议新开一个企业微信会话或清空当前对话上下文后测试。

推荐测试语句：

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
```

期望结果：

```text
预览 URL 已生成：https://101.254.114.238/webservice/NetInside?UserName=GAIOP&Password=***&type=packetsPreview...
下载 URL 已生成：https://101.254.114.238/webservice/NetInside?UserName=GAIOP&Password=***&type=packetsDown...
```

不应再出现：

```text
GAIOP 账号没有数据包下载权限
```

除非本轮确实调用了 `preview_only` 或下载接口，并从接口返回了 403。

### 3. 什么时候清理旧会话

从 `openclaw sessions` 看，当前有多个长期会话：

```text
direct agent:main:wecom...shijc  15m ago  85k/131k
direct agent:main:wecom...com.cn 2h ago   20k/131k
direct agent:main:wecom...yangs  13d ago  20k/131k
...
```

建议规则：

- 保留最近 1-2 个正在排查的会话。
- 对超过 7 天且不再需要复盘的会话，归档或清理。
- 对 token 占用超过 60% 且包含错误推理的会话，不再用于功能验收。
- 对生产验收，新开干净会话，避免旧结论污染。

### 4. 会话清理前要做什么

清理前先保存复盘材料：

- 关键日志时间点
- 修改文件
- 部署路径
- 验证命令
- 错误根因
- 当前正确链路

本文件即为本次会话复盘依据。

### 5. 建议的会话分层

后续建议按用途区分会话：

```text
会话 A：部署/排查会话
用途：看日志、改代码、部署、解释为什么错

会话 B：业务验收会话
用途：只问真实业务问题，观察 OpenClaw 是否调用正确 skill

会话 C：复盘/设计会话
用途：讨论架构、拆 skill、落文档
```

不要在同一个长会话里同时做“错误排查”和“生产验收”，否则模型很容易复用旧错误判断。

## 生产环境会话生命周期设计

### 1. 设计目标

生产环境不是简单地“会话越长越好”，也不是“每次都新开会话”。合理的目标是：

- 对用户来说：短时间连续追问要能承接上下文。
- 对系统来说：不能让几天前的错误结论继续影响今天的回答。
- 对运维来说：历史记录要可审计、可复盘、可定位问题。
- 对模型来说：上下文窗口要干净，避免长期会话膨胀到 60%-80% token 后仍继续复用。

因此，推荐将会话拆成三层生命周期：

```text
交互上下文生命周期：模型是否继续复用旧对话。
会话记录生命周期：sessions.json 和 transcript 文件保留多久。
审计归档生命周期：关键日志、轨迹、错误链路保留多久。
```

这三层不要混在一起。模型上下文可以短，审计记录可以长。

### 2. 推荐生命周期

建议生产环境按渠道和用途设置不同策略：

```text
普通用户私聊：
  交互上下文：24 小时无活动后建议新开。
  会话记录：30 天。
  审计归档：60-90 天。

运维排查私聊：
  交互上下文：单个问题排查期间保留；问题关闭后新开。
  会话记录：30-90 天。
  审计归档：90 天以上，视合规要求决定。

群聊：
  交互上下文：6-24 小时，或按明确主题新开。
  会话记录：30 天。
  审计归档：60-90 天。

生产验收：
  交互上下文：每轮验收前新开或 reset。
  会话记录：保留。
  审计归档：保留验收日志、输入、输出、工具调用记录。
```

对于 NAPM 这类强依赖实时数据和工具调用的系统，建议偏短上下文、长审计。

### 3. 当前 OpenClaw 默认行为

OpenClaw 当前源码默认的 session store maintenance 规则为：

```text
pruneAfter: 30 天
maxEntries: 500
mode: enforce
```

这来自 OpenClaw 的默认 session maintenance 逻辑：

```text
DEFAULT_SESSION_PRUNE_AFTER_MS = 720 小时 = 30 天
DEFAULT_SESSION_MAX_ENTRIES = 500
DEFAULT_SESSION_MAINTENANCE_MODE = enforce
```

注意：这是“存储维护”默认值，不是“模型上下文复用 TTL”。

也就是说，旧 session 文件可能 30 天后被 maintenance 清理，但在清理前，同一个企业微信私聊仍可能一直复用同一个 session key。

### 4. 为什么不能只依赖默认 30 天清理

默认 30 天适合清理磁盘和 session store，不适合作为生产问答上下文 TTL。

原因：

- 30 天内用户可能问过很多不相关问题。
- 旧错误判断可能被压缩进摘要或保留在近期上下文里。
- 运维排查过程里常出现“尝试、失败、误判、修正”，这些不应该污染后续业务验收。
- 数据查询类问题具有实时性，不能依赖旧答案。
- NAPM 工具链已经要求“当前轮必须有 fresh tool result”，长会话会增加模型绕过工具的概率。

因此，生产设计应当是：

```text
session store 可 30 天保留；
模型交互上下文建议 24 小时或按任务 reset；
验收/测试必须新开干净会话。
```

### 5. 会话分类设计

建议给会话分为四类：

```text
业务问答会话
  用户问系统状态、业务列表、应用列表、指标排行等。
  要求每轮数据问题必须调用对应 skill。
  不允许从旧上下文直接回答实时数据。

排查会话
  工程师查日志、改代码、部署、解释链路。
  可以保留长上下文。
  不应用于生产验收。

验收会话
  用于验证某个功能是否真正修好。
  每次验收前新开或 reset。
  只问业务问题，不夹杂排查过程。

复盘会话
  用于总结问题、落文档、抽象规范。
  可以引用历史，但不作为功能正确性依据。
```

本次长会话属于“排查 + 复盘会话”，不应该继续承担“验收会话”的角色。

### 6. NAPM 场景下的特殊规则

NAPM 查询有几个特殊风险：

- 数据实时变化。
- resolvedQuery 构造必须准确。
- skill/tool 调用路径必须可审计。
- 旧答案经常包含错误链路，例如 curl、python、本地脚本、旧 gateway、无权限误判。

因此 NAPM 场景建议强制执行：

```text
数据查询：必须有当前轮 skill/tool 结果。
元数据清单：必须走 query skill 或对应 packet/report skill。
数据包链接：必须走 napm-packet-analysis。
报告导出：必须走 napm-report-export。
回答中不得根据旧会话推断接口权限。
```

如果没有当前轮工具结果，宁可拒答或提示“需要执行 skill”，也不要手写结果。

### 7. 推荐配置策略

建议保留 OpenClaw 默认 30 天 session store 清理，同时补充运行规范。

推荐 `openclaw.json` 中显式写出 session maintenance，避免默认值不可见：

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "maintenance": {
      "mode": "enforce",
      "pruneAfter": "30d",
      "maxEntries": 500,
      "resetArchiveRetention": "30d"
    }
  }
}
```

如果后续用户量增加，可以加入磁盘预算：

```json
{
  "session": {
    "maintenance": {
      "mode": "enforce",
      "pruneAfter": "30d",
      "maxEntries": 500,
      "maxDiskBytes": "2gb",
      "highWaterBytes": "1600mb"
    }
  }
}
```

如果系统暂时不希望自动删历史，可以先设为 warn：

```json
{
  "session": {
    "maintenance": {
      "mode": "warn",
      "pruneAfter": "30d",
      "maxEntries": 500
    }
  }
}
```

但 warn 只报警不清理，长期会导致 session store 变大。

### 8. 操作规范

日常查看：

```bash
/home/netinside/.npm-global/bin/openclaw sessions
```

只看最近活跃：

```bash
/home/netinside/.npm-global/bin/openclaw sessions --active 120
```

查看全部 agent：

```bash
/home/netinside/.npm-global/bin/openclaw sessions --all-agents
```

清理前预览：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --dry-run
```

包括缺失 transcript 的记录：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --dry-run --fix-missing
```

执行清理：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --enforce
```

多 agent 清理：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --all-agents --enforce
```

### 9. 验收前操作规范

生产验收前建议执行：

```text
1. 新开企业微信会话，或在当前会话执行 /new 或 /reset。
2. 不要先问“之前怎么查的”“为什么错了”。
3. 直接问业务测试问题。
4. 同步观察 OpenClaw 日志和 audit 事件。
5. 只以当前轮 tool/skill 结果判断功能是否通过。
```

例如 packet skill 验收：

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
```

同时看日志：

```bash
journalctl --user -u openclaw-gateway.service -f
```

期望出现：

```text
napm_packet_analysis_invoked
napm_packet_analysis_completed
```

如果没有出现，不看最终自然语言回答，直接判定链路未走通。

### 10. 长会话污染识别标准

如果会话中出现以下内容，建议不要继续用于验收：

- 曾经输出过错误 API。
- 曾经说过“直接 curl”“python 过滤”“绕过 skill”。
- 曾经把 packet 查询误判为 NAPM 指标查询。
- 曾经把权限问题误判为账号无权限。
- token 使用超过 60%。
- 多轮修复、反驳、解释混在一起。
- 用户频繁追问“你怎么查的”“为什么这么回答”。

这类会话仍然可用于复盘，但不应用于判断功能是否已经修好。

### 11. 是否要自动新开会话

如果 OpenClaw 后续支持按 idle 时间自动切换 session，建议策略如下：

```text
普通私聊 idle 24h -> 新 session。
群聊 idle 6h 或主题变化 -> 新 session。
验收关键词出现，例如“测试一下”“验收”“重新测” -> 建议新 session 或强制忽略旧上下文。
排查关键词出现，例如“排查日志”“为什么错” -> 继续当前排查会话。
```

如果 OpenClaw 暂时没有该能力，可以由运营规范替代：

```text
测试前先 /new。
生产验收只在新会话中进行。
排查和复盘使用旧会话。
```

### 12. 推荐落地节奏

第一阶段：规范化，不改配置。

- 明确测试前使用 `/new` 或 `/reset`。
- 保留当前 session maintenance 默认 30 天。
- 排查会话和验收会话分开。

第二阶段：显式配置 maintenance。

- 在 `openclaw.json` 中显式配置 `session.maintenance`。
- 每周执行一次 `sessions cleanup --dry-run`。
- 确认无误后执行 `--enforce`。

第三阶段：自动化巡检。

- 定期导出 `openclaw sessions --json`。
- 标记超过 60% token 的长会话。
- 标记 7 天以上未活跃会话。
- 标记包含错误链路关键词的会话。

第四阶段：接入业务守门。

- NAPM 数据问题没有当前轮 tool result 时禁止回答。
- packet 问题没有 `napm-packet-analysis` 结果时禁止手写 URL。
- report 问题没有 `napm-report-export` 结果时禁止声称已生成。

### 13. 推荐管理制度

建议形成以下制度：

```text
生产用户：
  默认连续上下文 24 小时内有效。
  超过 24 小时的问题按新问题处理。

运维人员：
  排查会话可长期保留，但不能用于验收。
  每次修复后必须新开验收会话。

审计：
  所有 session transcript 保留 30 天。
  关键故障复盘文档长期保留。

清理：
  每周 dry-run。
  每月 enforce。
  重大版本上线前手动清理过长会话。
```

### 14. 本项目当前建议

结合本项目现状，建议立即采用：

```text
不马上强制删除已有 session。
保留本轮长会话作为复盘材料。
后续 NAPM 功能验收全部使用新会话。
显式配置 session.maintenance，采用 30d + 500 entries。
每周查看 sessions，重点关注 shijc 这个长会话的 token 占用。
```

对于当前截图里的会话：

```text
agent:main:wecom:direct:shijc  85k/131k
```

建议：

- 保留用于复盘。
- 不再用于 packet/query/report 功能验收。
- 如果继续增长到 100k/131k 以上，主动 `/new` 或归档。

## 配置落地步骤

### 1. 变更前备份

修改 OpenClaw 配置前先备份：

```bash
cp /home/netinside/.openclaw/openclaw.json \
  /home/netinside/.openclaw/openclaw.json.bak-session-$(date +%Y%m%d%H%M%S)
```

### 2. 查看当前配置

```bash
python3 - <<'PY'
import json
p='/home/netinside/.openclaw/openclaw.json'
j=json.load(open(p, encoding='utf-8'))
print(json.dumps(j.get('session'), ensure_ascii=False, indent=2))
PY
```

当前应类似：

```json
{
  "dmScope": "per-channel-peer"
}
```

### 3. 写入 maintenance 配置

建议配置：

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "maintenance": {
      "mode": "enforce",
      "pruneAfter": "30d",
      "maxEntries": 500,
      "resetArchiveRetention": "30d"
    }
  }
}
```

如果要保守一点，可以先使用：

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "maintenance": {
      "mode": "warn",
      "pruneAfter": "30d",
      "maxEntries": 500,
      "resetArchiveRetention": "30d"
    }
  }
}
```

### 4. 重启并验证

```bash
systemctl --user restart openclaw-gateway.service
sleep 3
systemctl --user is-active openclaw-gateway.service
```

查看日志：

```bash
journalctl --user -u openclaw-gateway.service -n 50 --no-pager
```

### 5. 清理预演

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --dry-run
```

如果结果符合预期，再执行：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --enforce
```

### 6. 每周例行巡检

建议每周执行：

```bash
/home/netinside/.npm-global/bin/openclaw sessions --json > /tmp/openclaw-sessions-$(date +%Y%m%d).json
/home/netinside/.npm-global/bin/openclaw sessions cleanup --dry-run
```

重点检查：

- token 使用超过 60% 的 session。
- 超过 7 天未活跃但仍高 token 的 session。
- 超过 30 天未活跃的 session。
- 生产验收是否发生在长会话里。

## 会话验收检查清单

### NAPM query 验收

测试语句：

```text
系统中有哪些业务？
系统中有哪些自动识别的应用？
最近一小时丢包严重的前10个IP
```

检查点：

- 是否调用 `napm-skill-query`。
- 是否有完整 `resolvedQuery`。
- 是否没有 direct curl/python 说法。
- 是否没有使用旧会话结论。

### Packet skill 验收

测试语句：

```text
帮我构造 101.254.114.238 最近一小时的数据包下载链接，不要下载
```

检查点：

- 是否调用 `napm-packet-analysis`。
- 日志是否出现 `napm_packet_analysis_invoked`。
- 日志是否出现 `napm_packet_analysis_completed`。
- 最终链接是否包含 `UserName=GAIOP&Password=***`。
- 是否没有再说“GAIOP 无权限”，除非本轮真实接口返回 403。

### Report skill 验收

测试语句：

```text
将以上以 Word 文档形式给我
```

检查点：

- 是否调用 `napm-report-export`。
- 是否只生成一份报告。
- 是否使用最新 fresh `reportData`。
- 是否没有重复发送同一个文件。

## 风险和边界

### 1. 不建议直接删除 session 文件

不要直接执行类似：

```bash
rm -rf /home/netinside/.openclaw/agents/main/sessions/*
```

原因：

- 会破坏 session store 和 transcript 的对应关系。
- 会影响审计追溯。
- 可能导致 OpenClaw 当前活跃会话状态异常。

应优先使用：

```bash
/home/netinside/.npm-global/bin/openclaw sessions cleanup --dry-run
/home/netinside/.npm-global/bin/openclaw sessions cleanup --enforce
```

### 2. 不建议把审计和上下文绑定

历史记录要保留，但模型不应该无限复用历史记录。

正确做法：

```text
历史 transcript 进入审计留存。
业务验收使用新 session。
实时数据问题强制走工具。
```

### 3. 不建议把所有用户统一成一个 session

当前 `dmScope=per-channel-peer` 是合理的。

不要改成所有私聊共用一个 main session，否则不同用户的问题会互相污染。

推荐保持：

```json
{
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

### 4. 不建议把会话 TTL 设置太短

如果 5-10 分钟就新开，用户连续追问会失去上下文。

比较合理的是：

```text
普通私聊：24 小时。
群聊主题：6-24 小时。
验收任务：每次新开。
排查任务：任务结束后新开。
```

## 一句话原则

生产环境会话管理的核心原则：

```text
上下文短一点，审计长一点；排查和验收分开；实时数据必须靠当前轮工具结果。
```



## 后续动作

1. 继续保留本会话用于复盘和技术解释。
2. 新开或清空企业微信会话用于 packet skill 验收。
3. 验收时重点观察日志是否出现：

```text
napm_packet_analysis_invoked
napm_packet_analysis_completed
```

4. 若没有出现上述日志，则说明仍未进入 packet tool，需要继续查工具暴露/模型选择链路。
5. 若出现上述日志但结果不对，则再排查 `openclaw-napm-packet-analysis/scripts/run_packet_analysis.js`。
