# NAPM BUG-A Phase 1：Truth Source 收口实施报告

## 1. 结论

Phase 1 已完成，并在 Truth Source 收口后停止，没有进入 Phase 2。

本阶段完成四类权威源统一：

1. Resolution Spec 只保留 Skill-local canonical 文件；
2. Object Ontology 只保留 Skill-local canonical 文件；
3. Object × Metric ownership 只保留 Skill-local规则表，根入口改为薄转发；
4. Metric ID Catalog 只保留 Skill-local `metrics-config.yml`，配置失败不再静默加载 42 个内置指标。

同时新增了未接入执行门禁的 ownership 三态 API，以及六项 runtime-contract 防漂移规则。QueryDecisionPolicy、Gateway、Direct、Resolver、Validator、Kernel 等 Phase 2+ 执行语义没有修改。

## 2. Git 基线与备份

```text
branch: codex/napm-turn-decision-phase1
HEAD: c07a652aa80dd593ecf3546fe41f8f621175491a
```

Phase 1 开始前 `git status --short`：

```text
 M memory/2026-09-08.md
?? docs/2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案.md
?? docs/2026-09-09-NAPM-BUG-A-Phase0-基线冻结与Characterization测试报告.md
?? memory/2026-09-09.md
?? test/bug-a-phase0-execution-characterization.test.js
?? test/bug-a-phase0-metric-contract-characterization.test.js
?? test/bug-a-phase0-plugin-characterization.test.js
?? test/bug-a-phase0-semantic-characterization.test.js
?? test/bug-a-phase0-truth-source-characterization.test.js
?? test/helpers/
```

Phase 1 修改前备份：

```text
C:\Users\20693\AppData\Local\Temp\codex-napm-bug-a-phase1-pre-20260909-111005
```

备份包含 Phase 0 与 Phase 0 之前的 10 个未提交文件。未执行 reset、stash、checkout 覆盖或自动提交。

Phase 1 结束时 HEAD 未变化，`git status --short`：

```text
 M AGENTS.md
 M CLAUDE.md
 M CONTEXT.md
 M PROJECT.md
 D config/metrics-config.yml
 D config/napm-resolution-spec.v1.json
 D config/object-ontology.v1.json
 M memory/2026-09-08.md
 M scripts/verify-napm-skill-runtime-contract.js
 M skills/openclaw-napm-alert-query/services/AlertIndirectPacketDiscoveryService.js
 M skills/openclaw-napm-query/SKILL.md
 M skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
 M skills/openclaw-napm-query/services/MetricMappingService.js
 M skills/openclaw-napm-query/src/constants/objectMetricOwnership.js
 M src/constants/objectMetricOwnership.js
?? docs/2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案.md
?? docs/2026-09-09-NAPM-BUG-A-Phase0-基线冻结与Characterization测试报告.md
?? docs/2026-09-09-NAPM-BUG-A-Phase1-Truth-Source收口实施报告.md
?? memory/2026-09-09.md
?? test/bug-a-phase0-execution-characterization.test.js
?? test/bug-a-phase0-metric-contract-characterization.test.js
?? test/bug-a-phase0-plugin-characterization.test.js
?? test/bug-a-phase0-semantic-characterization.test.js
?? test/bug-a-phase0-truth-source-characterization.test.js
?? test/bug-a-phase1-object-metric-ownership.test.js
?? test/bug-a-phase1-runtime-contract.test.js
?? test/helpers/
```

工作区保持未提交是本轮明确要求；没有整理、覆盖或提交既有修改。

### 2.1 变更归属

Phase 0 之前已有：

- `memory/2026-09-08.md`
- `docs/2026-09-08-NAPM-对象指标语义与查询执行契约最终实施方案.md`
- `memory/2026-09-09.md`

Phase 0 已有：

- `docs/2026-09-09-NAPM-BUG-A-Phase0-基线冻结与Characterization测试报告.md`
- 5 个 `bug-a-phase0-*` Characterization 套件
- `test/helpers/bug-a-phase0-southbound-call-counter.js`

