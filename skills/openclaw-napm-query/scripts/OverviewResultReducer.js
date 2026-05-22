/**
 * OverviewResultReducer.js
 *
 * 负责把 overview 执行结果压缩成最终概览对象和摘要。
 * 它会把 executionItems 转成 modules、topFindings、overview summary 和 displayText，
 * 让上层可以直接拿去渲染或转成 narration contract。
 */
function formatOverviewTimeRange(overview) {
  const start = Number(overview?.start || 0);
  const end = Number(overview?.end || 0);
  if (!start || !end || end <= start) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  return `数据时间：${formatter.format(new Date(start * 1000))} 至 ${formatter.format(new Date(end * 1000))}`;
}

// 生成概览类展示文本，优先突出时间范围、重点对象和模块摘要。
function buildOverviewDisplayText(overview) {
  const timeRangeText = formatOverviewTimeRange(overview);
  const scene = String(overview?.scene || '').trim();
  const discoveryObject = String(overview?.discovery?.selectedObject || '').trim();
  const discoveryMetric = String(overview?.discovery?.metric || '').trim();
  const sceneLabelMap = {
    system: '系统整体概览',
    business: '业务整体概览',
    business_group: '业务组整体概览',
    application: '应用整体概览',
    network: '网络整体概览',
    security: '安全整体概览'
  };
  const sceneLabel = sceneLabelMap[scene] || '整体概览';
  const successCount = Number(overview?.executionMeta?.successCount || 0);
  const failedCount = Number(overview?.executionMeta?.failedCount || 0);
  const queryCount = Number(overview?.executionMeta?.queryCount || 0);
  const modules = Array.isArray(overview?.modules) ? overview.modules : [];
  const okModules = modules.filter((item) => item?.ok);
  const topModuleSummaries = okModules
    .map((item) => String(item?.summary || '').trim())
    .filter(Boolean)
    .slice(0, 3);

  if (successCount <= 0) {
    return [
      timeRangeText,
      `${sceneLabel}已执行，但当前没有拿到可用结果。`,
      `本次共执行 ${queryCount} 个概览查询，成功 ${successCount} 个，失败 ${failedCount} 个。`,
      '建议优先检查 NAPM 上游接口与当前时间窗数据是否可用。'
    ].filter(Boolean).join('\n');
  }

  const lines = [
    timeRangeText,
    discoveryObject
      ? `本次先锁定到重点对象：${discoveryObject}${discoveryMetric ? `（依据 ${discoveryMetric}）` : ''}。`
      : null,
    `当前${sceneLabel}如下：`,
    ...topModuleSummaries
  ].filter(Boolean);

  if (topModuleSummaries.length === 0) {
    lines.push(`本次共执行 ${queryCount} 个概览查询，成功 ${successCount} 个，失败 ${failedCount} 个。`);
  }

  return lines.join('\n');
}

// 生成概览执行摘要，供最终输出和日志审计使用。
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

/**
 * 主入口：把 compiledPlan + executionResult 归并成可直接消费的 overview 结果。
 */
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
    discovery: executionResult?.discovery || null,
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
