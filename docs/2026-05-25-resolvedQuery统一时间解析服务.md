# 2026-05-25 resolvedQuery 统一时间解析服务

## 背景

前一轮已经把执行字段契约收口为：

```json
{
  "start": 1779638400,
  "end": 1779724740
}
```

但这些数字只是某一天的示例，不能写死。

真正需要解决的是：OpenClaw 构造 `resolvedQuery` 时，不能依赖模型临场手算时间，而要走稳定、可审计、可测试的时间解析规则。

## 修改目标

- 时间解析从模型临场计算收口到统一服务。
- `today` / `yesterday` 按运行当天动态计算，不写死示例时间戳。
- `last1hour` / `last24hours` / `lastNminutes` / `lastNhours` / `lastNdays` 统一按当前运行时间计算。
- 所有输出都满足后端要求：Unix 秒级时间戳，并按 60 秒分钟边界对齐。
- `resolvedQuery.timeRange` 只保留声明性字段，不携带 `start/end`。

## 新增文件

```text
skills/openclaw-napm-query/services/ResolvedQueryTimeRangeService.js
```

职责：

- 根据 prompt 或 `timeRangeKey` 解析时间范围。
- 动态生成根层级可执行 `start/end`。
- 输出审计信息：`source`、`alignment`、`displayText`。

核心输出示例：

```json
{
  "key": "today",
  "displayText": "今天",
  "start": 1779638400,
  "end": 1779724740,
  "source": "time_range_resolver",
  "alignment": "minute_floor",
  "boundary": "local_day"
}
```

注意：上面的数字只是 2026-05-25 当天的计算结果。到了下一天，`start/end` 会自动变化。

## 时间规则

### today / 今天

动态使用当前运行日期：

```text
start = 当天 00:00:00
end   = 当天 23:59:00
```

结束时间使用 `23:59:00`，不是 `23:59:59`，避免后端 60 秒对齐校验失败。

### yesterday / 昨天

动态使用当前运行日期的前一天：

```text
start = 昨天 00:00:00
end   = 昨天 23:59:00
```

### last1hour / 最近一小时

```text
end   = 当前时间向下取整到分钟
start = end - 3600
```

### last24hours / 最近24小时

```text
end   = 当前时间向下取整到分钟
start = end - 86400
```

### 无明确时间

默认：

```text
last1hour
```

## Resolver 接入

修改文件：

```text
skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js
```

`resolveTopValuesPrompt()` 现在通过统一服务生成时间：

```js
const timeRange = inferTimeRange(prompt, nowSeconds);
```

最终 `resolvedQuery` 写入：

```json
{
  "start": 1779638400,
  "end": 1779724740,
  "timeRange": {
    "key": "today",
    "displayText": "今天"
  },
  "resolutionHints": {
    "time": {
      "source": "time_range_resolver",
      "key": "today",
      "displayText": "今天",
      "alignment": "minute_floor"
    }
  }
}
```

这样后续看 audit 日志，可以直接判断时间来源是否走了统一解析器。

## Plugin 提示强化

修改文件：

```text
napm-openclaw-plugin.remote.js
```

在 OpenClaw system context 中新增规则：

- 时间必须按确定性 time-range 规则解析。
- `今天/today` -> `timeRange.key=today`。
- `昨天/yesterday` -> `timeRange.key=yesterday`。
- `最近一小时/过去一小时` -> `last1hour`。
- `最近24小时/过去一天` -> `last24hours`。
- 无时间默认 `last1hour`。
- today/yesterday 必须根据运行日期动态计算，禁止硬编码历史示例时间戳。
- 保留 `resolutionHints.time`，便于审计。

## 测试

新增测试：

```text
test/resolved-query-time-range-service.test.js
```

覆盖：

- `today` 会随 `nowSeconds` 所在日期动态变化。
- `yesterday` 为前一天自然日。
- `last1hour` 和默认窗口都按分钟对齐。

更新测试：

```text
test/napm-resolved-query-resolver-service.test.js
```

覆盖：

- resolver 生成 `timeRange.displayText`。
- resolver 生成 `resolutionHints.time.source=time_range_resolver`。
- `今天吞吐量最大的前10个IP是谁？` 输出根层级 `start/end`，且 `timeRange` 不包含 `start/end`。

验证结果：

```text
npm test -- --runInBand
32 test suites passed
188 tests passed
```

## 当前状态

时间执行格式已经收口：

```text
root start/end
```

时间解析职责进一步收口：

```text
ResolvedQueryTimeRangeService
```

后续如果远端 audit 仍看到：

```json
{
  "queryModeKey": "direct",
  "timeRangeKey": null,
  "resolutionHints": null
}
```

说明 OpenClaw 生产主链仍在绕过统一 resolver，由模型直接构造 `resolvedQuery`。这种情况下需要继续查 OpenClaw 主链是否真正消费了 plugin 注入的 schema/system context，或是否需要把统一时间解析器作为主链构造器的强制步骤接入。
