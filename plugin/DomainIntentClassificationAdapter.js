'use strict';

const CLASSIFICATION_SCHEMA_VERSION = 'napm.domain-intent-classification.v1';
const CLASSIFICATION_SOURCE = 'existing-domain-classifier-adapter';

const REQUIRED_CLASSIFIERS = Object.freeze([
  'isPlatformIdentityPrompt',
  'isOverviewPrompt',
  'isAlertEventPrompt',
  'isAlertSkillMetaFollowUpPrompt',
  'isMetricInventoryPrompt',
  'isMetricInventoryDetailPrompt',
  'inferMetricInventoryGroup',
  'isNapmMetaFollowUpPrompt',
  'isResultDeliveryFollowUpPrompt',
  'classifyNapmWorkflow',
  'isAlertPacketAnalysisPrompt',
  'isPacketCapturePrompt',
  'isReportExportPrompt',
  'isReportWorkflowPrompt',
  'isSystemDomainPrompt',
  'isNapmRelatedPrompt',
  'isContinuationPrompt',
  'isOutOfScopeNapmRequest',
  'classifyReportPrompt',
  'hasSpecificFaultDiagnosisTarget',
  'isFaultDiagnosisPrompt'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function assertClassifierContract(classifiers = {}) {
  for (const name of REQUIRED_CLASSIFIERS) {
    if (typeof classifiers?.[name] !== 'function') {
      throw new TypeError(`Domain intent classifier adapter requires ${name}().`);
    }
  }
}

function projectWorkflow(workflow = {}) {
  return {
    workflowType: normalizeText(workflow?.workflowType) || null,
    operation: normalizeText(workflow?.operation) || null,
    targetObjectType: normalizeText(workflow?.targetObjectType) || null,
    requiresResultReference: workflow?.requiresResultReference === true
  };
}

function freezeClassification({ workflow = {}, signals = {}, facts = {} } = {}) {
  return Object.freeze({
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    source: CLASSIFICATION_SOURCE,
    workflow: Object.freeze({ ...workflow }),
    signals: Object.freeze({ ...signals }),
    facts: Object.freeze({ ...facts })
  });
}

function buildPlatformIdentityClassification() {
  return freezeClassification({
    workflow: projectWorkflow(),
    signals: {
      alertPacket: false,
      alert: false,
      packet: false,
      reportIntent: null,
      faultDiagnosis: false,
      contextContinuation: false
    },
    facts: {
      platformIdentityPrompt: true,
      baseNapmRelated: false,
      baseDomainRelated: false
    }
  });
}

function createDomainIntentClassificationAdapter(classifiers = {}) {
  assertClassifierContract(classifiers);

  return Object.freeze({
    classify({ prompt = '', previousState = null } = {}) {
      const normalizedPrompt = normalizeText(prompt);
      if (classifiers.isPlatformIdentityPrompt(normalizedPrompt)) {
        return buildPlatformIdentityClassification();
      }

      const workflow = projectWorkflow(classifiers.classifyNapmWorkflow(normalizedPrompt));
      const continuationPrompt = Boolean(classifiers.isContinuationPrompt(normalizedPrompt));
      const overviewRelated = Boolean(classifiers.isOverviewPrompt(normalizedPrompt));
      const alertEventPrompt = Boolean(classifiers.isAlertEventPrompt(normalizedPrompt));
      const alertMetaFollowUpPrompt = Boolean(
        classifiers.isAlertSkillMetaFollowUpPrompt(normalizedPrompt, previousState)
      );
      const metricInventoryRootPrompt = Boolean(
        classifiers.isMetricInventoryPrompt(normalizedPrompt)
      );
      const metricInventoryPrompt = metricInventoryRootPrompt || Boolean(
        previousState?.lastMetricInventoryGroup
        && classifiers.isMetricInventoryDetailPrompt(normalizedPrompt)
      );
      const metaFollowUpPrompt = Boolean(
        classifiers.isNapmMetaFollowUpPrompt(normalizedPrompt, previousState)
      );
      const resultDeliveryFollowUpPrompt = Boolean(
        classifiers.isResultDeliveryFollowUpPrompt(normalizedPrompt, previousState)
      );
      const classifiedQueryResultFollowUpPrompt = Boolean(
        previousState?.napmRelated
        && workflow.operation === 'drilldown'
        && workflow.requiresResultReference
      );
      const alertPacketAnalysisPrompt = Boolean(
        classifiers.isAlertPacketAnalysisPrompt(normalizedPrompt)
      );
      const packetCapturePrompt = Boolean(classifiers.isPacketCapturePrompt(normalizedPrompt));
      const reportExportPrompt = Boolean(classifiers.isReportExportPrompt(normalizedPrompt));
      const reportWorkflowPrompt = Boolean(classifiers.isReportWorkflowPrompt(normalizedPrompt));
      const systemDomainPrompt = Boolean(classifiers.isSystemDomainPrompt(normalizedPrompt));
      const explicitNapmPrompt = Boolean(classifiers.isNapmRelatedPrompt(normalizedPrompt));
      const outOfScopeNapmRequest = Boolean(
        classifiers.isOutOfScopeNapmRequest(normalizedPrompt)
      );
      const reportIntent = reportExportPrompt && !reportWorkflowPrompt
        ? 'export'
        : normalizeText(classifiers.classifyReportPrompt(normalizedPrompt)) || null;
      const hasExplicitFaultTarget = Boolean(
        classifiers.hasSpecificFaultDiagnosisTarget(normalizedPrompt)
      );
      const faultDiagnosisPrompt = Boolean(classifiers.isFaultDiagnosisPrompt(
        normalizedPrompt,
        { hasExplicitTarget: hasExplicitFaultTarget }
      ));
      const baseDomainRelated = Boolean(
        overviewRelated
        || reportWorkflowPrompt
        || reportExportPrompt
        || alertEventPrompt
        || alertMetaFollowUpPrompt
        || metricInventoryPrompt
        || systemDomainPrompt
        || metaFollowUpPrompt
        || resultDeliveryFollowUpPrompt
        || classifiedQueryResultFollowUpPrompt
        || (previousState?.domainRelated && continuationPrompt)
      );
      const baseNapmRelated = Boolean(
        overviewRelated
        || reportWorkflowPrompt
        || reportExportPrompt
        || alertEventPrompt
        || alertMetaFollowUpPrompt
        || metricInventoryPrompt
        || explicitNapmPrompt
        || metaFollowUpPrompt
        || resultDeliveryFollowUpPrompt
        || classifiedQueryResultFollowUpPrompt
        || (previousState?.napmRelated && continuationPrompt)
      );

      return freezeClassification({
        workflow,
        signals: {
          alertPacket: alertPacketAnalysisPrompt,
          alert: alertEventPrompt,
          packet: packetCapturePrompt,
          reportIntent,
          faultDiagnosis: faultDiagnosisPrompt,
          contextContinuation: !workflow.workflowType && continuationPrompt
        },
        facts: {
          platformIdentityPrompt: false,
          overviewRelated,
          alertEventPrompt,
          alertMetaFollowUpPrompt,
          metricInventoryPrompt,
          metricInventoryRootPrompt,
          inferredMetricInventoryGroup: metricInventoryRootPrompt
            ? normalizeText(classifiers.inferMetricInventoryGroup(normalizedPrompt))
            : '',
          metaFollowUpPrompt,
          resultDeliveryFollowUpPrompt,
          classifiedQueryResultFollowUpPrompt,
          alertPacketAnalysisPrompt,
          packetCapturePrompt,
          reportExportPrompt,
          reportWorkflowPrompt,
          faultDiagnosisPrompt,
          continuationPrompt,
          outOfScopeNapmRequest,
          baseDomainRelated,
          baseNapmRelated
        }
      });
    }
  });
}

module.exports = {
  CLASSIFICATION_SCHEMA_VERSION,
  CLASSIFICATION_SOURCE,
  REQUIRED_CLASSIFIERS,
  createDomainIntentClassificationAdapter
};
