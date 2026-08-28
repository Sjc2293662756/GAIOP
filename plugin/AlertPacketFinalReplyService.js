'use strict';

const ALERT_EVIDENCE_LABELS = Object.freeze({
  server_response_wait: '服务端响应等待',
  http_response_time: 'HTTP 响应耗时',
  tcp_rtt: 'TCP RTT',
  tcp_retransmission: 'TCP 重传',
  alert_time_correlation: '告警时间相关性',
  packet_loss: '丢包',
  dns_time: 'DNS 耗时',
  tcp_connect_time: 'TCP 建连耗时',
  tls_handshake_time: 'TLS 握手耗时',
  http_status_code: 'HTTP 状态码',
  http_request_uri: 'HTTP 请求 URI',
  server_response: '服务端响应',
  tcp_stream: 'TCP 会话',
  endpoint_direction: '端点方向'
});

const PROFILE_EVIDENCE_CHECKS = Object.freeze({
  server_user_experience_time: ['server_response_wait', 'http_response_time', 'tcp_rtt', 'tcp_retransmission', 'alert_time_correlation'],
  network_user_experience_time: ['tcp_rtt', 'tcp_retransmission', 'packet_loss', 'alert_time_correlation'],
  page_load_time: ['dns_time', 'tcp_connect_time', 'tls_handshake_time', 'http_response_time', 'alert_time_correlation'],
  http_error_rate: ['http_status_code', 'http_request_uri', 'server_response', 'alert_time_correlation'],
  tcp_retransmission: ['tcp_retransmission', 'tcp_stream', 'alert_time_correlation'],
  network_latency: ['tcp_rtt', 'endpoint_direction', 'alert_time_correlation']
});

function prepareModelFinalContent(content, result = {}) {
  const sanitized = sanitizeText(content);
  // Alert packet analysis has a deterministic final-reply contract. Keeping a
  // model-authored final here would let a generic packet summary bypass it.
  if (result?.workflowType === 'alert_packet_analysis') {
    return '';
  }
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
  // There is intentionally no model-owned final path for this workflow.
  // `buildDeterministicFinalReply` is the only supported renderer.
  return false;
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

  const focused = hasAlertTriggerMetrics(result);
  const packetLines = focused
    ? buildFocusedPacketAnalysisLines(result)
    : buildPacketAnalysisLines(result?.packetAnalyses);
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
  if (workflowState === 'DOWNLOAD_CONFIRMATION_REQUIRED') {
    lines.push('', '下一步：请回复“开始分析”或“确认下载”，系统将继续下载并分析该数据包。');
  }
  lines.push('', buildConclusion(workflowState, result?.packetAnalyses, result));
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
  lines.push(...buildThresholdEvaluationLines(triggerMetrics));
  return lines;
}

function buildThresholdEvaluationLines(triggerMetrics = {}) {
  const names = toStringArray(triggerMetrics?.names);
  const values = toArray(triggerMetrics?.values);
  const units = toStringArray(triggerMetrics?.units);
  const condition = sanitizeText(triggerMetrics?.condition || '');
  if (!condition || names.length === 0 || values.length === 0) return [];

  const value = Number(values[0]);
  if (!Number.isFinite(value)) return [];
  const rules = parseThresholdRules(condition);
  if (rules.length === 0) return ['- 触发判定：条件未包含可计算的数值阈值，无法计算超阈值差值。'];

  const matched = rules.find((rule) => evaluateThreshold(value, rule.operator, rule.threshold));
  if (!matched) return ['- 触发判定：实际值未命中已解析的阈值条件，请核对告警规则与指标值。'];

  const unit = sanitizeText(units[0] || '');
  const delta = value - matched.threshold;
  const deltaText = formatNumber(Math.abs(delta));
  const level = sanitizeText(matched.level || triggerMetrics?.severity || '当前规则');
  const unitText = unit ? ` ${unit}` : '';
  const comparison = `${formatNumber(value)}${unitText} ${matched.operator} ${formatNumber(matched.threshold)}${unitText}`;
  const relation = delta >= 0
    ? `超过 ${deltaText}${unitText}`
    : `低于 ${deltaText}${unitText}`;
  return [`- 触发判定：${comparison}，${relation}，命中阈值：${level}`];
}

