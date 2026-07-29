'use strict';

const axios = require('axios');
const https = require('https');
const { URL, URLSearchParams } = require('url');

// ── URL helpers ─────────────────────────────────────────────────

function normalizeHost(host = '') {
  const raw = String(host || '').trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch (_error) {
    return withProtocol;
  }
}

function buildNetInsideUrl(host, params = {}) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) throw new Error('NETINSIDE_HOST is required.');

  const base = new URL(normalizedHost);
  const isNetInsidePath = /\/webservice\/NetInside\/?$/i.test(base.pathname);
  const url = isNetInsidePath ? base : new URL('/webservice/NetInside', normalizedHost);
  url.search = '';

  const searchParams = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) searchParams.append(key, String(item));
      } else {
        searchParams.set(key, String(value));
      }
    }
  }

  url.search = searchParams.toString();
  return url.toString();
}

function maskUrl(inputUrl = '') {
  try {
    const url = new URL(String(inputUrl || ''));
    for (const key of [...url.searchParams.keys()]) {
      if (/password|passwd|token|secret|authorization/i.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString();
  } catch (_error) {
    return String(inputUrl || '');
  }
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/^﻿/, '').trim();
  if (!text) return null;
  if (/^</.test(text)) return value;
  return JSON.parse(text);
}

// ── Alert normalization helpers ─────────────────────────────────

const ALERT_CATEGORY_LABELS = {
  networkAlerts: '网络性能告警',
  networkIssueAlerts: '网络异常告警',
  appAlerts: '应用性能告警',
  busAlerts: '业务故障告警',
  userAlerts: '用户体验告警',
  securityAlerts: '安全事件告警',
  AIAlerts: '智能分析告警'
};

const SEVERITY_LABELS = { 2: '轻微', 3: '重大', 4: '紧急' };

// ── SummaryClient ───────────────────────────────────────────────

class SummaryClient {
  constructor(options = {}) {
    this.host = options.host || process.env.NETINSIDE_HOST;
    this.username = options.username || process.env.NETINSIDE_USERNAME;
    this.password = options.password || process.env.NETINSIDE_PASSWORD;
    const tlsInsecureValue = options.tlsInsecure != null
      ? options.tlsInsecure
      : (process.env.NETINSIDE_TLS_INSECURE || '');
    this.tlsInsecure = String(tlsInsecureValue).toLowerCase() === 'true';
    this.timeoutMs = Number(options.timeoutMs || process.env.NAPM_SUMMARY_TIMEOUT_MS || 60000);
    this.requestHistory = [];
    this.client = axios.create({
      timeout: this.timeoutMs,
      httpsAgent: this.host && String(this.host).startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: !this.tlsInsecure })
        : undefined,
      headers: { Accept: 'application/json,text/plain,*/*' }
    });
  }

  assertRuntimeAuth() {
    if (!this.host) throw new Error('NETINSIDE_HOST is required.');
    if (!this.username) throw new Error('NETINSIDE_USERNAME is required.');
    if (!this.password) throw new Error('NETINSIDE_PASSWORD is required.');
  }

  buildAuthParams() {
    return { UserName: this.username, Password: this.password, json: 'true' };
  }

  _alignToMinute(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return n;
    return Math.floor(n / 60) * 60;
  }

  async request(type, extraParams = {}) {
    this.assertRuntimeAuth();
    // NAPM API requires start/end timestamps aligned to minute boundaries
    const aligned = { ...extraParams };
    if (aligned.start !== undefined) aligned.start = this._alignToMinute(aligned.start);
    if (aligned.end !== undefined) aligned.end = this._alignToMinute(aligned.end);
    const params = { ...this.buildAuthParams(), type, ...aligned };
    const url = buildNetInsideUrl(this.host, params);
    const startTime = Date.now();
    this.requestHistory.push({ type, url: maskUrl(url), startTime });

    let response;
    try {
      response = await this.client.get(url, { responseType: 'text', transformResponse: [(d) => d] });
    } catch (err) {
      if (err.response) {
        response = err.response;
      } else {
        throw err;
      }
    }

    const durationMs = Date.now() - startTime;
    const entry = this.requestHistory[this.requestHistory.length - 1];
    if (entry) {
      entry.durationMs = durationMs;
      entry.statusCode = response.status;
    }

    if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
      const error = new Error(`NAPM ${type} request failed with HTTP ${response?.status || 'unknown'}.`);
      error.code = 'NAPM_HTTP_STATUS_ERROR';
      error.statusCode = response?.status || null;
      throw error;
    }

    return parseMaybeJson(response.data || '');
  }

  // ── Alert APIs ────────────────────────────────────────────

  async getAlertsSummary(start, end) {
    return this.request('alertsSummary', { start, end });
  }

  async getAlertsTimeline(start, end) {
    return this.request('alertsSummaryTimeLine', { start, end });
  }

  async getAlertsDetail(eventIds, start, end) {
    const params = {};
    for (const id of eventIds) params['eventids'] = String(id);
    if (start) params.start = String(start);
    if (end) params.end = String(end);
    return this.request('alertsDetail', params);
  }

  // ── Metric APIs ────────────────────────────────────────────

  _buildGroupParams(groups = []) {
    const params = { numGroups: groups.length };
    groups.forEach((group, i) => {
      const n = i + 1;
      params[`groupType${n}`] = group.type;
      if (group.argument) params[`groupArgument${n}`] = group.argument;
    });
    return params;
  }

  async getTimeValues(start, end, metrics, groups, granularity) {
    const groupParams = this._buildGroupParams(groups);
    const params = {
      ...groupParams,
      metrics: Array.isArray(metrics) ? metrics.join(',') : metrics,
      start, end,
      granularity: granularity || this._autoGranularity(start, end)
    };
    return this.request('timeValues', params);
  }

  async getAverageValues(start, end, metrics, groups) {
    const groupParams = this._buildGroupParams(groups);
    const params = {
      ...groupParams,
      metrics: Array.isArray(metrics) ? metrics.join(',') : metrics,
      start, end
    };
    return this.request('averageValues', params);
  }

  async getTopValues(start, end, metrics, topMetric, topCount, groups) {
    // NAPM requires specific parameter order: numGroups/group* must come before metrics/start/end
    const groupParams = this._buildGroupParams(groups);
    const params = {
      ...groupParams,
      metrics: Array.isArray(metrics) ? metrics.join(',') : metrics,
      start, end,
      topMetric,
      topCount: topCount || 10
    };
    return this.request('topValues', params);
  }

  // ── Device API ─────────────────────────────────────────────

  async getApplianceInfo() {
    return this.request('applianceInfo', {});
  }

  // ── Helpers ────────────────────────────────────────────────

  _autoGranularity(start, end) {
    const rangeSec = Math.abs(Number(end || 0) - Number(start || 0));
    if (rangeSec <= 86400) return 60;       // ≤1 day → 1min
    if (rangeSec <= 604800) return 3600;     // ≤7 days → 1hour
    return 86400;                            // >7 days → 1day
  }
}

