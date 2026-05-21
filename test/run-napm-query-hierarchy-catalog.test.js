const { __test__ } = require('../skills/openclaw-napm-query/scripts/run_napm_query');
const NapmMetadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');

describe('run_napm_query hierarchy catalog prompt fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  test('should require upstream resolvedQuery for hierarchy prompts by default', async () => {
    await expect(__test__.resolveInput(
      {},
      {
        userQuery: 'IP地址支持哪些下钻路径？',
        prompt: 'IP地址支持哪些下钻路径？'
      }
    )).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('should require upstream resolvedQuery for top-level hierarchy catalog prompts by default', async () => {
    await expect(__test__.resolveInput(
      {},
      {
        userQuery: '有哪些顶层对象，以及各自支持哪些下钻？',
        prompt: '有哪些顶层对象，以及各自支持哪些下钻？'
      }
    )).rejects.toMatchObject({
      code: 'UPSTREAM_RESOLVED_QUERY_REQUIRED',
      details: expect.objectContaining({
        boundaryMode: 'strict',
        promptReceived: true
      })
    });
  });

  test('should build top-level hierarchy catalog payload from explicit resolvedQuery', async () => {
    const catalog = [{ groupType: 'BusinessGroup', runtimeGroupType: 'BusinessGroup', directChildren: [], paths: [] }];
    const spy = jest.spyOn(NapmMetadataService, 'getTopLevelDrilldownCatalog').mockResolvedValue(catalog);

    const payload = await __test__.buildHierarchyCatalogPayloadFromResolvedQuery({
      service: 'drilldownCatalog',
      groups: []
    });

    expect(spy).toHaveBeenCalledWith({ maxDepth: 2 });
    expect(payload).toEqual({
      service: 'drilldownCatalog',
      targetGroupType: null,
      catalog
    });
  });

  test('should build hierarchy payload from explicit resolvedQuery group target', async () => {
    const result = {
      groupType: 'BusinessGroup',
      runtimeGroupType: 'BusinessGroup',
      directChildren: [],
      paths: []
    };
    const spy = jest.spyOn(NapmMetadataService, 'getDrilldownPathsForGroupType').mockResolvedValue(result);

    const payload = await __test__.buildHierarchyCatalogPayloadFromResolvedQuery({
      service: 'drilldownCatalog',
      groups: [{ type: 'BusinessGroup', argument: null }]
    });

    expect(spy).toHaveBeenCalledWith('BusinessGroup', { maxDepth: 2 });
    expect(payload).toEqual({
      service: 'drilldownCatalog',
      targetGroupType: 'BusinessGroup',
      ...result
    });
  });
});
