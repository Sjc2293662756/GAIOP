# openclaw-napm-query 问题 9：文档生成标记整改说明

日期：2026-07-30  
状态：本地整改已完成。

## 问题与影响

Query Skill references 中残留 `:contentReference[oaicite:...]` 生成标记。这些内容不是有效 Markdown，也不是可解析的真实引用，可能干扰模型读取。

## 修改内容

初次整改清理了 `references/runtime-lookup-notes.md`。完成审计进一步发现同类残留仍存在，因此扩大到整个 Query Skill references 范围，清理：

- `references/runtime-lookup-notes.md`
- `references/metric-definitions.md`
- `references/query-construction.md`
- `references/source-index.md`

只删除生成标记，不改写指标定义、查询规则或来源说明正文。

## 回归验证

```text
rg -n ":contentReference\[oaicite:" skills/openclaw-napm-query
```

扫描无匹配结果。全量 Jest 仍为 73/73 suites、496/496 tests 通过。

## 验收结论

Query Skill 目录内不再包含该类残留生成标记，reference 正文语义保持不变。
