'use strict';

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
  return toNumber(row.timestamp ?? row.time ?? row.start ?? row.startTime ?? row.Time ?? row.X);
}

function normalizeTimeSeriesDataset(raw = {}, options = {}) {
  const timezone = options.timezone || 'Asia/Shanghai';
  const metrics = (options.metrics || ['TPIO', 'TPI', 'TPO']).map((item) => String(item).toUpperCase());
  const rows = extractRows(raw);
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
      granularity: options.granularity,
      spikeRatio: options.spikeRatio
    })
  };
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

class InspectionTrafficAnalysisService {
  constructor(options = {}) {
    this.client = options.client || null;
    this.timezone = options.timezone || 'Asia/Shanghai';
    this.nowSeconds = options.nowSeconds || null;
    this.thresholds = options.thresholds || {};
  }

  getNowSeconds() {
    return alignToMinute(this.nowSeconds || Math.floor(Date.now() / 1000));
  }

  async queryWindow({ id, title, durationSeconds, granularity }) {
    if (!this.client || typeof this.client.getTimeValues !== 'function') {
      return null;
    }
    const end = this.getNowSeconds();
    const start = end - durationSeconds;
    const params = {
      start,
      end,
      metrics: 'TPIO,TPI,TPO',
      granularity,
      numGroups: 1,
      groupType1: 'TotalTraffic'
    };
    const result = await this.client.getTimeValues(params);
    const dataset = normalizeTimeSeriesDataset(result.data, {
      timezone: this.timezone,
      granularity,
      metrics: ['TPIO', 'TPI', 'TPO'],
      primaryMetric: 'TPIO',
      spikeRatio: this.thresholds.trafficSpikeRatio
    });
    return {
      id,
      title,
      queryEvidence: {
        service: 'timeValues',
        groups: [{ type: 'TotalTraffic' }],
        metrics: ['TPIO', 'TPI', 'TPO'],
        granularity,
        start,
        end,
        requestUrlRedacted: result.requestUrlRedacted || ''
      },
      dataset
    };
  }

  buildFromWindows(windows = {}) {
    const recentHour = windows.recentHour || null;
    const recentDay = windows.recentDay || null;
    const findings = [];
    if (recentHour) {
      findings.push(buildFindingForDataset('最近1小时', 'trafficAnalysis.recentHour.dataset.stats', recentHour.dataset));
    }
    if (recentDay) {
      findings.push(buildFindingForDataset('最近1天', 'trafficAnalysis.recentDay.dataset.stats', recentDay.dataset));
    }
    const warning = findings.some((item) => item.level === 'warning');
    const unknown = findings.length === 0 || findings.some((item) => item.level === 'unknown');
    return {
      status: warning ? 'warning' : (unknown ? 'unknown' : 'ok'),
      recentHour,
      recentDay,
      findings
    };
  }

  async collect() {
    const recentHour = await this.queryWindow({
      id: 'traffic-last-hour',
      title: '最近1小时流量分布状况',
      durationSeconds: 3600,
      granularity: 60
    });
    const recentDay = await this.queryWindow({
      id: 'traffic-last-day',
      title: '最近1天流量分布状况',
      durationSeconds: 86400,
      granularity: 3600
    });
    return this.buildFromWindows({ recentHour, recentDay });
  }
}

module.exports = InspectionTrafficAnalysisService;
module.exports.__test__ = {
  normalizeTimeSeriesDataset,
  computeStats,
  buildFindingForDataset,
  extractRows,
  readMetric
};
