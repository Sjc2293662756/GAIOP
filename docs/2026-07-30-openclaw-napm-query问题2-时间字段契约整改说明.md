# openclaw-napm-query 问题 2：时间字段契约整改说明

日期：2026-07-30  
状态：本地整改和回归已完成，未执行远端部署。

## 问题与影响

原文档和运行时对时间所有权存在冲突：有的要求上游提供根级 `start/end`，有的要求只提供 `timeRange.key`，插件 Hook 和 Tool execute 还会重复覆盖时间。该状态可能产生缺失时间、陈旧时间或固定时间被相对时间替换。

## 设计

采用构造态与执行态两阶段契约：

- 相对时间构造态：提供具体 `timeRange.key`，不提供 `start/end`。
- 相对时间执行态：仅由 `napm-skill-query.execute()` 按服务器时钟物化根级 `start/end`。
- 固定时间：提供分钟对齐的根级 `start/end`，并设置 `executionOptions.timeMode="fixed"`。
- `timeRange.start/end` 永远不是执行时间戳。
- `lastNminutes` 等占位 key、缺失时间和互相冲突的时间声明必须失败。

## 修改内容

- 同步 `agents/openai.yaml`、`SKILL.md`、resolution spec 和 Tool 参数说明。
- 插件校验增加 `construction` 与 `execution` 阶段区分。
- 相对时间只在 Tool execute 中物化一次。
- 删除 `before_tool_call` 中的重复 `applyTimeOverride()`。
- `ResolvedQueryTimeRangeService` 和共享 `timeResolver` 拒绝占位 key，不再默认最近一小时。
- 固定时间禁止被当前服务器时钟重算。

## 回归验证

- `test/napm-openclaw-plugin-time-contract.test.js`：相对时间按冻结服务器时钟物化；固定时间保持不变；缺时间失败。
- `test/execution-time-resolver.test.js`：相对/固定模式和分钟边界。
- `test/resolved-query-time-range-service.test.js`：占位 key 拒绝。
- `test/napm-query-semantic-preservation.test.js`：固定时间不漂移。
- 全量 Jest：73 个 suite、496 个测试全部通过。

## 验收结论

时间语义只有一个声明来源和一个物化位置。生产调用不会静默补默认窗口，也不会在 Hook 与 execute 之间发生二次覆盖。
