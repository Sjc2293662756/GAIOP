'use strict';

const path = require('path');
const SummaryClient = require('../../openclaw-napm-summary/services/SummaryClient');

// ── helpers ─────────────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function valueOrDash(v) {
  const t = String(v ?? '').trim();
  return t || '-';
}

function loadJudgmentHints() {
  const hintsPath = path.join(__dirname, '..', 'templates', 'judgment-hints.v1.json');
  return require(hintsPath);
}

/**
 * Match judgment hints for a step based on data conditions.
 * Returns an array of hint text strings.
 */
function matchHints(flowType, stepId, data = {}) {
  const hints = loadJudgmentHints();
  const stepHints = hints[flowType]?.[stepId];
  if (!stepHints) return [];

  const matched = [];

  // Regular hints
  if (stepHints.hints) {
    for (const hint of stepHints.hints) {
      if (evaluateHintCondition(hint.when, data)) {
        matched.push({ type: 'judgment', text: hint.text });
      }
    }
  }

  // Packet triggers
  if (stepHints.packetTriggers) {
    for (const trigger of stepHints.packetTriggers) {
      if (evaluateHintCondition(trigger.when, data)) {
        matched.push({ type: 'packet_trigger', text: trigger.text });
      }
    }
  }

  return matched;
}

/**
 * Simple condition evaluation for hint matching.
 * Supported: "trafficNormal", "highTrafficAndLoss", etc.
 * These are pre-computed flags passed in from the step's data analysis.
 */
function evaluateHintCondition(condition = '', data = {}) {
  if (!condition) return true;
  // Direct flag lookup
  if (data[condition] === true) return true;
  return false;
}

/**
 * Resolve NAPM group argument from target object.
 * Uses groupArgument first, falls back to groupLabel (OpenClaw may only pass label).
 */
function resolveGroupArg(target) {
  if (!target || !isPlainObject(target)) return '';
  return target.groupArgument || target.groupLabel || '';
}

// ── NAPM data extraction helpers ──────────────────────────────────────

/**
 * Extract a metric value from a NAPM topValues item.
 * NAPM format: { metricValues: [{ metric: {id: "PGHTTP400"}, value: 123 }, ...] }
 */
function extractMetric(item = {}, metricId = '') {
  const mvList = asArray(item.metricValues);
  for (const mv of mvList) {
    if (mv.metric?.id === metricId) {
      return Number(mv.value) || 0;
    }
  }
  return 0;
}

/**
 * Extract all values for a given metric from a NAPM timeValues response.
 * NAPM format: { metricValues: [{ metric: {id: "PGHTTP400"}, values: [1,2,3] }] }
 */
function extractTimeSeries(data, metricId) {
  if (!isPlainObject(data)) return [];
  const mvList = asArray(data.metricValues);
  for (const mv of mvList) {
    if (mv.metric?.id === metricId) {
      return asArray(mv.values).map(Number).filter((n) => Number.isFinite(n));
    }
  }
  return [];
}

/**
 * Sum an array of numbers.
 */
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/**
 * Average of an array of numbers.
 */
function avg(arr) {
  if (arr.length === 0) return 0;
  return sum(arr) / arr.length;
}

/**
 * Max of an array of numbers.
 */
function max(arr) {
  if (arr.length === 0) return 0;
  return Math.max(...arr);
}

/**
 * Extract topValues items as a flat array of { key, keyLabel, ...metricValues }.
 */
function extractTopItems(data) {
  // Format A: { topValues: [...] }
  if (isPlainObject(data) && Array.isArray(data.topValues)) {
    return data.topValues.map((item) => flattenMetricItem(item));
  }
  // Format B: raw array of metric items
  if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0]?.metricValues)) {
    return data.map((item) => flattenMetricItem(item));
  }
  return [];
}

/**
 * Flatten a single NAPM metric item into { key, keyLabel, METRIC_ID: value, ... }.
 * Handles multiple key sources: item.key, item.group.argument, item.groupPath.
 */
