# Metric Category Mapping

## 1. 文档目的

本文件专门补齐项目内原先缺少的这层信息：

```text
指标分类 -> 细分指标族 -> 具体 metric code
```

它用于回答这类问题：

- `业务访问类有哪些指标`
- `网络连接类下面有哪些 metric code`
- `页面优化类属于哪些指标`
- `某个指标分类对应的编码在项目 md 里有没有明确列出来`

本文件是静态参考表，不单独决定某个对象是否允许使用某类指标。

最终仍需结合以下文件一起看：

- `references/top-level-metric-ownership.md`：先定顶层对象归属
- `references/metric-dimension-ownership.md`：再定对象维度下的默认候选
- `NapmMetadataService.getMetricsForGroupPath()` / `metricsForGroup`：最后做现网可执行校验

---

## 2. 使用规则

### 2.1 先分清“对象”和“指标分类”

- `WebApplication`、`BusinessGroup`、`DefinedApp`、`IPAddress` 是对象维度
- `业务访问`、`网络流量`、`网络连接`、`应用性能` 是语义指标分类

指标分类不能直接当 `groupType` 使用。

错误示例：

```text
groupType1=网络流量
groupType2=应用性能
```

正确思路：

```text
先确定 groupType
再从本文件选 metric code
最后做 metricsForGroup 校验
```

### 2.2 本文件只回答“分类下有哪些编码”

例如：

- `业务访问` 对应 `PGNPGE / PGNPGC / PGNPGS / PGRT`
- `网络连接` 对应 `CON* / CCN* / RFC* / CD* / CRT* / FIL* / RFR*`

但这不等于所有对象都能直接使用这些指标。

### 2.3 项目内强制对齐说明

- Plain `业务` / `业务系统` / `Web应用` 默认按 `WebApplication` 口径处理
- Plain `业务都可以查哪些指标` 只允许落到本文件第 3 节的业务侧指标
- `业务组` / `工作组` / `BusinessGroup` 才允许默认落到本文件第 4 节的非业务类指标
- `ClientBusinessGroup` 在当前项目里按业务类对象处理；不要直接沿用外部原始材料中的客户端网络口径
- `页面优化` 虽然是业务侧扩展指标族，但项目允许在业务类对象的指标清单中一起返回
- `安全分析` 更偏场景分类，不是一组独立专属 metric code；通常复用网络流量、网络性能、网络连接、Traceroute、Reset 等指标族
- `告警数据` 不在当前 `metrics` 树里，需走 `alertsSummary` 等告警服务

---

## 3. 业务类指标分类与 metric code

项目内默认归属到业务类对象的范围：

```text
WebApplication
PageFamily
User
ClientBusinessGroup
```

### 3.1 业务网络

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 业务网络 | 业务网络使用 | `PGBYTI PGBYTO PGSIZEI PGSIZEO` | 请求流量、页面流量、请求大小、页面大小 |

### 3.2 业务访问

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 业务访问 | 页面访问 | `PGNPGE PGNPGC PGNPGS PGRT` | 页面访问数、服务器侧访问数、客户端侧访问数、页面访问率 |

### 3.3 业务性能

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 业务性能 | 慢页面数量 | `PGNSLPGE PGNSLPGC PGNSLPGS` | 慢页面数量总量、服务器侧、客户端侧 |
| 业务性能 | 慢页面百分比 | `PGSLPCT PGSLPCTC PGSLPCTS` | 慢页面占比总量、服务器侧、客户端侧 |
| 业务性能 | 慢页面率 | `PGSLRT PGSLRTC PGSLRTS` | 慢页面发生率总量、服务器侧、客户端侧 |
| 业务性能 | 页面延时 | `PGTME PGTMC PGTMS` | 页面延时总量、服务器侧、客户端侧 |

