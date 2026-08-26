'use strict';

const AlertReferenceStore = require('./AlertReferenceStore');
const {
  buildAnalysisContext,
  normalizeTriggerMetrics,
} = require('../skills/openclaw-napm-alert-packet-analysis/services/AlertMetricProfileService');

const DEFAULT_PACKET_BUFFER_SECONDS = 120;

class AlertReferenceService {
  constructor(options = {}) {
    this.store = options.store || new AlertReferenceStore(options);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : AlertReferenceStore.DEFAULT_TTL_MS;
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : AlertReferenceStore.createReferenceId;
    this.packetBufferSeconds = Number(options.packetBufferSeconds) >= 0
      ? Number(options.packetBufferSeconds)
      : DEFAULT_PACKET_BUFFER_SECONDS;
  }

  createOrReuse(alert = {}) {
    const eventId = normalize(alert.extra?.elogid || alert.eventId || alert.detail?.eventId);
    const alertId = normalize(alert.alertId || alert.detail?.alertId);
    const start = normalizeTimestamp(alert.extra?.starttime || alert.detail?.start || alert.start);
    const end = normalizeTimestamp(alert.extra?.endtime || alert.detail?.end || alert.end);
    if (!eventId || !start) {
      return { ok: false, errorCode: 'ALERT_REFERENCE_INPUT_INCOMPLETE', message: '告警缺少可用于定位的事件 ID 或开始时间。' };
    }

    const existing = this.store.findByEventId(eventId);
    const referenceId = existing?.ok ? existing.referenceId : this.idFactory();
    const triggerMetrics = normalizeAlertMetrics(alert);
    const analysisContext = buildAnalysisContext({
      names: triggerMetrics.map((item) => item.label || item.name),
      codes: triggerMetrics.map((item) => item.code || item.label || item.name),
      values: triggerMetrics.map((item) => item.value),
      units: triggerMetrics.map((item) => item.unit),
      condition: triggerMetrics[0]?.condition || normalize(alert.extra?.condition || alert.detail?.condition),
      severity: normalize(alert.alertSeverity || alert.severity || alert.detail?.severityLabel),
    });

    const packetWindow = buildPacketWindow(start, end, this.packetBufferSeconds);
    const now = this.now();
    const record = {
      schemaVersion: 1,
      referenceId,
      status: existing?.ok ? (existing.status || 'PUSHED') : 'PUSHED',
      source: 'syslog',
      idempotencyKey: `event:${eventId}`,
      alert: {
        alertId: alertId || null,
        eventId,
        name: normalize(alert.alertName || alert.name || alert.detail?.name),
        category: normalize(alert.category || alert.detail?.category),
        categoryLabel: normalize(alert.categoryLabel || alert.detail?.categoryLabel),
        object: normalize(alert.extra?.canongrouppath || alert.detail?.objectName || alert.detail?.group || alert.group),
        severity: normalize(alert.alertSeverity || alert.severity || alert.detail?.severityLabel),
        start,
        end: end > start ? end : null,
        linkType: numberOrNull(alert.detail?.linkType ?? alert.linkType),
        categoryType: numberOrNull(alert.detail?.categoryType ?? alert.categoryType),
      },
      triggerMetrics,
      analysis: {
        profileId: analysisContext.profileId,
        profileVersion: analysisContext.profileVersion,
        focus: analysisContext.instruction || null,
        evidenceChecks: analysisContext.evidenceChecks || [],
        supported: analysisContext.supported !== false,
      },
      packet: {
        bufferSeconds: this.packetBufferSeconds,
        window: packetWindow,
        candidates: existing?.packet?.candidates || [],
      },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    };

    const stored = this.store.put(record);
    if (!stored.ok) return stored;
    return { ok: true, referenceId, record: stored, reused: Boolean(existing?.ok) };
  }

  get(referenceId) {
    return this.store.get(referenceId);
  }

  getAnalysisInput(referenceId, candidateId = '') {
    const result = this.store.get(referenceId);
    if (!result.ok) return result;
    const record = result;
    const candidate = candidateId
      ? (record.packet?.candidates || []).find((item) => item.candidateId === candidateId)
      : null;
    if (candidateId && !candidate) {
      return { ok: false, errorCode: 'ALERT_PACKET_CANDIDATE_NOT_FOUND', message: '未找到指定的数据包候选。' };
    }
    const trigger = metricsToWorkflowInput(record.triggerMetrics, record.analysis);
    const window = candidate?.packetWindow || record.packet?.window;
    return {
      ok: true,
      referenceId: record.referenceId,
      candidateId: candidate?.candidateId || null,
      eventId: record.alert.eventId,
      start: window?.start || null,
      end: window?.end || null,
      triggerMetrics: trigger,
      packetCandidate: candidate?.packetQuery || null,
      record,
    };
  }

