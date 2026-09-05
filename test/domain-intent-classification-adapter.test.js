'use strict';

const {
  CLASSIFICATION_SCHEMA_VERSION,
  createDomainIntentClassificationAdapter
} = require('../plugin/DomainIntentClassificationAdapter');

function createClassifiers(overrides = {}) {
  return {
    isPlatformIdentityPrompt: jest.fn(() => false),
    isOverviewPrompt: jest.fn(() => false),
    isAlertEventPrompt: jest.fn(() => false),
    isAlertSkillMetaFollowUpPrompt: jest.fn(() => false),
    isMetricInventoryPrompt: jest.fn(() => false),
    isMetricInventoryDetailPrompt: jest.fn(() => false),
    inferMetricInventoryGroup: jest.fn(() => ''),
    isNapmMetaFollowUpPrompt: jest.fn(() => false),
    isResultDeliveryFollowUpPrompt: jest.fn(() => false),
    classifyNapmWorkflow: jest.fn(() => ({})),
    isAlertPacketAnalysisPrompt: jest.fn(() => false),
    isPacketCapturePrompt: jest.fn(() => false),
    isReportExportPrompt: jest.fn(() => false),
    isReportWorkflowPrompt: jest.fn(() => false),
    isSystemDomainPrompt: jest.fn(() => false),
    isNapmRelatedPrompt: jest.fn(() => false),
    isContinuationPrompt: jest.fn(() => false),
    isOutOfScopeNapmRequest: jest.fn(() => false),
    classifyReportPrompt: jest.fn(() => null),
    hasSpecificFaultDiagnosisTarget: jest.fn(() => false),
    isFaultDiagnosisPrompt: jest.fn(() => false),
    ...overrides
  };
}

describe('DomainIntentClassificationAdapter', () => {
  test('projects existing domain predicates into one immutable structured classification', () => {
    const classifiers = createClassifiers({
      isAlertPacketAnalysisPrompt: jest.fn(() => true),
      isAlertEventPrompt: jest.fn(() => true),
      isNapmRelatedPrompt: jest.fn(() => true),
      isSystemDomainPrompt: jest.fn(() => true),
      classifyNapmWorkflow: jest.fn(() => ({
        workflowType: 'alert_packet_analysis',
        operation: 'detail',
        targetObjectType: 'Alert'
      }))
    });
    const adapter = createDomainIntentClassificationAdapter(classifiers);

    const classification = adapter.classify({
      prompt: 'opaque-domain-input',
      previousState: { napmRelated: true, domainRelated: true }
    });

    expect(classification).toMatchObject({
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      source: 'existing-domain-classifier-adapter',
      workflow: {
        workflowType: 'alert_packet_analysis',
        operation: 'detail',
        targetObjectType: 'Alert'
      },
      signals: {
        alertPacket: true,
        alert: true,
        packet: false,
        faultDiagnosis: false,
        contextContinuation: false
      },
      facts: { baseNapmRelated: true, baseDomainRelated: true }
    });
    expect(classifiers.isAlertPacketAnalysisPrompt).toHaveBeenCalledWith('opaque-domain-input');
    expect(Object.isFrozen(classification)).toBe(true);
    expect(Object.isFrozen(classification.workflow)).toBe(true);
    expect(Object.isFrozen(classification.signals)).toBe(true);
    expect(Object.isFrozen(classification.facts)).toBe(true);
  });

  test('normalizes a standalone report export without inventing prompt rules', () => {
    const classifiers = createClassifiers({
      isReportExportPrompt: jest.fn(() => true),
      classifyReportPrompt: jest.fn(() => null),
      isNapmRelatedPrompt: jest.fn(() => true)
    });
    const classification = createDomainIntentClassificationAdapter(classifiers).classify({
      prompt: 'opaque-report-input'
    });

    expect(classification.signals.reportIntent).toBe('export');
    expect(classifiers.isReportExportPrompt).toHaveBeenCalledWith('opaque-report-input');
    expect(classifiers.classifyReportPrompt).not.toHaveBeenCalled();
  });

  test('short-circuits platform identity before invoking NAPM domain classifiers', () => {
    const classifiers = createClassifiers({
      isPlatformIdentityPrompt: jest.fn(() => true)
    });
    const classification = createDomainIntentClassificationAdapter(classifiers).classify({
      prompt: '你是谁'
    });

    expect(classification.facts.platformIdentityPrompt).toBe(true);
    expect(classification.facts.baseNapmRelated).toBe(false);
    expect(classifiers.isAlertEventPrompt).not.toHaveBeenCalled();
    expect(classifiers.classifyNapmWorkflow).not.toHaveBeenCalled();
  });

  test('fails fast when the adapter contract omits an existing classifier', () => {
    const classifiers = createClassifiers();
    delete classifiers.isPacketCapturePrompt;

    expect(() => createDomainIntentClassificationAdapter(classifiers))
      .toThrow('isPacketCapturePrompt');
  });
});
