# Group Hierarchy

## 目录

1. 顶层对象类型
2. 常见对象定义
3. 常见 drill-down 路径
4. 特殊层级说明
5. explanation / metadata / execution 使用建议

***

## 1. 顶层对象类型

NAPM 常见顶层 group types 包括：

- TotalTraffic（总流量）
- IPAddress（IP 地址）
- Prefix24（子网 /24）
- BusinessGroup（业务组）
- IPConversation（IP 会话）
- ISPAS（ISP 自治域）
- DestAS（目的自治域）
- Applications（应用组）
- VLAN
- Interface
- WebApplication（WEB 应用）
- PageFamily（页面族）
- User（用户）
- MonInterfaceGroup（监控接口组）

`groups` 服务可用于查看完整 group drill-down 列表。:contentReference\[oaicite:34]{index=34}

***

## 2. 常见对象定义

### 2.1 TotalTraffic

表示设备监控到的所有流量。它是最通用的顶层聚合对象。

### 2.2 IPAddress

表示单个 IP 地址的全部进出流量，也可代指客户端。它既可以作为顶层对象，也常作为更深层 drill-down 的具体实体。

### 2.3 Prefix24

表示一个 /24 网段内所有 IP 的聚合流量。

### 2.4 BusinessGroup

业务组常表示为：工作组，或者一类地址的集合；等。:contentReference\[oaicite:38]{index=38}
它常见下钻包括：

- 成员 IP
- 连接的 IP
- 局域网流量
- 应用组
- IP 会话组
- 连接组 :contentReference\[oaicite:39]{index=39}

### 2.5 WebApplication

表示 WEB 应用维度，常用来表示：业务 、业务系统；
常见关联维度包括：

- 服务器 IP
- 客户端 IP
- 用户
- 页面族
- 初始组
- 初始 IP :contentReference\[oaicite:40]{index=40}

### 2.6 PageFamily

表示页面族，常见下钻包括：

- 服务器 IP
- 客户端 IP
- 用户
- 初始 IP
- 初始组 :contentReference\[oaicite:41]{index=41}

### 2.7 User

表示用户维度，在页面性能场景中常见下钻为 PageFamily。:contentReference\[oaicite:42]{index=42}

### 2.8 IPConversation

表示两个 IP 地址之间的会话流量。注意在 URL 中指定 IPConversation 时，分隔符应使用 `|` 而不是 `:`。:contentReference\[oaicite:43]{index=43}

***

## 3. 常见 drill-down 路径

### 3.1 BusinessGroup 常见路径

- BusinessGroup -> MemberIPs -> IPAddress -> ConnectedIP
- BusinessGroup -> ConnectedIPs -> IPAddress -> ConnectedIP
- BusinessGroup -> Applications -> DefinedApp
- BusinessGroup -> Applications -> OtherApp
- BusinessGroup -> IPConversations -> IPConversation :contentReference\[oaicite:44]{index=44}

### 3.2 WebApplication 常见路径

- WebApplication -> 服务器IP
- WebApplication -> 客户端IP
- WebApplication -> 用户
- WebApplication -> PageFamily
- WebApplication -> 初始组
- WebApplication -> 初始IP :contentReference\[oaicite:45]{index=45}

在工程化查询中，常见实例路径会继续具体化，例如：

- WebApplication -> ClientIPs -> IPAddress\
  用于查某个 Web 应用下客户端 IP 维度的排名或明细。该路径也出现在你们的构造案例中。:contentReference\[oaicite:46]{index=46}

### 3.3 IPAddress 常见路径

- IPAddress -> ConnectedIPs -> ConnectedIP
- IPAddress -> Applications -> Application
- IPAddress -> ConnectedGroups -> BusinessGroup
- IPAddress -> OtherApps -> OtherApp

### 3.4 Prefix24 常见路径

- Prefix24 -> MemberIPs -> IPAddress
- Prefix24 -> ConnectedIPs -> ConnectedIP
- Prefix24 -> Applications -> Application
- Prefix24 -> IPConversations -> IPConversation

***

## 4. 特殊层级说明

### 4.1 MemberIPs

表示某个聚合对象内部的成员 IP，例如 BusinessGroup 或 Prefix24 内的成员地址。

### 4.2 ConnectedIPs

表示与当前对象发生通信的对端 IP。

### 4.3 ClientIPs / ServerIPs

在 WebApplication / PageFamily 等页面分析场景中，ClientIPs 常表示请求页面的客户端 IP，ServerIPs 表示服务端或页面来源端。`api查询` 和构造手册里的 Web 应用案例明确使用了 ClientIPs 作为中间层。

### 4.4 Applications / DefinedApp / OtherApp

Applications 是应用集合层；DefinedApp 表示已定义应用；OtherApp 表示未定义或其它应用。

### 4.5 IPConversations

表示 IP 会话组，用于下钻到具体 IPConversation。

### 4.6 LinkMembers / ConnectedGroups

与业务组连接关系相关，用于分析组间通信。

***

## 5. explanation / metadata / execution 使用建议

### explanation

适合回答：

- BusinessGroup 和 WebApplication 区别是什么
- ClientIPs 是什么层级
- ConnectedIPs / MemberIPs 分别表示什么

### metadata resolution

应优先通过：

- `groups`
- `groupArguments`
- `metricsForGroup`
  确认：
- 当前 group 是否存在
- 是否需要 argument
- 该层是否支持目标 metric :contentReference\[oaicite:55]{index=55}

若问题已经变成“这个路径下默认该选哪类指标”，需要再结合 `metric-dimension-ownership.md`，不要只根据层级结构硬猜 metric。

### execution

执行时最终必须落到：

- `numGroups`
- `groupType1..n`
- `groupArgument1..n`
  的链式表达，而不是仅保留自然语言对象层级描述。
