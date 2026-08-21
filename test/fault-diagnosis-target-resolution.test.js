'use strict';

const FaultDiagnosisService = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');
const { normalizeFaultPayload } = require('../skills/openclaw-napm-fault-diagnosis/scripts/run_fault_diagnosis');

const NOW_MS = 1_787_193_600_000;

function createSteps(seen) {
  return {
    buildQueries(flowType, stepId, context) {
      seen.push({ flowType, stepId, target: context.target });
      return {
        description: stepId,
        queries: [{ label: stepId, required: true, fn: async () => ({ value: 1 }) }]
      };
    },
    analyzeStepData() { return {}; }
  };
}

function createInput(prompt) {
  return normalizeFaultPayload({
    prompt,
    description: prompt,
    timeRange: { key: 'last1hours' },
    fault: { description: prompt }
  }, { nowMs: NOW_MS });
}

describe('fault diagnosis target resolution', () => {
  test.each([
    [
      '给我回溯238web的业务故障分析报告！',
      { name: '回溯238web', type: 3 },
      'bs_app_slow',
      'WebApplication',
      'napm_bs_fault_diagnosis_v2',
      '回溯238web_业务故障分析报告'
    ],
    [
      '给我HTTPS应用故障分析报告！',
      { name: 'HTTPS', type: 2 },
      'cs_app_slow',
      'DefinedApp',
      'napm_cs_fault_diagnosis_v1',
      'HTTPS_应用故障分析报告'
    ]
  ])('uses the catalog target and correct template: %s', async (
    prompt,
    catalogRow,
    flowType,
    groupType,
    templateId,
    title
  ) => {
    const seen = [];
    const service = new FaultDiagnosisService({
      client: { request: jest.fn(async () => [catalogRow]) },
      steps: createSteps(seen)
    });

    const result = await service.run(createInput(prompt));

    expect(result).toMatchObject({
      ok: true,
      reportReady: true,
      flowType,
      reportData: {
        reportType: 'diagnostic_report',
        templateId,
        title,
        faultName: catalogRow.name
      }
    });
    expect(seen[0].target).toEqual({
      groupType,
      groupArgument: catalogRow.name,
      groupLabel: catalogRow.name
    });
    expect(seen.every((item) => item.target === seen[0].target)).toBe(true);
  });

  test('fails closed when the applications catalog is unavailable', async () => {
    const steps = createSteps([]);
    const service = new FaultDiagnosisService({
      client: { request: jest.fn(async () => { throw new Error('catalog unavailable'); }) },
      steps
    });
    const buildQueries = jest.spyOn(steps, 'buildQueries');

    const result = await service.run(createInput('给我HTTPS应用故障分析报告！'));

    expect(result).toMatchObject({
      ok: false,
      reportReady: false,
      error: { code: 'FAULT_TARGET_CATALOG_UNAVAILABLE' }
    });
    expect(result.reportData).toBeUndefined();
    expect(buildQueries).not.toHaveBeenCalled();
  });

  test('fails closed when the named target is not in the catalog', async () => {
    const steps = createSteps([]);
    const service = new FaultDiagnosisService({
      client: { request: jest.fn(async () => []) },
      steps
    });
    const buildQueries = jest.spyOn(steps, 'buildQueries');

    const result = await service.run(createInput('给我不存在应用ABC的应用故障分析报告！'));

    expect(result).toMatchObject({
      ok: false,
      reportReady: false,
      error: { code: 'FAULT_TARGET_NOT_FOUND' }
    });
    expect(buildQueries).not.toHaveBeenCalled();
  });
});
