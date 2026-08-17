/**
 * OpenClawNarrationContractService.js
 *
 * 负责把查询结果转换成 OpenClaw 可消费的 narration contract。
 * 它会把原始 rows、structuredRows、overview、summary 等执行结果统一收口成
 * narrationStructure / narrationInput / renderPolicy，方便后续生成最终用户回复。
 */
const {
  isBusinessObjectType,
  getMetricCategoriesForObjectType
} = require('../src/constants/objectMetricOwnership');
const AnswerModeRouter = require('./AnswerModeRouter');
const ExecutionFailureClassifier = require('./ExecutionFailureClassifier');
const { buildReportData } = require('./ReportDataContractService');

// 以下是一组数值与时间格式化辅助函数，用于把底层结果整理成稳定的展示字段。
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

/**
 * 从 payload、summary 和 resolvedQuery 中统一抽取时间范围，并生成面向用户的展示文本。
 */
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

/**
 * 统一规范化 narration 使用的结果行。
 * 不同 service 的返回结构差异较大，这里把 groups / metrics / 普通查询行收敛成统一字段集。
 */
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

function findMetricValueRecord(row, metricId = null) {
  const metricValues = Array.isArray(row?.metricValues) ? row.metricValues : [];
  if (metricValues.length === 0) {
    return null;
  }

  const exactMetric = metricValues.find((item) => {
    const currentMetricId = String(item?.metric?.id || item?.metric?.Id || '').trim();
    return metricId ? currentMetricId === metricId : Boolean(currentMetricId);
  });
  return exactMetric || metricValues[0] || null;
}

function extractMetricLabel(row, metricId = null) {
  const record = findMetricValueRecord(row, metricId);
  return pickFirstNonEmptyValue(record?.metric, ['label', 'Label', 'name', 'Name'])
    || metricId
    || null;
}

function extractMetricUnit(row, metricId = null) {
  const record = findMetricValueRecord(row, metricId);
  return pickFirstNonEmptyValue(record, ['unit', 'Unit'])
    || (metricId && row?.units && typeof row.units === 'object' ? row.units[metricId] : null)
    || row?.unit
    || null;
}

function buildTopnDisplayText(narration = {}) {
  if (!narration || narration.responseType !== 'topn') {
    return null;
  }

  const items = Array.isArray(narration.items) ? narration.items : [];
  if (items.length === 0) {
    return null;
  }

  const metricLabel = String(
    items.find((item) => item?.metricLabel)?.metricLabel
    || items[0]?.metric
    || 'value'
  ).trim();
  const objectLabel = String(narration.objectType || 'object').trim();
  const lines = [];
  const timeRangeText = String(narration?.timeRange?.displayText || '').trim();
  if (timeRangeText) {
    lines.push(timeRangeText);
  }
  lines.push(`| 排名 | ${objectLabel} | ${metricLabel} |`);
  lines.push('| --- | --- | --- |');
  items.forEach((item, index) => {
    const rank = Number.isFinite(Number(item?.rank)) ? Number(item.rank) : index + 1;
    const object = String(item?.object || '').trim();
    const value = String(item?.formattedValue || item?.value || item?.rawValue || '').trim();
    lines.push(`| ${rank} | ${object || '缺少对象标签'} | ${value || 'no_data'} |`);
  });
  return lines.join('\n');
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

/**
 * 构造 TopN / 排名类 narration 结构。
 */
function buildTopnStructure(payload, rows, followUpPrompts) {
  const metricId = extractMetricId(payload);
  const sortMetricId = extractSortMetricId(payload);
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const objectType = String(payload?.resolvedQuery?.groups?.[0]?.type || '').trim() || null;
  const items = rows.slice(0, 10).map((row, index) => {
    const rawValue = extractMetricValue(row, metricId);
    const unit = extractMetricUnit(row, metricId);
    return {
      rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
      objectType,
      object: row?.object || null,
      metric: metricId,
      metricLabel: extractMetricLabel(row, metricId),
      rawValue,
      value: row?.value || formatMetricValue(rawValue, unit),
      formattedValue: formatMetricValue(rawValue, unit),
      unit,
      groupPath: row?.groupPath || null
    };
  });
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
    objectType,
    displayText: buildTopnDisplayText({ responseType: 'topn', objectType, timeRange, items }),
    items,
    nextActions: followUpPrompts
  };
}

// 构造趋势类 narration 结构。
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

