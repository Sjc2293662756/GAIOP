'use strict';

/**
 * AlertIndirectPacketDiscoveryService
 *
 * 当业务/应用/工作组告警的 group 不是 IP 时，自动查询告警时段内该业务/应用
 * 下最可疑的 IP 会话，为间接数据包下载提供候选 IP 列表。
 *
 * 流程：
 *   1. shouldDiscover(event) → 判断是否触发间接发现
 *   2. buildDiscoveryParams(event, options) → 构造 topValues 查询参数
 *   3. parseTopValuesResult(rawData, categoryType) → 解析返回的 IP/IP 对
 *   4. buildIndirectCandidates(parsedIPs, event, options) → 构造 packetHandoff
 */

const { CATEGORY_TYPE_TO_GROUP_TYPE } = require('./AlertConstants');

// ── Discovery group chain 映射表 ────────────────────────────────────

/**
 * 每种 categoryType 对应的 discovery 查询路径配置。
 *
 * 字段说明：
 *   - groupType1/2/3: NAPM group chain 层级
 *   - defaultTopMetric: 当告警自身没有 metrics 时使用的默认排序指标
 *   - resultKeyFormat: 'ip' 表示返回单个 IP，'ipPair' 表示返回 IP|IP 对
 */
const DISCOVERY_GROUP_CHAIN_MAP = {
  // WebApplication → 查客户端 IP
  68: {
    groupType1: 'WebApplication',
    groupType2: 'ClientIPs',
    groupType3: 'IPAddress',
    defaultTopMetric: 'PGNPGE',
    resultKeyFormat: 'ip',
    description: 'WebApplication→ClientIPs→IPAddress',
  },
  // Application → 查 IP 会话对
  25: {
    groupType1: 'DefinedApp',
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
    description: 'DefinedApp→IPConversations→IPConversation',
  },
  // BusinessGroup → 查 IP 会话对
  14: {
    groupType1: 'BusinessGroup',
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
    description: 'BusinessGroup→IPConversations→IPConversation',
  },
  // PageFamily → 查客户端 IP
  63: {
    groupType1: 'PageFamily',
    groupType2: 'ClientIPs',
    groupType3: 'IPAddress',
    defaultTopMetric: 'PGNPGE',
    resultKeyFormat: 'ip',
    description: 'PageFamily→ClientIPs→IPAddress',
  },
};

// ── 公开 API ─────────────────────────────────────────────────────────

/**
 * 判断一个告警事件是否需要间接数据包发现。
 *
 * 条件：
 *   - linkType 不是 2（非事件 ID 直接关联）
 *   - group 不是 IP 地址
 *   - group 不为空
 *   - categoryType 在支持的映射表中
 */
function shouldDiscover(event = {}) {
  if (!event || !event.id) return false;

  // linkType=2 走直接事件 ID 路径
  if (Number(event.linkType) === 2) return false;

  // group 为空无法查询
  if (!event.group || String(event.group).trim() === '') return false;

  // group 是 IP 走直接 IP 路径
  if (looksLikeIp(event.group)) return false;

  // categoryType 必须在映射表中
  const chainConfig = DISCOVERY_GROUP_CHAIN_MAP[event.categoryType];
  if (!chainConfig) return false;

  return true;
}

/**
 * 构造 discovery topValues 查询参数。
 *
 * @param {object} event - 告警事件（已归一化）
 * @param {object} options - 查询选项
 * @returns {object} topValues 查询参数
 */
