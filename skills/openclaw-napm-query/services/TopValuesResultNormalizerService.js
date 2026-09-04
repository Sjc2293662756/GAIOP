'use strict';

function toFiniteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractMetricValue(row = {}, metricId = '') {
  const normalizedMetricId = String(metricId || '').trim();
  const metricValues = Array.isArray(row?.metricValues) ? row.metricValues : [];
  const metricRecord = metricValues.find((item) => (
    String(item?.metric?.id || item?.metric?.Id || '').trim() === normalizedMetricId
  )) || metricValues[0] || null;
  const metricValue = toFiniteNumber(metricRecord?.value ?? metricRecord?.Value);
  if (metricValue !== null) return metricValue;

  if (
    normalizedMetricId
    && row?.values
    && typeof row.values === 'object'
    && Object.prototype.hasOwnProperty.call(row.values, normalizedMetricId)
  ) {
    const value = toFiniteNumber(row.values[normalizedMetricId]);
    if (value !== null) return value;
  }
  if (normalizedMetricId && Object.prototype.hasOwnProperty.call(row, normalizedMetricId)) {
    const value = toFiniteNumber(row[normalizedMetricId]);
    if (value !== null) return value;
  }
  return toFiniteNumber(row?.rawValue ?? row?.value);
}

function normalizeDirection(query = {}) {
  const direction = String(
    query?.semanticConstraints?.direction
    || query?.direction
    || ''
  ).trim().toLowerCase();
  return direction === 'asc' ? 'asc' : 'desc';
}

function normalizeTopValuesRows(rows = [], query = {}) {
  if (!Array.isArray(rows)) return [];
  const metricId = String(
    query?.topMetric
    || query?.metric
    || query?.metrics?.[0]
    || ''
  ).trim();
  const direction = normalizeDirection(query);

  return rows
    .map((row, index) => ({ row, index, value: extractMetricValue(row, metricId) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      const difference = direction === 'asc'
        ? left.value - right.value
        : right.value - left.value;
      return difference || left.index - right.index;
    })
    .map((item, index) => ({
      ...item.row,
      rank: index + 1
    }));
}

module.exports = {
  extractMetricValue,
  normalizeTopValuesRows
};
