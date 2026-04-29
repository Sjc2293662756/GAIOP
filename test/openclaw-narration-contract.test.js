const { buildOpenClawReplyContract } = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');

describe('OpenClawNarrationContractService', () => {
  test('should build machine narration payload with topn narration structure', () => {
    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        metric: 'TPIO'
      },
      summary: {
        title: 'Top 3 query completed',
        highlights: ['metric=TPIO'],
        rowCount: 3,
        empty: false
      },
      rows: [
        { object: 'app-a', values: { TPIO: 123.456 }, units: { TPIO: 'Mbps' } },
        { object: 'app-b', values: { TPIO: 98.1 }, units: { TPIO: 'Mbps' } },
        { object: 'app-c', values: { TPIO: 76.5 }, units: { TPIO: 'Mbps' } }
      ],
      followUpActions: [
        { query: '看第1名详情' },
        { query: '查看最近24小时趋势' }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.responseMode).toBe('machine_narration_input');
    expect(payload.displayText).toBeNull();
    expect(payload.narrationStructure).toBeTruthy();
    expect(payload.narrationStructure.responseType).toBe('topn');
    expect(payload.narrationStructure.items).toHaveLength(3);
    expect(payload.narrationInput.result.narrationStructure.responseType).toBe('topn');
    expect(payload.narrationInput.followUp.prompts).toEqual(['看第1名详情', '查看最近24小时趋势']);
    expect(payload.narrationInput.renderPolicy.narrationRequired).toBe(true);
  });

  test('should preserve display text when verbatim forwarding is enabled', () => {
    const payload = buildOpenClawReplyContract({
      service: 'averageValues',
      requestUrl: 'http://fake/query',
      summary: {
        title: 'Average query completed',
        displayText: '平均查询已完成'
      }
    }, {
      forwardDisplayText: true,
      appendRequestUrlToDisplayText: (displayText, requestUrl) => `${displayText}\n${requestUrl}`
    });

    expect(payload.responseMode).toBe('verbatim_display_text');
    expect(payload.displayText).toContain('平均查询已完成');
    expect(payload.displayText).toContain('http://fake/query');
    expect(payload.replyText).toBe(payload.displayText);
  });
});
