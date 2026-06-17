const WorkflowClassifierService = require('../skills/openclaw-napm-query/services/WorkflowClassifierService');

describe('WorkflowClassifierService', () => {
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
});

describe('WorkflowClassifierService metric condition arbitration', () => {
  test('should classify metric-conditioned list questions as metric topn, not inventory', () => {
    const result = WorkflowClassifierService.classifyWorkflow('\u5728\u5176\u4ed6web\u5e94\u7528\u4e2d\uff0c\u6709\u54ea\u4e9b\u9875\u9762\u51fa\u73b0400\u9519\u8bef\uff1f');

    expect(result).toMatchObject({
      workflowType: 'metric_topn',
      reason: 'metric_condition_over_inventory'
    });
  });
});