// ── Alert data aggregation helpers ──────────────────────────────

/**
 * Format a Unix timestamp (seconds) to "YYYY-MM-DD HH:mm:ss" in Asia/Shanghai.
 */
function formatTimestamp(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return String(seconds ?? '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(numeric * 1000)).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function aggregateAlertsSummary(rawSummary) {
  if (!rawSummary || typeof rawSummary !== 'object') return { total: 0, critical: 0, major: 0, minor: 0, byCategory: [], topObjects: [], unresolvedAlerts: [] };

  const allEvents = [];
  for (const [category, groups] of Object.entries(rawSummary)) {
    if (!groups || typeof groups !== 'object') continue;
    for (const [group, events] of Object.entries(groups)) {
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        allEvents.push({
          ...event,
          category,
          categoryLabel: ALERT_CATEGORY_LABELS[category] || category,
          group
        });
      }
    }
  }

  // Totals by severity
  const critical = allEvents.filter((e) => Number(e.severity) === 4).length;
  const major = allEvents.filter((e) => Number(e.severity) === 3).length;
  const minor = allEvents.filter((e) => Number(e.severity) === 2).length;

  // By category
  const byCategoryMap = {};
  for (const event of allEvents) {
    const cat = event.category;
    if (!byCategoryMap[cat]) {
      byCategoryMap[cat] = { category: cat, categoryLabel: ALERT_CATEGORY_LABELS[cat] || cat, count: 0, critical: 0, major: 0, minor: 0 };
    }
    byCategoryMap[cat].count++;
    const sev = Number(event.severity);
    if (sev === 4) byCategoryMap[cat].critical++;
    else if (sev === 3) byCategoryMap[cat].major++;
    else if (sev === 2) byCategoryMap[cat].minor++;
  }
  const byCategory = Object.values(byCategoryMap).sort((a, b) => b.count - a.count);

  // Top objects
  const groupCounts = {};
  for (const event of allEvents) {
    const key = `${event.category}:${event.group}`;
    if (!groupCounts[key]) {
      groupCounts[key] = { group: event.group, groupType: event.groupType || '', category: event.category, count: 0, critical: 0, major: 0, minor: 0 };
    }
    groupCounts[key].count++;
    const sev = Number(event.severity);
    if (sev === 4) groupCounts[key].critical++;
    else if (sev === 3) groupCounts[key].major++;
    else if (sev === 2) groupCounts[key].minor++;
  }
  const topObjects = Object.values(groupCounts)
    .sort((a, b) => b.count - a.count || b.critical - a.critical)
    .slice(0, 20);

  // Unresolved alerts (no end time or end > now)
  const unresolvedAlerts = allEvents
    .filter((e) => !e.end || Number(e.end) === 0)
    .map((e) => ({
      id: e.id,
      name: e.name || '',
      severity: Number(e.severity) || 0,
      severityLabel: SEVERITY_LABELS[Number(e.severity)] || String(e.severity),
      categoryLabel: ALERT_CATEGORY_LABELS[e.category] || e.category,
      group: e.group,
      start: Number(e.start) || 0
    }));

  return {
    total: allEvents.length,
    critical,
    major,
    minor,
    byCategory,
    topObjects,
    unresolvedAlerts
  };
}

