#!/usr/bin/env node

const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

function loadDotenv() {
  const candidates = [
    path.join(workspaceRoot, 'node_modules', 'dotenv'),
    'dotenv'
  ];

  for (const candidate of candidates) {
    try {
      require(candidate).config({
        path: path.join(workspaceRoot, '.env')
      });
      return;
    } catch (_error) {
      // try next candidate
    }
  }
}

loadDotenv();

const RequirementParserService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/RequirementParserService'));
const MetricMappingService = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/MetricMappingService'));
const { buildOpenClawReplyContract } = require(path.join(workspaceRoot, 'skills/openclaw-napm-query/services/OpenClawNarrationContractService'));
const { executeOverviewModule } = require(path.join(__dirname, 'overview-module'));

const SHOW_UPSTREAM_API_IN_REPLY = ['1', 'true', 'yes', 'on'].includes(String(process.env.SHOW_UPSTREAM_API_IN_REPLY || '').trim().toLowerCase());
const SKILL_FORWARD_DISPLAY_TEXT = ['1', 'true', 'yes', 'on'].includes(String(process.env.SKILL_FORWARD_DISPLAY_TEXT || '').trim().toLowerCase());

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prompt') {
      args.prompt = argv[index + 1];
      index += 1;
    } else if (arg === '--query') {
      args.query = argv[index + 1];
      index += 1;
    } else if (arg === '--payload') {
      args.payload = argv[index + 1];
      index += 1;
    } else if (arg === '--resolvedQuery') {
      args.resolvedQuery = argv[index + 1];
      index += 1;
    } else if (arg === '--decision') {
      args.decision = argv[index + 1];
      index += 1;
    } else if (arg === '--intent') {
      args.intent = argv[index + 1];
      index += 1;
    } else if (arg === '--session') {
      args.session = argv[index + 1];
      index += 1;
    } else if (!String(arg || '').startsWith('--') && !args.prompt && !args.query) {
      args.prompt = arg;
    }
  }

  return args;
}

function parseJsonArg(name, value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${name}: ${error.message}`);
  }
}

function coerceJsonObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (error) {
    throw new Error(`Invalid JSON object: ${error.message}`);
  }
}

function appendRequestUrlToDisplayText(displayText, requestUrl) {
  const text = String(displayText || '').trim();
  const url = String(requestUrl || '').trim();
  if (!text) {
    return url || null;
  }
  if (!url || !SHOW_UPSTREAM_API_IN_REPLY) {
    return text;
  }
  return `${text}\n调试API：\n${url}`;
}

function buildDisplayText(summary = {}, payload = {}) {
  if (summary?.displayText) {
    return summary.displayText;
  }

  const lines = [];
  const title = String(summary?.title || '').trim();
  if (title) {
    lines.push(`结论：${title}`);
  }

  const highlights = Array.isArray(summary?.highlights) ? summary.highlights.filter(Boolean) : [];
  highlights.forEach((item) => lines.push(String(item)));

  if (SHOW_UPSTREAM_API_IN_REPLY && payload?.requestUrl) {
    lines.push(`调试API：`);
    lines.push(String(payload.requestUrl));
  }

  return lines.join('\n').trim() || null;
}

function buildSummary(service, resolvedQuery, data, extra = {}) {
  const rows = Array.isArray(data) ? data : [];
  const metric = resolvedQuery?.metric || (Array.isArray(resolvedQuery?.metrics) ? resolvedQuery.metrics.join(',') : '');
  const groupPath = Array.isArray(resolvedQuery?.groups)
    ? resolvedQuery.groups.map((item) => String(item?.type || '').trim()).filter(Boolean).join(' > ')
    : '';

  if (service === 'groups') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: 'Groups list completed',
      highlights: [`已返回 ${rows.length} 条对象/维度。`],
      rowCount: rows.length,
      empty: rows.length === 0
    };
  }

  if (service === 'metrics') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: 'Metrics list completed',
      highlights: [`已返回 ${rows.length} 条指标。`],
      rowCount: rows.length,
      empty: rows.length === 0
    };
  }

  if (rows.length === 0) {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: '还需要补充一点信息',
      highlights: ['本次未查到数据。'],
      rowCount: 0,
      empty: true
    };
  }

  if (service === 'topValues') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: 'Top query completed',
      highlights: [
        `已返回 ${rows.length} 条排行结果。`,
        metric ? `指标：${metric}` : null,
        groupPath ? `维度：${groupPath}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: false,
      metrics: metric ? [metric] : []
    };
  }

  if (service === 'timeValues') {
    return {
      mode: extra.mode || 'GO_DIRECT_QUERY',
      title: 'Trend query completed',
      highlights: [
        `已返回 ${rows.length} 个时间点。`,
        metric ? `指标：${metric}` : null,
        groupPath ? `维度：${groupPath}` : null
      ].filter(Boolean),
      rowCount: rows.length,
      empty: false,
      metrics: metric ? [metric] : []
    };
  }

  return {
    mode: extra.mode || 'GO_DIRECT_QUERY',
    title: 'Average query completed',
    highlights: [
      `已返回 ${rows.length} 条结果。`,
      metric ? `指标：${metric}` : null,
      groupPath ? `维度：${groupPath}` : null
    ].filter(Boolean),
    rowCount: rows.length,
    empty: false,
    metrics: metric ? [metric] : []
  };
}