function parseThresholdRules(condition = '') {
  const rules = [];
  const pattern = /(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)(?:\s*(?:则为|为|->|→)\s*([A-Za-z][A-Za-z0-9_-]*|[\u4e00-\u9fff]{1,12}))?/g;
  let match;
  while ((match = pattern.exec(String(condition))) !== null) {
    rules.push({
      operator: match[1],
      threshold: Number(match[2]),
      level: String(match[3] || '').trim()
    });
  }
  return rules.filter((rule) => Number.isFinite(rule.threshold));
}

function evaluateThreshold(value, operator, threshold) {
  if (operator === '>') return value > threshold;
  if (operator === '>=') return value >= threshold;
  if (operator === '<') return value < threshold;
  if (operator === '<=') return value <= threshold;
  return value === threshold;
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

function hasAlertTriggerMetrics(result = {}) {
  const triggerMetrics = result?.triggerMetrics;
  if (toStringArray(triggerMetrics?.names).length > 0 || toArray(triggerMetrics?.values).length > 0) {
    return true;
  }
  const items = Array.isArray(result?.packetAnalyses) ? result.packetAnalyses : [];
  return items.some((item) => {
    const evidence = extractAlertEvidence(item);
    return toStringArray(evidence?.metricLabels).length > 0
      || toStringArray(evidence?.evidenceChecks).length > 0;
  });
}

function buildFocusedPacketAnalysisLines(result = {}) {
  const items = Array.isArray(result?.packetAnalyses) ? result.packetAnalyses : [];
  if (items.length === 0) return ['- 当前没有可展示的候选数据包分析结果。'];

  const lines = ['专项分析画像：按告警触发指标逐项核对数据包证据。'];
  for (const [index, item] of items.slice(0, 10).entries()) {
    const rank = Number(item?.rank) || index + 1;
    const endpoint = formatCandidate(item);
    const status = item?.ok ? '成功' : '失败';
    lines.push(`- 候选 ${rank}${endpoint ? `（${endpoint}）` : ''}：${status}`);
    if (!item?.ok) {
      const message = sanitizeText(item?.error?.message || item?.result?.error?.message || '');
      lines.push(`  - 专项证据状态：${message ? `未形成（${message}）` : '未形成，证据不足'}`);
      continue;
    }

    const evidence = extractAlertEvidence(item);
    const profile = resolveAlertProfile(result, evidence);
    const evidenceChecks = resolveEvidenceChecks(result, evidence, profile.id);
    lines.push(`  - 分析画像：${profile.label}`);
    lines.push(`  - 专项证据总状态：${formatEvidenceStatus(resolveRenderedEvidenceStatus(evidence, evidenceChecks))}`);
    for (const check of evidenceChecks) {
      lines.push(`  - ${formatEvidenceCheck(check, evidence, item, result)}`);
    }
    const observations = collectSafeHighlights(item).filter(isAlertEvidenceObservation);
    if (observations.length > 0) {
      lines.push(`  - 专项观察：${observations.slice(0, 3).join('；')}`);
    }
    lines.push(`  - 专项结论：${buildCandidateFocusedConclusion(evidence, item, result)}`);
  }
  const comparisonLines = buildAlertMetricComparisonLines(result);
  if (comparisonLines.length > 0) {
    lines.push('', ...comparisonLines);
  }
  return lines;
}

function extractAlertEvidence(item = {}) {
  const candidates = [
    item?.result?.analysis?.alertEvidence,
    item?.result?.narrationInput?.analysis?.alertEvidence,
    item?.result?.alertEvidence,
    item?.alertEvidence
  ];
  return candidates.find((value) => value && typeof value === 'object') || {};
}

function resolveAlertProfile(result = {}, evidence = {}) {
  const profileId = String(
    evidence?.profileId
      || result?.triggerMetrics?.profileId
      || inferProfileId(result?.triggerMetrics)
      || ''
  ).trim();
  const label = profileId === 'server_user_experience_time'
    ? '服务端用户体验时间专项分析'
    : profileId === 'network_user_experience_time'
      ? '网络侧用户体验时间专项分析'
      : profileId === 'page_load_time'
        ? '页面加载时间专项分析'
        : profileId === 'http_error_rate'
          ? 'HTTP 错误专项分析'
          : profileId === 'tcp_retransmission'
            ? 'TCP 重传专项分析'
            : profileId === 'network_latency'
              ? '网络时延专项分析'
              : '告警指标专项分析';
  return { id: profileId, label };
}

function resolveEvidenceChecks(result = {}, evidence = {}, profileId = '') {
  const explicit = toStringArray(evidence?.evidenceChecks);
  if (explicit.length > 0) return explicit;
  const triggerChecks = toStringArray(result?.triggerMetrics?.evidenceChecks);
  if (triggerChecks.length > 0) return triggerChecks;
  return PROFILE_EVIDENCE_CHECKS[profileId] || [];
}

function inferProfileId(triggerMetrics = {}) {
  const text = [
    ...toStringArray(triggerMetrics?.names),
    ...toStringArray(triggerMetrics?.codes)
  ].join(' ');
  if (/用户体验时间.*服务器|服务器.*用户体验时间|server.*user.*experience|servbusytime/i.test(text)) {
    return 'server_user_experience_time';
  }
  if (/用户体验时间.*网络|网络.*用户体验时间|network.*user.*experience|netbusytime/i.test(text)) {
    return 'network_user_experience_time';
  }
  if (/页面加载时间|页面.*耗时|page.*load|pagetime/i.test(text)) return 'page_load_time';
  if (/http.*(?:4\d\d|5\d\d|错误|异常)|4xx|5xx|pghttp(?:400|500)/i.test(text)) return 'http_error_rate';
  if (/tcp.*重传|重传率|retransmission|rdti/i.test(text)) return 'tcp_retransmission';
  if (/网络.*(?:时延|延迟)|(?:时延|延迟).*网络|rtti|rtt/i.test(text)) return 'network_latency';
  return '';
}

function formatEvidenceStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  const labels = {
    SUPPORTED: '已捕获',
    PARTIAL: '部分捕获',
    NOT_CAPTURED: '未捕获',
    UNSUPPORTED_PROFILE: '不支持该画像'
  };
  return labels[normalized] || '证据不足';
}

