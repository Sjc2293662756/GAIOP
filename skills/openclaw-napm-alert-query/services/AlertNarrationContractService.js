'use strict';

const { shouldDiscover } = require('./AlertIndirectPacketDiscoveryService');

function buildTimeRange(criteria = {}) {
  return {
    start: criteria.start || null,
    end: criteria.end || null,
    displayText: criteria.timeRange?.displayText || null,
  };
}

function buildPacketHandoff(events = [], criteria = {}) {
  const candidates = events
    .map((event) => buildEventPacketHandoff(event, criteria))
    .filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.length === 1
    ? candidates[0]
    : {
        available: true,
        reason: 'MULTIPLE_ALERT_PACKET_CANDIDATES',
        candidates,
      };
}

/**
 * 解析告警的实际时间窗口。
 *
 * NAPM Syslog/alertsDetail 对未恢复的告警返回 endtime=0，
 * 此时用 period（告警持续时长）或默认值计算结束时间，
 * 确保间接发现和数据包下载有合理的时间窗口。
 */
function resolveAlertTimeWindow(event = {}, criteria = {}) {
  const start = event.start || criteria.start;
  if (!start) return { start: null, end: null };

  let end = event.end || criteria.end;
  if (!end) {
    // endtime=0 表示告警未恢复，尝试 period 或默认窗口
    const period = Number(event.period);
    if (period > 0) {
      end = start + period;
    } else {
      end = start + 300; // 默认 5 分钟
    }
  }

  return { start, end };
}

function buildEventPacketHandoff(event = {}, criteria = {}) {
  if (!event || !event.id) return null;
  const { start, end } = resolveAlertTimeWindow(event, criteria);
  if (!start || !end) return null;

  if (Number(event.linkType) === 2) {
    return {
      available: true,
      reason: 'ALERT_LINK_TYPE_EVENT_ID',
      eventId: event.id,
      linkType: event.linkType,
      suggestedPacketQuery: {
        mode: 'build_url_only',
        criteria: {
          id: String(event.id),
          start,
          end,
        },
      },
    };
  }

  if (Number(event.linkType) === 1 && looksLikeIp(event.group)) {
    return {
      available: true,
      reason: 'ALERT_LINK_TYPE_OBJECT_IP',
      eventId: event.id,
      linkType: event.linkType,
      suggestedPacketQuery: {
        mode: 'build_url_only',
        criteria: {
          ips: [event.group],
          start,
          end,
        },
      },
    };
  }

  // 间接数据包发现：业务/应用/工作组告警，group 不是 IP
  if (shouldDiscover(event)) {
    return {
      available: null, // 待 discovery 查询后确定
      reason: 'ALERT_INDIRECT_DISCOVERY_PENDING',
      eventId: event.id,
      needsDiscovery: true,
      // 保存原始事件信息供 discovery 使用
      discoveryEvent: {
        id: event.id,
        group: event.group,
        categoryType: event.categoryType,
        groupType: event.groupType,
        category: event.category,
        categoryLabel: event.categoryLabel,
        metrics: event.metrics,
        start,
        end,
        linkType: event.linkType,
        // 用户提供的宽时间范围（discovery 用这个，不用告警的窄窗口）
        criteriaStart: criteria.start || null,
        criteriaEnd: criteria.end || null,
      },
    };
  }

  return null;
}

