'use strict';

const {
  resolveExecutionTime,
  isExecutionTimeRange,
} = require('../skills/openclaw-napm-query/src/shared/timeResolver');
const { normalizeSummaryPayload } = require('../skills/openclaw-napm-summary/scripts/run_summary');
const { normalizeFaultPayload } = require('../skills/openclaw-napm-fault-diagnosis/scripts/run_fault_diagnosis');
const SummaryService = require('../skills/openclaw-napm-summary/services/SummaryService');
const FaultDiagnosisService = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');

const NOW_SECONDS = 1780000200;

describe('service execution-time boundary', () => {
  test('creates an immutable range from an injected clock', () => {
    const range = resolveExecutionTime({
      timeRangeKey: 'last2hours',
      clock: { nowSeconds: () => NOW_SECONDS }
    });

    expect(isExecutionTimeRange(range)).toBe(true);
    expect(Object.isFrozen(range)).toBe(true);
    expect(range).toMatchObject({ start: NOW_SECONDS - 7200, end: NOW_SECONDS });
  });

  test('runners attach the immutable range they resolved', () => {
    const summary = normalizeSummaryPayload({ timeRange: { key: 'last2hours' } }, { nowMs: NOW_SECONDS * 1000 });
    const fault = normalizeFaultPayload({ timeRange: { key: 'last2hours' } }, { nowMs: NOW_SECONDS * 1000 });

    expect(isExecutionTimeRange(summary.executionTimeRange)).toBe(true);
    expect(isExecutionTimeRange(fault.executionTimeRange)).toBe(true);
    expect(fault.executionTimeRange.faultWindow).toEqual({ start: NOW_SECONDS - 7200, end: NOW_SECONDS });
  });

  test('fault baseline is minute-aligned and requires a complete window', () => {
    const fault = normalizeFaultPayload({
      timeRange: {
        faultWindow: { start: NOW_SECONDS - 7201, end: NOW_SECONDS + 59 },
        baselineWindow: { start: NOW_SECONDS - 14401, end: NOW_SECONDS - 7201 }
      }
    }, { nowMs: NOW_SECONDS * 1000 });

    expect(fault.executionTimeRange.faultWindow).toEqual({
      start: NOW_SECONDS - 7260,
      end: NOW_SECONDS
    });
    expect(fault.executionTimeRange.baselineWindow).toEqual({
      start: NOW_SECONDS - 14460,
      end: NOW_SECONDS - 7260
    });
    expect(fault.executionTimeRange.baselineWindow.start % 60).toBe(0);
    expect(fault.executionTimeRange.baselineWindow.end % 60).toBe(0);
    expect(Object.isFrozen(fault.executionTimeRange.baselineWindow)).toBe(true);

    expect(() => normalizeFaultPayload({
      timeRange: { baselineWindow: { start: NOW_SECONDS - 7200 } }
    }, { nowMs: NOW_SECONDS * 1000 })).toThrow('Explicit start/end must both be valid Unix timestamps');
  });

  test('services reject missing execution time before any API work', async () => {
    const summaryClient = { requestHistory: [] };
    const faultClient = { request: jest.fn() };
    const summary = new SummaryService({ client: summaryClient });
    const fault = new FaultDiagnosisService({ client: faultClient });

    await expect(summary.run({ scope: { type: 'global' } })).rejects.toMatchObject({
      code: 'EXECUTION_TIME_RANGE_REQUIRED'
    });
    await expect(summary.run({
      scope: { type: 'global' },
      timeRange: { start: NOW_SECONDS - 7200, end: NOW_SECONDS }
    })).rejects.toMatchObject({ code: 'EXECUTION_TIME_RANGE_REQUIRED' });
    await expect(fault.start({ description: 'test' })).rejects.toMatchObject({
      code: 'EXECUTION_TIME_RANGE_REQUIRED'
    });
    await expect(fault.start({
      description: 'test',
      timeRange: { start: NOW_SECONDS - 7200, end: NOW_SECONDS }
    })).rejects.toMatchObject({ code: 'EXECUTION_TIME_RANGE_REQUIRED' });
    expect(faultClient.request).not.toHaveBeenCalled();
  });
});
