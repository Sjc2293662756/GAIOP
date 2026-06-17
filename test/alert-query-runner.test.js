const { executeAlertQuery } = require('../skills/openclaw-napm-alert-query/scripts/run_alert_query');

describe('openclaw-napm-alert-query runner', () => {
  test('should execute summary query with injected API service', async () => {
    const api = {
      async getSummary() {
        return {
          networkAlerts: {
            '192.168.1.16': [
              {
                id: 369652,
                severity: 4,
                categoryType: 3,
                metrics: ['TPIO'],
                value: [123],
                unit: ['Kbps'],
                linkType: 2,
                start: 1781488800,
                end: 1781492400
              }
            ]
          }
        };
      },
      getRequestHistory() {
        return ['https://example.test/webservice/NetInside?UserName=GAIOP&Password=***&type=alertsSummary&start=1781488800&end=1781492400&json=true'];
      }
    };

    const result = await executeAlertQuery({
      prompt: '最近一小时有哪些紧急告警',
      alertQuery: {
        mode: 'summary',
        criteria: {
          start: 1781488800,
          end: 1781492400,
          severities: [4]
        }
      }
    }, { api });

    expect(result.ok).toBe(true);
    expect(result.service).toBe('alertsSummary');
    expect(result.events).toHaveLength(1);
    expect(result.summary.bySeverity.critical).toBe(1);
    expect(result.requestUrl).toContain('type=alertsSummary');
    expect(result.requestUrl).not.toContain('secret');
    expect(result.narrationInput.schema).toBe('openclaw_napm_alert.v1');
    expect(result.reportData.dataSource.sourceSkill).toBe('openclaw-napm-alert-query');
  });

  test('should rebuild relative one-hour time range when model-provided timestamps are wrong', async () => {
    const calls = [];
    const api = {
      async getSummary(input) {
        calls.push(input);
        return {
          busAlerts: {
            '可观测239web': [
              {
                id: 669580,
                severity: 2,
                categoryType: 68,
                metrics: ['PGNPGE'],
                start: 1781517000,
                end: 1781571300
              }
            ]
          }
        };
      }
    };

    const result = await executeAlertQuery({
      prompt: '最近一小时有哪些告警',
      alertQuery: {
        mode: 'summary',
        criteria: {
          start: 1745328420,
          end: 1745332020
        }
      }
    }, {
      api,
      nowMs: Date.parse('2026-06-15T14:27:21.000Z')
    });

    expect(calls[0]).toMatchObject({
      start: 1781530020,
      end: 1781533620
    });
    expect(result.timeRange).toMatchObject({
      start: 1781530020,
      end: 1781533620,
      displayText: '最近一小时'
    });
    expect(result.summary.total).toBe(1);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALERT_RELATIVE_TIME_RANGE_REBUILT',
        originalStart: 1745328420,
        originalEnd: 1745332020
      })
    ]));
  });

  test('should prioritize critical alerts before major and minor in summary events', async () => {
    const api = {
      async getSummary() {
        return {
          busAlerts: {
            '可观测239web': [
              { id: 1, severity: 2, categoryType: 68, metrics: ['PGNPGE'], name: '轻微业务告警', start: 1781488800 },
              { id: 2, severity: 4, categoryType: 68, metrics: ['PGNPGE'], name: '紧急业务告警', start: 1781488700 },
              { id: 3, severity: 3, categoryType: 68, metrics: ['PGNPGE'], name: '重大业务告警', start: 1781488900 }
            ]
          },
          appAlerts: {
            HTTPS: [
              { id: 4, severity: 4, categoryType: 51, metrics: ['UEIO'], name: '更新的紧急应用告警', start: 1781489000 }
            ]
          }
        };
      }
    };

    const result = await executeAlertQuery({
      prompt: '最近一小时有哪些告警',
      alertQuery: {
        mode: 'summary',
        criteria: {
          start: 1781488800,
          end: 1781492400
        },
        options: {
          maxEvents: 3
        }
      }
    }, { api });

    expect(result.events.map((event) => event.severity)).toEqual([4, 4, 3]);
    expect(result.events.map((event) => event.id)).toEqual(['4', '2', '3']);
    expect(result.events.map((event) => event.name)).not.toContain('轻微业务告警');
  });

  test('should execute summary query with Chinese category label filter', async () => {
    const api = {
      async getSummary() {
        return {
          appAlerts: {
            HTTPS: [
              { id: 10, severity: 3, categoryType: 51, metrics: ['UEIO'], name: '外部应用性能下降' }
            ]
          },
          busAlerts: {
            可观测239web: [
              { id: 11, severity: 4, categoryType: 68, metrics: ['PGNPGE'], name: '业务故障告警' }
            ]
          }
        };
      }
    };

    const result = await executeAlertQuery({
      prompt: '近一小时有哪些应用告警',
      alertQuery: {
        mode: 'summary',
        criteria: {
          start: 1781488800,
          end: 1781492400,
          categories: ['应用性能告警']
        }
      }
    }, { api });

    expect(result.summary.total).toBe(1);
    expect(result.events[0]).toMatchObject({
      id: '10',
      category: 'appAlerts',
      categoryLabel: '应用性能告警'
    });
  });

  test('should force business alert prompt to busAlerts even when model mixes application categories', async () => {
    const api = {
      async getSummary() {
        return {
          appAlerts: {
            HTTPS: [
              { id: 20, severity: 3, categoryType: 51, metrics: ['UEIO'], name: '外部应用性能下降' }
            ]
          },
          busAlerts: {
            可观测239web: [
              { id: 21, severity: 4, categoryType: 68, metrics: ['PGNPGE'], name: 'T239web页面SNMP测试' }
            ]
          }
        };
      }
    };

    const result = await executeAlertQuery({
      prompt: '近一小时有哪些业务告警？',
      alertQuery: {
        mode: 'summary',
        criteria: {
          start: 1781488800,
          end: 1781492400,
          categories: ['业务应用', '业务系统', '应用性能', '业务']
        }
      }
    }, { api });

    expect(result.summary.total).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: '21',
      category: 'busAlerts',
      categoryLabel: '业务故障告警'
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALERT_PROMPT_CATEGORY_FILTER_REBUILT',
        categories: ['busAlerts']
      })
    ]));
  });

  test('should execute detail_with_timeseries query with injected API service', async () => {
    const calls = [];
    const api = {
      async getDetail(input) {
        calls.push(['detail', input]);
        return [
          {
            id: 369652,
            group: '192.168.1.16',
            severity: 4,
            categoryType: 3,
            metrics: ['TPIO'],
            unit: ['Kbps'],
            start: 1781488800,
            end: 1781492400
          }
        ];
      },
      async getMetricSeries(input) {
        calls.push(['series', input]);
        return {
          interval: { start: 1781488800 },
          metricValues: [{ values: [1, 2, 3] }]
        };
      }
    };

    const result = await executeAlertQuery({
      alertQuery: {
        mode: 'detail_with_timeseries',
        criteria: {
          eventIds: ['369652'],
          start: 1781488800,
          end: 1781492400
        }
      }
    }, { api });

    expect(result.ok).toBe(true);
    expect(result.details).toHaveLength(1);
    expect(result.metricSeries).toHaveLength(1);
    expect(result.metricSeries[0]).toMatchObject({
      eventId: '369652',
      metric: 'TPIO',
      groupType: 'IPAddress',
      values: [1, 2, 3]
    });
    expect(calls[1][1]).toMatchObject({
      metric: 'TPIO',
      groupType: 'IPAddress',
      group: '192.168.1.16'
    });
  });

  test('should enrich detail metrics from summary before metric series lookup', async () => {
    const calls = [];
    const api = {
      async getDetail(input) {
        calls.push(['detail', input]);
        return [
          {
            id: 669235,
            group: '可观测239web',
            severity: 2,
            categoryType: 68,
            metrics: [],
            unit: []
          }
        ];
      },
      async getSummary(input) {
        calls.push(['summary', input]);
        return {
          busAlerts: {
            '可观测239web': [
              {
                id: 669235,
                group: '可观测239web',
                severity: 2,
                categoryType: 68,
                metrics: ['PGNPGE'],
                unit: ['pages'],
                condition: 'if PGNPGE >= 1.0 then Minor else None'
              }
            ]
          }
        };
      },
      async getMetricSeries(input) {
        calls.push(['series', input]);
        return {
          interval: { start: 1781488800 },
          metricValues: [{ values: [4, 5] }]
        };
      }
    };

    const result = await executeAlertQuery({
      alertQuery: {
        mode: 'detail_with_timeseries',
        criteria: {
          eventIds: ['669235'],
          start: 1781488800,
          end: 1781492400
        }
      }
    }, { api });

    expect(result.ok).toBe(true);
    expect(result.details[0].metrics).toEqual(['PGNPGE']);
    expect(result.details[0].unit).toEqual(['pages']);
    expect(result.metricSeries).toHaveLength(1);
    expect(result.metricSeries[0]).toMatchObject({
      eventId: '669235',
      metric: 'PGNPGE',
      groupType: 'WebApplication',
      values: [4, 5]
    });
    expect(calls.map(([name]) => name)).toEqual(['detail', 'summary', 'series']);
  });

  test('should return explanation without requiring NetInside env', async () => {
    const result = await executeAlertQuery({
      alertQuery: {
        mode: 'explain_notification'
      }
    });

    expect(result.ok).toBe(true);
    expect(result.explanation.title).toBe('告警通知机制说明');
    expect(result.explanation.guardrail).toContain('只解释通知字段');
  });
});
