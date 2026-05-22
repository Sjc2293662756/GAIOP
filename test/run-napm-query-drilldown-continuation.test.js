const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');

describe('run_napm_query drilldown continuation', () => {
  test('should infer default web application descent path in helper', () => {
    const groups = __test__.inferDrilldownPathFromPrompt(
      [{ type: 'WebApplication', argument: 'demo-web' }],
      'show client ip detail'
    );

    expect(groups).toEqual([
      { type: 'WebApplication', argument: 'demo-web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
  });

  test('should not infer session scope for follow-up query without explicit inheritance', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        topCount: 5
      },
      'show details',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'WebApplication', argument: 'demo-web' }
        ]
      }
    );

    expect(resolvedQuery.metric).toBeUndefined();
    expect(resolvedQuery.metrics).toBeUndefined();
    expect(resolvedQuery.start).toBeUndefined();
    expect(resolvedQuery.end).toBeUndefined();
    expect(resolvedQuery.groups).toBeUndefined();
  });

  test('should inherit session fields only when resolvedQuery explicitly asks for them', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        topCount: 5,
        executionHints: {
          inheritMetric: true,
          inheritGroups: true,
          inheritTimeRange: true
        }
      },
      'show same scope',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'WebApplication', argument: 'demo-web' }
        ]
      }
    );

    expect(resolvedQuery.metric).toBe('RFCI');
    expect(resolvedQuery.metrics).toEqual(['RFCI']);
    expect(resolvedQuery.start).toBe(1777982400);
    expect(resolvedQuery.end).toBe(1777986000);
    expect(resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: 'demo-web' }
    ]);
  });

  test('should preserve explicit groups when not drilling down', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        metric: 'TPIO',
        metrics: ['TPIO'],
        groups: [{ type: 'DefinedApp', argument: 'HTTPS' }],
        executionHints: {
          inheritTimeRange: true
        }
      },
      'show trend',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'WebApplication', argument: 'demo-web' }
        ]
      }
    );

    expect(resolvedQuery.groups).toEqual([
      { type: 'DefinedApp', argument: 'HTTPS' }
    ]);
    expect(resolvedQuery.metric).toBe('TPIO');
    expect(resolvedQuery.start).toBe(1777982400);
    expect(resolvedQuery.end).toBe(1777986000);
  });

  test('should prefer structured planned groups from resolvedQuery pathPlanning', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        executionHints: {
          inheritMetric: true,
          inheritTimeRange: true
        },
        pathPlanning: {
          followUpAction: 'drilldown',
          plannedGroups: [
            { type: 'WebApplication', argument: 'demo-web' },
            { type: 'ClientIPs' },
            { type: 'IPAddress' }
          ]
        }
      },
      'use planned path',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'BusinessGroup', argument: 'server-segment' }
        ]
      }
    );

    expect(resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: 'demo-web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
    expect(resolvedQuery.metric).toBe('RFCI');
    expect(resolvedQuery.start).toBe(1777982400);
    expect(resolvedQuery.end).toBe(1777986000);
  });

  test('should preserve explicit multilevel path by default', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        metric: 'TPIO',
        metrics: ['TPIO'],
        groups: [
          { type: 'IPAddress', argument: '192.0.2.10' },
          { type: 'Applications' },
          { type: 'DefinedApp' }
        ]
      },
      '192.0.2.10 applications',
      null
    );

    expect(resolvedQuery.groups.map((group) => group.type)).toEqual([
      'IPAddress',
      'Applications',
      'DefinedApp'
    ]);
    expect(resolvedQuery.groups[0].argument).toBe('192.0.2.10');
    expect(resolvedQuery.pathPlanning).toBeUndefined();
  });

  test('should not plan page family drilldown without explicit repair permission', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'groups',
        groups: [{ type: 'WebApplication', argument: 'demo-web' }]
      },
      'show page family for this web application',
      null
    );

    expect(resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: 'demo-web' }
    ]);
    expect(resolvedQuery.pathPlanning).toBeUndefined();
  });

  test('should plan page family drilldown only when execution repair is explicit', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'groups',
        executionOptions: {
          allowPathRepair: true
        },
        groups: [{ type: 'WebApplication', argument: 'demo-web' }]
      },
      'show page family for this web application',
      null
    );

    expect(resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: 'demo-web' },
      { type: 'PageFamilies', argument: null },
      { type: 'PageFamily', argument: null }
    ]);
    expect(resolvedQuery.pathPlanning.selectedPath).toEqual([
      'WebApplication',
      'PageFamilies',
      'PageFamily'
    ]);
  });
});
