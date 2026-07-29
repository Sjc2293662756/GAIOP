---
name: routing-ranking-vs-diagnosis
description: 排行查询与故障诊断的路由区分规则 — 用户反复纠正后的经验
metadata:
  type: feedback
---

# 排行查询 vs 故障诊断 — 路由区分

**用户反馈**（2026-07-15 和 2026-07-16 两次纠正）：
- "今天哪个业务的400报错最多？" 是排行查询，应走 napm-skill-query
- 不应该走 napm-fault-diagnosis

**Why:** 用户问的是"哪个/哪些/谁...最多/最少/排行"，这是数据查询（ranking），
不是故障诊断（diagnosis）。故障诊断要求有具体的分析对象名称 + 分析/排查意图。

**How to apply:**
- "哪个XX最多/排行/TopN" → napm-skill-query (topValues)
- "分析XXweb的故障/给XX出诊断报告" → napm-fault-diagnosis
- 判断标准：有没有具体对象名 + 分析/诊断/报告意图？两者都满足 → fault-diagnosis；否则 → query

**Related:** [[SOUL.md 路由规则]], [[openai.yaml 决策树]]
