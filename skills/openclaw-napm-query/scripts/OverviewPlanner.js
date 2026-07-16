/**
 * OverviewPlanner.js
 *
 * 负责在候选概览模块集合中挑选“这次该查哪些模块”。
 * 它会综合场景、问题类型、指标域、对象类型、深度预算和元数据健康度，
 * 对 root / child candidate 打分并生成 overview plan。
 */
const { DEPTH_LEVELS } = require('./OverviewBudget');
const { getOverviewSceneProfile } = require('./OverviewCandidateRegistry');
const {
  normalizeSemanticMetricDomainToken,
  getSemanticMetricDomainAliases
} = require('../src/constants/metricDomains');

// 规划期打分与过滤策略，统一定义 root/child 评分权重及元数据问题处理规则。
const DEFAULT_OVERVIEW_PLANNING_POLICY = {
  hardMetadataIssuePrefixes: [
    'group_not_found:',
    'group_cannot_query:',
    'metrics_for_group_empty:',
    'metric_not_supported_for_group:'
  ],
  softMetadataIssuePrefixes: [
    'granularity_not_supported:',
    'group_argument_not_found:'
  ],
  rootScore: {
    scene: 20,
    questionType: 16,
    metricExact: 28,
    metricDomain: 12,
    objectType: 14,
    focusObject: 10,
    metadataHealthy: 8,
    softIssuePenalty: 4,
    queryCostPenalty: 3
  },
  childScore: {
    base: 10,
    parentScoreFactor: 0.15,
    trendQuestion: 18,
    deepDepth: 10,
    focusObject: 8,
    softIssuePenalty: 3
  },
  childPolicy: {
    allowFast: false,
    requireTrendOrDeepForLowPriority: true,
    standardPriorityFloor: 68
  }
};

// 统一规范化 planner 中涉及的自由文本。
function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
}

