# Metric Definitions

## 目录
1. 指标分类
2. 常用指标说明
3. 页面性能指标
4. 网络性能指标
5. 利用率与流量类指标
6. 指标解释注意事项
7. explanation / metadata / execution 使用建议

---

## 1. 指标分类

NAPM 指标可分为以下几类：

- 应用性能指标（Application Performance Metrics）
- 网络性能指标（Network Performance Metrics）
- 利用率指标（Utilization Metrics）
- 页面性能指标（Page Performance Metrics） :contentReference[oaicite:0]{index=0}

解释型问题优先基于本文件回答；查询型问题在解析 metric code 时，应结合运行时 `metrics` 元数据服务进一步确认。`metrics` 服务可返回设备支持的指标列表与代码。:contentReference[oaicite:1]{index=1}

若问题是“某个对象维度 / groupPath 该优先使用哪些指标”，不要只看本文件；应转到 `metric-dimension-ownership.md`，并在执行前结合 `metricsForGroup` 做最终校验。

---

## 2. 常用指标说明

### 2.1 用户体验时间（User Response Time）

- 含义：估算客户端完成一次 TCP Turn 的平均时间。
- 组成：连接建立时间 + 服务器响应时间 + 净荷传输时间 + 重传时延。:contentReference[oaicite:2]{index=2}
- 适合解释为：用户侧感受到的平均响应耗时。
- 不要解释为：完整应用层真实端到端页面时间。

### 2.2 服务器响应时间（Server Response Time）

- 含义：服务器对一次数据请求做出响应所花的平均时间。
- 单次 turn 的计算口径：从初始客户端请求结束，到初始服务器响应开始。:contentReference[oaicite:3]{index=3}
- 适合解释为：服务端处理与返回首个有效响应的速度。

### 2.3 初始应用响应时间（Initial Application Response Time）

- 含义：TCP Server 对应用层请求开始响应所需的平均时间。
- 适合解释为：更贴近服务端应用处理延迟的指标。:contentReference[oaicite:4]{index=4}

### 2.4 连接建立时间（Connection Setup Time）

- 含义：完成 TCP 三次握手所需平均时间。
- 单次连接口径：从第一个 SYN 到客户端 ACK。:contentReference[oaicite:5]{index=5}
- 常见 code：`CSTI` / `CSTO`。:contentReference[oaicite:6]{index=6}

### 2.5 连接时长（Connection Duration）

- 含义：TCP 连接从建立到终止的平均持续时间。:contentReference[oaicite:7]{index=7}

### 2.6 数据传输时间（Data Transfer Time）

- 含义：完成数据传输所需平均时间。
- 适合解释为：响应数据真正传送完所花的时间。:contentReference[oaicite:8]{index=8}

### 2.7 第一字节时间（Time To First Byte）

- 含义：TCP Server 发出首个数据字节所需平均时间。:contentReference[oaicite:9]{index=9}
- 常见 code：`T2FBO` / `T2FBI`。:contentReference[oaicite:10]{index=10}

---

## 3. 页面性能指标

### 3.1 慢页面率 / 慢页面百分比

NAPM 页面性能指标中同时存在：
- 慢页面率（Slow Page Rate）
- 慢页面百分比（% Slow Pages）
- 慢页面数量（Slow Pages） 

解释时应区分：
- **慢页面率**：单位时间内慢页面出现的速率
- **慢页面百分比**：慢页面占总页面访问的比例
- **慢页面数量**：慢页面总次数

### 3.2 页面访问数 / 页面访问率

- 页面访问数：页面被访问的次数
- 页面访问率：单位时间内页面访问速率 

### 3.3 页面延时 / 页面时间

- 页面时间（Page Time）：从一个页面视图中第一个到最后一个 HTTP 响应的平均时间。:contentReference[oaicite:13]{index=13}
- 常见 code：
  - `PGTME`：页面延时
  - `PGTMS`：页面延时（客户端）
  - `PGTMC`：页面延时（服务器） :contentReference[oaicite:14]{index=14}

