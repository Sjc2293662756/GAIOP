'use strict';

const path = require('path');
const BsFaultTemplateService = require('./BsFaultTemplateService');

const DEFAULT_TEMPLATE_ID = 'napm_bs_page_perf_v1';
const DEFAULT_TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'diagnostic');

// Access shared helpers from the parent class test exports
const parentTest = BsFaultTemplateService.__test__ || {};
const asArray = parentTest.asArray || ((v) => Array.isArray(v) ? v : []);

// ── PgPerf Row builders ──────────────────────────────────────────

function buildBsPerfOverviewRows(diagnosis = {}) {
  const step1 = diagnosis.step1 || {};
  const app = asArray(step1.topApps)[0] || {};
  return [
    ['页面访问数', String(app.PGNPGE ?? '-')],
    ['页面平均延时 (s)', String(app.PGTME ?? '-')],
    ['慢页面数', String(app.PGNSLPGE ?? '-')],
    ['慢页面率 (%)', String(app.PGSLPCT ?? '-')]
  ];
}

function buildBsPerfPageDelayRows(diagnosis = {}) {
  const pages = asArray(diagnosis.step2?.pages);
  if (pages.length === 0) return [['-', '-', '-', '-', '-']];
  return pages.slice(0, 20).map((p) => [
    p.pageUrl || p.key || '-',
    String(p.PGNPGE ?? '-'),
    String(p.PGTME ?? '-'),
    String(p.PGNSLPGE ?? '-'),
    String(p.PGSLPCT ?? '-')
  ]);
}

function buildBsPerfPageDetailsRows(diagnosis = {}) {
  const details = asArray(diagnosis.step3?.pageDetails);
  if (details.length === 0) return [['-', '-', '-', '-', '-', '-', '-', '-', '-']];

  return details.slice(0, 200).map((d) => [
    String(d.startTime ?? '-'),
    String(d.page ?? '-'),
    String(d.clientIp ?? '-'),
    d.pageTime != null ? String(d.pageTime) : '-',
    d.servBusyTime != null ? String(d.servBusyTime) : '-',
    d.netBusyTime != null ? String(d.netBusyTime) : '-',
    String(d.servRatio ?? '-'),
    String(d.netRatio ?? '-'),
    String(d.httpResponses ?? '-')
  ]);
}

function buildBsPerfEvidenceRows(diagnosis = {}) {
  const rows = [];
  if (diagnosis.step1) rows.push(['第一步：页面性能总览', 'PGNPGE,PGTME,PGNSLPGE,PGSLPCT',
    String(asArray(diagnosis.step1.topApps).length) + ' 条']);
  if (diagnosis.step2) rows.push(['第二步：页面延时分析', 'PGNPGE,PGTME,PGNSLPGE,PGSLPCT',
    String(asArray(diagnosis.step2.pages).length) + ' 个页面']);
  if (diagnosis.step3) rows.push(['第三步：延时成分拆分', 'PageTime,ServBusyTime,NetBusyTime',
    String(asArray(diagnosis.step3.pageDetails).length) + ' 次访问']);
  return rows.length > 0 ? rows : [['-', '-', '-']];
}

// ── Narrative rules loading ──────────────────────────────────────

function loadPerfNarrativeRules() {
  return JSON.parse(require('fs').readFileSync(
    path.join(__dirname, '..', 'templates', 'diagnostic', 'bs-perf-narrative-rules.v1.json'), 'utf8'));
}

// ── BsPerfTemplateService ───────────────────────────────────────

class BsPerfTemplateService extends BsFaultTemplateService {
  constructor(options = {}) {
    super({
      templateRoot: options.templateRoot || DEFAULT_TEMPLATE_ROOT,
      assetRoot: options.assetRoot || path.join(__dirname, '..'),
      templateId: options.templateId || DEFAULT_TEMPLATE_ID,
      narrativeRules: options.narrativeRules || null,
      chartSpecs: options.chartSpecs || null
    });
  }

  buildRowsForSection(section = {}, context = {}) {
    const diagnosis = context.diagnosis || {};
    const builder = section.rowBuilder;

    if (builder === 'bsPerfOverview') {
      return { columns: section.columns, rows: buildBsPerfOverviewRows(diagnosis) };
    }
    if (builder === 'bsPerfPageDelay') {
      return { columns: section.columns, rows: buildBsPerfPageDelayRows(diagnosis) };
    }
    if (builder === 'bsPerfPageDetails') {
      return { columns: section.columns, rows: buildBsPerfPageDetailsRows(diagnosis) };
    }
    if (builder === 'bsPerfEvidence') {
      return { columns: section.columns, rows: buildBsPerfEvidenceRows(diagnosis) };
    }

    // Fall back to parent builders for shared builders like staticTable, paragraphs, etc.
    return super.buildRowsForSection(section, context);
  }

  loadNarrativeRules() {
    if (!this._perfNarrativeRules) {
      try {
        this._perfNarrativeRules = loadPerfNarrativeRules();
      } catch (_) {
        this._perfNarrativeRules = { groups: {} };
      }
    }
    return this._perfNarrativeRules;
  }
}

module.exports = BsPerfTemplateService;
