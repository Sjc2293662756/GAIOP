const {
  isBusinessObjectType,
  getMetricCategoriesForObjectType
} = require('../../../src/constants/objectMetricOwnership');

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) {
    return String(value ?? '');
  }
  return Number(numeric.toFixed(4)).toString();
}

function formatMetricValue(value, unit = null) {
  if (value === null || value === undefined || value === '') {
    return 'no_data';
  }
  const formatted = formatNumber(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatTimestamp(timestamp) {
  const numeric = toFiniteNumber(timestamp);
  if (numeric === null) {
    return null;
  }

  const date = new Date(numeric * 1000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function normalizeTimeRange(payload = {}, summary = {}) {
  const resolvedQuery = payload?.resolvedQuery || {};
  const summaryRange = summary?.timeRange && typeof summary.timeRange === 'object'
    ? summary.timeRange
    : {};
  const hintRange = resolvedQuery?.resolutionHints?.time || {};
  const candidateRange = resolvedQuery?.candidateSpec?.hints?.time_range || {};

  const start = toFiniteNumber(
    summaryRange.start
    ?? resolvedQuery.start
    ?? hintRange.start
    ?? candidateRange.start
  );
  const end = toFiniteNumber(
    summaryRange.end
    ?? resolvedQuery.end
    ?? hintRange.end
    ?? candidateRange.end
  );

  if (start === null || end === null) {
    return null;
  }

  const key = String(
    summaryRange.key
    || resolvedQuery.timeRangeKey
    || hintRange.key
    || candidateRange.key
    || ''
  ).trim() || null;
  const startText = formatTimestamp(start);
  const endText = formatTimestamp(end);

  return {
    key,
    start,
    end,
    startText,
    endText,
    timezone: 'Asia/Shanghai',
    displayText: startText && endText
      ? `数据时间：${startText} 至 ${endText}`
      : null
  };
}

function ensureSummaryTimeRange(summary = {}, timeRange = null) {
  if (!timeRange) {
    return summary;
  }

  const nextSummary = {
    ...summary,
    timeRange
  };
  const displayText = String(timeRange.displayText || '').trim();
  if (!displayText) {
    return nextSummary;
  }

  const highlights = Array.isArray(nextSummary.highlights)
    ? nextSummary.highlights.filter(Boolean).map(item => String(item))
    : [];
  if (!highlights.some(item => item.includes(displayText))) {
    nextSummary.highlights = [displayText, ...highlights];
  } else {
    nextSummary.highlights = highlights;
  }

  return nextSummary;
}

function ensureDisplayTextTimeRange(displayText = null, timeRange = null) {
  const text = String(displayText || '').trim();
  if (!text) {
    return null;
  }

  const timeRangeText = String(timeRange?.displayText || '').trim();
  if (!timeRangeText) {
    return text;
  }

  if (text.includes(timeRangeText)) {
    return text;
  }

  return `${timeRangeText}\n${text}`;
}

function pickFirstNonEmptyValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source ? source[key] : undefined;
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' && !value.trim()) {
      continue;
    }
    return value;
  }
  return null;
}

function toPlainSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') {
    return {
      mode: null,
      title: null,
      highlights: [],
      rowCount: 0,
      empty: null
    };
  }

  return {
    mode: summary.mode || null,
    title: summary.title || null,
    highlights: Array.isArray(summary.highlights) ? summary.highlights.filter(Boolean) : [],
    rowCount: Number.isFinite(Number(summary.rowCount)) ? Number(summary.rowCount) : 0,
    empty: typeof summary.empty === 'boolean' ? summary.empty : null,
    timeRange: summary.timeRange || null
  };
}

