# Service Modes

## 目录
1. 核心查询服务
2. 元数据服务
3. 如何选择服务
4. 复合分析链路
5. 解释与执行边界
6. 使用建议

---

## 1. 核心查询服务

NAPM Web Services 的核心执行服务主要包括：

- `topValues`
- `averageValues`
- `timeValues`

这些 service 是执行模式，不是最上层用户意图本身。

### 1.1 topValues

用于返回某个 group drill-down 下的 Top 排行。常见参数包括：

- `start`
- `end`
- `metrics`
- `topMetric`
- `topCount`
- `numGroups`
- `groupTypei`
- `groupArgumenti`

适合回答：

- 前十 / top5 / 排行 / 谁最高 / 谁最多
- 哪个对象最突出
- 哪些对象最慢 / 报错最多 / 丢包最高

例如：

- 今天吞吐量前十的 IP
- 昨天 239web 的 HTTP500 top5 客户端 IP
- 丢包率最高的地址是谁

### 1.2 averageValues

用于返回某个 group drill-down 下指定指标在时间区间内的平均值或区间统计值。常见参数包括：

- `start`
- `end`
- `metrics`
- `numGroups`
- `groupTypei`
- `groupArgumenti`

适合回答：

- 平均值 / 均值 / 整体值
- 某个已知对象在某段时间内的平均表现
- 已明确对象的单点查询

例如：

- 101.254.114.238 的服务器响应时间是多少
- 回溯238web 近 24 小时平均访问量是多少

### 1.3 timeValues

用于返回某个 group drill-down 下指定指标的时间序列。常见参数包括：

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

例如：

- 最近 24 小时丢包率趋势
- 回溯238web 最近 7 天访问量走势

---

## 2. 元数据服务

常用元数据服务包括：

- `groups`
- `metrics`
- `groupArguments`
- `metricsForGroup`
- `applications`
- `businessGroups`
- `interfaces`
- `users`
- `pages`
- `vlans`

这类服务不是最终业务结果，但对解释、消歧、校验和构造执行查询很重要。

---

## 3. 如何选择服务

### 3.1 选择 topValues 的典型场景

当用户目标是比较多个对象并找出最突出对象时，优先考虑 `topValues`：

- 前十
- topN
- 排名
- 最多
- 最高
- 最慢
- 错误最多

补充规则：

- 如果问法是单数选择，例如“是谁”“哪个”“最高的是谁”，通常优先 `topCount=1`。
- `topMetric` 必须和排序语义一致，不能为了“默认排行”偷偷改成别的指标。

### 3.2 选择 averageValues 的典型场景

当用户目标是看某个已知对象在一个时间区间内的平均表现时，优先考虑 `averageValues`：

- 平均吞吐
- 平均响应时间
- 某个业务组昨天的均值

补充规则：

- `averageValues` 更适合“对象已知”的情况。
- 不要把“先找一个对象，再分析它”压成单条 `averageValues`。

### 3.3 选择 timeValues 的典型场景

当用户目标是看对象随时间变化时，优先考虑 `timeValues`：

- 最近 1 小时趋势
- 最近 7 天走势
- 今天每分钟波动

补充规则：

- `timeValues` 用来回答趋势，不负责替代“先发现对象”的那一步。
- 如果用户先问“哪个波动最大”，这一步仍应先做发现，再决定是否补趋势。

### 3.4 选择 overview 的典型场景

当用户目标不是单点数值，而是希望对对象做综合分析、深度分析、整体判断时，优先考虑 `overview`：

- HIS 今天很卡，帮我看一下
- 239web 最近异常吗
- 对这个地址做综合分析
- 对报错最多的业务做深度分析

补充规则：

- 对象明确时，直接做 focused `overview`。
- 对象不明确但用户先要“找出最突出对象”时，应先发现对象，再做 focused `overview`。

---

## 4. 复合分析链路

### 4.1 什么叫复合分析

下面这类问法不是单一步查询，而是两段式链路：

