const METADATA_SERVICES = new Set([
  'groups',
  'metrics',
  'metricsForGroup',
  'drilldownCatalog',
  'applications',
  'businessGroups',
  'groupArguments'
]);

const METRIC_SERVICES = new Set([
  'topValues',
  'averageValues',
  'timeValues',
  'overview',
  'alertsSummary'
]);

const METADATA_WORKFLOWS = new Set([
  'object_inventory',
  'metric_inventory',
  'drilldown_catalog'
]);

const METRIC_WORKFLOWS = new Set([
  'metric_topn',
  'metric_average',
  'metric_timeseries',
  'overview',
  'composite_analysis'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function getService(context = {}) {
  return normalizeText(context?.service || context?.gatewayRequest?.service || context?.resolvedQuery?.service);
}

function getWorkflowType(context = {}) {
  return normalizeText(
    context?.workflowType
    || context?.semanticConstraints?.workflowType
    || context?.gatewayRequest?.semanticConstraints?.workflowType
    || context?.resolvedQuery?.semanticConstraints?.workflowType
    || context?.gatewayRequest?.workflowType
    || context?.resolvedQuery?.workflowType
  );
}

function inferDomain(context = {}) {
  const service = getService(context);
  const workflowType = getWorkflowType(context);
  if (METADATA_WORKFLOWS.has(workflowType) || METADATA_SERVICES.has(service)) {
    return 'metadata';
  }
  if (METRIC_WORKFLOWS.has(workflowType) || METRIC_SERVICES.has(service)) {
    return 'metric';
  }
  return 'unknown';
}

function normalizeUpstreamStatus(error = {}) {
  const status = Number(
    error?.status
    || error?.statusCode
    || error?.response?.status
    || error?.details?.status
    || error?.details?.statusCode
  );
  return Number.isFinite(status) ? status : null;
}

function classifyCode(error = {}, context = {}) {
  const rawCode = normalizeText(error?.code);
  const message = normalizeText(error?.message || error);
  const status = normalizeUpstreamStatus(error);
  const domain = inferDomain(context);

  if (rawCode === 'WORKFLOW_SERVICE_CONTRACT_MISMATCH') {
    return 'WORKFLOW_SELECTION_INVALID';
  }
  if (rawCode === 'OBJECT_TYPE_UNRESOLVED') {
    return 'OBJECT_TYPE_UNRESOLVED';
  }
  if (rawCode === 'PROVIDER_BINDING_INVALID') {
    return 'PROVIDER_BINDING_INVALID';
  }
  if (rawCode === 'METADATA_ARGUMENT_TYPE_UNRESOLVED') {
    return 'METADATA_ARGUMENT_TYPE_UNRESOLVED';
  }
  if (rawCode === 'GROUP_ARGUMENT_REQUIRED') {
    return 'QUERY_SCOPE_INCOMPLETE';
  }
  if (rawCode === 'GROUP_ARGUMENT_FORBIDDEN' || rawCode === 'INVALID_GROUP_ARGUMENT') {
    return 'QUERY_SCOPE_INVALID';
  }
  if (rawCode === 'INVALID_METADATA_INVENTORY_ARGUMENT') {
    return 'QUERY_SHAPE_INVALID';
  }
  if (rawCode === 'QUERY_SHAPE_INVALID') {
    return 'QUERY_SHAPE_INVALID';
  }
  if (rawCode === 'DEPENDENCY_CONTRACT_MISMATCH') {
    return 'DEPENDENCY_CONTRACT_MISMATCH';
  }
  if (status === 403 || /\b403\b|forbidden|permission denied/i.test(message)) {
    return domain === 'metadata' ? 'METADATA_UPSTREAM_403' : 'NAPM_UPSTREAM_403';
  }
  if (status === 400 || /\b400\b|bad request/i.test(message)) {
    return domain === 'metadata' ? 'METADATA_UPSTREAM_400' : 'NAPM_UPSTREAM_400';
  }
  if (/empty|no data|not found|未查到|没有数据/i.test(message)) {
    return domain === 'metadata' ? 'METADATA_EMPTY' : 'METRIC_EMPTY';
  }
  return 'NAPM_UPSTREAM_ERROR';
}

function buildUserMessage(category = '', context = {}) {
  const service = getService(context) || 'unknown';
  const workflowType = getWorkflowType(context) || 'unknown';
  switch (category) {
    case 'WORKFLOW_SELECTION_INVALID':
      return `查询工作流与执行服务不匹配：workflow=${workflowType} 不能执行 service=${service}。`;
    case 'OBJECT_TYPE_UNRESOLVED':
      return '未能确定用户要查询的 NAPM 对象类型，需要先完成对象语义解析。';
    case 'PROVIDER_BINDING_INVALID':
      return '对象类型与元数据 provider 绑定不合法，查询没有进入南向执行。';
    case 'METADATA_ARGUMENT_TYPE_UNRESOLVED':
      return '元数据对象的 argumentType 未能可靠解析，已阻止调用南向接口。';
    case 'QUERY_SCOPE_INCOMPLETE':
      return '单对象查询缺少具体对象名称，未调用南向接口；请补充应用或业务名称。';
    case 'QUERY_SCOPE_INVALID':
      return '查询对象参数不合法，未调用南向接口；请检查对象名称或全局范围参数。';
    case 'METADATA_EMPTY':
      return '元数据查询执行成功，但当前对象池没有返回可用实例。';
    case 'METADATA_UPSTREAM_400':
      return '元数据查询被南向接口拒绝，通常表示请求形态或对象参数不被支持。';
    case 'METADATA_UPSTREAM_403':
      return '元数据查询被南向接口拒绝，当前账号或接口权限不足。';
    case 'METRIC_EMPTY':
      return '指标查询执行成功，但当前时间范围和对象条件下没有返回数据。';
    case 'QUERY_SHAPE_INVALID':
      return '查询结构不合法，缺少必要字段或字段位置不符合执行契约。';
    case 'DEPENDENCY_CONTRACT_MISMATCH':
      return '运行时代码依赖契约不匹配，查询未进入正常执行。';
    case 'NAPM_UPSTREAM_400':
      return '指标查询被南向接口拒绝，通常表示请求形态或指标参数不被支持。';
    case 'NAPM_UPSTREAM_403':
      return '指标查询被南向接口拒绝，当前账号或接口权限不足。';
    default:
      return 'NAPM 查询执行失败，失败原因已进入标准错误分类。';
  }
}

function classify(error = {}, context = {}) {
  const originalCode = normalizeText(error?.code) || null;
  const category = classifyCode(error, context);
  const domain = inferDomain(context);
  return {
    category,
    originalCode,
    domain,
    service: getService(context) || null,
    workflowType: getWorkflowType(context) || null,
    userMessage: buildUserMessage(category, context),
    debugMessage: normalizeText(error?.message || error) || null,
    retryable: [
      'METADATA_UPSTREAM_400',
      'METADATA_UPSTREAM_403',
      'NAPM_UPSTREAM_400',
      'NAPM_UPSTREAM_403',
      'NAPM_UPSTREAM_ERROR'
    ].includes(category)
  };
}

function normalizeError(error = {}, context = {}) {
  const classification = classify(error, context);
  return {
    code: normalizeText(error?.code) || classification.category,
    category: classification.category,
    message: error?.message || String(error),
    userMessage: classification.userMessage,
    failureClassification: classification,
    ...(error?.details ? { details: error.details } : {})
  };
}

module.exports = {
  classify,
  normalizeError,
  inferDomain
};
