'use strict';

const InspectionClient = require('./InspectionClient');
const InspectionFieldMapperService = require('./InspectionFieldMapperService');
const InspectionRuleService = require('./InspectionRuleService');
const InspectionTrafficAnalysisService = require('./InspectionTrafficAnalysisService');
const InspectionBusinessPerformanceService = require('./InspectionBusinessPerformanceService');
const TimeRangeService = require('../../openclaw-napm-query/services/ResolvedQueryTimeRangeService');
const { resolveExecutionTime } = require('../../openclaw-napm-query/src/shared/timeResolver');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeWindowMode(key = '', mode = '') {
  const requestedMode = asText(mode).toLowerCase();
  if (['rolling', 'calendar', 'custom'].includes(requestedMode)) return requestedMode;
  if (String(key).toLowerCase() === 'custom') return 'custom';
  if (/quarter|year/i.test(String(key))) return 'calendar';
  return 'rolling';
}

function getWindowInput(input = {}) {
  const nestedQuery = isPlainObject(input.inspectionQuery) ? input.inspectionQuery : {};
  const candidate = [
    input.reportWindow,
    input.timeRange,
    input.executionTimeRange,
    nestedQuery.reportWindow,
    nestedQuery.timeRange,
    nestedQuery.executionTimeRange
  ].find(isPlainObject);
  return candidate || {};
}

function makeWindowDescriptor(range = {}, options = {}) {
  const requestedKey = asText(options.requestedKey || range.requestedKey || range.key) || 'custom';
  const displayText = asText(options.displayText || range.displayText || requestedKey);
  const mode = normalizeWindowMode(requestedKey, options.mode || range.mode);
  const start = Number(range.start);
  const end = Number(range.end);
  return {
    id: asText(options.id) || requestedKey,
    key: requestedKey,
    resolvedKey: asText(range.key) || requestedKey,
    mode,
    start,
    end,
    durationSeconds: Math.max(0, end - start),
    timezone: options.timezone || DEFAULT_TIMEZONE,
    displayText,
    requestedKey,
    source: asText(options.source || range.source) || 'time_range_resolver',
    boundary: asText(range.boundary) || undefined
  };
}

function resolveInspectionWindowContract(input = {}, options = {}) {
  const nowSeconds = toFiniteNumber(options.nowSeconds) || Math.floor(Date.now() / 1000);
  const timezone = asText(options.timezone) || DEFAULT_TIMEZONE;
  const candidate = getWindowInput(input);
  const prompt = asText(input.prompt || input.sourceQuestion || input.userQuery);
  const requestedKey = asText(candidate.key || candidate.timeRangeKey);
  const requestedMode = asText(candidate.mode || candidate.timeMode);
  const explicitStart = toFiniteNumber(candidate.start);
  const explicitEnd = toFiniteNumber(candidate.end);
  const fixedMode = requestedMode === 'custom' || requestedKey.toLowerCase() === 'custom';

  let parsedPrompt = null;
  let resolved;
  if (requestedKey || explicitStart !== null || explicitEnd !== null) {
    resolved = resolveExecutionTime({
      timeRangeKey: fixedMode ? '' : requestedKey,
      start: explicitStart,
      end: explicitEnd,
      nowSeconds,
      defaultKey: 'last1hour'
    });
  } else {
    parsedPrompt = TimeRangeService.resolvePromptTimeRange(prompt, { nowSeconds });
    resolved = parsedPrompt
      ? resolveExecutionTime({ timeRangeKey: parsedPrompt.key, nowSeconds })
      : resolveExecutionTime({ defaultKey: 'last1hour', nowSeconds });
  }

  if (!resolved || resolved.ok === false) {
    const error = new Error(resolved?.message || 'Unable to resolve inspection report time range.');
    error.code = 'INSPECTION_TIME_RANGE_INVALID';
    error.details = {
      requestedKey: requestedKey || parsedPrompt?.key || null,
      reason: resolved?.reason || 'unresolved'
    };
    throw error;
  }

  const primaryKey = requestedKey || parsedPrompt?.key || resolved.key;
  const primary = makeWindowDescriptor(resolved, {
    id: 'traffic-primary',
    requestedKey: primaryKey,
    displayText: candidate.displayText || parsedPrompt?.displayText,
    mode: requestedMode || (parsedPrompt?.key ? normalizeWindowMode(parsedPrompt.key) : undefined),
    timezone,
    source: candidate.source || parsedPrompt?.source || resolved.source
  });
  const explicitWindow = Boolean(requestedKey || explicitStart !== null || explicitEnd !== null || parsedPrompt);

  const contextKeys = !explicitWindow
    ? ['last1day']
    : (primary.durationSeconds > 86400
      ? ['last1day', 'last1hour']
      : (primary.durationSeconds > 3600 ? ['last1hour'] : ['last1day']));
  const contextWindows = contextKeys
    .filter((key) => key !== primary.key && !(key === 'last1day' && primary.durationSeconds === 86400))
    .map((key) => {
      const contextRange = resolveExecutionTime({ timeRangeKey: key, nowSeconds });
      const isDay = key === 'last1day';
      return makeWindowDescriptor(contextRange, {
        id: isDay ? 'recent-day' : 'recent-hour',
        requestedKey: key,
        displayText: isDay ? '\u6700\u8fd11\u5929' : '\u6700\u8fd11\u5c0f\u65f6',
        timezone,
        source: 'inspection_context_window'
      });
    });

  const businessRange = explicitWindow
    ? primary
    : makeWindowDescriptor(resolveExecutionTime({ timeRangeKey: 'last7days', nowSeconds }), {
      id: 'business-primary',
      requestedKey: 'last7days',
      displayText: '\u6700\u8fd17\u5929',
      timezone,
      source: 'inspection_default_business_window'
    });

  return {
    reportWindow: {
      ...primary,
      id: 'report-window',
      displayText: candidate.displayText || parsedPrompt?.displayText || primary.displayText,
      explicit: explicitWindow
    },
    primaryWindow: primary,
    contextWindows,
    businessWindow: businessRange,
    explicit: explicitWindow,
    timezone
  };
}

