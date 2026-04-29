# Service Modes

## 目录
1. 核心查询服务
2. 元数据服务
3. 如何选择服务
4. 解释与执行边界
5. explanation / metadata / execution 使用建议

---

## 1. 核心查询服务

NAPM Web Services 的核心查询服务主要包括：

- `averageValues`
- `timeValues`
- `topValues` 

### 1.1 topValues
用于返回某个 group drill-down 下的 Top 值排行。常见参数包括：
- `start`
- `end`
- `metrics`
- `topMetric`
- `topCount`
- `numGroups`
- `groupTypei`
- `groupArgumenti` 

适合回答：
- 前十 / top5 / 排行 / 最高 / 最多
- 某维度下谁最突出

例如：
- 今天吞吐量前十的 IP
- 昨天 239web 的 HTTP500 top5 客户端 IP :contentReference[oaicite:59]{index=59}

### 1.2 averageValues
用于返回某个 group drill-down 下指定指标在时间区间内的平均值。常见参数包括：
- `start`
- `end`
- `metrics`
- `numGroups`
- `groupTypei`
- `groupArgumenti` 

适合回答：
- 均值 / 平均 / 汇总值
- 指定对象在某段时间内的平均响应时间、平均吞吐等

### 1.3 timeValues
用于返回某个 group drill-down 下指定指标的时间序列值。常见参数包括：
- `start`
- `end`
- `metrics`
- `granularity`
- `numGroups`
- `groupTypei`
- `groupArgumenti` 

适合回答：
- 趋势
- 曲线
- 最近一段时间怎么变化
- 历史走势

---

## 2. 元数据服务

常用元数据服务包括：

- `groups`：返回 group drill-down 列表
- `metrics`：返回设备支持的指标列表
- `groupArguments`：返回指定分组的参数候选
- `metricsForGroup`：返回某个 group drill-down 可用指标
- `applications`
- `businessGroups`
- `interfaces`
- `users`
- `pages`
- `vlans` 

这类服务不是最终业务查询结果，但对解释、消歧和执行构造很重要。

---

## 3. 如何选择服务

### 3.1 选择 topValues 的典型场景
当用户目标是比较多个对象并找出最突出对象时，优先考虑 `topValues`：
- 前十
- topN
- 排名
- 最多
- 最高
- 哪些最慢 / 哪些 500 最多

### 3.2 选择 averageValues 的典型场景
当用户目标是看某个对象在一个时间区间内的平均表现时，优先考虑 `averageValues`：
- 平均吞吐
- 平均响应时间
- 某业务组昨天的均值

### 3.3 选择 timeValues 的典型场景
当用户目标是看对象随时间变化时，优先考虑 `timeValues`：
- 最近 1 小时趋势
- 最近 7 天走势
- 今天每分钟波动

---

## 4. 解释与执行边界

### 4.1 不要把所有问题都先映射到 service
尽管执行层最终要落到 `topValues / averageValues / timeValues`，但 skill 总入口不应先按 service 三分类。你们当前 skill 已改为 decision-first，这些 service 属于后置执行层。

### 4.2 explanation 不等于 service 选择
例如：
- 什么是慢页面率
- WebApplication 和 BusinessGroup 区别
- topValues 和 averageValues 有什么区别  
这类应先进入 explanation，而不是直接执行查询。:contentReference[oaicite:64]{index=64}

### 4.3 analysis entry 不一定马上选 service
例如：
- HIS 今天很卡
- 最近为什么慢
- 239web 最近异常吗  
这类应先做概览或判定，再决定是否进入 `topValues / averageValues / timeValues`。

### 4.4 result interpretation 也不是 service 选择
例如：
- 为什么它这么高
- 这个结果怎么理解  
这类应优先进入结果解释流程。

---

## 5. explanation / metadata / execution 使用建议

### explanation
适合回答：
- topValues、averageValues、timeValues 分别是什么
- 三者有什么区别
- 某类问题通常会走哪种服务

### metadata resolution
当需要确认：
- 某 group 是否存在
- 某 group 能否使用某指标
- 某对象是否需要 groupArgument  
应优先查元数据服务，而不是直接猜。:contentReference[oaicite:67]{index=67}

### execution
仅当 next_action 为查询相关时，才真正落到：
- `topValues`
- `averageValues`
- `timeValues`
并补齐所有参数。:contentReference[oaicite:68]{index=68}