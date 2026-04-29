# 2026-04-07 变更总结

## 今日目标

今天的工作主线是把第一版语义归一层接入当前 NAPM / OpenClaw skill 主链，并把本地回归里明确失败的同义问法和路由优先级问题修掉，最后完成服务器同步和重启。

## 一、今天做了什么

### 1. 建了第一版语义归一层

新增了 `SemanticNormalizerService`，作为主链最前面的统一语义入口。它先不接 LLM，而是用规则、白名单和降级规则把自然语言稳定归一成：

- `intent`
- `focus`
- `objectType`
- `service`
- `matchedWhitelistId`
- `matchedDegradeRuleId`
- `confidence`
- `needs_clarification`

同时新增了两份配置：

- `config/semantic-whitelist.v1.json`
- `config/semantic-degrade-rules.v1.json`

第一版白名单只保留了已确认成熟的主线能力，降级规则只保留了 `overview / clarify / rewrite_hint / not_supported` 这些第一版真正会用到的分支。

### 2. 把归一层接进了主链

归一层接入到了：

- `历史 OpenClawNapmAssistantService（现已移除）`
- `旧 gatewayRoutes 路由文件（现已移除）`
- `skills/openclaw-napm-query/services/RequirementParserService.js`

主链现在的关键顺序是：

用户问句
-> `SemanticNormalizerService.normalize()`
-> 命中白名单直接走现有主链
-> 未命中则按降级规则走 `overview / clarify / rewrite_hint / not_supported`
-> `RequirementParserService` 只做轻量 seed，再继续走原有规则校验和执行链

这次没有改 `NapmToolService`、`ResultNarrationService`、`FollowUpActionResolver` 的主体执行逻辑。

### 3. 修了本地测试里明确失败的项

本地回归里最明显的问题是同义问法覆盖不足，以及 `compare / diagnose` 容易被 `overview` 吞掉。今天主要修了这些句式：

- `哪个IP最占带宽`
- `哪个IP最忙`
- `哪个IP最吃流量`
- `哪个应用最忙`
- `哪个应用最占带宽`
- `哪个应用最吃资源`
- `哪个网站最卡`
- `哪个业务组最忙`
- `哪些应用流量高`
- `流量比昨天怎么样`
- `应用为什么变慢`
- `连接不稳定吗`

修复后，这些问句都能稳定命中第一版白名单或明确降级规则，不再乱掉到 `overview`。

### 4. 做了本地回归验证

回归验证分了三层：

- `SemanticNormalizerService.normalize()`
- `OpenClawNapmAssistantService.plan()`
- `RequirementParserService.applyNormalizedSemanticSeed()`

结果确认：

- 白名单命中稳定
- `compare / diagnose` 不再被 `overview` 吞掉
- parser seed 能正确把 `traffic / objectType / service` 轻量落到已有骨架里

完整 `parseToGatewayRequest()` 仍会碰到现有上游自签证书问题，但这不影响本地语义归一和路由回归的结论。

### 5. 同步到了服务器并重启

已将本地改动同步到服务器：

- `101.254.114.237`
- 目录：`/opt/NAPM_Semantic_Gateway`

重启后健康检查通过，`/health` 返回正常。

## 二、今天实际改动的核心文件

- `历史 SemanticNormalizerService（现已移除）`
- `历史 OpenClawNapmAssistantService（现已移除）`
- `旧 gatewayRoutes 路由文件（现已移除）`
- `skills/openclaw-napm-query/services/RequirementParserService.js`
- `config/semantic-whitelist.v1.json`
- `config/semantic-degrade-rules.v1.json`
- `docs/first-version-semantic-normalizer.md`
- `docs/local-regression-fix-notes.md`

## 三、今天的结论

第一版语义归一层已经真正接入主链，并且本地失败项已经修复完毕。当前系统已经可以稳定把常见口语问法归一到已成熟能力，剩下的主要是服务器上的人工验收和后续更广的样例补充，而不是主链结构性问题。

## 四、后续建议

- 先按今天这份白名单和降级规则继续做人工验收。
- 如果后续还要扩范围，优先补同义问法，不要先扩白名单。
- 如果要上第二版，再考虑把 rule-based normalizer 替换成模型增强版，但当前不用动。
