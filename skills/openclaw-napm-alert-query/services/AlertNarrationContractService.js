'use strict';

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

function buildEventPacketHandoff(event = {}, criteria = {}) {
  if (!event || !event.id) return null;
  const start = event.start || criteria.start;
  const end = event.end || criteria.end;
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

  return null;
}

function looksLikeIp(value = '') {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function buildNarrationInput(result = {}) {
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
    packetHandoff: result.packetHandoff || null,
    error: result.error || null,
    warnings: result.warnings || [],
    renderPolicy: {
      target: 'final_user_reply',
      includeRawApiResponse: false,
      includeSensitiveUrls: false,
    },
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

module.exports = {
  buildTimeRange,
  buildPacketHandoff,
  buildEventPacketHandoff,
  buildNarrationInput,
  buildReportData,
  looksLikeIp,
};

