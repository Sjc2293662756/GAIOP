---
name: openclaw-napm-fault-diagnosis
description: 【路由优先】当用户要求对一个业务/Web应用做故障分析并出报告时，这是唯一正确的 Skill。覆盖所有"分析XXweb的故障""XXweb报错分析""业务故障报告""Web应用4xx/5xx错误诊断""HTTP错误分析+出报告"场景。三步标准化流程：4xx/5xx报错→页面错误Top20→状态码详情，一次调用直接生成 .docx 报告。不要用 openclaw-napm-query 来拼故障报告——本 Skill 内部已封装全部 NAPM 查询和报告生成。
---

# NAPM 故障诊断分析 Skill

## 🚨 路由规则（必读）

**以下用户说法，必须路由到本 Skill，禁止使用 openclaw-napm-query：**

| 用户说法 | 正确路由 |
|---------|---------|
| "分析一下 业务 XXweb 的故障情况" | → `napm-fault-diagnosis` |
| "分析XXweb的故障，给出故障报告" | → `napm-fault-diagnosis` |
| "XXweb报错分析" | → `napm-fault-diagnosis` |
| "XX业务 HTTP 400/500 错误诊断" | → `napm-fault-diagnosis` |
| "给XXweb出故障报告" | → `napm-fault-diagnosis` |

**只有当用户问的是单个指标查询（如"哪个业务报错最多""XX业务的HTTP 400数量""最近24小时TPIO趋势"）时，才用 openclaw-napm-query。**

## Skill Boundary

**必须用本 Skill：**
- 用户要求分析某个业务/Web应用/应用的故障情况 → B/S 业务慢流程（`bs_app_slow`）
- 用户要求分析客户端软件/数据库/非Web应用的慢问题 → C/S 应用慢流程（`cs_app_slow`）
- 用户要求分析全网慢/带宽占满/流量异常 → 网络慢流程（`network_slow`）
- 用户说"分析XX故障，给出报告"——**直接走标准化流程，不要拆成多次查询**

**不要用本 Skill：**
- 单个指标查询（如"哪个业务报错最多"、"最近24小时TPIO"） → `openclaw-napm-query`
- 综述报告/日报/周报 → `openclaw-napm-summary`
- 巡检报告 → `openclaw-napm-inspection`
- 数据包下载和分析 → `openclaw-napm-packet-analysis`
- 报告文件生成（本 Skill 已内置） → 无需额外调 `openclaw-napm-report`

## 支持的故障分析流程

| 流程 | flowType | 模式 | 步骤 | 适用场景 |
|------|---------|------|:--:|---------|
| B/S 业务慢 | `bs_app_slow` | 标准化单次调用 | 3 步 | Web 页面 4xx/5xx 报错、页面错误分析、状态码详情 |
| C/S 应用慢 | `cs_app_slow` | 标准化单次调用 | 2 步 | 客户端软件慢、数据库访问慢 |
| 网络慢 | `network_slow` | 交互式多轮 | 4 步 | 全网慢、带宽占满、流量异常 |

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
  "flowType": "bs_app_slow",
  "target": {
    "groupType": "WebApplication",
    "groupArgument": "回溯238web",
    "groupLabel": "回溯238web"
  },
  "timeRange": {
    "faultWindow": { "start": 1782805440, "end": 1782891840 }
  }
}
```

**返回**：`{ ok: true, reportReady: true, filePath: "...", fileName: "...", downloadUrl: "..." }`
文件已内置生成，不需要再调 `napm-report-export`。