function buildDiscoveryParams(event = {}, options = {}) {
  const chainConfig = DISCOVERY_GROUP_CHAIN_MAP[event.categoryType];
  if (!chainConfig) return null;

  const topCount = Number.isFinite(Number(options.discoveryTopCount))
    ? Number(options.discoveryTopCount)
    : 5;

  // 指标：优先用告警自己的 metrics，否则用默认 topMetric
  const eventMetrics = (Array.isArray(event.metrics) && event.metrics.length > 0)
    ? event.metrics
    : [chainConfig.defaultTopMetric];
  const topMetric = eventMetrics[0] || chainConfig.defaultTopMetric;

  return {
    type: 'topValues',
    start: event.start,
    end: event.end,
    metrics: eventMetrics.join(','),
    topMetric,
    topCount,
    numGroups: 3,
    groupType1: chainConfig.groupType1,
    groupArgument1: event.group,
    groupType2: chainConfig.groupType2,
    groupType3: chainConfig.groupType3,
    json: 'true',
    _meta: {
      chainConfig,
      topMetric,
      eventId: event.id,
    },
  };
}

/**
 * 解析 topValues 返回的原始数据，提取 IP 列表。
 *
 * @param {object} rawData - NAPM topValues API 原始响应
 * @param {number} categoryType - 告警 categoryType，用于判断解析方式
 * @returns {Array<{rank: number, ip?: string, ipPair?: string, ips: string[], metricValue: object}>}
 */
function parseTopValuesResult(rawData = {}, categoryType) {
  const chainConfig = DISCOVERY_GROUP_CHAIN_MAP[categoryType];
  const format = chainConfig ? chainConfig.resultKeyFormat : 'ip';

  // NAPM topValues 响应结构：{ topValues: [{ key, metricValues }] }
  // 或者：{ "IP": value, ... }（简化格式）
  const entries = [];

  if (Array.isArray(rawData.topValues)) {
    // 标准格式
    rawData.topValues.forEach((item) => {
      if (!item || item.key == null) return;
      const metricValues = {};
      if (Array.isArray(item.metricValues)) {
        item.metricValues.forEach((mv) => {
          if (mv && mv.metric) {
            const id = mv.metric.id || mv.metric.code || 'value';
            metricValues[id] = mv.value;
          }
        });
      }
      entries.push({ key: String(item.key), metricValues });
    });
  } else if (rawData && typeof rawData === 'object') {
    // 简化格式：{ "10.1.1.5": 156, ... }
    for (const [key, value] of Object.entries(rawData)) {
      if (key === 'type' || key === 'interval' || key === 'topValues') continue;
      const numVal = Number(value);
      if (Number.isFinite(numVal)) {
        entries.push({ key, metricValues: { value: numVal } });
      }
    }
  }

  // 解析 key → IP/IP 对
  const results = [];
  for (const entry of entries) {
    const ips = extractIPsFromKey(entry.key, format);
    if (ips.length === 0) continue;

    const candidate = {
      rank: results.length + 1,
      ips,
      metricValue: entry.metricValues,
    };

    if (format === 'ipPair') {
      candidate.ipPair = entry.key;
    } else {
      candidate.ip = ips[0];
    }

    results.push(candidate);
  }

  return results;
}

/**
 * 执行单个告警事件的间接数据包发现。
 *
 * @param {object} api - AlertApiService 实例
 * @param {object} event - 告警事件（已归一化）
 * @param {object} options - 查询选项
 * @returns {object|null} indirect packetHandoff 或 null
 */
