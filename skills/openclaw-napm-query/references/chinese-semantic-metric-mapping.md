# Chinese Semantic → Metric Code Mapping

## 1. 文档目的

当用户使用中文自然语言描述查询需求时，LLM 需要将"用户怎么说"精确映射为 NAPM metric code。本文件提供**正向索引**：从中文语义关键词出发，结合对象上下文，直接定位到正确的指标编码。

与项目内其他参考文件的关系：

- `metric-category-mapping.md`：按指标分类组织（分类 → code），适合回答"某分类下有哪些指标"
- `metric-dimension-ownership.md`：按对象维度组织（对象 → 候选指标），适合回答"某对象能查哪些指标"
- **本文件**：按用户中文用语组织（用户怎么说 → 正确 code），适合 LLM 构造 `resolvedQuery` 时查表

最终仍需通过 `metricsForGroup` / `NapmMetadataService.getMetricsForGroupPath()` 做现网可执行校验。

---

## 2. 使用规则

### 2.1 查表优先级

1. 如果用户明确说出具体数字/编码（400、500、4xx、5xx）→ 直接使用对应 code，不需要查表
2. 如果用户使用模糊中文（报错、慢、流量）→ 按本文件对应语义域查表
3. 查表时**必须先确定对象上下文**：同一中文词在不同对象上映射不同

### 2.2 对象上下文判定

```
业务 / 业务系统 / 网站 / web应用 → WebApplication
业务组 / 工作组 / 业务分组 → BusinessGroup
IP / 地址 / 主机 → IPAddress
网段 / 子网 → Prefix24
已定义应用 / 协议应用 → DefinedApp
```

对象判定详见 `references/query-workflow-contract.md` 和 `config/object-ontology.v1.json`。

### 2.3 方向性规则

NAPM 指标有严格的方向区分，不可混用：

```
入向（I）：TPI, BYTI, PKI, PLI, RTTI, RDTI, CONI, CCNI, RFCI, TRTI, UEII
出向（O）：TPO, BYTO, PKO, PLO, RTTO, RDTO, CONO, CCNO, RFCO, TRTO, UEIO
双向合计（IO）：TPIO, BYTIO, PKIO
```

用户未指明方向时：
- 问"总共/整体/全部" → 用 IO 双向合计
- 问"服务器看到的/服务器收到" → 用 I（Inbound，服务器视角）
- 问"客户端发出的/客户端看到" → 用 O（Outbound，客户端视角）
- 无法判断方向 → 默认用 IO，并在回答中说明

---

## 3. 语义域映射表

### 3.1 报错 / 错误 / 异常 / 失败

| 用户问法 | 对象上下文 | ✅ 正确指标 | ❌ 绝对不要用 | 说明 |
|---------|-----------|------------|-------------|------|
| 报错、错误、异常、失败 | WebApplication、PageFamily、业务、网站 | `PGHTTP400`, `PGHTTP500` | `PLI`, `PLO` | 业务层报错 = HTTP 错误码 |
| 报错、错误、异常、失败 | BusinessGroup、IPAddress、Prefix24、业务组、IP、网段 | `RFCI`, `RFCO` | `PLI`, `PLO` | 网络层报错 = TCP 连接失败 |
| 报错、错误、异常、失败 | DefinedApp、OtherApp、已定义应用 | `RFCI`, `PGHTTP400` | `PLI`, `PLO` | 同时关注连接+HTTP |
| 400、4xx、客户端错误 | 任意 | `PGHTTP400` | — | 明确 HTTP 状态码 |
| 500、5xx、服务端错误 | 任意 | `PGHTTP500` | — | 明确 HTTP 状态码 |
| HTTP错误 | WebApplication、业务 | `PGHTTP400`, `PGHTTP500` | — | 明确的 HTTP 层面 |
| 连接失败、TCP失败 | 任意 | `RFCI`, `RFCO` | `PLI` | 明确的连接层面 |
| 失败率 | 任意 | `RFRI`, `RFRO` | — | 连接失败率 |
| 400占比、500占比 | 任意 | `PGHTTP400PCT`, `PGHTTP500PCT` | — | HTTP 状态码百分比 |

**核心规则：绝不用 PLI/PLO（丢包指标）响应"报错"类查询。PLI/PLO 仅在用户明确说"丢包"时使用。**

### 3.2 慢 / 延迟 / 响应时间

