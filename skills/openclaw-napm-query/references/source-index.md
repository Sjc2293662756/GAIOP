# Source Index

## 目录
1. 说明
2. 各 reference 文件来源映射
3. 原始材料清单
4. 使用建议

---

## 1. 说明

本目录下的 references 文件不是原始文档的逐字复制，而是从现有 NAPM 资料中抽取出的高密度知识总结，供 skill 的 explanation、metadata resolution 与 execution 阶段使用。

---

## 2. 各 reference 文件来源映射

### 2.1 metric-definitions.md
主要来源：
- `NetInside NAPM user guide 1.5 - metrics.docx`：提供指标分类、定义、计算口径、Client/Server 与 TCP Client/TCP Server 的区别、Inbound/Outbound 说明等。:contentReference[oaicite:99]{index=99}
- `api参数.pdf` / `api查询` 中的指标字典：提供 metric code、中文名、单位等映射。:contentReference[oaicite:100]{index=100}

### 2.2 group-hierarchy.md
主要来源：
- `NetInside NAPM分组结构原始梳理文档-含维度v1.1.docx`：提供顶层对象与 drill-down 结构。:contentReference[oaicite:101]{index=101}
- `NetInside NAPM user guide 1.5 - api.docx`：提供官方 group drill-down 定义与 groupType 用法。:contentReference[oaicite:102]{index=102}
- `api查询.docx`：提供现网 group / argument 候选与实际对象示例。:contentReference[oaicite:103]{index=103}

### 2.3 service-modes.md
主要来源：
- `NetInside NAPM user guide 1.5 - api.docx`：提供 `topValues / averageValues / timeValues` 与元数据服务定义。:contentReference[oaicite:104]{index=104}
- `NetInside NAPM Web Services接口描述20201218.pdf`：提供官方服务表与 URL Cookbook。
- `API构造规则手册-0725.pdf`：提供更贴近你们使用场景的构造例子与服务选择样例。:contentReference[oaicite:106]{index=106}

### 2.4 query-construction.md
主要来源：
- `API构造规则手册-0725.pdf`：提供 URL 构造规则与典型查询案例。:contentReference[oaicite:107]{index=107}
- `api查询.docx`：提供元数据返回样例、argument 候选与现网实例。:contentReference[oaicite:108]{index=108}
- `api参数.pdf`：提供指标与分组 code 对照、参数最小集合。:contentReference[oaicite:109]{index=109}

### 2.5 runtime-lookup-notes.md
主要来源：
- `NetInside NAPM user guide 1.5 - api.docx`：提供元数据服务定义。:contentReference[oaicite:110]{index=110}
- `NetInside NAPM Web Services接口描述20201218.pdf`：提供官方服务说明。
- `api查询.docx`：提供现网对象、groupArguments 样本和运行时候选思路。:contentReference[oaicite:112]{index=112}

---

## 3. 原始材料清单

当前整理主要基于以下材料：

1. `NetInside NAPM user guide 1.5 - metrics.docx`
2. `NetInside NAPM user guide 1.5 - api.docx`
3. `NetInside NAPM分组结构原始梳理文档-含维度v1.1.docx`
4. `NetInside NAPM Web Services接口描述20201218.pdf`
5. `API构造规则手册-0725.pdf`
6. `api查询.docx`
7. `api参数.pdf` 

---

## 4. 使用建议

- 若要回答“指标是什么意思”，优先查 `metric-definitions.md`
- 若要回答“对象层级是什么”，优先查 `group-hierarchy.md`
- 若要回答“该走哪种服务”，优先查 `service-modes.md`
- 若要构造查询，优先查 `query-construction.md`
- 若要确认现网是否支持或存在，优先查 `runtime-lookup-notes.md`

静态 references 用于解释与通用规则；运行时元数据服务用于现网确认与执行前校验。