function collectQueryEvidence(inspection = {}) {
  const evidence = [];
  const traffic = inspection.trafficAnalysis || {};
  const dynamicWindows = [
    traffic.primary,
    traffic.contextDay,
    traffic.contextHour,
    ...(Array.isArray(traffic.contextWindows) ? traffic.contextWindows : []),
    traffic.recentHour,
    traffic.recentDay
  ];
  const seen = new Set();
  for (const section of dynamicWindows) {
    const evidenceKey = section?.queryEvidence && JSON.stringify(section.queryEvidence);
    if (evidenceKey && seen.has(evidenceKey)) continue;
    if (evidenceKey) seen.add(evidenceKey);
    if (section?.queryEvidence) evidence.push(section.queryEvidence);
  }
  if (Array.isArray(inspection.businessPerformance?.queryEvidence)) {
    evidence.push(...inspection.businessPerformance.queryEvidence);
  }
  return evidence;
}

class InspectionReportDataService {
  constructor(options = {}) {
    this.clientOptions = options;
    this.fieldMapper = options.fieldMapper || new InspectionFieldMapperService(options);
    this.ruleService = options.ruleService || new InspectionRuleService(options);
    this.client = options.client || null;
    this.trafficService = options.trafficService || null;
    this.businessService = options.businessService || null;
  }

  buildInspectionFromSources(source = {}, options = {}) {
    const mapped = this.fieldMapper.mapInspection(source, options);
    const withAnalysis = {
      ...mapped,
      reportWindow: options.windowContract?.reportWindow || mapped.reportWindow,
      primaryWindow: options.windowContract?.primaryWindow || mapped.primaryWindow,
      contextWindows: options.windowContract?.contextWindows || mapped.contextWindows,
      trafficAnalysis: isPlainObject(source.trafficAnalysis)
        ? source.trafficAnalysis
        : mapped.trafficAnalysis,
      businessPerformance: isPlainObject(source.businessPerformance)
        ? source.businessPerformance
        : mapped.businessPerformance
    };
    return this.ruleService.evaluate(withAnalysis);
  }

