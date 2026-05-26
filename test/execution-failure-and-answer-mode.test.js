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

const ExecutionFailureClassifier = require('../skills/openclaw-napm-query/services/ExecutionFailureClassifier');
const AnswerModeRouter = require('../skills/openclaw-napm-query/services/AnswerModeRouter');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const {
  buildOpenClawReplyContract
} = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');

describe('execution failure classifier and answer mode router', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('should classify workflow service mismatch as workflow selection invalid', () => {
    const failure = ExecutionFailureClassifier.classify({
      code: 'WORKFLOW_SERVICE_CONTRACT_MISMATCH',
      message: 'workflow object_inventory cannot execute service topValues'
    }, {
      service: 'topValues',
      semanticConstraints: {
        workflowType: 'object_inventory'
      }
    });

    expect(failure).toMatchObject({
      category: 'WORKFLOW_SELECTION_INVALID',
      originalCode: 'WORKFLOW_SERVICE_CONTRACT_MISMATCH',
      domain: 'metadata',
      service: 'topValues',
      workflowType: 'object_inventory'
    });
  });

  test('should classify metadata upstream 400 separately from no data', () => {
    const failure = ExecutionFailureClassifier.classify({
      message: '400 Bad Request'
    }, {
      service: 'groups',
      semanticConstraints: {
        workflowType: 'object_inventory'
      }
    });

    expect(failure).toMatchObject({
      category: 'METADATA_UPSTREAM_400',
      domain: 'metadata'
    });
  });

  test('should keep final answer mode from forwarding raw failure display text', () => {
    const output = buildOpenClawReplyContract({
      ok: false,
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        semanticConstraints: {
          workflowType: 'object_inventory'
        }
      },
      summary: {
        title: 'failed',
        displayText: 'raw stack or upstream message'
      },
      error: {
        code: 'WORKFLOW_SERVICE_CONTRACT_MISMATCH',
        message: 'workflow object_inventory cannot execute service topValues'
      },
      responseType: 'decision_result'
    }, {
      forwardDisplayText: true
    });

    expect(output.answerMode).toBe('final_answer_mode');
    expect(output.displayText).toBeNull();
    expect(output.responseMode).toBe('machine_narration_input');
    expect(output.failureClassification).toMatchObject({
      category: 'WORKFLOW_SELECTION_INVALID'
    });
    expect(output.narrationStructure.explanation).toContain('workflow=object_inventory');
    expect(output.narrationInput.renderPolicy.allowIntermediateAttempts).toBe(false);
  });

  test('should allow debug trace mode to forward display text and debug policy', () => {
    const output = buildOpenClawReplyContract({
      answerMode: 'debug_trace_mode',
      ok: false,
      service: 'groups',
      summary: {
        displayText: 'debug details'
      },
      error: {
        code: 'QUERY_SHAPE_INVALID',
        message: 'debug query shape'
      },
      responseType: 'decision_result'
    }, {
      forwardDisplayText: false
    });

    expect(output.answerMode).toBe('debug_trace_mode');
    expect(output.displayText).toBe('debug details');
    expect(output.narrationInput.renderPolicy.includeDebugTrace).toBe(true);
    expect(output.narrationInput.renderPolicy.allowIntermediateAttempts).toBe(true);
  });

  test('RequirementParserService should return normalized failure classification', async () => {
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
      category: 'WORKFLOW_SELECTION_INVALID',
      code: 'WORKFLOW_SERVICE_CONTRACT_MISMATCH',
      failureClassification: {
        category: 'WORKFLOW_SELECTION_INVALID',
        workflowType: 'object_inventory',
        service: 'topValues'
      }
    });
  });

  test('AnswerModeRouter should default to final answer mode', () => {
    expect(AnswerModeRouter.resolveAnswerMode({})).toBe('final_answer_mode');
    expect(AnswerModeRouter.resolveAnswerMode({ answerMode: 'debug' })).toBe('debug_trace_mode');
  });
});
