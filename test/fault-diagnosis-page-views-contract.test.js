'use strict';

const {
  FaultDiagnosisSteps
} = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisSteps');

describe('fault diagnosis pageViews contract', () => {
  let client;
  let steps;

  beforeEach(() => {
    client = { request: jest.fn(async () => []) };
    steps = new FaultDiagnosisSteps({ client });
  });

  test.each([
    [
      'B/S error detail',
      '_bsStep3',
      {
        pageErrorAnalysis: {
          topValues: [{ pageFamilyId: '8573007', keyLabel: '/error' }]
        }
      }
    ],
    [
      'B/S performance detail',
      '_perfStep3',
      {
        pageDelayAnalysis: {
          topValues: [{
            groupPath: 'root>pages>page 8573008/https://example.invalid/slow',
            metricValues: [{ metric: { id: 'PGNSLPGE' }, value: 3 }]
          }]
        }
      }
    ]
  ])('uses the shared default maxLimit for %s', async (_label, method, previousData) => {
    const plan = steps[method]({
      faultStart: 1785310980,
      faultEnd: 1785314580,
      _prevStepRawData: previousData
    });

    expect(plan.queries).toHaveLength(1);
    await plan.queries[0].fn();

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith('pageViews', {
      start: 1785310980,
      end: 1785314580,
      pageFamilyId: expect.stringMatching(/^857300[78]$/),
      maxLimit: 20
    });
  });

  test('honors a validated detail limit and reads the normalized httpStatus field', async () => {
    const plan = steps._bsStep3({
      faultStart: 1785310980,
      faultEnd: 1785314580,
      pageViewsMaxLimit: 50,
      _prevStepRawData: {
        pageErrorAnalysis: [{ pageFamilyId: '8573007' }]
      }
    });

    await plan.queries[0].fn();

    expect(client.request).toHaveBeenCalledWith('pageViews', expect.objectContaining({
      pageFamilyId: '8573007',
      maxLimit: 50
    }));
    expect(steps._pageHasStatusCode({ data: [{ httpStatus: 500 }] }, '500')).toBe(true);
    expect(steps._pageHasStatusCode({ rows: [{ statusCode: 404 }] }, '400')).toBe(true);
    expect(steps._pageHasStatusCode({ data: [{ httpStatus: 200, http500S: 1 }] }, '500')).toBe(true);
    expect(steps._pageHasStatusCode({ data: [{ httpStatus: 200 }] }, '500')).toBe(false);
  });
});
