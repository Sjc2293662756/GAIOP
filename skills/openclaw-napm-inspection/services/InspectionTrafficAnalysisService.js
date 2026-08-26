'use strict';

const SUPPORTED_GRANULARITIES = Object.freeze([60, 300, 3600, 86400]);
const DEFAULT_MAX_POINTS = 120;
const WEEK_SECONDS = 7 * 86400;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveNumber(value) {
  const numeric = toNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function normalizeGranularity(value) {
  const numeric = Number(value);
  return SUPPORTED_GRANULARITIES.includes(numeric) ? numeric : null;
}

function selectGranularity(durationSeconds, maxPoints = DEFAULT_MAX_POINTS) {
  const duration = Number(durationSeconds);
  const pointBudget = Number(maxPoints);
  if (!Number.isFinite(duration) || duration <= 0) return SUPPORTED_GRANULARITIES[0];
  const budget = Number.isFinite(pointBudget) && pointBudget > 0 ? pointBudget : DEFAULT_MAX_POINTS;
  const requiredStep = Math.max(1, Math.ceil(duration / budget));
  return SUPPORTED_GRANULARITIES.find((step) => step >= requiredStep)
    || SUPPORTED_GRANULARITIES[SUPPORTED_GRANULARITIES.length - 1];
}

function alignToMinute(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric / 60) * 60;
}

function formatTimestamp(seconds, timezone = 'Asia/Shanghai') {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
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

function getLocalDateParts(seconds, timezone = 'Asia/Shanghai') {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(numeric * 1000)).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});
}

function localWeekStartSeconds(seconds, timezone = 'Asia/Shanghai') {
  const parts = getLocalDateParts(seconds, timezone);
  if (!parts || !Number.isFinite(parts.year) || !Number.isFinite(parts.month) || !Number.isFinite(parts.day)) {
    return null;
  }
  const dateUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const dayOfWeek = new Date(dateUtc).getUTCDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;
  const mondayUtc = dateUtc - daysFromMonday * 86400000;
  // Production reports use Asia/Shanghai (UTC+08:00), which has no DST.
  // For other zones, UTC midnight remains a deterministic fallback label.
  const offsetSeconds = timezone === 'Asia/Shanghai' ? 8 * 3600 : 0;
  return Math.floor(mondayUtc / 1000) - offsetSeconds;
}

function extractRows(raw = {}) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.rows)) return raw.rows;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.result)) return raw.result;
  if (Array.isArray(raw?.points)) return raw.points;
  return [];
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

function readTimestamp(row = {}) {
  if (Object.prototype.hasOwnProperty.call(row, 'timestamp')) {
    return toNumber(row.timestamp);
  }
  return toNumber(row.timestamp ?? row.time ?? row.start ?? row.startTime ?? row.Time ?? row.X);
}