function resolveRenderedEvidenceStatus(evidence = {}, checks = []) {
  const normalized = String(evidence?.status || '').trim().toUpperCase();
  if (normalized === 'UNSUPPORTED_PROFILE' || normalized === 'NOT_CAPTURED') return normalized;

  const missing = checks.some((check) => {
    const rows = rowsForStatusCheck(check, evidence);
    return rows !== null && rows.length === 0;
  });
  if (missing) return 'PARTIAL';
  return normalized || 'PARTIAL';
}

function rowsForStatusCheck(check, evidence = {}) {
  if (check === 'server_response_wait' || check === 'http_response_time') {
    return asRows(evidence?.httpTimingRows);
  }
  if (check === 'tcp_rtt') return asRows(evidence?.rttRows);
  if (check === 'tcp_retransmission') return asRows(evidence?.retransmissionRows);
  if (check === 'alert_time_correlation') {
    return [
      ...asRows(evidence?.retransmissionRows),
      ...asRows(evidence?.rttRows),
      ...asRows(evidence?.httpTimingRows)
    ];
  }
  if (check === 'http_status_code' || check === 'http_request_uri' || check === 'server_response') {
    return asRows(evidence?.httpTimingRows);
  }
  if (check === 'tcp_stream') {
    return [...asRows(evidence?.rttRows), ...asRows(evidence?.retransmissionRows)];
  }
  // The packet executor does not currently expose DNS/TCP-connect/TLS rows;
  // leave those checks to its explicit status instead of guessing from []
  // and falsely downgrading an otherwise valid page-load result.
  return null;
}

