process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || '127.0.0.1';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'tester';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'tester';

const GroupPathPlannerService = require('../skills/openclaw-napm-query/services/GroupPathPlannerService');

describe('GroupPathPlannerService', () => {
  test('should plan BusinessGroup to applications path from prompt intent', () => {
    const result = GroupPathPlannerService.planPath({
      groups: [{ type: 'BusinessGroup', argument: '服务器网段' }]
    }, '看这个业务组下面的应用');

    expect(result).toBeTruthy();
    expect(result.plannedGroups).toEqual([
      { type: 'BusinessGroup', argument: '服务器网段' },
      { type: 'Applications', argument: null },
      { type: 'DefinedApp', argument: null }
    ]);
    expect(result.selectedPath).toEqual(['BusinessGroup', 'Applications', 'DefinedApp']);
  });

  test('should plan WebApplication to page family path using static tree container node', () => {
    const result = GroupPathPlannerService.planPath({
      groups: [{ type: 'WebApplication', argument: '回函238web' }]
    }, '继续看这个业务系统下面的页面族');

    expect(result).toBeTruthy();
    expect(result.plannedGroups).toEqual([
      { type: 'WebApplication', argument: '回函238web' },
      { type: 'PageFamilies', argument: null },
      { type: 'PageFamily', argument: null }
    ]);
    expect(result.selectedPath).toEqual(['WebApplication', 'PageFamilies', 'PageFamily']);
  });

  test('should plan IPAddress to connected group path when prompt asks for connected groups', () => {
    const result = GroupPathPlannerService.planPath({
      groups: [{ type: 'IPAddress', argument: '101.254.114.238' }]
    }, '这个IP下面的连接组有哪些');

    expect(result).toBeTruthy();
    expect(result.plannedGroups).toEqual([
      { type: 'IPAddress', argument: '101.254.114.238' },
      { type: 'ConnectedGroups', argument: null },
      { type: 'BusinessGroup', argument: null }
    ]);
    expect(result.selectedPath).toEqual(['IPAddress', 'ConnectedGroups', 'BusinessGroup']);
  });

  test('should fall back to default drilldown branch for WebApplication', () => {
    const result = GroupPathPlannerService.planPath({
      groups: [{ type: 'WebApplication', argument: '回函238web' }]
    }, '继续下钻');

    expect(result).toBeTruthy();
    expect(result.plannedGroups).toEqual([
      { type: 'WebApplication', argument: '回函238web' },
      { type: 'ClientIPs', argument: null },
      { type: 'IPAddress', argument: null }
    ]);
  });
});
