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

function getWorkflowType(query = {}) {
  return String(
    query?.semanticConstraints?.workflowType
    || query?.workflowType
    || ''
  ).trim();
}

function getService(query = {}) {
  return String(query?.service || '').trim();
}

function isMetadataWorkflow(workflowType = '') {
  return METADATA_WORKFLOWS.has(String(workflowType || '').trim());
}

function isMetricWorkflow(workflowType = '') {
  return METRIC_WORKFLOWS.has(String(workflowType || '').trim());
}

function isMetadataService(service = '') {
  return METADATA_SERVICES.has(String(service || '').trim());
}

function isMetricService(service = '') {
  return METRIC_SERVICES.has(String(service || '').trim());
}

function resolveExecutionKernel(query = {}) {
  const workflowType = getWorkflowType(query);
  const service = getService(query);

  if (isMetadataWorkflow(workflowType)) {
    return 'metadata';
  }
  if (isMetricWorkflow(workflowType)) {
    return 'metric';
  }
  if (isMetadataService(service)) {
    return 'metadata';
  }
  if (isMetricService(service)) {
    return 'metric';
  }
  return 'unknown';
}

function buildContractMismatchError(query = {}, expectedKernel = '', actualKernel = '') {
  const workflowType = getWorkflowType(query);
  const service = getService(query);
  const error = new Error(`Workflow/service contract mismatch: workflow ${workflowType || 'unknown'} cannot execute service ${service || 'unknown'}.`);
  error.code = 'WORKFLOW_SERVICE_CONTRACT_MISMATCH';
  error.details = {
    workflowType: workflowType || null,
    service: service || null,
    expectedKernel,
    actualKernel,
    semanticConstraints: query?.semanticConstraints || null
  };
  return error;
}

function assertWorkflowServiceContract(query = {}) {
  const workflowType = getWorkflowType(query);
  const service = getService(query);

  if (isMetadataWorkflow(workflowType) && isMetricService(service)) {
    throw buildContractMismatchError(query, 'metadata', 'metric');
  }

  if (isMetricWorkflow(workflowType) && isMetadataService(service)) {
    throw buildContractMismatchError(query, 'metric', 'metadata');
  }

  return true;
}

module.exports = {
  METADATA_WORKFLOWS,
  METRIC_WORKFLOWS,
  METADATA_SERVICES,
  METRIC_SERVICES,
  getWorkflowType,
  getService,
  isMetadataWorkflow,
  isMetricWorkflow,
  isMetadataService,
  isMetricService,
  resolveExecutionKernel,
  assertWorkflowServiceContract
};