function isAlertEvidenceObservation(text) {
  return /服务端响应|响应等待|HTTP|RTT|时延|延迟|重传|丢包|错误|失败|超时|连接/i.test(String(text || ''));
}

function formatEvidenceCheck(check, evidence = {}, item = {}, result = {}) {
  const label = ALERT_EVIDENCE_LABELS[check] || check;
  const rows = rowsForEvidenceCheck(check, evidence);
  if (check === 'alert_time_correlation') {
    return `${label}：${formatTimeCorrelation(rows, item, result)}`;
  }
  if (rows.length > 0) {
    let detail;
    if (check === 'server_response_wait') {
      detail = formatTimingEvidenceDetail(evidence, 'httpTimingRows', 'HTTP 时序');
    } else if (check === 'http_response_time') {
      detail = formatTimingEvidenceDetail(evidence, 'httpTimingRows');
    } else if (check === 'tcp_rtt') {
      detail = formatTimingEvidenceDetail(evidence, 'rttRows');
    } else if (check === 'tcp_retransmission') {
      detail = formatRowCountDetail(rows.length, evidence?.retransmissionTruncated);
    } else {
      detail = `已捕获（${rows.length} 条）`;
    }
    return `${label}：${detail}`;
  }
  if (check === 'server_response_wait' || check === 'http_response_time') {
    return `${label}：未捕获（无可核对的 HTTP 时序）`;
  }
  return `${label}：未捕获`;
}

function formatTimingEvidenceDetail(evidence = {}, field, prefix = '') {
  const rows = asRows(evidence?.[field]);
  const stats = summarizeTimingRows(rows, field === 'rttRows' ? 'rtt' : 'http');
  const countText = formatRowCount(stats.rowCount, evidence?.[`${field}Truncated`]);
  const prefixText = prefix ? `${prefix} ` : '';
  if (stats.valueCount === 0) {
    return `已捕获（${prefixText}${countText}；耗时字段不可解析）`;
  }
  return `已捕获（${prefixText}${countText}；平均 ${formatNumber(stats.averageMs)} 毫秒，最大 ${formatNumber(stats.maxMs)} 毫秒）`;
}

function formatRowCountDetail(count, truncated = false) {
  return `已捕获（${formatRowCount(count, truncated)}）`;
}

function formatRowCount(count, truncated = false) {
  return truncated ? `至少 ${count} 条，已达到展示上限` : `${count} 条`;
}

function rowsForEvidenceCheck(check, evidence = {}) {
  if (check === 'tcp_retransmission') return asRows(evidence?.retransmissionRows);
  if (check === 'tcp_rtt') return asRows(evidence?.rttRows);
  if (check === 'server_response_wait' || check === 'http_response_time') return asRows(evidence?.httpTimingRows);
  if (check === 'http_status_code' || check === 'http_request_uri' || check === 'server_response') {
    return asRows(evidence?.httpTimingRows);
  }
  if (check === 'tcp_stream') return [...asRows(evidence?.rttRows), ...asRows(evidence?.retransmissionRows)];
  if (check === 'alert_time_correlation') {
    return [
      ...asRows(evidence?.retransmissionRows),
      ...asRows(evidence?.rttRows),
      ...asRows(evidence?.httpTimingRows)
    ];
  }
  return [];
}

function formatTimeCorrelation(rows, item = {}, result = {}) {
  if (rows.length === 0) return '未捕获';
  const range = item?.query?.criteria || result?.timeRange || {};
  const start = normalizeUnixSeconds(range.start);
  const end = normalizeUnixSeconds(range.end);
  if (!start || !end) return '证据不足（缺少告警时间窗口）';
  const timestamps = rows.map(extractRowTimestamp).filter(Number.isFinite);
  if (timestamps.length === 0) return '证据不足（抓包时间戳不可解析）';
  const inside = timestamps.filter((timestamp) => timestamp >= start && timestamp <= end).length;
  if (inside > 0) return `已关联（${inside} 条在告警窗口内）`;
  return '未关联（捕获记录均在告警窗口外）';
}