function parseRequestedTopCount(prompt = '') {
  const text = String(prompt || '');
  const match = text.match(/(?:top\s*|前\s*)(\d{1,3})/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// 根据 prompt、intent 和 resolvedQuery 推断当前问句更像哪种概览问题。
function inferQuestionType(prompt = '', intent = {}, resolvedQuery = {}) {
  const fromIntent = normalizeText(intent?.questionType || intent?.userIntent);
  if (fromIntent && fromIntent !== 'query') {
    return fromIntent;
  }

  const service = normalizeText(resolvedQuery?.service);
  if (service === 'timevalues') return 'trend';
  if (service === 'topvalues') return 'topn';

  const text = String(prompt || '').trim();
  if (/(丢包|loss|drop|packet)/i.test(text)) return 'loss';
  if (/(慢|时延|响应时间|latency|delay|slow|response)/i.test(text)) return 'slow';
  if (/(失败|异常|告警|4xx|5xx|error|fail)/i.test(text)) return 'error';
  if (/(趋势|变化|走势|trend)/i.test(text)) return 'trend';
  if (/(排行|排名|前\d+|top\s*\d+|最多|最高)/i.test(text)) return 'topn';
  if (/(安全|攻击|风险|security|attack|threat)/i.test(text)) return 'security';
  return 'overview';
}

function normalizeMetricDomainToken(value) {
  return normalizeSemanticMetricDomainToken(value);
}

function inferMetricDomains(prompt = '', intent = {}, resolvedQuery = {}) {
  const values = [];
  const push = (value) => {
    const token = normalizeMetricDomainToken(value);
    if (token) {
      values.push(token);
    }
  };

  push(resolvedQuery?.metricDomain);
  push(resolvedQuery?.metricSemantic?.metricDomain);
  push(resolvedQuery?.semanticConstraints?.metricDomain);
  push(intent?.metricDomain);
  const candidates = Array.isArray(intent?.metricDomainCandidates) ? intent.metricDomainCandidates : [];
  candidates.forEach((item) => {
    if (typeof item === 'string') {
      push(item);
      return;
    }
    push(item?.domain);
    push(item?.metricDomain);
    push(item?.name);
    push(item?.label);
    const aliases = getSemanticMetricDomainAliases(item?.metricDomain || item?.domain || item?.name || item?.label);
    aliases.forEach((alias) => push(alias));
  });
  push(prompt);
  return uniqueStrings(values);
}

function inferMetricCodes(intent = {}, resolvedQuery = {}) {
  return uniqueStrings([
    resolvedQuery?.metric,
    ...(Array.isArray(resolvedQuery?.metrics) ? resolvedQuery.metrics : []),
    intent?.metric
  ]).map((item) => String(item).toUpperCase());
}

// 收集 query 当前涉及到的对象类型，为 candidate 打分时提供语义提示。
function inferObjectTypes(resolvedQuery = {}) {
  const values = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text) {
      values.push(text);
    }
  };

  const groups = Array.isArray(resolvedQuery?.groups) ? resolvedQuery.groups : [];
  groups.forEach((group) => push(group?.type));
  push(resolvedQuery?.semanticConstraints?.targetObjectType);
  push(resolvedQuery?.candidateSpec?.semantic_constraints?.targetObjectType);
  push(resolvedQuery?.semanticConstraints?.anchorObject?.type);
  push(resolvedQuery?.candidateSpec?.semantic_constraints?.anchorObject?.type);

  const objectCandidates = [
    ...(Array.isArray(resolvedQuery?.semanticConstraints?.objectCandidates) ? resolvedQuery.semanticConstraints.objectCandidates : []),
    ...(Array.isArray(resolvedQuery?.candidateSpec?.semantic_constraints?.objectCandidates) ? resolvedQuery.candidateSpec.semantic_constraints.objectCandidates : []),
    ...(Array.isArray(resolvedQuery?.candidateSpec?.candidate_inputs?.object_candidates) ? resolvedQuery.candidateSpec.candidate_inputs.object_candidates : [])
  ];
  objectCandidates.forEach((item) => push(item?.type || item?.objectType));
  return uniqueStrings(values);
}

/**
 * 从 prompt / resolvedQuery / metadataReview 中提取 overview 规划所需的 slots。
 * 这些 slots 会贯穿后续 candidate 选择和 query 编译过程。
 */
function extractOverviewSlots({ prompt = '', resolvedQuery = {}, intent = {}, scene = null, metadataReview = null } = {}) {
  const groups = Array.isArray(resolvedQuery?.groups) ? resolvedQuery.groups : [];
  const contextGroups = Array.isArray(resolvedQuery?.contextGroups) ? resolvedQuery.contextGroups : [];
  const anchorObject = resolvedQuery?.semanticConstraints?.anchorObject || resolvedQuery?.candidateSpec?.semantic_constraints?.anchorObject || null;
  const anchorArgument = String(anchorObject?.argument || anchorObject?.value || '').trim() || null;
  const focusGroup = groups.find((group) => group?.argument)
    || contextGroups.find((group) => group?.argument)
    || (anchorArgument
      ? {
          type: anchorObject?.type || null,
          argument: anchorArgument
        }
      : null);

  const slotValues = {
    focusDefinedApp: null,
    focusWebApplication: null,
    focusBusinessGroup: null,
    focusIpAddress: null
  };

  if (focusGroup?.type === 'DefinedApp' || focusGroup?.type === 'Application') slotValues.focusDefinedApp = focusGroup.argument;
  if (focusGroup?.type === 'WebApplication') slotValues.focusWebApplication = focusGroup.argument;
  if (focusGroup?.type === 'BusinessGroup') slotValues.focusBusinessGroup = focusGroup.argument;
  if (focusGroup?.type === 'IPAddress') slotValues.focusIpAddress = focusGroup.argument;

  return {
    scene,
    questionType: inferQuestionType(prompt, intent, resolvedQuery),
    metricCodes: inferMetricCodes(intent, resolvedQuery),
    metricDomains: inferMetricDomains(prompt, intent, resolvedQuery),
    objectTypes: inferObjectTypes(resolvedQuery),
    requestedTopCount: parseRequestedTopCount(prompt),
    focusObject: focusGroup ? { type: focusGroup.type || null, value: focusGroup.argument || null } : null,
    anchorGroups: [...groups, ...contextGroups]
      .filter((group) => group?.type && group?.argument)
      .map((group) => ({
      type: group.type,
      argument: group.argument
      })),
    slotValues,
    metadataAvailableGroupTypes: Array.isArray(metadataReview?.flattenedGroups)
      ? uniqueStrings(metadataReview.flattenedGroups.map((item) => item?.type))
      : []
  };
}

