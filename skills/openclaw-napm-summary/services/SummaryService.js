'use strict';

const SummaryClient = require('./SummaryClient');
const { aggregateAlertsSummary, aggregateAlertsTimeline } = require('./SummaryClient').__test__;

// ── helpers ─────────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Compute overallStatus from aggregated data.
 */
function computeOverallStatus(alertSummary = {}, trafficTrend = {}, businessSummary = {}, singleBusinessAnalysis = {}) {
  if ((alertSummary.critical || 0) > 0) return 'critical';
  if ((alertSummary.major || 0) > 0) return 'warning';
  if ((trafficTrend.stats?.missingPointCount || 0) > 0) return 'warning';
  if ((trafficTrend.stats?.spikeCount || 0) > 0) return 'warning';
  if (asArray(businessSummary.slowAccess).length > 0) return 'warning';
  if (asArray(businessSummary.httpErrors).length > 0) return 'warning';
  if ((singleBusinessAnalysis.overview?.slowVisitCount || 0) > 0) return 'warning';
  if ((singleBusinessAnalysis.httpCodeSummary?.http400 || 0) > 0) return 'warning';
  if ((singleBusinessAnalysis.httpCodeSummary?.http500 || 0) > 0) return 'warning';
  return 'ok';
}

/**
 * Compute basic stats from an array of numeric values.
 */
function computeStats(values = []) {
  const nums = asArray(values).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return { max: 0, avg: 0, min: 0 };
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return { max, avg, min };
}

/**
 * Detect missing points, zero segments, and spikes in a time series.
 */
function detectAnomalies(values = [], times = []) {
  const nums = asArray(values).map(Number);
  const missingPointCount = nums.filter((n) => !Number.isFinite(n) || n === null).length;
  const zeroSegmentCount = countSegments(nums, (n) => n === 0);
  const avg = nums.filter((n) => Number.isFinite(n) && n > 0).reduce((a, b) => a + b, 0) /
    Math.max(1, nums.filter((n) => Number.isFinite(n) && n > 0).length);
  const spikeCount = nums.filter((n) => Number.isFinite(n) && n > avg * 3).length;
  return { missingPointCount, zeroSegmentCount, spikeCount };
}

function countSegments(values, predicate) {
  let segments = 0;
  let inSegment = false;
  for (const v of values) {
    if (predicate(v)) {
      if (!inSegment) { segments++; inSegment = true; }
    } else {
      inSegment = false;
    }
  }
  return segments;
}

/**
 * Parse metric response (could be JSON array or CSV text).
 */
function parseMetricData(raw, metrics) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    // CSV parsing: first line is header, subsequent are data
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const values = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i]?.trim(); });
      return row;
    });
  }
  return [];
}

/**
 * Normalize timeValues response into { time[], <metric>[], unit } shape.
 *
 * NAPM timeValues API returns a structured object:
 * {
 *   interval: { start, end },
 *   granularity: <seconds>,
 *   metricValues: [
 *     { metric: { id: "TPIO", ... }, values: [123, 456, ...], stat: { max, min, avg } }
 *   ]
 * }
 */
function normalizeTimeSeries(raw, metrics) {
  if (!raw) return { time: [], unit: '' };

  // Handle structured NAPM response (object with metricValues)
  if (typeof raw === 'object' && !Array.isArray(raw) && raw.metricValues) {
    const interval = raw.interval || {};
    const granularity = Number(raw.granularity) || 60;
    const start = Number(interval.start) || 0;
    const mvList = Array.isArray(raw.metricValues) ? raw.metricValues : [];
    if (mvList.length === 0) return { time: [], unit: '' };

    // Build time axis from interval + granularity
    const firstMV = mvList[0];
    const valCount = Array.isArray(firstMV.values) ? firstMV.values.length : 0;
    const time = [];
    for (let i = 0; i < valCount; i++) {
      time.push(start + i * granularity);
    }

    const result = { time, unit: firstMV.metric?.unit || '' };
    for (const mv of mvList) {
      const metricId = mv.metric?.id || 'unknown';
      result[metricId] = Array.isArray(mv.values) ? mv.values.map(Number) : [];
    }
    return result;
  }

  // Fallback: JSON array or CSV string
  const rows = parseMetricData(raw, metrics);
  const metricList = Array.isArray(metrics) ? metrics : [metrics];
  const time = [];
  const series = {};
  for (const m of metricList) series[m] = [];

  for (const row of rows) {
    const t = Number(row.time || row.Time || row.timestamp || 0);
    time.push(t);
    for (const m of metricList) {
      series[m].push(Number(row[m]) || 0);
    }
  }

  return { time, ...series, unit: rows[0]?.unit || '' };
}

/**
 * Normalize averageValues response into a flat metric object.
 *
 * Supported input shapes:
 * 1. { metricValues: [{ metric:{id}, value, unit }] }
 * 2. [{ metricValues: [...] }]
 * 3. [{ PGNPGE: 123, PGNSLPGE: 4, ... }]
 * 4. CSV text
 */
function normalizeAverageValues(raw, metrics) {
  const metricList = Array.isArray(metrics)
    ? metrics
    : String(metrics || '').split(',').map((item) => item.trim()).filter(Boolean);

  const result = { units: {} };
  const assignValue = (metricId, value, unit) => {
    const numeric = Number(value);
    result[metricId] = Number.isFinite(numeric) ? numeric : value;
    if (unit) result.units[metricId] = unit;
  };

  if (!raw) return result;

  if (isPlainObject(raw) && Array.isArray(raw.metricValues)) {
    for (const item of raw.metricValues) {
      const metricId = item?.metric?.id;
      if (!metricId) continue;
      assignValue(metricId, item.value, item.unit || item?.metric?.unit);
    }
    return result;
  }

  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]?.metricValues)) {
    for (const item of raw[0].metricValues) {
      const metricId = item?.metric?.id;
      if (!metricId) continue;
      assignValue(metricId, item.value, item.unit || item?.metric?.unit);
    }
    return result;
  }

  const rows = parseMetricData(raw, metrics);
  const firstRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : (isPlainObject(raw) ? raw : null);
  if (!firstRow) return result;

  const keys = metricList.length > 0
    ? metricList
    : Object.keys(firstRow).filter((key) => !['key', 'keyLabel', 'group', 'groupPath', 'time', 'timestamp', 'unit', 'units'].includes(key));

  for (const metricId of keys) {
    if (!Object.prototype.hasOwnProperty.call(firstRow, metricId)) continue;
    assignValue(metricId, firstRow[metricId], firstRow?.units?.[metricId] || firstRow?.unit);
  }
  return result;
}

function buildTrendSummary(ts = {}, primaryMetricId) {
  const primaryValues = asArray(ts[primaryMetricId]).map(Number);
  const stats = {
    ...computeStats(primaryValues),
    ...detectAnomalies(primaryValues, ts.time)
  };

  const metricKeys = Object.keys(ts).filter((k) => k !== 'time' && k !== 'unit');
  const points = asArray(ts.time).map((t, i) => {
    const point = { time: t };
    metricKeys.forEach((metricKey) => {
      point[metricKey] = ts[metricKey]?.[i];
    });
    return point;
  });

  return {
    dataset: {
      points,
      metrics: metricKeys,
      unit: ts.unit || ''
    },
    stats
  };
}

