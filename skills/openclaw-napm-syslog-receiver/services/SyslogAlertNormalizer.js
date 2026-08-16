'use strict';

function toUnixSeconds(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toMillis(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

class SyslogAlertNormalizer {
  normalize(alert, receivedAt = Date.now()) {
    const start = toUnixSeconds(alert.extra?.starttime);
    const end = toUnixSeconds(alert.extra?.endtime);
    const metrics = Array.isArray(alert.metrics) ? alert.metrics.map((metric) => ({
      name: String(metric.name || ''),
      value: String(metric.value || ''),
      unit: String(metric.unit || ''),
    })) : [];
    const recovered = metrics.length > 0 && metrics.every((metric) => metric.value === 'N/D');
    return {
      eventId: alert.extra?.elogid || null,
      ruleId: alert.alertId ? String(alert.alertId) : null,
      occurredAt: toMillis(alert.timestamp),
      sourceIp: alert.fromHost || null,
      category: alert.category || 'unknown',
      severity: alert.alertSeverity || alert.severity || '未知',
      name: alert.alertName || '未命名告警',
      description: alert.extra?.description || alert.extra?.desc || null,
      groupPath: alert.extra?.canongrouppath || null,
      start,
      end,
      metrics,
      triggerCondition: alert.extra?.condition || null,
      status: recovered ? 'recovered' : 'active',
      receivedAt,
    };
  }
}

module.exports = SyslogAlertNormalizer;
