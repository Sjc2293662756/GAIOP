# 告警分类 category 与 categoryType 筛选口径说明

## 1. 背景

告警接口返回的事件中同时存在两类容易混淆的字段：

- `category` / `categoryLabel`
- `categoryType`

在用户询问“应用告警”“业务告警”“某对象类型相关告警”时，必须区分这两个字段的含义，否则会出现过滤结果为空、分类不准，或模型误说“categories 参数不生效”的问题。

## 2. 字段含义

### 2.1 `category`

`category` 是告警大类，也就是 `alertsSummary` 返回 JSON 的顶层分类 key。

常见映射：

| category | categoryLabel |
|---|---|
| `networkAlerts` | 网络性能告警 |
| `networkIssueAlerts` | 网络异常告警 |
| `appAlerts` | 应用性能告警 |
| `busAlerts` | 业务故障告警 |
| `userAlerts` | 用户体验告警 |
| `securityAlerts` | 安全事件告警 |
| `AIAlerts` | 智能分析告警 |

适合回答这类问题：

```text
近一小时有哪些应用告警？
近一小时有哪些应用性能告警？
近一小时有哪些业务告警？
近一小时有哪些网络异常告警？
近一小时有哪些安全告警？
```

对应筛选：

```json
{
  "categories": ["appAlerts"]
}
```

或允许中文别名，由 skill 归一化：

```json
{
  "categories": ["应用性能告警"]
}
```

## 3. `categoryType`

`categoryType` 是告警对象类型编码，不是告警大类。

它用于说明这条告警挂在哪一种对象维度上，例如 IP、业务组、页面族、WebApplication 等。

当前确认映射：

| categoryType | groupType1 |
|---:|---|
| `0` | `TotalTraffic` |
| `3` | `IPAddress` |
| `14` | `BusinessGroup` |
| `25` | `Application` |
| `29` | `BusinessGroupLink` |
| `53` | `IPConversation` |
| `58` | `Interface` |
| `63` | `PageFamily` |
| `67` | `User` |
| `68` | `WebApplication` |
| `72` | `MonInterfaceGroup` |

代码位置：

```text
skills/openclaw-napm-alert-query/services/AlertConstants.js
```

对应常量：

```js
const CATEGORY_TYPE_TO_GROUP_TYPE = {
  0: 'TotalTraffic',
  3: 'IPAddress',
  14: 'BusinessGroup',
  25: 'Application',
  29: 'BusinessGroupLink',
  53: 'IPConversation',
  58: 'Interface',
  63: 'PageFamily',
  67: 'User',
  68: 'WebApplication',
  72: 'MonInterfaceGroup',
};
```

适合回答这类问题：

```text
近一小时 WebApplication 相关告警有哪些？
近一小时 IP 地址相关告警有哪些？
近一小时业务组相关告警有哪些？
近一小时页面族相关告警有哪些？
近一小时接口相关告警有哪些？
```

对应筛选：

```json
{
  "categoryTypes": [68]
}
```

## 4. 二者区别

### 4.1 告警大类用 `category`

用户说“应用告警”时，通常语义是“应用性能告警”。

此时优先使用：

```json
{
  "categories": ["appAlerts"]
}
```

不应直接理解为：

```json
{
  "categoryTypes": [25]
}
```

原因：

`appAlerts` 表示应用性能告警这个大类；而 `categoryType=25` 只是对象类型为 `Application`。应用性能告警大类下面可能包含不同对象维度，不一定全部是 `Application`。

### 4.2 对象类型用 `categoryType`

用户明确问对象维度时，才使用 `categoryType`。

例如：

```text
WebApplication 相关告警
IP 地址相关告警
页面族相关告警
接口相关告警
```

此时应构造：

```json
{
  "categoryTypes": [68]
}
```

## 5. 推荐筛选规则

### 5.1 问告警大类

| 用户说法 | 推荐条件 |
|---|---|
| 应用告警 / 应用性能告警 | `categories=["appAlerts"]` |
| 业务告警 / 业务故障告警 | `categories=["busAlerts"]` |
| 网络性能告警 | `categories=["networkAlerts"]` |
| 网络异常告警 | `categories=["networkIssueAlerts"]` |
| 用户体验告警 | `categories=["userAlerts"]` |
| 安全告警 / 安全事件告警 | `categories=["securityAlerts"]` |
| 智能告警 / 智能分析告警 / AI 告警 | `categories=["AIAlerts"]` |

