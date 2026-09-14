'use strict';

const { REFERENCE_ACTIONS } = require('../ReferenceSelectionParser');

const DOMAIN_BY_TOOL = Object.freeze({
  'napm-skill-query': 'QUERY',
  'napm-alert-query': 'ALERT',
  'napm-alert-packet-analysis': 'ALERT_PACKET',
  'napm-packet-analysis': 'PACKET',
  'napm-report-export': 'REPORT',
  'napm-inspection-snapshot': 'INSPECTION',
  'napm-summary': 'SUMMARY',
  'napm-fault-diagnosis': 'FAULT_DIAGNOSIS'
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

class ContextBoundaryResolver {
  getAdmissionCandidates({ record = null, handled = false } = {}) {
    if (handled || record?.result?.ok !== true) return [];
    const sourceTool = normalizeText(record?.sourceTool);
    const domain = DOMAIN_BY_TOOL[sourceTool];
    if (!domain) return [];
    return [{
      domain,
      artifactId: `skill-result:${normalizeText(record?.turnId) || 'unknown'}`,
      artifactType: 'authoritative_skill_result_boundary',
      objectType: null,
      supportedActions: [REFERENCE_ACTIONS.DETAIL],
      route: 'napm_candidate',
      expectedTool: null,
      workflow: 'context_followup_clarification',
      requiresClarification: true,
      clarification: '您说的“第一个”更可能来自最近一份结果，但该结果类型尚不支持安全的序号下钻。请直接说明要查看的对象或重新发起对应查询。',
      freshnessPriority: 1,
      updatedAt: Number(record?.updatedAt) || 0
    }];
  }
}

module.exports = ContextBoundaryResolver;
