'use strict';

const { shouldDiscover } = require('./AlertIndirectPacketDiscoveryService');
const { ALERT_CATEGORY_LABELS, ALERT_SEVERITY_LABELS } = require('./AlertConstants');

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
        value: event.value,
        unit: event.unit,
        condition: event.condition,
        severity: event.severity,
        severityLabel: event.severityLabel,
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

/**
 * 生成告警查询结果的展示文本。格式由 skill 定义，plugin 直接透传。
 */
function buildDisplayText(result = {}, packetHandoff, triggerInfo) {
  const lines = [];
  const events = Array.isArray(result.details) && result.details.length > 0
    ? result.details
    : (Array.isArray(result.events) ? result.events : []);
  const summary = result.summary || {};
  const timeRange = result.timeRange || {};
  const timeText = timeRange.displayText
    || (timeRange.start && timeRange.end
      ? `${formatTimestamp(timeRange.start)} 至 ${formatTimestamp(timeRange.end)}`
      : '');

  // ── 标题 ──
  if (timeText) lines.push(`${timeText} 告警查询结果`);
  else lines.push('告警查询结果');
  lines.push('');

  // ── 概况 ──
  const bySev = summary.bySeverity || {};
  const total = summary.total != null ? summary.total : events.length;
  lines.push(`告警总数：${total} 条`);
  lines.push(`  🔴 紧急 ${bySev.critical || 0} 条  |  🟠 重大 ${bySev.major || 0} 条  |  🟢 轻微 ${bySev.minor || 0} 条`);
  lines.push('');

  // ── 按类别 + name+severity 分组 ──
  const categoryOrder = ['networkAlerts', 'networkIssueAlerts', 'appAlerts', 'busAlerts', 'userAlerts', 'securityAlerts', 'AIAlerts'];
  const symbols = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];

  // 按类别归类事件
  const eventsByCategory = new Map();
  for (const e of events) {
    const cat = e.category || 'unknown';
    if (!eventsByCategory.has(cat)) eventsByCategory.set(cat, []);
    eventsByCategory.get(cat).push(e);
  }

  for (let i = 0; i < categoryOrder.length; i++) {
    const catKey = categoryOrder[i];
    const catLabel = ALERT_CATEGORY_LABELS[catKey] || catKey;
    const catEvents = eventsByCategory.get(catKey) || [];
    const catTotal = catEvents.length;

    // 统计本类别各级别数量
    let catCritical = 0, catMajor = 0, catMinor = 0;
    for (const e of catEvents) {
      if (e.severity === 4) catCritical++;
      else if (e.severity === 3) catMajor++;
      else catMinor++;
    }

    if (catTotal === 0) {
      // 空类别：显式标注
      lines.push(`${symbols[i]} ${catLabel} — 0 条（🔴 0 / 🟠 0 / 🟢 0）`);
      lines.push('   无告警记录');
    } else {
      lines.push(`${symbols[i]} ${catLabel} — ${catTotal} 条（🔴 ${catCritical} / 🟠 ${catMajor} / 🟢 ${catMinor}）`);
      lines.push('');

      // 按 name + severity 分组聚合
      const groupMap = new Map();
      for (const e of catEvents) {
        const key = `${e.name || '未知告警'}||${e.severity || 0}`;
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            name: e.name || '未知告警',
            severity: e.severity || 0,
            severityLabel: e.severityLabel || '',
            groups: new Map(),
            count: 0,
            totalPeriod: 0,
            firstStart: e.start,
          });
        }
        const g = groupMap.get(key);
        g.count++;
        if (e.period > 0) g.totalPeriod += e.period;
        if (e.start && (!g.firstStart || e.start < g.firstStart)) g.firstStart = e.start;
        // 按 group 聚合对象名
        const objKey = e.group || '?';
        g.groups.set(objKey, (g.groups.get(objKey) || 0) + 1);
      }

      // 按严重级别降序排列分组
      const sortedGroups = [...groupMap.values()].sort((a, b) => b.severity - a.severity || b.count - a.count);
      for (let j = 0; j < sortedGroups.length; j++) {
        const g = sortedGroups[j];
        const sevEmoji = g.severity === 4 ? '🔴' : g.severity === 3 ? '🟠' : '🟢';
        const sevLabel = g.severityLabel || (g.severity === 4 ? '紧急' : g.severity === 3 ? '重大' : '轻微');
        const topObjects = [...g.groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
        const objText = topObjects.join('、');
        const durationText = g.totalPeriod > 0
          ? (g.totalPeriod < 60 ? `${Math.round(g.totalPeriod * 60)}秒` : `${g.totalPeriod}分钟`)
          : '?';
        const startText = g.firstStart ? formatTimestamp(g.firstStart) : '?';

        lines.push(`# ${g.name}触发（${sevEmoji} ${sevLabel}）`);
        lines.push('');
        lines.push(`对象 **${objText}** 触发了 **${g.count}** 次告警，持续时长为 **${durationText}**，开始时间为 **${startText}**。`);
        lines.push('');

        if (j < sortedGroups.length - 1) {
          lines.push('---');
          lines.push('');
        }
      }
    }
    lines.push('');
  }

  // ── 兜底：detail 接口返回的事件 category 可能为 null，落入 unknown 桶 ──
  const unknownEvents = eventsByCategory.get('unknown') || [];
  if (unknownEvents.length > 0) {
    const unkCritical = unknownEvents.filter(e => e.severity === 4).length;
    const unkMajor = unknownEvents.filter(e => e.severity === 3).length;
    const unkMinor = unknownEvents.filter(e => e.severity === 2).length;
    const symIndex = Math.min(categoryOrder.length, 7);
    lines.push(`${symbols[symIndex] || '⑧'} 其他告警 — ${unknownEvents.length} 条（🔴 ${unkCritical} / 🟠 ${unkMajor} / 🟢 ${unkMinor}）`);
    lines.push('');

    const groupMap = new Map();
    for (const e of unknownEvents) {
      const key = `${e.name || '未知告警'}||${e.severity || 0}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          name: e.name || '未知告警', severity: e.severity || 0,
          severityLabel: e.severityLabel || '',
          groups: new Map(), count: 0, totalPeriod: 0, firstStart: e.start,
        });
      }
      const g = groupMap.get(key);
      g.count++;
      if (e.period > 0) g.totalPeriod += e.period;
      if (e.start && (!g.firstStart || e.start < g.firstStart)) g.firstStart = e.start;
      const objKey = e.group || '?';
      g.groups.set(objKey, (g.groups.get(objKey) || 0) + 1);
    }
    const sortedGroups = [...groupMap.values()].sort((a, b) => b.severity - a.severity || b.count - a.count);
    for (let j = 0; j < sortedGroups.length; j++) {
      const g = sortedGroups[j];
      const sevEmoji = g.severity === 4 ? '🔴' : g.severity === 3 ? '🟠' : '🟢';
      const sevLabel = g.severityLabel || (g.severity === 4 ? '紧急' : g.severity === 3 ? '重大' : '轻微');
      const topObjects = [...g.groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
      const objText = topObjects.join('、');
      const durationText = g.totalPeriod > 0
        ? (g.totalPeriod < 60 ? `${Math.round(g.totalPeriod * 60)}秒` : `${g.totalPeriod}分钟`)
        : '?';
      const startText = g.firstStart ? formatTimestamp(g.firstStart) : '?';
      lines.push(`# ${g.name}触发（${sevEmoji} ${sevLabel}）`);
      lines.push('');
      lines.push(`对象 **${objText}** 触发了 **${g.count}** 次告警，持续时长为 **${durationText}**，开始时间为 **${startText}**。`);
      lines.push('');
      if (j < sortedGroups.length - 1) { lines.push('---'); lines.push(''); }
    }
    lines.push('');
  }

  // ── packet 信息（仅 detail 模式显示）──
  const ph = packetHandoff || result.packetHandoff;
  if (ph && result.mode !== 'summary') {
    if (ph.available) {
      const cands = ph.candidates || [];
      lines.push(`数据包：发现 ${cands.length} 个嫌疑 IP 会话`);
      for (const c of cands) {
        lines.push(`  ${c.rank}. ${c.ipPair || c.ip || c.ips?.join('↔') || '-'}`);
      }
    } else if (ph.reason) {
      lines.push(`数据包：${ph.reason}`);
    }
    lines.push('');
  }

  lines.push('告警查询完成。');
  return lines.join('\n');
}

