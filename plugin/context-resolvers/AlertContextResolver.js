'use strict';

const { REFERENCE_ACTIONS } = require('../ReferenceSelectionParser');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

class AlertContextResolver {
  getAdmissionCandidates({ record = null } = {}) {
    if (
      !isPlainObject(record)
      || record.sourceTool !== 'napm-alert-query'
      || record.result?.ok !== true
    ) {
      return [];
    }
    const events = Array.isArray(record.result.events) ? record.result.events : [];
    const items = events.map((event, index) => {
      const eventId = normalizeText(event?.id || event?.eventId);
      if (!eventId) return null;
      return {
        ordinal: index + 1,
        eventId,
        start: normalizeSeconds(event?.start || record.result?.timeRange?.start),
        end: normalizeSeconds(event?.end || record.result?.timeRange?.end),
        label: normalizeText(event?.name || event?.group || event?.categoryLabel) || null
      };
    }).filter(Boolean);
    if (items.length === 0) return [];

    return [{
      domain: 'ALERT',
      artifactId: `alert-result:${normalizeText(record.turnId) || 'unknown'}`,
      artifactType: 'authoritative_alert_result',
      objectType: 'AlertEvent',
      supportedActions: [REFERENCE_ACTIONS.DETAIL],
      route: 'napm_candidate',
      expectedTool: 'napm-alert-query',
      workflow: 'alert_event_detail',
      updatedAt: Number(record.updatedAt) || 0,
      items
    }];
  }

  buildContinuationToolParams(decision = {}) {
    if (
      decision?.reasonCode !== 'AUTHORITATIVE_RESULT_FOLLOWUP'
      || decision?.sourceDomain !== 'ALERT'
      || decision?.selection?.action !== REFERENCE_ACTIONS.DETAIL
    ) {
      return null;
    }
    const eventId = normalizeText(decision?.selectedItem?.eventId);
    if (!eventId) return null;
    const start = normalizeSeconds(decision?.selectedItem?.start);
    const end = normalizeSeconds(decision?.selectedItem?.end);
    const criteria = {
      eventIds: [eventId],
      ...(start ? { start } : {}),
      ...(end && end > start ? { end } : {})
    };
    return {
      mode: 'detail',
      criteria,
      alertQuery: {
        mode: 'detail',
        criteria
      }
    };
  }
}

module.exports = AlertContextResolver;
