#!/usr/bin/env node
/**
 * NAPM 综述报告 — 端到端测试脚本
 *
 * 在远端服务器执行，完成完整链路：
 *   NAPM API 查询 → 数据聚合 → reportData → docx 渲染 → 落盘
 *
 * 用法：
 *   node scripts/test_summary_e2e.js [scope] [hours]
 *
 *   scope: global | webApp:<name> | alert
 *   hours: 时间范围（小时），默认 24
 *
 * 示例：
 *   node scripts/test_summary_e2e.js global 24
 *   node scripts/test_summary_e2e.js webApp:239web 168
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ── env ──────────────────────────────────────────────────────
const workspaceRoot = path.resolve(__dirname, '..');
const envPath = path.join(workspaceRoot, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1) : raw;
    if (!process.env[key]) process.env[key] = value;
  }
}

const SummaryClient = require('../skills/openclaw-napm-summary/services/SummaryClient');
const SummaryService = require('../skills/openclaw-napm-summary/services/SummaryService');
const SummaryReportDataService = require('../skills/openclaw-napm-summary/services/SummaryReportDataService');
const { normalizeReportInput } = require('../skills/openclaw-napm-report/services/ReportInputContractService');
const SummaryFixedTemplateService = require('../skills/openclaw-napm-report/services/SummaryFixedTemplateService');
const ReportStorageService = require('../skills/openclaw-napm-report/services/ReportStorageService');

// ── parse args ────────────────────────────────────────────────

const scopeArg = process.argv[2] || 'global';
const hours = Number(process.argv[3]) || 24;

let scope;
if (scopeArg === 'global') {
  scope = { type: 'global', label: '全局' };
} else if (scopeArg === 'alert') {
  scope = { type: 'alert', label: '告警' };
} else if (scopeArg.startsWith('webApp:')) {
  const name = scopeArg.split(':')[1] || '239web';
  scope = { type: 'webApplication', label: '业务', target: { groupType: 'WebApplication', groupArgument: name, groupLabel: name } };
} else {
  console.error('Unknown scope:', scopeArg);
  console.error('Usage: node scripts/test_summary_e2e.js [global|webApp:<name>|alert] [hours]');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const start = now - hours * 3600;
const end = now;

const timeRange = {
  start,
  end,
  displayText: `${new Date(start * 1000).toISOString().replace('T', ' ').slice(0, 16)} ~ ${new Date(end * 1000).toISOString().replace('T', ' ').slice(0, 16)}`
};

// ── main ──────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  NAPM 综述报告 — 端到端测试');
  console.log('═══════════════════════════════════════════');
  console.log(`  scope:     ${scope.type} / ${scope.label}`);
  if (scope.target) console.log(`  target:    ${scope.target.groupLabel}`);
  console.log(`  timeRange: ${timeRange.displayText}`);
  console.log(`  hours:     ${hours}`);
  console.log('───────────────────────────────────────────');

  // Phase 1: Query + Aggregate
  console.log('\n[1/4] Querying NAPM API...');
  const client = new SummaryClient();
  const service = new SummaryService({ client });
  const result = await service.run({ scope, timeRange });
  console.log(`  ✓ ${result.audit.queriesPerformed.length} queries completed`);
  console.log(`  Alert total: ${result.summary.alertSummary?.total || 0}`);
  console.log(`  Critical: ${result.summary.alertSummary?.critical || 0}`);
  console.log(`  Overall status: ${result.summary.overallStatus || 'unknown'}`);

  // Phase 2: Build reportData
  console.log('\n[2/4] Building reportData...');
  const rds = new SummaryReportDataService();
  const reportData = rds.buildReportData(result, {
    sourceQuestion: `生成最近${hours}小时${scope.label}综述报告`
  });
  console.log(`  ✓ reportType: ${reportData.reportType}`);
  console.log(`  ✓ templateId: ${reportData.templateId}`);

  // Phase 3: Normalize
  console.log('\n[3/4] Normalizing input...');
  const normalized = normalizeReportInput({
    sourceResult: { ...result, reportData }
  });
  console.log(`  ✓ scope.type: ${normalized.scope?.type}`);

  // Phase 4: Render docx
  console.log('\n[4/4] Rendering docx...');
  const sts = new SummaryFixedTemplateService();
  const docxBuffer = await sts.renderDocx(normalized);
  console.log(`  ✓ docx size: ${(docxBuffer.length / 1024).toFixed(1)} KB`);

  // Save
  const outputDir = path.join(workspaceRoot, 'skills', 'openclaw-napm-report', 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const storage = new ReportStorageService({ outputDir });
  const reportId = storage.createReportId(normalized);
  const { fileName, filePath, auditPath } = storage.buildPaths(reportId, 'docx');

  fs.writeFileSync(filePath, docxBuffer);
  console.log(`  ✓ Saved: ${filePath}`);

  // Save audit
  storage.writeAuditJson(auditPath, {
    reportId,
    fileName,
    reportType: normalized.reportType,
    scope: normalized.scope,
    timeRange: normalized.timeRange,
    summary: {
      overallStatus: result.summary.overallStatus,
      alertTotal: result.summary.alertSummary?.total,
      critical: result.summary.alertSummary?.critical,
      trafficDataPoints: result.summary.trafficSummary?.trend?.dataset?.time?.length || 0
    },
    queriesPerformed: result.audit?.queriesPerformed || [],
    generatedAt: new Date().toISOString()
  });
  console.log(`  ✓ Audit: ${auditPath}`);

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  ✅ 综述报告生成成功');
  console.log('═══════════════════════════════════════════');
  console.log(`  文件: ${fileName}`);
  console.log(`  大小: ${(docxBuffer.length / 1024).toFixed(1)} KB`);
  console.log(`  告警总数: ${result.summary.alertSummary?.total || 0}`);
  console.log(`  整体状态: ${result.summary.overallStatus || 'unknown'}`);
  if (result.summary.recommendations?.length > 0) {
    console.log('  建议:');
    result.summary.recommendations.forEach((r, i) => console.log(`    ${i + 1}. ${r}`));
  }
  console.log('');
}

main().catch((err) => {
  console.error('\n❌ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});
