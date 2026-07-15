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
    groupType2: 'ClientIPs',
    groupType3: 'IPAddress',
    defaultTopMetric: 'PGNPGE',
    resultKeyFormat: 'ip',
  },
  // Application/DefinedApp → 查 IP 会话对
  25: {
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
  },
  // BusinessGroup → 查 IP 会话对
  14: {
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
  },
  // OtherApp (categoryType=51) → 查 IP 会话对
  51: {
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
  },
  // ConnectedBusinessGroup (categoryType=27) → 查 IP 会话对
  27: {
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
  },
  // BusinessGroupLink (categoryType=29) → 查 IP 会话对
  29: {
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
  },
  // OtherApp (categoryType=56) → 查 IP 会话对
  56: {
    groupType2: 'IPConversations',
    groupType3: 'IPConversation',
    defaultTopMetric: 'TPIO',
    resultKeyFormat: 'ipPair',
  },
  // PageFamily → 查客户端 IP
  63: {
    groupType2: 'ClientIPs',
    groupType3: 'IPAddress',
    defaultTopMetric: 'PGNPGE',
    resultKeyFormat: 'ip',
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

  // groupType1 从 CATEGORY_TYPE_TO_GROUP_TYPE 映射表取，不写死
  const groupType1 = event.groupType || CATEGORY_TYPE_TO_GROUP_TYPE[event.categoryType];
  if (!groupType1) return null;

  const topCount = Number.isFinite(Number(options.discoveryTopCount))
    ? Number(options.discoveryTopCount)
    : 5;

  // 指标：优先用告警自己的 metrics，否则用默认 topMetric
  const eventMetrics = (Array.isArray(event.metrics) && event.metrics.length > 0)
    ? event.metrics
    : [chainConfig.defaultTopMetric];
  const topMetric = eventMetrics[0] || chainConfig.defaultTopMetric;

  // discovery 优先用用户提供的宽时间范围，确保 NAPM API 能返回数据
  // 若用户未提供（如仅给 eventId），fallback 到告警自身窗口
  const discoveryStart = event.criteriaStart || event.start;
  const discoveryEnd = event.criteriaEnd || event.end;

  return {
    type: 'topValues',
    start: discoveryStart,
    end: discoveryEnd,
    metrics: eventMetrics.join(','),
    topMetric,
    topCount,
    numGroups: 3,
    groupType1,
    groupArgument1: event.group,
    groupType2: chainConfig.groupType2,
    groupType3: chainConfig.groupType3,
    json: 'true',
    _meta: {
      groupType1,
      groupType2: chainConfig.groupType2,
      groupType3: chainConfig.groupType3,
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

  // NAPM topValues 响应结构可能有三种格式：
  //   1. { topValues: [{ key, metricValues }] } — 标准 topValues
  //   2. { "IP": value, ... } — 简化键值对
  //   3. [{ group: { argument, key }, groupPath }] — 树形 drill-down 结果
  const entries = [];

  if (Array.isArray(rawData.topValues)) {
    // 格式 1：标准 topValues
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
  } else if (Array.isArray(rawData) && rawData.length > 0 && rawData[0].group) {
    // 格式 3：树形 drill-down [{ group: { argument, key }, groupPath }]
    rawData.forEach((item) => {
      if (!item || !item.group) return;
      const argument = String(item.group.argument || '').trim();
      if (!argument) return;
      entries.push({ key: argument, metricValues: {} });
    });
  } else if (rawData && typeof rawData === 'object') {
    // 格式 2：简化键值对 { "10.1.1.5": 156, ... }
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

  const groupChain = `${_meta.groupType1}→${_meta.groupType2}→${_meta.groupType3}`;

  try {
    const rawData = await api.getJsonByParams('topValues', queryParams);
    const candidates = parseTopValuesResult(rawData, event.categoryType);

    const bufferSeconds = Number.isFinite(Number(options.packetBufferSeconds))
      ? Number(options.packetBufferSeconds)
      : 120;

    if (candidates.length === 0) {
      return {
        available: false,
        reason: 'ALERT_INDIRECT_DISCOVERY_EMPTY',
        eventId: event.id,
        discoveryMethod: {
          type: 'topValues',
          groupChain,
          topMetric: _meta.topMetric,
        },
        candidates: [],
        bufferSeconds,
      };
    }

    // 告警触发指标 → 透传到 packet-analysis 用于侧重分析
    // options.alertTriggerMetrics 可包含外部注入的指标值（来自 syslog 等），
    // 当 NAPM API 返回 metrics:[] 时作为回退数据源
    const analysis = buildFocusAnalysis(event, options);

    return {
      available: true,
      reason: 'ALERT_INDIRECT_PACKET_VIA_DISCOVERY',
      eventId: event.id,
      discoveryMethod: {
        type: 'topValues',
        groupChain,
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
          analysis,
        },
      })),
      bufferSeconds,
    };
  } catch (error) {
    // 查询失败时尝试不带 groupArgument1 重试（常见原因：对象在 NAPM 中不存在）
    if (queryParams && queryParams.groupArgument1) {
      try {
        const fallbackParams = { ...queryParams };
        delete fallbackParams.groupArgument1;
        delete fallbackParams.groupType2;
        delete fallbackParams.groupType3;
        fallbackParams.numGroups = 1;
        fallbackParams.start = event.start;
        fallbackParams.end = event.end;
        const fallbackData = await api.getJsonByParams('topValues', fallbackParams);
        // 树形格式 [{ group: { argument, label }, groupPath }]，argument 是对象名
        const existingObjects = [];
        if (Array.isArray(fallbackData)) {
          for (const item of fallbackData) {
            if (item && item.group) {
              existingObjects.push({
                name: item.group.argument || '',
                label: item.group.label || '',
                key: item.group.key || '',
              });
            }
          }
        }
        if (existingObjects.length > 0) {
          const matched = existingObjects.filter(
            (o) => o.name === event.group || o.label === event.group
          );
          return {
            available: false,
            reason: 'ALERT_INDIRECT_DISCOVERY_OBJECT_NOT_FOUND',
            eventId: event.id,
            discoveryMethod: {
              type: 'topValues',
              groupChain: `${_meta.groupType1}（对象 "${event.group}" 不存在）`,
              topMetric: _meta.topMetric,
            },
            hint: matched.length > 0
              ? `对象 "${event.group}" 匹配到 ${matched[0].name}(${matched[0].label})，但下钻查询失败`
              : `对象 "${event.group}" 在 NAPM ${_meta.groupType1} 中不存在。现有对象: ${existingObjects.slice(0, 5).map((o) => o.name).join(', ')}`,
            candidates: [],
            bufferSeconds: options.packetBufferSeconds || 120,
          };
        }
      } catch (_fallbackError) {
        // fallback 也失败，忽略
      }
    }

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

/**
 * 从告警事件中提取触发指标信息，透传给 packet-analysis 用于侧重分析。
 *
 * @param {object} event - 告警事件（已归一化）
 * @param {object} [options] - 可选配置
 * @param {object} [options.alertTriggerMetrics] - 外部注入的指标值，
 *   当 NAPM alertsDetail 返回 metrics:[] 时作为回退数据源。
 *   格式: { names: ["中文名"], codes: ["CODE"], values: [1.23], units: ["ms"],
 *           condition: "> 3000", severity: "紧急" }
 */
function buildFocusAnalysis(event = {}, options = {}) {
  const metrics = Array.isArray(event.metrics) ? event.metrics : [];
  const value = Array.isArray(event.value) ? event.value : [];
  const unit = Array.isArray(event.unit) ? event.unit : [];
  const condition = event.condition || null;
  const severityLabel = event.severityLabel || null;

  // event 自身有指标 → 走原有逻辑
  if (metrics.length > 0) {
    const metricLabels = metrics.map((code) => getMetricLabel(code));
    return {
      hasTriggerMetrics: true,
      metrics,
      metricLabels,
      values: value,
      units: unit,
      condition,
      severity: severityLabel,
      summary: metrics.map((m, i) => {
        const label = metricLabels[i] || m;
        return `${label}(${m})=${value[i] ?? '?'}${unit[i] ?? ''}`;
      }).join(', '),
      instruction: `数据包分析报告必须围绕 ${metricLabels.join('、')}(${metrics.join('、')}) 展开。`
        + `解释为什么 ${metricLabels.join('、')} 达到 ${value.join('、')}${unit[0] || ''}，`
        + `结合数据包中的 TCP 重传、延迟、连接失败等证据，`
        + `找出导致指标异常的具体 IP 会话和时间点。`
        + (condition ? ` 触发条件: ${condition}` : ''),
    };
  }

  // event metrics 为空 → 尝试外部注入（来自 syslog 等数据源）
  const external = options.alertTriggerMetrics || null;
  if (external && Array.isArray(external.names) && external.names.length > 0) {
    return buildFocusFromExternalMetrics(external);
  }

  return {
    hasTriggerMetrics: false,
    note: '该告警无触发指标（metrics 为空），仍必须对发现的 IP 会话进行完整数据包分析。',
  };
}

/**
 * 从外部注入的指标值构建 focusAnalysis。
 * 用于 NAPM alertsDetail API 不返回触发指标时，
 * 由 syslog 等外部数据源补充指标上下文。
 *
 * @param {object} external
 * @param {string[]} external.names - 指标中文名
 * @param {string[]} [external.codes] - 指标代码
 * @param {number[]} external.values - 指标实际值
 * @param {string[]} external.units - 指标单位
 * @param {string} [external.condition] - 触发条件
 * @param {string} [external.severity] - 告警级别
 */
function buildFocusFromExternalMetrics(external = {}) {
  const names = external.names || [];
  const codes = external.codes || names;
  const values = external.values || [];
  const units = external.units || [];
  const condition = external.condition || null;
  const severity = external.severity || null;

  return {
    hasTriggerMetrics: true,
    metrics: codes,
    metricLabels: names,
    values,
    units,
    condition,
    severity,
    summary: names.map((n, i) => `${n}(${codes[i] || n})=${values[i] ?? '?'}${units[i] ?? ''}`).join(', '),
    instruction: `数据包分析报告必须围绕 ${names.join('、')} 展开。`
      + `解释为什么 ${names.join('、')} 达到 ${values.join('、')}${units[0] || ''}，`
      + `结合数据包中的 TCP 重传、延迟、连接失败等证据，`
      + `找出导致指标异常的具体 IP 会话和时间点。`
      + (condition ? ` 触发条件: ${condition}` : ''),
    _source: 'external_injected', // 标记数据来源
  };
}

// 从 metrics-config.yml 查指标中文名（不用 js-yaml，正则解析）
let _metricLabelCache = null;
function getMetricLabel(code = '') {
  if (!_metricLabelCache) {
    _metricLabelCache = {};
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(__dirname, '..', '..', '..', 'config', 'metrics-config.yml');
      const text = fs.readFileSync(configPath, 'utf8');
      // 解析格式: "- code: XXX\n    description: 中文名\n"
      const re = /-\s+code:\s*(\S+)\s*\n\s+description:\s*(.+)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        _metricLabelCache[m[1]] = m[2].trim();
      }
    } catch (_e) {
      // fallback: 用 code 作为 label
    }
  }
  return _metricLabelCache[code] || code;
}

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
  buildFocusAnalysis,
  extractIPsFromKey,
  looksLikeIp,
};
