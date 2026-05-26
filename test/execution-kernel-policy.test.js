process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

jest.mock('../skills/openclaw-napm-query/services/NapmClient', () => {
  return jest.fn().mockImplementation(() => ({
    username: process.env.NETINSIDE_USERNAME,
    password: process.env.NETINSIDE_PASSWORD,
    baseUrl: process.env.NETINSIDE_HOST,
    get: jest.fn().mockResolvedValue('[]'),
    getJson: jest.fn().mockResolvedValue([])
  }));
});

const ExecutionKernelPolicy = require('../skills/openclaw-napm-query/services/ExecutionKernelPolicy');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');

describe('execution kernel policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('should route metadata workflow to metadata kernel', () => {
    expect(ExecutionKernelPolicy.resolveExecutionKernel({
      service: 'groups',
      semanticConstraints: {
        workflowType: 'object_inventory'
      }
    })).toBe('metadata');
  });

  test('should route metric workflow to metric kernel', () => {
    expect(ExecutionKernelPolicy.resolveExecutionKernel({
      service: 'topValues',
      semanticConstraints: {
        workflowType: 'metric_topn'
      }
    })).toBe('metric');
  });

  test('should reject object inventory drift to topValues', async () => {
    const result = await RequirementParserService.executeDirectGatewayRequest({
      service: 'topValues',
      start: 1779413040,
      end: 1779499440,
      metric: 'TPIO',
      topMetric: 'TPIO',
      groups: [{ type: 'BusinessGroup' }],
      semanticConstraints: {
        workflowType: 'object_inventory',
        operation: 'metadata_list',
        targetObjectType: 'BusinessGroup'
      }
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'WORKFLOW_SERVICE_CONTRACT_MISMATCH',
      details: {
        workflowType: 'object_inventory',
        service: 'topValues',
        expectedKernel: 'metadata',
        actualKernel: 'metric'
      }
    });
  });

  test('should reject metric topn drift to groups', async () => {
    const result = await RequirementParserService.executeDirectGatewayRequest({
      service: 'groups',
      start: 1779413040,
      end: 1779499440,
      groups: [{ type: 'IPAddress' }],
      semanticConstraints: {
        workflowType: 'metric_topn',
        operation: 'metric_query',
        targetObjectType: 'IPAddress'
      }
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'WORKFLOW_SERVICE_CONTRACT_MISMATCH',
      details: {
        workflowType: 'metric_topn',
        service: 'groups',
        expectedKernel: 'metric',
        actualKernel: 'metadata'
      }
    });
  });
});
