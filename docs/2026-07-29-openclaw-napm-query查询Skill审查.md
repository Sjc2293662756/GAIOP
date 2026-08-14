# openclaw-napm-query 查询 Skill 审查记录

日期：2026-07-29

范围：`skills/openclaw-napm-query/`、生产插件输入契约、工作区路由规则及相关测试。

## 结论

当前查询 Skill 已具备结构化查询、元数据校验、执行内核、概览编排和叙述契约等主体能力，但生产输入契约、跨 Skill 路由规则和测试基线尚未收敛为单一可信来源。首要问题不是指标映射本身，而是调用方无法从现有说明中稳定判断应传原始 prompt、完整 `resolvedQuery`，还是仅传带 `timeRange.key` 的半成品查询。

## 问题清单

### 1. 生产输入契约互相矛盾（高）

- `skills/openclaw-napm-query/agents/openai.yaml` 指示简单查询只传原始 prompt，由插件本地规则引擎生成 `resolvedQuery`。
- `skills/openclaw-napm-query/SKILL.md`、`config/napm-resolution-spec.v1.json` 和 strict 运行时要求生产调用必须携带完整 `resolvedQuery`。
- 开发 resolver 工具默认不注册，但生产插件的 `prepareSkillExecutionArgs()` 仍会通过 `maybeAutoRepairResolvedQuery()` 隐式调用本地 resolver。resolver 能识别的 prompt-only 问句会被补成 `resolvedQuery`，不能识别的问句则由 strict 输入边界拒绝并返回 `UPSTREAM_RESOLVED_QUERY_REQUIRED`。

影响：同一生产入口名义上要求完整 `resolvedQuery`，实际却对部分 prompt-only 请求做隐藏修复。调用结果取决于本地 resolver 覆盖范围，形成难以预测、难以审计的双轨生产链路。

### 2. 时间字段契约存在多套互斥说法（高）

- `agents/openai.yaml` 要求调用方不要计算 `start/end`，只传 `timeRange.key`。
- resolution spec 要求调用 `napm-skill-query` 前已经提供根级 `start/end`，且按分钟对齐。
- 插件工具 schema 一方面描述根级时间为必需执行字段，另一方面又在 `start/end` 字段上要求模型不要自行填写。
- 实际插件会通过 `applyTimeOverride` 按服务端时钟把 `timeRange.key` 转为根级 `start/end`。

影响：模型可能生成缺失时间、陈旧时间或同时携带相互冲突的声明时间和执行时间。

### 3. 查询 Skill 的跨 Skill 路由边界偏离工作区规则（高）

- 查询 Skill 仍把告警列为自身查询能力，但工作区要求告警查询统一走 `napm-alert-query`。
- 查询 Skill 仅把“故障分析并出报告”路由到 `napm-fault-diagnosis`，但工作区规则要求针对具体命名对象的分析、诊断和排查均走故障诊断工具，不以是否要求报告为前提。

影响：告警摘要、时间线、具体业务故障分析可能绕过专用生产链路。

### 4. 查询集成测试依赖被忽略的旧插件副本（高）

- 16 个测试文件加载 `.codex-temp/napm-openclaw-plugin.remote.js`。
- `.codex-temp/` 被 `.gitignore` 排除，不属于可复现仓库内容。
- 当前临时副本创建于 2026-06-15，SHA256 与当前根目录生产插件不同。

影响：当前机器上的测试验证旧代码；全新 checkout 则可能因模块不存在直接失败，无法作为生产插件回归依据。

### 5. 执行层时间校验可接受非法值（中）

`QueryValidator` 仅在时间可转换为有限数字时检查顺序和分钟对齐。实测以下输入均被接受：

- `start="abc"`、`end="xyz"`
- `start === end`
- 负数时间戳

影响：绕过插件边界的 CLI 或内部调用可能把非法时间请求发送给 NAPM。

### 6. 日志存在敏感信息和业务数据泄漏风险（中）

- `NapmClient` 初始化日志记录未脱敏用户名和内部 base URL。
- GET 失败日志原样记录上游响应体。
- metric kernel 把 API 返回数据前 200 个字符写入普通日志，可能包含 IP、业务名称或用户信息。

影响：日志读取权限扩大时，可能暴露认证标识、内部地址和业务数据。

### 7. 错误日志序列化不正确（中）

部分调用使用 `logger.error(message, error.message)`。Winston 将第二个字符串按字符索引展开，当前 `error.log` 已出现 `{"0":"...","1":"..."}` 形式的记录。

影响：错误原因难以检索和聚合，告警系统无法稳定提取错误字段。

### 8. 质量门禁不可用（中）

- `package.json` 定义了 `npm run lint`，但仓库没有 ESLint 配置，命令直接失败。
- 全量测试：70 个 suite 中 14 个失败；443 个测试中 40 个失败。
- 部分测试包含 `return` 后不可达断言，测试意图与当前行为不一致。

影响：当前无法依靠 lint 和全量测试判断查询 Skill 是否达到可发布状态。

### 9. 文档存在残留生成标记（低）

`references/runtime-lookup-notes.md` 中残留 `:contentReference[oaicite:...]` 标记。

影响：降低 Skill 参考文档质量，并可能干扰模型读取。

## 建议整改顺序

1. 定义唯一生产输入契约，明确 prompt、`resolvedQuery` 和时间解析的所有权。
2. 同步修改 `agents/openai.yaml`、`SKILL.md`、resolution spec、插件 schema 和输入契约测试。
3. 收紧告警与故障诊断路由边界。
4. 移除测试对 `.codex-temp` 的依赖，统一测试当前生产插件。
5. 修复执行层验证、日志脱敏和错误序列化。
6. 恢复 lint 与全量测试门禁。

## 整改状态（2026-07-30）

9 个问题均已完成本地整改，并分别形成独立说明：

1. [问题 1：生产输入契约整改说明](./2026-07-30-openclaw-napm-query问题1-生产输入契约整改说明.md)
2. [问题 2：时间字段契约整改说明](./2026-07-30-openclaw-napm-query问题2-时间字段契约整改说明.md)
3. [问题 3：跨 Skill 路由整改说明](./2026-07-30-openclaw-napm-query问题3-跨Skill路由整改说明.md)
4. [问题 4：测试插件来源整改说明](./2026-07-30-openclaw-napm-query问题4-测试插件来源整改说明.md)
5. [问题 5：执行时间校验整改说明](./2026-07-30-openclaw-napm-query问题5-执行时间校验整改说明.md)
6. [问题 6：日志脱敏整改说明](./2026-07-30-openclaw-napm-query问题6-日志脱敏整改说明.md)
7. [问题 7：错误日志序列化整改说明](./2026-07-30-openclaw-napm-query问题7-错误日志序列化整改说明.md)
8. [问题 8：质量门禁整改说明](./2026-07-30-openclaw-napm-query问题8-质量门禁整改说明.md)
9. [问题 9：文档生成标记整改说明](./2026-07-30-openclaw-napm-query问题9-文档生成标记整改说明.md)

本地验收结果：`npm run lint` 退出码 0；全量 Jest 73/73 suites、496/496 tests 通过；插件语法检查、diff 检查和 Skill 结构校验通过。当前未执行远端部署。

## 本次验证

- `npm run lint`：失败，缺少 ESLint 配置。
- `npm test -- --runInBand`：14 个 suite 失败，56 个通过；40 个测试失败，403 个通过。
- 直接调用 `QueryValidator`：确认非法字符串、相等时间和负数时间可通过校验。
- Git 工作树在审查结束时保持干净；本文件为后续新增的审查归档。