Phase 1 新增或修改：见第 4 节。Phase 0 的 truth-source 测试按实施指令迁移为新契约，Phase 0 报告继续保留旧行为证据。

## 3. 全部读取者审计

### 3.1 Resolution Spec

- 运行时唯一加载器是 `skills/openclaw-napm-query/services/ResolutionSpecService.js`，固定读取 Skill-local 配置。
- Plugin 通过该 Service 动态加载，不直接读取根配置。
- 未发现构建或发布脚本必须直接读取根 Resolution Spec。
- 根副本与 Skill-local 内容已漂移，因此删除根副本，不保留人工镜像。

### 3.2 Object Ontology

- 运行时唯一加载器是 `ObjectOntologyService.js`，固定读取 Skill-local 配置。
- 未发现运行时、构建或发布代码直接读取根 ontology。
- 根副本缺少 `TotalTraffic` 且已漂移，因此删除。

### 3.3 Object × Metric ownership

- Query Skill 内的 RequirementParser、QueryMetadataConstraint、Narration、MetricInventory 等读取 Skill-local模块。
- 根同名模块只被旧测试入口引用。
- 为保持入口兼容，根模块改成单行语义的 CommonJS 薄转发，不再复制规则表。

### 3.4 Metric Catalog

- Query 的 `MetricMappingService` 已读取 Skill-local `metrics-config.yml`。
- 唯一额外读取者是 Alert Skill 的指标中文标签展示逻辑，原先读取根配置；现已改为读取相同的 Skill-local canonical 文件。
- 未发现构建或发布流程要求根副本存在，因此删除根 `metrics-config.yml`。

### 3.5 Resolution Spec 旧 ownership 字段

全仓生产 JavaScript 未发现直接读取以下字段用于准入：

```text
ownershipRules
ownershipMatrix
compatibleObjectTypes
preferredObjectTypes
ownershipClass
```

这些字段仍留在 canonical Resolution Spec 供旧数据兼容，新增 `executionOwnershipDeprecation` 明确标记：

- `status=deprecated`；
- canonical runtime source 为 `src/constants/objectMetricOwnership.js`；
- 禁止新的执行准入读取者；
- 计划在后续迁移完成后物理删除。

## 4. 文件变更

| 文件 | 修改类型 | Phase 1 目的 | 是否改变 Query 执行语义 |
|---|---|---|---|
| `config/napm-resolution-spec.v1.json` | 删除 | 消除漂移的根副本 | NO |
| `config/object-ontology.v1.json` | 删除 | 消除漂移的根副本 | NO |
| `config/metrics-config.yml` | 删除 | 消除第二个 Metric Catalog 文件 | NO；加载行为见下项 |
| `skills/openclaw-napm-query/config/napm-resolution-spec.v1.json` | 修改 | 标记旧 execution ownership 字段 deprecated | NO |
| `skills/openclaw-napm-query/services/MetricMappingService.js` | 修改 | 唯一 Catalog 严格加载、失败 fail closed、别名不创建新 ID | **仅改变 Catalog 加载失败行为** |
| `skills/openclaw-napm-query/src/constants/objectMetricOwnership.js` | 修改 | 新增精确路径、基线绑定的三态 API | NO，未接入门禁 |
| `src/constants/objectMetricOwnership.js` | 重构 | 根入口改为 Skill-local 薄转发 | NO |
| `skills/openclaw-napm-alert-query/services/AlertIndirectPacketDiscoveryService.js` | 修改 | 告警标签读取同一 Metric Catalog | NO，配置内容原本相同 |
| `scripts/verify-napm-skill-runtime-contract.js` | 修改 | 新增六项 Truth Source 校验 | NO |
| `test/bug-a-phase0-truth-source-characterization.test.js` | 迁移 | 用新正式契约替换 Phase 0 错误 fallback/双副本行为 | NO |
| `test/bug-a-phase1-object-metric-ownership.test.js` | 新增 | 三态矩阵与 Policy 未接线 guard | NO |
| `test/bug-a-phase1-runtime-contract.test.js` | 新增 | 六项规则正向和负向测试 | NO |
| `AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`、`PROJECT.md`、Query `SKILL.md` | 修改 | 同步唯一来源和阶段边界 | NO |
| 本报告、`memory/2026-09-09.md` | 新增/追加 | 留下实施与复查记录 | NO |

