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

排查过程中一度看到 `plugins inspect` 中 `napm-openclaw-plugin` 显示：

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

这个结果不能单独作为“插件完全未导入”的最终证据，因为 `plugins inspect` / `plugins list` 更偏静态 registry 视图；官方 `wecom-openclaw-plugin` 在该命令里也可能显示 `imported:false`。

更准确的验证方式是直接用 OpenClaw runtime loader 加载 NAPM 插件。验证结果显示当前远端已经可以注册出以下工具：

```text
napm-resolve-query
napm-mainflow-query
napm-skill-query
```

以及以下 hook：

```text
napm-message-scope-detect
napm-routing-policy
napm-boundary-tool-guard
napm-out-of-scope-rewriter
napm-before-message-write-guard
```

因此当前更精确的判断是：

```text
插件 runtime 可加载，resolver 可构造 resolvedQuery；
但 2026-05-21 19:48 那次企业微信 Agent 会话没有实际使用到 napm-mainflow-query，
导致模型绕行 curl / 底层 NetInside API。
```

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

另一个容易误判的点是：`activation.onStartup=true` 会让 persisted registry 将该插件标记成 `startup.sidecar=true`，但 NAPM 插件这里需要暴露的是主链可调用的 `tool/hook capability`。

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

export const register = plugin.register.bind(plugin);
export const id = plugin.id;
export const name = plugin.name;
export const description = plugin.description;

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

`index.mjs` 同时提供 `default` 和命名导出 `register/id/name/description`。这样无论 OpenClaw loader 使用 `module.default.register` 还是直接读取 `module.register`，都能拿到同一个插件注册函数。

同时调整 `openclaw.plugin.json` 的 activation：

```json
{
  "activation": {
    "onCapabilities": [
      "tool",
      "hook"
    ]
  }
}
```

原来的 `activation.onStartup=true` 会让 OpenClaw persisted registry 将 NAPM 标记成 `startup.sidecar=true`。NAPM 这里需要暴露给主链的是 tool/hook capability，不是启动型 sidecar。

## 远端部署位置

```text
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/package.json
/home/netinside/.openclaw/extensions/napm-openclaw-plugin/openclaw.plugin.json
```

## 验证标准

刷新 registry 并重启后，不能只看 `plugins inspect` 的 `imported` 字段。应优先做 runtime loader 验证：

```bash
cd /home/netinside/.openclaw
node --input-type=module - <<'NODE'
import { l as loadOpenClawPlugins } from './npm/node_modules/openclaw/dist/loader-CBUR8YGF.js';
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync('./openclaw.json', 'utf8'));
const registry = loadOpenClawPlugins({
  config,
  activationSourceConfig: config,
  workspaceDir: '/home/netinside/.openclaw/workspace',
  onlyPluginIds: ['napm-openclaw-plugin'],
  activate: false,
  preferBuiltPluginArtifacts: true,
  logger: console
});
console.log(JSON.stringify({
  tools: registry.tools.flatMap((tool) => tool.names),
  hooks: registry.hooks.map((hook) => hook.entry?.hook?.name),
  diagnostics: registry.diagnostics
}, null, 2));
NODE
```

期望至少包含：

```json
{
  "tools": [
    "napm-resolve-query",
    "napm-mainflow-query",
    "napm-skill-query"
  ]
}
```

`plugins inspect` 可以辅助观察 manifest：

```bash
/home/netinside/.openclaw/npm/node_modules/.bin/openclaw plugins inspect napm-openclaw-plugin --json
```

如果只看 `plugins inspect`，期望至少能看到 `source` 指向 `index.mjs`，并且 `contracts.tools` 存在：

```json
{
  "source": "/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs",
  "contracts": {
    "tools": [
      "napm-resolve-query",
      "napm-mainflow-query",
      "napm-skill-query"
    ]
  }
}
```

## Resolver 验证

本地验证以下问法已经可以稳定构造 `resolvedQuery`：

```text
吞吐量最大的前10个IP地址是谁？
```

结果摘要：

```json
{
  "ok": true,
  "service": "topValues",
  "queryModeKey": "topn",
  "metric": "TPIO",
  "groups": [
    {
      "type": "IPAddress"
    }
  ],
  "topCount": 10,
  "semanticConstraints": {
    "operation": "rank_top",
    "direction": "desc"
  }
}
```

同时验证：

```text
丢包最大的IP地址是谁？
哪个客户端IP丢包最高？
系统中有哪些工作组？
```

分别会构造成：

```text
topValues + PLI + IPAddress + topCount=1
topValues + PLI + IPAddress + topCount=1
groups + BusinessGroup + metadata_list
```

## 当前剩余风险

如果企业微信再次回答“直接调 NetInside 底层 API / curl”，说明不是 resolver 规则问题，而是当前 Agent turn 没有把 `napm-mainflow-query` 加入可用工具集，或模型没有遵循 NAPM routing policy。

这时应重点检查：

```text
1. 当前企业微信会话 Runtime 行里的 capabilities 是否仍为 none
2. 本轮 transcript 是否出现 napm-mainflow-query toolCall
3. journal 是否出现 [napm-openclaw-plugin] injecting NAPM routing policy
4. 是否仍有旧 session direct mapping 或旧 prompt policy 引导模型使用 exec/curl
```

如果 tools 已经存在但模型仍绕行，应继续加一层硬约束：在 NAPM prompt 下通过 `before_tool_call` 阻断 `exec/curl`，只允许 `napm-mainflow-query` / `napm-skill-query`。

旧判断中“必须看到 imported:true / toolNames 非空”的要求不再作为唯一标准：

```json
{
  "legacyReferenceOnly": [
    "napm-resolve-query",
    "napm-mainflow-query",
    "napm-skill-query"
  ]
}
```

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