/**
 * Normalize topValues response into an array of labeled objects.
 *
 * NAPM topValues API returns a structured object:
 * {
 *   group: { key, label, ... },
 *   topValues: [
 *     { key: "192.168.1.100", keyLabel: "192.168.1.100", metrics: { TPIO: 123, ... } }
 *   ]
 * }
 * OR a simple JSON array: [ { IPAddress: "...", TPIO: 123 }, ... ]
 */
function normalizeTopValues(raw, keyField) {
  if (!raw) return [];

  // Handle structured NAPM response: { topValues: [...] }
  if (typeof raw === 'object' && !Array.isArray(raw) && raw.topValues) {
    return flattenTopValuesItems(raw.topValues);
  }

  // Handle JSON array — could be flat rows OR nested { key, keyLabel, metricValues: [...] }
  if (Array.isArray(raw)) {
    return flattenTopValuesItems(raw);
  }

  // CSV string fallback
  const rows = parseMetricData(raw);
  return rows.map((row) => ({
    ...row,
    key: row[keyField] || row.key || row.keyLabel || '',
    keyLabel: row[keyField] || row.keyLabel || row.key || ''
  }));
}

/**
 * Flatten NAPM topValues items: extract key + metric values from nested structure.
 *
 * NAPM returns each item as:
 * { key: "192.168.1.100", keyLabel: "192.168.1.100",
 *   metricValues: [{ metric: { id: "TPIO", unit: "..." }, value: 123 }, ...] }
 *
 * We flatten to: { key: "192.168.1.100", keyLabel: "192.168.1.100", TPIO: 123, TPI: 456, ... }
 */
/**
 * Parse NAPM averageValues response into a key-value metrics map.
 * Response can be JSON array [{metric:...,value:...}] or object with metricValues.
 */
function parseAverageValues(raw) {
  const map = {};
  if (!raw) return map;

  // JSON array with metricValues: [{metricValues:[{metric:{id:"PGNPGE"},value:123}]}]
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const mvList = Array.isArray(item.metricValues) ? item.metricValues : [];
      for (const mv of mvList) {
        if (mv.metric?.id) map[mv.metric.id] = mv.value;
      }
    }
    return map;
  }

  // Single object with metricValues
  if (raw.metricValues) {
    for (const mv of raw.metricValues) {
      if (mv.metric?.id) map[mv.metric.id] = mv.value;
    }
    return map;
  }

  return map;
}

/**
 * Convert parallel-array timeSeries to points[] format for chart rendering.
 */
function buildTimePoints(ts, metricKeys) {
  return (ts.time || []).map((t, i) => {
    const pt = { time: t };
    metricKeys.forEach((mk) => { pt[mk] = ts[mk]?.[i]; });
    return pt;
  });
}

function flattenTopValuesItems(items) {
  const list = asArray(items);
  if (list.length === 0) return [];

  // NAPM API optimization: only the first item has full metric metadata (metric.id).
  // Subsequent items have values in the same order but without metric.id.
  // Cache the metric ID order from the first item.
  const firstMV = Array.isArray(list[0]?.metricValues) ? list[0].metricValues : [];
  const metricIdOrder = firstMV.map((mv) => mv.metric?.id || null);

  return list.map((item) => {
    const topKey = item.key || item.keyLabel || '';
    const groupKey = item.group?.argument || item.group?.label || '';
    const resolvedKey = topKey || groupKey;
    const result = {
      key: resolvedKey,
      keyLabel: item.keyLabel || item.key || groupKey || resolvedKey
    };
    const mvList = Array.isArray(item.metricValues) ? item.metricValues : [];
    for (let i = 0; i < mvList.length; i++) {
      const mv = mvList[i];
      // Use metric.id if present, otherwise fall back to the cached order from first item
      const metricId = mv.metric?.id || metricIdOrder[i];
      if (metricId) {
        result[metricId] = mv.value;
      }
    }
    return result;
  });
}

// ── SummaryService ──────────────────────────────────────────────

class SummaryService {
  constructor(options = {}) {
    this.client = options.client || new SummaryClient(options);
    this.timeoutMs = options.timeoutMs || 120000;
  }

  /**
   * Main entry: plan → execute → aggregate → result.
   */
  async run(input = {}) {
    const scope = isPlainObject(input.scope) ? input.scope : { type: 'global', label: '全局' };
    const timeRange = this._resolveTimeRange(input.timeRange || input, scope);

    // All non-global/non-alert scopes support both "整体" (no target) and "单个对象" (with target).

    const plan = this.plan(scope, timeRange);

    // Validate plan against NAPM metadata: skip unsupported metric × dimension combos
    try {
      const SummaryMetadataService = require('./SummaryMetadataService');
      const warnings = await SummaryMetadataService.validatePlan(plan);
      if (warnings.length > 0) {
        console.error('[SummaryService] Metric-dimension warnings:', JSON.stringify(warnings));
      }
    } catch (_) { /* metadata service unavailable — proceed with plan as-is */ }

    const rawData = await this.execute(plan);

    // ── Fault diagnosis: different aggregation and output shape ──
    if (scope.type === 'fault') {
      const faultResult = this._aggregateFault(rawData, scope, timeRange, input.fault || {});

      // Device info
      if (rawData.applianceInfo) {
        faultResult.deviceInfo = this._normalizeDeviceInfo(rawData.applianceInfo);
      }

      faultResult.reportDate = this._formatReportDate();

      return {
        ok: true,
        schema: 'openclaw_napm_fault_diagnosis_result.v1',
        scope,
        timeRange,
        fault: faultResult.fault,
        alertAnalysis: faultResult.alertAnalysis,
        trafficAnalysis: faultResult.trafficAnalysis,
        businessAnalysis: faultResult.businessAnalysis,
        reportData: null, // built downstream by SummaryReportDataService
        narrationInput: this._buildFaultNarrationInput(faultResult, scope, timeRange),
        audit: {
          sourceSkill: 'openclaw-napm-summary',
          requestHistory: this.client.requestHistory || [],
          queriesPerformed: plan.map((p) => p.label)
        }
      };
    }

    // ── Standard summary aggregation ──
    const summary = this.aggregate(rawData, scope, timeRange);

    // Device info
    if (rawData.applianceInfo) {
      summary.deviceInfo = this._normalizeDeviceInfo(rawData.applianceInfo);
    }

    // Overall status
    summary.overallStatus = computeOverallStatus(
      summary.alertSummary || {},
      summary.trafficSummary?.trend || {},
      summary.businessSummary || {},
      summary.singleBusinessAnalysis || {}
    );

    summary.reportDate = this._formatReportDate();
    summary.timeRange = timeRange;

    return {
      ok: true,
      schema: 'openclaw_napm_summary_result.v1',
      scope,
      timeRange,
      summary,
      reportData: null, // built downstream by SummaryReportDataService
      narrationInput: this._buildNarrationInput(summary, scope, timeRange),
      audit: {
        sourceSkill: 'openclaw-napm-summary',
        requestHistory: this.client.requestHistory || [],
        queriesPerformed: plan.map((p) => p.label)
      }
    };
  }