  saveCandidates(referenceId, candidates = []) {
    const recordResult = this.store.get(referenceId);
    if (!recordResult.ok) return recordResult;
    const normalized = candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId || `${referenceId}-P${candidate.rank || index + 1}`,
      rank: candidate.rank || index + 1,
      ip: candidate.ip || null,
      ips: Array.isArray(candidate.ips) ? candidate.ips : [],
      ipPair: candidate.ipPair || null,
      metricValue: candidate.metricValue || null,
      packetWindow: {
        start: candidate.packetWindow?.start || candidate.suggestedPacketQuery?.criteria?.start || null,
        end: candidate.packetWindow?.end || candidate.suggestedPacketQuery?.criteria?.end || null,
      },
      packetQuery: candidate.packetQuery || candidate.suggestedPacketQuery || null,
      status: candidate.status || 'DISCOVERED',
    }));
    return this.store.update(referenceId, {
      status: normalized.length === 1 ? 'CANDIDATE_SELECTED' : 'CANDIDATES_READY',
      packet: {
        ...(recordResult.packet || {}),
        candidates: normalized,
      },
    });
  }

  markCandidateSelected(referenceId, candidateId) {
    const recordResult = this.store.get(referenceId);
    if (!recordResult.ok) return recordResult;
    const candidates = Array.isArray(recordResult.packet?.candidates) ? recordResult.packet.candidates : [];
    if (!candidates.some((item) => item.candidateId === candidateId)) {
      return { ok: false, errorCode: 'ALERT_PACKET_CANDIDATE_NOT_FOUND', message: '未找到指定的数据包候选。' };
    }
    return this.store.update(referenceId, {
      status: 'CANDIDATE_SELECTED',
      packet: {
        ...(recordResult.packet || {}),
        candidates: candidates.map((item) => ({
          ...item,
          status: item.candidateId === candidateId ? 'SELECTED' : item.status,
        })),
      },
    });
  }
}

function normalizeAlertMetrics(alert = {}) {
  const source = Array.isArray(alert.metrics) && alert.metrics.length > 0
    ? alert.metrics
    : (Array.isArray(alert.detail?.metrics) ? alert.detail.metrics : []);
  const condition = normalize(alert.extra?.condition || alert.detail?.condition || alert.detail?.triggerCondition);
  const severity = normalize(alert.alertSeverity || alert.severity || alert.detail?.severityLabel);
  return source.map((metric) => ({
    code: normalize(metric.code || metric.id || metric.metric || metric.name),
    name: normalize(metric.name || metric.label || metric.code),
    label: normalize(metric.label || metric.name || metric.code),
    value: numberOrString(metric.value),
    unit: normalize(metric.unit || metric.units),
    condition,
    severity,
  })).filter((metric) => metric.name || metric.code);
}

function metricsToWorkflowInput(metrics = [], analysis = {}) {
  const normalized = Array.isArray(metrics) ? metrics : [];
  return {
    names: normalized.map((item) => item.label || item.name).filter(Boolean),
    codes: normalized.map((item) => item.code || item.label || item.name).filter(Boolean),
    values: normalized.map((item) => item.value).filter((value) => value !== null && value !== undefined && value !== ''),
    units: normalized.map((item) => item.unit).filter(Boolean),
    condition: normalized[0]?.condition || '',
    severity: normalized[0]?.severity || '',
    profileId: analysis.profileId || '',
    profileVersion: analysis.profileVersion || null,
  };
}

function buildPacketWindow(start, end, bufferSeconds) {
  const safeStart = Math.max(0, Number(start) - Number(bufferSeconds || 0));
  const safeEnd = Number(end) > Number(start)
    ? Number(end) + Number(bufferSeconds || 0)
    : Number(start) + Number(bufferSeconds || 0);
  return { start: safeStart, end: safeEnd };
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrString(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value).trim();
}

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

module.exports = AlertReferenceService;
module.exports.normalizeAlertMetrics = normalizeAlertMetrics;
module.exports.buildPacketWindow = buildPacketWindow;
module.exports.metricsToWorkflowInput = metricsToWorkflowInput;