function normalizeTimeSeriesDataset(raw = {}, options = {}) {
  const timezone = options.timezone || 'Asia/Shanghai';
  const metrics = (options.metrics || ['TPIO', 'TPI', 'TPO']).map((item) => String(item).toUpperCase());
  const requestedGranularity = normalizeGranularity(
    options.requestedGranularity ?? options.granularity
  ) || selectGranularity(options.durationSeconds, options.maxPoints);
  const responseGranularityValue = toNumber(raw?.granularity);
  const actualGranularity = normalizeGranularity(responseGranularityValue) || requestedGranularity;
  const intervalStart = toPositiveNumber(raw?.interval?.start) ?? toPositiveNumber(options.interval?.start);
  const intervalEnd = toPositiveNumber(raw?.interval?.end) ?? toPositiveNumber(options.interval?.end);

  // Handle column-based metricValues format from NAPM API
  let rows = extractRows(raw);
  if (rows.length === 0 && Array.isArray(raw?.metricValues)) {
    // Transpose column-based data to row-based
    // Input:  { metricValues: [{ metric:{id:"TPIO"}, values:[v1,v2,...] }, ...] }
    // Output: [{ TPIO: v1, TPI: v1, TPO: v1 }, { TPIO: v2, ... }, ...]
    const startTime = intervalStart !== null ? Math.floor(startTimeToMinute(intervalStart)) : null;

    const valueArrays = raw.metricValues.map((mv) => ({
      id: String((mv.metric?.id || mv.metric || '').toUpperCase()),
      values: Array.isArray(mv.values) ? mv.values : [],
      valids: Array.isArray(mv.valids) ? mv.valids : []
    })).filter((col) => col.id && col.values.length > 0);

    if (valueArrays.length > 0) {
      const rowCount = Math.max(...valueArrays.map((col) => col.values.length));
      rows = [];
      for (let i = 0; i < rowCount; i++) {
        const point = {
          index: i + 1,
          timestamp: startTime === null ? null : startTime + i * actualGranularity,
          time: startTime === null ? String(i + 1) : formatTimestamp(startTime + i * actualGranularity, timezone)
        };
        for (const col of valueArrays) {
          point[col.id] = col.values[i];
        }
        // Only include if at least one metric has a valid value
        const hasValid = valueArrays.some((col) => {
          const v = col.values[i];
          return v !== undefined && v !== null && (col.valids.length === 0 || col.valids[i] === true);
        });
        if (hasValid) rows.push(point);
      }
    }
  }

  const points = rows.map((row, index) => {
    const timestamp = readTimestamp(row);
    const point = {
      index: index + 1,
      timestamp,
      time: timestamp ? formatTimestamp(timestamp, timezone) : String(row.timeText || row.label || row.name || index + 1)
    };
    for (const metric of metrics) {
      const value = readMetric(row, metric);
      if (value !== null) point[metric] = value;
    }
    return point;
  }).filter((point) => metrics.some((metric) => Number.isFinite(point[metric])));
  return {
    unit: options.unit || 'Kbps',
    metrics,
    points,
    stats: computeStats(points, {
      metric: options.primaryMetric || metrics[0],
      granularity: actualGranularity,
      spikeRatio: options.spikeRatio
    }),
    interval: { start: intervalStart, end: intervalEnd },
    timezone,
    requestedGranularity,
    actualGranularity,
    responseGranularity: responseGranularityValue,
    granularitySource: normalizeGranularity(responseGranularityValue) ? 'response' : 'request_fallback',
    granularityMismatch: normalizeGranularity(responseGranularityValue) !== null
      && responseGranularityValue !== requestedGranularity
  };
}

function aggregateDatasetByLocalWeek(dataset = {}, options = {}) {
  const points = Array.isArray(dataset.points) ? dataset.points : [];
  const metrics = Array.isArray(dataset.metrics) ? dataset.metrics : ['TPIO', 'TPI', 'TPO'];
  const timezone = options.timezone || dataset.timezone || 'Asia/Shanghai';
  const buckets = new Map();

  for (const point of points) {
    const timestamp = toNumber(point?.timestamp);
    const bucketStart = timestamp === null ? null : localWeekStartSeconds(timestamp, timezone);
    if (bucketStart === null) continue;
    const bucketKey = String(bucketStart);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        timestamp: bucketStart,
        values: Object.fromEntries(metrics.map((metric) => [metric, []]))
      });
    }
    const bucket = buckets.get(bucketKey);
    for (const metric of metrics) {
      const value = toNumber(point?.[metric]);
      if (value !== null) bucket.values[metric].push(value);
    }
  }

  if (buckets.size === 0) {
    return {
      ...dataset,
      effectiveGranularity: dataset.actualGranularity,
      aggregation: {
        method: 'calendar_week_average',
        sourceGranularity: dataset.actualGranularity,
        effectiveGranularity: dataset.actualGranularity,
        timezone,
        status: 'skipped_missing_timestamps'
      }
    };
  }

  const aggregatedPoints = Array.from(buckets.values())
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((bucket, index) => {
      const point = {
        index: index + 1,
        timestamp: bucket.timestamp,
        time: formatTimestamp(bucket.timestamp, timezone)
      };
      for (const metric of metrics) {
        const values = bucket.values[metric];
        if (values.length > 0) {
          point[metric] = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
        }
      }
      return point;
    });
  const sourceStats = dataset.stats || {};
  const stats = computeStats(aggregatedPoints, {
    metric: metrics[0],
    granularity: WEEK_SECONDS,
    spikeRatio: options.spikeRatio
  });
  // Preserve anomalies detected at the source resolution. Weekly averaging
  // must not hide a daily gap, zero segment, or spike from the report.
  stats.missingPointCount = Number(sourceStats.missingPointCount) || 0;
  stats.zeroSegmentCount = Number(sourceStats.zeroSegmentCount) || 0;
  stats.spikeCount = Number(sourceStats.spikeCount) || 0;
  return {
    ...dataset,
    points: aggregatedPoints,
    stats,
    effectiveGranularity: WEEK_SECONDS,
    aggregation: {
      method: 'calendar_week_average',
      sourceGranularity: dataset.actualGranularity,
      effectiveGranularity: WEEK_SECONDS,
      timezone,
      status: 'applied'
    }
  };
}

