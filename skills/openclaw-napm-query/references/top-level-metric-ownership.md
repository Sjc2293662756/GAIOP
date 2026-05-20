# 顶层对象与指标分类对应关系

本文档严格对齐 `napm顶层所对应的指标.md`，只用于回答“顶层对象默认归属哪些指标分类”这类问题。

## 业务类对象

以下对象统一使用这些指标分类：

```text
业务网络、业务访问、业务性能、响应代码
```

对象范围：

```text
WebApplication
PageFamily
User
ClientBusinessGroup
```

## 非业务类对象

以下对象统一使用这些指标分类：

```text
数据包、网络流量、传输效率、网络性能、网络连接、应用访问、应用性能、用户体验、安全分析
```

对象范围：

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

## 关键约束

- Plain `业务` / `业务系统` / `Web应用` 默认按 `WebApplication` 口径回答。
- Plain `业务都可以查哪些指标` 不能外扩到 `BusinessGroup` / `IPAddress` / `IPConversation` 的网络指标口径。
- `业务组` / `工作组` / `BusinessGroup` 才允许默认回答丢包、RTT、重传、吞吐、连接等非业务类指标。
- 运行时若要真正执行查询，仍需再经过 `metricsForGroup` 或 `NapmMetadataService.getMetricsForGroupPath()` 做最终校验。
