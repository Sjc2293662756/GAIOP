'use strict';

const {
  isDomainIntentClassification
} = require('./DomainIntentClassificationAdapter');

const TURN_INTENT_HANDLING = Object.freeze({
  DOMAIN_ORCHESTRATED: 'domain_orchestrated',
  MODEL_OWNED: 'model_owned',
  REJECT: 'reject',
  SINGLE_TOOL: 'single_tool'
});

const TURN_INTENT_TYPES = Object.freeze({
  ALERT: 'alert',
  ALERT_PACKET: 'alert_packet',
  CONTEXT_FOLLOWUP: 'context_followup',
  FAULT_DIAGNOSIS: 'fault_diagnosis',
  INSPECTION: 'inspection',
  MODEL_OWNED: 'model_owned',
  PACKET: 'packet',
  QUERY: 'query',
  REJECTED: 'rejected',
  REPORT_EXPORT: 'report_export',
  REPORT_WORKFLOW: 'report_workflow',
  SUMMARY: 'summary'
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function freezeIntent(value = {}) {
  return Object.freeze({ ...value });
}

function singleTool(intentType, expectedTool, workflow = {}) {
  return freezeIntent({
    intentType,
    handling: TURN_INTENT_HANDLING.SINGLE_TOOL,
    expectedTool,
    workflowType: normalizeText(workflow?.workflowType) || null,
    operation: normalizeText(workflow?.operation) || null,
    targetObjectType: normalizeText(workflow?.targetObjectType) || null
  });
}

function domainOrchestrated(intentType, workflow = {}) {
  return freezeIntent({
    intentType,
    handling: TURN_INTENT_HANDLING.DOMAIN_ORCHESTRATED,
    expectedTool: null,
    workflowType: normalizeText(workflow?.workflowType) || null,
    operation: normalizeText(workflow?.operation) || null,
    targetObjectType: normalizeText(workflow?.targetObjectType) || null
  });
}

function resolveTurnIntent({ route = '', classification = null } = {}) {
  const normalizedRoute = normalizeText(route);
  if (normalizedRoute === 'explicit_out_of_scope') {
    return freezeIntent({
      intentType: TURN_INTENT_TYPES.REJECTED,
      handling: TURN_INTENT_HANDLING.REJECT,
      expectedTool: null
    });
  }
  if (normalizedRoute !== 'napm_candidate') {
    return freezeIntent({
      intentType: TURN_INTENT_TYPES.MODEL_OWNED,
      handling: TURN_INTENT_HANDLING.MODEL_OWNED,
      expectedTool: null
    });
  }

  if (!isDomainIntentClassification(classification)) {
    return freezeIntent({
      intentType: TURN_INTENT_TYPES.MODEL_OWNED,
      handling: TURN_INTENT_HANDLING.MODEL_OWNED,
      expectedTool: null
    });
  }

  const workflow = classification.workflow;
  const signals = classification.signals;

  if (signals?.alertPacket === true) {
    return singleTool(
      TURN_INTENT_TYPES.ALERT_PACKET,
      'napm-alert-packet-analysis',
      workflow
    );
  }
  if (signals?.alert === true) {
    return singleTool(TURN_INTENT_TYPES.ALERT, 'napm-alert-query', workflow);
  }
  if (signals?.packet === true) {
    return singleTool(TURN_INTENT_TYPES.PACKET, 'napm-packet-analysis', workflow);
  }

  const reportIntent = normalizeText(signals?.reportIntent);
  if (reportIntent === 'export') {
    return singleTool(TURN_INTENT_TYPES.REPORT_EXPORT, 'napm-report-export', workflow);
  }
  if (reportIntent === 'inspection') {
    return domainOrchestrated(TURN_INTENT_TYPES.INSPECTION, workflow);
  }
  if (reportIntent === 'summary') {
    return domainOrchestrated(TURN_INTENT_TYPES.SUMMARY, workflow);
  }
  if (reportIntent === 'mixed') {
    return domainOrchestrated(TURN_INTENT_TYPES.REPORT_WORKFLOW, workflow);
  }
  if (signals?.faultDiagnosis === true) {
    return singleTool(
      TURN_INTENT_TYPES.FAULT_DIAGNOSIS,
      'napm-fault-diagnosis',
      workflow
    );
  }
  if (signals?.contextContinuation === true) {
    return domainOrchestrated(TURN_INTENT_TYPES.CONTEXT_FOLLOWUP, workflow);
  }

  return singleTool(TURN_INTENT_TYPES.QUERY, 'napm-skill-query', workflow);
}

module.exports = {
  TURN_INTENT_HANDLING,
  TURN_INTENT_TYPES,
  resolveTurnIntent
};