| 用户问法 | 对象上下文 | ✅ 正确指标 | ❌ 绝对不要用 | 说明 |
|---------|-----------|------------|-------------|------|
| 慢、响应慢、响应时间 | WebApplication、PageFamily、业务、网站 | `PGTME` | `RTTI` | 页面延时 |
| 慢、响应慢、响应时间 | BusinessGroup、IPAddress、业务组 | `TRTI` | `RTTI` | 服务器响应时间 |
| 服务器响应时间 | 任意（明确说"服务器"） | `TRTI` | `RTTI`, `PGTME` | SKILL.md 明确规则 |
| 页面加载慢、页面打开慢 | WebApplication、PageFamily | `PGTME` | `TRTI`, `RTTI` | 页面延时 |
| 网络延迟、时延、RTT | BusinessGroup、IPAddress、Prefix24 | `RTTI`, `RTTO` | `TRTI`, `PGTME` | 网络层 RTT |
| 首字节慢、首字节时间 | 任意 | `T2FBI`, `T2FBO` | — | 首字节时间 |
| 连接慢、建连慢 | IPAddress、BusinessGroup | `CSTI` | `RTTI`, `TRTI` | TCP 建连耗时 |
| 用户体验慢、综合体验 | DefinedApp、IPAddress、BusinessGroup | `UEII`, `UEIO` | — | 综合体验耗时 |
| 数据传输慢 | 任意 | `NRTO`, `NRTI` | — | 数据传输耗时 |
| 慢页面、慢页面数 | WebApplication、PageFamily | `PGNSLPGE`, `PGSLPCT` | — | 慢页面数量/占比 |
| 卡、卡顿 | WebApplication、业务 | `PGTME` | `RTTI` | 用户感知的页面延时 |
| 延迟、延时 | 无明确上下文 | 需要 clarification | — | 太模糊，必须追问是页面还是网络 |

### 3.3 流量 / 带宽 / 吞吐

| 用户问法 | 对象上下文 | ✅ 正确指标 | 说明 |
|---------|-----------|------------|------|
| 流量、带宽、速率 | 任意 | `TPIO`, `TPI`, `TPO` | 吞吐量，速率型（Kbps），适合"带宽""速率" |
| 流量大小、传输量、数据量 | 任意 | `BYTIO`, `BYTI`, `BYTO` | 数据量型（data），适合"总共传了多少""累计流量" |
| 数据包数量、包量 | 任意 | `PKIO`, `PKI`, `PKO` | 数据包个数 |
| 包速率 | 任意 | `PKTIO`, `PKTI`, `PKTO` | 包速率（pkt/s） |
| 吞吐、吞吐量 | 任意 | `TPIO` | 默认用吞吐量 |
| 有效吞吐 | 任意 | `GPI`, `GPO` | 有效吞吐，区别于总吞吐 |
| 利用率 | Interface、MonInterfaceGroup、VLAN | `UTI`, `UTO` | 接口/链路利用率 |
| 页面流量 | WebApplication | `PGBYTI`, `PGBYTO` | 业务网络使用（请求/页面流量） |
| 请求大小、页面大小 | WebApplication | `PGSIZEI`, `PGSIZEO` | 业务网络使用（请求/页面大小） |

**区分口诀：问速率用 TPIO，问总量用 BYTIO，问包数用 PKIO。**

### 3.4 丢包

| 用户问法 | 对象上下文 | ✅ 正确指标 | 说明 |
|---------|-----------|------------|------|
| 丢包、丢包率、掉包 | 任意 | `PLI`, `PLO` | 入向丢包/出向丢包 |

**注意：PLI/PLO 仅用于丢包场景。不要当作"报错/异常"的泛指指标使用。**

### 3.5 重传

| 用户问法 | 对象上下文 | ✅ 正确指标 | 说明 |
|---------|-----------|------------|------|
| 重传、重传率 | 任意 | `RTXI`, `RTXO` | 重传率（Kbps） |
| 重传时延 | 任意 | `RDTI`, `RDTO` | 重传耗时（ms） |
| 包重传率 | 任意 | `RPKI`, `RPKO` | 包重传率（pkt/s） |

**区分口诀：问重传多少用 RTX，问重传多慢用 RDT，问包重传用 RPK。**

### 3.6 连接

| 用户问法 | 对象上下文 | ✅ 正确指标 | 说明 |
|---------|-----------|------------|------|
| 连接数、连接请求 | 任意 | `CONI`, `CONO` | TCP 连接请求数 |
| 成功连接、并发连接 | 任意 | `CCNI`, `CCNO` | 成功建立的连接数 |
| 连接失败 | 任意 | `RFCI`, `RFCO` | TCP 连接失败数 |
| 连接失败率 | 任意 | `RFRI`, `RFRO` | 连接失败率 |
| 连接时长 | 任意 | `CDI`, `CDO` | TCP 连接持续时间 |
| 连接建立时间 | 任意 | `CSTI`, `CSTO` | TCP 建连耗时 |
| 连接率 | 任意 | `CRTI`, `CRTO` | 连接建立速率 |
| 请求率 | 任意 | `FILI`, `FILO` | 连接请求速率 |

**区分口诀：问多少连接用 CON，问多少成功用 CCN，问多少失败用 RFC，问多快建连用 CST。**

### 3.7 访问 / 请求

