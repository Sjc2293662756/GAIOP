# resolvedQuery 时间字段构造契约收口

日期：2026-05-25

## 背景

`napm-skill-query` 的执行层只读取 `resolvedQuery.start` 和 `resolvedQuery.end` 作为真实执行时间字段。

此前 `napm-resolution-spec.v1.json` 中部分服务的 `required` 字段仍写着 `timeRange`，这会误导上游 OpenClaw 构造出如下结构：

```json
{
  "service": "topValues",
  "timeRange": {
    "start": 1779638400,
    "end": 1779724799
  }
}
```

但执行层校验的是根层级字段：

```json
{
  "service": "topValues",
  "start": 1779638400,
  "end": 1779724740
}
```

因此这不是执行层兜底问题，而是 resolvedQuery 构造契约必须收口。

## 修改原则

时间字段职责划分如下：

- `start` / `end`：唯一真实执行时间字段，必须位于 `resolvedQuery` 根层级。
- `timeRange`：只允许承载 `key`、`displayText` 等语义展示/审计信息。
- `timeRange.start` / `timeRange.end`：不作为执行字段，不允许替代根层级 `start/end`。
- 构造阶段必须完成 60 秒分钟边界对齐。

## 修改内容

### 1. 修改 resolution spec

文件：`config/napm-resolution-spec.v1.json`

将以下服务的 `required` 字段从 `timeRange` 改为根层级 `start` / `end`：

- `topValues`
- `averageValues`
- `timeValues`
- `overview`
- `topValues_multi_protocol`

同时将 `timeRange` 放入 `optional`，只作为语义元信息保留。

新增 `queryContract.constructionRules`：

```text
All executable data and analysis resolvedQuery objects must put effective execution timestamps at root-level start/end.
start/end must be Unix timestamps in seconds and aligned to 60-second minute boundaries before calling napm-skill-query.
timeRange is declarative metadata for key/display text only and must not be used as the executable timestamp carrier.
timeRange.start/timeRange.end are not accepted as substitutes for root-level start/end.
```

### 2. 修改本地诊断构造器

文件：`skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js`

新增：

```js
validateResolvedQueryTimeContract(resolvedQuery)
```

规则：

- 数据/分析类服务必须有根层级 `start/end`。
- 如果只有 `timeRange.start/end`，判定构造失败。
- 失败原因返回 `missing_root_execution_time`。

同时调整：

```js
normalizeResolvedQueryTimeRange(resolvedQuery)
```

它现在只对根层级 `start/end` 做分钟对齐，并移除 `timeRange.start/end`，避免后续日志或调用方误以为嵌套时间可以执行。

### 3. 修改 skill 输入规范

文件：`skills/openclaw-napm-query/scripts/run_napm_query.js`

`normalizeResolvedQueryTimeRange()` 不再保留 `timeRange.start/end`，只保留 `timeRange.key` 等语义信息。

注意：这不是执行层兜底展平，而是防止错误字段继续传播。

### 4. 修改测试

更新：

- `test/napm-resolved-query-resolver-service.test.js`
- `test/resolution-spec-service.test.js`
- `test/run-napm-query-input-contract.test.js`

新增/调整验证：

- 数据查询服务的 spec required 必须包含 `start/end`。
- 数据查询服务的 spec required 不得包含 `timeRange`。
- 构造器遇到只有 `timeRange.start/end` 的数据查询会返回 `missing_root_execution_time`。
- `timeRange.start/end` 会被清理，不再作为执行字段保留。

## 正确 resolvedQuery 示例

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "topCount": 10,
  "start": 1779638400,
  "end": 1779724740,
  "timeRange": {
    "key": "today",
    "displayText": "今天"
  },
  "format": "json"
}
```

## 错误 resolvedQuery 示例

```json
{
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "PLI",
  "metrics": ["PLI"],
  "topMetric": "PLI",
  "groups": [{ "type": "IPAddress" }],
  "timeRange": {
    "start": 1779638400,
    "end": 1779724740
  }
}
```

该结构应在构造阶段失败，而不是进入 skill 执行阶段再兜底。

## 验证

已执行：

```bash
npm test -- --runInBand test/napm-resolved-query-resolver-service.test.js test/resolution-spec-service.test.js test/run-napm-query-input-contract.test.js
node --check skills/openclaw-napm-query/services/NapmResolvedQueryResolverService.js
node --check skills/openclaw-napm-query/scripts/run_napm_query.js
node -e "JSON.parse(require('fs').readFileSync('config/napm-resolution-spec.v1.json','utf8')); console.log('spec json ok')"
```

结果均通过。