## 5. Authoritative Source Result

```text
Resolution Spec canonical:
skills/openclaw-napm-query/config/napm-resolution-spec.v1.json
root spec status: deleted

Object Ontology canonical:
skills/openclaw-napm-query/config/object-ontology.v1.json
root ontology status: deleted

ObjectMetricOwnership canonical:
skills/openclaw-napm-query/src/constants/objectMetricOwnership.js
root ownership status: thin re-export

Metric Catalog canonical:
skills/openclaw-napm-query/config/metrics-config.yml
root metrics-config status: deleted
```

## 6. Duplicate Source Audit

已消除：

- 根与 Skill-local Resolution Spec 双文件；
- 根与 Skill-local Object Ontology 双文件；
- 根与 Skill-local Metric Catalog 双文件；
- 根与 Skill-local ownership 复制规则表。

暂时保留的兼容投影：

- 根 `src/constants/objectMetricOwnership.js`，只做薄转发，不含规则数据。

后续阶段仍需移除的 legacy 数据：

- Resolution Spec 内 `ownershipRules`、`ownershipMatrix`；
- `metrics.catalog.*` 内 `compatibleObjectTypes`、`preferredObjectTypes`、`ownershipClass`。

这些字段本阶段只降级和封禁新执行读取，未提前物理删除。

## 7. Ownership Tri-State Result

新增 API：

```js
classifyObjectMetricCompatibility({
  service,
  groupPath,
  metricId,
  productBaseline
})
```

返回值仅为：

```text
KNOWN_COMPATIBLE
KNOWN_INCOMPATIBLE
UNKNOWN
```

当前项目没有可信的本地运行环境产品版本或 capability baseline，因此生产调用未提供基线时确定返回 `UNKNOWN`。`DOCUMENTED_PRODUCT_BASELINE` 绑定已在本地核验的两份接口材料，但当前没有任何 Query 执行组件自动声称运行环境匹配它。

| service | groupPath | metric | baseline | exhaustive | result |
|---|---|---|---|---|---|
| topValues | WebApplication | PGTME | match | true | KNOWN_COMPATIBLE |
| topValues | WebApplication | TRTI | match | true | KNOWN_INCOMPATIBLE |
| topValues | WebApplication→PageFamily | PGTME | match | false | UNKNOWN |
| topValues | DefinedApp | TRTI | match | 无精确覆盖 | UNKNOWN |
| averageValues | WebApplication | PGTME | match | 无精确覆盖 | UNKNOWN |
| topValues | WebApplication | PGTME | mismatch | true | UNKNOWN |
| topValues | WebApplication | PGTME | unknown | true | UNKNOWN |
| topValues | WebApplication | PGSUPERFAST | match | true | KNOWN_INCOMPATIBLE；不输出 METRIC_UNKNOWN |

最后一行只表示该 ID 不在精确 ownership allow-list；指标是否存在必须先由 Metric Catalog 判断。

```text
是否接入 QueryDecisionPolicy：NO
是否接入 RequirementParser / Kernel：NO
是否改变 southbound 行为：NO
```

旧 boolean API 保持原行为，包括未知 path 仍可能返回 `true`；后续 Phase 4 才迁移执行准入。

## 8. Metric Catalog Result

| 场景 | 结果 |
|---|---|
| valid config | 加载配置声明的 107 个合法 ID；测试最小目录只产生其声明的 1 个 ID |
| missing config | 抛出 `METRIC_CATALOG_NOT_FOUND` |
| invalid YAML | 抛出 `METRIC_CATALOG_PARSE_FAILED` |
| read failure | 抛出 `METRIC_CATALOG_READ_FAILED` |
| invalid structure | 抛出 `METRIC_CATALOG_INVALID` |
| unknown metric `PGSUPERFAST` | `isValidMetricCode=false` |
| supplemental alias | 仅在 Catalog 已声明相同 code 时添加描述，不创建新合法 ID |

