const { buildOpenClawReplyContract } = require('../skills/openclaw-napm-query/services/OpenClawNarrationContractService');

describe('OpenClawNarrationContractService', () => {
  test('should build machine narration payload with topn narration structure', () => {
    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        metric: 'TPIO',
        groups: [{ type: 'DefinedApp' }]
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
        { query: '\u770b\u7b2c1\u540d\u8be6\u60c5' },
        { query: '\u67e5\u770b\u6700\u8fd124\u5c0f\u65f6\u8d8b\u52bf' }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.responseMode).toBe('machine_narration_input');
    expect(payload.displayText).toBeNull();
    expect(payload.narrationStructure).toBeTruthy();
    expect(payload.narrationStructure.responseType).toBe('topn');
    expect(payload.narrationStructure.title).toBe('Top 3 query completed');
    expect(payload.narrationStructure.explanation).toContain('DefinedApp');
    expect(payload.narrationStructure.explanation).toContain('TPIO');
    expect(payload.narrationStructure.items).toHaveLength(3);
    expect(payload.narrationInput.result.narrationStructure.responseType).toBe('topn');
    expect(payload.narrationInput.followUp.prompts).toEqual([
      '\u770b\u7b2c1\u540d\u8be6\u60c5',
      '\u67e5\u770b\u6700\u8fd124\u5c0f\u65f6\u8d8b\u52bf'
    ]);
    expect(payload.narrationInput.renderPolicy.narrationRequired).toBe(true);
  });

  test('should distinguish query metric and sort metric for packet-loss topn narration', () => {
    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        metric: 'PLI',
        metrics: ['PLI'],
        topMetric: 'TPIO',
        groups: [{ type: 'IPAddress' }]
      },
      summary: {
        title: '排行结果',
        highlights: ['指标：PLI', '排序指标：TPIO'],
        rowCount: 3,
        empty: false,
        topMetric: 'TPIO'
      },
      rows: [
        { object: '111.36.57.69', values: { PLI: 15.77 }, units: { PLI: '%' } },
        { object: '51.91.64.198', values: { PLI: 3.76 }, units: { PLI: '%' } },
        { object: '192.0.2.40', values: { PLI: 2.92 }, units: { PLI: '%' } }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('topn');
    expect(payload.narrationStructure.explanation).toContain('查询指标为 PLI');
    expect(payload.narrationStructure.explanation).toContain('排序指标为 TPIO');
    expect(payload.narrationStructure.items[0].metric).toBe('PLI');
  });

  test('should bind TopN object labels with metric values for RFCI narration', () => {
    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        metric: 'RFCI',
        metrics: ['RFCI'],
        topMetric: 'RFCI',
        groups: [{ type: 'IPAddress' }]
      },
      summary: {
        title: 'Ranking result',
        rowCount: 2,
        empty: false,
        topMetric: 'RFCI'
      },
      rows: [
        {
          group: { argument: '192.0.2.39', key: 'IPAddress', label: 'IP地址' },
          groupPath: 'v12.0.0:engine 0/0/napm/DB>clientIP 192.0.2.39',
          metricValues: [
            { metric: { id: 'RFCI', label: '连接失败数(TCP服务器)', unit: '#' }, value: 43792, unit: 'files' }
          ]
        },
        {
          group: { argument: '192.0.2.40', key: 'IPAddress', label: 'IP地址' },
          groupPath: 'v12.0.0:engine 0/0/napm/DB>clientIP 192.0.2.40',
          metricValues: [
            { metric: { id: 'RFCI', label: '连接失败数(TCP服务器)', unit: '#' }, value: 1671, unit: 'files' }
          ]
        }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('topn');
    expect(payload.narrationStructure.items[0]).toMatchObject({
      objectType: 'IPAddress',
      object: '192.0.2.39',
      metric: 'RFCI',
      metricLabel: '连接失败数(TCP服务器)',
      rawValue: 43792,
      formattedValue: '43792 files'
    });
    expect(payload.summary.displayText).toContain('| 1 | 192.0.2.39 | 43792 files |');
    expect(payload.summary.displayText).not.toContain('object_1');
  });

  test('should preserve display text when verbatim forwarding is enabled', () => {
    const payload = buildOpenClawReplyContract({
      service: 'averageValues',
      requestUrl: 'http://fake/query',
      summary: {
        title: 'Average query completed',
        displayText: '\u5e73\u5747\u67e5\u8be2\u5df2\u5b8c\u6210'
      }
    }, {
      forwardDisplayText: true,
      appendRequestUrlToDisplayText: (displayText, requestUrl) => `${displayText}\n${requestUrl}`
    });

    expect(payload.responseMode).toBe('verbatim_display_text');
    expect(payload.displayText).toContain('\u5e73\u5747\u67e5\u8be2\u5df2\u5b8c\u6210');
    expect(payload.displayText).toContain('http://fake/query');
    expect(payload.replyText).toBe(payload.displayText);
  });

  test('should prepend time range when forwarding verbatim display text', () => {
    const payload = buildOpenClawReplyContract({
      service: 'topValues',
      resolvedQuery: {
        service: 'topValues',
        start: 1777478400,
        end: 1777564800
      },
      summary: {
        title: '业务报错排行',
        displayText: '已注册业务中：回溯238web 和 可观测238_测试111 各 284 次并列最高'
      }
    }, {
      forwardDisplayText: true
    });

    expect(payload.responseMode).toBe('verbatim_display_text');
    expect(payload.displayText).toContain('数据时间');
    expect(payload.displayText).toContain('2026-04-30 00:00:00');
    expect(payload.displayText).toContain('2026-05-01 00:00:00');
    expect(payload.displayText).toContain('已注册业务中：回溯238web 和 可观测238_测试111 各 284 次并列最高');
  });

  test('should build explicit overview narration structure', () => {
    const payload = buildOpenClawReplyContract({
      service: 'overview',
      resolvedQuery: {
        service: 'averageValues',
        start: 1777478400,
        end: 1777564800
      },
      summary: {
        title: 'Overview scene network executed',
        highlights: ['queries=9', 'success=9'],
        rowCount: 9,
        empty: false
      },
      overview: {
        scene: 'network',
        discovery: {
          selectedObject: '101.254.114.237',
          metric: 'RFCI',
          rank: 1,
          targetObjectType: 'IPAddress'
        },
        modules: [
          {
            key: 'networkAlertSummary',
            label: '\u544a\u8b66\u6982\u51b5',
            ok: true,
            rowCount: 1,
            summary: '\u544a\u8b66\u6982\u51b5\uff1a\u68c0\u6d4b\u5230 3 \u6761\u544a\u8b66',
            preview: [{ object: '\u7cfb\u7edfA' }]
          }
        ],
        topFindings: [
          '\u544a\u8b66\u6982\u51b5\uff1a\u68c0\u6d4b\u5230 3 \u6761\u544a\u8b66',
          'IP\u541e\u5410\u6392\u884c\uff1a1.1.1.1 100 kb/sec'
        ],
        queries: [
          { key: 'networkAlertSummary' },
          { key: 'topIpThroughput' }
        ]
      }
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('overview');
    expect(payload.narrationStructure.scene).toBe('network');
    expect(payload.narrationStructure.discovery).toEqual({
      object: '101.254.114.237',
      metric: 'RFCI',
      rank: 1,
      targetObjectType: 'IPAddress'
    });
    expect(payload.narrationStructure.summary).toEqual(
      expect.arrayContaining(['queries=9', 'success=9', '\u544a\u8b66\u6982\u51b5\uff1a\u68c0\u6d4b\u5230 3 \u6761\u544a\u8b66'])
    );
    expect(payload.narrationStructure.modules).toHaveLength(1);
    expect(payload.narrationStructure.modules[0].label).toBe('\u544a\u8b66\u6982\u51b5');
  });

  test('should build natural application overview summary', () => {
    const payload = buildOpenClawReplyContract({
      service: 'overview',
      resolvedQuery: {
        service: 'averageValues',
        start: 1777478400,
        end: 1777564800
      },
      summary: {
        title: 'Overview scene application executed',
        highlights: ['queries=7', 'success=7'],
        rowCount: 7,
        empty: false
      },
      overview: {
        scene: 'application',
        modules: [
          {
            key: 'applicationAlertSummary',
            label: '\u5e94\u7528\u544a\u8b66\u6982\u51b5',
            ok: true,
            rowCount: 1,
            summary: '\u5e94\u7528\u544a\u8b66\u6982\u51b5\uff1a\u68c0\u6d4b\u5230 10 \u6761\u544a\u8b66\uff0c\u6700\u9ad8\u7ea7\u522b 4\uff0c\u6d89\u53ca \u5e94\u7528A\u3001\u5e94\u7528B \u7b49',
            preview: [{ object: '\u5e94\u7528A' }, { object: '\u5e94\u7528B' }, { object: '\u5e94\u7528C' }]
          },
          {
            key: 'topApplicationThroughput',
            label: '\u5e94\u7528\u541e\u5410\u6392\u884c',
            ok: true,
            rowCount: 3,
            summary: '\u5e94\u7528\u541e\u5410\u6392\u884c\uff1a\u5e94\u7528A 10 kb/sec\uff1b\u5e94\u7528B 8 kb/sec\uff1b\u5e94\u7528C 6 kb/sec',
            preview: [
              { object: '\u5e94\u7528A', valueText: '10 kb/sec' },
              { object: '\u5e94\u7528B', valueText: '8 kb/sec' },
              { object: '\u5e94\u7528C', valueText: '6 kb/sec' }
            ]
          },
          {
            key: 'appAccessTrend',
            label: '\u5e94\u7528\u8bbf\u95ee\u8d8b\u52bf',
            ok: true,
            rowCount: 1,
            summary: '\u5e94\u7528\u8bbf\u95ee\u8d8b\u52bf\uff1a\u5171 24 \u4e2a\u65f6\u95f4\u70b9\uff0c\u5cf0\u503c 384 files\uff0c\u6700\u65b0 0 files',
            preview: []
          },
          {
            key: 'appExperienceTrend',
            label: '\u5e94\u7528\u4f53\u9a8c\u8d8b\u52bf',
            ok: true,
            rowCount: 1,
            summary: '\u5e94\u7528\u4f53\u9a8c\u8d8b\u52bf\uff1a\u5171 24 \u4e2a\u65f6\u95f4\u70b9\uff0c\u5cf0\u503c 7.75 sec\uff0c\u6700\u65b0 0 sec',
            preview: []
          },
          {
            key: 'appFailureTop',
            label: '\u5e94\u7528\u5931\u8d25\u6392\u884c',
            ok: true,
            rowCount: 3,
            summary: '\u5e94\u7528\u5931\u8d25\u6392\u884c\uff1a\u5e94\u7528A 100 files\uff1b\u5e94\u7528B 80 files\uff1b\u5e94\u7528C 60 files',
            preview: [{ object: '\u5e94\u7528A' }, { object: '\u5e94\u7528B' }, { object: '\u5e94\u7528C' }]
          }
        ],
        topFindings: [],
        queries: [
          { key: 'applicationAlertSummary' },
          { key: 'topApplicationThroughput' },
          { key: 'appAccessTrend' },
          { key: 'appExperienceTrend' },
          { key: 'appFailureTop' }
        ]
      }
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('overview');
    expect(payload.narrationStructure.scene).toBe('application');
    expect(payload.narrationStructure.queryCount).toBe(5);
    expect(payload.narrationStructure.summary[0]).toContain('\u4eca\u5929\u5e94\u7528\u4fa7\u544a\u8b66\u8f83\u591a');
    expect(payload.narrationStructure.summary.join(' ')).toContain('\u6d41\u91cf\u4e3b\u8981\u96c6\u4e2d\u5728');
    expect(payload.narrationStructure.summary.join(' ')).toContain('\u5931\u8d25\u91cf\u9760\u524d\u7684\u5e94\u7528');
    expect(payload.narrationStructure.modules).toHaveLength(5);
  });

  test('should make WebApplication catalog narration factual and unfiltered', () => {
    const payload = buildOpenClawReplyContract({
      service: 'groups',
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }],
        semanticConstraints: {
          operation: 'metadata_list'
        }
      },
      metadata: {
        requestedObjectType: 'WebApplication',
        effectiveObjectType: 'WebApplication',
        providerType: 'applications',
        apiType: 'applications',
        applicationTypeFilter: [3],
        applicationCatalogRole: 'web_business'
      },
      summary: {
        title: '对象列表',
        rowCount: 3,
        empty: false
      },
      rows: [
        { label: '交通可观测性分析平台', value: '交通可观测性分析平台', type: 'WebApplication', applicationType: 3 },
        { label: 'Esxi-Web', value: 'Esxi-Web', type: 'WebApplication', applicationType: 3 },
        { label: 'Zabbix-web', value: 'Zabbix-web', type: 'WebApplication', applicationType: 3 }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('group_list');
    expect(payload.narrationStructure.itemCount).toBe(3);
    expect(payload.narrationStructure.items.map(item => item.value)).toEqual([
      '交通可观测性分析平台',
      'Esxi-Web',
      'Zabbix-web'
    ]);
    expect(payload.narrationStructure.explanation).toContain('applications');
    expect(payload.narrationStructure.explanation).toContain('Type=3');
    expect(payload.narrationStructure.explanation).toContain('不要按中文名称');
    expect(payload.narrationStructure.explanation).toContain('活跃流量');
    expect(payload.summary.displayText).toContain('Esxi-Web');
    expect(payload.summary.displayText).toContain('Zabbix-web');
    expect(payload.summary.displayText).toContain('不是按流量活跃度过滤');
    expect(payload.summary.displayText).toContain('不是中文名称过滤');
  });

  test('should render a complete DefinedApp catalog instead of a generic title', () => {
    const payload = buildOpenClawReplyContract({
      service: 'groups',
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'DefinedApp' }],
        semanticConstraints: {
          operation: 'metadata_list',
          workflowType: 'object_inventory',
          targetObjectType: 'DefinedApp'
        }
      },
      metadata: {
        requestedObjectType: 'DefinedApp',
        effectiveObjectType: 'DefinedApp',
        providerType: 'applications',
        apiType: 'applications',
        applicationTypeFilter: [2],
        applicationCatalogRole: 'defined_application'
      },
      summary: {
        title: '对象列表',
        rowCount: 3,
        empty: false
      },
      rows: [
        { label: '回溯238', value: '回溯238', type: 'DefinedApp', applicationType: 2 },
        { label: 'Esxi-local', value: 'Esxi-local', type: 'DefinedApp', applicationType: 2 },
        { label: 'HIS系统1', value: 'HIS系统1', type: 'DefinedApp', applicationType: 2 }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('group_list');
    expect(payload.narrationStructure.displayText).toContain('3 个已定义应用');
    expect(payload.summary.displayText).toContain('DefinedApp');
    expect(payload.summary.displayText).toContain('applications Type=2');
    expect(payload.summary.displayText).toContain('回溯238');
    expect(payload.summary.displayText).toContain('Esxi-local');
    expect(payload.summary.displayText).not.toBe('对象列表');
  });

  test('should constrain WebApplication metric-list narration to returned web metrics only', () => {
    const payload = buildOpenClawReplyContract({
      service: 'metrics',
      resolvedQuery: {
        service: 'metrics',
        groups: [{ type: 'WebApplication' }],
        start: 1777478400,
        end: 1777564800
      },
      summary: {
        title: '指标列表',
        rowCount: 4,
        empty: false
      },
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'PGHTTP500', label: 'HTTP 500数量', unit: 'objects' },
        { id: 'PGTME', label: '页面延时', unit: 'sec' },
        { id: 'POPT', label: '优化的页面数量百分比', unit: '%' }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('metric_list');
    expect(payload.narrationStructure.explanation).toContain('WebApplication');
    expect(payload.narrationStructure.explanation).toContain('PGNPGE');
    expect(payload.narrationStructure.explanation).toContain('PGHTTP500');
    expect(payload.narrationStructure.explanation).toContain('不\u8981\u63d0\u53ca');
    expect(payload.narrationStructure.explanation).toContain('RTT');
    expect(payload.narrationStructure.explanation).toContain('告警');
  });

  test('should build deterministic metric-list display text from returned rows', () => {
    const payload = buildOpenClawReplyContract({
      service: 'metrics',
      resolvedQuery: {
        service: 'metrics',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }]
      },
      summary: {
        title: '指标列表',
        rowCount: 3,
        empty: false
      },
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'PGRT', label: '页面访问率', unit: 'pages/min' },
        { id: 'PGTME', label: '页面延时', unit: 'sec' }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.displayText).toContain('WebApplication');
    expect(payload.narrationStructure.displayText).toContain('3 个指标');
    expect(payload.summary.displayText).toContain('PGNPGE');
    expect(payload.summary.displayText).toContain('PGRT');
    expect(payload.summary.displayText).toContain('PGTME');
    expect(payload.summary.displayText).toContain('页面访问率（PGRT，pages/min）');
    expect(payload.summary.displayText).not.toContain('页面访问率（PGNPGE');
  });

  test('should constrain ClientBusinessGroup metric-list narration to business-owned metrics only', () => {
    const payload = buildOpenClawReplyContract({
      service: 'metrics',
      resolvedQuery: {
        service: 'metrics',
        groups: [{ type: 'ClientBusinessGroup' }],
        start: 1777478400,
        end: 1777564800
      },
      summary: {
        title: '指标列表',
        rowCount: 3,
        empty: false
      },
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'PGHTTP500', label: 'HTTP 500数量', unit: 'objects' },
        { id: 'PFOPT', label: '全优化页面百分比', unit: '%' }
      ]
    }, {
      forwardDisplayText: false
    });

    expect(payload.narrationStructure.responseType).toBe('metric_list');
    expect(payload.narrationStructure.explanation).toContain('ClientBusinessGroup');
    expect(payload.narrationStructure.explanation).toContain('业务网络');
    expect(payload.narrationStructure.explanation).toContain('PGNPGE');
    expect(payload.narrationStructure.explanation).toContain('RTT');
    expect(payload.narrationStructure.explanation).toContain('吞吐');
  });
});