function normalizeNarrationRows(service, rows = [], fallbackRows = []) {
  const useFallbackRows = ['groups', 'metrics'].includes(String(service || '').trim())
    && Array.isArray(fallbackRows)
    && fallbackRows.length > 0;
  const sourceRows = useFallbackRows
    ? fallbackRows
    : (Array.isArray(rows) ? rows : []);

  return sourceRows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      const text = String(row ?? '').trim() || null;
      return {
        rank: index + 1,
        object: text,
        value: text
      };
    }

    if (service === 'groups') {
      const label = pickFirstNonEmptyValue(row, [
        'label',
        'Label',
        'value',
        'Value',
        'name',
        'Name',
        'argument',
        'Argument',
        'object',
        'Object'
      ]);

      return {
        ...row,
        rank: index + 1,
        type: pickFirstNonEmptyValue(row, ['type', 'Type', 'groupType', 'GroupType']),
        label: label || null,
        object: row.object || label || null,
        value: row.value || label || null
      };
    }

    if (service === 'metrics') {
      const label = pickFirstNonEmptyValue(row, ['label', 'Label', 'name', 'Name']);
      const metricId = pickFirstNonEmptyValue(row, ['id', 'Id', 'metric', 'Metric']);
      return {
        ...row,
        rank: index + 1,
        id: metricId || null,
        label: label || metricId || null,
        object: row.object || label || metricId || null
      };
    }

    const metricValues = Array.isArray(row.metricValues) ? row.metricValues : [];
    const firstMetricValue = metricValues[0] || null;
    const primaryMetricId = pickFirstNonEmptyValue(firstMetricValue?.metric, ['id', 'Id']);
    const primaryUnit = pickFirstNonEmptyValue(firstMetricValue, ['unit', 'Unit']);
    const primaryValue = pickFirstNonEmptyValue(firstMetricValue, ['value', 'Value']);
    const groupArgument = pickFirstNonEmptyValue(row?.group, ['argument', 'Argument', 'label', 'Label', 'key', 'Key']);

    return {
      ...row,
      rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
      object: row.object || groupArgument || row.groupPath || null,
      value: row.value ?? primaryValue ?? null,
      rawValue: row.rawValue ?? primaryValue ?? null,
      metric: row.metric || primaryMetricId || null,
      unit: row.unit || primaryUnit || null
    };
  });
}

function extractMetricId(payload = {}) {
  const resolvedQuery = payload?.resolvedQuery || {};
  const summaryMetrics = Array.isArray(payload?.summary?.metrics) ? payload.summary.metrics : [];
  return String(
    resolvedQuery.metric
    || summaryMetrics[0]
    || resolvedQuery.topMetric
    || (Array.isArray(resolvedQuery.metrics) ? resolvedQuery.metrics[0] : '')
    || ''
  ).trim() || null;
}

function extractSortMetricId(payload = {}) {
  const resolvedQuery = payload?.resolvedQuery || {};
  const summaryTopMetric = String(payload?.summary?.topMetric || '').trim();
  return String(
    resolvedQuery.topMetric
    || summaryTopMetric
    || resolvedQuery.metric
    || (Array.isArray(resolvedQuery.metrics) ? resolvedQuery.metrics[0] : '')
    || ''
  ).trim() || null;
}

function extractMetricValue(row, metricId = null) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const metricValues = Array.isArray(row.metricValues) ? row.metricValues : [];
  if (metricValues.length > 0) {
    const exactMetric = metricValues.find((item) => {
      const currentMetricId = String(item?.metric?.id || item?.metric?.Id || '').trim();
      return metricId ? currentMetricId === metricId : Boolean(currentMetricId);
    });
    const fallbackMetric = exactMetric || metricValues[0];
    const metricValue = toFiniteNumber(fallbackMetric?.value ?? fallbackMetric?.Value);
    if (metricValue !== null) {
      return metricValue;
    }
  }

  if (metricId && row?.values && typeof row.values === 'object' && Object.prototype.hasOwnProperty.call(row.values, metricId)) {
    return toFiniteNumber(row.values[metricId]);
  }
  if (metricId && row?.metric === metricId) {
    return toFiniteNumber(row.value);
  }
  if (metricId && Object.prototype.hasOwnProperty.call(row, metricId)) {
    return toFiniteNumber(row[metricId]);
  }
  return toFiniteNumber(row?.rawValue ?? row?.value);
}

