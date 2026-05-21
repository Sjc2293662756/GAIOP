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

  test('should recognize business object inventory prompt', () => {
    const testApi = plugin.__test__;

    expect(testApi.isBusinessObjectInventoryPrompt('\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f')).toBe(true);
    expect(testApi.isBusinessObjectInventoryPrompt('\u73b0\u5728\u4e1a\u52a1\u7ec4\u6574\u4f53\u60c5\u51b5\u600e\u4e48\u6837\uff1f')).toBe(false);
  });

  test('should build business object inventory helper resolvedQuery', () => {
    const testApi = plugin.__test__;
    const resolvedQuery = testApi.buildBusinessObjectInventoryResolvedQuery('\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f');

    expect(resolvedQuery).toMatchObject({
      service: 'groups',
      queryModeKey: 'metadata',
      semanticConstraints: {
        operation: 'metadata_list',
        targetObjectType: 'WebApplication'
      },
      groups: [{ type: 'WebApplication' }]
    });
  });

  test('should preserve raw prompt and avoid injecting resolvedQuery during skill arg preparation', () => {
    const testApi = plugin.__test__;
    const prompt = '\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f';
    const prepared = testApi.prepareSkillExecutionArgs({
      prompt,
      userQuery: prompt
    });

    expect(prepared.prompt).toBe(prompt);
    expect(prepared.userQuery).toBe(prompt);
    expect(prepared.resolvedQuery).toBeUndefined();
  });

  test('should preserve raw prompt and avoid injecting resolvedQuery in canonical skill params', () => {
    const testApi = plugin.__test__;
    const prompt = '\u5f53\u524d\u6709\u54ea\u4e9b\u4e1a\u52a1\u5bf9\u8c61\uff1f';
    const prepared = testApi.buildCanonicalSkillToolParams(prompt, {});

    expect(prepared.prompt).toBe(prompt);
    expect(prepared.userQuery).toBe(prompt);
    expect(prepared.resolvedQuery).toBeUndefined();
  });
});
