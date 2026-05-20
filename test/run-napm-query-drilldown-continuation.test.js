const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');

describe('run_napm_query drilldown continuation', () => {
  test('should detect drilldown-style prompts', () => {
    expect(__test__.isDrilldownPrompt('继续往下钻看看明细')).toBe(true);
    expect(__test__.isDrilldownPrompt('看下客户端IP')).toBe(false);
  });

  test('should infer default web application descent path', () => {
    const groups = __test__.inferDrilldownPathFromPrompt(
      [{ type: 'WebApplication', argument: '回溯238web' }],
      '继续下钻'
    );

    expect(groups).toEqual([
      { type: 'WebApplication', argument: '回溯238web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
  });

  test('should infer explicit business group application path', () => {
    const groups = __test__.inferDrilldownPathFromPrompt(
      [{ type: 'BusinessGroup', argument: '服务器网段' }],
      '看下这个业务组下面的应用'
    );

    expect(groups).toEqual([
      { type: 'BusinessGroup', argument: '服务器网段' },
      { type: 'Applications', argument: null },
      { type: 'DefinedApp', argument: null }
    ]);
  });

  test('should inherit session scope for follow-up query', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        topCount: 5
      },
      '看明细',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'WebApplication', argument: '回溯238web' }
        ]
      }
    );

    expect(resolvedQuery.metric).toBe('RFCI');
    expect(resolvedQuery.metrics).toEqual(['RFCI']);
    expect(resolvedQuery.start).toBe(1777982400);
    expect(resolvedQuery.end).toBe(1777986000);
    expect(resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: '回溯238web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
  });

  test('should preserve explicit groups when not drilling down', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'topValues',
        metric: 'TPIO',
        metrics: ['TPIO'],
        groups: [{ type: 'DefinedApp', argument: 'HTTPS' }]
      },
      '看趋势',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'WebApplication', argument: '回溯238web' }
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
        pathPlanning: {
          followUpAction: 'drilldown',
          plannedGroups: [
            { type: 'WebApplication', argument: '回溯238web' },
            { type: 'ClientIPs' },
            { type: 'IPAddress' }
          ]
        }
      },
      '需要',
      {
        last_result_available: true,
        turn_expiry: 3,
        last_metric: 'RFCI',
        last_time_range: {
          start: 1777982400,
          end: 1777986000
        },
        last_groups: [
          { type: 'BusinessGroup', argument: '服务器网段' }
        ]
      }
    );

    expect(resolvedQuery.groups).toEqual([
      { type: 'WebApplication', argument: '回溯238web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
    expect(resolvedQuery.metric).toBe('RFCI');
    expect(resolvedQuery.start).toBe(1777982400);
    expect(resolvedQuery.end).toBe(1777986000);
  });
  test('should plan page family drilldown through PageFamilies container', () => {
    const resolvedQuery = __test__.applySessionContinuationToResolvedQuery(
      {
        service: 'groups',
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