function getDepthRank(depth = 'standard') {
  return DEPTH_LEVELS[depth] || DEPTH_LEVELS.standard;
}

function getCandidateMetricCodes(candidate) {
  const metrics = Array.isArray(candidate?.request?.metrics) ? candidate.request.metrics : [];
  return uniqueStrings(metrics).map((item) => String(item).toUpperCase());
}

function getDepthProfileCandidates(depthProfiles = {}, depth = 'standard') {
  if (!depthProfiles || typeof depthProfiles !== 'object') {
    return [];
  }
    return Array.isArray(depthProfiles[depth]) ? depthProfiles[depth] : [];
}

// 读取指定 candidate 的动态元数据健康状况，并区分 hard issue 与 soft issue。
function getMetadataHealth(candidateId, metadataReview = {}, planningPolicy = DEFAULT_OVERVIEW_PLANNING_POLICY) {
  const candidateReview = metadataReview?.byCandidateId?.[candidateId] || {};
  const issues = Array.isArray(candidateReview?.issues) ? candidateReview.issues : [];
  const hardIssues = issues.filter((issue) => planningPolicy.hardMetadataIssuePrefixes.some((prefix) => String(issue).startsWith(prefix)));
  const softIssues = issues.filter((issue) => planningPolicy.softMetadataIssuePrefixes.some((prefix) => String(issue).startsWith(prefix)));
  return {
    review: candidateReview,
    hardIssues,
    softIssues
  };
}

/**
 * 为 root candidate 打分，并判断它是否可被选入本轮 overview plan。
 */