function looksLikeIp(value = '') {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function buildNarrationInput(result = {}) {
  const packetHandoff = result.packetHandoff || null;
  const triggerInfo = buildTriggerInfo(result);

  return {
    schema: 'openclaw_napm_alert.v1',
    language: 'zh-CN',
    mode: result.mode || null,
    ok: Boolean(result.ok),
    timeRange: result.timeRange || null,
    summary: result.summary || null,
    events: result.events || [],
    details: result.details || [],
    timeline: result.timeline || [],
    metricSeries: result.metricSeries || [],
    packetHandoff,
    triggerInfo,
    error: result.error || null,
    warnings: result.warnings || [],
    renderPolicy: {
      target: 'final_user_reply',
      includeRawApiResponse: false,
      includeSensitiveUrls: false,
    },
    packetInstruction: buildPacketInstruction(packetHandoff, triggerInfo),
  };
}

/**
 * 从告警详情中提取触发条件信息，供 AI 在数据包分析报告中解释告警原因。
 */
function buildTriggerInfo(result = {}) {
  const events = result.details && result.details.length > 0
    ? result.details
    : (Array.isArray(result.events) ? result.events : []);
  if (events.length === 0) return null;

  return events.map((e) => ({
    eventId: e.id,
    name: e.name || null,
    group: e.group || null,
    severity: e.severity || null,
    severityLabel: e.severityLabel || null,
    metrics: e.metrics || [],
    condition: e.condition || null,
    value: e.value || [],
    baseline: e.baseline || [],
    unit: e.unit || [],
    start: e.start || null,
    end: e.end || null,
    period: e.period || null,
  }));
}

/**
 * 根据 packetHandoff 结果生成 AI 下一步操作的直接指令。
 * 这是 narrationInput 中最关键的字段——AI 必须遵循，不得自行决策。
 */
function buildPacketInstruction(packetHandoff, triggerInfo = null) {
  // 无 packetHandoff
  if (!packetHandoff) {
    return {
      action: 'STOP_NO_PACKET',
      message: '该告警无关联数据包。直接告知用户"该告警无可下载的数据包"，不得调用 packet-analysis。',
      callPacketAnalysis: false,
    };
  }

  // 间接发现为空
  if (packetHandoff.reason === 'ALERT_INDIRECT_DISCOVERY_EMPTY') {
    return {
      action: 'STOP_DISCOVERY_EMPTY',
      message: `间接发现未找到嫌疑 IP（查询链路: ${packetHandoff.discoveryMethod?.groupChain || 'N/A'}）。告知用户该告警在对应业务/应用下无可疑 IP 会话，建议手动指定 IP 进行数据包分析。`,
      callPacketAnalysis: false,
    };
  }

  // 间接发现失败
  if (packetHandoff.reason === 'ALERT_INDIRECT_DISCOVERY_FAILED') {
    return {
      action: 'STOP_DISCOVERY_FAILED',
      message: `间接发现执行失败: ${packetHandoff.error?.message || '未知错误'}。告知用户发现过程出错，可手动指定 IP 进行分析。`,
      callPacketAnalysis: false,
    };
  }

  // 间接发现成功 — 有 candidates
  if (packetHandoff.reason === 'ALERT_INDIRECT_PACKET_VIA_DISCOVERY'
      && Array.isArray(packetHandoff.candidates) && packetHandoff.candidates.length > 0) {
    return {
      action: 'USE_CANDIDATES',
      message: `间接发现到 ${packetHandoff.candidates.length} 个嫌疑 IP 会话。必须逐条展示候选列表，然后对每个 candidate 使用其 suggestedPacketQuery（原样传递 mode 和 criteria）调用 openclaw-napm-packet-analysis。禁止自己构造 packetQuery，禁止直接用 eventId 查询。` + (
        triggerInfo && triggerInfo.length > 0
          ? ` 【重要】数据包分析报告中必须包含告警触发原因分析：指标(${(triggerInfo[0].metrics||[]).join(',')})、触发条件(${triggerInfo[0].condition || 'N/A'})、实际值(${(triggerInfo[0].value||[]).join(',')})，结合数据包内容解释为什么指标异常。`
          : ''),
      callPacketAnalysis: true,
      candidates: packetHandoff.candidates.map((c) => ({
        rank: c.rank,
        ips: c.ips,
        ipPair: c.ipPair || null,
        ip: c.ip || null,
        metricValue: c.metricValue,
        suggestedPacketQuery: c.suggestedPacketQuery,
      })),
    };
  }

  // 直接路径 — linkType=2 或 IP
  if (packetHandoff.available && packetHandoff.suggestedPacketQuery) {
    return {
      action: 'USE_DIRECT_QUERY',
      message: '告警有直接数据包关联。使用 suggestedPacketQuery 调用 openclaw-napm-packet-analysis。',
      callPacketAnalysis: true,
      suggestedPacketQuery: packetHandoff.suggestedPacketQuery,
    };
  }

  // 多候选
  if (packetHandoff.reason === 'MULTIPLE_ALERT_PACKET_CANDIDATES'
      && Array.isArray(packetHandoff.candidates)) {
    const indirectCandidates = packetHandoff.candidates
      .filter((c) => c && c.available && Array.isArray(c.candidates))
      .flatMap((c) => c.candidates);
    if (indirectCandidates.length > 0) {
      return {
        action: 'USE_CANDIDATES',
        message: `多个告警的间接发现共找到 ${indirectCandidates.length} 个嫌疑 IP 会话。逐条展示并按 suggestedPacketQuery 调用 packet-analysis。`,
        callPacketAnalysis: true,
        candidates: indirectCandidates.slice(0, 10).map((c) => ({
          rank: c.rank,
          ips: c.ips,
          ipPair: c.ipPair || null,
          ip: c.ip || null,
          metricValue: c.metricValue,
          suggestedPacketQuery: c.suggestedPacketQuery,
        })),
      };
    }
  }

  // 默认 — 无可用数据包
  return {
    action: 'STOP_NO_PACKET',
    message: '该告警无可用的数据包关联。直接告知用户。',
    callPacketAnalysis: false,
  };
}

function buildReportData(result = {}, sourceQuestion = '') {
  const sections = [];
  const summary = result.summary || {};
  if (summary.total != null) {
    sections.push({
      type: 'summary',
      title: '核心结论',
      content: `本次告警查询共返回 ${summary.total} 条事件，其中紧急 ${summary.bySeverity?.critical || 0} 条、重大 ${summary.bySeverity?.major || 0} 条、轻微 ${summary.bySeverity?.minor || 0} 条。`,
    });
  }
  if (Array.isArray(result.events) && result.events.length > 0) {
    sections.push({
      type: 'table',
      title: '告警事件列表',
      rows: result.events.map((event) => ({
        id: event.id,
        category: event.categoryLabel || event.category,
        group: event.group,
        severity: event.severityLabel || event.severity,
        name: event.name,
        metrics: (event.metrics || []).join(','),
        start: event.start,
        end: event.end,
      })),
    });
  }

  return {
    reportType: 'diagnostic_report',
    format: 'docx',
    title: 'NAPM 告警分析报告',
    sourceQuestion: sourceQuestion || null,
    timeRange: result.timeRange || null,
    dataSource: {
      system: 'NAPM',
      sourceSkill: 'openclaw-napm-alert-query',
      queryService: result.service || null,
    },
    sections,
    audit: {
      sourceSkill: 'openclaw-napm-alert-query',
    },
  };
}

/**
 * 从 packetHandoff 中提取所有需要间接发现的候选事件。
 * @returns {Array} discoveryEvent 列表
 */
function extractIndirectDiscoveryEvents(packetHandoff) {
  if (!packetHandoff) return [];

  const collect = (candidate) => {
    if (candidate && candidate.needsDiscovery && candidate.discoveryEvent) {
      return [candidate.discoveryEvent];
    }
    return [];
  };

  if (packetHandoff.needsDiscovery && packetHandoff.discoveryEvent) {
    return [packetHandoff.discoveryEvent];
  }

  if (packetHandoff.reason === 'MULTIPLE_ALERT_PACKET_CANDIDATES'
      && Array.isArray(packetHandoff.candidates)) {
    return packetHandoff.candidates.flatMap(collect);
  }

  return [];
}

module.exports = {
  buildTimeRange,
  buildPacketHandoff,
  buildEventPacketHandoff,
  buildNarrationInput,
  buildReportData,
  buildPacketInstruction,
  extractIndirectDiscoveryEvents,
  resolveAlertTimeWindow,
  looksLikeIp,
};