function isMetadataWebApplicationInventory(resolvedQuery = {}) {
  const service = String(resolvedQuery?.service || '').trim();
  const firstGroupType = String(resolvedQuery?.groups?.[0]?.type || '').trim();
  const operation = String(
    resolvedQuery?.semanticConstraints?.operation
    || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
    || ''
  ).trim();

  return service === 'groups'
    && firstGroupType === 'WebApplication'
    && operation === 'metadata_list';
}

function isNoiseWebApplicationLabel(label = '') {
  const raw = String(label || '').trim();
  if (!raw) {
    return true;
  }
  return /^(?:Other Group|Other Web Application)$/i.test(raw);
}

function isProtocolStyleWebApplicationLabel(label = '') {
  const raw = String(label || '').trim();
  if (!raw) {
    return true;
  }
  if (/[\u4e00-\u9fa5]/.test(raw)) {
    return false;
  }
  if (/[a-z]/.test(raw)) {
    return false;
  }

  const normalized = raw.toUpperCase();
  const exactProtocolLabels = new Set([
    'AIM-TCP', 'AIM-UDP', 'DNS', 'HTTP', 'HTTPS', 'ICMP', 'IMAP', 'POP3', 'SMTP', 'SSH', 'TELNET',
    'FTP-CONTROL', 'FTP-DATA', 'MSSQL-TCP', 'MSSQL-UDP', 'RTCP'
  ]);
  if (exactProtocolLabels.has(normalized)) {
    return true;
  }

  if (
    /^(?:MS-|SAP-|ORACLE-|SUN-RPC|NETBIOS|SQL\*NET|RTP|RTSP|SIP|H323|FTP|SMTP|SSH|DNS|HTTP|HTTPS|ICMP|TELNET|IMAP|POP3|MSSQL|VMWARE-SRV|MS-WBT-SRV|KAZAA|GNUTELLA|RBT-WANOPT)/.test(normalized)
  ) {
    return true;
  }

  return /^(?:[A-Z0-9*]+(?:[-_][A-Z0-9*]+){0,8})$/.test(normalized);
}

function filterBusinessSystemRows(rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  const filtered = items.filter((item) => {
    const label = String(item?.label || item?.Label || item?.value || item?.name || '').trim();
    if (isNoiseWebApplicationLabel(label)) {
      return false;
    }
    if (isProtocolStyleWebApplicationLabel(label)) {
      return false;
    }
    return true;
  });

  return filtered.length > 0 ? filtered : items;
}

function buildFollowUpActionsFromGate(gate = null) {
  const options = Array.isArray(gate?.options) ? gate.options : [];
  return options.map((item) => ({
    label: item?.label || item?.value || null,
    value: item?.value || item?.label || null,
    query: item?.replyText || item?.value || item?.label || null
  })).filter((item) => item.query);
}