  // ── Query planning ─────────────────────────────────────────

  plan(scope = {}, timeRange = {}) {
    const { start, end } = timeRange;
    const scopeType = scope.type || 'global';
    const granularity = this._autoGranularity(start, end);

    const hasTarget = !!(scope.target && scope.target.groupType && scope.target.groupArgument);

    const plans = {
      global: () => this._planGlobal(start, end, granularity),
      webApplication: () => hasTarget
        ? this._planWebApplicationTarget(scope, start, end, granularity)
        : this._planWebApplicationOverview(start, end, granularity),
      network: () => hasTarget
        ? this._planNetworkTarget(scope, start, end, granularity)
        : this._planNetworkOverview(start, end, granularity),
      application: () => hasTarget
        ? this._planApplicationTarget(scope, start, end, granularity)
        : this._planApplicationOverview(start, end, granularity),
      businessGroup: () => hasTarget
        ? this._planBusinessGroupTarget(scope, start, end, granularity)
        : this._planBusinessGroupOverview(start, end, granularity),
      alert: () => this._planAlert(start, end, granularity),
      fault: () => this._planFault(scope, timeRange, granularity)
    };

    const planner = plans[scopeType] || plans.global;
    return planner();
  }

  _planGlobal(start, end, granularity) {
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'trafficTrend', groupType: 'TotalTraffic', metrics: ['TPIO', 'TPI', 'TPO'], fn: () => this.client.getTimeValues(start, end, 'TPIO,TPI,TPO', [{ type: 'TotalTraffic' }], granularity) },
      { label: 'topIPs', groupType: 'IPAddress', metrics: ['TPIO', 'TPI', 'TPO'], fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'IPAddress' }]) },
      { label: 'topApps', groupType: 'DefinedApp', metrics: ['TPIO', 'TPI', 'TPO'], fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'DefinedApp' }]) },
      { label: 'slowAccess', groupType: 'WebApplication', metrics: ['PGSLPCT', 'PGNSLPGE', 'PGTME'], fn: () => this.client.getTopValues(start, end, 'PGSLPCT,PGNSLPGE,PGTME', 'PGSLPCT', 10, [{ type: 'WebApplication' }]) },
      { label: 'httpErrors', groupType: 'WebApplication', metrics: ['PGHTTP400', 'PGHTTP500'], fn: () => this.client.getTopValues(start, end, 'PGHTTP400,PGHTTP500', 'PGHTTP500', 10, [{ type: 'WebApplication' }]) },
      { label: 'applianceInfo', fn: () => this.client.getApplianceInfo() }
    ];
  }

  // ── WebApplication: 业务整体（无 target） ──────────────────
  _planWebApplicationOverview(start, end, granularity) {
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'slowAccess', groupType: 'WebApplication', metrics: ['PGSLPCT', 'PGNSLPGE', 'PGTME'], fn: () => this.client.getTopValues(start, end, 'PGSLPCT,PGNSLPGE,PGTME', 'PGSLPCT', 10, [{ type: 'WebApplication' }]) },
      { label: 'httpErrors', groupType: 'WebApplication', metrics: ['PGHTTP400', 'PGHTTP500'], fn: () => this.client.getTopValues(start, end, 'PGHTTP400,PGHTTP500', 'PGHTTP500', 10, [{ type: 'WebApplication' }]) },
      { label: 'pageTraffic', groupType: 'WebApplication', metrics: ['PGBYTI', 'PGBYTO'], fn: () => this.client.getTopValues(start, end, 'PGBYTI,PGBYTO', 'PGBYTI', 10, [{ type: 'WebApplication' }]) },
      { label: 'pageViews', groupType: 'WebApplication', metrics: ['PGNPGE'], fn: () => this.client.getTopValues(start, end, 'PGNPGE', 'PGNPGE', 10, [{ type: 'WebApplication' }]) },
      { label: 'applianceInfo', fn: () => this.client.getApplianceInfo() }
    ];
  }

  // ── WebApplication: 单个业务（有 target） ──────────────────
  _planWebApplicationTarget(scope, start, end, granularity) {
    const target = scope.target || {};
    const groupArg = target.groupArgument || '';
    const groups = [{ type: 'WebApplication', argument: groupArg }];
    const clientIpGroups = [
      { type: 'WebApplication', argument: groupArg },
      { type: 'ClientIPs' },
      { type: 'IPAddress' }
    ];
    const clientBusinessGroups = [
      { type: 'WebApplication', argument: groupArg },
      { type: 'ClientBusinessGroupLabel' },
      { type: 'ClientBusinessGroup' }
    ];

    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'businessOverview', groupType: 'WebApplication', metrics: ['PGNPGE', 'PGNSLPGE', 'PGSLPCT', 'PGSLRT', 'PGTME'], fn: () => this.client.getAverageValues(start, end, 'PGNPGE,PGNSLPGE,PGSLPCT,PGSLRT,PGTME', groups) },
      { label: 'accessSlowTrend', groupType: 'WebApplication', metrics: ['PGNPGE', 'PGNSLPGE'], fn: () => this.client.getTimeValues(start, end, 'PGNPGE,PGNSLPGE', groups, granularity) },
      { label: 'nodeDistribution', groupType: 'WebApplication', metrics: ['PGNPGE', 'PGNSLPGE'], fn: () => this.client.getTopValues(start, end, 'PGNPGE,PGNSLPGE', 'PGNPGE', 5, clientBusinessGroups) },
      { label: 'resourceSummary', groupType: 'WebApplication', metrics: ['PGBYTI', 'PGSIZEI', 'PGSIZEO', 'PGBYTO', 'PGNOBJE'], fn: () => this.client.getAverageValues(start, end, 'PGBYTI,PGSIZEI,PGSIZEO,PGBYTO,PGNOBJE', groups) },
      { label: 'requestResponseTrend', groupType: 'WebApplication', metrics: ['PGBYTI', 'PGBYTO'], fn: () => this.client.getTimeValues(start, end, 'PGBYTI,PGBYTO', groups, granularity) },
      { label: 'slowClients', groupType: 'WebApplication', metrics: ['PGTME'], fn: () => this.client.getTopValues(start, end, 'PGTME', 'PGNPGE', 5, clientIpGroups) },
      { label: 'httpCodeSummary', groupType: 'WebApplication', metrics: ['PGHTTP100', 'PGHTTP200', 'PGHTTP300', 'PGHTTP400', 'PGHTTP500'], fn: () => this.client.getAverageValues(start, end, 'PGHTTP100,PGHTTP200,PGHTTP300,PGHTTP400,PGHTTP500', groups) },
      { label: 'http400Clients', groupType: 'WebApplication', metrics: ['PGHTTP400'], fn: () => this.client.getTopValues(start, end, 'PGHTTP400', 'PGHTTP400', 5, clientIpGroups) },
      { label: 'http500Clients', groupType: 'WebApplication', metrics: ['PGHTTP500'], fn: () => this.client.getTopValues(start, end, 'PGHTTP500', 'PGHTTP500', 5, clientIpGroups) },
      { label: 'applianceInfo', fn: () => this.client.getApplianceInfo() }
    ];
  }

  // ── Network: 流量整体（无 target） ──────────────────────
  _planNetworkOverview(start, end, granularity) {
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'trafficTrend', fn: () => this.client.getTimeValues(start, end, 'TPIO,TPI,TPO', [{ type: 'TotalTraffic' }], granularity) },
      { label: 'topIPs', fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'IPAddress' }]) },
      { label: 'topApps', fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'DefinedApp' }]) },
      { label: 'applianceInfo', fn: () => this.client.getApplianceInfo() }
    ];
  }

  // ── Network: 单个对象（有 target） ────────────────────────
  _planNetworkTarget(scope, start, end, granularity) {
    const target = scope.target || {};
    const groupType = target.groupType || 'TotalTraffic';
    const groupArg = target.groupArgument || '';
    const groups = groupArg ? [{ type: groupType, argument: groupArg }] : [{ type: 'TotalTraffic' }];
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'trafficTrend', fn: () => this.client.getTimeValues(start, end, 'TPIO,TPI,TPO,PLI,PLO', groups, granularity) }
    ];
  }

  // ── BusinessGroup: 工作组整体（无 target） ──────────────
  _planBusinessGroupOverview(start, end, granularity) {
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'topGroups', fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'BusinessGroup' }]) },
      { label: 'applianceInfo', fn: () => this.client.getApplianceInfo() }
    ];
  }

  // ── BusinessGroup: 单个工作组（有 target） ────────────────
  _planBusinessGroupTarget(scope, start, end, granularity) {
    const target = scope.target || {};
    const groupArg = target.groupArgument || '';
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'trafficTrend', fn: () => this.client.getTimeValues(start, end, 'TPIO,TPI,TPO', [{ type: 'BusinessGroup', argument: groupArg }], granularity) },
      { label: 'drillDown', fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'BusinessGroup', argument: groupArg }, { type: 'WebApplication' }]) }
    ];
  }

  // ── Application: 应用整体（无 target） ──────────────────
  _planApplicationOverview(start, end, granularity) {
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'topApps', fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'DefinedApp' }]) },
      { label: 'appConnections', fn: () => this.client.getTopValues(start, end, 'CONI,CONO', 'CONI', 10, [{ type: 'DefinedApp' }]) },
      { label: 'appFailures', fn: () => this.client.getTopValues(start, end, 'RFCO,RFCI', 'RFCO', 10, [{ type: 'DefinedApp' }]) },
      { label: 'appQuality', fn: () => this.client.getTopValues(start, end, 'PLI,PLO,RTTI,RTTO', 'PLI', 10, [{ type: 'DefinedApp' }]) },
      { label: 'applianceInfo', fn: () => this.client.getApplianceInfo() }
    ];
  }

  // ── Application: 单个应用（有 target） ──────────────────
  _planApplicationTarget(scope, start, end, granularity) {
    const target = scope.target || {};
    const groupArg = target.groupArgument || '';
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) },
      { label: 'trafficTrend', fn: () => this.client.getTimeValues(start, end, 'TPIO,TPI,TPO,PLI,PLO', [{ type: 'Application', argument: groupArg }], granularity) },
      { label: 'drillDown', fn: () => this.client.getTopValues(start, end, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'Application', argument: groupArg }, { type: 'IPAddress' }]) }
    ];
  }

  _planAlert(start, end, granularity) {
    return [
      { label: 'alertsSummary', fn: () => this.client.getAlertsSummary(start, end) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(start, end) }
    ];
  }

  // ── Fault: 故障分析 ──────────────────────────────────────

  /**
   * Fault diagnosis query plan.
   *
   * Unlike summary scopes which query a single time window,
   * fault analysis optionally compares two windows:
   *   timeRange.faultWindow — the incident period
   *   timeRange.baselineWindow — the "normal" period for comparison
   *
   * Query layers:
   *   1. Alerts (always) — fault window alerts + timeline
   *   2. Traffic (always) — fault trend + optional baseline trend + top IPs
   *   3. Business (focus=all | focus=business) — slow access + HTTP errors
   *   4. Device info (always) — appliance metadata
   *
   * focus 可选值: "all" (默认) | "traffic" | "business"
   */
  _planFault(scope, timeRange, granularity) {
    const faultWindow = timeRange.faultWindow || { start: timeRange.start, end: timeRange.end };
    const baselineWindow = timeRange.baselineWindow || null;
    const faultStart = faultWindow.start;
    const faultEnd = faultWindow.end;
    const focus = scope.focus || 'all';

    // Resolve traffic groups: default to TotalTraffic, or use scope.target for scoped faults
    const target = scope.target || {};
    let groups = [{ type: 'TotalTraffic' }];
    if (target.groupType && target.groupArgument) {
      groups = [{ type: target.groupType, argument: target.groupArgument }];
    }

    const plan = [
      // ── Layer 1: Alerts ──
      { label: 'alertsSummary',  fn: () => this.client.getAlertsSummary(faultStart, faultEnd) },
      { label: 'alertsTimeline', fn: () => this.client.getAlertsTimeline(faultStart, faultEnd) },

      // ── Layer 2: Traffic ──
      { label: 'faultTrend', groupType: 'Traffic', metrics: ['TPIO', 'TPI', 'TPO'],
        fn: () => this.client.getTimeValues(faultStart, faultEnd, 'TPIO,TPI,TPO,PLI,PLO', groups, granularity) },
      { label: 'topIPs', groupType: 'IPAddress', metrics: ['TPIO', 'TPI', 'TPO'],
        fn: () => this.client.getTopValues(faultStart, faultEnd, 'TPIO,TPI,TPO', 'TPIO', 10, [{ type: 'IPAddress' }]) },
    ];

    // Baseline traffic (if available)
    if (baselineWindow && baselineWindow.start && baselineWindow.end) {
      plan.push(
        { label: 'baselineTrend', groupType: 'Traffic', metrics: ['TPIO', 'TPI', 'TPO'],
          fn: () => this.client.getTimeValues(baselineWindow.start, baselineWindow.end, 'TPIO,TPI,TPO', groups, granularity) }
      );
    }

    // ── Layer 3: Business (when focus includes business) ──
    if (focus === 'all' || focus === 'business') {
      plan.push(
        { label: 'slowAccess', groupType: 'WebApplication', metrics: ['PGSLPCT', 'PGNSLPGE', 'PGTME'],
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'PGSLPCT,PGNSLPGE,PGTME', 'PGSLPCT', 10, [{ type: 'WebApplication' }]) },
        { label: 'httpErrors', groupType: 'WebApplication', metrics: ['PGHTTP400', 'PGHTTP500'],
          fn: () => this.client.getTopValues(faultStart, faultEnd, 'PGHTTP400,PGHTTP500', 'PGHTTP500', 10, [{ type: 'WebApplication' }]) }
      );
    }

    // App-level connection / failure / quality data (when target is DefinedApp or Application)
    if (target.groupType === 'DefinedApp' || target.groupType === 'Application') {
      plan.push(
        { label: 'appConnections', fn: () => this.client.getTopValues(faultStart, faultEnd, 'CONI,CONO', 'CONI', 10, [groups[0]]) },
        { label: 'appFailures',    fn: () => this.client.getTopValues(faultStart, faultEnd, 'RFCO,RFCI', 'RFCO', 10, [groups[0]]) },
        { label: 'appQuality',     fn: () => this.client.getTopValues(faultStart, faultEnd, 'PLI,PLO,RTTI,RTTO', 'PLI', 10, [groups[0]]) }
      );
    }

    // ── Layer 4: Device info ──
    plan.push({ label: 'applianceInfo', fn: () => this.client.getApplianceInfo() });

    return plan;
  }

  // ── Query execution ────────────────────────────────────────

  async execute(plan = []) {
    const results = {};
    // Execute in parallel
    const settled = await Promise.allSettled(plan.map((p) => p.fn()));
    plan.forEach((p, i) => {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        results[p.label] = result.value;
      } else {
        console.error(`[SummaryService] Query "${p.label}" failed:`, result.reason?.message || result.reason);
        results[p.label] = null;
      }
    });
    return results;
  }

  // ── Data aggregation ───────────────────────────────────────

  aggregate(rawData = {}, scope = {}, timeRange = {}) {
    const scopeType = scope.type || 'global';
    const hasTarget = !!(scope.target && scope.target.groupType && scope.target.groupArgument);
    const summary = {
      alertSummary: this._aggregateAlerts(rawData, scope),
      trafficSummary: this._aggregateTraffic(rawData, scope),
      businessSummary: this._aggregateBusiness(rawData, scope),
      conclusion: null,
      recommendations: []
    };
    return summary;
  }

  _aggregateAlerts(rawData = {}, scope = {}) {
    const scopeType = scope.type || 'global';
    const target = scope.target || {};

    const alertSummary = aggregateAlertsSummary(rawData.alertsSummary);
    const timeline = aggregateAlertsTimeline(rawData.alertsTimeline);

    // Scope-based category filtering: each scope focuses on relevant alert types
    const scopeAlertCategories = {
      webApplication: ['appAlerts', 'busAlerts'],
      application: ['appAlerts'],
      businessGroup: ['busAlerts', 'appAlerts'],
      network: ['networkAlerts', 'networkIssueAlerts']
    };
    const relevantCategories = scopeAlertCategories[scopeType] || null;

    // For scoped with target: filter by object AND by relevant categories
    if (scopeType !== 'global' && target.groupType && target.groupArgument) {
      const unresolvedFiltered = (alertSummary.unresolvedAlerts || []).filter(
        (a) => a.group === target.groupArgument
      );
      const result = {
        ...alertSummary,
        topObjects: alertSummary.topObjects.filter(
          (o) => o.group === target.groupArgument
        ),
        unresolvedAlerts: unresolvedFiltered
      };
      // Also apply category filtering for the scope
      if (relevantCategories) {
        result.byCategory = alertSummary.byCategory.filter(
          (c) => relevantCategories.includes(c.category)
        );
        result.total = result.byCategory.reduce((s, c) => s + c.count, 0);
        result.critical = result.byCategory.reduce((s, c) => s + (c.critical || 0), 0);
        result.major = result.byCategory.reduce((s, c) => s + (c.major || 0), 0);
        result.minor = result.byCategory.reduce((s, c) => s + (c.minor || 0), 0);
      }
      return { ...result, timeline };
    }

    // For scoped without target (overview): filter by relevant alert categories
    if (relevantCategories) {
      const filtered = {
        ...alertSummary,
        byCategory: alertSummary.byCategory.filter(
          (c) => relevantCategories.includes(c.category)
        ),
        topObjects: alertSummary.topObjects.filter(
          (o) => relevantCategories.some((cat) => {
            // topObjects don't have category, skip filtering for overview
            return true;
          })
        )
      };
      // Recompute totals from filtered categories
      filtered.total = filtered.byCategory.reduce((s, c) => s + c.count, 0);
      filtered.critical = filtered.byCategory.reduce((s, c) => s + (c.critical || 0), 0);
      filtered.major = filtered.byCategory.reduce((s, c) => s + (c.major || 0), 0);
      filtered.minor = filtered.byCategory.reduce((s, c) => s + (c.minor || 0), 0);
      return { ...filtered, timeline };
    }

    return { ...alertSummary, timeline };
  }

  _aggregateTraffic(rawData = {}, scope = {}) {
    const scopeType = scope.type || 'global';
    const hasTarget = !!(scope.target && scope.target.groupType && scope.target.groupArgument);
    const trafficSummary = { trend: null, topIPs: [], topApps: [], drillDown: null, appConnections: [], appFailures: [], appQuality: [] };

    if (scopeType === 'webApplication' && hasTarget && rawData.requestResponseTrend) {
      const ts = normalizeTimeSeries(rawData.requestResponseTrend, ['PGBYTI', 'PGBYTO']);
      trafficSummary.trend = buildTrendSummary(ts, 'PGBYTI');
    } else if (scopeType !== 'alert' && rawData.trafficTrend) {
      const metrics = scopeType === 'global'
        ? ['TPIO', 'TPI', 'TPO']
        : ['TPIO', 'TPI', 'TPO', 'PLI', 'PLO', 'PGSLPCT', 'PGTME', 'PGHTTP400', 'PGHTTP500'];
      const ts = normalizeTimeSeries(rawData.trafficTrend, metrics);
      trafficSummary.trend = buildTrendSummary(ts, 'TPIO');
    }

    if ((scopeType === 'global' || scopeType === 'network') && rawData.topIPs) {
      trafficSummary.topIPs = normalizeTopValues(rawData.topIPs, 'IPAddress');
    }

    if (rawData.topApps) {
      const keyField = scopeType === 'webApplication' ? 'WebApplication' : 'DefinedApp';
      trafficSummary.topApps = normalizeTopValues(rawData.topApps, keyField);
    }

    if (scopeType === 'businessGroup' && rawData.topGroups) {
      trafficSummary.topApps = normalizeTopValues(rawData.topGroups, 'BusinessGroup');
    }

    if (rawData.drillDown) {
      trafficSummary.drillDown = {
        groupType: 'IPAddress',
        label: '下级维度',
        items: normalizeTopValues(rawData.drillDown, 'IPAddress')
      };
    }

    if (rawData.appConnections) {
      trafficSummary.appConnections = normalizeTopValues(rawData.appConnections, 'DefinedApp').map((row) => ({
        appName: row.key || row.keyLabel || '-',
        connIn: Number(row.CONI || 0),
        connOut: Number(row.CONO || 0)
      }));
    }

    if (rawData.appFailures) {
      trafficSummary.appFailures = normalizeTopValues(rawData.appFailures, 'DefinedApp').map((row) => ({
        appName: row.key || row.keyLabel || '-',
        failOut: Number(row.RFCO || 0),
        failIn: Number(row.RFCI || 0)
      }));
    }

    if (rawData.appQuality) {
      trafficSummary.appQuality = normalizeTopValues(rawData.appQuality, 'DefinedApp').map((row) => ({
        appName: row.key || row.keyLabel || '-',
        lossIn: Number(row.PLI || 0),
        lossOut: Number(row.PLO || 0),
        rttIn: Number(row.RTTI || 0),
        rttOut: Number(row.RTTO || 0)
      }));
    }

    return trafficSummary;
  }

  _aggregateBusiness(rawData = {}, scope = {}) {
    const scopeType = scope.type || 'global';
    const hasTarget = !!(scope.target && scope.target.groupType && scope.target.groupArgument);
    const businessSummary = {
      // overview (no target)
      slowAccess: [], httpErrors: [], pageTraffic: [], pageViews: [],
      // targeted (has target) — business analysis
      overview: null, accessTrend: null, nodeDist: [],
      resource: null, trafficTrend: null, slowClients: [],
      httpCodes: null, error400Clients: [], error500Clients: []
    };

    if (scopeType !== 'global' && scopeType !== 'webApplication') return businessSummary;

    // ── TARGETED: single web application analysis ──────────────
    if (hasTarget) {
      // Business overview (averageValues: PGNPGE,PGNSLPGE,PGSLPCT,PGSLRT,PGTME)
      if (rawData.businessOverview) {
        businessSummary.overview = parseAverageValues(rawData.businessOverview);
      }

      // Access + slow trend (timeValues)
      if (rawData.accessSlowTrend) {
        const ts = normalizeTimeSeries(rawData.accessSlowTrend, ['PGNPGE', 'PGNSLPGE']);
        if (ts.time?.length > 0) {
          businessSummary.accessTrend = {
            dataset: { points: buildTimePoints(ts, ['PGNPGE', 'PGNSLPGE']), metrics: ['PGNPGE', 'PGNSLPGE'], unit: '' }
          };
        }
      }

      // Node distribution (topValues: PGNPGE,PGNSLPGE by ClientBusinessGroup)
      if (rawData.nodeDistribution) {
        businessSummary.nodeDist = normalizeTopValues(rawData.nodeDistribution, 'ClientBusinessGroup')
          .map((row) => ({
            nodeName: row.key || row.keyLabel || '-',
            pageViews: Number(row.PGNPGE || 0),
            slowViews: Number(row.PGNSLPGE || 0)
          }));
      }

      // Resource summary (averageValues: PGBYTI,PGSIZEI,PGSIZEO,PGBYTO,PGNOBJE)
      if (rawData.resourceSummary) {
        businessSummary.resource = parseAverageValues(rawData.resourceSummary);
      }

      // Request/response traffic trend (timeValues)
      if (rawData.requestResponseTrend) {
        const ts = normalizeTimeSeries(rawData.requestResponseTrend, ['PGBYTI', 'PGBYTO']);
        if (ts.time?.length > 0) {
          businessSummary.trafficTrend = {
            dataset: { points: buildTimePoints(ts, ['PGBYTI', 'PGBYTO']), metrics: ['PGBYTI', 'PGBYTO'], unit: '' }
          };
        }
      }

      // Slowest clients (topValues: PGTME by ClientIPs→IPAddress)
      if (rawData.slowClients) {
        businessSummary.slowClients = normalizeTopValues(rawData.slowClients, 'IPAddress')
          .map((row) => ({
            clientIp: row.key || row.keyLabel || '-',
            avgDelayMs: Number(row.PGTME || 0)
          }));
      }

      // HTTP code summary (averageValues: PGHTTP100-500)
      if (rawData.httpCodeSummary) {
        businessSummary.httpCodes = parseAverageValues(rawData.httpCodeSummary);
      }

      // 400 error clients (topValues by ClientIPs→IPAddress)
      if (rawData.http400Clients) {
        businessSummary.error400Clients = normalizeTopValues(rawData.http400Clients, 'IPAddress')
          .map((row) => ({
            clientIp: row.key || row.keyLabel || '-',
            errorCount: Number(row.PGHTTP400 || 0)
          }));
      }

      // 500 error clients (topValues by ClientIPs→IPAddress)
      if (rawData.http500Clients) {
        businessSummary.error500Clients = normalizeTopValues(rawData.http500Clients, 'IPAddress')
          .map((row) => ({
            clientIp: row.key || row.keyLabel || '-',
            errorCount: Number(row.PGHTTP500 || 0)
          }));
      }

      return businessSummary;
    }

    // ── OVERVIEW: all web applications ─────────────────────────
    // Slow access
    if (rawData.slowAccess) {
      businessSummary.slowAccess = normalizeTopValues(rawData.slowAccess, 'WebApplication').map((row) => {
        const delay = Number(row.PGTME || row.avgPageDelayMs || 0);
        const pct = Number(row.PGSLPCT || 0);
        return {
          businessName: row.WebApplication || row.keyLabel || row.key || '-',
          slowCount: Number(row.PGNSLPGE || row.slowCount || 0),
          ratio: row.PGSLPCT ? `${pct.toFixed(2)}%` : (row.ratio || '0%'),
          avgPageDelayMs: Number.isFinite(delay) ? Math.round(delay * 100) / 100 : delay
        };
      });
    }

    // HTTP errors (overview)
    if (rawData.httpErrors) {
      businessSummary.httpErrors = normalizeTopValues(rawData.httpErrors, 'WebApplication').map((row) => ({
        businessName: row.WebApplication || row.keyLabel || row.key || '-',
        http400: Number(row.PGHTTP400 || row.http400 || 0),
        http500: Number(row.PGHTTP500 || row.http500 || 0)
      }));
    }

    // Page traffic
    if (rawData.pageTraffic) {
      businessSummary.pageTraffic = normalizeTopValues(rawData.pageTraffic, 'WebApplication').map((row) => ({
        businessName: row.WebApplication || row.keyLabel || row.key || '-',
        requestBytes: Number(row.PGBYTI || 0),
        responseBytes: Number(row.PGBYTO || 0)
      }));
    }

    // Page views
    if (rawData.pageViews) {
      businessSummary.pageViews = normalizeTopValues(rawData.pageViews, 'WebApplication').map((row) => ({
        businessName: row.WebApplication || row.keyLabel || row.key || '-',
        pageViews: Number(row.PGNPGE || 0)
      }));
    }

    return businessSummary;
  }

  // ── Fault diagnosis aggregation ────────────────────────────

  /**
   * Aggregate raw NAPM data into fault analysis report data structure.
   *
   * This differs from normal aggregate() in that it:
   *   - Computes drop% between baseline and fault window
   *   - Detects anomalies with fault window context
   *   - Correlates alerts with traffic anomalies
   *   - Produces the diagnostic_report data contract
   */
  _aggregateFault(rawData = {}, scope = {}, timeRange = {}, faultInput = {}) {
    const faultWindow = timeRange.faultWindow || timeRange;
    const baselineWindow = timeRange.baselineWindow || null;

    // ── Alert analysis ──
    const alertSummary = aggregateAlertsSummary(rawData.alertsSummary);
    const alertTimeline = aggregateAlertsTimeline(rawData.alertsTimeline);
    const alertOverallStatus = (alertSummary.critical || 0) > 0 ? 'critical'
      : (alertSummary.major || 0) > 0 ? 'warning' : 'ok';

    const alertAnalysis = {
      overallStatus: alertOverallStatus,
      summary: { ...alertSummary },
      timeline: alertTimeline
    };

    // ── Traffic analysis ──
    const trafficAnalysis = { trend: null, baselineTrend: null, topIPs: [], anomalies: [], appConnections: [], appFailures: [], appQuality: [] };

    if (rawData.faultTrend) {
      const metrics = ['TPIO', 'TPI', 'TPO', 'PLI', 'PLO'];
      const ts = normalizeTimeSeries(rawData.faultTrend, metrics);
      const tpioValues = ts.TPIO || [];
      const stats = {
        ...computeStats(tpioValues),
        ...detectAnomalies(tpioValues, ts.time)
      };

      const metricKeys = Object.keys(ts).filter((k) => k !== 'time' && k !== 'unit');
      const points = (ts.time || []).map((t, i) => {
        const point = { time: t };
        metricKeys.forEach((mk) => { point[mk] = ts[mk]?.[i]; });
        return point;
      });

      trafficAnalysis.trend = {
        dataset: { points, metrics: metricKeys, unit: ts.unit || '' },
        stats
      };
    }

    // Baseline traffic (for comparison)
    if (rawData.baselineTrend) {
      const metrics = ['TPIO', 'TPI', 'TPO'];
      const bTs = normalizeTimeSeries(rawData.baselineTrend, metrics);
      const bMetricKeys = Object.keys(bTs).filter((k) => k !== 'time' && k !== 'unit');
      const bPoints = (bTs.time || []).map((t, i) => {
        const point = { time: t };
        bMetricKeys.forEach((mk) => { point[mk] = bTs[mk]?.[i]; });
        return point;
      });

      trafficAnalysis.baselineTrend = {
        dataset: { points: bPoints, metrics: bMetricKeys, unit: bTs.unit || '' },
        stats: computeStats(bTs.TPIO || [])
      };
    }

    // ── Anomaly detection + baseline comparison ──
    if (rawData.faultTrend) {
      const faultStats = trafficAnalysis.trend?.stats || {};
      const faultAvg = (trafficAnalysis.trend?.dataset?.points || [])
        .reduce((sum, p) => sum + (Number(p.TPIO) || 0), 0) /
        Math.max(1, (trafficAnalysis.trend?.dataset?.points || []).length);

      const baselineAvg = baselineWindow && rawData.baselineTrend
        ? (trafficAnalysis.baselineTrend?.dataset?.points || [])
            .reduce((sum, p) => sum + (Number(p.TPIO) || 0), 0) /
          Math.max(1, (trafficAnalysis.baselineTrend?.dataset?.points || []).length)
        : null;

      // Detect significant traffic drop
      if (baselineAvg !== null && baselineAvg > 0) {
        const faultMin = faultStats.min || faultAvg;
        const dropPercent = ((baselineAvg - faultMin) / baselineAvg) * 100;
        if (dropPercent > 30) {
          trafficAnalysis.anomalies.push({
            time: this._findAnomalyTime(trafficAnalysis.trend?.dataset?.points || [], 'TPIO', 'min'),
            metric: 'TPIO',
            description: `流量从基线均值 ${this._formatBps(baselineAvg)} 骤降至 ${this._formatBps(faultMin)}，降幅 ${dropPercent.toFixed(0)}%`,
            severity: dropPercent > 60 ? 'critical' : 'major',
            dropPercent: Math.round(dropPercent)
          });
        }
      }

      // Missing points
      if (faultStats.missingPointCount > 0) {
        trafficAnalysis.anomalies.push({
          time: this._findAnomalyTime(trafficAnalysis.trend?.dataset?.points || [], null, 'gap'),
          metric: 'TPIO',
          description: `流量趋势存在 ${faultStats.missingPointCount} 个疑似缺失点，可能为采集中断`,
          severity: 'warning'
        });
      }

      // Zero segments
      if (faultStats.zeroSegmentCount > 0) {
        trafficAnalysis.anomalies.push({
          time: this._findAnomalyTime(trafficAnalysis.trend?.dataset?.points || [], null, 'zero'),
          metric: 'TPIO',
          description: `流量趋势存在 ${faultStats.zeroSegmentCount} 个零流量片段，可能为链路中断`,
          severity: 'critical'
        });
      }

      // Spikes
      if (faultStats.spikeCount > 0) {
        trafficAnalysis.anomalies.push({
          time: this._findAnomalyTime(trafficAnalysis.trend?.dataset?.points || [], 'TPIO', 'max'),
          metric: 'TPIO',
          description: `流量趋势存在 ${faultStats.spikeCount} 个异常尖峰`,
          severity: 'warning'
        });
      }
    }

    // Top IPs
    if (rawData.topIPs) {
      trafficAnalysis.topIPs = normalizeTopValues(rawData.topIPs, 'IPAddress');
    }

    // App-level data
    if (rawData.appConnections) {
      trafficAnalysis.appConnections = normalizeTopValues(rawData.appConnections, 'DefinedApp').map((row) => ({
        appName: row.key || row.keyLabel || '-',
        connIn: Number(row.CONI || 0),
        connOut: Number(row.CONO || 0)
      }));
    }
    if (rawData.appFailures) {
      trafficAnalysis.appFailures = normalizeTopValues(rawData.appFailures, 'DefinedApp').map((row) => ({
        appName: row.key || row.keyLabel || '-',
        failOut: Number(row.RFCO || 0),
        failIn: Number(row.RFCI || 0)
      }));
    }
    if (rawData.appQuality) {
      trafficAnalysis.appQuality = normalizeTopValues(rawData.appQuality, 'DefinedApp').map((row) => ({
        appName: row.key || row.keyLabel || '-',
        lossIn: Number(row.PLI || 0),
        lossOut: Number(row.PLO || 0),
        rttIn: Number(row.RTTI || 0),
        rttOut: Number(row.RTTO || 0)
      }));
    }

    // ── Business analysis ──
    const businessAnalysis = { slowAccess: [], httpErrors: [] };

    if (rawData.slowAccess) {
      businessAnalysis.slowAccess = normalizeTopValues(rawData.slowAccess, 'WebApplication').map((row) => {
        const delay = Number(row.PGTME || row.avgPageDelayMs || 0);
        const pct = Number(row.PGSLPCT || 0);
        return {
          businessName: row.WebApplication || row.keyLabel || row.key || '-',
          slowCount: Number(row.PGNSLPGE || row.slowCount || 0),
          ratio: row.PGSLPCT ? `${pct.toFixed(2)}%` : (row.ratio || '0%'),
          avgPageDelayMs: Number.isFinite(delay) ? Math.round(delay * 100) / 100 : delay
        };
      });
    }

    if (rawData.httpErrors) {
      businessAnalysis.httpErrors = normalizeTopValues(rawData.httpErrors, 'WebApplication').map((row) => ({
        businessName: row.WebApplication || row.keyLabel || row.key || '-',
        http400: Number(row.PGHTTP400 || row.http400 || 0),
        http500: Number(row.PGHTTP500 || row.http500 || 0)
      }));
    }

    // ── Fault metadata ──
    const fault = {
      description: faultInput.description || scope.fault?.description || '未命名故障',
      severity: faultInput.severity || scope.fault?.severity || alertOverallStatus,
      affectedObjects: faultInput.affectedObjects || scope.fault?.affectedObjects || [],
      timeline: faultInput.timeline || scope.fault?.timeline || [],
      recommendations: faultInput.recommendations || scope.fault?.recommendations || [],
      prevention: faultInput.prevention || scope.fault?.prevention || []
    };

    // Auto-populate timeline from anomalies if not provided
    if (fault.timeline.length === 0 && trafficAnalysis.anomalies.length > 0) {
      for (const anomaly of trafficAnalysis.anomalies) {
        fault.timeline.push({
          time: anomaly.time || '-',
          event: anomaly.description,
          type: anomaly.severity === 'critical' ? 'trigger' : 'impact'
        });
      }
    }

    // Auto-generate recommendations if not provided
    if (fault.recommendations.length === 0) {
      if (alertAnalysis.summary.critical > 0) {
        fault.recommendations.push(`优先处理 ${alertAnalysis.summary.critical} 条紧急告警`);
      }
      if (trafficAnalysis.anomalies.length > 0) {
        fault.recommendations.push(`排查 ${trafficAnalysis.anomalies.length} 个流量异常点，确认根因`);
      }
      if (businessAnalysis.slowAccess.length > 0) {
        fault.recommendations.push(`关注 ${businessAnalysis.slowAccess.length} 个慢访问业务的后端服务状态`);
      }
      if (businessAnalysis.httpErrors.length > 0) {
        fault.recommendations.push(`排查 HTTP 错误来源，检查应用日志和网关状态`);
      }
      if (fault.recommendations.length === 0) {
        fault.recommendations.push('建议结合各维度数据进行综合分析，必要时进行抓包复现');
      }
    }

    if (fault.prevention.length === 0) {
      fault.prevention.push('建议将相关指标纳入监控告警策略');
      fault.prevention.push('定期进行同类型故障预防性检查');
    }

    return { fault, alertAnalysis, trafficAnalysis, businessAnalysis };
  }

  /**
   * Find the timestamp of the most significant anomaly in a time series.
   */
  _findAnomalyTime(points = [], metric, mode) {
    if (points.length === 0) return '-';
    if (mode === 'max') {
      let maxVal = -Infinity, maxTime = points[0]?.time;
      for (const p of points) {
        const v = Number(metric ? p[metric] : 0);
        if (v > maxVal) { maxVal = v; maxTime = p.time; }
      }
      return maxTime;
    }
    if (mode === 'min') {
      let minVal = Infinity, minTime = points[0]?.time;
      for (const p of points) {
        const v = Number(metric ? p[metric] : 0);
        if (Number.isFinite(v) && v > 0 && v < minVal) { minVal = v; minTime = p.time; }
      }
      return minTime;
    }
    // 'gap' or 'zero' — return the first point
    return points[0]?.time || '-';
  }

  /**
   * Format bps value to human-readable string.
   */
  _formatBps(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}Gbps`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}Mbps`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}kbps`;
    return `${n.toFixed(0)}bps`;
  }

  _buildFaultNarrationInput(faultResult = {}, scope = {}, timeRange = {}) {
    const alertAnalysis = faultResult.alertAnalysis || {};
    const trafficAnalysis = faultResult.trafficAnalysis || {};
    const businessAnalysis = faultResult.businessAnalysis || {};

    return {
      schema: 'openclaw_napm_fault_diagnosis.v1',
      fault: faultResult.fault,
      alertAnalysis,
      trafficAnalysis,
      businessAnalysis,
      scope,
      timeRange,
      promptHint: `请根据以下故障诊断数据，撰写一份专业的故障分析报告叙述。`
        + `故障描述：${faultResult.fault?.description || ''}。`
        + `时间范围：${timeRange.displayText || ''}。`
        + `告警总数：${alertAnalysis.summary?.total || 0}（紧急 ${alertAnalysis.summary?.critical || 0}）。`
        + `流量异常：${trafficAnalysis.anomalies?.length || 0} 个。`
    };
  }

  // ── Helpers ────────────────────────────────────────────────

  _resolveTimeRange(input = {}, scope = {}) {
    // Fault scope: support nested faultWindow + baselineWindow
    if (scope.type === 'fault' && isPlainObject(input.faultWindow)) {
      const fw = input.faultWindow;
      const bw = input.baselineWindow || null;
      const now = Math.floor(Date.now() / 1000);
      const faultStart = Number(fw.start) || (now - 7200);
      const faultEnd = Number(fw.end) || now;
      const result = {
        start: faultStart,
        end: faultEnd,
        displayText: input.displayText || this._formatTimeRange(faultStart, faultEnd),
        faultWindow: { start: faultStart, end: faultEnd },
        baselineWindow: null
      };
      if (bw && (bw.start || bw.end)) {
        const bs = Number(bw.start) || (faultStart - 86400);
        const be = Number(bw.end) || faultStart;
        result.baselineWindow = { start: bs, end: be };
      }
      return result;
    }

    const now = Math.floor(Date.now() / 1000);
    const MAX_PAST_SEC = 365 * 86400; // 1 year sanity bound

    let start = Number(input.start) || 0;
    let end = Number(input.end) || 0;

    // Sanity check: reject timestamps more than 1 year in the past or 1 day in the future
    if (!start || start < now - MAX_PAST_SEC || start > now + 86400) {
      start = now - 86400;
    }
    if (!end || end < now - MAX_PAST_SEC || end > now + 86400) {
      end = now;
    }
    const displayText = input.displayText || this._formatTimeRange(start, end);
    return { start, end, displayText };
  }

  _formatTimeRange(start, end) {
    const s = new Date(Number(start) * 1000);
    const e = new Date(Number(end) * 1000);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return `${fmt(s)} ~ ${fmt(e)}`;
  }

  _formatReportDate() {
    const d = new Date();
    return `${d.getFullYear()}年${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日`;
  }

  _autoGranularity(start, end) {
    const rangeSec = Math.abs(Number(end || 0) - Number(start || 0));
    if (rangeSec <= 86400) return 60;
    if (rangeSec <= 604800) return 3600;
    return 86400;
  }

  _normalizeDeviceInfo(raw) {
    if (!isPlainObject(raw)) return {};
    return {
      systemName: raw.boxName || raw.systemName || raw.hostname || '',
      ip: raw.address || raw.ip || raw.ipAddress || '',
      softwareVersion: '5.0',
      serialNumber: this._formatSerialNumber(raw.serialNumber || raw.sn || ''),
      uptime: raw.uptime || ''
    };
  }

  _formatSerialNumber(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    // 通用前缀替换：将原始前缀（如 ARXVXA、ARX3800）统一替换为 NAPM
    return text.replace(/^[A-Z0-9]+-/i, 'NAPM-');
  }

  _buildNarrationInput(summary = {}, scope = {}, timeRange = {}) {
    const scopeLabel = scope.label || '全局';
    const targetLabel = scope.target?.groupLabel || '';
    const focusText = scope.type === 'global' ? '整个系统' : targetLabel;

    return {
      schema: 'openclaw_napm_summary.v1',
      summary,
      scope,
      timeRange,
      promptHint: `请根据以下${scopeLabel}综述数据，撰写一份专业的NAPM${scopeLabel}综述报告叙述。聚焦对象：${focusText}。时间范围：${timeRange.displayText || ''}。`
    };
  }
}

module.exports = SummaryService;
module.exports.__test__ = {
  computeOverallStatus,
  computeStats,
  detectAnomalies,
  normalizeTimeSeries,
  normalizeTopValues,
  parseMetricData
};
