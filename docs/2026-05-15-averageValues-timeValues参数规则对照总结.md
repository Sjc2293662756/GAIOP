# 2026-05-15 averageValues / timeValues 参数规则对照总结

最后更新：2026-05-15

## 1. 目的

本文件用于总结以下两类资料之间的关系：

1. 外部材料中的 API 构造规则
2. 当前项目 `NAPM_Semantic_Gateway` 中对 `averageValues`、`timeValues` 的真实实现规则

本次重点核对的材料包括：

- `G:\my_file\项目测试\观枢·智维平台-GAIOP\材料\API构造规则手册-0725.pdf`
- `G:\my_file\项目测试\观枢·智维平台-GAIOP\材料\api构造规则.md`
- `G:\my_file\项目测试\观枢·智维平台-GAIOP\材料\pdf_extract_ws.txt`

项目内重点核对的实现文件包括：

- `skills/openclaw-napm-query/services/QueryValidator.js`
- `skills/openclaw-napm-query/services/QueryMetadataConstraintService.js`
- `skills/openclaw-napm-query/services/NapmMetadataService.js`
- `skills/openclaw-napm-query/services/RequirementParserService.js`
- `skills/openclaw-napm-query/references/service-modes.md`
- `skills/openclaw-napm-query/references/query-construction.md`

## 2. 总结结论

结论可以概括为一句话：

**API 手册中的基础参数要求，与项目当前实现的底层执行规则基本一致；但项目实现比手册多了一层运行时约束、自动修正、元数据校验和语义收口。**

也就是说：

1. 手册定义了 API 应该怎么拼。
2. 项目实现不仅会拼 API，还会判断：
   - 参数结构是否合法
   - 指标和对象是否兼容
   - granularity 是否合理
   - 该问题是否真的应该走 `averageValues` / `timeValues`

因此二者不是“完全一样”，而是：

- **底层参数规则：基本一样**
- **项目执行口径：更严格、更工程化**

## 3. 手册中的基础规则

根据 `API构造规则手册-0725.pdf` 的抽取文本，以及 `api构造规则.md` 的整理内容：

### 3.1 averageValues

手册给出的核心参数为：

- `type=averageValues`
- `start`
- `end`
- `metrics`
- `numGroups`
- `groupTypei`
- `groupArgumenti`（按需）

这表示：

1. `averageValues` 用于获取指定对象、指定指标、指定时间范围内的平均值或区间统计值。
2. `groupArgument` 不是每一层都必须填，而是“该层需要具体对象值时才填”。

### 3.2 timeValues

手册给出的核心参数为：

- `type=timeValues`
- `start`
- `end`
- `metrics`
- `granularity`
- `numGroups`
- `groupTypei`
- `groupArgumenti`（按需）

这表示：

1. `timeValues` 用于获取时间序列。
2. `granularity` 是时间粒度，单位为秒。
3. `granularity` 应从系统 `granularities` 服务支持的值中选取。

### 3.3 手册里的补充规则

手册还明确了：

1. `groupType` 和 `groupArgument` 必须按层级顺序设置。
2. `topCount` 有范围限制。
3. `granularity` 必须使用系统支持值。
4. 多层 drill-down 查询时，要按路径顺序正确拼装 `numGroups`、`groupTypeX`、`groupArgumentX`。

## 4. 项目中的硬性执行规则

项目当前对 `averageValues` / `timeValues` 的硬性执行校验，主要体现在 `QueryValidator.js`。

### 4.1 averageValues 的项目硬要求

项目中，`averageValues` 至少要求：

- `service`
- `start`
- `end`
- `metrics`

并且：

- `metrics` 必须是**非空数组**

这和手册要求是同方向的，只是项目内部用的是结构化 `resolvedQuery` 形态，不是直接 URL 字符串。

### 4.2 timeValues 的项目硬要求

项目中，`timeValues` 至少要求：

- `service`
- `start`
- `end`
- `metrics`
- `granularity`

并且：

- `metrics` 必须是**非空数组**
- `granularity` 缺失时直接视为非法

### 4.3 这里和手册的关系

这一层与手册是**基本一致**的。

主要差别只有一个：

- 手册描述的是 HTTP API 参数形式
- 项目校验的是内部 `resolvedQuery` 对象形式

例如：

- 手册里是 `metrics=TPIO,TPI,TPO`
- 项目里是 `metrics: ['TPIO', 'TPI', 'TPO']`

真正发请求时，项目会再把数组转成逗号分隔字符串。

## 5. 项目中多出来的运行时约束

这一部分是手册没有明确覆盖，但项目真实在做的事情。

### 5.1 granularity 自动归一化

手册只说：

- `granularity` 要填
- 并且要使用系统支持值

项目比这更进一步：