function buildDecisionSummary(title, text, mode = 'ASK_CLARIFYING_QUESTION') {
  return {
    mode,
    title,
    highlights: [text].filter(Boolean),
    rowCount: 0,
    empty: true,
    displayText: text
  };
}

function normalizeResolvedQueryShape(resolvedQuery = {}, prompt = '') {
  const query = resolvedQuery && typeof resolvedQuery === 'object'
    ? JSON.parse(JSON.stringify(resolvedQuery))
    : {};

  query.userRequirement = query.userRequirement || prompt || '';
  query.format = query.format || 'json';

  if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
    if (query.metric) {
      query.metrics = [query.metric];
    }
  }

  if (query.service === 'topValues') {
    query.topCount = Number.isFinite(Number(query.topCount)) && Number(query.topCount) > 0
      ? Number(query.topCount)
      : 10;
    query.topMetric = query.topMetric || query.metric || query.metrics?.[0] || null;
  }

  if (query.service === 'timeValues') {
    query.granularity = Number.isFinite(Number(query.granularity)) && Number(query.granularity) > 0
      ? Number(query.granularity)
      : 3600;
  }

  return query;
}

async function resolvePromptExecution(prompt, requestContext) {
  const mappingResult = await RequirementParserService.mapNaturalLanguageWithMetadata(prompt, requestContext);
  const resolvedQuery = normalizeResolvedQueryShape(mappingResult?.resolvedQuery || {}, prompt);
  const intentResult = RequirementParserService.buildIntentResult(resolvedQuery, prompt);
  const semanticResolutionResult = RequirementParserService.buildSemanticResolutionResult({
    ...resolvedQuery,
    clarificationGate: mappingResult?.clarificationGate || null,
    candidateSpec: mappingResult?.candidateSpec || null,
    candidateGeneration: mappingResult?.candidateGeneration || null,
    metricResolve: mappingResult?.metricResolve || null,
    metricSemantic: mappingResult?.metricDisambiguation || null,
    objectSemantic: mappingResult?.objectDisambiguation || null,
    pathPlanning: mappingResult?.pathPlan || null,
    executionGuard: resolvedQuery?.executionGuard || null
  });

  return {
    prompt,
    mappingResult,
    resolvedQuery,
    intentResult,
    semanticResolutionResult
  };
}

async function resolveInput(args, payload) {
  const prompt = String(
    args.prompt
    || payload?.prompt
    || payload?.query
    || ''
  ).trim();

  const requestContext = {
    decision: parseJsonArg('--decision', args.decision) || payload?.decision || null,
    intent: parseJsonArg('--intent', args.intent) || payload?.intent || null,
    session: parseJsonArg('--session', args.session) || payload?.session || null
  };

  const explicitResolvedQuery = coerceJsonObject(args.query)
    || parseJsonArg('--resolvedQuery', args.resolvedQuery)
    || payload?.resolvedQuery
    || null;

  if (explicitResolvedQuery) {
    const resolvedQuery = normalizeResolvedQueryShape(explicitResolvedQuery, prompt);
    return {
      prompt: prompt || String(resolvedQuery?.userRequirement || '').trim(),
      mappingResult: null,
      resolvedQuery,
      intentResult: RequirementParserService.buildIntentResult(resolvedQuery, prompt),
      semanticResolutionResult: RequirementParserService.buildSemanticResolutionResult(resolvedQuery),
      requestContext,
      payload
    };
  }

  if (!prompt) {
    throw new Error('Provide either --prompt, --query, --resolvedQuery, or --payload with resolvedQuery.');
  }

  const localResolution = await resolvePromptExecution(prompt, requestContext);
  return {
    ...localResolution,
    requestContext,
    payload
  };
}

function buildClarificationContract(base = {}, gate = null) {
  const question = String(
    gate?.question
    || base?.resolvedQuery?.executionGuard?.message
    || '当前信息还不够，我需要你再明确一点。'
  ).trim();
  const followUpActions = buildFollowUpActionsFromGate(gate);
  const summary = buildDecisionSummary('还需要补充一点信息', question);

  return buildOpenClawReplyContract({
    ...base,
    ok: false,
    error: null,
    rows: [],
    summary,
    displayText: question,
    followUpActions,
    responseType: 'decision_result'
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText
  });
}

