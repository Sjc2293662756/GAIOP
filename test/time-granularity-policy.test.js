'use strict';

const fs = require('fs');
const path = require('path');
const {
  selectGranularityForDuration,
  selectGranularityForRange
} = require('../skills/shared/TimeGranularityPolicy');
const InspectionTrafficAnalysisService = require('../skills/openclaw-napm-inspection/services/InspectionTrafficAnalysisService');
const SummaryService = require('../skills/openclaw-napm-summary/services/SummaryService');
const SummaryClient = require('../skills/openclaw-napm-summary/services/SummaryClient');
const FaultDiagnosisService = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');
const LegacyInspectionTrafficAnalysisService = require('../skills/openclaw-napm-inspection/InspectionTrafficAnalysisService');
const { __test__: queryRuntimeTest } = require('../skills/openclaw-napm-query/scripts/run_napm_query');

describe('shared automatic time granularity policy', () => {
  test.each([
    [undefined, 60],
    [0, 60],
    [6 * 3600, 60],
    [(6 * 3600) + 1, 300],
    [3 * 86400, 300],
    [(3 * 86400) + 1, 3600],
    [30 * 86400, 3600],
    [3599999, 3600],
    [3600000, 86400],
    [3600001, 86400]
  ])('maps duration %s seconds to %s seconds', (duration, expected) => {
    expect(selectGranularityForDuration(duration)).toBe(expected);
  });

  test('uses the absolute range and defaults invalid ranges to one minute', () => {
    expect(selectGranularityForRange(1000, 1000 + 86400)).toBe(300);
    expect(selectGranularityForRange(1000 + 86400, 1000)).toBe(300);
    expect(selectGranularityForRange('invalid', 1000)).toBe(60);
  });

  test.each([
    ['inspection', (start, end) => InspectionTrafficAnalysisService.__test__.selectGranularity(end - start)],
    ['summary service', (start, end) => new SummaryService({ client: {} })._autoGranularity(start, end)],
    ['summary client', (start, end) => new SummaryClient({})._autoGranularity(start, end)],
    ['fault diagnosis', (start, end) => new FaultDiagnosisService({ client: {}, steps: {} })._autoGranularity(start, end)]
  ])('%s delegates automatic selection to the shared policy', (_name, select) => {
    const start = 1780000000;
    expect(select(start, start + 6 * 3600)).toBe(60);
    expect(select(start, start + 86400)).toBe(300);
    expect(select(start, start + 7 * 86400)).toBe(3600);
    expect(select(start, start + 3600000)).toBe(86400);
  });

  test('ordinary timeValues metadata repair uses the shared policy', () => {
    const corrections = [];
    const query = {
      service: 'timeValues',
      start: 1780000000,
      end: 1780000000 + 30 * 86400,
      granularity: null
    };

    QueryMetadataConstraintService.normalizeGranularity(query, corrections);

    expect(query.granularity).toBe(3600);
    expect(corrections).toEqual([
      expect.objectContaining({ action: 'normalize_granularity', to: 3600 })
    ]);
  });

  test('ordinary query runtime selects from the normalized execution range', () => {
    const start = 1780000019;
    const query = queryRuntimeTest.normalizeResolvedQueryShape({
      service: 'timeValues',
      start,
      end: start + 86400,
      metrics: ['TPIO']
    });

    expect(query.start % 60).toBe(0);
    expect(query.end % 60).toBe(0);
    expect(query.granularity).toBe(300);
  });

  test('legacy inspection compatibility copy uses the shared policy', () => {
    expect(
      LegacyInspectionTrafficAnalysisService.__test__.selectGranularityForDuration(86400)
    ).toBe(300);
  });

  test('a valid explicit granularity is not overwritten', () => {
    const corrections = [];
    const query = {
      service: 'timeValues',
      start: 1780000000,
      end: 1780000000 + 3600000,
      granularity: 300
    };

    QueryMetadataConstraintService.normalizeGranularity(query, corrections);

    expect(query.granularity).toBe(300);
    expect(corrections).toEqual([]);
  });

  test('both resolution specs publish the same duration policy', () => {
    const skillSpec = JSON.parse(fs.readFileSync(path.join(
      __dirname,
      '..',
      'skills',
      'openclaw-napm-query',
      'config',
      'napm-resolution-spec.v1.json'
    ), 'utf8'));
    const expectedPolicy = {
      defaultGranularity: 60,
      rules: [
        { maxDurationSeconds: 21600, granularity: 60 },
        { maxDurationSeconds: 259200, granularity: 300 },
        { maxDurationSeconds: 3599999, granularity: 3600 },
        { minDurationSeconds: 3600000, granularity: 86400 }
      ]
    };

    expect(skillSpec.time.automaticGranularityPolicy).toEqual(expectedPolicy);
  });
});
