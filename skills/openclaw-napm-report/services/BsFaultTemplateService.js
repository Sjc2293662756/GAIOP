'use strict';

const path = require('path');
const {
  Document, Packer
} = require('docx');
const InspectionFixedTemplateService = require('./InspectionFixedTemplateService');

const DEFAULT_TEMPLATE_ID = 'napm_bs_fault_diagnosis_v2';
const DEFAULT_TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'diagnostic');

const parentTest = InspectionFixedTemplateService.__test__ || {};
const asText = parentTest.asText || ((v) => String(v ?? ''));
const asArray = parentTest.asArray || ((v) => Array.isArray(v) ? v : []);
const getByPath = parentTest.getByPath || ((src, p) => {
  const parts = String(p || '').split('.').filter(Boolean);
  let c = src;
  for (const k of parts) { if (c == null) return undefined; c = c[k]; }
  return c;
});
const interpolate = parentTest.interpolate || ((tpl, ctx) =>
  String(tpl || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => asText(getByPath(ctx, p)))
);
const valueOrDash = (v) => { const t = String(v ?? '').trim(); return t || '-'; };
const buildDocumentHeader = parentTest.buildDocumentHeader || (() => undefined);
const buildDocumentFooter = parentTest.buildDocumentFooter || (() => undefined);
const buildPageProperties = parentTest.buildPageProperties || (() => ({ page: {} }));
const buildDocumentStyles = parentTest.buildDocumentStyles || (() => ({}));
const DEFAULT_FONT = parentTest.DEFAULT_FONT || 'Microsoft YaHei';
const DEFAULT_TEXT_COLOR = parentTest.DEFAULT_TEXT_COLOR || '000000';

function isPlainObject(v) { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }

// ── Narrative rules ──────────────────────────────────────────────

function loadBsNarrativeRules() {
  return loadJson(path.join(__dirname, '..', 'templates', 'diagnostic', 'bs-narrative-rules.v1.json'));
}

function loadJson(p) { return JSON.parse(require('fs').readFileSync(p, 'utf8')); }

function existsValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function evalCondition(condition, context) {
  const text = String(condition || '').trim();
  if (!text || text === 'default') return true;
  const existsMatch = text.match(/^(.+?)\s+exists$/);
  if (existsMatch) return existsValue(getByPath(context, existsMatch[1].trim()));
  const emptyMatch = text.match(/^(.+?)\s+empty$/);
  if (emptyMatch) return !existsValue(getByPath(context, emptyMatch[1].trim()));
  // AND/OR before comparison — otherwise compare regex `.+$` eats the AND/OR clause
  const andParts = text.split(/\s+AND\s+/);
  if (andParts.length > 1) return andParts.every((p) => evalCondition(p.trim(), context));
  const orParts = text.split(/\s+OR\s+/);
  if (orParts.length > 1) return orParts.some((p) => evalCondition(p.trim(), context));
  const compareMatch = text.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compareMatch) {
    const left = getByPath(context, compareMatch[1].trim());
    const operator = compareMatch[2];
    const right = parseExpectedValue(compareMatch[3]);
    return compareValues(left, operator, right);
  }
  return existsValue(getByPath(context, text));
}

