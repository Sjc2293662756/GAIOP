const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');

describe('WorkflowClassifierService', () => {
  test('classifies an alert packet event before generic metric workflows', () => {
    const result = WorkflowClassifierService.classifyWorkflow([
      '分析告警数据包 eventId=745278 start=1786327320 end=1786327560',
      '触发指标值: 用户体验时间（服务器）=3055.3701毫秒'
    ].join('\n'));

    expect(result).toMatchObject({
      workflowType: 'alert_packet_analysis',
      confidence: 1,
      eventId: '745278',
      reason: 'alert_packet_event_intent'
    });
  });

  test('should classify BusinessGroup inventory as object_inventory', () => {
    const result = WorkflowClassifierService.classifyWorkflow('系统都有哪些工作组');

    expect(result).toMatchObject({
      workflowType: 'object_inventory',
      targetObjectType: 'BusinessGroup'
    });
  });

  test('should classify business inventory as WebApplication object_inventory', () => {
    const result = WorkflowClassifierService.classifyWorkflow('系统中有哪些业务');

    expect(result).toMatchObject({
      workflowType: 'object_inventory',
      targetObjectType: 'WebApplication'
    });
  });

  test.each([
    '你有什么功能？',
    '你有哪些能力？',
    '你能做些什么？'
  ])('should not classify assistant capability prompt as object inventory: %s', (prompt) => {
    expect(WorkflowClassifierService.classifyWorkflow(prompt)).toMatchObject({
      workflowType: null,
      targetObjectType: null,
      reason: 'workflow_unresolved'
    });
  });

  test('classifies inventory wording with a comparative metric as ranking', () => {
    const result = WorkflowClassifierService.classifyWorkflow('最近一周有哪些业务出现较多 HTTP 500 错误？');

    expect(result).toMatchObject({
      workflowType: 'metric_topn',
      targetObjectType: 'WebApplication',
      reason: 'ranking_intent'
    });
  });

  test.each([
    ['最近一周有哪些业务的 HTTP 500 错误趋势上升？', 'metric_timeseries'],
    ['最近一周有哪些业务的平均响应时间较高？', 'metric_average']
  ])('classifies mixed object wording by explicit data operation: %s', (prompt, workflowType) => {
    expect(WorkflowClassifierService.classifyWorkflow(prompt)).toMatchObject({
      workflowType,
      targetObjectType: 'WebApplication'
    });
  });

  test('should classify auto-detected applications as CompositeApplication object_inventory', () => {
    const result = WorkflowClassifierService.classifyWorkflow('系统中有哪些自动识别的应用');

    expect(result).toMatchObject({
      workflowType: 'object_inventory',
      targetObjectType: 'CompositeApplication'
    });
  });

  test('should classify metric inventory before object inventory', () => {
    const result = WorkflowClassifierService.classifyWorkflow('工作组都可以查哪些指标');

    expect(result).toMatchObject({
      workflowType: 'metric_inventory',
      targetObjectType: 'BusinessGroup'
    });
  });

  test('should classify drilldown catalog before object inventory', () => {
    const result = WorkflowClassifierService.classifyWorkflow('BusinessGroup 可以往下钻到哪里');

    expect(result).toMatchObject({
      workflowType: 'drilldown_catalog',
      targetObjectType: 'BusinessGroup'
    });
  });

  test.each([
    ['最近 7 天应用流量趋势如何？', 'metric_timeseries', 'DefinedApp', 'traffic'],
    ['应用吞吐最高的是哪些？', 'metric_topn', 'DefinedApp', 'throughput'],
    ['最近 7 天总流量趋势如何？', 'metric_timeseries', 'TotalTraffic', 'traffic']
  ])('returns structured object and metric intent for traffic queries: %s', (
    prompt,
    workflowType,
    targetObjectType,
    metricDomain
  ) => {
    expect(WorkflowClassifierService.classifyWorkflow(prompt)).toMatchObject({
      workflowType,
      targetObjectType,
      metricSemantic: {
        domain: metricDomain
      }
    });
  });
});
