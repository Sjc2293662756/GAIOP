'use strict';

const {
  TURN_INTENT_HANDLING,
  TURN_INTENT_TYPES,
  resolveTurnIntent
} = require('../plugin/TurnIntentResolver');
const {
  CLASSIFICATION_SCHEMA_VERSION,
  CLASSIFICATION_SOURCE,
  createDomainIntentClassificationAdapter
} = require('../plugin/DomainIntentClassificationAdapter');

function napmIntent(signals = {}, overrides = {}) {
  const workflow = overrides.workflow || { workflowType: 'metric_topn' };
  const classification = createDomainIntentClassificationAdapter({
    isPlatformIdentityPrompt: () => false,
    isOverviewPrompt: () => false,
    isAlertEventPrompt: () => signals.alert === true,
    isAlertSkillMetaFollowUpPrompt: () => false,
    isMetricInventoryPrompt: () => false,
    isMetricInventoryDetailPrompt: () => false,
    inferMetricInventoryGroup: () => '',
    isNapmMetaFollowUpPrompt: () => false,
    isResultDeliveryFollowUpPrompt: () => false,
    classifyNapmWorkflow: () => workflow,
    isAlertPacketAnalysisPrompt: () => signals.alertPacket === true,
    isPacketCapturePrompt: () => signals.packet === true,
    isReportExportPrompt: () => signals.reportIntent === 'export',
    isReportWorkflowPrompt: () => false,
    isSystemDomainPrompt: () => true,
    isNapmRelatedPrompt: () => true,
    isContinuationPrompt: () => signals.contextContinuation === true,
    isOutOfScopeNapmRequest: () => false,
    classifyReportPrompt: () => signals.reportIntent || null,
    hasSpecificFaultDiagnosisTarget: () => signals.faultDiagnosis === true,
    isFaultDiagnosisPrompt: () => signals.faultDiagnosis === true
  }).classify({ prompt: 'opaque-domain-input' });

  return resolveTurnIntent({
    route: 'napm_candidate',
    classification
  });
}

describe('TurnIntentResolver', () => {
  test.each([
    [{ alertPacket: true, alert: true, packet: true }, 'alert_packet', 'napm-alert-packet-analysis'],
    [{ alert: true }, 'alert', 'napm-alert-query'],
    [{ packet: true }, 'packet', 'napm-packet-analysis'],
    [{ reportIntent: 'export' }, 'report_export', 'napm-report-export'],
    [{ faultDiagnosis: true }, 'fault_diagnosis', 'napm-fault-diagnosis'],
    [{}, 'query', 'napm-skill-query']
  ])('maps structured signals %j to %s', (signals, intentType, expectedTool) => {
    expect(napmIntent(signals)).toMatchObject({
      intentType,
      expectedTool,
      handling: TURN_INTENT_HANDLING.SINGLE_TOOL
    });
  });

  test('leaves an unresolved continuation to authoritative domain context', () => {
    expect(napmIntent({ contextContinuation: true }, {
      workflow: { workflowType: null }
    })).toMatchObject({
      intentType: TURN_INTENT_TYPES.CONTEXT_FOLLOWUP,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.DOMAIN_ORCHESTRATED
    });
  });

  test.each([
    ['inspection', TURN_INTENT_TYPES.INSPECTION],
    ['summary', TURN_INTENT_TYPES.SUMMARY],
    ['mixed', TURN_INTENT_TYPES.REPORT_WORKFLOW]
  ])('keeps %s reports domain-orchestrated instead of guessing one Tool', (reportIntent, intentType) => {
    expect(napmIntent({ reportIntent })).toMatchObject({
      intentType,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.DOMAIN_ORCHESTRATED
    });
  });

  test('does not select a NAPM Tool for model-owned or rejected routes', () => {
    expect(resolveTurnIntent({ route: 'model_owned' })).toMatchObject({
      intentType: TURN_INTENT_TYPES.MODEL_OWNED,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.MODEL_OWNED
    });
    expect(resolveTurnIntent({
      route: 'explicit_out_of_scope'
    })).toMatchObject({
      intentType: TURN_INTENT_TYPES.REJECTED,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.REJECT
    });
  });

  test('uses existing classifier output without inspecting the raw prompt', () => {
    const intent = napmIntent({}, {
      workflow: {
        workflowType: 'page_view_detail',
        operation: 'detail_list',
        targetObjectType: 'PageView'
      }
    });

    expect(intent).toMatchObject({
      intentType: TURN_INTENT_TYPES.QUERY,
      expectedTool: 'napm-skill-query',
      workflowType: 'page_view_detail',
      operation: 'detail_list',
      targetObjectType: 'PageView'
    });
    expect(Object.isFrozen(intent)).toBe(true);
  });

  test('does not trust ad-hoc signals outside the structured classification contract', () => {
    expect(resolveTurnIntent({
      route: 'napm_candidate',
      signals: { alert: true }
    })).toMatchObject({
      intentType: TURN_INTENT_TYPES.MODEL_OWNED,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.MODEL_OWNED
    });
  });

  test('does not trust a frozen classification that only copies schema and source fields', () => {
    const forgedClassification = Object.freeze({
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      source: CLASSIFICATION_SOURCE,
      workflow: Object.freeze({ workflowType: 'alert_query' }),
      signals: Object.freeze({ alert: true }),
      facts: Object.freeze({ baseNapmRelated: true })
    });

    expect(resolveTurnIntent({
      route: 'napm_candidate',
      classification: forgedClassification
    })).toMatchObject({
      intentType: TURN_INTENT_TYPES.MODEL_OWNED,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.MODEL_OWNED
    });
  });

});