function extractRowTimestamp(row) {
  if (row && typeof row === 'object') {
    return Number(row.timestamp || row.time || row.frameTime || row.frame_time_epoch);
  }
  const first = String(row || '').split('|')[0].trim();
  return Number(first);
}

function asRows(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && String(item).trim()) : [];
}

function buildCandidateFocusedConclusion(evidence = {}, item = {}, result = {}) {
  const retransmissions = asRows(evidence?.retransmissionRows).length;
  const rtts = asRows(evidence?.rttRows).length;
  const httpTimings = asRows(evidence?.httpTimingRows).length;
  const correlation = formatTimeCorrelation(
    [...asRows(evidence?.retransmissionRows), ...asRows(evidence?.rttRows), ...asRows(evidence?.httpTimingRows)],
    item,
    result
  );
  const findings = [];
  if (httpTimings > 0) findings.push(`HTTP 时序 ${httpTimings} 条，可核对服务端响应等待和 HTTP 响应耗时`);
  if (rtts > 0) findings.push(`TCP RTT ${rtts} 条`);
  if (retransmissions > 0) findings.push(`TCP 重传 ${retransmissions} 条`);
  if (findings.length === 0) {
    return '未捕获可用于解释该告警指标的专项证据，无法据此判断触发原因。';
  }
  const quantitative = buildCandidateQuantitativeConclusion(evidence, result);
  const findingText = quantitative ? `${quantitative}；` : `已捕获 ${findings.join('、')}；`;
  return `${findingText}告警时间相关性为${correlation}。该结果用于确定重点排查对象，不能仅凭单一抓包字段直接认定根因。`;
}

function buildCandidateQuantitativeConclusion(evidence = {}, result = {}) {
  const trigger = getPrimaryDurationTrigger(result);
  if (!trigger) return '';
  const parts = [];
  const http = summarizeTimingRows(asRows(evidence?.httpTimingRows), 'http');
  const rtt = summarizeTimingRows(asRows(evidence?.rttRows), 'rtt');
  if (http.valueCount > 0) {
    const relation = http.maxMs >= trigger.value
      ? `高于告警触发值 ${formatNumber(trigger.value)} 毫秒，支持该候选作为重点排查对象`
      : `低于告警触发值 ${formatNumber(trigger.value)} 毫秒，当前 HTTP 证据不足以单独解释`;
    parts.push(`HTTP 响应耗时平均 ${formatNumber(http.averageMs)} 毫秒、最大 ${formatNumber(http.maxMs)} 毫秒（${relation}）`);
  }
  if (rtt.valueCount > 0) {
    parts.push(`TCP RTT 平均 ${formatNumber(rtt.averageMs)} 毫秒、最大 ${formatNumber(rtt.maxMs)} 毫秒`);
  }
  if (asRows(evidence?.retransmissionRows).length > 0) {
    parts.push(`TCP 重传 ${formatRowCount(asRows(evidence.retransmissionRows).length, evidence?.retransmissionTruncated)}`);
  }
  return parts.join('；');
}

function buildAlertMetricComparisonLines(result = {}) {
  const trigger = getPrimaryDurationTrigger(result);
  if (!trigger) return [];
  const items = Array.isArray(result?.packetAnalyses) ? result.packetAnalyses : [];
  const lines = [`告警指标对照：告警触发值 ${formatNumber(trigger.value)} ${trigger.unit}`];
  for (const [index, item] of items.slice(0, 10).entries()) {
    const rank = Number(item?.rank) || index + 1;
    const evidence = extractAlertEvidence(item);
    const http = summarizeTimingRows(asRows(evidence?.httpTimingRows), 'http');
    const rtt = summarizeTimingRows(asRows(evidence?.rttRows), 'rtt');
    const parts = [];
    if (http.valueCount > 0) {
      const relation = http.maxMs >= trigger.value
        ? '高于触发值，支持该候选作为重点排查对象'
        : '低于触发值，当前 HTTP 证据不足以单独解释';
      parts.push(`HTTP 响应耗时平均 ${formatNumber(http.averageMs)} 毫秒，最大 ${formatNumber(http.maxMs)} 毫秒，${relation}`);
    } else {
      parts.push('HTTP 响应耗时无可解析数值');
    }
    if (rtt.valueCount > 0) {
      parts.push(`TCP RTT 平均 ${formatNumber(rtt.averageMs)} 毫秒，最大 ${formatNumber(rtt.maxMs)} 毫秒`);
    }
    if (asRows(evidence?.retransmissionRows).length > 0) {
      parts.push(`TCP 重传 ${formatRowCount(asRows(evidence.retransmissionRows).length, evidence?.retransmissionTruncated)}`);
    }
    lines.push(`- 候选 ${rank}：${parts.join('；')}。`);
  }
  return lines;
}