function aggregateAlertsTimeline(rawTimeline) {
  if (!rawTimeline || typeof rawTimeline !== 'object') return [];

  // Collect all unique bucketStart timestamps across categories
  const buckets = {};
  for (const [category, timePoints] of Object.entries(rawTimeline)) {
    if (!timePoints || typeof timePoints !== 'object') continue;
    for (const [bucketStart, counts] of Object.entries(timePoints)) {
      const ts = Number(bucketStart);
      if (!buckets[ts]) buckets[ts] = {};
      // counts is [minor, critical, major] per current frontend reading
      const arr = Array.isArray(counts) ? counts : [];
      buckets[ts][`${category}_minor`] = Number(arr[0]) || 0;
      buckets[ts][`${category}_critical`] = Number(arr[1]) || 0;
      buckets[ts][`${category}_major`] = Number(arr[2]) || 0;
    }
  }

  // Sort by timestamp and compute cross-category totals
  return Object.entries(buckets)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([ts, catCounts]) => {
      let critical_total = 0, major_total = 0, minor_total = 0;
      for (const [key, val] of Object.entries(catCounts)) {
        if (key.endsWith('_critical')) critical_total += Number(val) || 0;
        else if (key.endsWith('_major')) major_total += Number(val) || 0;
        else if (key.endsWith('_minor')) minor_total += Number(val) || 0;
      }
      return {
        bucketStart: formatTimestamp(Number(ts)),
        critical_total,
        major_total,
        minor_total
      };
    });
}

module.exports = SummaryClient;
module.exports.__test__ = {
  normalizeHost,
  buildNetInsideUrl,
  maskUrl,
  aggregateAlertsSummary,
  aggregateAlertsTimeline,
  ALERT_CATEGORY_LABELS,
  SEVERITY_LABELS
};
