const { evaluateSettledPlan } = require('../skills/shared/ExecutionOutcome');

describe('ExecutionOutcome', () => {
  test('distinguishes empty data from a failed query', () => {
    const plan = [
      { label: 'empty', fn: () => null },
      { label: 'failed', fn: () => null }
    ];
    const execution = evaluateSettledPlan(plan, [
      { status: 'fulfilled', value: [] },
      { status: 'rejected', reason: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }
    ]);

    expect(execution.outcomes).toEqual([
      { label: 'empty', required: true, status: 'empty' },
      {
        label: 'failed',
        required: true,
        status: 'failed',
        error: { code: 'ETIMEDOUT', message: 'timeout' }
      }
    ]);
    expect(execution.completeness).toMatchObject({
      status: 'partial',
      partial: true,
      requiredUsableCount: 1,
      emptyRequiredCount: 1,
      failedRequiredCount: 1
    });
  });

  test('fails when every required query fails even if an optional query succeeds', () => {
    const execution = evaluateSettledPlan([
      { label: 'required', fn: () => null },
      { label: 'optional', required: false, fn: () => null }
    ], [
      { status: 'rejected', reason: new Error('unavailable') },
      { status: 'fulfilled', value: { version: '1.0' } }
    ]);

    expect(execution.completeness).toMatchObject({
      status: 'failed',
      partial: false,
      failedRequiredCount: 1
    });
  });

  test('marks a completed but entirely empty required plan', () => {
    const execution = evaluateSettledPlan([
      { label: 'first', fn: () => null },
      { label: 'second', fn: () => null }
    ], [
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: null }
    ]);

    expect(execution.completeness).toMatchObject({
      status: 'success',
      partial: false,
      emptyRequiredCount: 2,
      allRequiredEmpty: true
    });
  });
});