function startTimeToMinute(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric / 60) * 60 : null;
}

function computeStats(points = [], options = {}) {
  const metric = options.metric || 'TPIO';
  const values = points
    .map((point) => toNumber(point[metric]))
    .filter((value) => value !== null);
  if (values.length === 0) {
    return {
      max: null,
      min: null,
      avg: null,
      missingPointCount: 0,
      zeroSegmentCount: 0,
      spikeCount: 0
    };
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const zeroSegmentCount = values.filter((value) => value === 0).length;
  const spikeRatio = Number(options.spikeRatio || 3);
  const spikeCount = avg > 0
    ? values.filter((value) => value > avg * spikeRatio).length
    : 0;
  const granularity = Number(options.granularity);
  let missingPointCount = 0;
  if (Number.isFinite(granularity) && granularity > 0) {
    const timestamps = points
      .map((point) => toNumber(point.timestamp))
      .filter((value) => value !== null)
      .sort((left, right) => left - right);
    for (let index = 1; index < timestamps.length; index += 1) {
      const gap = timestamps[index] - timestamps[index - 1];
      if (gap > granularity * 1.5) {
        missingPointCount += Math.max(1, Math.round(gap / granularity) - 1);
      }
    }
  }
  return {
    max: Number(max.toFixed(4)),
    min: Number(min.toFixed(4)),
    avg: Number(avg.toFixed(4)),
    missingPointCount,
    zeroSegmentCount,
    spikeCount
  };
}

function buildFindingForDataset(label, ref, dataset = {}) {
  const stats = dataset.stats || {};
  if (!Array.isArray(dataset.points) || dataset.points.length === 0) {
    return {
      level: 'unknown',
      text: `${label}未获取到流量趋势数据。`,
      evidenceRefs: [ref]
    };
  }
  const problems = [];
  if (Number(stats.missingPointCount) > 0) problems.push(`存在${stats.missingPointCount}个疑似缺点`);
  if (Number(stats.zeroSegmentCount) > 0) problems.push(`存在${stats.zeroSegmentCount}个零流量点`);
  if (Number(stats.spikeCount) > 0) problems.push(`存在${stats.spikeCount}个疑似尖峰`);
  return problems.length > 0
    ? {
        level: 'warning',
        text: `${label}${problems.join('，')}。`,
        evidenceRefs: [ref]
      }
    : {
        level: 'ok',
        text: `${label}流量曲线连续，未发现明显中断或异常尖峰。`,
        evidenceRefs: [ref]
      };
}

function normalizeWindowInput(window = {}, defaults = {}) {
  const start = toPositiveNumber(window.start);
  const end = toPositiveNumber(window.end);
  const durationSeconds = toPositiveNumber(window.durationSeconds)
    || (start !== null && end !== null ? end - start : toPositiveNumber(defaults.durationSeconds));
  const key = String(window.key || defaults.key || '').trim();
  const displayText = String(window.displayText || defaults.displayText || key || '').trim();
  return {
    id: String(window.id || defaults.id || key || 'traffic-window').trim(),
    key,
    mode: String(window.mode || defaults.mode || 'rolling').trim(),
    start,
    end,
    durationSeconds,
    displayText,
    title: String(window.title || defaults.title || `${displayText}流量分布状况`).trim(),
    narrativeLabel: String(window.narrativeLabel || defaults.narrativeLabel || `${displayText}总流量趋势`).trim(),
    timezone: window.timezone || defaults.timezone || 'Asia/Shanghai'
  };
}

class InspectionTrafficAnalysisService {
  constructor(options = {}) {
    this.client = options.client || null;
    this.timezone = options.timezone || 'Asia/Shanghai';
    this.nowSeconds = options.nowSeconds || null;
    this.thresholds = options.thresholds || {};
    this.maxPoints = Number.isFinite(Number(options.maxPoints)) && Number(options.maxPoints) > 0
      ? Number(options.maxPoints)
      : DEFAULT_MAX_POINTS;
  }

  getNowSeconds() {
    return alignToMinute(this.nowSeconds || Math.floor(Date.now() / 1000));
  }

  async queryWindow({ id, title, durationSeconds, granularity, start, end, key, mode, displayText, narrativeLabel }) {
    if (!this.client || typeof this.client.getTimeValues !== 'function') {
      return null;
    }
    const resolvedEnd = alignToMinute(end) || this.getNowSeconds();
    const resolvedDuration = toPositiveNumber(durationSeconds) || 3600;
    const resolvedStart = alignToMinute(start) || (resolvedEnd - resolvedDuration);
    const requestedGranularity = normalizeGranularity(granularity)
      || selectGranularity(resolvedDuration, this.maxPoints);
    const params = {
      start: resolvedStart,
      end: resolvedEnd,
      metrics: 'TPIO,TPI,TPO',
      granularity: requestedGranularity,
      numGroups: 1,
      groupType1: 'TotalTraffic'
    };
    const result = await this.client.getTimeValues(params);
    const normalizedDataset = normalizeTimeSeriesDataset(result?.data || {}, {
      timezone: this.timezone,
      durationSeconds: resolvedDuration,
      maxPoints: this.maxPoints,
      requestedGranularity,
      interval: { start: resolvedStart, end: resolvedEnd },
      metrics: ['TPIO', 'TPI', 'TPO'],
      primaryMetric: 'TPIO',
      spikeRatio: this.thresholds.trafficSpikeRatio
    });
    const sourceStep = normalizedDataset.actualGranularity || requestedGranularity;
    const needsWeeklyAggregation = resolvedDuration > this.maxPoints * sourceStep
      && sourceStep <= 86400;
    const dataset = needsWeeklyAggregation
      ? aggregateDatasetByLocalWeek(normalizedDataset, {
          timezone: this.timezone,
          spikeRatio: this.thresholds.trafficSpikeRatio
        })
      : {
          ...normalizedDataset,
          effectiveGranularity: normalizedDataset.actualGranularity,
          aggregation: null
        };
    return {
      id,
      title,
      key,
      mode,
      displayText,
      narrativeLabel,
      start: resolvedStart,
      end: resolvedEnd,
      durationSeconds: resolvedDuration,
      queryEvidence: {
        service: 'timeValues',
        groups: [{ type: 'TotalTraffic' }],
        metrics: ['TPIO', 'TPI', 'TPO'],
        granularity: requestedGranularity,
        requestedGranularity,
        actualGranularity: dataset.actualGranularity,
        effectiveGranularity: dataset.effectiveGranularity,
        granularitySource: dataset.granularitySource,
        granularityMismatch: dataset.granularityMismatch,
        aggregation: dataset.aggregation,
        start: resolvedStart,
        end: resolvedEnd,
        windowKey: key || null,
        windowMode: mode || null,
        displayText: displayText || title || '',
        effectiveStart: dataset.interval?.start,
        effectiveEnd: dataset.interval?.end,
        requestUrlRedacted: result?.requestUrlRedacted || ''
      },
      dataset
    };
  }

  buildFromWindows(windows = {}) {
    // Legacy callers only provide recentHour/recentDay. Treat recentHour as
    // the primary window so their findings and status remain meaningful.
    const primary = windows.primary || windows.recentHour || null;
    const contextWindows = Array.isArray(windows.contextWindows)
      ? windows.contextWindows.filter(Boolean)
      : [];
    const contextDay = windows.contextDay
      || windows.recentDay
      || contextWindows.find((item) => item.key === 'last1day' || item.id === 'recent-day')
      || null;
    const contextHour = windows.contextHour
      || contextWindows.find((item) => item.key === 'last1hour' || item.id === 'recent-hour')
      || null;
    const recentHour = windows.recentHour || (primary?.durationSeconds === 3600 ? primary : contextHour);
    const recentDay = windows.recentDay || (primary?.durationSeconds === 86400 ? primary : contextDay);
    const findingEntries = [];
    if (primary) findingEntries.push([windows.primary ? 'primary' : 'recentHour', primary]);
    if (contextDay && contextDay !== primary) {
      findingEntries.push([windows.contextDay || windows.contextWindows ? 'contextDay' : 'recentDay', contextDay]);
    }
    if (contextHour && contextHour !== primary && contextHour !== contextDay) findingEntries.push(['contextHour', contextHour]);
    const findings = findingEntries.map(([path, window]) => buildFindingForDataset(
      window.narrativeLabel || window.title || window.displayText || window.key,
      `trafficAnalysis.${path}.dataset.stats`,
      window.dataset
    ));
    const warning = findings.some((item) => item.level === 'warning');
    const unknown = findings.length === 0 || findings.some((item) => item.level === 'unknown');
    return {
      status: warning ? 'warning' : (unknown ? 'unknown' : 'ok'),
      reportWindow: windows.reportWindow || null,
      primary,
      contextWindows,
      contextDay,
      contextHour,
      recentHour,
      recentDay,
      findings
    };
  }

  async collect(windowContract = {}) {
    const primary = normalizeWindowInput(windowContract.primaryWindow || {}, {
      id: 'traffic-last-hour',
      key: 'last1hour',
      displayText: '最近1小时',
      durationSeconds: 3600,
      timezone: this.timezone
    });
    if (!windowContract.primaryWindow?.title) {
      primary.title = `${primary.displayText}流量分布趋势`;
    }
    const contextWindows = (Array.isArray(windowContract.contextWindows) && windowContract.contextWindows.length > 0
      ? windowContract.contextWindows
      : [{
          id: 'recent-day',
          key: 'last1day',
          displayText: '最近1天',
          durationSeconds: 86400,
          timezone: this.timezone
        }])
      .map((window) => normalizeWindowInput(window, {
        timezone: this.timezone,
        title: `报告截止时${window.displayText || window.key || ''}流量分布状况`,
        narrativeLabel: `${window.displayText || window.key || ''}总流量趋势`
      }));
    const primaryResult = await this.queryWindow(primary);
    const contextResults = await Promise.all(contextWindows.map((window) => this.queryWindow(window)));
    const results = {
      primary: primaryResult,
      contextWindows: contextResults,
      contextDay: contextResults.find((item) => item?.key === 'last1day' || item?.id === 'recent-day') || null,
      contextHour: contextResults.find((item) => item?.key === 'last1hour' || item?.id === 'recent-hour') || null,
      reportWindow: windowContract.reportWindow || null
    };
    return this.buildFromWindows(results);
  }
}

module.exports = InspectionTrafficAnalysisService;
module.exports.__test__ = {
  SUPPORTED_GRANULARITIES,
  WEEK_SECONDS,
  DEFAULT_MAX_POINTS,
  normalizeGranularity,
  selectGranularity,
  normalizeTimeSeriesDataset,
  aggregateDatasetByLocalWeek,
  computeStats,
  buildFindingForDataset,
  normalizeWindowInput,
  extractRows,
  readMetric
};