function getPrimaryDurationTrigger(result = {}) {
  const profile = resolveAlertProfile(result, {});
  if (profile.id !== 'server_user_experience_time') return null;
  const values = toArray(result?.triggerMetrics?.values).map(Number).filter(Number.isFinite);
  if (values.length === 0) return null;
  const units = toStringArray(result?.triggerMetrics?.units);
  return { value: values[0], unit: units[0] || '毫秒' };
}

function summarizeTimingRows(rows = [], kind = 'http') {
  const source = asRows(rows);
  const valueIndex = kind === 'rtt' ? 4 : 7;
  const values = source
    .map((row) => extractEvidenceNumericValue(row, valueIndex, kind))
    .map(normalizeTimingMilliseconds)
    .filter(Number.isFinite);
  return {
    rowCount: source.length,
    valueCount: values.length,
    averageMs: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    maxMs: values.length > 0 ? Math.max(...values) : null,
    minMs: values.length > 0 ? Math.min(...values) : null,
  };
}

function extractEvidenceNumericValue(row, index, kind) {
  if (row && typeof row === 'object') {
    const keys = kind === 'rtt'
      ? ['tcp.analysis.ack_rtt', 'ackRtt', 'rtt', 'value']
      : ['http.time', 'httpTime', 'responseTime', 'value'];
    for (const key of keys) {
      if (row[key] != null && row[key] !== '') return Number(row[key]);
    }
    return NaN;
  }
  const fields = String(row || '').split('|');
  return Number(fields[index]);
}

function normalizeTimingMilliseconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric * 1000 : NaN;
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
    .filter((text) => !/\b(?:eventId|start|end)\s*[:=]\s*\d{1,20}/i.test(text))
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

function buildConclusion(workflowState, packetAnalyses = [], result = {}) {
  const items = Array.isArray(packetAnalyses) ? packetAnalyses : [];
  const successCount = items.filter((item) => item?.ok).length;
  if (workflowState === 'COMPLETED') {
    if (hasAlertTriggerMetrics(result)) {
      const metricName = toStringArray(result?.triggerMetrics?.names)[0] || '告警触发指标';
      return `结论：已完成 ${successCount} 个候选会话的${metricName}专项证据核对；仅将标记为“已捕获”且与告警窗口关联的证据作为依据，未捕获或证据不足项不能认定为告警根因。`;
    }
    return `结论：已完成 ${successCount} 个候选会话的数据包分析，请以上述数据包证据作为告警原因判断依据。`;
  }
  if (workflowState === 'PARTIAL_PACKET_ANALYSIS') {
    return `结论：已获得 ${successCount} 个候选会话的有效证据，但仍有候选分析失败；当前结论仅覆盖成功部分。`;
  }
  if (workflowState === 'DOWNLOAD_CONFIRMATION_REQUIRED') {
    return '结论：数据包预览已完成，但下载需要用户确认，当前尚未形成数据包分析证据。';
  }
  return '结论：本轮未形成完整的数据包证据，不能据此推测告警根因。';
}

function workflowStateLabel(state) {
  const labels = {
    COMPLETED: '已完成',
    PARTIAL_PACKET_ANALYSIS: '部分完成',
    DOWNLOAD_CONFIRMATION_REQUIRED: '等待下载确认',
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

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '未知');
  return String(Number(numeric.toFixed(4)));
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