### 3.4 HTTP 状态码指标

NAPM 支持：
- HTTP 100 / 200 / 300 / 400 / 500 数量
- 对应百分比 `% HTTP 100/200/300/400/500` 

解释建议：
- 数量：该状态码返回总数
- 百分比：该状态码在全部 HTTP 响应中的占比

---

## 4. 网络性能指标

### 4.1 丢包情况（Packet Loss）

- 含义：TCP 包重传占观测包的百分比，高值通常表示网络丢包或严重传输问题。:contentReference[oaicite:16]{index=16}
- 常见 code：`PLI`、`PLO`。:contentReference[oaicite:17]{index=17}

### 4.2 包重传率 / 重传率 / 重传时延

- 包重传率：每秒重传 TCP 包数量
- 重传率：每秒重传数据量
- 重传时延：每个 TCP Turn 因重传带来的平均时延 

### 4.3 往返时间（Round Trip Time）

- 含义：设备与 TCP Client 之间的平均 RTT。:contentReference[oaicite:19]{index=19}
- 常见 code：
  - `RTTI`：往返时间（流入）
  - `RTTO`：往返时间（流出）
  - `TRTT`：Traceroute 往返时间
  - `TRTT1`：通过 ISP 网络的往返时间
  - `TRTT2`：ISP 对等点往返时间 :contentReference[oaicite:20]{index=20}

---

## 5. 利用率与流量类指标

### 5.1 吞吐量（Throughput）

- 含义：平均数据传输速率。:contentReference[oaicite:21]{index=21}
- 常见 code：
  - `TPI`：吞吐量（流入）
  - `TPO`：吞吐量（流出）
  - `TPIO`：吞吐量（流入和流出） :contentReference[oaicite:22]{index=22}

### 5.2 流量（Traffic）

- 含义：原始数据总传输量。:contentReference[oaicite:23]{index=23}
- 常见 code：
  - `BYTI`
  - `BYTO`
  - `BYTIO` :contentReference[oaicite:24]{index=24}

### 5.3 有效吞吐（Goodput）

- 含义：仅统计有效 TCP 负载的数据传输速率，不含重传与无数据包。:contentReference[oaicite:25]{index=25}
- 常见 code：
  - `GPI`
  - `GPO` :contentReference[oaicite:26]{index=26}

### 5.4 包吞吐量 / 包流量 / 包大小

- 包吞吐量：每秒传输包数
- 包流量：总包数
- 包大小：平均每包字节数 

---

## 6. 指标解释注意事项

### 6.1 Client / Server 与 TCP Client / TCP Server 不是一回事

NAPM 将：
- TCP Connection 指标标为 `TCP Client` / `TCP Server`
- TCP Turn 指标标为 `Client` / `Server` :contentReference[oaicite:28]{index=28}

解释时不要混淆。

### 6.2 Inbound / Outbound 的含义与 group 有关

对于利用率指标，Inbound / Outbound 表示相对 group 的流向；对某些 group（如 Application、Total Traffic、VLAN、Mon Interface Group），方向依赖 Internal Address List。:contentReference[oaicite:29]{index=29}

### 6.3 同名指标可能有总量、速率、百分比三种形式

例如慢页面、HTTP 状态码、流量、吞吐等，解释时先确认用户问的是数量、比例还是速率。

---

## 7. explanation / metadata / execution 使用建议

### explanation
优先用于回答：
- 指标是什么
- 指标间有什么区别
- 某个结果怎么解释

### metadata resolution
需要进一步确认：
- 当前设备是否支持该指标
- 某个指标是否适用于某个 group
- 指标 code 与 label 的精确匹配

可通过 `metrics` 与 `metricsForGroup` 服务确认。:contentReference[oaicite:31]{index=31}

### execution
执行层需要使用 metric code，而不是中文名。常用 code 可从 `metrics` 服务或静态参数表获取。
