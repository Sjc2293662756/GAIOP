'use strict';

const {
  TURN_INTENT_HANDLING,
  TURN_INTENT_TYPES,
  resolveTurnIntent
} = require('../plugin/TurnIntentResolver');

function napmIntent(signals = {}, overrides = {}) {
  return resolveTurnIntent({
    route: 'napm_candidate',
    workflow: { workflowType: 'metric_topn' },
    signals,
    ...overrides
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
    expect(resolveTurnIntent({ route: 'model_owned', signals: { alert: true } })).toMatchObject({
      intentType: TURN_INTENT_TYPES.MODEL_OWNED,
      expectedTool: null,
      handling: TURN_INTENT_HANDLING.MODEL_OWNED
    });
    expect(resolveTurnIntent({
      route: 'explicit_out_of_scope',
      signals: { packet: true }
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
});
