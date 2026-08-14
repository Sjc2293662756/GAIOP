# openclaw-napm-query 问题 4：测试插件来源整改说明

日期：2026-07-30  
状态：本地整改和回归已完成。

## 问题与影响

16 个插件集成测试曾加载被 `.gitignore` 排除的 `.codex-temp/napm-openclaw-plugin.remote.js`。这些测试验证的是旧副本，新 checkout 还可能因文件不存在直接失败。

## 设计

根目录 `napm-openclaw-plugin.remote.js` 是本地生产插件唯一测试来源。测试不得依赖临时副本、归档副本或机器私有文件。

## 修改内容

- 将相关测试的 `require()` 统一切换到根目录生产插件。
- 更新注册断言为当前 7 个生产 Tool。
- 验证 2 个 Resolver 诊断 Tool 默认关闭、环境变量启用时才注册。
- 新增 `jest.config.cjs`，排除 `archive/`、`.codex-temp/` 和 `node_modules/`，避免归档测试被重复收集。

## 回归验证

- `rg` 扫描 `test/**/*.js`，不存在 `.codex-temp` 引用。
- 插件集成、守卫、注册和路由套件均加载当前生产插件。
- 全量 Jest：73 个 suite、496 个测试全部通过。

## 验收结论

测试结果现在可由仓库当前文件复现，并能真实反映根目录生产插件行为。
