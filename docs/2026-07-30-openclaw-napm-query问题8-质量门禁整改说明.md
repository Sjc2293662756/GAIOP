# openclaw-napm-query 问题 8：质量门禁整改说明

日期：2026-07-30  
状态：本地整改和回归已完成。

## 问题与影响

审查时 `npm run lint` 因缺少 ESLint 配置直接失败，全量 Jest 有 14 个 suite、40 个测试失败，部分断言位于 `return` 之后。该状态无法证明查询 Skill 可发布。

## 修改内容

- 新增 `.eslintrc.cjs`，恢复 Query Skill 的 lint 入口。
- 新增 `jest.config.cjs`，隔离归档和临时副本。
- 修复不可达断言、旧 Tool 注册数量和旧 strict 契约预期。
- 将插件测试统一到当前生产插件。
- 修复报告续导时传错包装对象的问题，并为无数据错误补充结构化 details。
- 更新报告生成测试为显式固定模板注册契约。
- 更新综述集成 mock 的方法签名和 12 项 WebApplication 查询计划。
- 修复巡检字段 mapper 未使用 about 页面版本号的问题。

## 验收结果

- `npm run lint`：退出码 0；0 个 error，18 个历史 unused warning。
- `npm test -- --runInBand`：73/73 suites 通过，496/496 tests 通过。
- `node --check napm-openclaw-plugin.remote.js`：通过。
- `git diff --check`：通过。

## 验收结论

lint 和全量测试已经恢复为可执行门禁。历史 unused warning 不影响退出码，但保留为后续代码清理项；本次不以关闭规则掩盖错误。