1. 如果 `granularity` 不合理，项目会先按时间跨度做归一化。
2. 如果动态元数据返回的支持值里不包含当前值，项目会替换成远端支持值。

当前项目的默认归一化策略大致为：

- 时间跨度不超过 6 小时：优先 `60`
- 不超过 3 天：优先 `300`
- 不超过 30 天：优先 `3600`
- 更长时间：优先 `86400`

也就是说，项目不是“只报错”，而是会尽量把不合理的 `granularity` 修成可执行值。

### 5.2 metric 与 group 的兼容性校验

手册主要讲“怎么拼”；项目还会判断：

- 当前 `group` 下，这个 `metric` 是否真的可查

如果不兼容，项目可能会：

1. 报警告
2. 给出候选指标
3. 在某些情况下改写 group 类型

这一层能力主要来自：

- `DimensionMappingService`
- `QueryMetadataConstraintService`
- `NapmMetadataService.getMetricsForGroupPath()`

这说明项目的真实口径是：

**能不能查，不只看手册例子，还要看当前 group path 的动态元数据。**

### 5.3 groupArgument 的动态校验

手册说：

- `groupArgument` 按需填写

项目也认可这一点，但会再多做一步：

1. 如果该 group 的 `hasArgument=true`
2. 并且用户传了 argument
3. 项目会去查 `groupArguments`
4. 如果值不存在，会记录问题并给候选项

所以在项目里，`groupArgument` 不只是“有没有”，还要进一步看“值是否真实存在于当前系统元数据中”。

### 5.4 averageValues / timeValues 的语义使用边界

这是手册没有覆盖、但项目现在非常强调的一点。

项目中：

- `averageValues` 更适合“对象已知”的平均值/区间值
- `timeValues` 更适合“趋势”

项目明确反对把下面这种问法直接压成单次 `averageValues` 或 `timeValues`：

- 先找最...的对象，再分析它
- 找到失败最多的地址，然后综合分析
- 报错最多的是哪个业务，再分析它

这类问题在项目里应走：

```text
discovery
  -> focused overview
```

而不是直接单次 `averageValues` / `timeValues`。

因此：

**手册只解决“参数怎么拼”，项目还解决“这句话到底该不该用这个 service”。**

## 6. 二者一致点清单

以下内容，手册与项目实现基本一致：

1. `averageValues` 需要时间范围和指标。
2. `timeValues` 需要时间范围、指标和 `granularity`。
3. group path 通过 `numGroups + groupTypei + groupArgumenti` 描述。
4. `groupArgumenti` 是按需填写，不是每一层都强制有值。
5. 多层路径必须按层级顺序拼装。
6. `granularity` 需要使用系统支持值。

## 7. 二者差异点清单

以下内容是项目实现比手册多出来的：

1. 项目内部 `metrics` 使用数组，不是直接字符串。
2. 项目会把 `metrics` 数组在最后执行时再拼成逗号字符串。
3. 项目会对 `granularity` 先做本地归一化，再做动态支持值修正。
4. 项目会通过 `metricsForGroup` 校验当前 group path 与指标是否兼容。
5. 项目会通过 `groupArguments` 校验 argument 是否真实存在。
6. 项目对 `averageValues` / `timeValues` 有上层语义边界，不是所有问题都允许直接走这两个 service。

## 8. 当前项目可采用的标准口径

如果后面再讨论这个问题，建议统一采用下面这套说法：

### 8.1 averageValues

最小可执行要求：

- `service`
- `start`
- `end`
- `metrics`

稳定可执行要求：

- `service`
- `start`
- `end`
- `metrics`
- 正确的 `groups`
- 需要时的 `groupArgument`
- 通过 `metricsForGroup` 校验

适用语义：

- 对象已知
- 查平均值 / 区间值 / 单对象统计

### 8.2 timeValues

最小可执行要求：

- `service`
- `start`
- `end`
- `metrics`
- `granularity`

稳定可执行要求：

- `service`
- `start`
- `end`
- `metrics`
- `granularity`
- 正确的 `groups`
- 需要时的 `groupArgument`
- `granularity` 需可被系统接受
- 通过 `metricsForGroup` 校验

适用语义：

- 查趋势
- 查时间序列

## 9. 最终结论

本次核对后，可以明确得出结论：

1. `API构造规则手册-0725.pdf` 与项目当前对 `averageValues`、`timeValues` 的**底层参数要求基本一致**。
2. 项目实现并不是简单照抄 PDF，而是在此基础上增加了：
   - 内部结构化 `resolvedQuery` 约束
   - 动态元数据校验
   - `granularity` 自动修正
   - 语义使用边界控制
3. 因此后续如果要判断“项目现在是不是按手册来”，正确答案应是：

**是按手册的基础 API 规则来，但项目又额外加了自己的一层执行保护和语义收口。**