- 先找最…的对象，再分析它
- 找到失败最多的地址，然后综合分析
- 连接失败数最多的是谁，对它做深度分析
- 报错最多的业务是哪个，继续分析这个业务

这类问法的本质是：

1. 先做对象发现
2. 再做对象锁定后的综合分析

### 4.2 推荐执行形态

推荐把这类问题构造成：

- 外层 `service=overview`
- 在 `analysisPipeline.discoveryQuery` 中放发现步骤

发现步骤常见形态：

- 用 `topValues` 找出“最高/最多/最慢/最差”的对象
- 发现结果锁定为 `selectedObject`
- 再转成 focused `overview`

### 4.3 discoveryQuery 的选择依据

优先规则如下：

- 问“谁 / 哪个 / 最高 / 最多 / 最差”时，优先 `topValues`
- 问“哪个对象最近波动最大，再分析它”时，可以先用趋势相关发现，但最终仍要锁对象
- 问“这个对象最近怎么样”且对象已给定时，不需要 discovery，直接 focused `overview`

### 4.4 discovery metric 必须和选择语义一致

发现步骤的 metric 必须和用户要选的“最…”一致：

- 丢包最高 -> `PLI` 或 `PLO`
- 连接失败最多 -> `RFCI`
- HTTP 400/500 报错最多 -> 对应 HTTP 错误指标
- 吞吐最高 -> `TPIO`
- 页面访问最多 -> `PGNPGE`

不要出现：

- 用户问丢包最高，却按吞吐排序
- 用户问失败最多，却按总流量排序
- 用户问报错最多，却按访问量排序

### 4.5 时间范围处理

复合分析中，发现步骤和后续 focused overview 默认应共用同一时间范围。

只有在以下情况才应改时间：

- 用户明确改变时间范围
- 运行时明确要求补齐缺省时间

### 4.6 如果对象已经明确

如果用户已经明确给出对象，就不要再做 discovery：

- 分析 101.254.114.237
- 看一下回溯238web 的整体情况
- 对 HIS系统1 做综合分析

这时应直接进入 focused `overview`。

### 4.7 如果 discovery 没找到对象

如果发现步骤没有锁定明确对象，不要伪造分析结果。

应返回：

- 已按什么指标尝试发现对象
- 当前时间范围
- 没有锁定到可分析对象
- 建议缩小时间范围或直接指定对象

---

## 5. 解释与执行边界

### 5.1 不要把所有问题都先映射到 service

尽管执行层最终要落到 `topValues / averageValues / timeValues`，但这些 service 只是执行模式，不是最上层用户意图本身。

当前直连运行时应先区分是：

- explanation
- metadata inventory
- overview
- result interpretation
- 或已经收敛为可执行查询

只有进入执行阶段后，才选择具体 service。

### 5.2 explanation 不等于 service 选择

例如：

- 什么是慢页面率
- WebApplication 和 BusinessGroup 区别
- topValues 和 averageValues 有什么区别

这类应先进入 explanation，而不是直接执行查询。

### 5.3 analysis entry 不一定马上选 service

例如：

- HIS 今天很卡
- 最近为什么慢
- 239web 最近异常吗

这类应先做概览、补充元数据确认或结果判读，再决定是否进入 `topValues / averageValues / timeValues`。

### 5.4 result interpretation 也不是 service 选择

例如：

- 为什么它这么高
- 这个结果怎么理解

这类应优先进入结果解释流程。

---

## 6. 使用建议

### explanation

适合回答：

- topValues、averageValues、timeValues 分别是什么
- 三者有什么区别
- 某类问题通常会走哪种服务

### metadata resolution

当需要确认：

- 某个 group 是否存在
- 某个 group 能否使用某指标
- 某对象是否需要 `groupArgument`

应优先查元数据服务，而不是直接猜。

### execution

仅当问题已经被收敛为可执行查询，并补齐必要参数后，才真正落到：

- `topValues`
- `averageValues`
- `timeValues`
- `overview`

并补齐所有参数。
