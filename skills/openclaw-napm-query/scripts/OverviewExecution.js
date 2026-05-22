/**
 * OverviewExecution.js
 *
 * 负责执行已经编译完成的 overview plan。
 * 它会按预算串行执行 root query，并在允许时继续派生 child query，
 * 同时统计执行结果、跳过原因和整体耗时信息。
 */
function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

/**
 * 执行单条 query，并在失败时按预算进行有限重试。
 */
async function executeSingleQuery(query, executeGatewayRequest, retries = 0) {
  let attempts = 0;
  let lastError = null;
  while (attempts <= retries) {
    attempts += 1;
    try {
      const result = await executeGatewayRequest(query);
      return {
        ok: Boolean(result?.ok),
        service: result?.service || query.service,
        data: Array.isArray(result?.data) ? result.data : [],
        requestUrl: result?.requestUrl || null,
        error: result?.error || null,
        attempts
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    service: query.service,
    data: [],
    requestUrl: null,
    error: {
      code: 'OVERVIEW_QUERY_EXECUTION_ERROR',
      message: lastError?.message || 'Unknown overview execution error'
    },
    attempts
  };
}

// 根据 child plan 的 deriveArgument 配置，推断它要从父结果里抽取哪一类对象值。
function buildChildArgumentTargetType(childPlan) {
  const targetParam = String(childPlan?.deriveArgument?.targetParam || '').trim();
  const groups = Array.isArray(childPlan?.querySeed?.groups) ? childPlan.querySeed.groups : [];
  const match = targetParam.match(/^groupArgument(\d+)$/i);
  if (match) {
    const index = Number(match[1]) - 1;
    return groups[index]?.type || null;
  }
  return groups[0]?.type || null;
}

// 判断概览执行是否已经超出当前预算设定的总超时时间。
function isTimeoutExceeded(startedAt, timeoutMs) {
  return timeoutMs > 0 && (Date.now() - startedAt) >= timeoutMs;
}

/**
 * 主入口：执行编译好的 overview plan，并返回结构化执行结果。
 */
async function executeOverviewPlan({
  compiledPlan,
  executeGatewayRequest,
  extractTopGroupValues,
  applyArgumentByTargetParam
} = {}) {
  if (typeof executeGatewayRequest !== 'function') {
    throw new Error('executeOverviewPlan requires executeGatewayRequest function');
  }

  const startedAt = Date.now();
  const budget = compiledPlan?.budget || {};
  const warnings = [];
  const runtimeSkipped = [];
  const executionItems = [];
  let queryCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let remainingChildBudget = Number(budget.maxChildren || 0);

  for (const executionItem of compiledPlan?.executionItems || []) {
    if (isTimeoutExceeded(startedAt, Number(budget.timeoutMs || 0))) {
      runtimeSkipped.push({
        candidateId: executionItem.candidateId,
        label: executionItem.label,
        role: executionItem.role,
        reason: 'timeout_budget_exceeded',
        details: { timeoutMs: budget.timeoutMs }
      });
      continue;
    }

    const rootResult = await executeSingleQuery(
      executionItem.query,
      executeGatewayRequest,
      Number(budget.maxRetriesPerQuery || 0)
    );
    queryCount += 1;
    if (rootResult.ok) {
      successCount += 1;
    } else {
      failedCount += 1;
      warnings.push(`overview root query failed: ${executionItem.candidateId}`);
    }

    const rootExecution = {
      key: executionItem.candidateId,
      planId: executionItem.planId,
      candidateId: executionItem.candidateId,
      label: executionItem.label,
      role: executionItem.role,
      params: executionItem.query,
      ok: rootResult.ok,
      service: rootResult.service,
      requestUrl: rootResult.requestUrl,
      rowCount: Array.isArray(rootResult.data) ? rootResult.data.length : 0,
      error: rootResult.error || null,
      data: rootResult.data,
      children: []
    };

    if (!rootResult.ok && Array.isArray(executionItem.childPlans)) {
      executionItem.childPlans.forEach((childPlan) => {
        runtimeSkipped.push({
          candidateId: childPlan.candidateId,
          label: childPlan.label,
          role: childPlan.role,
          parentCandidateId: childPlan.parentCandidateId,
          reason: 'parent_query_failed',
          details: null
        });
      });
    }

    if (rootResult.ok && Array.isArray(executionItem.childPlans) && executionItem.childPlans.length > 0) {
      for (const childPlan of executionItem.childPlans) {
        if (remainingChildBudget <= 0) {
          runtimeSkipped.push({
            candidateId: childPlan.candidateId,
            label: childPlan.label,
            role: childPlan.role,
            parentCandidateId: childPlan.parentCandidateId,
            reason: 'child_budget_exhausted',
            details: null
          });
          continue;
        }

        if (isTimeoutExceeded(startedAt, Number(budget.timeoutMs || 0))) {
          runtimeSkipped.push({
            candidateId: childPlan.candidateId,
            label: childPlan.label,
            role: childPlan.role,
            parentCandidateId: childPlan.parentCandidateId,
            reason: 'timeout_budget_exceeded',
            details: { timeoutMs: budget.timeoutMs }
          });
          continue;
        }

        const targetType = buildChildArgumentTargetType(childPlan);
        const groupValues = extractTopGroupValues(
          rootResult.data,
          targetType,
          executionItem.query.metrics || [executionItem.query.metric],
          Math.min(Number(childPlan.maxChildQueries || 0), remainingChildBudget)
        );

        if (!Array.isArray(groupValues) || groupValues.length === 0) {
          runtimeSkipped.push({
            candidateId: childPlan.candidateId,
            label: childPlan.label,
            role: childPlan.role,
            parentCandidateId: childPlan.parentCandidateId,
            reason: 'no_derived_groups',
            details: { sourceCandidateId: executionItem.candidateId }
          });
          continue;
        }

        for (const groupValue of groupValues.slice(0, Math.min(Number(childPlan.maxChildQueries || 0), remainingChildBudget))) {
          if (isTimeoutExceeded(startedAt, Number(budget.timeoutMs || 0))) {
            runtimeSkipped.push({
              candidateId: childPlan.candidateId,
              label: childPlan.label,
              role: childPlan.role,
              parentCandidateId: childPlan.parentCandidateId,
              reason: 'timeout_budget_exceeded',
              details: { timeoutMs: budget.timeoutMs }
            });
            break;
          }

          const childQuery = deepClone(childPlan.querySeed);
          applyArgumentByTargetParam(
            childQuery.groups,
            childPlan?.deriveArgument?.targetParam || 'groupArgument1',
            groupValue
          );

          const childResult = await executeSingleQuery(
            childQuery,
            executeGatewayRequest,
            Number(budget.maxRetriesPerQuery || 0)
          );
          queryCount += 1;
          remainingChildBudget -= 1;
          if (childResult.ok) {
            successCount += 1;
          } else {
            failedCount += 1;
            warnings.push(`overview child query failed: ${childPlan.candidateId}(${groupValue})`);
          }

          rootExecution.children.push({
            key: childPlan.candidateId,
            planId: childPlan.planId,
            candidateId: childPlan.candidateId,
            label: childPlan.label,
            mode: 'child',
            parentCandidateId: childPlan.parentCandidateId,
            argumentValue: groupValue,
            params: childQuery,
            ok: childResult.ok,
            service: childResult.service,
            requestUrl: childResult.requestUrl,
            rowCount: Array.isArray(childResult.data) ? childResult.data.length : 0,
            error: childResult.error || null,
            data: childResult.data
          });
        }
      }
    }

    executionItems.push(rootExecution);
  }

  return {
    scene: compiledPlan?.scene || null,
    depth: compiledPlan?.depth || null,
    selectedCandidates: Array.isArray(compiledPlan?.selectedCandidates) ? compiledPlan.selectedCandidates.slice() : [],
    skippedCandidates: [
      ...(Array.isArray(compiledPlan?.skippedCandidates) ? compiledPlan.skippedCandidates : []),
      ...runtimeSkipped
    ],
    executionItems,
    warnings,
    executionMeta: {
      queryCount,
      successCount,
      failedCount,
      childBudgetUsed: Number(budget.maxChildren || 0) - remainingChildBudget,
      remainingChildBudget,
      durationMs: Date.now() - startedAt,
      timeoutMs: Number(budget.timeoutMs || 0)
    }
  };
}

module.exports = {
  executeOverviewPlan
};