function normalizeFollowUpPrompts(payload = {}) {
  return (Array.isArray(payload?.followUpActions) ? payload.followUpActions : [])
    .map((item) => String(item?.query || item?.replyText || item?.label || item?.value || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function resolveResponseType(payload = {}, hasResultData = false) {
  const explicit = String(payload?.responseType || '').trim();
  if (explicit) {
    return explicit;
  }

  if (payload?.compareResult) {
    return 'compare';
  }
  if (payload?.overview && typeof payload.overview === 'object') {
    return 'overview';
  }

  const service = String(payload?.service || payload?.resolvedQuery?.service || '').trim();
  if (service === 'topValues') return 'topn';
  if (service === 'timeValues') return 'trend';
  if (service === 'metrics') return 'metric_list';
  if (service === 'groups') return 'group_list';
  if (service === 'averageValues') return 'query';
  return hasResultData ? 'query' : 'decision_result';
}

function buildTopnStructure(payload, rows, followUpPrompts) {
  const metricId = extractMetricId(payload);
  const sortMetricId = extractSortMetricId(payload);
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const objectType = String(payload?.resolvedQuery?.groups?.[0]?.type || '').trim() || null;
  const explanationMetricText = metricId && sortMetricId && metricId !== sortMetricId
    ? `查询指标为 ${metricId}，排序指标为 ${sortMetricId}`
    : (metricId ? `围绕 ${metricId} 指标` : null);
  return {
    responseType: 'topn',
    title: payload?.summary?.title || '排行结果',
    explanation: objectType && explanationMetricText
      ? `这是按 ${objectType} 维度返回的排行结果，${explanationMetricText}。请直接概括前列对象、领先程度和明显差距。`
      : '这是一个排行结果。请直接概括前列对象、领先程度和明显差距。',
    timeRange,
    items: rows.slice(0, 10).map((row, index) => ({
      rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
      object: row?.object || `object_${index + 1}`,
      metric: metricId,
      rawValue: extractMetricValue(row, metricId),
      value: row?.value || formatMetricValue(
        extractMetricValue(row, metricId),
        row?.units?.[metricId] || row?.unit || null
      ),
      unit: row?.units?.[metricId] || row?.unit || null
    })),
    nextActions: followUpPrompts
  };
}

function buildTrendStructure(payload, rows, structuredSeries, followUpPrompts) {
  const metricId = extractMetricId(payload);
  const points = Array.isArray(structuredSeries?.points) ? structuredSeries.points : rows;
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  return {
    responseType: 'trend',
    title: payload?.summary?.title || '趋势结果',
    explanation: points.length > 0
      ? `这是一个时间趋势结果，共 ${points.length} 个时间点。请概括整体走势、峰值、低谷和最新值。`
      : '这是一个时间趋势结果，但当前时间范围内没有返回有效时间点。',
    metric: metricId,
    timeRange,
    pointCount: points.length,
    firstPoint: points[0] || null,
    lastPoint: points.length > 0 ? points[points.length - 1] : null,
    nextActions: followUpPrompts
  };
}

function buildPreviewText(preview = [], limit = 3) {
  return (Array.isArray(preview) ? preview.slice(0, limit) : [])
    .map((item) => String(item?.object || '').trim())
    .filter(Boolean)
    .join('、');
}

function findOverviewModule(modules = [], key) {
  return Array.isArray(modules)
    ? modules.find((item) => String(item?.key || '').trim() === key) || null
    : null;
}

function buildApplicationOverviewSummary(modules = []) {
  const lines = [];

  const alertModule = findOverviewModule(modules, 'applicationAlertSummary');
  if (alertModule?.summary) {
    const topApps = buildPreviewText(alertModule.preview, 3);
    if (topApps) {
      lines.push(`今天应用侧告警较多，重点涉及 ${topApps}。`);
    } else {
      lines.push(String(alertModule.summary).trim());
    }
  }

  const throughputModule = findOverviewModule(modules, 'topApplicationThroughput');
  if (throughputModule?.preview?.length) {
    const [top1, top2, top3] = throughputModule.preview;
    const names = [top1?.object, top2?.object, top3?.object]
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (names.length > 0) {
      const leadValue = String(top1?.valueText || '').trim();
      lines.push(
        leadValue
          ? `当前流量主要集中在 ${names.join('、')}，其中 ${top1.object} 吞吐最高，约 ${leadValue}。`
          : `当前流量主要集中在 ${names.join('、')}。`
      );
    }
  }

  const accessModule = findOverviewModule(modules, 'appAccessTrend');
  const experienceModule = findOverviewModule(modules, 'appExperienceTrend');
  if (accessModule?.summary || experienceModule?.summary) {
    const accessText = String(accessModule?.summary || '').trim().replace(/^应用访问趋势：?/, '');
    const experienceText = String(experienceModule?.summary || '').trim().replace(/^应用体验趋势：?/, '');
    if (accessText && experienceText) {
      lines.push(`访问与体验方面，${accessText}；${experienceText}。`);
    } else if (accessText) {
      lines.push(`访问情况方面，${accessText}。`);
    } else if (experienceText) {
      lines.push(`体验情况方面，${experienceText}。`);
    }
  }

  const failureModule = findOverviewModule(modules, 'appFailureTop');
  if (failureModule?.preview?.length) {
    const failureApps = buildPreviewText(failureModule.preview, 3);
    if (failureApps) {
      lines.push(`失败量靠前的应用主要是 ${failureApps}，建议优先关注这些对象。`);
    }
  }

  return lines.slice(0, 4);
}

function buildOverviewStructure(payload, followUpPrompts) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const scene = String(payload?.overview?.scene || '').trim();
  const discovery = payload?.overview?.discovery && typeof payload.overview.discovery === 'object'
    ? payload.overview.discovery
    : null;
  const discoveryObject = String(discovery?.selectedObject || '').trim();
  const discoveryMetric = String(discovery?.metric || '').trim();
  const sceneLabelMap = {
    system: '????',
    business: '????',
    business_group: '?????',
    application: '????',
    network: '????',
    security: '????'
  };
  const sceneLabel = sceneLabelMap[scene] || '????';
  const overviewQueries = Array.isArray(payload?.overview?.queries) ? payload.overview.queries : [];
  const summaryHighlights = Array.isArray(payload?.summary?.highlights)
    ? payload.summary.highlights.filter(Boolean).map((item) => String(item))
    : [];
  const topFindings = Array.isArray(payload?.overview?.topFindings)
    ? payload.overview.topFindings.filter(Boolean).map((item) => String(item))
    : [];
  const modules = Array.isArray(payload?.overview?.modules)
    ? payload.overview.modules.map((item) => ({
      key: item?.key || null,
      label: item?.label || item?.key || null,
      ok: item?.ok !== false,
      rowCount: Number.isFinite(Number(item?.rowCount)) ? Number(item.rowCount) : 0,
      summary: item?.summary || null,
      preview: Array.isArray(item?.preview) ? item.preview.slice(0, 3) : []
    }))
    : [];
  const applicationSummary = scene === 'application'
    ? buildApplicationOverviewSummary(modules)
    : [];
  const keyFindings = applicationSummary.length > 0
    ? applicationSummary
    : [...summaryHighlights, ...topFindings].slice(0, 8);
  const explanation = scene === 'application'
    ? '?????????????????????????????????????'
    : '??' + sceneLabel + '??????????????????????????????';

  return {
    responseType: 'overview',
    title: sceneLabel + '??',
    explanation,
    timeRange,
    scene,
    sceneLabel,
    discovery: discoveryObject
      ? {
          object: discoveryObject,
          metric: discoveryMetric || null,
          rank: Number.isFinite(Number(discovery?.rank)) ? Number(discovery.rank) : 1,
          targetObjectType: discovery?.targetObjectType || null
        }
      : null,
    queryCount: overviewQueries.length,
    summary: keyFindings,
    modules,
    nextActions: followUpPrompts.length > 0
      ? followUpPrompts
      : (Array.isArray(payload?.overview?.nextActions) ? payload.overview.nextActions.slice(0, 6) : [])
  };
}
function buildCompareStructure(payload, followUpPrompts) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  return {
    responseType: 'compare',
    title: payload?.summary?.title || '对比结果',
    explanation: '这是一个对比结果。请直接概括谁更高、差距多大，以及是否存在明显异常。',
    timeRange,
    compare: payload?.compareResult || null,
    nextActions: followUpPrompts
  };
}

function buildListStructure(payload, rows, followUpPrompts, responseType, labelKey) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const listTypeLabel = responseType === 'group_list' ? '对象列表' : '指标列表';
  const objectType = String(payload?.resolvedQuery?.groups?.[0]?.type || '').trim() || null;
  const itemIds = rows.map((row) => String(row?.id || '').trim()).filter(Boolean);
  const sampleMetricIds = itemIds.slice(0, 12);
  const businessOwnedMetricList = sampleMetricIds.join('、');
  const businessCategoryText = getMetricCategoriesForObjectType(objectType).join('、');

  const explanation = (() => {
    if (rows.length === 0) {
      return `这是一个${listTypeLabel}，但当前没有返回有效结果。`;
    }

    if (responseType === 'metric_list' && isBusinessObjectType(objectType)) {
      return `这是 ${objectType} 视角的指标列表。最终回答只能基于已返回的指标项来总结，归属口径为 ${businessCategoryText || '业务类指标'}。可以围绕业务网络、业务访问、业务性能、响应代码和页面优化来总结，不要提及列表里未出现的非业务类网络指标，包括丢包、RTT、重传、吞吐、网络连接或告警类宣称。当前返回的代表指标包括：${businessOwnedMetricList || '见结果列表'}。`;
    }

    if (responseType === 'metric_list') {
      return `这是一个${listTypeLabel}，请优先基于已返回的指标项来总结，不要扩展到列表中没有出现的其他指标类别。`;
    }

    return `这是一个${listTypeLabel}，请优先概括总数、代表性对象，以及是否更像业务系统列表还是协议类列表。`;
  })();

  return {
    responseType,
    title: payload?.summary?.title || listTypeLabel,
    explanation,
    timeRange,
    items: rows.slice(0, 20).map((row, index) => ({
      rank: index + 1,
      value: row?.[labelKey] || row?.object || row?.value || null,
      type: row?.type || null,
      id: row?.id || null
    })),
    nextActions: followUpPrompts
  };
}