function evaluateRootCandidate(candidate, context) {
  const planningPolicy = context.planningPolicy || DEFAULT_OVERVIEW_PLANNING_POLICY;
  const slotRequirements = Array.isArray(candidate.slotRequirements) ? candidate.slotRequirements : [];
  const missingSlots = slotRequirements.filter((slotKey) => !context.slots?.slotValues?.[slotKey]);
  if (missingSlots.length > 0) {
    return { selectable: false, score: null, reasons: ['missing_slot'], details: { missingSlots } };
  }

  if (getDepthRank(context.depth) < getDepthRank(candidate.minDepth || 'fast')) {
    return {
      selectable: false,
      score: null,
      reasons: ['depth_filtered'],
      details: { minDepth: candidate.minDepth || 'fast', activeDepth: context.depth }
    };
  }

  const metadataHealth = getMetadataHealth(candidate.id, context.metadataReview, planningPolicy);
  if (metadataHealth.hardIssues.length > 0) {
    return {
      selectable: false,
      score: null,
      reasons: ['metadata_blocked'],
      details: { issues: metadataHealth.hardIssues }
    };
  }

  let score = Number(candidate.priority || 0);
  const scoreReasons = ['priority'];
  const candidateMetricCodes = getCandidateMetricCodes(candidate);
  const candidateMetricDomains = Array.isArray(candidate?.capability?.metricDomains) ? candidate.capability.metricDomains : [];
  const candidateObjectTypes = Array.isArray(candidate?.capability?.objectTypes) ? candidate.capability.objectTypes : [];
  const candidateQuestionTypes = Array.isArray(candidate?.capability?.questionTypes) ? candidate.capability.questionTypes : [];

  score += planningPolicy.rootScore.scene;
  scoreReasons.push('scene');

  if (candidateQuestionTypes.includes(context.slots.questionType)) {
    score += planningPolicy.rootScore.questionType;
    scoreReasons.push(`question:${context.slots.questionType}`);
  }
  if (context.slots.metricCodes.some((metricCode) => candidateMetricCodes.includes(metricCode))) {
    score += planningPolicy.rootScore.metricExact;
    scoreReasons.push('metric_exact');
  }
  if (context.slots.metricDomains.some((domain) => candidateMetricDomains.includes(domain))) {
    score += planningPolicy.rootScore.metricDomain;
    scoreReasons.push('metric_domain');
  }
  if (context.slots.objectTypes.some((objectType) => candidateObjectTypes.includes(objectType))) {
    score += planningPolicy.rootScore.objectType;
    scoreReasons.push('object_type');
  }
  if (context.slots.focusObject?.type && candidateObjectTypes.includes(context.slots.focusObject.type)) {
    score += planningPolicy.rootScore.focusObject;
    scoreReasons.push('focus_object');
  }

  score += planningPolicy.rootScore.metadataHealthy;
  if (metadataHealth.softIssues.length > 0) {
    score -= metadataHealth.softIssues.length * planningPolicy.rootScore.softIssuePenalty;
    scoreReasons.push('metadata_soft_penalty');
  }
  score -= Number(candidate?.cost?.rootQueries || 1) * planningPolicy.rootScore.queryCostPenalty;

  return {
    selectable: true,
    score,
    reasons: scoreReasons,
    details: {
      softIssues: metadataHealth.softIssues,
      review: metadataHealth.review
    }
  };
}

/**
 * 为 child candidate 打分。
 * child query 必须依附 parent selection，因此这里会同时考虑父模块得分和当前深度预算。
 */
function evaluateChildCandidate(candidate, parentSelection, context) {
  const planningPolicy = context.planningPolicy || DEFAULT_OVERVIEW_PLANNING_POLICY;
  if (context.budget.maxChildren <= 0) {
    return { selectable: false, score: null, reasons: ['child_budget_disabled'], details: {} };
  }

  if (context.depth === 'fast' && !planningPolicy.childPolicy.allowFast) {
    return { selectable: false, score: null, reasons: ['child_depth_policy'], details: { activeDepth: context.depth } };
  }

  const metadataHealth = getMetadataHealth(candidate.id, context.metadataReview, planningPolicy);
  if (metadataHealth.hardIssues.length > 0) {
    return {
      selectable: false,
      score: null,
      reasons: ['metadata_blocked'],
      details: { issues: metadataHealth.hardIssues }
    };
  }

  const hasTrendIntent = context.slots.questionType === 'trend';
  const isDeep = context.depth === 'deep';
  const focusMatches = Boolean(
    context.slots.focusObject?.type
    && Array.isArray(candidate?.capability?.objectTypes)
    && candidate.capability.objectTypes.includes(context.slots.focusObject.type)
  );

  const lowPriorityBlocked = planningPolicy.childPolicy.requireTrendOrDeepForLowPriority
    && Number(candidate.priority || 0) < planningPolicy.childPolicy.standardPriorityFloor
    && !hasTrendIntent
    && !isDeep
    && !focusMatches;
  if (context.depth === 'standard' && lowPriorityBlocked) {
    return { selectable: false, score: null, reasons: ['child_policy_blocked'], details: { activeDepth: context.depth } };
  }

  let score = Number(candidate.priority || 0) + planningPolicy.childScore.base;
  const scoreReasons = ['priority', 'child_base'];
  score += Number(parentSelection.score || 0) * planningPolicy.childScore.parentScoreFactor;
  scoreReasons.push('parent_score');

  if (hasTrendIntent) {
    score += planningPolicy.childScore.trendQuestion;
    scoreReasons.push('trend');
  }
  if (isDeep) {
    score += planningPolicy.childScore.deepDepth;
    scoreReasons.push('deep');
  }
  if (focusMatches) {
    score += planningPolicy.childScore.focusObject;
    scoreReasons.push('focus_object');
  }
  if (metadataHealth.softIssues.length > 0) {
    score -= metadataHealth.softIssues.length * planningPolicy.childScore.softIssuePenalty;
    scoreReasons.push('metadata_soft_penalty');
  }

  return {
    selectable: true,
    score,
    reasons: scoreReasons,
    details: {
      parentCandidateId: parentSelection.candidateId,
      softIssues: metadataHealth.softIssues
    }
  };
}