function formatTimestamp(ts) {
  if (!ts) return '?';
  const d = new Date(ts > 9999999999 ? ts : ts * 1000);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function formatDuration(event = {}) {
  const period = Number(event.period);
  if (period > 0) {
    if (period < 60) return `${Math.round(period * 60)}秒`;
    return `${period}分钟`;
  }
  const s = (event.start || event.firstStart) && (event.end || event.lastEnd)
    ? (event.end || event.lastEnd) - (event.start || event.firstStart) : 0;
  if (s <= 0) return '?';
  if (s < 60) return `${Math.round(s)}秒`;
  return `${Math.round(s / 60)}分钟`;
}

function buildCategoryDetailFromEvents(events = []) {
  const map = new Map();
  for (const e of events) {
    const cat = e.category || e.categoryLabel || 'unknown';
    const label = e.categoryLabel || cat;
    if (!map.has(cat)) map.set(cat, { category: cat, categoryLabel: label, total: 0, bySeverity: { critical: 0, major: 0, minor: 0 }, overviewEvents: [] });
    const d = map.get(cat);
    d.total++;
    if (e.severity === 4) d.bySeverity.critical++;
    else if (e.severity === 3) d.bySeverity.major++;
    else d.bySeverity.minor++;
    if (d.overviewEvents.length < 3) d.overviewEvents.push(e);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function buildNarrationInput(result = {}) {
  const packetHandoff = result.packetHandoff || null;
  const triggerInfo = buildTriggerInfo(result);

  return {
    schema: 'openclaw_napm_alert.v1',
    language: 'zh-CN',
    mode: result.mode || null,
    // 🔴 2026-07-27 修复: 失败结果不应生成 displayText，
    // 防止 buildAlertQueryReply 透传误导性"告警总数：0 条"模板。
    displayText: result.ok ? buildDisplayText(result, packetHandoff, triggerInfo) : null,
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

    // 从 triggerInfo 动态构建聚焦消息
    let focusMsg = '';
    if (triggerInfo && triggerInfo.length > 0) {
      const t = triggerInfo[0];
      const m = (t.metrics || []).join('、');
      const v = (t.value || []).join('、');
      const u = (t.unit || [])[0] || '';
      if (m) {
        focusMsg = `\n⚠️ 告警触发指标: ${m} = ${v}${u}。`
          + ` 触发条件: ${t.condition || 'N/A'}。`
          + ` 级别: ${t.severityLabel || 'N/A'}。`
          + `\n数据包分析报告必须围绕 ${m} 展开：`
          + `\n1. 解释为什么 ${m} 达到 ${v}${u}`
          + `\n2. 结合数据包中的重传、延迟、连接失败等证据`
          + `\n3. 找出导致指标异常的具体 IP 会话和时间点`
          + `\n4. 将数据包时间线与告警触发时刻关联`;
      }
    }
    if (!focusMsg) {
      focusMsg = '\n该告警无触发指标，但仍必须对发现的 IP 会话进行完整数据包分析（协议分布、会话通信、TCP 异常等）。';
    }

    return {
      action: 'USE_CANDIDATES',
      message: `间接发现到 ${packetHandoff.candidates.length} 个嫌疑 IP 会话。必须逐条展示候选列表，然后对每个 candidate 使用其 suggestedPacketQuery（原样传递 mode、criteria 和 analysis）调用 openclaw-napm-packet-analysis。禁止自己构造 packetQuery，禁止直接用 eventId 查询。${focusMsg}`,
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

const { GENERIC_QUERY_TEMPLATE_ID, REPORT_SCHEMA } = require('../../openclaw-napm-report/services/ReportTemplateRegistry');

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
    schema: REPORT_SCHEMA,
    reportType: 'quick_report',
    templateId: GENERIC_QUERY_TEMPLATE_ID,
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
  buildDisplayText,
  extractIndirectDiscoveryEvents,
  resolveAlertTimeWindow,
  looksLikeIp,
};

