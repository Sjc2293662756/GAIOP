# 第一版语义归一层改造记录

## 目标

把第一版语义归一层接入当前主链，限定在已确认的白名单能力和降级规则内，不接 LLM，不重写执行器和结果展示层。

## 这次改了什么

- 新增 `历史 SemanticNormalizerService（现已移除）`
- 新增 `config/semantic-whitelist.v1.json`
- 新增 `config/semantic-degrade-rules.v1.json`
- 修改 `历史 OpenClawNapmAssistantService（现已移除）`
- 修改 `旧 gatewayRoutes 路由文件（现已移除）`
- 修改 `skills/openclaw-napm-query/services/RequirementParserService.js`

## 接入方式

1. 路由层先计算 `normalizedSemantic`，塞进 `requestContext`
2. `OpenClawNapmAssistantService.plan()` 优先读取 `normalizedSemantic`
3. `RequirementParserService.parseToGatewayRequest()` 使用 `normalizedSemantic` 做轻量 seed
4. 白名单命中继续走现有主链
5. 非白名单按第一版降级规则返回 `overview / clarify / not_supported / rewrite_hint`

## 第一版明确不做的事

- 不接 LLM
- 不改 `NapmToolService` 核心执行逻辑
- 不重写 `FollowUpActionResolver`
- 不重写 `ResultNarrationService`
- 不扩白名单到未确认能力
