# openclaw-napm-query 问题 7：错误日志序列化整改说明

日期：2026-07-30  
状态：本地整改和回归已完成。

## 问题与影响

部分错误日志使用 `logger.error(message, error.message)`。Winston 会把第二个字符串按字符索引序列化，生成 `{"0":"...","1":"..."}`，导致错误字段无法稳定查询和聚合。

## 最终契约

Logger 的第二个参数必须是结构化对象：

```js
logger.error('NAPM API request failed', {
  error: redactSensitiveText(error.message),
  code: error.code || null
});
```

不得把字符串、数字或其他 primitive 直接作为 metadata。

## 修改内容

- 将查询链中的 primitive metadata 调用改为对象。
- 统一使用 `error`、`code`、`status`、`service` 等稳定字段。
- 在结构化错误进入日志前执行敏感文本清洗。

## 回归验证

- 静态扫描未发现 `logger.error(message, error.message)` 类调用。
- `test/query-log-safety.test.js` 验证错误 metadata 为对象且内容已脱敏。
- `npm run lint` 退出码为 0。
- 全量 Jest：73 个 suite、496 个测试全部通过。

## 验收结论

错误日志恢复为可检索的结构化记录，不再产生按字符索引展开的异常 JSON。
