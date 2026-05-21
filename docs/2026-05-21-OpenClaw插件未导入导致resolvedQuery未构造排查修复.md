# OpenClaw 插件未导入导致 resolvedQuery 未构造排查修复

## 现象

2026-05-21 19:48，用户在企业微信询问：

```text
吞吐量最大的前10个IP地址是谁？
```

OpenClaw 最终回答了正确数据，但追问“这个你是怎么查询的？”时，系统说明走的是直接 NetInside 底层 API：

```text
type=topValues
topMetric=BYTIO
metrics=BYTIO
groupType1=IPAddress
topCount=10
```

这说明主链没有稳定通过 NAPM skill，也没有由 OpenClaw 主链构造并下发 `resolvedQuery`。

## 结论

本次根因不是企业微信插件拦截。

企业微信入口日志已经出现：

```text
NAPM prompt detected; releasing to OpenClaw Agent mainflow resolver
```

说明企业微信插件已将 NAPM 问题放行给 OpenClaw Agent 主链。

真实根因是 `napm-openclaw-plugin` 在 OpenClaw runtime 中没有被真正导入：

```json
{
  "status": "loaded",
  "imported": false,
  "toolNames": [],
  "hookNames": [],
  "contracts": {
    "tools": [
      "napm-resolve-query",
      "napm-mainflow-query",
      "napm-skill-query"
    ]
  }
}
```

含义是：manifest 被 registry 识别到了，但插件运行时代码没有 import/register，所以 OpenClaw 主链看不到以下工具：

```text
napm-resolve-query
napm-mainflow-query
napm-skill-query
```

主链看不到工具，就不会调用构造器，也就不会产出 `resolvedQuery`。随后模型只能绕行 `curl` / 底层 API。

## 为什么没有导入

远端 NAPM 插件包原来是 CommonJS 入口：

```json
{
  "main": "index.js",
  "type": "commonjs"
}
```

而当前 OpenClaw 2026.5.4 的官方插件形态使用 ESM runtime extension，例如企业微信插件：

```json
{
  "type": "module",
  "main": "dist/index.js",
  "openclaw": {
    "extensions": [
      "./dist/index.js"
    ]
  }
}
```

因此 NAPM 插件虽然有 `openclaw.plugin.json` 的 contracts 声明，但缺少 OpenClaw runtime 实际导入的 `openclaw.extensions` 入口。

## 本次修复

新增 ESM 薄包装入口：

```text
napm-openclaw-plugin.index.mjs
```

内容：

```js
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginModule = require('./index.js');

const plugin = pluginModule?.default || pluginModule;

export default plugin;
```

新增专用于远端 NAPM 插件目录的包清单：

```text
napm-openclaw-plugin.package.json
```

关键配置：

```json
{
  "main": "index.js",
  "type": "commonjs",
  "openclaw": {
    "extensions": [
      "./index.mjs"
    ]
  }
}
```

这里必须保留 `"type": "commonjs"`，否则 Node 会把现有 `index.js` 当 ESM 解析，导致 `require/module.exports` 不可用。

最终链路是：OpenClaw 按 ESM extension 导入 `index.mjs`，`index.mjs` 再通过 `createRequire()` 兼容加载现有 CommonJS `index.js`。

## 远端部署位置

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/package.json
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/openclaw.plugin.json
```

## 验证标准

刷新 registry 并重启后，必须看到：

```bash
/home/netinside/.openclaw/npm/node_modules/.bin/openclaw plugins inspect napm-openclaw-plugin --json
```

期望结果：

```json
{
  "imported": true,
  "toolNames": [
    "napm-resolve-query",
    "napm-mainflow-query",
    "napm-skill-query"
  ]
}
```

如果仍是 `imported:false` 或 `toolNames:[]`，说明 OpenClaw 仍没有加载 NAPM 插件 runtime，不能继续讨论 resolver 规则问题。

## 后续测试问题

企业微信重新测试：

```text
吞吐量最大的前10个IP地址是谁？
```

预期链路：

```text
WeCom
-> OpenClaw Agent mainflow
-> napm-mainflow-query
-> NapmResolvedQueryResolverService.resolvePrompt()
-> napm-skill-query(resolvedQuery)
-> run_napm_query.js strict execution
```

不应再出现模型自行解释“直接调 NetInside 底层 API / curl”的路径。