async function discover(api, event = {}, options = {}) {
  if (!shouldDiscover(event)) return null;

  const params = buildDiscoveryParams(event, options);
  if (!params) return null;

  const { _meta, ...queryParams } = params;

  try {
    const rawData = await api.getJsonByParams('topValues', queryParams);
    const candidates = parseTopValuesResult(rawData, event.categoryType);

    if (candidates.length === 0) {
      return {
        available: false,
        reason: 'ALERT_INDIRECT_DISCOVERY_EMPTY',
        eventId: event.id,
        discoveryMethod: {
          type: 'topValues',
          groupChain: _meta.chainConfig.description,
          topMetric: _meta.topMetric,
        },
        candidates: [],
        bufferSeconds: options.packetBufferSeconds || 120,
      };
    }

    const bufferSeconds = Number.isFinite(Number(options.packetBufferSeconds))
      ? Number(options.packetBufferSeconds)
      : 120;

    return {
      available: true,
      reason: 'ALERT_INDIRECT_PACKET_VIA_DISCOVERY',
      eventId: event.id,
      discoveryMethod: {
        type: 'topValues',
        groupChain: _meta.chainConfig.description,
        topMetric: _meta.topMetric,
        topCount: queryParams.topCount,
      },
      candidates: candidates.map((c) => ({
        ...c,
        suggestedPacketQuery: {
          mode: 'preview_download_analyze',
          criteria: {
            ips: c.ips,
            start: (event.start || 0) - bufferSeconds,
            end: (event.end || 0) + bufferSeconds,
          },
        },
      })),
      bufferSeconds,
    };
  } catch (error) {
    return {
      available: false,
      reason: 'ALERT_INDIRECT_DISCOVERY_FAILED',
      eventId: event.id,
      error: {
        code: 'ALERT_INDIRECT_DISCOVERY_ERROR',
        message: error.message || String(error),
      },
      candidates: [],
      bufferSeconds: options.packetBufferSeconds || 120,
    };
  }
}

/**
 * 批量执行间接发现（多个 event 时去重）。
 *
 * @param {object} api - AlertApiService 实例
 * @param {Array} events - 告警事件列表（已归一化）
 * @param {object} options - 查询选项
 * @returns {object|null} 聚合的 packetHandoff 或 null
 */
async function discoverForEvents(api, events = [], options = {}) {
  const discoverableEvents = events.filter((e) => shouldDiscover(e));
  if (discoverableEvents.length === 0) return null;

  // 去重：同一 group + categoryType 只查一次
  const seen = new Set();
  const uniqueEvents = [];
  for (const event of discoverableEvents) {
    const dedupKey = `${event.categoryType}::${event.group}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    uniqueEvents.push(event);
  }

  const results = [];
  for (const event of uniqueEvents) {
    const result = await discover(api, event, options);
    if (result) {
      results.push(result);
    }
  }

  const allResults = results.filter((r) => r);
  if (allResults.length === 0) return null;

  if (allResults.length === 1) return allResults[0];

  // 多事件聚合
  return {
    available: allResults.some((r) => r.available),
    reason: 'ALERT_INDIRECT_PACKET_VIA_DISCOVERY_MULTI',
    eventIds: allResults.map((r) => r.eventId),
    groups: allResults.map((r) => ({
      eventId: r.eventId,
      available: r.available,
      reason: r.reason,
      discoveryMethod: r.discoveryMethod,
      candidates: r.candidates,
      bufferSeconds: r.bufferSeconds,
      error: r.error || null,
    })),
  };
}

// ── 内部工具函数 ────────────────────────────────────────────────────

function looksLikeIp(value = '') {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

/**
 * 从 topValues 返回的 key 中提取 IP 列表。
 *
 * @param {string} key - topValues 的 key（如 "10.1.1.5" 或 "10.1.1.5|10.2.2.100"）
 * @param {'ip'|'ipPair'} format
 * @returns {string[]} IP 地址数组
 */
function extractIPsFromKey(key = '', format = 'ip') {
  const text = String(key || '').trim();
  if (!text) return [];

  if (format === 'ipPair') {
    // IPConversation 使用 | 分隔两个 IP
    const parts = text.split('|').map((s) => s.trim()).filter(Boolean);
    return parts.filter((p) => looksLikeIp(p));
  }

  // 单个 IP 格式
  if (looksLikeIp(text)) return [text];
  return [];
}

module.exports = {
  DISCOVERY_GROUP_CHAIN_MAP,
  shouldDiscover,
  buildDiscoveryParams,
  parseTopValuesResult,
  discover,
  discoverForEvents,
  extractIPsFromKey,
  looksLikeIp,
};