/**
 * 构造概览类 narration 结构。
 * 这里会把 overview scene、模块摘要和发现项统一包装成“可直接叙述”的结果对象。
 */
function buildOverviewStructure(payload, followUpPrompts) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const scene = String(payload?.overview?.scene || '').trim();
  const discovery = payload?.overview?.discovery && typeof payload.overview.discovery === 'object'
    ? payload.overview.discovery
    : null;
  const discoveryObject = String(discovery?.selectedObject || '').trim();
  const discoveryMetric = String(discovery?.metric || '').trim();
  const sceneLabelMap = {
    system: '系统概览',
    business: '业务概览',
    business_group: '业务组概览',
    application: '应用概览',
    network: '网络概览',
    security: '安全概览'
  };
  const sceneLabel = sceneLabelMap[scene] || '概览';
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
    ? '这是应用概览结果，请优先总结告警、吞吐、访问趋势、体验趋势和失败热点。'
    : `这是${sceneLabel}结果，请优先总结核心发现、异常热点和建议关注方向。`;

  return {
    responseType: 'overview',
    title: sceneLabel,
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

// 构造对比类 narration 结构。
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

function getListItemValue(row = {}, labelKey = 'label') {
  return row?.[labelKey] || row?.object || row?.value || row?.label || row?.name || null;
}

function isWebApplicationCatalogList(payload = {}, responseType = '', objectType = '') {
  const metadata = payload?.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : {};
  return responseType === 'group_list'
    && objectType === 'WebApplication'
    && metadata.providerType === 'applications'
    && Array.isArray(metadata.applicationTypeFilter)
    && metadata.applicationTypeFilter.map(Number).includes(3);
}

function buildWebApplicationCatalogDisplayText(rows = []) {
  const lines = [`系统中目前有 ${rows.length} 个业务系统（WebApplication，applications Type=3）：`];
  rows.forEach((row, index) => {
    const value = String(getListItemValue(row, 'label') || '').trim();
    if (value) {
      lines.push(`${index + 1}. ${value}`);
    }
  });
  lines.push('查询口径：南向 applications 目录，按 Type=3 识别 WebApplication/业务系统；这不是按流量活跃度过滤，也不是中文名称过滤。');
  return lines.join('\n');
}

function resolveGroupListDescriptor(objectType = '', metadata = {}) {
  const typeFilter = Array.isArray(metadata?.applicationTypeFilter)
    ? metadata.applicationTypeFilter.map(Number).filter(Number.isFinite)
    : [];
  const descriptors = {
    DefinedApp: { label: '已定义应用', detail: 'DefinedApp，applications Type=2' },
    WebApplication: { label: '业务系统', detail: 'WebApplication，applications Type=3' },
    BuiltinApplication: { label: '内置应用', detail: 'BuiltinApplication，applications Type=1' },
    CompositeApplication: { label: '自动识别应用', detail: 'CompositeApplication，applications Type=4' },
    OtherApp: { label: '未知应用', detail: 'OtherApp' },
    BusinessGroup: { label: '业务组', detail: 'BusinessGroup' }
  };
  const descriptor = descriptors[objectType] || {
    label: objectType || '对象',
    detail: objectType || null
  };
  if (metadata?.providerType === 'applications' && typeFilter.length === 1) {
    return {
      ...descriptor,
      detail: `${objectType || descriptor.detail}，applications Type=${typeFilter[0]}`
    };
  }
  return descriptor;
}

function buildGroupListDisplayText(payload = {}, rows = [], explicitObjectType = '', explicitMetadata = null) {
  const metadata = explicitMetadata && typeof explicitMetadata === 'object'
    ? explicitMetadata
    : (payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {});
  const objectType = String(
    explicitObjectType
    || metadata.effectiveObjectType
    || metadata.requestedObjectType
    || payload?.resolvedQuery?.groups?.[0]?.type
    || ''
  ).trim();
  const descriptor = resolveGroupListDescriptor(objectType, metadata);
  if (!Array.isArray(rows) || rows.length === 0) {
    return `当前没有返回${descriptor.label}。`;
  }

  const detail = descriptor.detail ? `（${descriptor.detail}）` : '';
  const lines = [`系统中目前有 ${rows.length} 个${descriptor.label}${detail}：`];
  rows.forEach((row, index) => {
    const value = String(getListItemValue(row, 'label') || '').trim();
    if (value) {
      lines.push(`${index + 1}. ${value}`);
    }
  });
  return lines.join('\n');
}

function buildMetricListDisplayText(payload = {}, rows = [], explicitObjectType = '') {
  const objectType = String(
    explicitObjectType
    || payload?.metadata?.effectiveObjectType
    || payload?.metadata?.requestedObjectType
    || payload?.resolvedQuery?.groups?.[0]?.type
    || ''
  ).trim();
  const objectLabels = {
    WebApplication: '业务',
    BusinessGroup: '业务组',
    ClientBusinessGroup: '客户端业务组',
    DefinedApp: '应用',
    IPAddress: '网络',
    PageFamily: '页面族',
    User: '用户'
  };
  const objectLabel = objectLabels[objectType] || objectType || '当前对象';
  const scopeText = objectType ? `${objectLabel}（${objectType}）` : objectLabel;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return `当前没有返回${scopeText}可查指标。`;
  }

  const lines = [`${scopeText}共返回 ${list.length} 个指标：`];
  list.forEach((row, index) => {
    const metricId = String(row?.id || row?.metric || '').trim();
    const label = String(getListItemValue(row, 'label') || metricId || '').trim();
    if (!label && !metricId) {
      return;
    }
    const unit = Array.isArray(row?.unit)
      ? row.unit.map((item) => String(item || '').trim()).filter(Boolean).join('/')
      : String(row?.unit || '').trim();
    const detail = [metricId, unit].filter(Boolean).join('，');
    lines.push(`${index + 1}. ${label}${detail ? `（${detail}）` : ''}`);
  });
  return lines.join('\n');
}