async function executeResolvedQuery(prompt, resolvedQuery, payload, intentResult) {
  const isOverview = resolvedQuery?.service === 'overview' || resolvedQuery?.queryModeKey === 'overview';
  if (isOverview) {
    return executeOverviewModule({
      prompt,
      payload,
      intent: intentResult,
      resolvedQuery,
      executeGatewayRequest: RequirementParserService.executeGatewayRequest.bind(RequirementParserService)
    });
  }

  return RequirementParserService.executeGatewayRequest(resolvedQuery);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = parseJsonArg('--payload', args.payload) || {};
  const input = await resolveInput(args, payload);
  const prompt = input.prompt || '';
  const resolvedQuery = input.resolvedQuery || {};
  const mappingResult = input.mappingResult || null;
  const intentResult = input.intentResult || null;
  const semanticResolutionResult = input.semanticResolutionResult || null;

  const clarificationGate = mappingResult?.clarificationGate || resolvedQuery?.clarificationGate || null;
  if (clarificationGate?.required) {
    const output = buildClarificationContract({
      prompt,
      service: resolvedQuery?.service || null,
      resolvedQuery,
      intentResult,
      semanticResolutionResult,
      assistantDecision: clarificationGate,
      supportedMetrics: MetricMappingService.getAllMetricCodes().length
    }, clarificationGate);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (resolvedQuery?.executionGuard?.blockExecution) {
    const output = buildClarificationContract({
      prompt,
      service: resolvedQuery?.service || null,
      resolvedQuery,
      intentResult,
      semanticResolutionResult,
      assistantDecision: resolvedQuery.executionGuard,
      supportedMetrics: MetricMappingService.getAllMetricCodes().length
    }, {
      question: resolvedQuery.executionGuard.message,
      options: (resolvedQuery.executionGuard.details?.suggestedCandidates || []).map((item) => ({
        label: item?.label || item?.value,
        value: item?.value || item?.label,
        replyText: item?.value || item?.label
      }))
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const executionResult = await executeResolvedQuery(prompt, resolvedQuery, payload, intentResult);
  const rawRows = Array.isArray(executionResult?.data) ? executionResult.data : [];
  const rows = isMetadataWebApplicationInventory(resolvedQuery)
    ? filterBusinessSystemRows(rawRows)
    : rawRows;
  const service = executionResult?.service || resolvedQuery?.service || null;
  const summary = executionResult?.summary || buildSummary(service, resolvedQuery, rows);
  const output = buildOpenClawReplyContract({
    ok: Boolean(executionResult?.ok),
    prompt,
    service,
    resolvedQuery,
    rows,
    data: rows,
    overview: executionResult?.overview || null,
    requestUrl: executionResult?.requestUrl || null,
    requestParamsJson: executionResult?.requestParams || null,
    summary,
    error: executionResult?.error || null,
    warnings: Array.isArray(executionResult?.warnings) ? executionResult.warnings : [],
    supportedMetrics: MetricMappingService.getAllMetricCodes().length,
    intentResult,
    semanticResolutionResult,
    assistantDecision: clarificationGate || null
  }, {
    forwardDisplayText: SKILL_FORWARD_DISPLAY_TEXT,
    appendRequestUrlToDisplayText,
    defaultDisplayTextBuilder: buildDisplayText
  });

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  const summary = buildDecisionSummary('Skill execution failed', error.message, 'FAILED');
  const output = buildOpenClawReplyContract({
    ok: false,
    service: null,
    resolvedQuery: null,
    rows: [],
    data: [],
    summary,
    error: {
      code: error.code || 'SKILL_EXECUTION_ERROR',
      message: error.message
    },
    responseType: 'decision_result',
    displayText: error.message
  }, {
    forwardDisplayText: true,
    appendRequestUrlToDisplayText
  });

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
});
