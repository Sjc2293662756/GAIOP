'use strict';

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function alignToMinute(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric / 60) * 60;
}

function extractRows(raw = {}) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.rows)) return raw.rows;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.result)) return raw.result;
  return [];
}

function readObjectName(row = {}) {
  return String(
    row.object
    || row.group
    || row.name
    || row.label
    || row.BusinessName
    || row.WebApplication
    || row.argument
    || ''
  ).trim();
}

function readMetric(row = {}, metric = '') {
  if (row[metric] !== undefined) return toNumber(row[metric]);
  if (row.metrics?.[metric] !== undefined) {
    const value = row.metrics[metric];
    if (value && typeof value === 'object') return toNumber(value.value);
    return toNumber(value);
  }
  if (Array.isArray(row.metricValues)) {
    const match = row.metricValues.find((item) => {
      const id = item?.metric?.id || item?.metric || item?.id || item?.name;
      return String(id || '').toUpperCase() === metric;
    });
    if (match) return toNumber(match.value ?? match.Value);
  }
  return null;
}

function normalizeTopRows(raw = {}, metrics = []) {
  return extractRows(raw).map((row, index) => {
    const normalized = {
      rank: Number(row.rank || row.Rank || index + 1),
      businessName: readObjectName(row),
      raw: row
    };
    for (const metric of metrics) {
      const value = readMetric(row, metric);
      if (value !== null) normalized[metric] = value;
    }
    return normalized;
  }).filter((row) => row.businessName);
}

function formatPercent(value) {
  const numeric = toNumber(value);
  if (numeric === null) return '';
  return `${Number(numeric.toFixed(3))}%`;
}

function mergeErrorRows(http400Rows = [], http500Rows = []) {
  const byName = new Map();
  const ensure = (businessName) => {
    if (!byName.has(businessName)) {
      byName.set(businessName, {
        businessName,
        http400: 0,
        http500: 0,
        evidenceRefs: []
      });
    }
    return byName.get(businessName);
  };
  http400Rows.forEach((row, index) => {
    const target = ensure(row.businessName);
    target.http400 = row.PGHTTP400 || 0;
    target.evidenceRefs.push(`business-http400-top.rows[${index}]`);
  });
  http500Rows.forEach((row, index) => {
    const target = ensure(row.businessName);
    target.http500 = row.PGHTTP500 || 0;
    target.evidenceRefs.push(`business-http500-top.rows[${index}]`);
  });
  return Array.from(byName.values())
    .filter((row) => row.http400 > 0 || row.http500 > 0)
    .sort((left, right) => (right.http500 + right.http400) - (left.http500 + left.http400));
}

class InspectionBusinessPerformanceService {
  constructor(options = {}) {
    this.client = options.client || null;
    this.nowSeconds = options.nowSeconds || null;
    this.topCount = Number(options.topCount || 20);
    this.thresholds = {
      businessSlowRatioWarningGreaterThan: 0,
      businessSlowCountWarningGreaterThan: 0,
      businessHttp400WarningGreaterThan: 0,
      businessHttp500WarningGreaterThan: 0,
      ...(options.thresholds || {})
    };
  }

  getTimeRange() {
    const end = alignToMinute(this.nowSeconds || Math.floor(Date.now() / 1000));
    return {
      start: end - 7 * 86400,
      end
    };
  }

  async queryTop(id, params) {
    if (!this.client || typeof this.client.getTopValues !== 'function') {
      return null;
    }
    const range = this.getTimeRange();
    const result = await this.client.getTopValues({
      start: range.start,
      end: range.end,
      topCount: this.topCount,
      numGroups: 1,
      groupType1: 'WebApplication',
      ...params
    });
    return {
      id,
      range,
      raw: result.data,
      requestUrlRedacted: result.requestUrlRedacted || ''
    };
  }

  async collect() {
    const slow = await this.queryTop('business-slow-access-top', {
      metrics: 'PGSLPCT,PGNSLPGE,PGTME',
      topMetric: 'PGSLPCT'
    });
    const http400 = await this.queryTop('business-http400-top', {
      metrics: 'PGHTTP400',
      topMetric: 'PGHTTP400'
    });
    const http500 = await this.queryTop('business-http500-top', {
      metrics: 'PGHTTP500',
      topMetric: 'PGHTTP500'
    });
    return this.buildFromQueryResults({ slow, http400, http500 });
  }

