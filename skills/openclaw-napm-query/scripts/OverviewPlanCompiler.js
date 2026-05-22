/**
 * OverviewPlanCompiler.js
 *
 * 负责把 overview planner 选中的候选模块编译成真正可执行的 query plan。
 * 这个阶段会补齐时间范围、groups、slot 参数、child query 预算分配，
 * 让执行器拿到的是一份已经可以直接跑的执行清单。
 */
function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// 从 candidate.request.groups 构造执行态 groups，并优先用 slot 值回填 argument。
function buildGroupsFromCandidate(candidate, slots = {}) {
  const groups = Array.isArray(candidate?.request?.groups) ? candidate.request.groups : [];
  return groups.map((group) => {
    const next = { type: group.type };
    const explicitArgument = String(group.argument || '').trim();
    if (explicitArgument) {
      next.argument = explicitArgument;
      return next;
    }
    const slotKey = String(group.argumentFromSlot || '').trim();
    const slotValue = slotKey ? String(slots?.slotValues?.[slotKey] || '').trim() : '';
    if (slotValue) {
      next.argument = slotValue;
    }
    return next;
  });
}

// 合并 seedGroups、上下文 groups 和 anchorObject，生成候选编译阶段的锚点 groups。
function buildSeedGroups(seedGroups = [], contextGroups = [], anchorObject = null) {
  const groups = [];
  if (Array.isArray(seedGroups)) {
    groups.push(...seedGroups);
  }
  if (Array.isArray(contextGroups)) {
    groups.push(...contextGroups);
  }
  const anchorArgument = String(anchorObject?.argument || anchorObject?.value || '').trim();
  if (anchorObject?.type && anchorArgument) {
    groups.push({
      type: anchorObject.type,
      argument: anchorArgument
    });
  }
  return groups;
}

// 选取第一条既有 type 又有 argument 的 seed group，作为后续锚点补齐来源。
function pickAnchorGroup(seedGroups = []) {
  return seedGroups.find((group) => group && group.type && group.argument) || null;
}

// 当编译出的 query 缺少 anchor argument 时，尝试从 seedGroups 中补回去。
function applySeedAnchorIfNeeded(query, seedGroups = []) {
  const next = deepClone(query);
  const groups = Array.isArray(next?.groups) ? next.groups : [];
  if (groups.length === 0) {
    return next;
  }
  const anchorGroup = pickAnchorGroup(seedGroups);
  if (!anchorGroup) {
    return next;
  }
  const sameType = groups.find((group) => group?.type === anchorGroup.type);
  if (sameType && !sameType.argument) {
    sameType.argument = anchorGroup.argument;
  }
  return next;
}

// 根据候选的元数据审查结果，对 query 做最终粒度等细节修正。
function applyMetadataAdjustments(query, candidateReview = {}) {
  const next = deepClone(query);
  const granularities = Array.isArray(candidateReview?.granularities) ? candidateReview.granularities : [];
  if (next.service === 'timeValues' && granularities.length > 0) {
    const currentGranularity = Number(next.granularity);
    if (!granularities.includes(currentGranularity)) {
      next.granularity = granularities[0];
    }
  }
  return next;
}

/**
 * 把单个 candidate 编译成基础 query。
 * 这里会统一补 service、metrics、groups、topCount、granularity 等执行字段。
 */
function buildBaseQueryFromCandidate(candidate, range, seedGroups = [], slots = {}, candidateReview = null) {
  const request = candidate?.request || {};
  const metrics = Array.isArray(request.metrics) ? request.metrics.filter(Boolean) : [];
  const metric = request.metric || metrics[0] || null;
  const query = {
    service: request.service,
    start: range.start,
    end: range.end,
    format: 'json'
  };

  if (metrics.length > 0) {
    query.metrics = metrics;
  }
  if (metric) {
    query.metric = metric;
  }

  const groups = buildGroupsFromCandidate(candidate, slots);
  if (groups.length > 0) {
    query.groups = groups;
  }

  if (request.service === 'topValues') {
    query.topMetric = request.topMetric || metric;
    const requestedTopCount = toFiniteNumber(slots?.requestedTopCount);
    const fallbackTopCount = toFiniteNumber(request.topCount) || 5;
    query.topCount = requestedTopCount && requestedTopCount > 0
      ? Math.max(1, requestedTopCount)
      : fallbackTopCount;
  }

  if (request.service === 'timeValues') {
    query.granularity = toFiniteNumber(request.granularity) || 3600;
  }

  const anchoredQuery = applySeedAnchorIfNeeded(query, seedGroups);
  return applyMetadataAdjustments(anchoredQuery, candidateReview);
}

// 根据总 child 预算，给编译后的 child plans 做尽量均衡的名额分配。
function buildChildBudgetAllocations(compiledChildPlans = [], maxChildren = 0) {
  const allocations = new Map();
  if (maxChildren <= 0 || compiledChildPlans.length === 0) {
    return allocations;
  }

  let remaining = maxChildren;
  for (const childPlan of compiledChildPlans) {
    if (remaining <= 0) {
      break;
    }
    allocations.set(childPlan.planId, 1);
    remaining -= 1;
  }

  let index = 0;
  while (remaining > 0 && compiledChildPlans.length > 0) {
    const childPlan = compiledChildPlans[index % compiledChildPlans.length];
    const current = allocations.get(childPlan.planId) || 0;
    const maxForPlan = Number(childPlan.recommendedMaxChildren || 1);
    if (current < maxForPlan) {
      allocations.set(childPlan.planId, current + 1);
      remaining -= 1;
    }
    index += 1;
    if (index > compiledChildPlans.length * 10) {
      break;
    }
  }

  return allocations;
}

