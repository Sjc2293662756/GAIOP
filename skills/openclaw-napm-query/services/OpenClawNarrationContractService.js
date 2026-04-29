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
    empty: typeof summary.empty === 'boolean' ? summary.empty : null
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
    || resolvedQuery.topMetric
    || summaryMetrics[0]
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
  return {
    responseType: 'topn',
    title: payload?.summary?.title || 'NAPM ranking results',
    explanation: payload?.summary?.title || 'Returned the current ranking result.',
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
  return {
    responseType: 'trend',
    title: payload?.summary?.title || 'NAPM trend results',
    explanation: points.length > 0
      ? `Returned ${points.length} trend points.`
      : 'No trend points were returned.',
    metric: metricId,
    pointCount: points.length,
    firstPoint: points[0] || null,
    lastPoint: points.length > 0 ? points[points.length - 1] : null,
    nextActions: followUpPrompts
  };
}

function buildOverviewStructure(payload, followUpPrompts) {
  return {
    responseType: 'overview',
    title: payload?.summary?.title || 'NAPM overview results',
    summary: Array.isArray(payload?.overview?.topFindings) ? payload.overview.topFindings : [],
    nextActions: followUpPrompts.length > 0
      ? followUpPrompts
      : (Array.isArray(payload?.overview?.nextActions) ? payload.overview.nextActions.slice(0, 6) : [])
  };
}

function buildCompareStructure(payload, followUpPrompts) {
  return {
    responseType: 'compare',
    title: payload?.summary?.title || 'NAPM compare results',
    explanation: payload?.summary?.title || 'Returned the compare result.',
    compare: payload?.compareResult || null,
    nextActions: followUpPrompts
  };
}

function buildListStructure(payload, rows, followUpPrompts, responseType, labelKey) {
  return {
    responseType,
    title: payload?.summary?.title || 'NAPM list results',
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
  return {
    responseType: 'query',
    title: payload?.summary?.title || 'NAPM query results',
    summary: Array.isArray(payload?.summary?.highlights) ? payload.summary.highlights.slice(0, 8) : [],
    rowCount: rows.length,
    nextActions: followUpPrompts
  };
}

function buildDecisionStructure(payload, followUpPrompts) {
  return {
    responseType: 'decision_result',
    title: payload?.summary?.title || 'NAPM decision result',
    explanation: payload?.displayText || payload?.replyText || payload?.summary?.displayText || null,
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
      'Use summary and structured result data before raw rows.',
      'Only fall back to displayText when verbatim forwarding is requested.'
    ]
  };
}

function buildOpenClawReplyContract(data = {}, options = {}) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const summary = data.summary && typeof data.summary === 'object'
    ? { ...data.summary }
    : {};
  const requestUrl = String(
    data.requestUrl
    || summary.requestUrl
    || ''
  ).trim() || null;

  const rawDisplayText = String(
    data.replyText
    || data.displayText
    || summary.displayText
    || ''
  ).trim() || null;
  const fallbackDisplayText = typeof options.defaultDisplayTextBuilder === 'function'
    ? String(options.defaultDisplayTextBuilder(summary, data) || '').trim() || null
    : null;
  const computedDisplayText = rawDisplayText || fallbackDisplayText;
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
  if (requestUrl) {
    summary.requestUrl = requestUrl;
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
    requestUrl,
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
        requestUrl,
        requestParamsJson: data.requestParamsJson || summary.requestParamsJson || null
      },
      summary: toPlainSummary(summary),
      result: {
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