function parseExpectedValue(raw) {
  const text = String(raw || '').trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true') return true; if (text === 'false') return false;
  return text.replace(/^['"]|['"]$/g, '');
}

function compareValues(left, operator, right) {
  if (operator === '==' || operator === '!=') {
    const result = String(left) === String(right);
    return operator === '==' ? result : !result;
  }
  const ln = Number(left), rn = Number(right);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
  if (operator === '>') return ln > rn; if (operator === '>=') return ln >= rn;
  if (operator === '<') return ln < rn; if (operator === '<=') return ln <= rn;
  return false;
}

function buildNarrativeTexts(context = {}, rules = {}, groupId = '', mode = 'first') {
  const group = asArray(rules.groups?.[groupId]);
  if (group.length === 0) return [];
  if (mode === 'all') {
    const matches = group
      .filter((rule) => String(rule.when || '').trim() !== 'default')
      .filter((rule) => evalCondition(rule.when, context))
      .map((rule) => interpolate(rule.text, context))
      .filter(Boolean);
    if (matches.length > 0) return matches;
  }
  const match = group.find((rule) => evalCondition(rule.when, context));
  return match ? [interpolate(match.text, context)] : [];
}

// ── Row builders ────────────────────────────────────────────────

function buildBsErrorOverviewRows(diagnosis = {}) {
  const step1 = diagnosis.step1 || {};
  const app = asArray(step1.topApps)[0] || {};
  return [
    ['页面访问数', String(app.PGNPGE ?? '-')],
    ['页面延时 (s)', String(app.PGTME ?? '-')],
    ['慢页面数', String(app.PGNSLPGE ?? '-')],
    ['慢页面率 (%)', String(app.PGSLPCT ?? '-')],
    ['HTTP 400 错误', String(app.PGHTTP400 ?? '-')],
    ['HTTP 500 错误', String(app.PGHTTP500 ?? '-')],
    ['请求流量 (MiB)', app.PGBYTI != null ? (Number(app.PGBYTI) / 1048576).toFixed(2) : '-'],
    ['页面流量 (MiB)', app.PGBYTO != null ? (Number(app.PGBYTO) / 1048576).toFixed(2) : '-']
  ];
}

function buildBsPageErrorsRows(diagnosis = {}) {
  const pages = asArray(diagnosis.step2?.pages);
  if (pages.length === 0) return [['-', '-', '-', '-', '-', '-', '-']];
  // Sort by visit count descending
  const sorted = [...pages].sort((a, b) => (Number(b.PGNPGE) || 0) - (Number(a.PGNPGE) || 0));
  return sorted.slice(0, 20).map((p) => [
    p.pageUrl || p.key || '-',
    String(p.PGNPGE ?? p.visits ?? '-'),
    String(p.PGNOBJE ?? p.responses ?? '-'),
    String(p.PGHTTP200 ?? p.http200 ?? '-'),
    String(p.PGHTTP300 ?? p.http300 ?? '-'),
    String(p.PGHTTP400 ?? p.http400 ?? '-'),
    String(p.PGHTTP500 ?? p.http500 ?? '-')
  ]);
}

function buildBsPageDetailsRows(diagnosis = {}) {
  const details = asArray(diagnosis.step3?.pageDetails);
  if (details.length === 0) return [['-', '-', '-', '-', '-', '-', '-', '-']];

  // Each row is one page visit with its own client IP, status code, etc.
  return details.slice(0, 200).map((d) => [
    String(d.startTime ?? '-'),
    String(d.page ?? '-'),
    String(d.clientIp ?? '-'),
    String(d.httpStatus ?? '-'),
    String(d.http200S ?? '-'),
    String(d.http400S ?? '-'),
    String(d.http500S ?? '-'),
    String(d.httpResponses ?? '-')
  ]);
}

function buildBsEvidenceRows(diagnosis = {}) {
  const rows = [];
  if (diagnosis.step1) rows.push(['第一步：4xx/5xx 报错', 'PGHTTP400,PGHTTP400PCT,PGHTTP500,PGHTTP500PCT',
    String(asArray(diagnosis.step1.topApps).length) + ' 条']);
  if (diagnosis.step2) rows.push(['第二步：页面错误分析', 'PGNPGE,PGNOBJE,PGHTTP200-500',
    String(asArray(diagnosis.step2.pages).length) + ' 个页面']);
  if (diagnosis.step3) rows.push(['第三步：状态码详情', 'pageViews API',
    String(asArray(diagnosis.step3.pageDetails).length) + ' 个页面详情']);
  return rows.length > 0 ? rows : [['-', '-', '-']];
}

// ── BsFaultTemplateService ───────────────────────────────────

class BsFaultTemplateService extends InspectionFixedTemplateService {
  constructor(options = {}) {
    super({
      templateRoot: options.templateRoot || DEFAULT_TEMPLATE_ROOT,
      assetRoot: options.assetRoot || path.join(__dirname, '..'),
      templateId: options.templateId || DEFAULT_TEMPLATE_ID,
      narrativeRules: options.narrativeRules || null,
      chartSpecs: options.chartSpecs || null
    });
  }

  buildContext(report = {}) {
    const diagnosis = report.diagnosis || {};
    return {
      ...report,
      report,
      diagnosis,
      title: report.title || '业务故障分析报告',
      timeRange: report.timeRange || {},
      audit: report.audit || {}
    };
  }

  buildRowsForSection(section = {}, context = {}) {
    const diagnosis = context.diagnosis || {};
    const builder = section.rowBuilder;

    if (builder === 'bsErrorOverview') {
      return { columns: section.columns, rows: buildBsErrorOverviewRows(diagnosis) };
    }
    if (builder === 'bsPageErrors') {
      return { columns: section.columns, rows: buildBsPageErrorsRows(diagnosis) };
    }
    if (builder === 'bsPageDetails') {
      return { columns: section.columns, rows: buildBsPageDetailsRows(diagnosis) };
    }
    if (builder === 'bsEvidence') {
      return { columns: section.columns, rows: buildBsEvidenceRows(diagnosis) };
    }

    return super.buildRowsForSection(section, context);
  }

  loadNarrativeRules() {
    if (!this._bsNarrativeRules) {
      try {
        this._bsNarrativeRules = loadBsNarrativeRules();
      } catch (_) {
        this._bsNarrativeRules = { groups: {} };
      }
    }
    return this._bsNarrativeRules;
  }

  renderNarrative(section = {}, context = {}) {
    const rules = this.loadNarrativeRules();
    const texts = buildNarrativeTexts(context, rules, section.ruleGroup, section.mode || 'first');
    const { HeadingLevel, Paragraph, TextRun } = require('docx');
    const children = [];
    if (section.title) {
      const level = Number(section.level) || 2;
      children.push(new Paragraph({
        heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        spacing: { before: level === 1 ? 240 : 160, after: 120 },
        children: [new TextRun({ text: interpolate(section.title, context), bold: true,
          size: level === 1 ? 28 : 24, color: DEFAULT_TEXT_COLOR, font: DEFAULT_FONT })]
      }));
    }
    for (const text of texts.length > 0 ? texts : ['-']) {
      children.push(new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text, size: 21, color: DEFAULT_TEXT_COLOR, font: DEFAULT_FONT })]
      }));
    }
    return children;
  }

  async renderDocx(report = {}) {
    const template = this.loadTemplate(report.templateId || this.defaultTemplateId);
    const context = this.buildContext({
      ...report,
      title: report.title || '业务故障分析报告',
      templateId: report.templateId || template.templateId
    });

    this._chartBuffers = await this.preRenderCharts(template, context);
    const header = buildDocumentHeader(template, context, { assetRoot: this.assetRoot });
    const footer = buildDocumentFooter(template, context, { assetRoot: this.assetRoot });

    const section = {
      properties: buildPageProperties(template),
      children: asArray(template.sections).flatMap((item) => this.renderSection(item, context, this._chartBuffers))
    };
    if (header) section.headers = { default: header };
    if (footer) section.footers = { default: footer };

    const doc = new Document({
      creator: 'openclaw-napm-report',
      title: asText(report.title || '业务故障分析报告'),
      description: 'Generated by OpenClaw NAPM BS fault diagnosis template v2',
      features: { updateFields: true },
      styles: buildDocumentStyles(),
      sections: [section]
    });

    const buffer = await Packer.toBuffer(doc);

    // JSZip post-process for Heading1Char/Heading2Char
    try {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(buffer);
      let stylesXml = await zip.file('word/styles.xml').async('string');
      if (!stylesXml.includes('w:styleId="Heading1Char"')) {
        stylesXml = stylesXml.replace('</w:styles>',
          '<w:style w:type="character" w:styleId="Heading1Char"><w:name w:val="Heading 1 Char"/><w:link w:val="Heading1"/>' +
          '<w:uiPriority w:val="9"/><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:cs="Microsoft YaHei"/>' +
          '<w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>');
      }
      if (!stylesXml.includes('w:styleId="Heading2Char"')) {
        stylesXml = stylesXml.replace('</w:styles>',
          '<w:style w:type="character" w:styleId="Heading2Char"><w:name w:val="Heading 2 Char"/><w:link w:val="Heading2"/>' +
          '<w:uiPriority w:val="9"/><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:cs="Microsoft YaHei"/>' +
          '<w:b/><w:color w:val="000000"/><w:sz w:val="24"/></w:rPr></w:style></w:styles>');
      }
      zip.file('word/styles.xml', stylesXml);
      return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    } catch (_) { return buffer; }
  }
}

module.exports = BsFaultTemplateService;
