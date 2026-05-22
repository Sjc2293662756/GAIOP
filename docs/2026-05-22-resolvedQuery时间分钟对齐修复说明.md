# resolvedQuery 时间分钟对齐修复说明

日期：2026-05-22

## 背景

NetInside 后端 `topValues` / `averageValues` / `timeValues` 等查询要求 `start`、`end` 时间戳必须是 60 秒的整数倍。如果 OpenClaw/mainflow 构造出的 `resolvedQuery` 使用当前秒级时间，例如 `1779413047`，执行层拼接到后端 API 后会触发时间粒度校验失败，导致查询报错或被迫手动重构 `resolvedQuery`。

本次修复目标是：在正确链路中由 OpenClaw/mainflow 构造 `resolvedQuery` 时就完成分钟对齐；同时 skill 执行入口做兜底归一化，避免外部传入非整分钟时间直接打到后端。

## 修改范围

1. `NapmResolvedQueryResolverService`

   - 新增并导出 `alignToMinute()` 与 `normalizeResolvedQueryTimeRange()`。
   - 相对时间窗口统一使用向下取整后的 `end`，再计算并对齐 `start`。
   - `success()` 返回前统一归一化 `resolvedQuery.start/end` 与 `resolvedQuery.timeRange.start/end`。
   - 默认时间窗口保持“未说明时间则最近 1 小时”，明确说“过去/最近 24 小时”则按 24 小时生成。

2. `run_napm_query.js`

   - 新增执行层 `floorToMinute()` 与 `normalizeResolvedQueryTimeRange()`。
   - 外部传入 `--resolvedQuery`、`payload.resolvedQuery`、会话继承时间、overview discovery 子查询、未知端口双协议子查询都会在执行前归一化。
   - `executeResolvedQuery()` 开始执行前再次调用 `normalizeResolvedQueryShape()`，防止测试或内部调用绕过 `resolveInput()`。

3. `QueryValidator`

   - 在请求进入 `RequirementParserService.executeGatewayRequest()` 的校验边界增加硬性检查：

     ```text
     start % 60 === 0
     end % 60 === 0
     ```

   - 如果仍有非整分钟时间进入网关请求，会直接报错 `Start and end timestamps must be aligned to 60-second minute boundaries`，避免把非法请求发送给 NetInside。

## 行为示例

输入：

```json
{
  "service": "topValues",
  "metric": "PLI",
  "start": 1779413047,
  "end": 1779499449,
  "timeRange": {
    "start": 1779413047,
    "end": 1779499449
  }
}
```

归一化后：

```json
{
  "service": "topValues",
  "metric": "PLI",
  "start": 1779413040,
  "end": 1779499440,
  "timeRange": {
    "start": 1779413040,
    "end": 1779499440
  }
}
```

## 正确链路

```text
用户自然语言
  -> OpenClaw/mainflow resolver 构造 resolvedQuery
  -> resolvedQuery 时间向下取整到分钟
  -> napm-skill-query 接收结构化 resolvedQuery
  -> skill 执行入口再次兜底归一化
  -> QueryValidator 校验通过
  -> NetInside WebService 查询
```

这样后续测试时，如果用户说“最近一小时连接失败数最多的是谁”，`resolvedQuery` 应该直接带整分钟的 `start/end`；如果用户没有说明时间，默认最近 1 小时；如果用户明确说“最近24小时/过去一天”，则以用户说明为准。

## 验证

已执行目标测试：

```powershell
npm test -- --runTestsByPath test/napm-resolved-query-resolver-service.test.js test/run-napm-query-input-contract.test.js
```

结果：

```text
PASS test/napm-resolved-query-resolver-service.test.js
PASS test/run-napm-query-input-contract.test.js
Tests: 30 passed, 30 total
```

新增覆盖点：

- resolver 生成的 TopN 时间窗口必须按分钟对齐。
- 外部传入的 `resolvedQuery.start/end` 与 `timeRange.start/end` 会被归一化。
- overview discovery 子查询中的 `start/end` 会被归一化。
- validator 会拒绝非 60 秒整数倍的网关请求。

## 注意事项

- 本次修复不是让模型手动构造 `resolvedQuery`，而是让 mainflow/resolver 在构造阶段就产出合法时间。
- skill 侧归一化是安全兜底，不替代上游构造职责。
- 如果线上仍出现非整分钟时间，需要先看 `napm_resolved_query_constructed` / `napm_skill_resolved_query_received` 日志，确认问题发生在构造层还是执行入口之后。
