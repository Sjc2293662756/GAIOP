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
        step2_user_experience_trend: (ctx) => this._csStep2(ctx),
        step3_slow_client_analysis: (ctx) => this._csStep3(ctx)
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
        step2_user_experience_trend: (d) => this._analyzeCsStep2(d),
        step3_slow_client_analysis: (d) => this._analyzeCsStep3(d)
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
  // C/S App slow — 应用类型识别 & 执行参数映射
  // ═══════════════════════════════════════════════════════════════
  //
  // NAPM 的"应用"覆盖多种子类型（参见 config/object-ontology.v1.json）：
  //   DefinedApp (Type=2)          → executionGroupType = DefinedApp
  //   CompositeApplication (Type=4) → executionGroupType = DefinedApp（映射）
  //   BuiltinApplication (Type=1)   → executionGroupType = DefinedApp（映射）
  //   OtherApp                     → executionGroupType = OtherApp
  //
  // AppPro 双轨逻辑（参见 单个应用剖析-接口文档.md）：
  //   checkApplicationType < 0  → OtherApp, groupType3 = ConnectedIP
  //   checkApplicationType >= 0 → DefinedApp, groupType3 = IPAddress
  //
  // 返回 { executionGroupType, isOtherApp, clientIpGroupType, label }

  _resolveCsAppMeta(target) {
    const rawType = (target?.groupType || '').trim();
    // CompositeApplication / BuiltinApplication / Application 执行时映射为 DefinedApp
    const isOtherApp = rawType === 'OtherApp';
    const executionGroupType = isOtherApp ? 'OtherApp' : 'DefinedApp';
    // 客户端 IP 分组：OtherApp 用 ConnectedIP，其余用 IPAddress
    const clientIpGroupType = isOtherApp ? 'ConnectedIP' : 'IPAddress';

    const labelMap = {
      DefinedApp: '已定义应用',
      CompositeApplication: '自动识别应用（复合协议）',
      BuiltinApplication: '内置端口应用',
      OtherApp: '未知应用',
      Application: '已定义应用（通用）'
    };
    const label = labelMap[rawType] || labelMap.DefinedApp;

    return { executionGroupType, isOtherApp, clientIpGroupType, label, rawType: rawType || 'DefinedApp' };
  }

  // ═══════════════════════════════════════════════════════════════
  // C/S App slow — Step 1: 应用运行状况
  // ═══════════════════════════════════════════════════════════════

  _csStep1(ctx = {}) {
    const { faultStart, faultEnd, target, granularity } = ctx;
    const appMeta = this._resolveCsAppMeta(target);
    const groupArg = target?.groupArgument || '';
    const groups = groupArg
      ? [{ type: appMeta.executionGroupType, argument: groupArg }]
      : [{ type: appMeta.executionGroupType }];

    return {
      label: 'step1_app_overview',
      description: `第一步：查看${appMeta.label}运行状况`,
      queries: [
        {
          label: 'appPerformanceSummary',
          fn: () => this.client.getAverageValues(
            faultStart, faultEnd,
            'UEII,CSTI,TRTI,PTTO,RDTO',
            groups
          )
        },
        {
          label: 'appTrafficTrend',
          fn: () => this.client.getTimeValues(
            faultStart, faultEnd,
            'TPI,TPO',
            groups, granularity || 60
          )
        }
      ]
    };
  }

  _analyzeCsStep1(raw = {}) {
    const flags = {};
    if (raw.appPerformanceSummary) flags.hasPerformanceData = true;
    if (raw.appTrafficTrend) flags.hasTrafficData = true;

    const perfData = raw.appPerformanceSummary;
    if (perfData && Object.keys(perfData).length > 0) {
      const ueii = Number(perfData.UEII) || 0;
      const rdt = Number(perfData.RDTO) || 0;
      const trti = Number(perfData.TRTI) || 0;
      const csti = Number(perfData.CSTI) || 0;

      flags._ueii = ueii;
      flags._rdto = rdt;
      flags._trti = trti;
      flags._csti = csti;

      if (ueii > 1000) flags.userExpHigh = true;
      if (rdt > 200) flags.retransHigh = true;
      if (trti > 500) flags.serverRespHigh = true;
      if (csti > 200) flags.connSetupHigh = true;
    }

    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // C/S App slow — Step 2: 拆分用户体验
  // ═══════════════════════════════════════════════════════════════

  _csStep2(ctx = {}) {
    const { faultStart, faultEnd, target, granularity } = ctx;
    const appMeta = this._resolveCsAppMeta(target);
    const groupArg = target?.groupArgument || '';
    const groups = groupArg
      ? [{ type: appMeta.executionGroupType, argument: groupArg }]
      : [{ type: appMeta.executionGroupType }];

    return {
      label: 'step2_user_experience_trend',
      description: '第二步：用户体验趋势分析（查找波峰）',
      queries: [
        {
          label: 'userExpTrend',
          fn: () => this.client.getTimeValues(
            faultStart, faultEnd,
            'UEII,CSTI,TRTI,PTTO,RDTO',
            groups, granularity || 60
          )
        }
      ]
    };
  }

  _analyzeCsStep2(raw = {}) {
    const flags = {};
    const trend = raw.userExpTrend;

    if (!trend || !isPlainObject(trend)) {
      flags.noTrendData = true;
      return flags;
    }

    flags.hasTrendData = true;

    const uetVals = extractTimeSeries(trend, 'UEII');
    if (uetVals.length === 0) {
      flags.noUetData = true;
      return flags;
    }

    const mean = avg(uetVals);
    const maxVal = max(uetVals);
    const sd = Math.sqrt(uetVals.reduce((s, v) => s + (v - mean) ** 2, 0) / uetVals.length);
    const threshold = mean + 2 * sd;

    flags._uetMean = mean;
    flags._uetMax = maxVal;
    flags._uetThreshold = threshold;
    flags._uetPointCount = uetVals.length;

    // Find indices above threshold
    const aboveIdx = [];
    for (let i = 0; i < uetVals.length; i++) {
      if (uetVals[i] >= threshold) aboveIdx.push(i);
    }

    if (aboveIdx.length === 0) {
      flags.uetNormal = true;
      return flags;
    }

    // Group consecutive indices into intervals, find peak in each
    const intervals = [];
    let start = aboveIdx[0];
    for (let i = 1; i <= aboveIdx.length; i++) {
      if (i === aboveIdx.length || aboveIdx[i] > aboveIdx[i - 1] + 1) {
        const end = aboveIdx[i - 1];
        let peakIdx = start, peakVal = uetVals[start];
        for (let j = start; j <= end; j++) {
          if (uetVals[j] > peakVal) { peakIdx = j; peakVal = uetVals[j]; }
        }
        intervals.push({ startIdx: start, endIdx: end, peakIdx, peakVal, span: end - start + 1 });
        if (i < aboveIdx.length) start = aboveIdx[i];
      }
    }

    const totalSpan = aboveIdx[aboveIdx.length - 1] - aboveIdx[0] + 1;
    const isPlateau = intervals.length >= 3 && totalSpan > uetVals.length * 0.5;

    flags._intervals = intervals;
    flags._intervalCount = intervals.length;
    flags._isPlateau = isPlateau;

    // Select peaks
    let selectedPeaks = [];
    if (isPlateau) {
      const sampleIndices = [];
      const step = Math.max(1, Math.floor(totalSpan / 4));
      for (let i = aboveIdx[0]; i <= aboveIdx[aboveIdx.length - 1]; i += step) {
        sampleIndices.push(i);
      }
      const unique = [...new Set(sampleIndices)].sort((a, b) => a - b);
      selectedPeaks = unique.slice(0, 5).map((idx) => ({
        index: idx, value: uetVals[idx], reason: 'plateau_sample'
      }));
    } else if (intervals.length > 5) {
      selectedPeaks = [...intervals]
        .sort((a, b) => b.peakVal - a.peakVal)
        .slice(0, 5)
        .map((iv) => ({ index: iv.peakIdx, value: iv.peakVal, reason: 'top5' }));
    } else {
      selectedPeaks = intervals.map((iv) => ({
        index: iv.peakIdx, value: iv.peakVal, reason: 'all'
      }));
    }

    flags._selectedPeaks = selectedPeaks;
    flags._peakCount = selectedPeaks.length;
    flags.hasPeaks = selectedPeaks.length > 0;

    return flags;
  }

  // ═══════════════════════════════════════════════════════════════
  // C/S App slow — Step 3: 波峰窗口慢客户端分析
  // ═══════════════════════════════════════════════════════════════

  _csStep3(ctx = {}) {
    const { faultStart, faultEnd, target } = ctx;
    const appMeta = this._resolveCsAppMeta(target);
    const groupArg = target?.groupArgument || '';

    // OtherApp 用 ConnectedIP，其余用 IPAddress（AppPro 双轨逻辑）
    const clientGroups = groupArg
      ? [{ type: appMeta.executionGroupType, argument: groupArg }, { type: 'ExternalIPs' }, { type: appMeta.clientIpGroupType }]
      : [{ type: appMeta.executionGroupType }, { type: 'ExternalIPs' }, { type: appMeta.clientIpGroupType }];

    const prevRaw = ctx._prevStepRawData || {};
    const trend = prevRaw.userExpTrend;
    let startTime = Number(faultStart) || 0;
    let gran = Number(ctx.granularity) || 60;
    if (trend) {
      startTime = Number(trend.interval?.start || trend.start) || startTime;
      gran = Number(trend.granularity) || gran;
    }

    // Get peaks detected in step2 analysis
    const prevAnalysisFlags = ctx._prevAnalysisFlags || {};
    const peaks = prevAnalysisFlags._selectedPeaks || [];
    if (peaks.length === 0) {
      return {
        label: 'step3_slow_client_analysis',
        description: '第三步：慢客户端分析（全窗口，未检测到明显波峰）',
        queries: [{
          label: 'overallSlowClients',
          fn: () => this.client.getTopValues(
            faultStart, faultEnd || (faultStart + 3600),
            'UEII,CSTI,TRTI,PTTO,RDTO', 'UEII', 10, clientGroups
          )
        }]
      };
    }

    const queries = peaks.map((p, i) => ({
      label: `peak_${i + 1}_clients`,
      peakIndex: p.index,
      peakValue: p.value,
      peakReason: p.reason || '',
      fn: () => {
        const peakTime = startTime + p.index * gran;
        return this.client.getTopValues(
          peakTime - 30, peakTime + 30,
          'UEII,CSTI,TRTI,PTTO,RDTO', 'UEII', 10, clientGroups
        );
      }
    }));

    queries.push({
      label: 'overallSlowClients',
      fn: () => this.client.getTopValues(
        faultStart, faultEnd || (faultStart + 3600),
        'UEII,CSTI,TRTI,PTTO,RDTO', 'UEII', 10, clientGroups
      )
    });

    return {
      label: 'step3_slow_client_analysis',
      description: `第三步：波峰窗口慢客户端分析（检测到 ${peaks.length} 个波峰）`,
      queries
    };
  }

  _analyzeCsStep3(raw = {}) {
    const flags = {};
    const peakKeys = Object.keys(raw).filter((k) => k.startsWith('peak_') && raw[k]);
    flags._peakQueryCount = peakKeys.length;

    if (peakKeys.length === 0) {
      flags.noPeakData = true;
      return flags;
    }

    flags.hasPeakData = true;

    const peakClients = [];
    for (const key of peakKeys) {
      const items = extractTopItems(raw[key]);
      peakClients.push({
        peakLabel: key,
        clients: items.slice(0, 10),
        clientCount: items.length
      });
    }
    flags._peakClients = peakClients;

    if (peakClients.length >= 2) {
      const allClientSets = peakClients.map((pc) => new Set(pc.clients.map((c) => c.key)));
      const recurring = [...allClientSets[0]].filter((ip) =>
        allClientSets.every((s) => s.has(ip))
      );
      if (recurring.length > 0) {
        flags.recurringClient = true;
        flags._recurringIps = recurring;
      }
    }

    for (const pc of peakClients) {
      if (pc.clients.length === 1) {
        flags.singleClientDominant = true;
        break;
      }
      if (pc.clients.length >= 2) {
        const first = pc.clients[0]?.UEII || 0;
        const second = pc.clients[1]?.UEII || 0;
        if (first > 0 && first > second * 3) {
          flags.singleClientDominant = true;
          break;
        }
      }
    }

    return flags;
  }
}

module.exports = { FaultDiagnosisSteps, matchHints };
module.exports.__test__ = { matchHints, evaluateHintCondition };
