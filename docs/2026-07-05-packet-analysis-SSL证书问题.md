# Packet-Analysis SSL 证书问题排查与修复

> 日期：2026-07-05

---

## 1. 问题现象

调用 `napm-packet-analysis` 下载数据包时报 `self-signed certificate` 错误，无法通过 HTTPS 访问 NetInside API 下载 pcap 文件。

AI 的输出中反复出现：
```
"数据包分析因为 SSL 证书问题（自签名证书）未能直接下载"
"self-signed certificate"
```

但 `napm-alert-query` 访问同样的 NetInside API 却正常工作。

---

## 2. 根因分析

### 2.1 两个 Skill 使用了不同的环境变量

| Skill | 脚本 | TLS 控制变量 | 含义 |
|-------|------|-------------|------|
| alert-query | `AlertApiService.js` | `NETINSIDE_TLS_INSECURE` | `true`=跳过验证 |
| packet-analysis | `run_packet_analysis.js` | `NETINSIDE_TLS_REJECT_UNAUTHORIZED` | `false`=跳过验证 |

**两个变量名不同，语义相反。**

### 2.2 代码路径追踪

#### AlertApiService.js（alert-query 用的）

```js
// skills/openclaw-napm-alert-query/services/AlertApiService.js:72-75
const tlsInsecureValue = options.tlsInsecure != null
  ? options.tlsInsecure
  : (process.env.NETINSIDE_TLS_INSECURE || '');
this.tlsInsecure = String(tlsInsecureValue).toLowerCase() === 'true';

// :80-81
this.client = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: !this.tlsInsecure })
});
```

逻辑：`NETINSIDE_TLS_INSECURE=true` → `tlsInsecure=true` → `rejectUnauthorized=false` → ✅ 跳过验证

#### run_packet_analysis.js（packet-analysis 用的）

```js
// skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js:1501-1502
if (url.protocol === 'https:' && envBool('NETINSIDE_TLS_REJECT_UNAUTHORIZED', true) === false) {
  requestOptions.agent = new https.Agent({ rejectUnauthorized: false });
}

// :2178-2182
function envBool(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}
```

逻辑：`NETINSIDE_TLS_REJECT_UNAUTHORIZED` 未设置 → `envBool` 返回默认值 `true` → `true === false` 为 false → 不创建跳过验证的 Agent → ❌ 证书错误

### 2.3 Plugin 传参缺失

```js
// napm-openclaw-plugin.remote.js — runPacketExecutor (修复前)
env: {
  ...process.env,
  NETINSIDE_TLS_INSECURE: process.env.NETINSIDE_TLS_INSECURE || 'true',
  // ❌ 没有传 NETINSIDE_TLS_REJECT_UNAUTHORIZED
  FORCE_COLOR: '0',
  NO_COLOR: '1'
}
```

对比 `runAlertExecutor`（正常工作）也是同样的 env：
```js
env: {
  ...process.env,
  NETINSIDE_TLS_INSECURE: process.env.NETINSIDE_TLS_INSECURE || 'true',
  FORCE_COLOR: '0',
  NO_COLOR: '1'
}
```

alert-query 能工作是因为它读 `NETINSIDE_TLS_INSECURE`（已被设为 `true`）。packet-analysis 不能工作是因为它读 `NETINSIDE_TLS_REJECT_UNAUTHORIZED`（未被设置，默认 `true`=严格校验）。

### 2.4 为什么 AI 手动 curl 能绕过

AI 有时用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 来运行 curl——这是 Node.js 原生环境变量，`https.Agent` 会自动读取。但 skill 脚本里自己用 `envBool('NETINSIDE_TLS_REJECT_UNAUTHORIZED', ...)` 做了二次判断，不依赖 Node.js 原生变量。所以 AI 绕过的方式对 skill 脚本调用无效。

---

## 3. 修复

### 3.1 runPacketExecutor（napm-openclaw-plugin.remote.js）

```diff
 env: {
   ...process.env,
   NETINSIDE_TLS_INSECURE: process.env.NETINSIDE_TLS_INSECURE || 'true',
+  NETINSIDE_TLS_REJECT_UNAUTHORIZED: process.env.NETINSIDE_TLS_REJECT_UNAUTHORIZED || 'false',
   FORCE_COLOR: '0',
   NO_COLOR: '1'
 }
```

### 3.2 远端 .env（`/home/netinside/.openclaw/workspace/.env`）

已确认远端 `.env` 包含：
```
NETINSIDE_TLS_INSECURE=true
NETINSIDE_TLS_REJECT_UNAUTHORIZED=false
```

---

## 4. 后续建议

### 4.1 统一变量名

两个 Skill 应统一使用同一个 TLS 控制变量，避免维护两套语义。建议长期方案：
- alert-query 的 `AlertApiService` 改为读取 `NETINSIDE_TLS_REJECT_UNAUTHORIZED`
- 或 packet-analysis 的 `run_packet_analysis.js` 增加对 `NETINSIDE_TLS_INSECURE` 的兼容

### 4.2 统一语义方向

两个变量语义相反，容易混淆：

| 变量 | 默认 | 跳过验证 |
|------|------|---------|
| `NETINSIDE_TLS_INSECURE` | 空/false | 设为 `true` |
| `NETINSIDE_TLS_REJECT_UNAUTHORIZED` | `true` | 设为 `false` |

建议统一为 `NETINSIDE_TLS_INSECURE` 并全部使用同一套语义。

---

## 5. 修改文件

| 文件 | 修改 |
|------|------|
| `napm-openclaw-plugin.remote.js` | `runPacketExecutor` 的 child process env 新增 `NETINSIDE_TLS_REJECT_UNAUTHORIZED` |
