'use strict';

/**
 * Shared metadata helper — wraps NapmMetadataService from the query skill
 * and provides convenience methods for metric × dimension validation.
 *
 * All other NAPM skills can require this to discover:
 *   - which metrics are available for a given group type
 *   - the group tree (dimension hierarchy)
 *   - valid drill-down paths
 */
const path = require('path');

let _metadataService = null;
let _loadAttempted = false;

function getMetadataService() {
  if (_metadataService) return _metadataService;
  if (_loadAttempted) return null;
  _loadAttempted = true;

  const candidates = [
    path.resolve(__dirname, '..', '..', 'openclaw-napm-query', 'services', 'NapmMetadataService.js'),
    path.resolve(__dirname, '..', '..', '..', 'skills', 'openclaw-napm-query', 'services', 'NapmMetadataService.js')
  ];

  for (const candidate of candidates) {
    try {
      _metadataService = require(candidate);
      return _metadataService;
    } catch (_) {
      // try next
    }
  }
  return null;
}

class SummaryMetadataService {
  /**
   * Get all available metric IDs for a given group type.
   * Cached in-memory after first call.
   */
  async getAvailableMetrics(groupType) {
    const cache = this._metricCache || (this._metricCache = new Map());
    if (cache.has(groupType)) return cache.get(groupType);

    const svc = getMetadataService();
    if (!svc) return [];

    try {
      const raw = await svc.getMetricsForGroupPath([{ type: groupType }]);
      const ids = Array.isArray(raw) ? raw.map((m) => m.id || m).filter(Boolean) : [];
      cache.set(groupType, ids);
      return ids;
    } catch (_) {
      return [];
    }
  }

  /**
   * Check whether a list of metrics is available for a group type.
   * Returns { available: [...], missing: [...] }.
   */
  async checkMetrics(groupType, metricIds = []) {
    const available = await this.getAvailableMetrics(groupType);
    const availableSet = new Set(available.map(String));
    const result = { available: [], missing: [] };
    for (const m of metricIds) {
      (availableSet.has(String(m)) ? result.available : result.missing).push(m);
    }
    return result;
  }

  /**
   * Validate a query plan and return warnings for any metric-group mismatches.
   * Each plan item can optionally declare { groupType, metrics } for validation.
   */
  async validatePlan(plan = []) {
    const warnings = [];
    for (const item of plan) {
      if (!item.groupType || !item.metrics) continue;
      const check = await this.checkMetrics(item.groupType, item.metrics);
      if (check.missing.length > 0) {
        warnings.push({
          label: item.label,
          groupType: item.groupType,
          missingMetrics: check.missing,
          hint: `${item.groupType} 不支持指标: ${check.missing.join(', ')}，可用: ${check.available.slice(0, 10).join(', ')}`
        });
      }
    }
    return warnings;
  }
}

module.exports = new SummaryMetadataService();
