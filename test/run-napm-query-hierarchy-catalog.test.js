const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');

describe('run_napm_query hierarchy catalog prompt fallback', () => {
  test('should recognize hierarchy prompts for a specific object', () => {
    expect(__test__.isHierarchyCatalogPrompt('IP地址支持哪些下钻路径？')).toBe(true);
    expect(__test__.isHierarchyCatalogPrompt('BusinessGroup 可以往下钻到哪里')).toBe(true);
    expect(__test__.normalizeDrilldownQuestionTarget('IP地址支持哪些下钻路径？')).toBe('IPAddress');
    expect(__test__.normalizeDrilldownQuestionTarget('BusinessGroup 可以往下钻到哪里')).toBe('BusinessGroup');
  });

  test('should recognize top-level hierarchy catalog prompts', () => {
    expect(__test__.isHierarchyCatalogPrompt('有哪些顶层对象，以及各自支持哪些下钻？')).toBe(true);
    expect(__test__.normalizeDrilldownQuestionTarget('有哪些顶层对象，以及各自支持哪些下钻？')).toBe(null);
  });

  test('should resolve hierarchy prompt to drilldownCatalog without resolvedQuery', async () => {
    const input = await __test__.resolveInput(
      {},
      {
        userQuery: 'IP地址支持哪些下钻路径？',
        prompt: 'IP地址支持哪些下钻路径？'
      }
    );

    expect(input.resolvedQuery).toMatchObject({
      service: 'drilldownCatalog',
      groups: [{ type: 'IPAddress', argument: null }]
    });
    expect(input.hierarchyCatalogPayload).toBeTruthy();
    expect(input.hierarchyCatalogPayload.runtimeGroupType).toBe('IPAddress');
    expect(input.hierarchyCatalogPayload.directChildren.map((item) => item.runtimeKey)).toEqual(
      expect.arrayContaining(['ConnectedIPs', 'Applications', 'ConnectedGroups', 'OtherApps'])
    );
  });

  test('should resolve top-level hierarchy catalog prompt to catalog payload', async () => {
    const input = await __test__.resolveInput(
      {},
      {
        userQuery: '有哪些顶层对象，以及各自支持哪些下钻？',
        prompt: '有哪些顶层对象，以及各自支持哪些下钻？'
      }
    );

    expect(input.resolvedQuery).toMatchObject({
      service: 'drilldownCatalog',
      groups: []
    });
    expect(Array.isArray(input.hierarchyCatalogPayload.catalog)).toBe(true);
    const groupTypes = input.hierarchyCatalogPayload.catalog.map((item) => item.runtimeGroupType);
    expect(groupTypes).toEqual(
      expect.arrayContaining(['IPAddress', 'BusinessGroup', 'WebApplication'])
    );
  });
});
