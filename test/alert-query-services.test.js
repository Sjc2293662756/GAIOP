const AlertApiService = require('../skills/openclaw-napm-alert-query/services/AlertApiService');
const { validateAlertQuery } = require('../skills/openclaw-napm-alert-query/services/AlertQueryValidator');
const {
  normalizeSummary,
  normalizeDetail,
  normalizeTimeline,
  filterEvents,
} = require('../skills/openclaw-napm-alert-query/services/AlertNormalizerService');
const { analyzeEvents } = require('../skills/openclaw-napm-alert-query/services/AlertAnalyzerService');
const {
  buildPacketHandoff,
} = require('../skills/openclaw-napm-alert-query/services/AlertNarrationContractService');

describe('openclaw-napm-alert-query services', () => {
  test('should validate executable alert query timestamps and normalize milliseconds', () => {
    const result = validateAlertQuery({
      mode: 'summary',
      criteria: {
        start: 1781488800000,
        end: 1781492400000,
        severities: ['4']
      }
    });

    expect(result.ok).toBe(true);
    expect(result.query.criteria.start).toBe(1781488800);
    expect(result.query.criteria.end).toBe(1781492400);
    expect(result.query.criteria.severities).toEqual([4]);
  });

  test('should flatten alertsSummary category/object/event structure', () => {
    const events = normalizeSummary({
      networkAlerts: {
        '192.168.1.16': [
          {
            id: 369652,
            severity: 4,
            categoryType: 3,
            metrics: ['TPIO'],
            value: [123.45],
            unit: ['Kbps'],
            tasktype: '0',
            linkType: 2
          }
        ]
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '369652',
      category: 'networkAlerts',
      categoryLabel: '网络性能告警',
      group: '192.168.1.16',
      severity: 4,
      severityLabel: '紧急',
      groupType: 'IPAddress',
      taskTypeLabel: '静态/普通告警',
      linkTypeLabel: '按事件 ID 关联数据包'
    });
  });

  test('should build alertsDetail URL with repeated eventids parameters', () => {
    const api = new AlertApiService({
      host: 'https://example.test/webservice/NetInside',
      username: 'GAIOP',
      password: 'secret'
    });

    const url = new URL(api.buildUrl('alertsDetail', {
      eventids: ['369652', '369653'],
      start: 1781488800,
      end: 1781492400,
      json: 'true'
    }));

    expect(url.pathname).toBe('/webservice/NetInside');
    expect(url.searchParams.get('type')).toBe('alertsDetail');
    expect(url.searchParams.getAll('eventids')).toEqual(['369652', '369653']);
    expect(url.search).not.toContain('eventids%5B%5D');
  });

  test('should record masked backend request URL when querying alertsSummary', async () => {
    const api = new AlertApiService({
      host: 'https://example.test',
      username: 'GAIOP',
      password: 'secret'
    });
    api.client.get = async (url) => {
      expect(url).toContain('Password=secret');
      return { data: {} };
    };

    await api.getSummary({
      start: 1781488800,
      end: 1781492400
    });

    expect(api.getRequestHistory()).toHaveLength(1);
    expect(api.getLastRequestUrl()).toContain('/webservice/NetInside?');
    expect(api.getLastRequestUrl()).toContain('type=alertsSummary');
    expect(api.getLastRequestUrl()).toContain('Password=***');
    expect(api.getLastRequestUrl()).not.toContain('secret');
  });

  test('should normalize timeline buckets and preserve raw counts warning', () => {
    const buckets = normalizeTimeline({
      AIAlerts: {
        '1586880000': [1, 2, 3]
      }
    });

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      category: 'AIAlerts',
      categoryLabel: '智能分析告警',
      bucketStart: 1586880000,
      minor: 1,
      critical: 2,
      major: 3,
      rawCounts: [1, 2, 3]
    });
    expect(buckets[0].orderWarning).toContain('severity array order');
  });

  test('should filter and aggregate alert events', () => {
    const events = normalizeDetail([
      { id: 1, group: '192.168.1.16', severity: 4, metrics: ['TPIO'], categoryType: 3 },
      { id: 2, group: '192.168.1.17', severity: 3, metrics: ['RTTI'], categoryType: 3 }
    ]);

    const filtered = filterEvents(events, {
      severities: [4],
      objects: ['192.168.1.16'],
      metrics: ['TPIO']
    });
    const summary = analyzeEvents(filtered);

    expect(filtered).toHaveLength(1);
    expect(summary.total).toBe(1);
    expect(summary.bySeverity.critical).toBe(1);
    expect(summary.topMetrics).toEqual([{ metric: 'TPIO', count: 1 }]);
  });

  test('should normalize Chinese alert category labels to backend category keys', () => {
    const result = validateAlertQuery({
      mode: 'summary',
      criteria: {
        start: 1781488800,
        end: 1781492400,
        categories: ['应用性能告警', '业务告警', '网络异常告警']
      }
    });

    expect(result.ok).toBe(true);
    expect(result.query.criteria.categories).toEqual(['appAlerts', 'busAlerts', 'networkIssueAlerts']);
  });

  test('should filter events by normalized backend category key', () => {
    const events = normalizeSummary({
      appAlerts: {
        HTTPS: [{ id: 1, severity: 4, categoryType: 51, metrics: ['UEIO'] }]
      },
      busAlerts: {
        可观测239web: [{ id: 2, severity: 4, categoryType: 68, metrics: ['PGNPGE'] }]
      }
    });

    const validation = validateAlertQuery({
      mode: 'summary',
      criteria: {
        start: 1781488800,
        end: 1781492400,
        categories: ['应用告警']
      }
    });
    const filtered = filterEvents(events, validation.query.criteria);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      id: '1',
      category: 'appAlerts',
      categoryLabel: '应用性能告警'
    });
  });

  test('should create packet handoff from linkType=2 event id', () => {
    const handoff = buildPacketHandoff([
      {
        id: '369652',
        linkType: 2,
        start: 1781488800,
        end: 1781492400
      }
    ], {});

    expect(handoff).toMatchObject({
      available: true,
      reason: 'ALERT_LINK_TYPE_EVENT_ID',
      eventId: '369652',
      suggestedPacketQuery: {
        mode: 'build_url_only',
        criteria: {
          id: '369652',
          start: 1781488800,
          end: 1781492400
        }
      }
    });
  });
});