function buildGenericStructure(payload, rows, followUpPrompts) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  return {
    responseType: 'query',
    title: payload?.summary?.title || '查询结果',
    explanation: rows.length > 0
      ? '这是一个普通查询结果。请结合时间范围、指标和值直接说结论，不要复述机器状态。'
      : '这是一个普通查询结果，但当前没有返回数据。请明确说明查询范围、时间范围和未命中的事实。',
    timeRange,
    summary: Array.isArray(payload?.summary?.highlights) ? payload.summary.highlights.slice(0, 8) : [],
    rowCount: rows.length,
    nextActions: followUpPrompts
  };
}

function buildDecisionStructure(payload, followUpPrompts) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  return {
    responseType: 'decision_result',
    title: payload?.summary?.title || '处理结果',
    explanation: payload?.displayText || payload?.replyText || payload?.summary?.displayText || null,
    timeRange,
    nextActions: followUpPrompts
  };
}

function buildNarrationStructure(payload = {}, rows = [], structuredRows = [], structuredSeries = null) {
  const followUpPrompts = normalizeFollowUpPrompts(payload);
  const responseType = resolveResponseType(
    payload,
    rows.length > 0 || structuredRows.length > 0 || Boolean(structuredSeries) || Boolean(payload?.overview)
  );

  if (responseType === 'topn') {
    return buildTopnStructure(payload, rows.length > 0 ? rows : structuredRows, followUpPrompts);
  }
  if (responseType === 'trend') {
    return buildTrendStructure(payload, rows, structuredSeries, followUpPrompts);
  }
  if (responseType === 'overview') {
    return buildOverviewStructure(payload, followUpPrompts);
  }
  if (responseType === 'compare') {
    return buildCompareStructure(payload, followUpPrompts);
  }
  if (responseType === 'metric_list') {
    return buildListStructure(payload, structuredRows.length > 0 ? structuredRows : rows, followUpPrompts, 'metric_list', 'label');
  }
  if (responseType === 'group_list') {
    return buildListStructure(payload, structuredRows.length > 0 ? structuredRows : rows, followUpPrompts, 'group_list', 'label');
  }
  if (responseType === 'decision_result') {
    return buildDecisionStructure(payload, followUpPrompts);
  }
  return buildGenericStructure(payload, rows, followUpPrompts);
}

