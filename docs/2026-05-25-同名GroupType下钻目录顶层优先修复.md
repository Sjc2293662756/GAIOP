# 2026-05-25 同名 GroupType 下钻目录顶层优先修复

## 1. 问题背景

用户询问：

```text
现在业务组有哪些下钻路径？
```

系统曾回答 `BusinessGroup` 是叶子节点、`children=[]`，因此不能继续下钻。

该回答不符合当前静态 group tree 的真实结构。`config/groups-tree.static.json` 中顶层 `BusinessGroup` 实际存在 7 个直接下钻方向：

```text
MemberIPs
ConnectedIPs
LocalTraffic
IPProtocols
ConnectedGroups
Applications
IPConversations
```

## 2. 根因

`groups-tree.static.json` 中同一个运行时 group type 可能出现在多个位置。

以 `BusinessGroup` 为例，静态树里存在多个同名节点：

```text
IPAddress > ConnectedGroups > BusinessGroup
BusinessGroup
BusinessGroup > ConnectedGroups > ConnectedBusinessGroup > Applications > Application > LinkMembers > BusinessGroup
BusinessGroup > ConnectedGroups > ConnectedBusinessGroup > LinkMembers > BusinessGroup
```

其中：

```text
IPAddress > ConnectedGroups > BusinessGroup
```

是一个嵌套位置下的对端业务组节点，确实是叶子节点。

但用户问“业务组有哪些下钻路径”时，语义上应优先选择顶层对象：

```text
BusinessGroup
```

因此，错误原因不是静态树缺少业务组下钻信息，而是查询/解释时可能命中了第一个同名 `BusinessGroup` 节点，导致把嵌套叶子节点误当成顶层对象。

## 3. 修复原则

对所有 group type 统一 적용，不只针对 `BusinessGroup`：

```text
当用户查询某个对象的下钻目录时，如果静态树中存在多个同名 group type：
1. 优先选择 path.length === 1 的顶层节点。
2. 如果没有顶层节点，再回退到评分最高的嵌套节点。
3. 返回结果保留 sourcePath/sourcePathText/isTopLevel，便于排查实际选中的锚点。
```

`path.length === 1` 表示该节点路径只有一层，也就是顶层对象。例如：

```js
['BusinessGroup'] // 顶层 BusinessGroup
```

而下面这种不是顶层对象：

```js
['IPAddress', 'ConnectedGroups', 'BusinessGroup']
```

## 4. 代码调整

修改文件：

```text
skills/openclaw-napm-query/services/NapmMetadataService.js
```

核心调整：

```text
getDrilldownPathsForGroupType()
  -> 不再直接使用 candidates[0]
  -> 改为 selectPreferredGroupNode(candidates)

findGroupNodesByType()
  -> 同名节点排序改为 compareGroupNodesForCanonicalSelection()
```

新增通用选择逻辑：

```text
selectPreferredGroupNode(nodes)
isTopLevelGroupNode(node)
compareGroupNodesForCanonicalSelection(left, right)
```

选择顺序：

```text
顶层节点优先
同为顶层或同为非顶层时，继续按 scoreGroupNode() 评分
评分相同则按 pathText 稳定排序
```

## 5. 影响范围

该修复覆盖所有在静态树中重复出现的顶层对象，包括但不限于：

```text
IPAddress
BusinessGroup
IPConversation
DefinedApp
OtherApp
WebApplication
PageFamily
User
ClientBusinessGroup
```

修复后，当用户询问这些对象的下钻目录时，主链应优先使用顶层对象定义，而不是误选嵌套位置下的同名节点。

## 6. 回归测试

修改文件：

```text
test/napm-metadata-drilldown-catalog.test.js
```

新增测试：

```text
should prefer top-level definitions when a group type appears in multiple tree locations
```

测试逻辑：

```text
1. 读取所有顶层 group type。
2. 找出同时存在顶层节点和嵌套同名节点的 group type。
3. 对每个 group type 调用 getDrilldownPathsForGroupType()。
4. 断言返回的 sourcePath 必须是顶层路径。
5. 断言 isTopLevel=true。
```

