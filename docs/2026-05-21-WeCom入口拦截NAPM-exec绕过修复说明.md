# 2026-05-21 WeCom 入口拦截 NAPM exec 绕过修复说明

## 背景

用户在企业微信中询问：

```text
丢包最大的IP地址是谁？
```

OpenClaw 返回了看似正确的丢包 Top IP，但排查远端日志后确认该轮没有经过 `napm-skill-query`，也没有进入新增的 `resolvedQuery` audit 链路。

## 现象证据

- `audit.log` 在该时间点没有 `napm_plugin_*` 或 `napm_skill_*` 事件。
- `journalctl` 只看到 WeCom 收消息和最终回复，没有 NAPM 插件 hook 日志。
- 会话 JSONL 显示主 Agent 直接调用了 `exec`，通过 `curl` 请求 NetInside `topValues` API。
- 因此这不是 skill 查询正确与否的问题，而是 WeCom 通道把 NAPM 问题放行到了 OpenClaw Agent，Agent 绕过了 `resolvedQuery -> napm-skill-query` 边界。

## 根因

远端实际运行的 WeCom 插件是：

```text
/home/netinside/.openclaw/npm/node_modules/@wecom/wecom-openclaw-plugin/dist/src/monitor.js
```

该入口收到企业微信消息后直接构造 OpenClaw Agent 上下文并进入主流程。NAPM 插件虽然已加载，但本轮 WeCom 消息没有形成可见的 NAPM hook / tool 调用链路，导致 Agent 可以自行使用 `exec/curl` 查询底层 API。

## 本次修复

在 WeCom 真实消息入口增加 NAPM 边界预检：

1. 在 `processWeComMessageNow()` 创建消息状态后、构造 Agent 上下文前，先识别 NAPM 相关问法。
2. 命中 NAPM 问法后，调用本地 `openclaw-napm-query/scripts/run_napm_query.js` 做 strict 边界校验。
3. 如果 skill 返回 `UPSTREAM_RESOLVED_QUERY_REQUIRED` 或其他 resolvedQuery 缺失错误，直接回复边界诊断。
4. 不再 fallback 到 OpenClaw Agent，因此不会再由 Agent 走 `exec/curl` 直接查 NetInside API。

## 预期效果

再次测试：

```text
丢包最大的IP地址是谁？
```

如果上游仍没有构造 `resolvedQuery`，回复应类似：

```text
这条 NAPM 问题已经在企业微信入口被拦截，没有继续交给 OpenClaw Agent 自行调用 exec/curl。
当前 strict 边界要求：上游必须先构造结构化 resolvedQuery，再调用 napm-skill-query。
本轮没有拿到可执行 resolvedQuery（UPSTREAM_RESOLVED_QUERY_REQUIRED），所以不会展示任何直接 API 查询结果。
```

这说明问题明确定位在 OpenClaw mainflow 没有稳定产出 `resolvedQuery`，而不是 skill 查询错误。

如果后续上游能稳定产出 `resolvedQuery`，则 WeCom 入口会允许 skill 结果直接返回，且日志中应出现 `napm_skill_*` audit 事件。

## 后续重点

- 继续推动 OpenClaw mainflow 消费 `config/napm-resolution-spec.v1.json` 产出结构化 `resolvedQuery`。
- 企业微信入口只做边界防绕过，不在这里构造业务 resolvedQuery，避免再次形成兜底双写规则。
- 保留 NAPM 插件侧 `before_tool_call` 拦截，但不能只依赖它，因为这次绕过说明 WeCom 通道可能先于 NAPM 插件 hook 进入 Agent 主流程。
