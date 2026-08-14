# openclaw-napm-query 问题 1：生产输入契约整改说明

日期：2026-07-30  
状态：本地整改、远端部署和生产 Tool 连调已完成。

## 问题与影响

原生产入口同时存在两种行为：文档要求上游提供完整 `resolvedQuery`，插件又会在部分请求中根据 `prompt` 隐式调用本地 Resolver。相同入口因此可能走结构化执行，也可能走二次自然语言解析，结果依赖 Resolver 覆盖范围。

## 与旧整改的关系

旧文档《NAPM 查询语义解析与参数改写问题整改说明》已经发现“双重语义解析”，但当时采用“字段级合并”保护 `topCount`、`metrics`、`start/end`，仍保留生产 Resolver。

本次不是重做 TopN、指标或时间修复，而是完成旧整改未收口的所有权问题：生产链路不再调用 Resolver。

## 最终契约

```text
OpenClaw 构造语义完整的 resolvedQuery
  -> 插件执行无损、确定性的结构规范化
  -> Tool execute 物化执行时间
  -> Query Skill 校验并执行
```

- `resolvedQuery` 是 `napm-skill-query` 的生产必填输入。
- `prompt` 和 `userQuery` 只用于追踪与叙述，不得构造、补全或修复查询语义。
- 缺少查询语义时返回结构化失败，不根据文本猜测。
- `napm-resolve-query` 和 `napm-mainflow-query` 只作为开发诊断工具，并由 `NAPM_ENABLE_DEV_RESOLVER_TOOLS=true` 显式启用。

## 修改内容

- 同步收敛 `SKILL.md`、`agents/openai.yaml`、resolution spec 和插件 Tool Schema。
- 从 `prepareSkillExecutionArgs()` 移除 `maybeAutoRepairResolvedQuery()` 生产调用链。
- 删除无生产用途的自动修复整体替换/字段合并入口。
- 将 `resolvedQuery` 加入 Tool Schema 顶层 `required`。
- 保留 Resolver 单元能力，限制其只从默认关闭的诊断 Tool 进入。

## 回归验证

- `test/napm-openclaw-plugin-time-contract.test.js`：prompt-only Tool 调用明确失败。
- `test/napm-query-semantic-preservation.test.js`：prompt 不再生成查询，显式结构化字段不被改写。
- `test/run-napm-query-input-contract.test.js`：strict 边界要求上游 `resolvedQuery`。
- `test/napm-openclaw-plugin-resolver-tool.test.js`：7 个生产 Tool 默认注册，2 个 Resolver Tool 默认关闭。
- 全量 Jest：73 个 suite、496 个测试全部通过。

## 验收结论

生产输入已收敛为单轨结构化契约。旧整改中的 TopN、指标集合、固定时间保护继续保留，没有重复实现第二套语义解析。

## 远端部署与生产连调

- 已将整改涉及的运行文件同步到生产运行目录，部署前文件均已归档，SHA-256、JSON 和 JavaScript 语法检查通过。
- Gateway 已通过用户级 systemd 服务受控重启；当前 18789 端口正常监听，4 个插件加载且无插件错误。
- 企业微信 WebSocket 已完成认证，通道状态为 `running=true`。
- prompt-only 请求在真实 Tool 定义下返回 `UPSTREAM_RESOLVED_QUERY_INVALID` / `missing_resolved_query`，没有调用后端。
- 相对时间 Top5 请求保持 `topCount=5` 和严格 3600 秒窗口；固定时间多指标请求保持显式 `start/end`、`BYTI,BYTO,BYTIO`、`topMetric=BYTIO` 和 `topCount=5`。
- 告警请求一次路由到 `napm-alert-query`。

## 连调追加修复

生产诊断连调发现插件把 Agent 运行期 Hook 注册到了 `registerHook`，而当前 OpenClaw 的 `before_tool_call`、`after_tool_call`、`before_message_write` 和 `message_sending` 必须通过 `api.on` 注册。本地旧测试模拟了错误接口，因此没有提前发现。

整改后：

- Typed Hooks 逐项通过 `api.on` 注册，并保留旧测试环境兼容后备。
- 故障诊断请求只允许一次 `napm-fault-diagnosis`；失败后禁止降级 Query、重复诊断、日志探测或其他 Tool。
- `after_tool_call` 将失败结果绑定到当前 run/session；最终消息落盘和企业微信发送前均强制使用确切失败文本。
- 失败回复明确说明没有足够证据，禁止推断对象不存在、无数据或具体根因。
- 生产复测只调用 1 次 `napm-fault-diagnosis`，未调用 `napm-skill-query`；会话最终文本已按安全失败契约改写。

完整部署与连调证据见《2026-07-30-openclaw-napm-query生产部署与连调验收记录》。
