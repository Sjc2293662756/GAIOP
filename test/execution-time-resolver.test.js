const {
  applyTimeOverride,
  resolveExecutionTime,
} = require('../skills/openclaw-napm-query/src/shared/timeResolver');
const { normalizeSummaryPayload } = require('../skills/openclaw-napm-summary/scripts/run_summary');
const { normalizeFaultPayload } = require('../skills/openclaw-napm-fault-diagnosis/scripts/run_fault_diagnosis');
const alertRunner = require('../skills/openclaw-napm-alert-query/scripts/run_alert_query');

const NOW_SECONDS = 1780000200;
const NOW_MS = NOW_SECONDS * 1000;

describe('execution time resolver', () => {
  test.each([
    ['last2hours', 7200],
    ['last8hours', 28800],
    ['last14days', 14 * 86400],
  ])('resolves %s without silently falling back', (key, duration) => {
    const result = resolveExecutionTime({ timeRangeKey: key, nowSeconds: NOW_SECONDS });

    expect(result).toMatchObject({
      ok: true,
      key,
      start: NOW_SECONDS - duration,
      end: NOW_SECONDS,
      alignment: 'minute_floor',
    });
  });

  test('uses Asia/Shanghai day boundaries independent of the process timezone', () => {
    expect(resolveExecutionTime({ timeRangeKey: 'today', nowSeconds: NOW_SECONDS })).toMatchObject({
      start: 1779984000,
      end: NOW_SECONDS,
      boundary: 'local_day',
    });
    expect(resolveExecutionTime({ timeRangeKey: 'yesterday', nowSeconds: NOW_SECONDS })).toMatchObject({
      start: 1779897600,
      end: 1779983940,
      boundary: 'local_day',
    });
  });

  test('normalizes explicit millisecond timestamps before they reach an API', () => {
    const result = resolveExecutionTime({
      start: 1779996600123,
      end: 1780000200987,
      nowSeconds: NOW_SECONDS,
    });

    expect(result).toMatchObject({
      ok: true,
      key: 'custom',
      start: 1779996600,
      end: 1780000200,
    });
  });

  test('query normalization fills root execution fields for a direct tool call', () => {
    const query = {
      service: 'topValues',
      timeRange: { key: 'last2hours' },
    };

    applyTimeOverride(query, NOW_MS);

    expect(query).toMatchObject({
      start: NOW_SECONDS - 7200,
      end: NOW_SECONDS,
      timeRange: { key: 'last2hours' },
    });
  });

  test('does not turn deprecated nested timestamps into an implicit default query', () => {
    const query = {
      service: 'topValues',
      timeRange: { start: NOW_SECONDS - 3600, end: NOW_SECONDS },
    };

    applyTimeOverride(query, NOW_MS);

    expect(query.start).toBeUndefined();
    expect(query.end).toBeUndefined();
  });

  test('summary and fault direct calls use the same relative window', () => {
    const summary = normalizeSummaryPayload({ timeRange: { key: 'last2hours' } }, { nowMs: NOW_MS });
    const fault = normalizeFaultPayload({ timeRange: { key: 'last2hours' } }, { nowMs: NOW_MS });

    expect(summary.timeRange).toMatchObject({ start: NOW_SECONDS - 7200, end: NOW_SECONDS, key: 'last2hours' });
    expect(fault.timeRange).toMatchObject({ start: NOW_SECONDS - 7200, end: NOW_SECONDS, key: 'last2hours' });
    expect(fault.timeRange.faultWindow).toEqual({ start: NOW_SECONDS - 7200, end: NOW_SECONDS });
  });

  test('alert prompt parsing covers calendar and Chinese relative windows', () => {
    const resolvePrompt = alertRunner.__test__.resolveRelativeTimeRangeFromPrompt;

    expect(resolvePrompt('今天有哪些告警', NOW_MS)).toMatchObject({ key: 'today', start: 1779984000, end: NOW_SECONDS });
    expect(resolvePrompt('昨天有哪些告警', NOW_MS)).toMatchObject({ key: 'yesterday', start: 1779897600, end: 1779983940 });
    expect(resolvePrompt('最近两小时有哪些告警', NOW_MS)).toMatchObject({ key: 'last7200seconds', start: NOW_SECONDS - 7200, end: NOW_SECONDS });
  });
});
