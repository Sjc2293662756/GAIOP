---
name: openclaw-napm-fault-diagnosis
description: 【路由优先】NAPM 故障诊断分析 Skill。⚠️ 重要：flowType 参数由工具内部根据 NAPM 目录自动检测，调用时不需要传 flowType——工具会自动判断是业务故障分析(bs_app_slow)还是应用故障分析(cs_app_slow)。只需传 description + timeRange，target 也会自动补全。覆盖两类对象：① 业务（WebApplication/Type=3）：HTTP 错误/4xx/5xx；② 应用（DefinedApp/Type=2 等）：用户体验时间拆分/波峰客户端定位。
---

# NAPM 故障诊断分析 Skill

## 🚨🚨 调用前必读：不要自己猜 flowType！🚨🚨

**工具内部已实现 NAPM 目录自动检测。调用时：**
- ❌ **不要传 `flowType`** —— 工具会根据 NAPM applications 目录自动判断
- ❌ **不要自己猜 target.groupType** —— 工具会自动查 catalog 补全
- ✅ **只需传 `description` + `timeRange`** —— target 可选，工具会自动补全

**用户说"应用故障分析"但工具判定为"业务"？信任工具判定——它查了 NAPM 目录，比你的猜测准确。**

NAPM 系统中严格区分两个对象类型，**选错流程会导致分析结果完全不对**：

| | 业务（WebApplication） | 应用（DefinedApp 等） |
|---|---|---|
| **NAPM Type** | Type=3 | Type=2（1/4 映射到 2） |
| **中文关键词** | 业务、业务系统、Web应用、网站、web | 应用、已定义应用、协议应用、客户端软件 |
| **协议层** | HTTP/HTTPS | TCP/UDP |
| **故障分析流程** | `bs_app_slow` — B/S 架构业务慢 | `cs_app_slow` — C/S 架构应用慢 |
| **分析锚点** | 页面 URL → HTTP 状态码 | 时间波峰 → 用户体验时间成分 |
| **报告标题** | `_业务故障分析报告` | `_应用故障分析报告` |

**你不需要自己判断走哪个流程。** 直接把用户的原始描述传给工具的 `description` 参数。工具内部自动完成：名称提取 → NAPM 目录查询 → Type 判定 → flowType 选择。不要自己去调 `applications` API 来判断类型——这是工具的内部逻辑。

## 🚨 路由规则（必读）

**以下用户说法，必须路由到本 Skill，禁止使用 openclaw-napm-query：**

| 用户说法 | 正确路由 | flowType |
|---------|---------|----------|
| "分析一下 业务 XXweb 的故障情况" | → `napm-fault-diagnosis` | `bs_app_slow` |
| "XXweb报错分析" | → `napm-fault-diagnosis` | `bs_app_slow` |
| "XX业务 HTTP 400/500 错误诊断" | → `napm-fault-diagnosis` | `bs_app_slow` |
| "XX的应用故障分析报告" | → `napm-fault-diagnosis` | `cs_app_slow` |
| "XX应用慢，帮我分析" | → `napm-fault-diagnosis` | `cs_app_slow` |
| "分析XX应用的故障" | → `napm-fault-diagnosis` | `cs_app_slow` |
| "客户端软件慢/数据库访问慢" | → `napm-fault-diagnosis` | `cs_app_slow` |

**只有当用户问的是单个指标查询（如"哪个业务报错最多""XX业务的HTTP 400数量""最近24小时TPIO趋势"）时，才用 openclaw-napm-query。**

## Skill Boundary

**必须用本 Skill：**
- 用户要求分析某个 **业务/Web 应用** 的故障 → `bs_app_slow`（业务故障分析）
- 用户要求分析某个 **应用/客户端软件/数据库** 的故障 → `cs_app_slow`（应用故障分析）
- 用户说"应用故障分析报告"、"业务故障分析报告" → 直接按对应 flowType 调用
- 用户要求分析全网慢/带宽占满/流量异常 → `network_slow`
- 用户说"分析XX故障，给出报告"——**直接走标准化流程，不要拆成多次查询**

**不要用本 Skill：**
- 单个指标查询 → `openclaw-napm-query`
- 综述报告/日报/周报 → `openclaw-napm-summary`
- 巡检报告 → `openclaw-napm-inspection`
- 数据包下载和分析 → `openclaw-napm-packet-analysis`
- 报告文件生成（本 Skill 已内置） → 无需额外调 `openclaw-napm-report`

## 支持的故障分析流程

| 流程 | flowType | 对象类型 | 步骤 | 适用场景 |
|------|---------|---------|:--:|---------|
| B/S 业务慢 | `bs_app_slow` | WebApplication (Type=3) | 3 步 | Web 页面 4xx/5xx 报错、页面错误分析、状态码详情 |
| C/S 应用慢 | `cs_app_slow` | DefinedApp (Type=2/1/4) + OtherApp | 3 步 | 客户端软件慢、应用性能退化、用户体验波峰定位 |
| 网络慢 | `network_slow` | 全局 | 4 步 | 全网慢、带宽占满、流量异常 |

---

## B/S 业务慢标准化流程（3 步）

**这是最常用的流程。** 报告模板 `napm_bs_fault_diagnosis_v2`，封面→目录→§8 结构。

```
Step 1 — 查询业务基本情况（averageValues，1 次 API 调用）
  指标: PGNPGE, PGTME, PGNSLPGE, PGSLPCT, PGHTTP400, PGHTTP500, PGBYTI, PGBYTO
  表格: 页面访问数 | HTTP 400 | 400 占比 | HTTP 500 | 500 占比

Step 2 — 页面错误分析 Top 20（topValues 三层钻取，1 次 API 调用）
  路径: WebApplication → PageFamilies → PageFamily
  指标: PGNPGE, PGNOBJE, PGHTTP200, PGHTTP300, PGHTTP400, PGHTTP500
  排序: PGHTTP500, Top 20
  表格: 页面路径 | 访问数 | 响应数 | 200 | 300 | 400 | 500

Step 3 — 页面状态码详情（pageViews，对 Step2 每个页面 1 次 API 调用）
  参数: pageFamilyId（从 Step2 的 groupPath 中正则提取 /page\s+(\d+)/i）
  表格: 页面路径 | 访问数 | 200 | 300 | 400 | 500 | 异常判断
```

### 报告结构（§8）

封面 → 目录 → 1 基本信息 → 2 分析过程（2.1/2.2/2.3 每步含表格+判断提示）→ 3 证据项 → 4 根因判断（条件叙述，AND/OR）→ 5 处置建议 → 6 验证方式

---

## 调用方式

**标准化流程（B/S、C/S）— 单次调用，一次拿到 .docx 文件路径：**

```json
{
  "description": "回溯238web 页面大量 HTTP 400/500 报错",
  "timeRange": {
    "faultWindow": { "start": 1782805440, "end": 1782891840 }
  }
}
```
**这就是全部参数。** 不要传 `flowType`、不要传 `target`——工具会自动补全。

**返回**：`{ ok: true, reportReady: true, filePath: "...", fileName: "...", downloadUrl: "..." }`
文件已内置生成，不需要再调 `napm-report-export`。