// 构造清单类 narration 结构，适用于对象列表与指标列表两类元数据结果。
function buildListStructure(payload, rows, followUpPrompts, responseType, labelKey) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const listTypeLabel = responseType === 'group_list' ? '对象列表' : '指标列表';
  const metadata = payload?.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : null;
  const objectType = String(
    metadata?.effectiveObjectType
    || metadata?.requestedObjectType
    || payload?.resolvedQuery?.groups?.[0]?.type
    || ''
  ).trim() || null;
  const webApplicationCatalogList = isWebApplicationCatalogList(payload, responseType, objectType);
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

    if (webApplicationCatalogList) {
      return '这是 WebApplication 业务系统目录。查询口径是南向 applications 接口返回的应用目录，并按 Type=3 做业务系统类型筛选；请原样列出返回 items，不要按中文名称、活跃流量、是否有近期流量或名称风格再次过滤，也不要把缺失对象解释为被移除或无流量。';
    }

    return `这是一个${listTypeLabel}，请优先概括总数、代表性对象，以及是否更像业务系统列表还是协议类列表。`;
  })();
  const items = rows.map((row, index) => ({
    rank: index + 1,
    value: getListItemValue(row, labelKey),
    type: row?.type || null,
    id: row?.id || null,
    applicationType: Number.isFinite(Number(row?.applicationType)) ? Number(row.applicationType) : null,
    status: row?.status || row?.Status || null
  }));
  const displayText = webApplicationCatalogList
    ? buildWebApplicationCatalogDisplayText(rows)
    : (responseType === 'group_list'
      ? buildGroupListDisplayText(payload, rows, objectType, metadata)
      : buildMetricListDisplayText(payload, rows, objectType));

  return {
    responseType,
    title: payload?.summary?.title || listTypeLabel,
    explanation,
    timeRange,
    metadata,
    itemCount: rows.length,
    items,
    displayText,
    nextActions: followUpPrompts
  };
}

// 构造普通查询 narration 结构。
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

// 构造决策结果 narration 结构，适用于没有结果集、只有处理结论的场景。
function buildDecisionStructure(payload, followUpPrompts) {
  const timeRange = normalizeTimeRange(payload, payload?.summary || {});
  const failure = payload?.error?.failureClassification || payload?.failureClassification || null;
  return {
    responseType: 'decision_result',
    title: payload?.summary?.title || '????',
    explanation: failure?.userMessage || payload?.displayText || payload?.replyText || payload?.summary?.displayText || null,
    failureClassification: failure,
    timeRange,
    nextActions: followUpPrompts
  };
}


/**
 * 根据结果类型分派到不同 narration builder，生成统一 narrationStructure。
 */
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

// 生成供 OpenClaw 渲染阶段使用的 render policy。
function buildRenderPolicy(payload = {}, options = {}) {
  return {
    ...AnswerModeRouter.buildRenderPolicy(payload, options),
    responseType: resolveResponseType(payload, true)
  };
}

