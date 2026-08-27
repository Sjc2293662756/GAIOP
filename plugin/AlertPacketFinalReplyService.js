'use strict';

const INTERNAL_CONTENT_PATTERNS = [
  /openclaw_napm_alert_packet_analysis\.v1/i,
  /["']?renderPolicy["']?\s*:/i,
  /["']?narrationInput["']?\s*:/i,
  /请仅依据下面的结构化证据解释告警触发原因/
];

function prepareModelFinalContent(content, result = {}) {
  const sanitized = sanitizeText(content);
  if (!isEligibleModelFinalContent(sanitized, result)) {
    return '';
  }
  return result?.referenceId ? hideReferenceInternals(sanitized) : sanitized;
}

function hideReferenceInternals(text) {
  return String(text || '')
    .replace(/["']?eventId["']?\s*[:=]\s*["']?\d{1,20}["']?/gi, '')
    .replace(/["']?start["']?\s*[:=]\s*["']?\d{10,13}["']?/gi, '')
    .replace(/["']?end["']?\s*[:=]\s*["']?\d{10,13}["']?/gi, '')
    .replace(/告警事件\s*\d{1,20}/g, '告警事件')
    .replace(/\b(?:Alert\s*ID|Event\s*ID)\s*[:=]?\s*\d{1,20}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isEligibleModelFinalContent(content, result = {}) {
  const text = String(content || '').trim();
  if (!text || text.length < 16 || result?.workflowType !== 'alert_packet_analysis') {
    return false;
  }
  const workflowState = String(result?.workflowState || '').trim();
  if (result?.ok === false || (workflowState && workflowState !== 'COMPLETED')) {
    return false;
  }
  if (INTERNAL_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  const eventId = String(result?.eventId || '').trim();
  const metricNames = toStringArray(result?.triggerMetrics?.names);
  const evidenceTerms = ['告警', '数据包', '抓包', 'packet', 'alert', '重传', '时延', '响应'];
  return Boolean(
    (eventId && text.includes(eventId))
    || metricNames.some((name) => text.includes(name))
    || evidenceTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()))
  );
}

function buildDeterministicFinalReply(result = {}) {
  const eventId = sanitizeText(result?.eventId || '') || '未知';
  const referenceId = sanitizeText(result?.referenceId || '');
  const workflowState = sanitizeText(result?.workflowState || '') || 'UNKNOWN';
  const lines = [referenceId ? `告警引用 ${referenceId} 数据包分析结果` : `告警事件 ${eventId} 数据包分析结果`];

  lines.push(`工作流状态：${workflowState}（${workflowStateLabel(workflowState)}）`);
  const range = formatTimeRange(result?.timeRange);
  if (range) {
    lines.push(`分析时间范围：${range}`);
  }

  const metrics = buildMetricLines(result?.triggerMetrics);
  if (metrics.length > 0) {
    lines.push('', '告警触发信息');
    lines.push(...metrics);
  }

  const alertDetails = buildAlertDetailLines(result?.alert);
  if (alertDetails.length > 0) {
    lines.push('', '告警详情');
    lines.push(...alertDetails);
  }

  if (workflowState === 'CANDIDATE_SELECTION_REQUIRED') {
    lines.push('', '候选数据包');
    const options = Array.isArray(result.candidateOptions) ? result.candidateOptions : [];
    if (options.length === 0) {
      lines.push('- 当前没有可展示的候选数据包。');
    } else {
      for (const [index, option] of options.entries()) {
        const candidateId = sanitizeText(option.candidateId || `${referenceId}-P${index + 1}`);
        const endpoint = [option.ipPair, option.ip, ...(Array.isArray(option.ips) ? option.ips : [])]
          .map(sanitizeText)
          .filter(Boolean)
          .filter((value, itemIndex, values) => values.indexOf(value) === itemIndex)
          .join(' -> ');
        lines.push(`- ${candidateId}${endpoint ? `：${endpoint}` : ''}`);
      }
      lines.push('', `请回复：分析 ${sanitizeText(options[0]?.candidateId || `${referenceId}-P1`)}`);
    }
    lines.push('', '结论：请先选择一个候选数据包，系统不会自动选择第一个候选。');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const packetLines = buildPacketAnalysisLines(result?.packetAnalyses);
  if (packetLines.length > 0) {
    lines.push('', '数据包证据');
    lines.push(...packetLines);
  } else {
    lines.push('', '数据包证据', '- 当前结果中没有可展示的成功数据包分析证据。');
  }

  const errorMessage = sanitizeText(result?.error?.message || '');
  if (errorMessage) {
    lines.push('', `未完成项：${errorMessage}`);
  }
  lines.push('', buildConclusion(workflowState, result?.packetAnalyses));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildMetricLines(triggerMetrics = {}) {
  const names = toStringArray(triggerMetrics?.names);
  const values = toArray(triggerMetrics?.values);
  const units = toStringArray(triggerMetrics?.units);
  const lines = [];
  const count = Math.max(names.length, values.length);
  for (let index = 0; index < count; index += 1) {
    const name = sanitizeText(names[index] || `指标 ${index + 1}`);
    const value = sanitizeText(values[index] ?? '未知');
    const unit = sanitizeText(units[index] || '');
    lines.push(`- ${name}：${value}${unit}`);
  }
  const severity = sanitizeText(triggerMetrics?.severity || '');
  const condition = sanitizeText(triggerMetrics?.condition || '');
  if (severity) lines.push(`- 告警级别：${severity}`);
  if (condition) lines.push(`- 触发条件：${condition}`);
  return lines;
}

function buildAlertDetailLines(alert = {}) {
  const detail = Array.isArray(alert?.details) ? alert.details[0] : null;
  if (!detail || typeof detail !== 'object') {
    return [];
  }
  const fields = [
    ['告警名称', detail.name || detail.alertName],
    ['告警对象', detail.group || detail.groupName || detail.objectName || detail.objName],
    ['告警类别', detail.categoryLabel || detail.category],
    ['告警级别', detail.severityLabel || detail.severity]
  ];
  return fields
    .map(([label, value]) => [label, sanitizeText(value || '')])
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}：${value}`);
}

function buildPacketAnalysisLines(packetAnalyses = []) {
  const items = Array.isArray(packetAnalyses) ? packetAnalyses : [];
  const lines = [];
  for (const [index, item] of items.slice(0, 10).entries()) {
    const rank = Number(item?.rank) || index + 1;
    const endpoint = formatCandidate(item);
    const status = item?.ok ? '成功' : '失败';
    lines.push(`- 候选 ${rank}${endpoint ? `（${endpoint}）` : ''}：${status}`);
    const highlights = collectSafeHighlights(item);
    for (const highlight of highlights.slice(0, 5)) {
      lines.push(`  - ${highlight}`);
    }
    if (!item?.ok) {
      const message = sanitizeText(item?.error?.message || item?.result?.error?.message || '');
      if (message) lines.push(`  - 失败原因：${message}`);
    }
  }
  return lines;
}

function collectSafeHighlights(item = {}) {
  const candidates = [
    ...(Array.isArray(item?.result?.summary?.highlights) ? item.result.summary.highlights : []),
    ...(Array.isArray(item?.result?.narrationInput?.summary?.highlights)
      ? item.result.narrationInput.summary.highlights
      : [])
  ];
  return [...new Set(candidates
    .map(sanitizeText)
    .filter(Boolean)
    .filter((text) => !/https?:\/\//i.test(text))
    .filter((text) => !/(?:raw packet|原始数据包|tshark\s+rows?)/i.test(text))
  )];
}

function formatCandidate(item = {}) {
  const candidate = item?.candidate && typeof item.candidate === 'object' ? item.candidate : {};
  const queryCriteria = item?.query?.criteria && typeof item.query.criteria === 'object'
    ? item.query.criteria
    : {};
  const values = [
    candidate.ipPair,
    candidate.ip,
    ...(Array.isArray(candidate.ips) ? candidate.ips : []),
    ...(Array.isArray(queryCriteria.ips) ? queryCriteria.ips : [])
  ].map(sanitizeText).filter(Boolean);
  return [...new Set(values)].join(' -> ');
}

function buildConclusion(workflowState, packetAnalyses = []) {
  const items = Array.isArray(packetAnalyses) ? packetAnalyses : [];
  const successCount = items.filter((item) => item?.ok).length;
  if (workflowState === 'COMPLETED') {
    return `结论：已完成 ${successCount} 个候选会话的数据包分析，请以上述数据包证据作为告警原因判断依据。`;
  }
  if (workflowState === 'PARTIAL_PACKET_ANALYSIS') {
    return `结论：已获得 ${successCount} 个候选会话的有效证据，但仍有候选分析失败；当前结论仅覆盖成功部分。`;
  }
  return '结论：本轮未形成完整的数据包证据，不能据此推测告警根因。';
}

function workflowStateLabel(state) {
  const labels = {
    COMPLETED: '已完成',
    PARTIAL_PACKET_ANALYSIS: '部分完成',
    PACKET_ANALYSIS_FAILED: '数据包分析失败',
    ALERT_DETAIL_NOT_VISIBLE: '告警详情暂不可见',
    ALERT_DETAIL_QUERY_FAILED: '告警详情查询失败',
    NO_PACKET_CANDIDATE: '无可执行数据包候选',
    INVALID_INPUT: '输入无效',
    WORKFLOW_RUNTIME_FAILED: '工作流运行失败',
    CANDIDATE_SELECTION_REQUIRED: '等待选择数据包候选'
  };
  return labels[state] || '未识别状态';
}

function formatTimeRange(timeRange = null) {
  const start = normalizeUnixSeconds(timeRange?.start);
  const end = normalizeUnixSeconds(timeRange?.end);
  if (!start || !end) return '';
  return `${formatShanghaiTime(start)} 至 ${formatShanghaiTime(end)}`;
}

function formatShanghaiTime(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return String(unixSeconds);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, '://***:***@')
    .replace(/([?&](?:UserName|Password|password|passwd|token|access_token|api_key)=)[^&#\s)\]]+/gi, '$1***')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function normalizeUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function toArray(value) {
  return Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
}

function toStringArray(value) {
  return toArray(value).map((item) => String(item).trim()).filter(Boolean);
}

module.exports = {
  buildDeterministicFinalReply,
  isEligibleModelFinalContent,
  prepareModelFinalContent,
  hideReferenceInternals,
  sanitizeText
};
