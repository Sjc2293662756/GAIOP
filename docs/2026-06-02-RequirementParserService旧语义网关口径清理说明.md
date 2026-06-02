# RequirementParserService 旧语义网关口径清理说明

日期：2026-06-02

## 背景

当前主链路已经不是旧“语义网关自行理解/构造查询”的调用模式。

现行边界是：

```text
OpenClaw 上游负责语义理解与 resolvedQuery 构造
plugin 负责契约校验与工具转发
openclaw-napm-query skill 负责结构化查询执行
RequirementParserService 负责执行期校验、执行内核分派、上游 API 调用和错误收口
```

但 `RequirementParserService.js` 中仍有部分日志和注释使用“语义网关调用”“网关请求”等旧口径，容易误导后续排查。

## 本次修改

修改文件：

```text
skills/openclaw-napm-query/services/RequirementParserService.js
```

主要调整：

- 将运行日志 `=== 语义网关调用 ===` 改为 `=== NAPM skill 结构化查询执行 ===`。
- 将 `正在解析网关请求 JSON...` 改为 `正在解析执行态查询 JSON...`。
- 将 `Gateway request executed through split execution kernel.` 改为 `Structured query executed through split execution kernel.`。
- 将 `网关请求执行失败` 改为 `结构化查询执行失败`。
- 将“直接执行网关请求”注释改为“直接执行结构化查询”。
- 将“执行完整网关请求主链”注释改为“执行完整结构化查询主链”。
- 将“语义映射阶段产出的 resolvedQuery”改为“上游结构化阶段产出的 resolvedQuery”。
- 将“默认 gatewayRequest”相关注释改为“默认执行态查询”。
- 将 stable template 日志中的 `Gateway stable templates` 改为 `Runtime stable query templates`。

## 保留项

本次没有批量重命名以下函数和变量：

```text
gatewayRequest
executeGatewayRequest
executeDirectGatewayRequest
buildGatewayRequestSummary
```

原因是这些名称已经被多个执行路径和测试引用，直接重命名会扩大风险。文件头已明确说明：`gatewayRequest` 只是历史命名，当前含义是“运行时执行查询对象”，不代表旧项目级 gateway 仍是现行主链。

## 验证

已执行：

```bash
node --check skills/openclaw-napm-query/services/RequirementParserService.js
```

并确认以下旧口径不再出现：

```text
语义网关
网关调用
网关请求执行
Gateway request
Gateway stable
语义映射阶段
```