### 3.4 响应代码

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 响应代码 | HTTP 响应总量 | `PGNOBJE` | HTTP 响应总数 |
| 响应代码 | HTTP 状态码数量 | `PGHTTP100 PGHTTP200 PGHTTP300 PGHTTP400 PGHTTP500` | 100/200/300/400/500 状态码数量 |
| 响应代码 | HTTP 状态码占比 | `PGHTTP100PCT PGHTTP200PCT PGHTTP300PCT PGHTTP400PCT PGHTTP500PCT` | 100/200/300/400/500 状态码百分比 |

### 3.5 页面优化

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 页面优化 | 页面优化状态 | `POPT ROPT PNOPT PPOPT PFOPT` | 优化页面占比、优化响应占比、未优化占比、部分优化占比、完全优化占比 |

说明：

```text
页面优化是业务侧扩展指标族。
在本项目里，业务类对象的指标清单允许带上这组指标。
```

---

## 4. 非业务类指标分类与 metric code

项目内默认归属到非业务类对象的范围：

```text
TotalTraffic
IPAddress
Prefix24
ISPAS
DestAS
BusinessGroup
BusinessGroupLink
IPConversation
DefinedApp
OtherApp
VLAN
Interface
MonInterfaceGroup
```

### 4.1 网络流量

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 网络流量 | 吞吐量 | `TPIO TPI TPO` | 速率型指标，适合吞吐量、带宽、趋势、TopN |
| 网络流量 | 流量大小 | `BYTIO BYTI BYTO` | 数据量型指标，适合累计流量、传输大小、字节数 |

### 4.2 数据包

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 数据包 | 数据包数量 | `PKIO PKI PKO` | 包总量、入向包量、出向包量 |
| 数据包 | 包吞吐量 | `PKTIO PKTI PKTO` | 包速率总量、入向包速率、出向包速率 |
| 数据包 | 数据包大小 | `PKZI PKZO` | 入向包大小、出向包大小 |

### 4.3 传输效率

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 传输效率 | 有效吞吐 | `GPI GPO` | 入向有效吞吐、出向有效吞吐 |
| 传输效率 | 利用率 | `UTI UTO` | 入向利用率、出向利用率 |
| 传输效率 | 净荷 | `FSO_B FSI_B FSO_P FSI_P` | 服务器/客户端净荷数据量与净荷包数量 |

### 4.4 网络性能

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 网络性能 | 往返时间 | `RTTI RTTO` | 入向 RTT、出向 RTT |
| 网络性能 | 丢包 | `PLI PLO` | 入向丢包、出向丢包 |
| 网络性能 | 重传 | `RDTI RDTO RTXI RTXO RPKI RPKO` | 重传时延、重传率、包重传率 |
| 网络性能 | Traceroute | `TRTT TRTT1 TRTT2` | 路由往返时间、ISP 网络 RTT、ISP 对等点 RTT |

说明：

```text
Traceroute 指标更适合 ISPAS、DestAS、TotalTraffic、IPAddress、BusinessGroup 等路径质量场景。
不要默认把它们列入 WebApplication / PageFamily / User 的指标清单。
```

### 4.5 网络连接

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 网络连接 | 连接请求 | `CONI CONO` | TCP 服务器侧连接请求数、TCP 客户端侧连接请求数 |
| 网络连接 | 连接成功 | `CCNI CCNO` | TCP 服务器侧成功连接数、TCP 客户端侧成功连接数 |
| 网络连接 | 连接失败 | `RFCI RFCO` | TCP 服务器侧失败连接数、TCP 客户端侧失败连接数 |
| 网络连接 | 连接时长 | `CDI CDO` | TCP 服务器侧连接时长、TCP 客户端侧连接时长 |
| 网络连接 | 连接率 | `CRTI CRTO` | TCP 服务器侧连接率、TCP 客户端侧连接率 |
| 网络连接 | 请求率 | `FILI FILO` | TCP 服务器侧连接请求率、TCP 客户端侧连接请求率 |
| 网络连接 | 失败率 | `RFRI RFRO` | TCP 服务器侧连接失败率、TCP 客户端侧连接失败率 |