  buildEvidence(record, metrics = [], topMetric = '') {
    if (!record) return null;
    return {
      id: record.id,
      service: 'topValues',
      groups: [{ type: 'WebApplication' }],
      metrics,
      topMetric,
      topCount: this.topCount,
      start: record.range?.start,
      end: record.range?.end,
      requestUrlRedacted: record.requestUrlRedacted || ''
    };
  }

  buildFromQueryResults(results = {}) {
    const slowRows = normalizeTopRows(results.slow?.raw, ['PGSLPCT', 'PGNSLPGE', 'PGTME']);
    const http400Rows = normalizeTopRows(results.http400?.raw, ['PGHTTP400']);
    const http500Rows = normalizeTopRows(results.http500?.raw, ['PGHTTP500']);
    const slowAccess = slowRows
      .filter((row) => (
        (row.PGSLPCT || 0) > Number(this.thresholds.businessSlowRatioWarningGreaterThan)
        || (row.PGNSLPGE || 0) > Number(this.thresholds.businessSlowCountWarningGreaterThan)
      ))
      .map((row, index) => ({
        businessName: row.businessName,
        ratio: formatPercent(row.PGSLPCT || 0),
        slowCount: row.PGNSLPGE || 0,
        avgPageDelayMs: row.PGTME || 0,
        evidenceRef: `business-slow-access-top.rows[${index}]`
      }));
    const httpErrors = mergeErrorRows(
      http400Rows.filter((row) => (row.PGHTTP400 || 0) > Number(this.thresholds.businessHttp400WarningGreaterThan)),
      http500Rows.filter((row) => (row.PGHTTP500 || 0) > Number(this.thresholds.businessHttp500WarningGreaterThan))
    );
    const findings = [];
    if (slowAccess.length > 0) {
      findings.push({
        level: 'warning',
        text: `${slowAccess[0].businessName}出现${slowAccess[0].ratio}慢访问。`,
        evidenceRefs: [slowAccess[0].evidenceRef]
      });
    }
    if (httpErrors.length > 0) {
      findings.push({
        level: 'warning',
        text: '多个业务存在 HTTP 400/500 报错。',
        evidenceRefs: ['business-http400-top.rows', 'business-http500-top.rows']
      });
    }
    const hasAnyQueryRows = slowRows.length > 0 || http400Rows.length > 0 || http500Rows.length > 0;
    return {
      status: findings.length > 0 ? 'warning' : (hasAnyQueryRows ? 'ok' : 'unknown'),
      queryEvidence: [
        this.buildEvidence(results.slow, ['PGSLPCT', 'PGNSLPGE', 'PGTME'], 'PGSLPCT'),
        this.buildEvidence(results.http400, ['PGHTTP400'], 'PGHTTP400'),
        this.buildEvidence(results.http500, ['PGHTTP500'], 'PGHTTP500')
      ].filter(Boolean),
      rows: {
        slow: slowRows,
        http400: http400Rows,
        http500: http500Rows
      },
      slowAccess,
      httpErrors,
      findings: findings.length > 0
        ? findings
        : (hasAnyQueryRows
          ? [{ level: 'ok', text: '最近7日业务慢访问和 HTTP 400/500 报错未发现明显异常。', evidenceRefs: ['businessPerformance.rows'] }]
          : [{ level: 'unknown', text: '未获取到业务性能数据。', evidenceRefs: ['businessPerformance.queryEvidence'] }]),
      recommendations: findings.length > 0
        ? [{ text: '建议进一步定位慢访问和 HTTP 报错原因。', basedOn: ['businessPerformance.findings'] }]
        : []
    };
  }
}

module.exports = InspectionBusinessPerformanceService;
module.exports.__test__ = {
  normalizeTopRows,
  mergeErrorRows,
  readMetric,
  readObjectName,
  formatPercent
};