function flattenMetricItem(item) {
  // Resolve key/label from multiple possible sources
  let key = item.key || item.group?.argument || '';
  let keyLabel = item.keyLabel || item.group?.argument || '';
  // For PageFamily items, parse key from groupPath if not found
  if (!key && item.groupPath) {
    const match = String(item.groupPath).match(/page\s+(\d+)/i);
    if (match) { key = match[1]; keyLabel = match[1]; }
  }
  if (!keyLabel && key) keyLabel = key;

  const result = { key: String(key || '-'), keyLabel: String(keyLabel || key || '-') };
  const mvList = asArray(item.metricValues);
  for (const mv of mvList) {
    result[mv.metric?.id || 'unknown'] = Number(mv.value) || 0;
  }
  return result;
}

// ── Step definitions ────────────────────────────────────────────────

class FaultDiagnosisSteps {
  constructor(options = {}) {
    this.client = options.client || new SummaryClient(options);
  }

  /**
   * Build NAPM query plan for a specific flow step.
   * Returns { label, queries: [{ label, fn }] }
   */
  buildQueries(flowType, stepId, context = {}) {
    const builders = {
      network_slow: {
        step1_traffic_trend: (ctx) => this._networkStep1(ctx),
        step2_top_objects: (ctx) => this._networkStep2(ctx),
        step3_network_quality: (ctx) => this._networkStep3(ctx),
        step4_connection_failure: (ctx) => this._networkStep4(ctx)
      },
      bs_app_slow: {
        step1_4xx_5xx_overview: (ctx) => this._bsStep1(ctx),
        step2_page_error_analysis: (ctx) => this._bsStep2(ctx),
        step3_page_status_detail: (ctx) => this._bsStep3(ctx)
      },
      cs_app_slow: {
        step1_app_overview: (ctx) => this._csStep1(ctx),
        step2_time_breakdown: (ctx) => this._csStep2(ctx)
      }
    };

    const builder = builders[flowType]?.[stepId];
    if (!builder) {
      return { label: stepId, queries: [] };
    }
    return builder(context);
  }

  /**
   * Analyze step data and produce flag-based conditions for hint matching.
   */
  analyzeStepData(flowType, stepId, rawData = {}, context = {}) {
    const analyzers = {
      network_slow: {
        step1_traffic_trend: (d) => this._analyzeNetworkStep1(d),
        step2_top_objects: (d) => this._analyzeNetworkStep2(d),
        step3_network_quality: (d) => this._analyzeNetworkStep3(d),
        step4_connection_failure: (d) => this._analyzeNetworkStep4(d)
      },
      bs_app_slow: {
        step1_4xx_5xx_overview: (d) => this._analyzeBsStep1(d),
        step2_page_error_analysis: (d) => this._analyzeBsStep2(d),
        step3_page_status_detail: (d) => this._analyzeBsStep3(d)
      },
      cs_app_slow: {
        step1_app_overview: (d) => this._analyzeCsStep1(d),
        step2_time_breakdown: (d) => this._analyzeCsStep2(d)
      }
    };

    const analyzer = analyzers[flowType]?.[stepId];
    if (!analyzer) return {};
    return analyzer(rawData);
  }

  // ═══════════════════════════════════════════════════════════════
  // Network slow — Step 1: 总流量趋势
  // ═══════════════════════════════════════════════════════════════

  _networkStep1(ctx = {}) {
    const { faultStart, faultEnd, baselineStart, baselineEnd, granularity } = ctx;
    const queries = [
      {
        label: 'faultTrend',
        fn: () => this.client.getTimeValues(
          faultStart, faultEnd, 'TPIO,TPI,TPO',
          [{ type: 'TotalTraffic' }], granularity || 60
        )
      }
    ];
    if (baselineStart && baselineEnd) {
      queries.push({
        label: 'baselineTrend',
        fn: () => this.client.getTimeValues(
          baselineStart, baselineEnd, 'TPIO,TPI,TPO',
          [{ type: 'TotalTraffic' }], granularity || 60
        )
      });
    }
    return {
      label: 'step1_traffic_trend',
      description: '第一步：查看总流量趋势',
      queries
    };
  }