### 4.6 应用访问

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 应用访问 | Reset | `RSTSI RSTSO RSTI RSTO` | 服务器端重置率、客户端重置率的服务器侧/客户端侧视角 |
| 应用访问 | 应用交互 | `TRNI TRNO TRRI TRRO` | 服务器/客户端交互数与交互率 |

### 4.7 应用性能

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 应用性能 | 连接建立时间 | `CSTI CSTO` | TCP 服务器侧、TCP 客户端侧建连耗时 |
| 应用性能 | 服务器响应时间 | `TRTI TRTO` | 服务器侧、客户端侧观察到的服务器响应耗时 |
| 应用性能 | 数据传输时间 | `NRTO NRTI` | 服务器侧、客户端侧数据传输耗时 |
| 应用性能 | 净荷传输时间 | `PTTI PTTO` | 客户端侧、服务器侧净荷传输耗时 |
| 应用性能 | 第一字节时间 | `T2FBO T2FBI` | TCP 服务器侧、TCP 客户端侧首字节时间 |
| 应用性能 | 初始应用响应时间 | `ARTO ARTI` | TCP 服务器侧、TCP 客户端侧初始应用响应时间 |

说明：

```text
DefinedApp、OtherApp、IPAddress、IPConversation、BusinessGroup 更适合默认使用应用性能类指标。
对于业务页面对象，优先仍应使用 PG* 页面体验指标。
```

### 4.8 用户体验

| 指标分类 | 细分指标族 | metric code | 说明 |
| --- | --- | --- | --- |
| 用户体验 | 用户体验时间 | `UEII UEIO` | 服务器侧、客户端侧综合体验耗时 |

### 4.9 安全分析

`安全分析` 在原始材料里更偏“概览场景分类”，不是单独的一棵 metric family。

当前项目里，安全分析通常复用以下指标族：

```text
TPIO TPI TPO
BYTIO BYTI BYTO
PKIO PKI PKO
PLI PLO
RTTI RTTO
CONO CCNO RFCO
TRTT TRTT1 TRTT2
RSTSI RSTSO RSTI RSTO
```

使用原则：

```text
先看对象维度，再从网络流量 / 数据包 / 网络性能 / 网络连接 / 应用访问中选具体指标。
不要把“安全分析”当成一个可直接展开为固定全量 code 的独立分类。
```

---

## 5. 非 metrics 树补充

### 5.1 告警数据

告警数据不在当前项目使用的 `metrics` 树里，通常走：

```text
alertsSummary
```

因此：

- `告警数据` 不应硬塞进本文件第 3 节或第 4 节的 metric code 表
- 如果问题是告警总数、最高告警级别、各概览告警摘要，应转到告警服务口径处理

### 5.2 方向性指标必须保留方向

例如：

```text
总和方向：TPIO BYTIO PKIO PKTIO
入向方向：TPI BYTI PKI PKTI RTTI PLI RDTI RTXI RPKI
出向方向：TPO BYTO PKO PKTO RTTO PLO RDTO RTXO RPKO
```

因此在回答或构造查询时，不能把：

```text
RTTI / RTTO
PLI / PLO
CONI / CONO
TRTI / TRTO
```

混成一个没有方向和视角差异的“同义指标”。

---

## 6. 推荐排查顺序

当用户问“某类指标有哪些”时，推荐固定按以下顺序排查：

1. 先看 `top-level-metric-ownership.md`，确认对象属于业务类还是非业务类
2. 再看本文件，展开“指标分类 -> metric code”
3. 再看 `metric-dimension-ownership.md`，确认该维度是否适合默认使用这组指标
4. 最后通过 `metricsForGroup` / `NapmMetadataService.getMetricsForGroupPath()` 做现网校验

如果四步里任何一步不通过：

- 不要直接对用户输出这组指标
- 不要把业务对象静默外扩成业务组或网络对象
- 不要把指标分类直接当成 API 里的 `groupType`