```text
是否仍会加载 42 built-in fallback：NO
```

这是 Phase 1 唯一有意替换的 Phase 0 运行行为：从“目录坏了仍继续”改为明确失败。Phase 0 报告仍保留原行为证据。

## 9. Runtime Contract 新规则

| 规则 | 结果 | 负向测试 |
|---|---|---|
| Resolution Spec uniqueness | PASS | 根副本重现时 FAIL |
| Object Ontology uniqueness | PASS | 根副本重现时 FAIL |
| Ownership uniqueness | PASS | 根入口出现独立规则表时 FAIL |
| Metric Catalog uniqueness | PASS | 根副本重现时 FAIL |
| No runtime metric fallback | PASS | `loadDefaultMetrics`/内置默认表重现时 FAIL |
| No new Resolution Spec execution ownership consumer | PASS | Query 或 Plugin 执行组件读取旧字段时 FAIL |

运行时校验仍同时检查 8 个生产 Tool 均导出进程内 `handleSkillCall`。

## 10. Phase 0 非目标行为回归

下列错误或历史兼容行为在 Phase 1 仍由 Characterization Tests 锁定，没有提前进入 Phase 2/4：

| 非目标行为 | Phase 1 后状态 |
|---|---|
| Policy `WebApplication + TRTI` | 仍 `EXECUTE_QUERY` |
| Gateway `WebApplication + TRTI` | 仍 metadata + data 调用 |
| Direct `WebApplication + TRTI` | 仍可绕过 Policy 直接执行 |
| BottomN asc | 仍对上游 TopN 做本地升序重排 |
| Plugin `topMetric in metrics[]` | 仍要求包含 |
| QueryValidator legacy `metric` | 仍要求单数 metric |
| Kernel metric fallback | 仍使用现有 `topMetric || metric`/CSV 兼容 |
| Metadata overload | 仍按 groups 存在与否切 provider |
| Error message NO_DATA guessing | 仍可按 `empty/no data` 文本猜测 |

这些行为均属于后续 Phase，不在本阶段修复。

## 11. 测试结果

```text
Phase 0 suites: 5 passed / 69 tests passed
Phase 1 suites: 2 passed / 19 tests passed
Phase 0 + Phase 1: 7 suites passed / 88 tests passed

full repo: 123 suites passed / 1131 tests passed
snapshots: 0

npm test -- --runInBand: PASS
npm run lint: PASS
npm run verify:runtime-contract: PASS
git diff --check: PASS
```

所有 NAPM 调用测试使用 fake client 和 `example.invalid`；没有访问真实南向接口。

## 12. 边界与遗留风险

1. 三态 API 已建立但故意未接门禁，因此当前用户问题“慢业务 Top5”的错误指标/对象执行行为尚未修复；这是 Phase 2+ 的工作。
2. 当前运行环境没有可信本地 baseline 注入，所以三态生产默认 `UNKNOWN`。后续接线前必须建立可信 baseline 或 runtime capability 证明，不能直接使用模型或普通环境变量声明。
3. Resolution Spec 旧 ownership 字段仍存在，计划在消费者迁移完成后的阶段物理删除；runtime-contract 已阻止新增直接执行读取者。
4. `MetricMappingService.validateAndFixMetrics()` 与 Metric Kernel 的 legacy metric fallback 未在本阶段修改；它们不同于已经移除的“Catalog 加载失败后注入 42 个合法 ID”。
5. 删除根配置会在未来完整发布的 `rsync --delete` 中清理活动 workspace 根副本；本阶段没有制作包或部署。

## 13. 明确声明

```text
是否修改版本号：NO
是否制作发布包：NO
是否连接远端 NAPM：NO
是否连接、修改或重启服务器：NO
是否部署：NO
是否提交 commit：NO
是否进入 Phase 2：NO
Phase 1 是否完成：YES
```