| 用户问法 | 对象上下文 | ✅ 正确指标 | 说明 |
|---------|-----------|------------|------|
| 访问量、访问次数、页面访问 | WebApplication、PageFamily、业务 | `PGNPGE` | 页面访问数（总量） |
| 服务器侧访问 | WebApplication | `PGNPGC` | 服务器侧页面访问数 |
| 客户端侧访问 | WebApplication | `PGNPGS` | 客户端侧页面访问数 |
| 页面访问率 | WebApplication | `PGRT` | 页面访问速率 |
| 交互数、事务数 | DefinedApp、IPAddress、BusinessGroup | `TRNI`, `TRNO` | 应用交互数 |
| 交互率 | DefinedApp、IPAddress、BusinessGroup | `TRRI`, `TRRO` | 应用交互率 |
| Reset、重置 | 任意 | `RSTSI`, `RSTSO`, `RSTI`, `RSTO` | TCP Reset 率/数 |

**核心规则：WebApplication 用 PGNPGE（页面访问），DefinedApp/BusinessGroup/IP 用 TRNI/TRNO（应用交互）。不可混用。**

### 3.8 用户体验 / 综合性能

| 用户问法 | 对象上下文 | ✅ 正确指标 | 说明 |
|---------|-----------|------------|------|
| 用户体验、综合体验 | DefinedApp、IPAddress、BusinessGroup | `UEII`, `UEIO` | 综合体验耗时 |
| 初始应用响应 | DefinedApp、BusinessGroup | `ARTI`, `ARTO` | 初始应用响应时间 |
| 页面优化 | WebApplication | `POPT`, `ROPT`, `PNOPT`, `PPOPT`, `PFOPT` | 页面优化状态指标 |
| 净荷 | 任意 | `FSO_B`, `FSI_B`, `FSO_P`, `FSI_P` | 净荷数据量/包数量 |

---

## 4. 对象-指标速查矩阵

以下矩阵汇总了常见对象类型在模糊中文问法下的默认首选指标：

| 对象类型 | 报错/失败 | 慢/延迟 | 流量/带宽 | 连接 | 访问 |
|---------|----------|---------|----------|------|------|
| WebApplication | PGHTTP400, PGHTTP500 | PGTME | PGBYTI (页面流量), TPIO | — | PGNPGE |
| PageFamily | PGHTTP400, PGHTTP500 | PGTME | — | — | PGNPGE |
| BusinessGroup | RFCI, RFCO | TRTI, RTTI | TPIO, BYTIO | CONI, CCNI, RFCI | TRNI |
| IPAddress | RFCI, RFCO | RTTI, TRTI | TPIO, BYTIO | CONI, CCNI, RFCI | TRNI |
| Prefix24 | RFCI, RFCO | RTTI | TPIO, BYTIO | CONI | TRNI |
| DefinedApp | RFCI, PGHTTP400 | TRTI, CSTI | TPIO, BYTIO | CONI, CCNI, RFCI | TRNI |
| OtherApp | RFCI, PGHTTP400 | TRTI | TPIO | RFCI | TRNI |
| TotalTraffic | — | — | TPIO | — | — |
| IPConversation | RFCI | RTTI, TRTI | TPIO | CONI, RFCI | TRNI |

---

## 5. 对齐项目常量定义

本文件中的指标编码和对象分类与以下项目文件保持一致：

- `src/constants/objectMetricOwnership.js`：业务/非业务对象分类、指标归属、默认优先级
- `src/constants/metricDomains.js`：指标域定义、`normalizeSemanticMetricDomainToken()`
- `src/constants/objectDimensions.js`：对象维度定义与中文别名
- `config/object-ontology.v1.json`：对象类型定义、中文别名、库存来源
- `config/metrics-config.yml`：指标定义与合法编码列表

当本文件与上述文件出现不一致时，以项目常量定义为准。

---

## 6. 常见映射错误与纠正

以下是历史上出现过或容易出现的映射错误：

| 用户原话 | ❌ 错误映射 | ✅ 正确映射 | 原因 |
|---------|------------|------------|------|
| 哪个业务报错最多 | PLI | PGHTTP400, PGHTTP500 | 业务 = WebApplication，报错 = HTTP 错误码 |
| 服务器响应时间 | RTTI | TRTI | SKILL.md 明确规则 |
| 数据包数量最多的应用 | 吞吐量 TPIO | PKIO | 数据包 = PKIO，不是吞吐 |
| 流量最大的 IP | BYTIO (数据量) | TPIO (速率) | "最大"暗示峰值速率，不是累计量 |
| 连接数最多的地址 | CCNI (成功连接) | CONI (连接请求) | 连接数通常指总请求数 |
| 最慢的页面 | RTTI | PGTME | 页面慢 = 页面延时，不是 RTT |
| 访问其他web应用次数 | TRNI | PGNPGE | WebApplication 用页面访问指标 |

---

## 7. 与 LLM Agent 定义的衔接

`agents/openai.yaml` 的 `Metric guardrails` 段落包含最常用的高频规则。当 guardrails 没有覆盖用户问法时，LLM 应查阅本文件对应语义域。如果本文件也没有覆盖，应优先执行 `metricsForGroup` 运行时查询来确定可用指标，而不是自行猜测。
