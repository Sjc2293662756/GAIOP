# Metric Dimension Ownership

## 1. 目标

本文件用于回答两类问题：

- 某个对象维度默认应优先使用哪些指标
- Plain `业务都可以查哪些指标`、`业务组都可以查哪些指标` 这类问法应该落到哪个对象口径

它只负责静态归属与候选选择，不替代运行时 `metricsForGroup` 校验。

## 2. 顶层归属硬规则

### 2.1 业务类对象

以下对象统一按业务类指标口径处理：

```text
WebApplication
PageFamily
User
ClientBusinessGroup
```

允许的指标分类：

```text
业务网络、业务访问、业务性能、响应代码
```

对外默认可展示的代表指标：

```text
PGBYTI PGBYTO PGSIZEI PGSIZEO
PGNPGE PGNPGC PGNPGS PGRT
PGNSLPGE PGNSLPGC PGNSLPGS
PGSLPCT PGSLPCTC PGSLPCTS
PGSLRT PGSLRTC PGSLRTS
PGTME PGTMC PGTMS
PGNOBJE
PGHTTP100 PGHTTP200 PGHTTP300 PGHTTP400 PGHTTP500
PGHTTP100PCT PGHTTP200PCT PGHTTP300PCT PGHTTP400PCT PGHTTP500PCT
POPT ROPT PNOPT PPOPT PFOPT
```

默认禁止把以下指标作为业务对象指标清单返回：

```text
TPIO BYTIO TPI TPO
PLI PLO RTTI RTTO RDTI RDTO RTXI RTXO
CONI CONO CCNI CCNO RFCI RFCO
UEII UEIO
TRTI TRTO
```

### 2.2 非业务类对象

以下对象统一按非业务类指标口径处理：

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

允许的指标分类：

```text
数据包、网络流量、传输效率、网络性能、网络连接、应用访问、应用性能、用户体验、安全分析
```

## 3. Plain 问法落点

- Plain `业务` / `业务系统` / `Web应用` 默认落到 `WebApplication`
- Plain `业务都可以查哪些指标` 必须按业务类对象口径回答
- `业务组` / `工作组` / `BusinessGroup` 才允许默认回答吞吐、丢包、RTT、重传、连接、应用性能、用户体验等网络口径指标
- `ClientBusinessGroup` 在当前项目中按业务类对象处理，不走旧的客户端网络指标口径

## 4. 常见对象默认候选

### 4.1 `WebApplication` / `PageFamily` / `User` / `ClientBusinessGroup`

- 主候选：`PG*` 页面指标与页面优化指标
- 回答指标清单时：只列业务网络、业务访问、业务性能、响应代码、页面优化
- 不要列：丢包、RTT、重传、吞吐、连接、用户体验、应用性能

### 4.2 `BusinessGroup` / `IPAddress` / `IPConversation` / `TotalTraffic` / `Prefix24`

- 主候选：`TPIO`、`BYTIO`、`PKIO`、`PLI`、`RTTI`、`CONI`、`CCNI`、`RFCI`
- 可补：`TRTI`、`UEII`、`CSTI`
- 不要把 `PG*` 当默认主指标

### 4.3 `DefinedApp` / `OtherApp`

- 主候选：流量、连接、应用访问、应用性能、用户体验
- 非页面场景下不要把 `PG*` 和页面优化指标当默认主指标

### 4.4 `Interface` / `MonInterfaceGroup` / `VLAN`

- 主候选：流量、包、丢包、重传、传输效率
- 不要把 `PG*`、页面优化、用户体验当默认主指标

### 4.5 `ISPAS` / `DestAS`

- 主候选：流量、RTT、Traceroute、丢包
- 不要把 `PG*`、页面优化当默认主指标

## 5. 执行前最终校验

固定流程：

1. 先确定对象维度
2. 再按本文件选静态候选指标
3. 再用 `NapmMetadataService.getMetricsForGroupPath()` 或 `metricsForGroup` 求交集
4. 只执行交集结果

如果交集为空：

- 同一指标族内回退
- 仍为空再澄清
- 不要把业务对象直接回退成非业务指标清单
