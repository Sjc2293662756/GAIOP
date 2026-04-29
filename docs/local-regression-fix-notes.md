# 本地回归失败项修复记录

日期：2026-04-07

## 修复目标

只修第一版语义归一层本地回归里已经明确失败的点，不扩白名单，不接 LLM，不改执行层。

## 本次修复文件

- `历史 SemanticNormalizerService（现已移除）`

## 本次修复内容

- 统一重写第一版 rule-based 语义归一逻辑，去掉受编码影响的中文正则。
- 补齐同义问法：
  - `最占带宽`
  - `最忙`
  - `最吃流量`
  - `最吃资源`
  - `最卡`
  - `哪些应用流量高`
  - `哪个业务组最忙`
  - `流量比昨天怎么样`
  - `应用为什么变慢`
  - `连接不稳定吗`
- 固定白名单命中优先级：
  - `traffic / compare / diagnose` 先于 `overview`
  - 明确对象时优先落到 `IPAddress / BusinessGroup / Application / WebApplication`
- 收窄 broad overview：
  - 只保留真正 broad 的问法进入 `DG-OVERVIEW-BROAD`

## 回归结果

### 已通过

- `哪个业务组最忙` -> `WL-TOP-TRAFFIC-BUSINESSGROUP`
- `哪些应用流量高` -> `WL-TOP-TRAFFIC-APPLICATION`
- `流量比昨天怎么样` -> `WL-CMP-TRAFFIC-GLOBAL`
- `应用为什么变慢` -> `WL-DIAG-APP-SLOW-GLOBAL`
- `连接不稳定吗` -> `WL-DIAG-CONN-STAB-GLOBAL`
- `哪个IP最占带宽` -> `WL-TOP-TRAFFIC-IPADDRESS`
- `哪个IP最忙` -> `WL-TOP-TRAFFIC-IPADDRESS`
- `哪个IP最吃流量` -> `WL-TOP-TRAFFIC-IPADDRESS`
- `哪个应用最忙` -> `WL-TOP-TRAFFIC-APPLICATION`
- `哪个应用最占带宽` -> `WL-TOP-TRAFFIC-APPLICATION`
- `哪个应用最吃资源` -> `WL-TOP-TRAFFIC-APPLICATION`
- `哪个网站最卡` -> `WL-TOP-WEBEX-WEBAPPLICATION`

### 仍保留的上游问题

- `RequirementParserService.parseToGatewayRequest()` 的完整链路仍会触发 NAPM 上游自签证书错误。
- 本地验收阶段使用的是 `applyNormalizedSemanticSeed()` 和 `plan()` 的归一/路由结果，不依赖真实上游返回。

## 结论

第一版语义归一层已经稳定接入主链，本地失败项已修复并通过回归。