  buildReportData(inspection = {}, options = {}) {
    const title = asText(options.title)
      || `${inspection.customerName ? `${inspection.customerName}` : ''}基于AI的全流量性能分析平台健康检查报告`;
    return {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'inspection_report',
      templateId: 'napm_traffic_health_inspection_v1',
      format: options.format || 'docx',
      defaultFormat: 'docx',
      title,
      sourceQuestion: asText(options.sourceQuestion || options.prompt) || '生成基于AI的全流量性能分析平台巡检报告',
      dataSource: {
        system: 'NAPM',
        sourceSkill: 'openclaw-napm-inspection',
        queryService: 'inspectionSnapshot'
      },
      timeRange: inspection.reportWindow || undefined,
      reportWindow: inspection.reportWindow || undefined,
      inspection,
      sections: [
        {
          type: 'inspection',
          title: '巡检报告',
          dataPath: 'inspection'
        }
      ],
      audit: {
        sourceSkill: 'openclaw-napm-inspection',
        sourceSchema: inspection.schema || 'openclaw_napm_inspection.v1',
        authMode: 'query_params',
        queryEvidence: collectQueryEvidence(inspection),
        requestHistory: Array.isArray(options.requestHistory) ? options.requestHistory : []
      }
    };
  }

  buildResult(inspection = {}, options = {}) {
    const reportData = this.buildReportData(inspection, options);
    return {
      ok: true,
      schema: 'openclaw_napm_inspection_result.v1',
      inspection,
      reportData,
      summary: {
        title: reportData.title,
        status: inspection.summary?.overallStatus || 'unknown',
        highlights: Array.isArray(inspection.summary?.abnormalItems) && inspection.summary.abnormalItems.length > 0
          ? inspection.summary.abnormalItems
          : [inspection.summary?.conclusion || '巡检数据已生成。']
      },
      narrationInput: {
        schema: 'openclaw_napm_inspection.v1',
        type: 'inspection_result',
        inspection
      }
    };
  }

  async collectSources(options = {}) {
    const client = this.client || new InspectionClient({
      ...this.clientOptions,
      ...options
    });
    const [appliance, packets, about] = await Promise.all([
      client.getApplianceInfo(),
      client.getPacketsInfo(),
      client.getAboutHtml()
    ]);
    const trafficService = this.trafficService || new InspectionTrafficAnalysisService({
      client,
      nowSeconds: options.nowSeconds,
      timezone: options.timezone,
      thresholds: options.thresholds
    });
    const businessService = this.businessService || new InspectionBusinessPerformanceService({
      client,
      nowSeconds: options.nowSeconds,
      timezone: options.timezone,
      thresholds: options.thresholds
    });
    const windowContract = options.windowContract || resolveInspectionWindowContract(options, options);
    const [trafficAnalysis, businessPerformance] = await Promise.all([
      trafficService.collect(windowContract),
      businessService.collect({ businessWindow: windowContract.businessWindow })
    ]);
    return {
      applianceInfo: appliance.data,
      packetsInfo: packets.data,
      aboutHtml: about.data,
      trafficAnalysis,
      businessPerformance,
      reportWindow: windowContract.reportWindow,
      primaryWindow: windowContract.primaryWindow,
      contextWindows: windowContract.contextWindows,
      requestHistory: typeof client.getRequestHistory === 'function' ? client.getRequestHistory() : []
    };
  }

  async run(input = {}) {
    const source = isPlainObject(input.source) ? input.source : null;
    const options = {
      customerName: input.customerName,
      projectName: input.projectName,
      reportDate: input.reportDate,
      title: input.title,
      sourceQuestion: input.sourceQuestion || input.prompt,
      format: input.format || 'docx',
      nowSeconds: input.nowSeconds,
      timezone: input.timezone || 'Asia/Shanghai',
      thresholds: input.thresholds,
      host: input.host,
      username: input.username,
      password: input.password,
      tlsInsecure: input.tlsInsecure,
      timeoutMs: input.timeoutMs
    };
    const windowContract = resolveInspectionWindowContract(input, options);
    options.windowContract = windowContract;
    const collected = source
      ? {
          ...source,
          requestHistory: Array.isArray(source.requestHistory) ? source.requestHistory : []
        }
      : await this.collectSources(options);
    const inspection = this.buildInspectionFromSources(collected, options);
    return this.buildResult(inspection, {
      ...options,
      requestHistory: collected.requestHistory || []
    });
  }
}

module.exports = InspectionReportDataService;
module.exports.__test__ = {
  collectQueryEvidence,
  resolveInspectionWindowContract,
  makeWindowDescriptor,
  normalizeWindowMode
};