/**
 * 主入口：把 overview plan 编译为 executionItems。
 * 输出结果会保留 selectedCandidates / skippedCandidates，便于执行与调试阶段复用。
 */
function compileOverviewPlan({ overviewPlan, timeRange, seedGroups = [], metadataReview = null } = {}) {
  const anchorSeedGroups = buildSeedGroups(
    seedGroups,
    overviewPlan?.slots?.anchorGroups || [],
    overviewPlan?.slots?.focusObject
      ? {
          type: overviewPlan.slots.focusObject.type,
          argument: overviewPlan.slots.focusObject.value
        }
      : null
  );
  const compiledRootItems = [];
  const compiledChildPlans = [];
  const selectedCandidates = [];
  const skippedCandidates = Array.isArray(overviewPlan?.skippedCandidates)
    ? overviewPlan.skippedCandidates.map((item) => ({ ...item }))
    : [];

  const selectedRoots = Array.isArray(overviewPlan?.selectedRootCandidates) ? overviewPlan.selectedRootCandidates : [];
  const selectedChildren = Array.isArray(overviewPlan?.selectedChildCandidates) ? overviewPlan.selectedChildCandidates : [];

  for (const selection of selectedRoots) {
    const candidate = selection.candidate;
    const candidateReview = metadataReview?.byCandidateId?.[candidate.id] || null;
    const query = buildBaseQueryFromCandidate(candidate, timeRange, anchorSeedGroups, overviewPlan.slots, candidateReview);
    compiledRootItems.push({
      planId: candidate.id,
      candidateId: candidate.id,
      label: candidate.label,
      role: candidate.role,
      score: selection.score,
      scoreReasons: selection.scoreReasons,
      candidate,
      query,
      childPlans: []
    });
    selectedCandidates.push({
      candidateId: candidate.id,
      label: candidate.label,
      role: candidate.role,
      score: selection.score,
      scoreReasons: selection.scoreReasons,
      planId: candidate.id
    });
  }

  for (const selection of selectedChildren) {
    const candidate = selection.candidate;
    const parentItem = compiledRootItems.find((item) => item.candidateId === selection.parentCandidateId);
    if (!parentItem) {
      skippedCandidates.push({
        candidateId: candidate.id,
        label: candidate.label,
        role: candidate.role,
        parentCandidateId: selection.parentCandidateId,
        reason: 'dependency_missing_at_compile',
        details: null
      });
      continue;
    }

    const candidateReview = metadataReview?.byCandidateId?.[candidate.id] || null;
    const querySeed = buildBaseQueryFromCandidate(candidate, timeRange, anchorSeedGroups, overviewPlan.slots, candidateReview);
    compiledChildPlans.push({
      planId: `${parentItem.candidateId}:${candidate.id}`,
      candidateId: candidate.id,
      parentCandidateId: parentItem.candidateId,
      label: candidate.label,
      role: candidate.role,
      score: selection.score,
      scoreReasons: selection.scoreReasons,
      candidate,
      querySeed,
      deriveArgument: deepClone(candidate.deriveArgument || {}),
      recommendedMaxChildren: Number(candidate.recommendedMaxChildren || 1)
    });
  }

  compiledChildPlans.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const allocations = buildChildBudgetAllocations(compiledChildPlans, Number(overviewPlan?.budget?.maxChildren || 0));

  for (const childPlan of compiledChildPlans) {
    const allocated = allocations.get(childPlan.planId) || 0;
    if (allocated <= 0) {
      skippedCandidates.push({
        candidateId: childPlan.candidateId,
        label: childPlan.label,
        role: childPlan.role,
        parentCandidateId: childPlan.parentCandidateId,
        reason: 'child_budget_not_allocated',
        details: { maxChildren: overviewPlan?.budget?.maxChildren || 0 }
      });
      continue;
    }

    const parentItem = compiledRootItems.find((item) => item.candidateId === childPlan.parentCandidateId);
    if (!parentItem) {
      continue;
    }

    parentItem.childPlans.push({
      ...childPlan,
      maxChildQueries: allocated
    });
    selectedCandidates.push({
      candidateId: childPlan.candidateId,
      label: childPlan.label,
      role: childPlan.role,
      parentCandidateId: childPlan.parentCandidateId,
      score: childPlan.score,
      scoreReasons: childPlan.scoreReasons,
      planId: childPlan.planId,
      maxChildQueries: allocated
    });
  }

  return {
    scene: overviewPlan.scene,
    depth: overviewPlan.depth,
    budget: { ...overviewPlan.budget },
    planningPolicy: overviewPlan.planningPolicy,
    slots: overviewPlan.slots,
    selectedCandidates,
    skippedCandidates,
    executionItems: compiledRootItems
  };
}

module.exports = {
  compileOverviewPlan,
  buildBaseQueryFromCandidate,
  buildGroupsFromCandidate,
  applySeedAnchorIfNeeded,
  buildSeedGroups
};
