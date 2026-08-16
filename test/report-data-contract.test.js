'use strict';

const { buildOpenClawReplyContract } = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');

describe('NAPM query report data contract', () => {
  test('builds canonical reportData for a topn query result', () => {
    const result = buildOpenClawReplyContract({
      ok: true,
      prompt: 'which applications have the highest PLI',
      service: 'topValues',
      responseType: 'topn',
      resolvedQuery: {
        service: 'topValues',
        metric: 'PLI',
        metrics: ['PLI'],
        groups: [{ type: 'WebApplication' }],
        start: 1_700_000_000,
        end: 1_700_003_600
      },
      rows: [{ object: '239web', metric: 'PLI', value: 12.3 }],
      summary: { title: 'Top applications', highlights: ['239web'] },
      narrationStructure: {
        responseType: 'topn',
        title: 'Top applications',
        items: [{ rank: 1, object: '239web', metric: 'PLI', value: 12.3 }]
      }
    }, { forwardDisplayText: false });

    expect(result.reportData).toMatchObject({
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'quick_report',
      format: 'docx',
      dataSource: { queryService: 'topValues', metrics: ['PLI'] },
      sections: expect.arrayContaining([
        expect.objectContaining({ type: 'table' })
      ])
    });
  });
});
