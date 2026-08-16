'use strict';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const querySkill = require('../skills/openclaw-napm-query/scripts/run_napm_query');
const packetSkill = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');

describe('NAPM Skill in-process runtime contract', () => {
  test('query skill exposes the plugin runtime entry point', () => {
    expect(querySkill.handleSkillCall).toEqual(expect.any(Function));
  });

  test('query skill executes a valid structured query passed as an object', async () => {
    const originalExecuteGatewayRequest = RequirementParserService.executeGatewayRequest;
    RequirementParserService.executeGatewayRequest = jest.fn(async (resolvedQuery) => ({
      ok: true,
      service: resolvedQuery.service,
      data: [{
        group: { type: 'IPAddress', argument: '10.0.0.1' },
        metricValues: [{ metric: { id: 'PLI' }, value: 12, unit: 'count' }]
      }],
      requestUrl: 'http://example.invalid/napi/query',
      error: null
    }));

    try {
      const result = await querySkill.handleSkillCall({
        prompt: 'recent packet-loss ranking',
        traceId: 'napm-runtime-contract-query',
        sessionState: { traceId: 'napm-runtime-contract-query' },
        resolvedQuery: {
          service: 'topValues',
          metric: 'PLI',
          metrics: ['PLI'],
          topMetric: 'PLI',
          topCount: 10,
          groups: [{ type: 'IPAddress' }],
          start: 1777982400,
          end: 1777986000,
          userRequirement: 'recent packet-loss ranking'
        }
      });

      expect(result).toMatchObject({
        ok: true,
        service: 'topValues',
        rows: [expect.objectContaining({ group: { type: 'IPAddress', argument: '10.0.0.1' } })]
      });
      expect(RequirementParserService.executeGatewayRequest).toHaveBeenCalledTimes(1);
    } finally {
      RequirementParserService.executeGatewayRequest = originalExecuteGatewayRequest;
    }
  });

  test('packet skill can build a download URL through the in-process entry point', async () => {
    expect(packetSkill.handleSkillCall).toEqual(expect.any(Function));

    const result = await packetSkill.handleSkillCall({
      mode: 'build_url_only',
      downloadType: 'packetsDown',
      packetQuery: {
        criteria: {
          host: 'https://napm.example.invalid',
          ips: ['10.0.0.1'],
          start: 1777982400,
          end: 1777986000
        }
      },
      analysis: { level: 'summary' },
      filePolicy: { keepFiles: false }
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'build_url_only',
      downloadType: 'packetsDown',
      criteria: expect.objectContaining({ ips: ['10.0.0.1'] })
    });
    expect(result.urls.download).toContain('type=packetsDown');
    expect(result.urls.download).toContain('ips=10.0.0.1');
  });
});