  _analyzeNetworkStep1(raw = {}) {
    const flags = {};
    // Simplified: in production, this would compare fault vs baseline
    // For now, provide the flags based on what data is available
    if (raw.faultTrend) {
      flags.hasFaultData = true;
    }
    if (raw.baselineTrend) {
      flags.hasBaseline = true;
    }
    // Default hint: let the human judge based on the trend chart
    flags.trafficNormal = true; // Most conservative default
    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // Network slow — Step 2: Top 对象
  // ═══════════════════════════════════════════════════════════════

  _networkStep2(ctx = {}) {
    const { faultStart, faultEnd } = ctx;
    return {
      label: 'step2_top_objects',
      description: '第二步：定位 Top 对象',
      queries: [
        { label: 'topApps', groupType: 'DefinedApp',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'DefinedApp' }]) },
        { label: 'topHosts', groupType: 'IPAddress',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'IPAddress' }]) },
        { label: 'topGroups', groupType: 'BusinessGroup',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'BusinessGroup' }]) },
        { label: 'topSessions', groupType: 'IPConversation',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'IPConversation' }]) }
      ]
    };
  }

  _analyzeNetworkStep2(raw = {}) {
    const flags = {};
    if (raw.topApps) flags.hasTopApps = true;
    if (raw.topHosts) flags.hasTopHosts = true;
    if (raw.topGroups) flags.hasTopGroups = true;
    flags.scattered = true; // Default
    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // Network slow — Step 3: 网络质量
  // ═══════════════════════════════════════════════════════════════

  _networkStep3(ctx = {}) {
    const { faultStart, faultEnd } = ctx;
    return {
      label: 'step3_network_quality',
      description: '第三步：查看网络质量指标',
      queries: [
        { label: 'ipQuality', groupType: 'IPAddress',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'RTTI,RTTO,PLI,PLO,RTDI,RTDO', 'PLI', 10, [{ type: 'IPAddress' }]) },
        { label: 'groupQuality', groupType: 'BusinessGroup',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'PLI,PLO,RTTI,RTTO', 'PLI', 10, [{ type: 'BusinessGroup' }]) },
        { label: 'appQuality', groupType: 'DefinedApp',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'PLI,PLO,RTTI,RTTO,RTDI,RTDO', 'PLI', 10, [{ type: 'DefinedApp' }]) }
      ]
    };
  }

  _analyzeNetworkStep3(raw = {}) {
    const flags = {};
    // Placeholder — actual analysis would compare values vs thresholds
    flags.normalTrafficButLoss = true;
    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // Network slow — Step 4: 连接失败和异常
  // ═══════════════════════════════════════════════════════════════

  _networkStep4(ctx = {}) {
    const { faultStart, faultEnd } = ctx;
    return {
      label: 'step4_connection_failure',
      description: '第四步：检查连接失败和异常主机',
      queries: [
        { label: 'ipFailures', groupType: 'IPAddress',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'RFCI,RFCO,FLSI,FLSO', 'RFCO', 10, [{ type: 'IPAddress' }]) },
        { label: 'appFailures', groupType: 'DefinedApp',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'RFCI,RFCO,FLSI,FLSO', 'RFCO', 10, [{ type: 'DefinedApp' }]) },
        { label: 'groupFailures', groupType: 'BusinessGroup',
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'FLSI,FLSO', 'FLSO', 10, [{ type: 'BusinessGroup' }]) }
      ]
    };
  }

  _analyzeNetworkStep4(raw = {}) {
    const flags = {};
    // Placeholder — actual analysis needs threshold checking
    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // B/S App slow — Step 1: 业务整体指标
  // ═══════════════════════════════════════════════════════════════

  _bsStep1(ctx = {}) {
    const { faultStart, faultEnd, target } = ctx;
    const groupArg = resolveGroupArg(target);
    const groupType = target?.groupType || 'WebApplication';
    const groups = groupArg
      ? [{ type: groupType, argument: groupArg }]
      : [{ type: groupType }];

    return {
      label: 'step1_4xx_5xx_overview',
      description: '第一步：查询业务 4xx/5xx 报错情况',
      queries: [
        {
          label: 'businessOverview',
          fn: () => this.client.getAverageValues(
            faultStart, faultEnd,
            'PGNPGE,PGTME,PGNSLPGE,PGSLPCT,PGHTTP400,PGHTTP500,PGBYTI,PGBYTO',
            groups
          )
        }
      ]
    };
  }

  _analyzeBsStep1(raw = {}) {
    const flags = {};
    const data = raw.businessOverview || {};

    if (!isPlainObject(data) || Object.keys(data).length === 0) {
      flags.errorNormal = true;
      return flags;
    }

    flags.hasOverview = true;
    const total400 = Number(data.PGHTTP400) || 0;
    const total500 = Number(data.PGHTTP500) || 0;
    const totalVisits = Number(data.PGNPGE) || 1;

    flags._total400 = total400;
    flags._total500 = total500;
    flags._totalVisits = totalVisits;
    flags._slowRate = Number(data.PGSLPCT) || 0;

    // Simple threshold: any 400 > 50 or 400 rate > 5% → elevated
    if (total400 > 50 || (totalVisits > 0 && total400 / totalVisits > 0.05)) {
      flags.http400Up = true;
    }
    if (total500 > 0) {
      flags.http500Up = true;
    }
    if (flags.http400Up && flags.http500Up) {
      flags.http400And500Up = true;
    }
    if (!flags.http400Up && !flags.http500Up) {
      flags.errorNormal = true;
    }

    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // B/S App slow — Step 2: 异常 URL/页面
  // ═══════════════════════════════════════════════════════════════

  _bsStep2(ctx = {}) {
    const { faultStart, faultEnd, target, granularity } = ctx;
    const groupArg = resolveGroupArg(target);
    const groupType = target?.groupType || 'WebApplication';
    const baseGroup = groupArg
      ? [{ type: groupType, argument: groupArg }]
      : [{ type: groupType }];

    return {
      label: 'step2_page_error_analysis',
      description: '第二步：页面错误分析（按访问数排序 Top 20）',
      queries: [
        {
          label: 'pageErrorAnalysis',
          fn: () => this.client.getTopValues(
            faultStart, faultEnd,
            'PGNPGE,PGNOBJE,PGHTTP200,PGHTTP300,PGHTTP400,PGHTTP500',
            'PGHTTP500', 20,
            [...baseGroup, { type: 'PageFamilies' }, { type: 'PageFamily' }]
          )
        }
      ]
    };
  }

  _analyzeBsStep2(raw = {}) {
    const flags = {};

    if (!raw.pageErrorAnalysis) return flags;

    flags.hasPageData = true;
    const pages = extractTopItems(raw.pageErrorAnalysis);

    if (pages.length === 0) return flags;

    // ── Compute totals ──
    let totalVisits = 0, total400 = 0, total500 = 0, totalSlowRate = 0;
    let max400Page = null, max500Page = null, maxVisitsPage = null;
    let max400 = 0, max500 = 0, maxVisits = 0;
    let pageCountWithErrors = 0;

    for (const page of pages) {
      const visits = page.PGNPGE || 0;
      const errors400 = page.PGHTTP400 || 0;
      const errors500 = page.PGHTTP500 || 0;
      const slowRate = page.PGSLPCT || 0;

      totalVisits += visits;
      total400 += errors400;
      total500 += errors500;
      totalSlowRate += slowRate;

      if (errors400 > 0 || errors500 > 0) pageCountWithErrors++;

      if (errors400 > max400) { max400 = errors400; max400Page = page; }
      if (errors500 > max500) { max500 = errors500; max500Page = page; }
      if (visits > maxVisits) { maxVisits = visits; maxVisitsPage = page; }
    }

    // ── Store computed values ──
    flags._totalVisits = totalVisits;
    flags._total400 = total400;
    flags._total500 = total500;
    flags._pageCount = pages.length;
    flags._pageCountWithErrors = pageCountWithErrors;
    flags._max400Page = max400Page;
    flags._max500Page = max500Page;
    flags._maxVisitsPage = maxVisitsPage;

    // ── Judgment: page 400 dominant ──
    if (max400Page && total400 > 0) {
      const pctOfTotal400 = (max400 / total400) * 100;
      if (pctOfTotal400 > 50) {
        flags.page400Dominant = true;
        flags._dominant400Pct = Math.round(pctOfTotal400);
      }
    }

    // ── Judgment: page 500 dominant ──
    if (max500Page && total500 > 0) {
      const pctOfTotal500 = (max500 / total500) * 100;
      if (pctOfTotal500 > 50) {
        flags.page500Dominant = true;
        flags._dominant500Pct = Math.round(pctOfTotal500);
      }
    }

    // ── Judgment: slow page dominant ──
    if (totalSlowRate > 0 && total400 === 0 && total500 === 0) {
      flags.pageSlowDominant = true;
    }

    // ── Judgment: top-visit page has errors ──
    if (maxVisitsPage) {
      const topVisits400 = maxVisitsPage.PGHTTP400 || 0;
      const topVisits500 = maxVisitsPage.PGHTTP500 || 0;
      if (topVisits400 + topVisits500 > 0) {
        flags.topPageHighVisits = true;
      }
    }

    // ── Judgment: errors scattered across many pages ──
    if (pageCountWithErrors > pages.length * 0.4 && !flags.page400Dominant && !flags.page500Dominant) {
      flags.errorsScattered = true;
    }

    // ── Packet triggers ──
    if (max500Page && max500 > 10) {
      flags.page500NeedContent = true;
    }
    if (max400Page && max400 > 50) {
      flags.page400NeedContent = true;
    }

    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // B/S App slow — Step 3: 页面状态码详情
  // ═══════════════════════════════════════════════════════════════

  _bsStep3(ctx = {}) {
    const { faultStart, faultEnd } = ctx;
    const prevRaw = ctx._prevStepRawData || {};
    const pageData = prevRaw.pageErrorAnalysis;
    let topItems = [];
    if (Array.isArray(pageData?.topValues)) topItems = pageData.topValues;
    else if (Array.isArray(pageData)) topItems = pageData;

    const queries = [];
    for (const item of topItems.slice(0, 20)) {
      // pageFamilyId from groupPath: ">pages>page 8573230/http://..."
      let pageFamilyId = '';
      if (item.groupPath) {
        const m = String(item.groupPath).match(/page\s+(\d+)/i);
        if (m) pageFamilyId = m[1];
      }
      if (!pageFamilyId) pageFamilyId = item.group?.argument || item.key || '';
      if (!pageFamilyId) continue;

      queries.push({
        label: `pageDetail_${pageFamilyId}`,
        pageKey: item.keyLabel || item.group?.argument || pageFamilyId,
        pageId: pageFamilyId,
        fn: () => this.client.request('pageViews', {
          start: faultStart,
          end: faultEnd,
          pageFamilyId
        })
      });
    }

    return {
      label: 'step3_page_status_detail',
      description: `第三步：逐页访问明细分析（共 ${queries.length} 个页面）`,
      queries
    };
  }

  _analyzeBsStep3(raw = {}) {
    const flags = { hasPageViewData: true };

    // Count pages with pageViews data
    const pageDetailKeys = Object.keys(raw).filter((k) => k.startsWith('pageDetail_'));
    flags._pageDetailCount = pageDetailKeys.length;

    if (pageDetailKeys.length === 0) {
      flags.isPresentationStep = true;
      return flags;
    }

    // Analyze each page's pageViews data
    let pagesWith500 = 0;
    let pagesWith400 = 0;
    let totalPages = 0;

    for (const key of pageDetailKeys) {
      const pageData = raw[key];
      if (!pageData) continue;
      totalPages++;

      // pageViews response may contain status code distribution
      const has500 = this._pageHasStatusCode(pageData, '500');
      const has400 = this._pageHasStatusCode(pageData, '400');

      if (has500) pagesWith500++;
      if (has400) pagesWith400++;
    }

    if (totalPages === 1 && pagesWith500 + pagesWith400 > 0 && totalPages > 0) {
      flags.singlePageAllErrors = true;
    }
    if (pagesWith500 > 2) {
      flags.multiPage500 = true;
    }
    if (pagesWith400 > 4) {
      flags.multiPage400 = true;
    }

    return flags;
  }

  /**
   * Check if a pageViews response contains a specific HTTP status code.
   */
  _pageHasStatusCode(pageData, statusCode) {
    if (!pageData) return false;
    // pageViews response format: may contain rows with status code field
    const rows = Array.isArray(pageData) ? pageData
      : (Array.isArray(pageData?.rows) ? pageData.rows
        : (Array.isArray(pageData?.data) ? pageData.data : []));
    for (const row of rows) {
      const code = String(row?.statusCode || row?.status || row?.code || '');
      if (code.startsWith(statusCode)) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // C/S App slow — Step 1: 应用运行状况
  // ═══════════════════════════════════════════════════════════════

  _csStep1(ctx = {}) {
    const { faultStart, faultEnd, target, granularity } = ctx;
    const groupType = target?.groupType || 'Application';
    const groupArg = target?.groupArgument || '';
    const groups = groupArg
      ? [{ type: groupType, argument: groupArg }]
      : [{ type: 'Application' }];

    return {
      label: 'step1_app_overview',
      description: '第一步：查看应用运行状况',
      queries: [
        {
          label: 'appTrend',
          fn: () => this.client.getTimeValues(
            faultStart, faultEnd,
            'TPIO,TPI,TPO,CONI,CONO,SCSI,SCSO,FLSI,FLSO',
            groups, granularity || 60
          )
        },
        {
          label: 'appConnections',
          fn: () => this.client.getTopValues(
            faultStart, faultEnd,
            'CONI,CONO', 'CONI', 10, groups
          )
        },
        {
          label: 'appFailures',
          fn: () => this.client.getTopValues(
            faultStart, faultEnd,
            'RFCI,RFCO,FLSI,FLSO', 'RFCO', 10, groups
          )
        }
      ]
    };
  }

  _analyzeCsStep1(raw = {}) {
    const flags = {};
    if (raw.appTrend) flags.hasAppData = true;
    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // C/S App slow — Step 2: 拆分用户体验
  // ═══════════════════════════════════════════════════════════════

  _csStep2(ctx = {}) {
    const { faultStart, faultEnd, target } = ctx;
    const groupType = target?.groupType || 'Application';
    const groupArg = target?.groupArgument || '';
    const groups = groupArg
      ? [{ type: groupType, argument: groupArg }]
      : [{ type: 'Application' }];

    return {
      label: 'step2_time_breakdown',
      description: '第二步：拆分用户体验（建连时间 + 服务器响应 + 数据传输 + 重传）',
      queries: [
        {
          label: 'timeComponents',
          fn: () => this.client.getTopValues(
            faultStart, faultEnd,
            'CSTI,CSTO,SRTI,SRTO,DTTI,DTTO,RTDI,RTDO,UETI,UETO',
            'UETO', 10, groups
          )
        },
        {
          label: 'qualityMetrics',
          fn: () => this.client.getTopValues(
            faultStart, faultEnd,
            'RTTI,RTTO,PLI,PLO',
            'PLI', 10, groups
          )
        }
      ]
    };
  }

  _analyzeCsStep2(raw = {}) {
    const flags = {};
    if (raw.timeComponents) flags.hasTimeComponents = true;
    return flags;
  }
}

module.exports = { FaultDiagnosisSteps, matchHints };
module.exports.__test__ = { matchHints, evaluateHintCondition };
