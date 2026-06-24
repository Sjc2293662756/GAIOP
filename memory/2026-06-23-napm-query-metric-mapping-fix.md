---
name: napm-query-chinese-metric-mapping
description: NAPM query skill 中文语义→指标映射系统性修复，解决"报错"误映射为 PLI 等问题
metadata:
  type: project
---

## 背景

用户反馈：当问"现在哪个业务报错最多？"时，系统错误地将"报错"映射为 PLI（丢包）指标，而非正确的 PGHTTP400/PGHTTP500（HTTP 错误码）。

## 根因

`agents/openai.yaml` 的 Metric guardrails 只有 5 条稀疏规则，覆盖不到 50+ 个 NAPM metric code。LLM 在"报错"到具体指标 code 的映射上缺乏精确指引，自由联想到了 NAPM 体系中曝光率最高的"异常信号"指标 PLI。

更深层的问题：现有参考文件（`metric-category-mapping.md` 等）是按 NAPM 指标分类组织的"反向索引"，LLM 需要的是从用户中文用语正向定位到指标 code 的查表工具。

## 修改内容

### 第一轮：针对性修复（解决"报错"问题）

| 文件 | 改动 |
|------|------|
| `agents/openai.yaml` | Metric guardrails 新增 6 条"报错"映射规则；Ranking guardrails 新增 1 条 |
| `references/query-workflow-contract.md` | 新增 Metric Disambiguation 章节 + "报错"示例 |
| `SKILL.md` | Semantic Mapping Guardrails 新增报错/丢包/连接失败/HTTP错误规则；Important Query Examples 新增"业务报错"示例 |
| `references/metric-dimension-ownership.md` | 4.1 WebApplication 章节补充"报错语义"说明 |

### 第二轮：系统性修复（覆盖全部 8 个语义域）

| 文件 | 改动 |
|------|------|
| **新建** `references/chinese-semantic-metric-mapping.md` | 8 个语义域（报错/慢/流量/丢包/重传/连接/访问/用户体验）的完整正向映射表，含对象上下文敏感规则 + 常见错误纠正 + 对象-指标速查矩阵 |
| `agents/openai.yaml` | Metric guardrails 末尾新增对 `chinese-semantic-metric-mapping.md` 的引用 |
| `SKILL.md` | References 列表 + Semantic Mapping Guardrails 各新增引用 |
| `references/source-index.md` | 新增 2.9 节 + 使用建议条目 |

## 核心映射规则

```
用户说"报错"
├─ 对象 = WebApplication/业务 → PGHTTP400 + PGHTTP500 ✅
├─ 对象 = BusinessGroup/业务组 → RFCI + RFCO ✅
└─ 绝不用 PLI/PLO（丢包）❌
```

## 后续建议

- 如果发现新的中文问法映射错误，应在 `chinese-semantic-metric-mapping.md` 对应语义域补充条目
- 同时在 `openai.yaml` 的高频 guardrails 中考虑是否值得显式列出
- 最终仍需运行时 `metricsForGroup` 校验兼容性