### 5.2 问对象类型

| 用户说法 | 推荐条件 |
|---|---|
| 总流量相关告警 | `categoryTypes=[0]` |
| IP 地址相关告警 | `categoryTypes=[3]` |
| 业务组相关告警 | `categoryTypes=[14]` |
| 应用对象相关告警 | `categoryTypes=[25]` |
| 业务组链路相关告警 | `categoryTypes=[29]` |
| IP 会话相关告警 | `categoryTypes=[53]` |
| 接口相关告警 | `categoryTypes=[58]` |
| 页面族相关告警 | `categoryTypes=[63]` |
| 用户相关告警 | `categoryTypes=[67]` |
| WebApplication / 业务系统相关告警 | `categoryTypes=[68]` |
| 接口组相关告警 | `categoryTypes=[72]` |

### 5.3 同时限定告警大类和对象类型

可以组合：

```json
{
  "categories": ["appAlerts"],
  "categoryTypes": [68]
}
```

语义：

```text
应用性能告警中，筛选对象类型为 WebApplication 的告警。
```

## 6. 与 timeValues 的关系

`categoryType` 还用于告警触发指标趋势查询。

链路：

```text
alertsSummary / alertsDetail 返回 categoryType
  -> normalizeEvent()
  -> event.groupType = CATEGORY_TYPE_TO_GROUP_TYPE[categoryType]
  -> detail_with_timeseries
  -> timeValues 请求使用 groupType1 = event.groupType
```

例如：

```json
{
  "categoryType": 68,
  "group": "可观测239web",
  "metrics": ["PGNPGE"]
}
```

构造 `timeValues`：

```text
type=timeValues
metrics=PGNPGE
groupType1=WebApplication
groupArgument1=可观测239web
```

## 7. 已修复的兼容问题

之前主链可能传入：

```json
{
  "categories": ["应用性能告警"]
}
```

旧逻辑只拿它与事件中的 `event.category=appAlerts` 比较，导致匹配不到，最终模型说：

```text
categories 参数在当前模式下不生效
```

这句话不准确。

真实问题是：

```text
中文 categoryLabel 没有归一化成后端 category key。
```

现在已在 `AlertQueryValidator` 中兼容：

```text
应用性能告警 / 应用告警 -> appAlerts
业务故障告警 / 业务告警 -> busAlerts
网络异常告警 -> networkIssueAlerts
网络性能告警 -> networkAlerts
用户体验告警 -> userAlerts
安全事件告警 / 安全告警 -> securityAlerts
智能分析告警 / AI告警 -> AIAlerts
```

`AlertNormalizerService.filterEvents()` 也兼容：

```text
criteria.categories 匹配 event.category
criteria.categories 匹配 event.categoryLabel
```

## 8. 测试建议

### 8.1 category 大类筛选

```text
近一小时有哪些应用告警？
近一小时有哪些业务告警？
近一小时有哪些网络异常告警？
```

期望：

- `应用告警` 返回 `category=appAlerts`。
- `业务告警` 返回 `category=busAlerts`。
- `网络异常告警` 返回 `category=networkIssueAlerts`。
- 不再出现“categories 参数不生效”。

### 8.2 categoryType 对象类型筛选

```text
近一小时有哪些 WebApplication 相关告警？
近一小时有哪些 IP 地址相关告警？
近一小时有哪些页面族相关告警？
```

期望：

- WebApplication -> `categoryTypes=[68]`。
- IP 地址 -> `categoryTypes=[3]`。
- PageFamily -> `categoryTypes=[63]`。

### 8.3 组合筛选

```text
近一小时应用性能告警里，WebApplication 相关的有哪些？
```

期望：

```json
{
  "categories": ["appAlerts"],
  "categoryTypes": [68]
}
```

## 9. 结论

告警筛选口径应固定为：

```text
问告警大类：用 category/categories
问对象类型：用 categoryType/categoryTypes
查触发指标趋势：用 categoryType -> groupType1 映射
```