/**
 * 主入口：根据候选集、场景、深度和元数据状况构建 overview plan。
 */
function buildOverviewPlan({
  candidates = [],
  scene,
  depth,
  budget,
  metadataReview,
  slots,
  planningPolicy = DEFAULT_OVERVIEW_PLANNING_POLICY
} = {}) {
  const rootCandidates = candidates.filter((candidate) => candidate.role !== 'child');
  const childCandidates = candidates.filter((candidate) => candidate.role === 'child');
  const context = { scene, depth, budget, metadataReview, slots, planningPolicy };
  const sceneProfile = getOverviewSceneProfile(scene);
  const rootTemplateOrder = getDepthProfileCandidates(sceneProfile?.depthRoots, depth);
  const childTemplateOrder = getDepthProfileCandidates(sceneProfile?.depthChildren, depth);
  const rootOrderMap = new Map(rootTemplateOrder.map((candidateId, index) => [candidateId, index]));
  const childOrderMap = new Map(childTemplateOrder.map((candidateId, index) => [candidateId, index]));

  const selectedRootCandidates = [];
  const skippedCandidates = [];

  const rankedRoots = rootCandidates
    .filter((candidate) => rootTemplateOrder.length === 0 || rootOrderMap.has(candidate.id))
    .map((candidate) => ({ candidate, evaluation: evaluateRootCandidate(candidate, context) }))
    .sort((left, right) => {
      const leftHasSlotRequirement = Array.isArray(left.candidate?.slotRequirements) && left.candidate.slotRequirements.length > 0;
      const rightHasSlotRequirement = Array.isArray(right.candidate?.slotRequirements) && right.candidate.slotRequirements.length > 0;
      if (context.slots?.focusObject?.type && leftHasSlotRequirement !== rightHasSlotRequirement) {
        return rightHasSlotRequirement ? 1 : -1;
      }
      if (rootTemplateOrder.length > 0) {
        const leftIndex = rootOrderMap.has(left.candidate.id) ? rootOrderMap.get(left.candidate.id) : Number.MAX_SAFE_INTEGER;
        const rightIndex = rootOrderMap.has(right.candidate.id) ? rootOrderMap.get(right.candidate.id) : Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
      }
      const leftScore = Number(left.evaluation.score || -Infinity);
      const rightScore = Number(right.evaluation.score || -Infinity);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return Number(right.candidate.priority || 0) - Number(left.candidate.priority || 0);
    });

  for (const item of rankedRoots) {
    if (!item.evaluation.selectable) {
      skippedCandidates.push({
        candidateId: item.candidate.id,
        label: item.candidate.label,
        role: item.candidate.role,
        reason: item.evaluation.reasons[0],
        details: item.evaluation.details || null
      });
      continue;
    }

    if (selectedRootCandidates.length >= budget.maxQueries) {
      skippedCandidates.push({
        candidateId: item.candidate.id,
        label: item.candidate.label,
        role: item.candidate.role,
        reason: 'budget_limited',
        details: { maxQueries: budget.maxQueries }
      });
      continue;
    }

    selectedRootCandidates.push({
      candidateId: item.candidate.id,
      label: item.candidate.label,
      role: item.candidate.role,
      score: item.evaluation.score,
      scoreReasons: item.evaluation.reasons,
      candidate: item.candidate
    });
  }

  if (rootTemplateOrder.length > 0) {
    rootCandidates
      .filter((candidate) => !rootOrderMap.has(candidate.id))
      .forEach((candidate) => {
        skippedCandidates.push({
          candidateId: candidate.id,
          label: candidate.label,
          role: candidate.role,
          reason: 'scene_profile_filtered',
          details: { scene, depth }
        });
      });
  }

  const selectedChildCandidates = [];
  const rankedChildren = childCandidates
    .filter((candidate) => childTemplateOrder.length === 0 || childOrderMap.has(candidate.id))
    .map((candidate) => {
      const parentSelection = selectedRootCandidates.find((selected) => (
        Array.isArray(candidate.dependsOnCandidateIds) && candidate.dependsOnCandidateIds.includes(selected.candidateId)
      ));
      if (!parentSelection) {
        return {
          candidate,
          parentSelection: null,
          evaluation: { selectable: false, score: null, reasons: ['dependency_not_selected'], details: {} }
        };
      }
      return {
        candidate,
        parentSelection,
        evaluation: evaluateChildCandidate(candidate, parentSelection, context)
      };
    })
    .sort((left, right) => {
      if (childTemplateOrder.length > 0) {
        const leftIndex = childOrderMap.has(left.candidate.id) ? childOrderMap.get(left.candidate.id) : Number.MAX_SAFE_INTEGER;
        const rightIndex = childOrderMap.has(right.candidate.id) ? childOrderMap.get(right.candidate.id) : Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
      }
      const leftScore = Number(left.evaluation.score || -Infinity);
      const rightScore = Number(right.evaluation.score || -Infinity);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return Number(right.candidate.priority || 0) - Number(left.candidate.priority || 0);
    });

  for (const item of rankedChildren) {
    if (!item.evaluation.selectable) {
      skippedCandidates.push({
        candidateId: item.candidate.id,
        label: item.candidate.label,
        role: item.candidate.role,
        parentCandidateId: item.parentSelection?.candidateId || null,
        reason: item.evaluation.reasons[0],
        details: item.evaluation.details || null
      });
      continue;
    }

    if (selectedChildCandidates.some((selected) => selected.candidateId === item.candidate.id)) {
      continue;
    }

    selectedChildCandidates.push({
      candidateId: item.candidate.id,
      label: item.candidate.label,
      role: item.candidate.role,
      parentCandidateId: item.parentSelection.candidateId,
      score: item.evaluation.score,
      scoreReasons: item.evaluation.reasons,
      candidate: item.candidate
    });
  }

  if (childTemplateOrder.length > 0) {
    childCandidates
      .filter((candidate) => !childOrderMap.has(candidate.id))
      .forEach((candidate) => {
        skippedCandidates.push({
          candidateId: candidate.id,
          label: candidate.label,
          role: candidate.role,
          reason: 'scene_profile_filtered',
          details: { scene, depth }
        });
      });
  }

  return {
    scene,
    depth,
    budget: { ...budget },
    planningPolicy,
    slots,
    selectedRootCandidates,
    selectedChildCandidates,
    selectedCandidates: [
      ...selectedRootCandidates.map((item) => ({
        candidateId: item.candidateId,
        label: item.label,
        role: item.role,
        score: item.score,
        scoreReasons: item.scoreReasons
      })),
      ...selectedChildCandidates.map((item) => ({
        candidateId: item.candidateId,
        label: item.label,
        role: item.role,
        parentCandidateId: item.parentCandidateId,
        score: item.score,
        scoreReasons: item.scoreReasons
      }))
    ],
    skippedCandidates
  };
}

module.exports = {
  DEFAULT_OVERVIEW_PLANNING_POLICY,
  extractOverviewSlots,
  buildOverviewPlan
};