function buildRenderPolicy(payload = {}) {
  return {
    language: 'zh-CN',
    narrationRequired: true,
    target: 'final_user_reply',
    responseType: resolveResponseType(payload, true),
    preferSources: [
      'result.narrationStructure',
      'summary',
      'result.structuredRows',
      'result.rows',
      'result.structuredSeries',
      'result.overview'
    ],
    fallbackSources: [
      'displayText',
      'replyText'
    ],
    rules: [
      'Prefer narrationStructure for final wording.',
      'Always include result timeRange/displayText when present.',
      'Use summary and structured result data before raw rows.',
      'Only fall back to displayText when verbatim forwarding is requested.'
    ]
  };
}

function buildOpenClawReplyContract(data = {}, options = {}) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  let summary = data.summary && typeof data.summary === 'object'
    ? { ...data.summary }
    : {};
  const timeRange = normalizeTimeRange(data, summary);
  summary = ensureSummaryTimeRange(summary, timeRange);
  const requestUrl = String(
    data.requestUrl
    || summary.requestUrl
    || ''
  ).trim() || null;
  const includeRequestUrl = options.includeRequestUrl === true;

  const rawDisplayText = String(
    data.replyText
    || data.displayText
    || summary.displayText
    || ''
  ).trim() || null;
  const fallbackDisplayText = typeof options.defaultDisplayTextBuilder === 'function'
    ? String(options.defaultDisplayTextBuilder(summary, data) || '').trim() || null
    : null;
  const computedDisplayText = ensureDisplayTextTimeRange(
    rawDisplayText || fallbackDisplayText,
    timeRange
  );
  const forwardDisplayText = Boolean(options.forwardDisplayText);
  const displayText = forwardDisplayText
    ? (
        typeof options.appendRequestUrlToDisplayText === 'function'
          ? options.appendRequestUrlToDisplayText(computedDisplayText, requestUrl)
          : computedDisplayText
      ) || null
    : null;

  if (displayText) {
    summary.displayText = displayText;
  } else if (Object.prototype.hasOwnProperty.call(summary, 'displayText')) {
    delete summary.displayText;
  }
  if (includeRequestUrl && requestUrl) {
    summary.requestUrl = requestUrl;
  } else if (Object.prototype.hasOwnProperty.call(summary, 'requestUrl')) {
    delete summary.requestUrl;
  }

  const service = data.service || data?.resolvedQuery?.service || null;
  const rawRows = Array.isArray(data.rows)
    ? data.rows
    : (Array.isArray(data.data) ? data.data : []);
  const rawStructuredRows = Array.isArray(data.structuredRows) ? data.structuredRows : [];
  const rows = normalizeNarrationRows(service, rawRows, rawStructuredRows);
  const structuredRows = normalizeNarrationRows(service, rawStructuredRows);
  const structuredSeries = data.structuredSeries && typeof data.structuredSeries === 'object'
    ? data.structuredSeries
    : null;
  const enrichedRows = Array.isArray(data.enrichedRows) ? data.enrichedRows : [];
  const hasResultData = rows.length > 0 || structuredRows.length > 0 || Boolean(structuredSeries) || Boolean(data.overview);
  const narrationStructure = data.narrationStructure && typeof data.narrationStructure === 'object'
    ? data.narrationStructure
    : buildNarrationStructure(data, rows, structuredRows, structuredSeries);
  const followUpPrompts = normalizeFollowUpPrompts(data);

  return {
    ...data,
    summary,
    displayText,
    replyText: displayText,
    responseMode: displayText ? 'verbatim_display_text' : 'machine_narration_input',
    narrationBy: 'openclaw',
    narrationStructure,
    narrationInput: {
      schema: 'openclaw_napm_narration.v1',
      narrationBy: 'openclaw',
      narrationRequired: true,
      type: hasResultData ? 'query_result' : 'decision_result',
      service,
      responseType: data.responseType || narrationStructure?.responseType || null,
      decision: data.assistantDecision || data.decision || null,
      intent: data.intentResult || data.intent || null,
      resolvedQuery: data.resolvedQuery || null,
      request: {
        requestUrl: includeRequestUrl ? requestUrl : null,
        requestParamsJson: data.requestParamsJson || summary.requestParamsJson || null,
        timeRange
      },
      summary: toPlainSummary(summary),
      result: {
        timeRange,
        rows,
        structuredRows,
        structuredSeries,
        enrichedRows,
        compareResult: data.compareResult || null,
        overview: data.overview || null,
        narrationStructure
      },
      followUp: {
        prompts: followUpPrompts,
        actions: Array.isArray(data.followUpActions) ? data.followUpActions : []
      },
      renderPolicy: buildRenderPolicy({
        ...data,
        responseType: data.responseType || narrationStructure?.responseType || null
      })
    }
  };
}

module.exports = {
  buildOpenClawReplyContract,
  buildNarrationStructure,
  normalizeNarrationRows,
  toPlainSummary
};