## 7. 验证结果

执行聚焦测试：

```bash
npx jest test/napm-metadata-drilldown-catalog.test.js test/run-napm-query-hierarchy-catalog.test.js --runInBand
```

结果：

```text
Test Suites: 2 passed, 2 total
Tests: 11 passed, 11 total
```

实际抽样确认：

```text
BusinessGroup: sourcePathText=BusinessGroup, isTopLevel=true, directChildren=7
IPAddress: sourcePathText=IPAddress, isTopLevel=true, directChildren=4
DefinedApp: sourcePathText=DefinedApp, isTopLevel=true, directChildren=3
WebApplication: sourcePathText=WebApplication, isTopLevel=true, directChildren=6
```

## 8. 正确 resolvedQuery 形态

用户询问：

```text
现在业务组有哪些下钻路径？
```

应构造：

```json
{
  "service": "drilldownCatalog",
  "groups": [
    {
      "type": "BusinessGroup",
      "argument": null
    }
  ],
  "semanticConstraints": {
    "operation": "drilldown_catalog",
    "targetObjectType": "BusinessGroup"
  }
}
```

执行时应返回顶层 `BusinessGroup` 的下钻目录，而不是嵌套叶子节点 `IPAddress > ConnectedGroups > BusinessGroup`。

## 9. 防止模型手动推测

2026-05-25 17:50 左右再次出现类似错误回答：

```text
读取 groups-tree.static.json，找到 key: "BusinessGroup" 节点，children: []，所以没有子节点。
BusinessGroup -> IPAddress 等组合路径是推测。
```

这说明仅修复 `NapmMetadataService` 的选点逻辑还不够；如果模型绕过 `drilldownCatalog`，直接手动解释 JSON，仍可能命中嵌套叶子节点。

因此补充插件层硬约束：

```text
napm-openclaw-plugin.remote.js
```

新增输出识别函数：

```text
looksLikeManualHierarchyInferenceText()
```

识别并拦截以下高风险回答：

```text
groups-tree.static.json
children: []
children 为空
叶子节点
手动读取 JSON
递归搜索节点
组合路径
推测/猜测
没有走 napm-skill-query
直接调用 NapmMetadataService
```

当当前 prompt 是下钻/层级目录问题时：

```text
isHierarchyCatalogPrompt(prompt) === true
```

如果最终回答命中手动推测特征：

```text
1. 若本轮已有真实 skill 结果，直接用 skill 结果覆盖回答。
2. 若本轮没有 skill 结果，返回固定拦截提示。
3. 不允许输出 children=[]、组合路径推测、手动 JSON 解释。
```

固定拦截提示会要求：

```text
必须先构造 service=drilldownCatalog 的 resolvedQuery，
再通过 napm-skill-query 执行。
```

同时在 OpenClaw routing system context 中新增约束：

```text
For hierarchy or drilldown questions, never manually inspect groups-tree.static.json,
never decide from a single `children: []` node,
and never invent "combination paths";
answer only from the current `drilldownCatalog` skill result.
```

新增回归测试：

```text
test/napm-openclaw-plugin-hierarchy-guard.test.js
```

覆盖场景：

```text
用户：现在业务组有哪些下钻路径？
模型错误回答：读取 groups-tree.static.json，BusinessGroup children: []，组合路径是推测。
期望：插件拦截该回答，替换为必须执行 service=drilldownCatalog + napm-skill-query。
```

本地验证：

```bash
npx jest test/napm-openclaw-plugin-hierarchy-guard.test.js test/napm-metadata-drilldown-catalog.test.js --runInBand
```

结果：

```text
Test Suites: 2 passed, 2 total
Tests: 9 passed, 9 total
```

远端部署：

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
```

远端备份：

```text
/home/netinside/.openclaw/deploy_backups/20260525_175816_manual_hierarchy_inference_guard
```

远端验证：

```text
isHierarchy=true
target=BusinessGroup
manualInference=true
openclaw-gateway.service active
```
