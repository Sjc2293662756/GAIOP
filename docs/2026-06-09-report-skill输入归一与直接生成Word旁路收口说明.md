# Report Skill 输入归一与直接生成 Word 旁路收口说明

## 背景

企业微信中出现过如下链路：

```text
用户：将以上总结为报告以word的形式给我
模型：直接构建一份word文档，并通过 MEDIA 发送
```

该链路没有出现 `napm_report_export_invoked` / `napm_report_export_completed` 审计记录，说明文件生成绕过了 `napm-report-export` 和 `openclaw-napm-report`。

这不符合当前 skill 化方向：

- query skill 负责真实查询。
- packet skill 负责数据包预览、下载、分析。
- report skill 负责报告输入校验和 docx 文件生成。
- plugin 只保留工具注册、最近结果缓存、审计和硬边界，不继续承载报告业务编排。

## 本次调整

### 1. Report skill 增加输入归一层

新增：

```text
skills/openclaw-napm-report/services/ReportInputContractService.js
```

职责：

- 接收显式 `reportData`。
- 接收 query skill 返回的 `result.reportData`。
- 接收 packet skill 返回的结构化结果，并转换为 `reportData.sections`。
- 归一 `word/doc` 为 `docx`。
- 不查询 NAPM，不下载数据包，不理解原始自然语言查询。

支持输入形态：

```json
{ "reportData": { "...": "..." } }
```

```json
{ "sourceResult": { "reportData": { "...": "..." } } }
```

```json
{ "sourceResult": { "narrationInput": { "schema": "openclaw_napm_packet_analysis.v1" }, "...": "..." } }
```

### 2. Report CLI 使用归一结果

修改：

```text
skills/openclaw-napm-report/scripts/generate_napm_report.js
```

执行流程变为：

```text
read input json
  -> normalizeReportInput()
  -> ReportGenerationService.generate()
  -> output docx + audit json
```

因此，报告 skill 自己能够消费 packet/query 的结构化结果，而不是依赖 plugin 手写 packet 报告章节。

### 3. Plugin 保持薄边界

修改：

```text
napm-openclaw-plugin.remote.js
```

保留职责：

- `napm-packet-analysis` 执行后记录最近结构化结果。
- `napm-report-export` 执行时把最近结构化结果作为 `sourceResult` 传给 report skill。
- 成功导出后记录最近合法 report export 结果。
- 如果报告导出 prompt 中出现直接 `.docx/.pdf` MEDIA 或“报告已生成”文本，但没有合法 `napm-report-export` 结果，则拦截并提示必须走 report skill。

不再做：

- 在 plugin 内展开 packet analysis 章节。
- 在 plugin 内生成 Word。
- 在 plugin 内替代 report skill 做报告内容编排。

## 正确链路

上一轮已经有查询或 packet 分析结果时：

```text
用户：将以上总结为报告以word的形式给我
  -> OpenClaw 调用 napm-report-export
  -> plugin 取最近 fresh 结构化结果
  -> report skill normalizeReportInput()
  -> report skill 生成 docx
  -> plugin 记录 napm_report_export_completed
  -> OpenClaw 发送该 docx
```

同一轮复合请求：

```text
用户：分析某 IP 最近一天的数据包，并导出 Word 报告
  -> openclaw-napm-packet-analysis
  -> napm-report-export
  -> openclaw-napm-report
```

## 验证

已执行：

```bash
node --check napm-openclaw-plugin.remote.js
node --check skills/openclaw-napm-report/services/ReportInputContractService.js
node --check skills/openclaw-napm-report/scripts/generate_napm_report.js
npm test -- --runInBand test/napm-report-input-contract.test.js test/napm-openclaw-plugin-report-export.test.js test/napm-report-generation-service.test.js
```

结果：

```text
Test Suites: 3 passed, 3 total
Tests: 16 passed, 16 total
```

## 后续注意

- 如果继续推进纯 skill 化，plugin 中的 report 逻辑还可以进一步瘦身为只传 `sourceResult` 和做 MEDIA 硬边界。
- OpenClaw 真实运行时仍需要插件注册工具；当前不是完全无 plugin 模式。
- 企业微信验证时应检查审计日志中是否出现 `napm_report_export_invoked` 和 `napm_report_export_completed`。
