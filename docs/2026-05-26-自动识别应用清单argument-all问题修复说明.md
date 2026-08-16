# 自动识别应用清单 argument=all 问题修复说明

## 背景

用户询问“系统中有哪些自动识别的应用”时，语义应识别为 `CompositeApplication` 元数据清单查询。

正确的 resolvedQuery 形态是：

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "semanticConstraints": {
    "operation": "metadata_list"
  },
  "groups": [
    { "type": "CompositeApplication" }
  ],
  "format": "json"
}
```

## 问题表现

部分链路会构造为：

```json
{
  "service": "groups",
  "queryModeKey": "metadata",
  "groups": [
    { "type": "CompositeApplication", "argument": "all" }
  ]
}
```

执行时 `argument: "all"` 被传入 `NapmMetadataService.listObjectInstances(objectType, keyword)` 的 `keyword` 参数，随后进入 `normalizeNamedList(raw, keyword)` 做名称模糊过滤。

结果是 `all` 被当成普通搜索词，只保留名称里包含 `all` 的应用，例如 `CALL_SETUP` 类复合应用，导致自动识别应用清单从真实的 Type=4 全量列表被误裁剪为 4 条。

## 根因

`argument` 字段同时承担了两种语义：

- 对象实参，例如查询某个具体对象。
- “全部”的哨兵值，例如 `all`。

元数据清单查询中，“查全部”不应该通过 `argument: "all"` 表达，而应该通过省略 `argument` 表达。否则执行层无法区分 `all` 是系统哨兵值，还是用户想搜索名称包含 all 的对象。

## 修改内容

1. 插件边界加强 `CompositeApplication` 清单契约校验。

   “系统中有哪些自动识别的应用”必须是 `service=groups`、`queryModeKey=metadata`、`groups=[{type:"CompositeApplication"}]`，不允许使用 `overview/auto_apps`，也不允许携带 `argument:"all"`。

2. 插件 prompt 约束 OpenClaw 构造正确形态。

   对 `CompositeApplication` 清单问题，明确要求省略 `argument`，用缺省 argument 表示全量清单。

3. 执行层增加硬错误。

   `RequirementParserService` 在单对象元数据清单执行前检查 `argument`。如果收到 `all`、`*`、`__all__`，返回 `INVALID_METADATA_INVENTORY_ARGUMENT`，不继续调用南向 API，也不把它当关键词过滤。

4. 增加回归测试。

   - 插件允许正确的 `groups=[{type:"CompositeApplication"}]`。
   - 插件拒绝 `groups=[{type:"CompositeApplication", argument:"all"}]`。
   - 执行层拒绝 `argument:"all"`，并确认不会调用 `getApplications()`，避免再次出现按 `all` 误过滤。

## 设计约束

本次修复不采用“把 all 静默转为空字符串”的兜底方案。

原因是静默修正会继续掩盖上游 resolvedQuery 构造错误，后续仍可能在其他元数据对象上复发。当前策略是让错误契约尽早暴露，让 OpenClaw 构造层生成正确结构。

## 预期结果

再次询问“系统中有哪些自动识别的应用”时，应走：

```text
OpenClaw 构造 resolvedQuery
  -> service=groups
  -> queryModeKey=metadata
  -> groups=[{type:"CompositeApplication"}]
NAPM skill 执行
  -> NapmMetadataService.listObjectInstances("CompositeApplication", "")
  -> applications 南向 API
  -> applicationTypeFilter=[4]
  -> 返回全部 Type=4 自动识别应用
```

如果仍出现 `argument:"all"`，系统应直接报 `INVALID_METADATA_INVENTORY_ARGUMENT`，而不是返回被误过滤后的 4 条数据。
