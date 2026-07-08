# LLM 推理耗时优化方案：Prompt 精简与动态上下文

日期：2026-07-08
状态：方案设计（不修改代码）

---

## 目录

1. [根因定量分析](#一根因定量分析)
2. [优化目标](#二优化目标)
3. [方案一：动态路由上下文注入（P0）](#三方案一动态路由上下文注入p0)
4. [方案二：精简 Tool Schema（P1）](#四方案二精简-tool-schemap1)
5. [方案三：合并通用规则消除冗余（P2）](#五方案三合并通用规则消除冗余p2)
6. [方案四：模型层面优化（P3）](#六方案四模型层面优化p3)
7. [综合效果预测](#七综合效果预测)
8. [实施顺序建议](#八实施顺序建议)
9. [风险与回滚](#九风险与回滚)

---

## 一、根因定量分析

### 1.1 实测数据

基于 2026-07-08 09:40 的 `最近一小时，吞吐量较大的前10个IP` 查询实测：

| 指标 | 值 |
|------|-----|
| 端到端耗时 | **10.3s** |
| LLM 推理耗时 | **~8.0s**（占总耗时 **77.4%**） |
| Hook + Skill + API | **<300ms**（占 2.9%） |
| Agent 启动 + prefill | **~902ms**（占 8.7%） |

### 1.2 LLM 每轮看到的上下文

| 组成部分 | 字符数 | Token | 当前查询相关度 | 来源 |
|---------|--------|-------|:---:|------|
| 路由 System Context | 12,607 | ~5,000 | **1/49 条** | `buildNapmRoutingSystemContext()` |
| `napm-skill-query` 定义 | 5,468 | ~2,200 | ✅ | `createSkillToolDefinition()` |
| `napm-report-export` 定义 | 1,906 | ~760 | ❌ | `createReportExportToolDefinition()` |
| `napm-alert-query` 定义 | 4,644 | ~1,860 | ❌ | `createAlertQueryToolDefinition()` |
| `napm-inspection-snapshot` 定义 | 2,427 | ~970 | ❌ | `createInspectionSnapshotToolDefinition()` |
| `napm-summary` 定义 | 3,231 | ~1,290 | ❌ | `createSummaryToolDefinition()` |
| `napm-fault-diagnosis` 定义 | 3,569 | ~1,430 | ❌ | `createFaultDiagnosisToolDefinition()` |
| `napm-packet-analysis` 定义 | 4,530 | ~1,810 | ❌ | `createPacketAnalysisToolDefinition()` |
| OpenClaw 基础 Prompt | ~2,000 | ~800 | 部分 | OpenClaw 框架 |
| **合计** | **~40,000** | **~16,000** | **~15%** | |

### 1.3 瓶颈位置

```
每次 LLM 调用的 Token 流：

输入 (16,000 tokens)
┌──────────────────────────────────────────────┐
│ ████████████ 路由规则 (5,000)    ← 85% 无关  │
│ ██████████████████████ Tool定义 (10,300)     │
│                            ← 85% 无关        │
│ ██ 基础Prompt (800)                          │
│ █ 用户消息 (50)                              │
└──────────────────────────────────────────────┘
         │
         ▼
    DeepSeek Chat prefill (~6,000 tok/s)
         │
         ▼  ~2,700ms（仅读取输入）
    ┌──────────┐
    │ LLM 推理  │ → Tool决策 ~1,500ms
    │          │ → 格式化   ~2,500ms
    └──────────┘
         │
         ▼
输出 (~200 tokens)
┌──────────┐
│ 回答文本  │
└──────────┘
```

**核心矛盾**：每次查询 LLM 需要处理 ~16,000 token 输入，其中 **~13,600 token（85%）与当前查询无关**。这直接导致：
- **Prefill 阶段浪费 ~1.5-2s**：LLM 必须读取全部 16K token 才能开始推理
- **注意力分散**：大量无关规则稀释了 LLM 对关键指令的注意力
- **每轮重复开销**：多轮对话中每次都注入相同的完整上下文

---

## 二、优化目标

| 目标 | 当前 | 目标 | 预期节省 |
|------|------|------|---------|
| 路由上下文 Token | ~5,000 | ~2,000 | **-3,000 token** |
| Tool 定义 Token | ~10,300 | ~6,500 | **-3,800 token** |
| 总输入 Token | ~16,000 | ~9,500 | **-6,500 token (-40%)** |
| Prefill 时间 | ~2,700ms | ~1,600ms | **-1,100ms** |
| 端到端耗时 | 10.3s | **7-8s** | **-2~3s** |

---

## 三、方案一：动态路由上下文注入（P0）

### 3.1 问题定位

**关键代码**：`napm-openclaw-plugin.remote.js` line 4543-4597

```javascript
registerNapmHook(
  ['before_prompt_build', 'before_agent_start'],
  (event, ctx) => {
    // ... guard state 分类 ...
    return {
      appendSystemContext: buildNapmRoutingSystemContext()  // ← 永远注入全部 49 条
    };
  },
);
```

**问题**：`buildNapmRoutingSystemContext()` 返回全部 49 条规则，**无任何过滤**。但 `before_prompt_build` Hook 已经在上文完成了 prompt 分类（`napmRelated`、`alertRelated`、`faultRelated` 等），这个分类结果完全可以直接用于选择注入哪些规则。

### 3.2 改造方案

**核心思路**：将 49 条规则按适用场景分为"通用规则"和"场景专属规则"，根据 `guardState` 中的 prompt 分类动态组合。

#### 3.2.1 规则分类

```
通用规则（所有查询都注入，~8 条，~800 token）：
├── 角色边界声明（1 条）
├── resolvedQuery 所有权声明（1 条）
├── 输入通道声明（1 条）
├── 时间契约（2 条）
├── displayText 优先（1 条）
├── Debug API URL 追加（1 条）
└── 新鲜数据强制（1 条）

napm-skill-query 场景（~5 条额外，~500 token）：
├── 查询边界
├── 查询契约引用
├── 澄清/回答/解释声明
└── 边界拒绝声明

napm-summary 场景（~6 条额外，~600 token）：
├── 综述报告路由 + Scope 映射表
├── 综述边界 + 综述契约
├── 跨技能边界
└── 自动导出规则

napm-alert-query 场景（~5 条额外，~500 token）：
├── 告警边界 + 告警契约
├── 告警回答格式（2 条）
└── 告警数据包序列

napm-fault-diagnosis 场景（~3 条额外，~300 token）：
├── 故障诊断路由
├── 故障流参数
└── 报告导出衔接

napm-packet-analysis 场景（~8 条额外，~800 token）：
├── 数据包边界 + 包契约
├── 告警数据包序列 + 触发分析
├── 业务页面预览（2 条）
├── IP 降级禁止
└── 跨技能边界

napm-inspection-snapshot 场景（~3 条额外，~300 token）：
├── 巡检边界 + 巡检契约
└── 报告导出衔接

报告导出通用（~3 条额外，~300 token）：
├── 报告导出声明
├── PDF 禁用
└── follow-up 导出规则
```

#### 3.2.2 动态组合逻辑（伪代码）

```javascript
function buildNapmRoutingSystemContext(guardState = {}) {
  const rules = [];

  // ── 通用规则（始终注入）──
  rules.push(
    GENERAL_ROLE_BOUNDARY,
    GENERAL_RESOLVED_QUERY_OWNERSHIP,
    GENERAL_INPUT_CHANNEL,
    GENERAL_TIME_CONTRACT,
    GENERAL_DISPLAY_TEXT,
    GENERAL_DEBUG_API_URL,
    GENERAL_FRESH_DATA,
    GENERAL_NON_MONITORING_REJECT,
  );

  // ── 场景规则（按需注入）──
  if (guardState.napmRelated && !guardState.alertRelated && !guardState.summaryRelated) {
    // 纯数据查询场景
    rules.push(
      QUERY_BOUNDARY,
      QUERY_CONTRACT_REF,
      QUERY_CLARIFICATION,
      QUERY_BOUNDARY_REJECT,
    );
  }

  if (guardState.summaryRelated || guardState.isSummaryPrompt) {
    rules.push(
      SUMMARY_ROUTING,
      SUMMARY_SCOPE_MAP,
      SUMMARY_BOUNDARY,
      SUMMARY_CONTRACT,
      SUMMARY_AUTO_EXPORT,
    );
  }

  if (guardState.alertRelated || guardState.alertEventPrompt) {
    rules.push(
      ALERT_BOUNDARY,
      ALERT_CONTRACT,
      ALERT_ANSWER_FORMAT,
    );
  }

  if (guardState.faultRelated || guardState.isFaultDiagnosisPrompt) {
    rules.push(
      FAULT_DIAGNOSIS_ROUTING,
      FAULT_FLOW_PARAMS,
      FAULT_REPORT_EXPORT,
    );
  }

  // ... 其他场景同理 ...

  // ── 报告导出规则（多场景共享）──
  if (guardState.reportRelated || guardState.isReportExportPrompt) {
    rules.push(
      REPORT_EXPORT_DECLARATION,
      REPORT_PDF_DISABLED,
      REPORT_FOLLOW_UP,
    );
  }

  return rules.join('\n');
}
```

#### 3.2.3 Hook 改动点

```javascript
// 改前（line 4589-4591）：
return {
  appendSystemContext: buildNapmRoutingSystemContext()  // 全量
};

// 改后：
return {
  appendSystemContext: buildNapmRoutingSystemContext(guardState)  // 动态
};
```

### 3.3 效果预估

| 场景 | 改前 Token | 改后 Token | 节省 |
|------|-----------|-----------|------|
| napm-skill-query（最常见） | ~5,000 | ~1,300 | **-3,700 (-74%)** |
| napm-summary | ~5,000 | ~1,700 | **-3,300 (-66%)** |
| napm-alert-query | ~5,000 | ~1,500 | **-3,500 (-70%)** |
| napm-fault-diagnosis | ~5,000 | ~1,400 | **-3,600 (-72%)** |
| napm-packet-analysis | ~5,000 | ~1,800 | **-3,200 (-64%)** |

### 3.4 前置条件

**好消息**：`before_prompt_build` Hook 已经在 line 4545-4583 完成了完整的 prompt 分类，`guardState` 中已有以下字段可用于路由：

| guardState 字段 | 用途 |
|----------------|------|
| `napmRelated` | 是否为 NAPM 相关查询 |
| `alertRelated` | 是否为告警相关 |
| `alertEventPrompt` | 是否为告警事件查询 |
| `alertMetaFollowUpPrompt` | 是否为告警元数据追问 |
| `domainRelated` | 是否在监控领域内 |
| `generalOutOfScopeRequested` | 是否完全越界 |

**还需要补充的分类**（在 Hook 中已有对应检测函数）：
- `isFaultDiagnosisPrompt(prompt)` → 故障诊断
- `isSummaryPrompt(prompt)` → 综述报告
- `isAlertEventPrompt(prompt)` → 告警事件
- `isPacketAnalysisPrompt(prompt)` → 数据包分析

这些分类函数在 `before_tool_call` Hook 中已经在使用（line 5407-5702），只是没有把结果存入 `guardState`。

---

## 四、方案二：精简 Tool Schema（P1）

### 4.1 问题定位

7 个 Tool 定义合计 25,775 字符、~10,300 token。主要膨胀来源：

#### `createSkillToolDefinition`（5,468 字符）— 最大膨胀源

```javascript
// line 4557-4601: resolvedQuery 的 JSON Schema
resolvedQuery: {
  type: 'object',
  description: 'Required fully resolved query payload. For executable data services such as topValues, averageValues, timeValues, overview, and topValues_multi_protocol, put Unix-second execution timestamps at root-level start and end, aligned to 60-second minute boundaries. Do not put executable timestamps only in timeRange.start/timeRange.end; timeRange is declarative metadata only.',  // ← 296 字符的描述
  properties: {
    service: { type: 'string' },
    queryModeKey: { type: 'string' },
    metrics: { type: 'array', items: { type: 'string' } },
    metric: { type: 'string' },
    topMetric: { type: 'string' },
    groups: { /* 嵌套对象，16 行 */ },
    topCount: { type: 'number' },
    start: { type: 'number', description: 'Auto-filled by plugin from timeRange.key. Do NOT calculate or fill this yourself.' },
    end: { type: 'number', description: 'Auto-filled by plugin from timeRange.key. Do NOT calculate or fill this yourself.' },
    timeRange: { /* 嵌套对象，10 行 */ },
    format: { type: 'string' },
    semanticConstraints: { type: 'object', additionalProperties: true },
    pathPlanning: { type: 'object', additionalProperties: true },
    resolutionHints: { type: 'object', additionalProperties: true }
  },
  required: ['service'],
  additionalProperties: true
}
```

**问题**：
1. `resolvedQuery` 的 `description` 有 296 字符，详细解释时间戳放置规则——但现在时间由 `before_tool_call` Hook 自动覆盖，这些描述**完全多余**
2. `start`/`end` 各有 80+ 字符的 description 告诉 LLM "不要自己计算"——与时间契约重复
3. `timeRange` 的嵌套 schema 有 10 行，其中的 `description`（line 4588）有 200+ 字符
4. `groups` 的嵌套 schema 有 16 行，包含 `type` 和 `argument` 的子属性描述

#### `createAlertQueryToolDefinition`（4,644 字符）

同样的嵌套 schema 膨胀问题，`alertQuery.criteria` 的属性描述极详细。

#### `createPacketAnalysisToolDefinition`（4,530 字符）

数据包查询的 schema 也很详细，包含 `criteria` 的多个子属性。

### 4.2 改造方案

#### 4.2.1 `createSkillToolDefinition` — 精简 `resolvedQuery` schema

**删除/精简**：
- `resolvedQuery.description`：从 296 字符 → `"Structured NAPM query payload produced by OpenClaw upstream resolver."`（~80 字符）
- `start.description`：删除（时间由 Plugin 自动覆盖，LLM 不需要知道这个字段）
- `end.description`：删除（同上）
- `timeRange.description`：从 200+ 字符 → `"Set key only (last1hour|last24hours|today|yesterday|last7days|last30days). Plugin auto-computes start/end."`（~120 字符）
- `groups`：合并为 `type: 'array', items: { type: 'object', additionalProperties: true }`
- `semanticConstraints`/`pathPlanning`/`resolutionHints`：这些是 LLM 不需要关心的内部字段，可以移到 `additionalProperties: true` 覆盖范围

**预估节省**：
```
resolvedQuery schema: 5,468 字符 → ~3,000 字符
节省: ~2,500 字符 → ~1,000 token
```

#### 4.2.2 `createAlertQueryToolDefinition` — 精简 `alertQuery` schema

**删除/精简**：
- 子属性描述中与路由上下文重复的信息（mode 说明、criteria 格式等）
- `additionalProperties: true` 覆盖不需要显式声明的字段

**预估节省**：
```
alertQuery schema: 4,644 字符 → ~3,000 字符
节省: ~1,600 字符 → ~640 token
```

#### 4.2.3 其他 5 个 Tool 定义 — 类似精简

| Tool | 改前字符 | 改后字符 | 节省 Token |
|------|---------|---------|-----------|
| napm-report-export | 1,906 | ~1,200 | ~280 |
| napm-inspection-snapshot | 2,427 | ~1,500 | ~370 |
| napm-summary | 3,231 | ~2,000 | ~490 |
| napm-fault-diagnosis | 3,569 | ~2,200 | ~550 |
| napm-packet-analysis | 4,530 | ~2,800 | ~690 |
| **合计** | **25,775** | **~15,700** | **~4,000** |

### 4.3 效果预估

| 指标 | 改前 | 改后 | 节省 |
|------|------|------|------|
| Tool 定义总 Token | ~10,300 | ~6,300 | **-4,000 (-39%)** |
| Prefill 时间节省 | — | — | **~670ms** |

---

## 五、方案三：合并通用规则消除冗余（P2）

### 5.1 问题定位

当前 49 条路由规则中存在大量**跨场景重复**和**语义重叠**：

#### 5.1.1 跨场景重复

以下规则在多个 Tool 的描述中重复出现：

| 重复内容 | 出现位置 | 出现次数 |
|---------|---------|:---:|
| "先调 X，再调 napm-report-export" | 故障诊断、综述、巡检、告警边界 | 4 次 |
| "Do NOT use napm-skill-query for X" | 故障诊断、综述、告警、数据包 | 4 次 |
| "必须从当前 turn 的 fresh result 回答" | 新鲜数据强制 + 各边界规则中隐式提及 | 3+ 次 |
| "scope.type 映射" | 综述路由 + 综述契约 | 2 次（可合并为 1 条表格） |
| alert 回答格式要求 | 告警 final-answer contract + alert summary template | 2 条（可合并） |

#### 5.1.2 冗余的强调语句

```
"NEVER"      出现 2 次
"CRITICAL"   出现 2 次  
"ABSOLUTE"   出现 1 次
"STRICTLY"   出现 2 次
"MUST"       出现 ~15 次
"IMPORTANT"  出现 2 次
"⚠️"         出现 3 次
"🔴"         出现 2 次
```

这些强调词在 LLM 上下文中效果有限（LLM 不会因为大写就更重视），但增加了 token 消耗。

### 5.2 改造方案

#### 5.2.1 合并同类规则

**改前**（4 条分散的"禁止使用 napm-skill-query"）：
```
规则A（故障诊断）: "NEVER use napm-skill-query or napm-alert-query for fault analysis"
规则B（综述报告）: "Do NOT use napm-skill-query for report requests"
规则C（告警）    : "must call napm-alert-query"
规则D（数据包）  : "Do not answer packet requests by ... falling back to napm-skill-query"
```

**改后**（1 条集中路由表）：
```
TOOL ROUTING TABLE:
  fault/report   → napm-fault-diagnosis → napm-report-export
  summary/report → napm-summary → napm-report-export
  alert/packet   → napm-alert-query → napm-packet-analysis
  data query     → napm-skill-query (→ napm-report-export if export requested)
  inspection     → napm-inspection-snapshot → napm-report-export
  packet         → napm-packet-analysis
  export only    → napm-report-export (with existing reportData)
```

#### 5.2.2 去掉无用的强调词

```
改前: "🔴 ABSOLUTE ROUTING PRIORITY #1 — FAULT DIAGNOSIS: When the user asks..."
改后: "Fault diagnosis → napm-fault-diagnosis. Pass flowType, target, timeRange."

改前: "CRITICAL ROUTING RULE: When the user asks for 综述报告..."
改后: "Summary report → napm-summary with scope+timeRange, then napm-report-export."

改前: "STRICTLY FORBIDDEN: adding 建议关注/按严重程度..."
改后: "Output alert result verbatim. No extra sections or formatting."
```

#### 5.2.3 Scope 映射表压缩

**改前**（1 条 330 字符的规则）：
```
Scope mapping — set scope.type based on user wording:
  全局/系统/NAPM 综述 → scope.type="global", scope.label="全局";
  业务 综述 → scope.type="webApplication", scope.label="业务";
  网络/流量 综述 → scope.type="network", scope.label="网络";
  工作组/业务组 综述 → scope.type="businessGroup", scope.label="工作组";
  应用 综述 → scope.type="application", scope.label="应用";
  告警 综述 → scope.type="alert", scope.label="告警".
```

**改后**（紧凑映射表）：
```
scope.type: {全局→global, 业务→webApplication, 网络→network, 工作组→businessGroup, 应用→application, 告警→alert}
```

### 5.3 效果预估

| 指标 | 改前 | 改后 | 节省 |
|------|------|------|------|
| 路由规则条数 | 49 | ~25 | — |
| 规则总字符 | 12,607 | ~6,500 | -48% |
| 规则总 Token | ~5,000 | ~2,600 | **-2,400 (-48%)** |

---

## 六、方案四：模型层面优化（P3）

### 6.1 问题定位

DeepSeek Chat 的实测性能：
- Prefill 速度：~6,000 tok/s
- Generation 速度：~30-50 tok/s（中文）
- API 网络延迟（国内→DeepSeek）：~100-200ms

在当前 16,000 token 输入下：
- Prefill：~2,700ms
- Generation（200 token 输出）：~4,000-6,000ms
- 网络 + 调度：~1,000ms

### 6.2 可选方案

| 方案 | 预期 Prefill | 预期 Generation | 端到端预期 | 风险 |
|------|:---:|:---:|:---:|------|
| **保持 DeepSeek Chat** + P0/P1/P2 | ~1,600ms | ~4,000ms | **~7s** | 无 |
| **切换 DeepSeek-V3** | ~1,200ms | ~3,000ms | **~5.5s** | 中：需评估 API 兼容性和成本 |
| **混合模型**（复杂查询用 V3，简单格式化用 Chat） | — | — | **4-7s** | 高：需要路由逻辑 |

**建议**：先执行 P0/P1/P2（纯 prompt 优化、零风险），观察效果后再决定是否切换模型。

### 6.3 DeepSeek 平台可调参数

这些参数在 OpenClaw 配置中调整，不涉及 NAPM 代码：

| 参数 | 当前推测值 | 建议值 | 影响 |
|------|:---:|:---:|------|
| `temperature` | 0.7 (默认) | 0.3 | 降低随机性、加速生成 |
| `max_tokens` | 4096 (默认) | 2048 | 限制输出长度、减少不需要的长回答 |
| `top_p` | 1.0 (默认) | 0.9 | 缩小采样空间 |

> **注意**：这些参数在 OpenClaw 的 agent 配置中设置（`agents/openai.yaml` 或 settings），不在 Plugin 代码中。

---

## 七、综合效果预测

### 7.1 各方案叠加效果

| 方案 | 输入 Token | Prefill 时间 | Generation 时间 | 端到端 |
|------|:---:|:---:|:---:|:---:|
| **当前** | 16,000 | 2,700ms | ~5,000ms | **10.3s** |
| P0 动态上下文 | 12,300 | 2,100ms | ~5,000ms | **8.8s** |
| P0 + P1 (Tool 精简) | 8,300 | 1,400ms | ~4,500ms | **7.5s** |
| P0 + P1 + P2 (规则压缩) | 6,400 | 1,100ms | ~4,500ms | **7.0s** |
| P0 + P1 + P2 + P3 (模型参数) | 6,400 | 1,100ms | ~3,500ms | **6.0s** |

### 7.2 最常见场景（napm-skill-query）的改善

```
改前 (10.3s):
████████████  Prefill 2.7s
          ████████████████████████  Generation 5.0s
                               ██  其他 2.6s

改后 (7.0s, P0+P1+P2):
██████  Prefill 1.1s (-59%)
       ████████████████████  Generation 4.5s (-10%)
                           █  其他 1.4s (-46%)
```

---

## 八、实施顺序建议

| # | 方案 | 工作量 | 风险 | 预期节省 | 依赖 |
|---|------|:---:|:---:|:---:|------|
| 1 | **P2: 规则合并压缩** | 低（纯文本改写） | **极低** | -2,400 token | 无 |
| 2 | **P0: 动态上下文注入** | 中（需改 Hook 逻辑） | **低** | -3,700 token | P2 之后（规则已分类） |
| 3 | **P1: Tool Schema 精简** | 中（需改 7 个函数） | **中** | -4,000 token | 无 |
| 4 | **P3: 模型参数调优** | 低（改 OpenClaw 配置） | **低** | -1,000ms generation | 无 |

**推荐顺序理由**：
1. **P2 先做**：风险最低（只改文本内容，不改注入逻辑），可以立即验证效果
2. **P0 在 P2 之后**：P2 将规则分类整理后，P0 的动态注入逻辑更容易实现
3. **P1 独立进行**：不依赖 P0/P2，但需要测试确保 LLM 仍然正确构造参数
4. **P3 最后试探**：在 prompt 优化效果不达预期时启用

### 渐进验证策略

```
每个方案实施后：
  1. 本地语法检查
  2. 推送到远端
  3. 重启 Gateway
  4. 发送 3 种典型查询（data query / alert / summary）验证
  5. 对比耗时变化
```

---

## 九、风险与回滚

### 9.1 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|:---:|------|------|
| **P2 规则压缩后 LLM 路由错误** | 低 | LLM 选错 Tool，用户得到错误回答 | 保留关键词触发词（故障→fault-diagnosis，告警→alert-query 等），这些是路由的核心信号 |
| **P0 动态注入时 guardState 分类错误** | 中 | 新对话首条消息可能被误分类，缺少必要规则 | 保留"通用规则"始终注入（~8 条覆盖基本场景），场景规则用保守策略（疑似时多注少漏） |
| **P1 Tool Schema 精简后 LLM 参数构造错误** | 中 | LLM 可能遗漏必填字段 | 保留 `required: ['service']` 等 JSON Schema 约束，只在 description 层面精简 |
| **P0 分类函数依赖 prompt 文本匹配** | 低 | 用户用非常规措辞时分类失败 | 使用已有的 `isFaultDiagnosisPrompt` 等函数，它们的模式匹配已经过大量生产验证 |

### 9.2 回滚方案

| 方案 | 回滚方式 |
|------|---------|
| P2 | 恢复 `buildNapmRoutingSystemContext()` 的旧版文本（Git revert） |
| P0 | Feature flag 控制：`NAPM_DYNAMIC_CONTEXT=0` 时回退到全量注入 |
| P1 | Git revert 7 个 Tool 定义函数 |
| P3 | 恢复 OpenClaw agent 配置中的旧参数值 |

### 9.3 监控指标

部署后应关注的指标：

| 指标 | 当前基线 | 目标 | 查看方式 |
|------|:---:|:---:|------|
| 端到端耗时（T0→T1） | 10.3s | < 8s | 主日志 `kind=final - aibot_msg_callback` |
| Prefill 时间（T0→首个 streamId） | 2.0s | < 1.2s | 主日志 `streamId finish=false - aibot_msg_callback` |
| LLM 推理时间（streamId→kind=final） | 8.0s | < 6s | 主日志 `kind=final - streamId` |
| Tool 选择准确率 | — | > 95% | 人工审查 audit.log 中的 Tool 调用 |
| 首次 API 成功率 | — | > 80% | combined.log 中 `NAPM API response received` vs `request failed` |

---

## 附录 A：路由规则分类详解

### 通用规则（8 条，始终注入）

```
1. 角色边界: "Only handle system monitoring, NAPM query, anomaly diagnosis requests."
2. resolvedQuery 所有权: "OpenClaw upstream owns resolvedQuery construction."
3. 输入通道: "Accepted structured input: payload.resolvedQuery."
4. 时间契约: "Set timeRange.key only. Plugin computes start/end from server clock."
5. 时间示例: "{service, timeRange:{key:'last1hour',displayText:'最近1小时'}}. No start/end."
6. displayText 优先: "Prefer using displayText directly instead of paraphrasing."
7. Debug API URL: "If result contains requestUrl, append Debug API: URL at end."
8. 新鲜数据: "Never answer from stale memory. Base reply on fresh tool result."
9. 非监控拒绝: "Non-monitoring requests → redirect to system monitoring."
```

### 场景规则（按 guardState 动态注入）

#### 数据查询场景（guardState.napmRelated, ~4 条）
```
Q1. 查询边界: "Metric/ranking/average/trend/overview → napm-skill-query."
Q2. 查询契约引用: "Construction rules in query-workflow-contract.md."
Q3. 澄清/回答: "ASK_CLARIFYING_QUESTION → ask. ANSWER_CONCEPTUALLY → answer."
Q4. 边界拒绝: "REJECT_AND_REDIRECT → explain out of boundary."
```

#### 综述报告场景（guardState.summaryRelated, ~5 条）
```
S1. 综述路由: "Summary report → napm-summary with scope+timeRange."
S2. Scope 映射: {全局→global, 业务→webApplication, 网络→network, ...}
S3. 综述边界: "napm-summary queries alert/traffic/business in parallel."
S4. 综述契约: "scope type+target, timeRange start/end."
S5. 自动导出: "After napm-summary, ALWAYS call napm-report-export."
```

#### 告警场景（guardState.alertRelated, ~3 条）
```
A1. 告警边界: "告警 → napm-alert-query with alertQuery."
A2. 告警契约: "mode=summary|timeline|detail|detail_with_timeseries|explain_notification."
A3. 回答格式: "Output alert result verbatim. No extra formatting."
```

...（其余场景同理）
