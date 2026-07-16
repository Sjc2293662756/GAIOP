'use strict';

/**
 * NAPM Unified Time Resolver
 *
 * Extracted from napm-openclaw-plugin.remote.js (line 2618-2648).
 * Centralizes time override logic so it can be applied from a single
 * location (before_tool_call Hook) to all 7 NAPM Tools.
 *
 * Strategy (2026-06-29): "时间描述替代时间戳" — LLM only passes
 * timeRange.key, this module unconditionally computes start/end
 * using Date.now().
 */

const DURATION_MAP = {
  last5minutes: 300,
  last1hour: 3600,
  last24hours: 86400,
  last1day: 86400,
  last7days: 604800,
  last30days: 2592000,
};

/**
 * Servers that require executable start/end timestamps.
 * Other servers (metricInventory, objectInventory, groups, etc.)
 * do not need time and should NOT be modified.
 */
const NEEDS_TIME = new Set([
  'topValues',
  'averageValues',
  'timeValues',
  'overview',
  'topValues_multi_protocol',
]);

/**
 * Floor a Unix timestamp (in seconds) to the nearest minute boundary.
 * @param {number} v
 * @returns {number}
 */
function floorToMinute(v) {
  return Math.floor(v / 60) * 60;
}

/**
 * Resolve a timeRange key into concrete start/end timestamps.
 * Mirrors the inline logic from Plugin line 2628-2641 exactly.
 *
 * @param {string} timeKey - e.g. 'today', 'yesterday', 'last1hour', 'last7days'
 * @param {number} nowSeconds - current Unix time in seconds (from Date.now())
 * @returns {{ start: number, end: number, key: string }}
 */
function resolveTimeFromKey(timeKey, nowSeconds) {
  const now = Number.isFinite(nowSeconds) && nowSeconds > 0
    ? nowSeconds
    : Math.floor(Date.now() / 1000);

  if (timeKey === 'today') {
    const d = new Date(now * 1000);
    d.setHours(0, 0, 0, 0);
    const start = floorToMinute(d.getTime() / 1000);
    return { start, end: floorToMinute(now), key: 'today' };
  }

  if (timeKey === 'yesterday') {
    const d = new Date(now * 1000);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    const start = floorToMinute(d.getTime() / 1000);
    return { start, end: floorToMinute(start + 86340), key: 'yesterday' };
  }

  const duration = DURATION_MAP[timeKey] || 3600; // default: 1 hour
  const start = floorToMinute(now - duration);
  const end = floorToMinute(now);
  return { start, end, key: timeKey || 'last1hour' };
}

/**
 * Apply unified time override to a resolvedQuery object.
 * Unconditionally overwrites start/end based on timeRange.key
 * using Date.now(). Only applies to servers that need timestamps.
 *
 * @param {object} resolvedQuery - The resolvedQuery from tool args (mutated in place)
 * @param {number} [overrideNowMs] - Optional test override for Date.now() (in milliseconds)
 * @returns {object} The resolvedQuery (same object, mutated)
 */
function applyTimeOverride(resolvedQuery, overrideNowMs) {
  if (!resolvedQuery || typeof resolvedQuery !== 'object') return resolvedQuery;

  const service = String(resolvedQuery.service || '').trim();
  if (!NEEDS_TIME.has(service)) return resolvedQuery;

  const nowMs = overrideNowMs || Date.now();
  const now = Math.floor(nowMs / 1000);
  const timeKey = String(
    (resolvedQuery.timeRange && resolvedQuery.timeRange.key) || ''
  ).trim() || 'last1hour';

  const range = resolveTimeFromKey(timeKey, now);

  resolvedQuery.start = range.start;
  resolvedQuery.end = range.end;
  if (!resolvedQuery.timeRange || typeof resolvedQuery.timeRange !== 'object') {
    resolvedQuery.timeRange = {};
  }
  resolvedQuery.timeRange.key = timeKey;

  return resolvedQuery;
}

module.exports = {
  DURATION_MAP,
  NEEDS_TIME,
  floorToMinute,
  resolveTimeFromKey,
  applyTimeOverride,
};