/**
 * 主入口：把执行结果转换成 OpenClaw 最终回复契约。
 * 除 narrationStructure 外，还会补齐 summary、displayText、timeRange 和 renderPolicy。
 */
function buildOpenClawReplyContract(data = {}, options = {}) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const service = data.service || data?.resolvedQuery?.service || null;
  const answerMode = AnswerModeRouter.resolveAnswerMode(data, options);
  const failureClassification = data?.error
    ? ExecutionFailureClassifier.classify(data.error, {
        resolvedQuery: data.resolvedQuery || null,
        service,
        semanticConstraints: data?.resolvedQuery?.semanticConstraints || data?.semanticConstraints || null,
        workflowType: data?.resolvedQuery?.workflowType || data?.semanticConstraints?.workflowType || null
      })
    : null;
  const normalizedError = data?.error
    ? {
        ...data.error,
        failureClassification,
        userMessage: data.error.userMessage || failureClassification?.userMessage || null
      }
    : null;

  let summary = data.summary && typeof data.summary === 'object'
    ? { ...data.summary }
    : {};
  if (failureClassification && !summary.displayText) {
    summary.displayText = failureClassification.userMessage;
  }
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
  const forwardDisplayText = AnswerModeRouter.shouldForwardDisplayText({
    ...data,
    error: normalizedError,
    answerMode
  }, options);
  const displayText = forwardDisplayText
    ? (
        typeof options.appendRequestUrlToDisplayText === 'function'
          ? options.appendRequestUrlToDisplayText(computedDisplayText, requestUrl)
          : computedDisplayText
      ) || null
    : null;

  if (displayText) {
    summary.displayText = displayText;
  } else if (Object.prototype.hasOwnProperty.call(summary, 'displayText') && !failureClassification) {
    delete summary.displayText;
  }
  if (includeRequestUrl && requestUrl) {
    summary.requestUrl = requestUrl;
  } else if (Object.prototype.hasOwnProperty.call(summary, 'requestUrl')) {
    delete summary.requestUrl;
  }

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
  const narrationPayload = {
    ...data,
    answerMode,
    error: normalizedError,
    failureClassification,
    summary
  };
  const narrationStructure = data.narrationStructure && typeof data.narrationStructure === 'object'
    ? data.narrationStructure
    : buildNarrationStructure(narrationPayload, rows, structuredRows, structuredSeries);
  if (!summary.displayText && narrationStructure?.responseType === 'topn' && narrationStructure?.displayText) {
    summary.displayText = narrationStructure.displayText;
  }
  if (!summary.displayText && narrationStructure?.responseType === 'group_list' && narrationStructure?.displayText) {
    summary.displayText = narrationStructure.displayText;
  }
  if (!summary.displayText && narrationStructure?.responseType === 'metric_list' && narrationStructure?.displayText) {
    summary.displayText = narrationStructure.displayText;
  }
  const followUpPrompts = normalizeFollowUpPrompts(data);
  const responseType = data.responseType || narrationStructure?.responseType || null;
  const reportData = data.reportData && typeof data.reportData === 'object'
    ? data.reportData
    : buildReportData({
        ...data,
        service,
        responseType,
        summary,
        timeRange,
        requestUrl,
        narrationStructure,
        followUpPrompts,
        followUpActions: Array.isArray(data.followUpActions) ? data.followUpActions : []
      });

  return {
    ...data,
    answerMode,
    error: normalizedError,
    failureClassification,
    summary,
    displayText,
    replyText: displayText,
    responseMode: displayText ? 'verbatim_display_text' : 'machine_narration_input',
    narrationBy: 'openclaw',
    narrationStructure,
    reportData,
    narrationInput: {
      schema: 'openclaw_napm_narration.v1',
      narrationBy: 'openclaw',
      narrationRequired: true,
      answerMode,
      type: hasResultData ? 'query_result' : 'decision_result',
      service,
      responseType,
      failureClassification,
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
        error: normalizedError,
        answerMode,
        responseType: data.responseType || narrationStructure?.responseType || null
      }, { answerMode })
    }
  };
}

module.exports = {
  buildGroupListDisplayText,
  buildMetricListDisplayText,
  buildOpenClawReplyContract,
  buildNarrationStructure,
  normalizeNarrationRows,
  toPlainSummary
};
