const SummaryService = require('../skills/openclaw-napm-summary/services/SummaryService');
const SummaryClient = require('../skills/openclaw-napm-summary/services/SummaryClient');
const FaultDiagnosisService = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');
const { resolveExecutionTime } = require('../skills/openclaw-napm-query/src/shared/timeResolver');

const executionTimeRange = resolveExecutionTime({
  start: 1_780_000_000,
  end: 1_780_003_600,
  displayText: 'test window'
});

function createSummaryService(plan) {
  const service = new SummaryService({ client: { requestHistory: [] } });
  service.plan = () => plan;
  service.aggregate = () => ({
    alertSummary: {},
    trafficSummary: { trend: {} },
    businessSummary: {},
    singleBusinessAnalysis: {}
  });
  return service;
}

describe('summary and fault failure propagation', () => {
  test('summary refuses to claim health when all required queries fail', async () => {
    const service = createSummaryService([
      { label: 'alertsSummary', fn: () => Promise.reject(new Error('alerts unavailable')) },
      { label: 'trafficTrend', fn: () => Promise.reject(new Error('traffic unavailable')) },
      { label: 'applianceInfo', fn: () => Promise.resolve({ version: '1.0' }) }
    ]);

    const result = await service.run({
      scope: { type: 'global', label: 'global' },
      executionTimeRange
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SUMMARY_REQUIRED_DATA_UNAVAILABLE' },
      completeness: { status: 'failed', failedRequiredCount: 2 }
    });
    expect(result.summary).toBeUndefined();
  });

  test('summary labels partial input as unknown instead of healthy', async () => {
    const service = createSummaryService([
      { label: 'alertsSummary', fn: () => Promise.resolve([]) },
      { label: 'trafficTrend', fn: () => Promise.reject(new Error('traffic unavailable')) }
    ]);

    const result = await service.run({
      scope: { type: 'global', label: 'global' },
      executionTimeRange
    });

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      completeness: { status: 'partial', failedRequiredCount: 1 },
      summary: { overallStatus: 'unknown' }
    });
    expect(result.failures).toEqual([
      expect.objectContaining({ label: 'trafficTrend', required: true })
    ]);
  });

  test('summary keeps a successful empty result distinct from a healthy conclusion', async () => {
    const service = createSummaryService([
      { label: 'alertsSummary', fn: () => Promise.resolve([]) },
      { label: 'trafficTrend', fn: () => Promise.resolve(null) }
    ]);

    const result = await service.run({
      scope: { type: 'global', label: 'global' },
      executionTimeRange
    });

    expect(result).toMatchObject({
      ok: true,
      partial: false,
      empty: true,
      completeness: { status: 'success', allRequiredEmpty: true },
      summary: { overallStatus: 'unknown' }
    });
  });

  test('fault diagnosis stops a required step failure and refuses a report', async () => {
    const steps = {
      buildQueries: () => ({
        description: 'required evidence',
        queries: [{ label: 'evidence', fn: () => Promise.reject(new Error('NAPM unavailable')) }]
      }),
      analyzeStepData: () => {
        throw new Error('analysis must not run without required evidence');
      }
    };
    const service = new FaultDiagnosisService({ client: { requestHistory: [] }, steps });
    const session = {
      flowType: 'bs_app_slow',
      context: {},
      completedSteps: [],
      description: 'test fault'
    };

    const result = await service.executeStep(session, 'step1_4xx_5xx_overview');

    expect(result).toMatchObject({
      ok: false,
      reportReady: false,
      error: { code: 'FAULT_DIAGNOSIS_REQUIRED_DATA_UNAVAILABLE' },
      completeness: { status: 'failed', failedRequiredCount: 1 }
    });
    expect(service._buildReportResult(session)).toMatchObject({
      ok: false,
      reportReady: false,
      error: { code: 'FAULT_DIAGNOSIS_REQUIRED_DATA_UNAVAILABLE' }
    });
  });

  test('fault diagnosis refuses a report when required evidence is empty', async () => {
    const steps = {
      buildQueries: () => ({
        description: 'required evidence',
        queries: [{ label: 'evidence', fn: () => Promise.resolve([]) }]
      }),
      analyzeStepData: () => {
        throw new Error('analysis must not run without evidence');
      }
    };
    const service = new FaultDiagnosisService({ client: { requestHistory: [] }, steps });
    const session = {
      flowType: 'bs_app_slow',
      context: {},
      completedSteps: [],
      description: 'test fault'
    };

    const result = await service.executeStep(session, 'step1_4xx_5xx_overview');

    expect(result).toMatchObject({
      ok: false,
      reportReady: false,
      error: { code: 'FAULT_DIAGNOSIS_REQUIRED_EVIDENCE_EMPTY' },
      completeness: {
        status: 'failed',
        missingEvidence: [{ label: 'evidence', required: true, status: 'empty' }]
      }
    });
    expect(service._buildReportResult(session)).toMatchObject({
      ok: false,
      reportReady: false,
      error: { code: 'FAULT_DIAGNOSIS_REQUIRED_EVIDENCE_EMPTY' }
    });
  });

  test('summary client rejects non-2xx responses', async () => {
    const client = new SummaryClient({
      host: 'https://napm.example.test',
      username: 'user',
      password: 'password'
    });
    client.client = { get: async () => ({ status: 503, data: 'unavailable' }) };

    await expect(client.request('alertsSummary')).rejects.toMatchObject({
      code: 'NAPM_HTTP_STATUS_ERROR',
      statusCode: 503
    });
  });
});
