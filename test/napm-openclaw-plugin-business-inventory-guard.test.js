const path = require('path');

describe('napm-openclaw-plugin business inventory guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
      return;
    }
    process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
  });

  test('should recognize plain business object inventory prompt and force WebApplication', () => {
    const testApi = plugin.__test__;

    expect(testApi.isBusinessObjectInventoryPrompt('系统中有哪些业务？')).toBe(true);
    expect(testApi.isBusinessObjectInventoryPrompt('系统中都有哪些业务？')).toBe(true);
    expect(testApi.isBusinessObjectInventoryPrompt('现在系统有哪些业务系统？')).toBe(true);
    expect(testApi.buildBusinessObjectInventoryResolvedQuery('系统中有哪些业务？')).toMatchObject({
      service: 'groups',
      semanticConstraints: {
        operation: 'metadata_list',
        targetObjectType: 'WebApplication'
      },
      groups: [{ type: 'WebApplication' }]
    });
  });

  test('should not rewrite explicit business group inventory prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isBusinessObjectInventoryPrompt('系统中有哪些业务组？')).toBe(false);
    expect(testApi.buildBusinessObjectInventoryResolvedQuery('系统中有哪些业务组？')).toBeNull();
  });

  test('should inject business inventory resolvedQuery during skill arg preparation', () => {
    const testApi = plugin.__test__;

    expect(testApi.prepareSkillExecutionArgs({
      prompt: '系统中都有哪些业务？'
    })).toMatchObject({
      userQuery: '系统中都有哪些业务？',
      resolvedQuery: {
        service: 'groups',
        semanticConstraints: {
          operation: 'metadata_list',
          targetObjectType: 'WebApplication'
        },
        groups: [{ type: 'WebApplication' }]
      }
    });
  });
});
