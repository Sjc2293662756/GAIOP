# Query Construction

## 目录
1. 查询基本结构
2. 核心参数说明
3. 各服务参数要求
4. group path 组装规则
5. 常见构造案例
6. explanation / metadata / execution 使用建议

---

## 1. 查询基本结构

NAPM Web Services 的通用 URL 结构为：

`https://<host>:<httpsPort>/webservice/NetInside?UserName=<user>&Password=<password>&type=<service><arguments>&csv=<format>`

参数顺序可调整，但第一个参数前需使用 `?`，其余参数以前缀 `&` 拼接。

如果使用 JSON 形式执行，也应保留相同语义结构：
- service type
- time range
- metrics
- groups
- extra query args（如 topCount、granularity）

---

## 2. 核心参数说明

### 2.1 type
表示服务类型，例如：
- `topValues`
- `averageValues`
- `timeValues`
- `groups`
- `metrics`
- `groupArguments`
- `metricsForGroup` 

### 2.2 start / end
表示查询时间范围，单位为 UNIX 时间戳（秒）。

### 2.3 metrics
表示指标 code 列表。可为单个或逗号分隔多个值。可通过 `metrics` 服务查看完整 code 列表。

### 2.4 numGroups
表示 group chain 的层数。

### 2.5 groupType1..n
表示每一层 group 的类型。常见值包括：
- `BusinessGroup`
- `WebApplication`
- `IPAddress`
- `Prefix24`
- `IPConversation` 等 

### 2.6 groupArgument1..n
表示某层具体对象值。并非每层都必须提供。是否需要应结合该层是否 `hasArgument` 及元数据服务结果确认。

### 2.7 topMetric
在 `topValues` 中表示排序使用的指标。

### 2.8 topCount
在 `topValues` 中表示返回前 N 个结果。

### 2.9 granularity
在 `timeValues` 中表示时间颗粒度（秒）。可通过 `granularities` 服务查看支持值。

---

## 3. 各服务参数要求

### 3.1 topValues
最常见参数组合：
- `type=topValues`
- `start`
- `end`
- `metrics`
- `topMetric`
- `topCount`
- `numGroups`
- `groupTypei`
- `groupArgumenti`（按需） 

### 3.2 averageValues
最常见参数组合：
- `type=averageValues`
- `start`
- `end`
- `metrics`
- `numGroups`
- `groupTypei`
- `groupArgumenti`（按需） 

### 3.3 timeValues
最常见参数组合：
- `type=timeValues`
- `start`
- `end`
- `metrics`
- `granularity`
- `numGroups`
- `groupTypei`
- `groupArgumenti`（按需） 

---

## 4. group path 组装规则

### 4.1 单层对象
例如查某个 IP 的平均吞吐：

- `numGroups=1`
- `groupType1=IPAddress`
- `groupArgument1=<具体IP>` 

### 4.2 单层聚合对象
例如查 BusinessGroup 维度排行，可只指定：
- `numGroups=1`
- `groupType1=BusinessGroup`
不一定需要 `groupArgument1`。

### 4.3 多层 drill-down
例如查某个 WebApplication 下客户端 IP 的 HTTP500 Top5，可构造成：
- `numGroups=3`
- `groupType1=WebApplication`
- `groupArgument1=<web应用名>`
- `groupType2=ClientIPs`
- `groupType3=IPAddress`
- `metrics=PGHTTP500`
- `topMetric=PGHTTP500`
- `topCount=5` :contentReference[oaicite:84]{index=84}

### 4.4 指定最深层具体对象
若从 TopN 切换到查某个具体对象平均值，则通常在最深层补 `groupArgument`。例如：
- `groupArgument3=1.202.187.84`
用于锁定某个客户端 IP。:contentReference[oaicite:85]{index=85}

---

## 5. 常见构造案例

### 5.1 查某 IP 在一个时间段的平均吞吐
思路：
- 服务：`averageValues`
- 对象：`IPAddress`
- 指标：`TPIO`
- 时间：`start/end` 

### 5.2 查某 BusinessGroup 最近一段时间吞吐趋势
思路：
- 服务：`timeValues`
- 对象：`BusinessGroup`
- 指标：`TPIO`
- 时间：`start/end`
- 颗粒度：`granularity=60` 或运行时选择 

### 5.3 查昨天 239web 的 HTTP500 top5 客户端 IP
思路：
- 服务：`topValues`
- group chain：`WebApplication -> ClientIPs -> IPAddress`
- metric：`PGHTTP500`
- topMetric：`PGHTTP500`
- topCount：`5` :contentReference[oaicite:88]{index=88}

### 5.4 查某客户端 IP 在该 WebApplication 下的 HTTP500 均值/总量
思路：
- 从上一个路径继续
- 改服务为 `averageValues`
- 补最深层 `groupArgument` 锁定 IP
- 去掉 `topMetric/topCount` :contentReference[oaicite:89]{index=89}

---

## 6. explanation / metadata / execution 使用建议

### explanation
适合回答：
- groupType / groupArgument 是什么
- topMetric 和 metrics 有什么区别
- granularity 是什么

### metadata resolution
构造前建议查：
- `groups`
- `groupArguments`
- `metrics`
- `metricsForGroup`
以避免：
- 选错 group path
- 选错对象类型
- 选了该层不支持的指标 :contentReference[oaicite:90]{index=90}

### execution
执行层要输出的是结构化 resolvedQuery，而不是仅靠自然语言隐式推断。最终必须明确：
- service
- time range
- metrics
- group chain
- extra args（topCount / topMetric / granularity）