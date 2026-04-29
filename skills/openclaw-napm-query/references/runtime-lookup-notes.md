# Runtime Lookup Notes

## 目录
1. 为什么需要运行时查询
2. 适合运行时查询的内容
3. 推荐优先使用的元数据服务
4. 典型使用场景
5. explanation / metadata / execution 使用建议

---

## 1. 为什么需要运行时查询

静态文档适合解释 NAPM 的通用定义，但不能保证回答以下问题时始终准确：

- 当前设备实际支持哪些指标
- 当前设备当前配置下有哪些 groups
- 某个 group 当前有哪些 argument 候选
- 某个 group drill-down 当前支持哪些指标
- 现网中某个对象名是否真的存在

这些问题应优先通过运行时元数据服务确认，而不是仅靠静态规则猜测。`metrics`、`groups`、`groupArguments`、`metricsForGroup` 都是官方支持服务。

---

## 2. 适合运行时查询的内容

### 2.1 当前支持的 metrics
使用 `metrics` 服务，获取设备支持的指标 code、label 和 unit。

### 2.2 当前 groups 树
使用 `groups` 服务，查看设备上的 group drill-down 结构。

### 2.3 某个 group 的参数候选
使用 `groupArguments` 服务，根据 `argumentType` 获取具体候选值。

### 2.4 某个 group 可用的指标
使用 `metricsForGroup` 服务，确认某个 group drill-down 支持的 metric 列表。

### 2.5 现网对象值
对于现网业务对象名、应用名、业务组名，优先通过运行时结果与现有元数据样本确认，而不是只看静态示例。`api查询` 文档里已经包含了一部分现网对象样本。:contentReference[oaicite:96]{index=96}

---

## 3. 推荐优先使用的元数据服务

### 3.1 metrics
用途：
- 指标 code 映射
- 指标 label 解释
- 单位确认

### 3.2 groups
用途：
- 确认对象类型
- 确认 drill-down 路径
- 确认某层是否需要 argument

### 3.3 groupArguments
用途：
- 获取对象候选值
- 生成 clarification 候选
- 消歧对象名

### 3.4 metricsForGroup
用途：
- 确认某层 group 是否支持目标 metric
- 避免查询前选错指标

---

## 4. 典型使用场景

### 4.1 explanation 场景
用户问：
- ClientIPs 是什么层级
- WebApplication 下面能看什么
- 这个指标能不能查业务组

做法：
- 先解释静态定义
- 若涉及“当前系统是否支持”，再补运行时元数据确认

### 4.2 query 场景
用户问：
- 查昨天 239web 的 HTTP500 top5 客户端 IP

做法：
1. 判定出 intent
2. 用 groups / groupArguments / metricsForGroup 确认路径与指标
3. 再构造 resolvedQuery 并执行

### 4.3 clarification 场景
用户问：
- 查 HIS 的情况
但 HIS 可能对应多个对象或业务组。

做法：
- 通过 groupArguments 或缓存候选生成最小澄清问题

### 4.4 result interpretation 场景
用户问：
- 为什么它这么高

做法：
- 先基于已有结果解释
- 若需补上下文，可回查原 query 的 resolvedQuery 与相关元数据

---

## 5. explanation / metadata / execution 使用建议

### explanation
静态 references 优先；涉及“当前环境是否存在/支持”时，辅以运行时元数据。

### metadata resolution
这是运行时查询最主要的使用阶段，应优先调用：
- `metrics`
- `groups`
- `groupArguments`
- `metricsForGroup` :contentReference[oaicite:97]{index=97}

### execution
只有 metadata resolution 成功后，才进入最终执行，避免错误对象绑定和无效指标查询。你们现有网关设计也强调 metadata review、argument resolution 和 execution guard。:contentReference[oaicite:98]{index=98}