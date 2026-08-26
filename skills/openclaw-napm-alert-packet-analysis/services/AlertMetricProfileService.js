'use strict';

const PROFILES = Object.freeze({
  server_user_experience_time: Object.freeze({
    id: 'server_user_experience_time',
    version: 1,
    label: '服务端用户体验时间专项分析',
    matches: [/用户体验时间.*服务器/i, /服务器.*用户体验时间/i, /server.*user.*experience/i, /servbusytime/i],
    evidenceChecks: ['server_response_wait', 'http_response_time', 'tcp_rtt', 'tcp_retransmission', 'alert_time_correlation'],
    instruction: '重点解释服务端响应等待、HTTP响应耗时、TCP RTT和重传是否共同导致用户体验时间升高。',
  }),
  network_user_experience_time: Object.freeze({
    id: 'network_user_experience_time',
    version: 1,
    label: '网络侧用户体验时间专项分析',
    matches: [/用户体验时间.*网络/i, /网络.*用户体验时间/i, /network.*user.*experience/i, /netbusytime/i],
    evidenceChecks: ['tcp_rtt', 'tcp_retransmission', 'packet_loss', 'alert_time_correlation'],
    instruction: '重点解释网络往返时延、重传、丢包和异常会话是否导致用户体验时间升高。',
  }),
  page_load_time: Object.freeze({
    id: 'page_load_time',
    version: 1,
    label: '页面加载时间专项分析',
    matches: [/页面加载时间/i, /页面.*耗时/i, /page.*load/i, /pagetime/i],
    evidenceChecks: ['dns_time', 'tcp_connect_time', 'tls_handshake_time', 'http_response_time', 'alert_time_correlation'],
    instruction: '重点拆分 DNS、TCP、TLS、HTTP 和首字节阶段，解释页面加载时间异常来源。',
  }),
  http_error_rate: Object.freeze({
    id: 'http_error_rate',
    version: 1,
    label: 'HTTP 错误专项分析',
    matches: [/http.*(?:4\d\d|5\d\d|错误|异常)/i, /4xx/i, /5xx/i, /pghttp(?:400|500)/i],
    evidenceChecks: ['http_status_code', 'http_request_uri', 'server_response', 'alert_time_correlation'],
    instruction: '重点关联 HTTP 状态码、请求 URI、服务端响应和异常会话，解释错误告警的来源。',
  }),
  tcp_retransmission: Object.freeze({
    id: 'tcp_retransmission',
    version: 1,
    label: 'TCP 重传专项分析',
    matches: [/tcp.*重传/i, /重传率/i, /retransmission/i, /rdti/i],
    evidenceChecks: ['tcp_retransmission', 'tcp_stream', 'alert_time_correlation'],
    instruction: '重点定位重传发生的 TCP 会话、时间点和两端 IP，并判断其与告警窗口的关系。',
  }),
  network_latency: Object.freeze({
    id: 'network_latency',
    version: 1,
    label: '网络时延专项分析',
    matches: [/网络.*(?:时延|延迟)/i, /(?:时延|延迟).*网络/i, /rtti|rtt/i],
    evidenceChecks: ['tcp_rtt', 'endpoint_direction', 'alert_time_correlation'],
    instruction: '重点分析 RTT 分布、客户端到服务端方向和高延迟会话。',
  }),
});

function asArray(value) {
  return Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
}

function normalizeMetricText(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[\s（）()【】［］]/g, '')
    .toLowerCase();
}

function normalizeTriggerMetrics(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const names = asArray(source.names || source.name || source.metricLabels || source.metricLabel).map(String).map((item) => item.trim()).filter(Boolean);
  const codes = asArray(source.codes || source.code || source.metrics || source.metric).map(String).map((item) => item.trim()).filter(Boolean);
  const values = asArray(source.values ?? source.value).map(Number).filter(Number.isFinite);
  const units = asArray(source.units || source.unit).map(String).map((item) => item.trim()).filter(Boolean);
  return {
    names,
    codes,
    values,
    units,
    condition: String(source.condition || '').trim(),
    severity: String(source.severity || source.severityLabel || '').trim(),
    profileId: String(source.profileId || source.analysisProfile || '').trim(),
    profileVersion: Number(source.profileVersion || 0) || null,
  };
}

function resolveProfile(input = {}) {
  const metrics = normalizeTriggerMetrics(input);
  if (metrics.profileId && PROFILES[metrics.profileId]) return PROFILES[metrics.profileId];
  const texts = [...metrics.names, ...metrics.codes].map(normalizeMetricText).filter(Boolean);
  for (const profile of Object.values(PROFILES)) {
    if (profile.matches.some((pattern) => texts.some((text) => pattern.test(text)))) return profile;
  }
  return null;
}

function buildAnalysisContext(input = {}) {
  const metrics = normalizeTriggerMetrics(input);
  const profile = resolveProfile(metrics);
  const labels = metrics.names.length > 0 ? metrics.names : metrics.codes;
  if (!labels.length) {
    return {
      hasTriggerMetrics: false,
      profileId: null,
      profileVersion: null,
      note: '该告警未携带可识别的触发指标。',
    };
  }
  const profileId = profile?.id || 'unknown_alert_metric';
  const summary = labels.map((label, index) => `${label}=${metrics.values[index] ?? '?'}${metrics.units[index] || ''}`).join('、');
  return {
    hasTriggerMetrics: true,
    profileId,
    profileVersion: profile?.version || metrics.profileVersion || 1,
    metrics: metrics.codes.length > 0 ? metrics.codes : labels,
    metricLabels: labels,
    values: metrics.values,
    units: metrics.units,
    condition: metrics.condition || null,
    severity: metrics.severity || null,
    summary,
    evidenceChecks: profile?.evidenceChecks || [],
    instruction: profile?.instruction
      || `数据包分析必须围绕 ${labels.join('、')} 展开，并明确说明当前数据包证据是否支持该指标异常。`,
    supported: Boolean(profile),
  };
}

function getProfile(profileId) {
  return PROFILES[String(profileId || '').trim()] || null;
}

module.exports = {
  PROFILES,
  normalizeMetricText,
  normalizeTriggerMetrics,
  resolveProfile,
  buildAnalysisContext,
  getProfile,
};
