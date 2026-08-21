'use strict';

const TARGET_RESOLUTION_STATUS = Object.freeze({
  OVERALL: 'overall',
  RESOLVED: 'resolved',
  NOT_FOUND: 'target_not_found',
  AMBIGUOUS: 'target_ambiguous',
  CATALOG_UNAVAILABLE: 'catalog_unavailable'
});

const SUMMARY_SCOPE_BY_GROUP_TYPE = Object.freeze({
  WebApplication: { type: 'webApplication', label: '业务' },
  DefinedApp: { type: 'application', label: '应用' }
});

const GROUP_TYPE_BY_SUMMARY_SCOPE = Object.freeze({
  webApplication: 'WebApplication',
  application: 'DefinedApp'
});

function normalizeText(value = '') {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeComparableText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s，。！？!?、,:：；;"'“”‘’（）()【】{}<>《》~～]/g, '');
}

function extractPotentialTargetHint(prompt = '') {
  let text = normalizeText(prompt);
  if (!text) return '';

  text = text
    .replace(/[，。！？!?、,:：；;"'“”‘’（）()【】{}<>《》~～]/g, ' ')
    .replace(/\b(?:docx|word|pdf)\b/gi, ' ')
    .replace(/(?:最近|近)?(?:\d+|[一二三四五六七八九十百两]+)(?:分钟|小时|天|日|周|个月|月)/g, ' ')
    .replace(/(?:今天|今日|昨天|昨日|本周|上周|本月|上月|日报|周报|月报)/g, ' ')
    .replace(/(?:故障分析报告|故障诊断报告|应用故障分析|业务故障分析|页面性能分析|综述分析报告|综述报告|分析报告|诊断报告|报告|综述)/gi, ' ')
    .replace(/(?:WebApplication|DefinedApp|Web应用|业务系统|业务组|工作组|业务|应用|系统|NAPM|观枢|全局|整体|全部|所有|网络|告警)/gi, ' ')
    .replace(/(?:请帮我|麻烦帮我|帮我|请|给我|生成|制作|创建|出一份|出个|做一份|查看|分析)/g, ' ')
    .replace(/的/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function getRowName(row = {}) {
  const values = [
    row.name,
    row.Name,
    row.label,
    row.value,
    row.argument,
    row.key,
    row.raw?.name,
    row.raw?.Name
  ];
  return values.map(normalizeText).find(Boolean) || '';
}

function getApplicationType(row = {}) {
  const values = [
    row.applicationType,
    row.Type,
    row.typeCode,
    row.rawType,
    row.raw?.Type,
    row.raw?.type,
    row.type
  ];
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function getRowGroupType(row = {}) {
  const explicit = normalizeText(
    row.__groupType
    || row.executionGroupType
    || row.effectiveObjectType
    || row.objectType
    || (typeof row.type === 'string' ? row.type : '')
  );
  if (explicit === 'Application') return 'DefinedApp';
  if (explicit === 'WebApplication' || explicit === 'DefinedApp') return explicit;

  const applicationType = getApplicationType(row);
  if (applicationType === 3) return 'WebApplication';
  if ([1, 2, 4].includes(applicationType)) return 'DefinedApp';
  return '';
}

function toTargetCandidate(row = {}) {
  const groupArgument = getRowName(row);
  const groupType = getRowGroupType(row);
  if (!groupArgument || !groupType) return null;
  return {
    groupType,
    groupArgument,
    groupLabel: groupArgument
  };
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.groupType}\u0000${normalizeComparableText(candidate.groupArgument)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class NapmObjectTargetResolver {
  constructor(options = {}) {
    this.catalogProvider = typeof options.catalogProvider === 'function'
      ? options.catalogProvider
      : null;
    this.metadataService = options.metadataService || null;
  }

  async _listCatalog(groupTypes = []) {
    if (this.catalogProvider) {
      return this.catalogProvider(groupTypes);
    }

    if (!this.metadataService) {
      const NapmMetadataService = require('../openclaw-napm-query/services/NapmMetadataService');
      this.metadataService = new NapmMetadataService();
    }

    const lists = await Promise.all(groupTypes.map(async (groupType) => {
      const rows = await this.metadataService.listObjectInstances(groupType);
      if (!Array.isArray(rows)) {
        throw new Error(`Object catalog did not return an array for ${groupType}.`);
      }
      return rows.map((row) => ({ ...row, __groupType: groupType }));
    }));
    return lists.flat();
  }

  async resolveNamedTarget(prompt = '', options = {}) {
    const targetHint = normalizeText(options.targetHint || extractPotentialTargetHint(prompt));
    if (!targetHint) {
      return {
        ok: true,
        status: TARGET_RESOLUTION_STATUS.OVERALL,
        target: null,
        targetHint: ''
      };
    }

    const groupTypes = Array.isArray(options.groupTypes) && options.groupTypes.length > 0
      ? options.groupTypes.slice()
      : ['WebApplication', 'DefinedApp'];

    let rows;
    try {
      rows = await this._listCatalog(groupTypes);
      if (!Array.isArray(rows)) {
        throw new Error('Object catalog did not return an array.');
      }
    } catch (error) {
      return {
        ok: false,
        status: TARGET_RESOLUTION_STATUS.CATALOG_UNAVAILABLE,
        target: null,
        targetHint,
        errorCode: error?.code || 'OBJECT_TARGET_CATALOG_UNAVAILABLE'
      };
    }

    const comparablePrompt = normalizeComparableText(prompt);
    const comparableHint = normalizeComparableText(targetHint);
    let candidates = dedupeCandidates(rows
      .map(toTargetCandidate)
      .filter(Boolean)
      .filter((candidate) => {
        const comparableName = normalizeComparableText(candidate.groupArgument);
        return comparableName
          && (comparablePrompt.includes(comparableName) || comparableHint === comparableName);
      }));

    const preferredGroupType = normalizeText(options.preferredGroupType);
    if (preferredGroupType) {
      const preferred = candidates.filter((candidate) => candidate.groupType === preferredGroupType);
      if (preferred.length > 0) candidates = preferred;
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        status: TARGET_RESOLUTION_STATUS.NOT_FOUND,
        target: null,
        targetHint
      };
    }

    const maxNameLength = Math.max(...candidates.map((candidate) =>
      normalizeComparableText(candidate.groupArgument).length));
    const strongest = candidates.filter((candidate) =>
      normalizeComparableText(candidate.groupArgument).length === maxNameLength);

    if (strongest.length !== 1) {
      return {
        ok: false,
        status: TARGET_RESOLUTION_STATUS.AMBIGUOUS,
        target: null,
        targetHint,
        candidates: strongest
      };
    }

    return {
      ok: true,
      status: TARGET_RESOLUTION_STATUS.RESOLVED,
      target: strongest[0],
      targetHint
    };
  }

  async resolveSummaryScope(prompt = '', baseScope = {}) {
    const normalizedScope = {
      type: normalizeText(baseScope.type) || 'global',
      label: normalizeText(baseScope.label) || '全局'
    };
    const targetHint = extractPotentialTargetHint(prompt);
    if (!targetHint) {
      return {
        ok: true,
        status: TARGET_RESOLUTION_STATUS.OVERALL,
        scope: normalizedScope,
        targetHint: ''
      };
    }

    const preferredGroupType = GROUP_TYPE_BY_SUMMARY_SCOPE[normalizedScope.type] || '';
    const resolution = await this.resolveNamedTarget(prompt, {
      targetHint,
      preferredGroupType,
      groupTypes: ['WebApplication', 'DefinedApp']
    });
    if (!resolution.ok) {
      return { ...resolution, scope: normalizedScope };
    }

    const resolvedScope = SUMMARY_SCOPE_BY_GROUP_TYPE[resolution.target.groupType];
    if (!resolvedScope) {
      return {
        ok: false,
        status: TARGET_RESOLUTION_STATUS.NOT_FOUND,
        scope: normalizedScope,
        targetHint
      };
    }

    return {
      ...resolution,
      scope: {
        ...resolvedScope,
        target: resolution.target
      }
    };
  }
}

module.exports = {
  NapmObjectTargetResolver,
  TARGET_RESOLUTION_STATUS,
  extractPotentialTargetHint,
  normalizeComparableText,
  toTargetCandidate
};
