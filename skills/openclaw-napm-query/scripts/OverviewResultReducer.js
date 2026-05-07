function buildOverviewDisplayText(overview) {
  const lines = [
    '[OpenClaw overview execution completed]',
    `scene=${overview.scene}, depth=${overview.depth}, time=${overview.start}~${overview.end}`,
    `selected=${Array.isArray(overview.selectedCandidates) ? overview.selectedCandidates.length : 0}, skipped=${Array.isArray(overview.skippedCandidates) ? overview.skippedCandidates.length : 0}`,
    `queries=${overview.executionMeta.queryCount}, success=${overview.executionMeta.successCount}, failed=${overview.executionMeta.failedCount}`
  ];

  const modules = Array.isArray(overview.modules) ? overview.modules : [];
  modules.forEach((moduleItem, index) => {
    lines.push(`${index + 1}. ${moduleItem.key} ${moduleItem.ok ? 'ok' : 'failed'} rows=${moduleItem.rowCount || 0}`);
  });

  return lines.join('\n');
}

function buildOverviewSummary(overview) {
  return {
    mode: 'GO_OVERVIEW_QUERY',
    title: `Overview scene ${overview.scene} executed`,
    highlights: [
      `scene=${overview.scene}`,
      `depth=${overview.depth}`,
      `selected=${Array.isArray(overview.selectedCandidates) ? overview.selectedCandidates.length : 0}`,
      `queries=${overview.executionMeta.queryCount}`,
      `success=${overview.executionMeta.successCount}`,
      `failed=${overview.executionMeta.failedCount}`
    ],
    topFindings: Array.isArray(overview.topFindings) ? overview.topFindings.slice(0, 12) : [],
    overview,
    displayText: buildOverviewDisplayText(overview)
  };
}

function reduceOverviewResults({
  scene,
  depth,
  timeRange,
  overviewPlan,
  compiledPlan,
  executionResult,
  buildOverviewModuleInsight
} = {}) {
  const modules = [];
  const topFindings = [];

  for (const executionItem of executionResult?.executionItems || []) {
    const candidateSelection = (compiledPlan?.selectedCandidates || []).find((item) => item.planId === executionItem.planId);
    const moduleInsight = buildOverviewModuleInsight({
      candidateId: executionItem.candidateId,
      label: executionItem.label,
      service: executionItem.service || executionItem.params?.service || null,
      metrics: executionItem.params?.metrics || [],
      topMetric: executionItem.params?.topMetric || executionItem.params?.metric || null
    }, executionItem.data);

    const moduleItem = {
      key: executionItem.candidateId,
      label: executionItem.label,
      ok: executionItem.ok,
      rowCount: executionItem.rowCount,
      summary: executionItem.ok ? moduleInsight.summary : `${executionItem.label} 执行失败`,
      preview: executionItem.ok ? moduleInsight.preview : [],
      score: candidateSelection?.score || null,
      children: Array.isArray(executionItem.children)
        ? executionItem.children.map((child) => ({
            key: child.candidateId,
            label: child.label,
            ok: child.ok,
            rowCount: child.rowCount,
            argumentValue: child.argumentValue,
            summary: child.ok ? `${child.label} ${child.argumentValue || ''}`.trim() : `${child.label} 执行失败`
          }))
        : []
    };

    modules.push(moduleItem);
    if (executionItem.ok && moduleInsight.summary) {
      topFindings.push(moduleInsight.summary);
    }
  }

  const overview = {
    intent: 'overview',
    scene,
    depth,
    start: timeRange.start,
    end: timeRange.end,
    selectedCandidates: Array.isArray(compiledPlan?.selectedCandidates) ? compiledPlan.selectedCandidates.slice() : [],
    skippedCandidates: Array.isArray(executionResult?.skippedCandidates) ? executionResult.skippedCandidates.slice() : [],
    modules,
    queries: Array.isArray(executionResult?.executionItems) ? executionResult.executionItems.slice() : [],
    warnings: Array.isArray(executionResult?.warnings) ? executionResult.warnings.slice() : [],
    topFindings,
    executionMeta: {
      queryCount: Number(executionResult?.executionMeta?.queryCount || 0),
      successCount: Number(executionResult?.executionMeta?.successCount || 0),
      failedCount: Number(executionResult?.executionMeta?.failedCount || 0),
      durationMs: Number(executionResult?.executionMeta?.durationMs || 0),
      timeoutMs: Number(executionResult?.executionMeta?.timeoutMs || 0),
      childBudgetUsed: Number(executionResult?.executionMeta?.childBudgetUsed || 0),
      remainingChildBudget: Number(executionResult?.executionMeta?.remainingChildBudget || 0)
    },
    renderPolicy: {
      allowPartialResult: true
    },
    planning: {
      budget: compiledPlan?.budget || overviewPlan?.budget || null,
      planningPolicy: overviewPlan?.planningPolicy || null,
      slots: overviewPlan?.slots || null
    }
  };

  return {
    overview,
    summary: buildOverviewSummary(overview)
  };
}

module.exports = {
  reduceOverviewResults
};
