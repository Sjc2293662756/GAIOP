const plugin = require('../napm-openclaw-plugin.remote');

describe('napm-openclaw-plugin topn display', () => {
  test('should render TopN object/value table instead of numeric-only samples', () => {
    const text = plugin.__test__.buildTopnUserFacingText({
      resolvedQuery: {
        metric: 'RFCI',
        groups: [{ type: 'IPAddress' }]
      }
    }, {
      responseType: 'topn',
      objectType: 'IPAddress',
      items: [
        {
          rank: 1,
          object: '192.0.2.39',
          metric: 'RFCI',
          metricLabel: '连接失败数(TCP服务器)',
          rawValue: 43792,
          formattedValue: '43792 files'
        },
        {
          rank: 2,
          object: '192.0.2.40',
          metric: 'RFCI',
          metricLabel: '连接失败数(TCP服务器)',
          rawValue: 1671,
          formattedValue: '1671 files'
        }
      ]
    });

    expect(text).toContain('| 排名 | IPAddress | 连接失败数(TCP服务器) |');
    expect(text).toContain('| 1 | 192.0.2.39 | 43792 files |');
    expect(text).toContain('| 2 | 192.0.2.40 | 1671 files |');
    expect(text).not.toContain('可查指标示例');
    expect(text).not.toContain('IP 43792');
  });
});