不能把“应用告警”简单等同于 `categoryType=25`。

如果用户说“应用告警”，默认优先理解为：

```text
应用性能告警 -> appAlerts
```

只有用户明确说“Application 对象相关告警”或“应用对象维度告警”时，才使用：

```text
categoryType=25
```

## 10. 2026-06-17 业务告警误归类修复记录

### 10.1 线上现象

用户询问：

```text
近一小时有哪些业务告警？
```

企微端错误回答中出现：

```text
HTTPS — 外部应用性能下降
```

该事件属于：

```text
appAlerts / 应用性能告警
```

不应被归入：

```text
busAlerts / 业务故障告警
```

### 10.2 audit 证据

09:57 这轮主链传给 `napm-alert-query` 的条件是：

```json
{
  "prompt": "近一小时有哪些业务告警？",
  "mode": "summary",
  "criteria": {
    "categories": ["业务应用", "业务系统", "应用性能", "业务"]
  }
}
```

其中：

```text
应用性能 -> appAlerts
```

所以旧逻辑会把应用性能告警混入业务告警结果，导致 `HTTPS / 外部应用性能下降` 被错误展示。

### 10.3 根因

主链把“业务告警”误扩展成了“业务相关告警”，混入了：

```text
业务应用
业务系统
应用性能
业务
```

但在告警领域，“业务告警”默认应解释为：

```text
业务故障告警 -> busAlerts
```

而不是：

```text
业务系统相关告警
应用性能告警
WebApplication 相关告警
```

### 10.4 修复策略

在告警 skill 执行层增加 prompt 兜底。

位置：

```text
skills/openclaw-napm-alert-query/scripts/run_alert_query.js
```

新增逻辑：

```text
applyPromptCategoryFilter()
resolveCategoryFilterFromPrompt()
```

当 prompt 明确包含以下表达：

```text
业务告警
业务故障
业务故障告警
```

强制重建：

```json
{
  "categories": ["busAlerts"]
}
```

即使主链传入：

```json
{
  "categories": ["业务应用", "业务系统", "应用性能", "业务"]
}
```

执行层也会覆盖为：

```json
{
  "categories": ["busAlerts"]
}
```

### 10.5 审计 warning

当执行层覆盖主链分类时，结果中写入：

```json
{
  "code": "ALERT_PROMPT_CATEGORY_FILTER_REBUILT",
  "message": "已按用户告警分类表达重建筛选条件：busAlerts。",
  "originalCategories": ["业务应用", "业务系统", "appAlerts", "业务"],
  "categories": ["busAlerts"]
}
```

用途：

- 保留主链原始错误输入。
- 明确执行层做过分类纠偏。
- 后续排查时可确认不是后端接口问题。

### 10.6 远端验证

修复前，同样入参返回：

```text
categories: appAlerts
labels: 应用性能告警
events: HTTPS / 外部应用性能下降
```

修复后，同样入参返回：

```text
total=3
categories: busAlerts
labels: 业务故障告警
```

示例事件：

```text
紧急 / 业务故障告警 / 可观测239web / T239web页面SNMP测试
紧急 / 业务故障告警 / 可观测239web / T239web页面SNMP测试
轻微 / 业务故障告警 / 可观测239web / T239web页面SNMP测试
```

### 10.7 测试覆盖

新增 runner 级回归测试：

```text
should force business alert prompt to busAlerts even when model mixes application categories
```

覆盖场景：

```json
{
  "prompt": "近一小时有哪些业务告警？",
  "criteria": {
    "categories": ["业务应用", "业务系统", "应用性能", "业务"]
  }
}
```

期望：

```json
{
  "categories": ["busAlerts"]
}
```

且返回事件只包含：

```text
busAlerts / 业务故障告警
```

### 10.8 远端部署

已同步远端：

```text
/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/scripts/run_alert_query.js
```

备份：

```text
run_alert_query.js.bak-prompt-category-20260617113034
```

语法检查：

```text
node --check /home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/scripts/run_alert_query.js
```

服务重启：

```text
systemctl --user restart openclaw-gateway.service
systemctl --user is-active openclaw-gateway.service
```

最终状态：

```text
active
```
